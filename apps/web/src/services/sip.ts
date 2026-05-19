// SIP service backed by JsSIP (full SIP UA in the browser).
//
// Why JsSIP instead of @telnyx/webrtc?
//   • Telnyx WebRTC SDK only exposes a single "call" object at a time and
//     hides each leg's call_control_id from us, which blocked real 3-way.
//   • JsSIP is a generic SIP-over-WebSocket UA — every call is its own
//     RTCSession with its own RTCPeerConnection. Multiple concurrent calls
//     work natively, exactly like a native softphone (PJSIP).
//   • Audio mixing for conferences happens client-side via Web Audio API
//     (see `enableConferenceMixing()` below) — mirrors the PJSIP pattern.
//
// Public surface is unchanged so the rest of the app (SipContext, InCall,
// IncomingCall) doesn't need to be touched: same SipService class, same
// events, same method names.

import JsSIP from 'jssip';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RTCSession = any; // jssip's RTCSession type is JSDoc-only

export type SipState = 'disconnected' | 'connecting' | 'registered' | 'failed';
export type CallState =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'connected'
  | 'ended'
  | 'incoming';
export type CallQualityLevel = 'good' | 'fair' | 'poor' | 'unknown';

export interface SipConfig {
  username: string;
  password: string;
  /** E.164 number to use as the From caller ID. */
  callerNumber?: string;
  /** Override the WSS endpoint. Defaults to Telnyx's. */
  wssUri?: string;
  /** Override the SIP domain (the part after @). Defaults to sip.telnyx.com. */
  realm?: string;
}

export interface CallEvent {
  state: CallState;
  number?: string;
  reason?: string;
  callId?: string;
  fromNumber?: string;
  toNumber?: string;
  direction?: 'inbound' | 'outbound';
  hangupCause?: string;
}

export interface CallQuality {
  level: CallQualityLevel;
  jitter: number;
  loss: number;
  rtt: number | null;
}

type Listener<T = unknown> = (payload: T) => void;

function toE164(raw: string): string {
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  return `+${cleaned}`;
}

function applySpeakerSelection(audioEl: HTMLAudioElement): void {
  const speakerId = localStorage.getItem('ace_speaker');
  if (speakerId && speakerId !== 'default' && 'setSinkId' in audioEl) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (audioEl as any).setSinkId(speakerId).catch((e: Error) =>
      console.warn('[sip] setSinkId failed', e.message),
    );
  }
}

/**
 * Per-call book-keeping. We attach this to each JsSIP RTCSession so we can
 * track held state, the destination number we dialed, etc.
 */
interface CallEntry {
  id: string;
  session: RTCSession;
  direction: 'inbound' | 'outbound';
  fromNumber: string;
  toNumber: string;
  destinationDisplay: string;
  heldLocal: boolean;
  audioEl: HTMLAudioElement | null;
  startedAt: number;
}

export class SipService {
  private ua: JsSIP.UA | null = null;
  private callerNumber = '';
  private realm = 'sip.telnyx.com';
  /** Default audio element used for the active (non-conference) call. */
  private primaryAudioEl: HTMLAudioElement;
  /** Map of call id → entry, lets us juggle multiple simultaneous calls. */
  private calls: Map<string, CallEntry> = new Map();
  /** Whichever call is currently considered "active" (i.e. not on hold). */
  private activeCallId: string | null = null;
  /** ID of the incoming-but-not-yet-answered call (if any). */
  private incomingCallId: string | null = null;
  private listeners: Map<string, Set<Listener>> = new Map();
  // Quality polling
  private qualityTimer: ReturnType<typeof setInterval> | null = null;
  private lastPacketsLost = 0;
  private lastPacketsReceived = 0;

  constructor() {
    this.primaryAudioEl = document.createElement('audio');
    this.primaryAudioEl.autoplay = true;
    this.primaryAudioEl.id = 'ace-remote-audio';
    document.body.appendChild(this.primaryAudioEl);
    applySpeakerSelection(this.primaryAudioEl);
  }

  // ---------- Event bus ----------
  on<T = unknown>(event: string, handler: Listener<T>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler as Listener);
    return () => this.listeners.get(event)?.delete(handler as Listener);
  }
  private emit<T = unknown>(event: string, payload: T): void {
    this.listeners.get(event)?.forEach((h) => h(payload));
  }

  // ---------- Connection ----------
  connect(config: SipConfig): void {
    if (this.ua) this.disconnect();

    this.callerNumber = config.callerNumber ?? '';
    this.realm = config.realm ?? 'sip.telnyx.com';
    const wssUri = config.wssUri ?? 'wss://sip.telnyx.com:443';

    const socket = new JsSIP.WebSocketInterface(wssUri);
    const uri = `sip:${config.username}@${this.realm}`;
    this.ua = new JsSIP.UA({
      sockets: [socket],
      uri,
      password: config.password,
      // Identity for outgoing INVITEs — Telnyx uses this for the From header.
      display_name: 'ACE Dialer',
      // Re-register every 5 minutes to keep the SIP registration warm.
      register: true,
      register_expires: 300,
      // session_timers prevents zombie calls if media drops silently.
      session_timers: true,
      // Use the user's selected mic via global getUserMedia constraints.
      user_agent: 'ACE-Dialer/1.0',
    });

    this.ua.on('connecting', () => {
      console.log('[sip] connecting');
      this.emit<SipState>('state', 'connecting');
    });
    this.ua.on('connected', () => {
      console.log('[sip] socket connected');
    });
    this.ua.on('disconnected', () => {
      console.log('[sip] socket disconnected');
      this.emit<SipState>('state', 'disconnected');
    });
    this.ua.on('registered', () => {
      console.log('[sip] registered');
      this.emit<SipState>('state', 'registered');
    });
    this.ua.on('unregistered', () => {
      console.log('[sip] unregistered');
      this.emit<SipState>('state', 'disconnected');
    });
    this.ua.on('registrationFailed', (e: { cause?: string }) => {
      console.warn('[sip] registrationFailed', e.cause);
      this.emit<SipState>('state', 'failed');
    });

    // Each new outgoing or incoming call is a "newRTCSession" event.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.ua.on('newRTCSession', (data: any) => {
      const session: RTCSession = data.session;
      this.attachSessionListeners(session);
    });

    this.emit<SipState>('state', 'connecting');
    this.ua.start();
  }

  // ---------- Call lifecycle (outbound / inbound common path) ----------
  private attachSessionListeners(session: RTCSession): void {
    const direction: 'inbound' | 'outbound' =
      session.direction === 'incoming' ? 'inbound' : 'outbound';
    const fromNumber =
      direction === 'inbound'
        ? this.extractPhone(session.remote_identity?.uri)
        : this.callerNumber;
    const toNumber =
      direction === 'outbound'
        ? this.extractPhone(session.remote_identity?.uri)
        : this.callerNumber;
    const callId: string = session.id;
    const destinationDisplay = direction === 'inbound' ? fromNumber : toNumber;

    // Dedicated audio element per call. JsSIP attaches the remote track via
    // `peerconnection.ontrack` — we route it into our element.
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.id = `ace-call-${callId}`;
    document.body.appendChild(audioEl);
    applySpeakerSelection(audioEl);

    const entry: CallEntry = {
      id: callId,
      session,
      direction,
      fromNumber,
      toNumber,
      destinationDisplay,
      heldLocal: false,
      audioEl,
      startedAt: Date.now(),
    };
    this.calls.set(callId, entry);

    // Wire the peer connection's remote stream into our audio element as soon
    // as the SDP exchange completes.
    session.on('peerconnection', (data: { peerconnection: RTCPeerConnection }) => {
      const pc = data.peerconnection;
      pc.addEventListener('track', (ev: RTCTrackEvent) => {
        if (ev.streams && ev.streams[0]) {
          audioEl.srcObject = ev.streams[0];
          // Also wire to the primary audio element so the existing speaker-
          // routing (setSinkId) targets this call.
          if (entry.id === this.activeCallId) {
            this.primaryAudioEl.srcObject = ev.streams[0];
            void this.primaryAudioEl.play().catch(() => {});
          }
          applySpeakerSelection(audioEl);
        }
      });
    });

    // Outbound call lifecycle
    if (direction === 'outbound') {
      this.emit<CallEvent>('call', this.buildEvent(entry, 'calling'));
    } else {
      // Inbound: park this call as the "incoming" until user accepts/declines.
      this.incomingCallId = callId;
      this.emit<CallEvent>('call', this.buildEvent(entry, 'incoming'));
    }

    session.on('progress', () => {
      // 180 Ringing
      if (direction === 'outbound') {
        this.emit<CallEvent>('call', this.buildEvent(entry, 'ringing'));
      }
    });

    session.on('accepted', () => {
      // 200 OK received (outbound) or sent (inbound)
      // For inbound, this is the user answering.
      if (this.incomingCallId === callId) this.incomingCallId = null;
      this.activeCallId = callId;
      this.emit<CallEvent>('call', this.buildEvent(entry, 'connected'));
      this.startQualityPolling();
    });

    session.on('confirmed', () => {
      // ACK received — call is fully established.
      this.activeCallId = callId;
      this.emit<CallEvent>('call', this.buildEvent(entry, 'connected'));
    });

    session.on('ended', (data: { cause?: string }) => {
      this.cleanupCall(callId, data?.cause ?? 'normal_clearing');
    });
    session.on('failed', (data: { cause?: string }) => {
      this.cleanupCall(callId, data?.cause ?? 'failed');
    });
  }

  private cleanupCall(callId: string, cause: string): void {
    const entry = this.calls.get(callId);
    if (!entry) return;
    this.emit<CallEvent>('call', { ...this.buildEvent(entry, 'ended'), hangupCause: cause });
    try {
      if (entry.audioEl) {
        entry.audioEl.srcObject = null;
        entry.audioEl.remove();
      }
    } catch {
      /* noop */
    }
    this.calls.delete(callId);
    if (this.activeCallId === callId) this.activeCallId = null;
    if (this.incomingCallId === callId) this.incomingCallId = null;

    // If a held call remains, promote it to active and unhold.
    if (!this.activeCallId && this.calls.size > 0) {
      const next = Array.from(this.calls.values())[0];
      this.activeCallId = next.id;
      try {
        next.session.unhold();
      } catch { /* noop */ }
      next.heldLocal = false;
      if (next.audioEl) {
        this.primaryAudioEl.srcObject = next.audioEl.srcObject;
      }
    }

    if (this.calls.size === 0) this.stopQualityPolling();
  }

  private buildEvent(entry: CallEntry, state: CallState): CallEvent {
    return {
      state,
      callId: entry.id,
      fromNumber: entry.fromNumber,
      toNumber: entry.toNumber,
      direction: entry.direction,
      number: entry.destinationDisplay,
    };
  }

  // ---------- Outbound / inbound API ----------
  call(rawNumber: string): void {
    if (!this.ua) throw new Error('SIP not connected');
    const e164 = toE164(rawNumber);
    const target = `sip:${e164}@${this.realm}`;
    console.log('[sip] dialing', { rawNumber, target });
    applySpeakerSelection(this.primaryAudioEl);

    this.ua.call(target, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      // Tell Telnyx our caller ID via the From URI.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extraHeaders: this.callerNumber ? [`X-Caller-Number: ${this.callerNumber}`] : ([] as any),
    });
  }

  /** Start a second concurrent call — used by Add Call. */
  addCall(rawNumber: string): void {
    if (!this.ua) throw new Error('SIP not connected');
    // Hold the currently active call before starting a new one.
    const current = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    if (current) {
      try {
        current.session.hold();
        current.heldLocal = true;
      } catch (e) {
        console.warn('[sip] hold for addCall failed', e);
      }
    }
    this.call(rawNumber);
  }

  swapCalls(): void {
    if (this.calls.size < 2) return;
    const ids = Array.from(this.calls.keys());
    const currentIdx = ids.indexOf(this.activeCallId ?? '');
    const nextIdx = (currentIdx + 1) % ids.length;
    const nextId = ids[nextIdx];
    const current = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    const next = this.calls.get(nextId);
    if (current && current.id !== nextId) {
      try {
        current.session.hold();
        current.heldLocal = true;
      } catch (e) {
        console.warn('[sip] swap hold failed', e);
      }
    }
    if (next) {
      try {
        next.session.unhold();
        next.heldLocal = false;
      } catch (e) {
        console.warn('[sip] swap unhold failed', e);
      }
      this.activeCallId = next.id;
      if (next.audioEl) this.primaryAudioEl.srcObject = next.audioEl.srcObject;
    }
  }

  getActiveCallId(): string | null {
    return this.activeCallId;
  }
  getHeldCallId(): string | null {
    // First call that isn't the active one.
    for (const c of this.calls.values()) {
      if (c.id !== this.activeCallId) return c.id;
    }
    return null;
  }

  acceptCall(): void {
    const id = this.incomingCallId;
    if (!id) return;
    const entry = this.calls.get(id);
    if (!entry) return;
    applySpeakerSelection(this.primaryAudioEl);
    try {
      entry.session.answer({
        mediaConstraints: { audio: true, video: false },
        pcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
      });
    } catch (e) {
      console.warn('[sip] answer failed', e);
    }
  }

  declineCall(): void {
    const id = this.incomingCallId;
    if (!id) return;
    const entry = this.calls.get(id);
    if (!entry) return;
    try {
      entry.session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
    } catch (e) {
      console.warn('[sip] decline failed', e);
    }
    this.incomingCallId = null;
  }

  hangup(): void {
    const active = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    const tryTerminate = (entry: CallEntry | null | undefined) => {
      if (!entry) return;
      try {
        entry.session.terminate();
      } catch (e) {
        console.warn('[sip] terminate threw', e);
      }
    };
    tryTerminate(active);
    // Also hang up any remaining calls so the user goes to a clean state.
    for (const entry of Array.from(this.calls.values())) {
      if (entry.id !== this.activeCallId) tryTerminate(entry);
    }
    // Force an 'ended' event so the UI navigates back even if SIP doesn't ack.
    if (active) {
      this.emit<CallEvent>('call', {
        ...this.buildEvent(active, 'ended'),
        hangupCause: 'user_hangup',
      });
      this.cleanupCall(active.id, 'user_hangup');
    }
  }

  toggleHold(): boolean {
    const active = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    if (!active) return false;
    try {
      if (active.heldLocal) {
        active.session.unhold();
        active.heldLocal = false;
      } else {
        active.session.hold();
        active.heldLocal = true;
      }
    } catch (e) {
      console.warn('[sip] hold/unhold failed', e);
    }
    return active.heldLocal;
  }

  isOnHold(): boolean {
    const active = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    return !!active?.heldLocal;
  }

  /** Blind transfer the active call via SIP REFER. */
  transfer(rawDestination: string): boolean {
    const active = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    if (!active) return false;
    const e164 = toE164(rawDestination);
    const target = `sip:${e164}@${this.realm}`;
    try {
      active.session.refer(target);
      console.log('[sip] REFER sent for transfer →', target);
      return true;
    } catch (e) {
      console.warn('[sip] transfer (REFER) failed', e);
      return false;
    }
  }

  toggleMute(): boolean {
    const active = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    if (!active) return false;
    const muted = active.session.isMuted();
    if (muted.audio) {
      active.session.unmute({ audio: true });
      return false;
    }
    active.session.mute({ audio: true });
    return true;
  }

  sendDTMF(digit: string): void {
    const active = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    if (!active) return;
    try {
      active.session.sendDTMF(digit);
    } catch (e) {
      console.warn('[sip] sendDTMF failed', e);
    }
  }

  // ---------- Audio output ----------
  async listAudioOutputs(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'audiooutput');
    } catch (e) {
      console.warn('[sip] enumerateDevices failed', e);
      return [];
    }
  }

  async setAudioOutput(deviceId: string): Promise<void> {
    localStorage.setItem('ace_speaker', deviceId);
    const targets: HTMLAudioElement[] = [this.primaryAudioEl];
    for (const entry of this.calls.values()) {
      if (entry.audioEl) targets.push(entry.audioEl);
    }
    for (const el of targets) {
      if (!('setSinkId' in el)) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (el as any).setSinkId(deviceId);
      } catch (e) {
        console.warn('[sip] setSinkId failed', e);
      }
    }
  }

  // ---------- Call quality polling ----------
  private startQualityPolling(): void {
    this.stopQualityPolling();
    this.lastPacketsLost = 0;
    this.lastPacketsReceived = 0;
    this.qualityTimer = setInterval(() => {
      void this.pollQualityOnce();
    }, 2000);
    void this.pollQualityOnce();
  }
  private stopQualityPolling(): void {
    if (this.qualityTimer) {
      clearInterval(this.qualityTimer);
      this.qualityTimer = null;
    }
    this.emit<CallQuality>('quality', { level: 'unknown', jitter: 0, loss: 0, rtt: null });
  }
  private async pollQualityOnce(): Promise<void> {
    const active = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    if (!active) return;
    const pc: RTCPeerConnection | null = active.session?.connection ?? null;
    if (!pc?.getStats) return;
    let report: RTCStatsReport | null = null;
    try {
      report = await pc.getStats();
    } catch (e) {
      console.debug('[sip] getStats failed', e);
      return;
    }
    if (!report) return;

    let jitter = 0;
    let packetsLost = 0;
    let packetsReceived = 0;
    let rtt: number | null = null;
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && (s.kind === 'audio' || (s as { mediaType?: string }).mediaType === 'audio')) {
        const r = s as { jitter?: number; packetsLost?: number; packetsReceived?: number };
        if (typeof r.jitter === 'number') jitter = Math.max(jitter, r.jitter);
        if (typeof r.packetsLost === 'number') packetsLost = Math.max(packetsLost, r.packetsLost);
        if (typeof r.packetsReceived === 'number') packetsReceived = Math.max(packetsReceived, r.packetsReceived);
      }
      if (s.type === 'candidate-pair' && (s as { state?: string }).state === 'succeeded') {
        const r = s as { currentRoundTripTime?: number };
        if (typeof r.currentRoundTripTime === 'number') rtt = r.currentRoundTripTime;
      }
    });
    const dLost = Math.max(0, packetsLost - this.lastPacketsLost);
    const dRecv = Math.max(0, packetsReceived - this.lastPacketsReceived);
    const loss = dRecv + dLost > 0 ? dLost / (dRecv + dLost) : 0;
    this.lastPacketsLost = packetsLost;
    this.lastPacketsReceived = packetsReceived;
    const jms = jitter * 1000;
    const lossPct = loss * 100;
    const rttMs = rtt !== null ? rtt * 1000 : 0;
    let level: CallQualityLevel = 'good';
    if (jms >= 60 || lossPct >= 5 || (rtt !== null && rttMs >= 400)) level = 'poor';
    else if (jms >= 30 || lossPct >= 1 || (rtt !== null && rttMs >= 200)) level = 'fair';
    this.emit<CallQuality>('quality', { level, jitter, loss, rtt });
  }

  // ---------- Helpers ----------
  private extractPhone(uri: { user?: string; toString(): string } | undefined): string {
    if (!uri) return '';
    const user = uri.user ?? '';
    if (user) {
      if (user.startsWith('+')) return user;
      if (user.length === 11 && user.startsWith('1')) return `+${user}`;
      if (user.length === 10) return `+1${user}`;
      return user;
    }
    const str = uri.toString();
    const match = /sip:(\+?\d+)@/.exec(str);
    return match ? match[1] : str;
  }

  disconnect(): void {
    this.hangup();
    for (const entry of this.calls.values()) {
      try {
        entry.session.terminate();
      } catch {
        /* noop */
      }
      if (entry.audioEl) {
        try { entry.audioEl.remove(); } catch { /* noop */ }
      }
    }
    this.calls.clear();
    this.activeCallId = null;
    this.incomingCallId = null;
    this.stopQualityPolling();
    if (this.ua) {
      try { this.ua.stop(); } catch { /* noop */ }
      this.ua = null;
    }
  }
}

export const sipService = new SipService();
