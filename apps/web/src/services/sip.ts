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
import { getHoldMusicEnabled, getHoldMusicDataUrl } from '../lib/userPrefs';
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ua: any = null;
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
    // Telnyx SIP-over-WebSocket endpoint. Port 7443 is the conventional WSS
    // port for SIP (Telnyx, Twilio, most carriers). Some Telnyx accounts
    // also accept wss://rtc.telnyx.com:443. Override via config.wssUri or
    // VITE_SIP_WSS_URI if your account uses a different region/host.
    const wssUri = config.wssUri ?? 'wss://sip.telnyx.com:7443';
    console.log('[sip] connecting to', wssUri, 'as', config.username);

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
      // IMPORTANT: session_timers MUST be false for Telnyx. With it on,
      // JsSIP sends re-INVITE/UPDATE every ~90s and Telnyx 481s the call
      // (no matching dialog) which then teardown the call. Off = the call
      // stays alive as long as RTP flows.
      session_timers: false,
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

    // JsSIP's 'peerconnection' event timing is unreliable across versions.
    // Instead, poll for session.connection (the underlying RTCPeerConnection)
    // and wire listeners as soon as it appears. Run a few times in case JsSIP
    // creates the PC lazily.
    const wirePcWhenReady = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pc: RTCPeerConnection | null = (session as any).connection ?? (session as any)._connection ?? null;
      if (!pc) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((pc as any).__aceWired) return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pc as any).__aceWired = true;
      console.log('[sip] PC found, wiring listeners');

      pc.addEventListener('track', (ev: RTCTrackEvent) => {
        console.log('[sip] track event — kind:', ev.track.kind, 'streams:', ev.streams.length);
        if (ev.streams && ev.streams[0]) {
          const stream = ev.streams[0];
          audioEl.srcObject = stream;
          void audioEl.play().catch((e) => console.warn('[sip] per-call audioEl.play failed', e));
          this.primaryAudioEl.srcObject = stream;
          void this.primaryAudioEl.play().catch((e) =>
            console.warn('[sip] primaryAudioEl.play failed', e),
          );
          applySpeakerSelection(audioEl);
          applySpeakerSelection(this.primaryAudioEl);
          console.log('[sip] remote stream attached to both audio elements');
        } else {
          console.warn('[sip] track event but no streams!', ev);
        }
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        console.log('[sip] iceConnectionState:', pc.iceConnectionState);
      });
      pc.addEventListener('connectionstatechange', () => {
        console.log('[sip] connectionState:', pc.connectionState);
      });
      pc.addEventListener('signalingstatechange', () => {
        console.log('[sip] signalingState:', pc.signalingState);
      });
      // Also check current receivers for any already-attached remote tracks.
      try {
        for (const receiver of pc.getReceivers?.() ?? []) {
          if (receiver.track) {
            console.log('[sip] existing receiver track:', receiver.track.kind);
          }
        }
      } catch { /* noop */ }
      return true;
    };

    // Try immediately, then poll for up to 5 seconds.
    if (!wirePcWhenReady()) {
      let tries = 0;
      const id = setInterval(() => {
        tries += 1;
        if (wirePcWhenReady() || tries >= 50) clearInterval(id);
      }, 100);
    }

    // Outbound call lifecycle
    if (direction === 'outbound') {
      this.emit<CallEvent>('call', this.buildEvent(entry, 'calling'));
    } else {
      // Inbound: park this call as the "incoming" until user accepts/declines.
      this.incomingCallId = callId;
      this.emit<CallEvent>('call', this.buildEvent(entry, 'incoming'));
    }

    session.on('progress', (data: { response?: { status_code?: number; reason_phrase?: string } }) => {
      console.log('[sip] progress', callId, data?.response?.status_code, data?.response?.reason_phrase);
      if (direction === 'outbound') {
        this.emit<CallEvent>('call', this.buildEvent(entry, 'ringing'));
      }
    });

    session.on('accepted', () => {
      console.log('[sip] accepted', callId);
      if (this.incomingCallId === callId) this.incomingCallId = null;
      this.activeCallId = callId;
      this.emit<CallEvent>('call', this.buildEvent(entry, 'connected'));
      this.startQualityPolling();
    });

    session.on('confirmed', () => {
      console.log('[sip] confirmed (ACK sent/received)', callId);
      this.activeCallId = callId;
      this.emit<CallEvent>('call', this.buildEvent(entry, 'connected'));
    });

    session.on('ended', (data: { cause?: string; originator?: string; message?: { status_code?: number; reason_phrase?: string } }) => {
      console.log('[sip] ended', callId, {
        cause: data?.cause,
        originator: data?.originator,
        status: data?.message?.status_code,
        reason: data?.message?.reason_phrase,
      });
      this.cleanupCall(callId, data?.cause ?? 'normal_clearing');
    });
    session.on('failed', (data: { cause?: string; originator?: string; message?: { status_code?: number; reason_phrase?: string } }) => {
      console.warn('[sip] failed', callId, {
        cause: data?.cause,
        originator: data?.originator,
        status: data?.message?.status_code,
        reason: data?.message?.reason_phrase,
      });
      this.cleanupCall(callId, data?.cause ?? 'failed');
    });

    // ICE / peerconnection diagnostics
    session.on('icecandidate', (data: { candidate?: { candidate?: string } }) => {
      console.debug('[sip] icecandidate', data?.candidate?.candidate?.slice(0, 60));
    });
    session.on('sdp', (data: { type?: string; sdp?: string; originator?: string }) => {
      console.log('[sip] SDP', data?.originator, data?.type);
      if (data?.sdp) {
        // For remote SDP, add the WebRTC attributes Chrome requires that
        // Telnyx's FreeSWITCH backend doesn't emit by default:
        //   - a=rtcp-mux         (mux RTP+RTCP on same port)
        //   - a=group:BUNDLE 0   (bundle media streams)
        //   - a=rtcp-rsize       (reduced-size RTCP)
        // Without these, Chrome's setRemoteDescription throws and JsSIP
        // surfaces "Bad Media Description".
        if (data.originator === 'remote') {
          let s = data.sdp;
          let mutated = false;
          if (!/a=rtcp-mux/m.test(s)) {
            s = s.replace(/(m=audio[^\n]*\n)/g, '$1a=rtcp-mux\r\n');
            mutated = true;
          }
          if (!/a=group:BUNDLE/m.test(s)) {
            // Insert just before the first m= line (valid SDP session-level
            // attribute position; FreeSWITCH outputs SDP with the s= line
            // followed by c=/t= so we can't insert there).
            s = s.replace(/(\n)(m=)/, '$1a=group:BUNDLE 0\r\n$2');
            mutated = true;
          }
          if (!/a=rtcp-rsize/m.test(s)) {
            s = s.replace(/(m=audio[^\n]*\n)/g, '$1a=rtcp-rsize\r\n');
            mutated = true;
          }
          if (mutated) {
            console.log('[sip] munged remote SDP for Chrome compatibility');
            data.sdp = s;
          }
        }

        console.log('[sip] SDP content:\n' + data.sdp);
        const hasFingerprint = /a=fingerprint:/i.test(data.sdp);
        const hasSetup = /a=setup:/i.test(data.sdp);
        const hasMux = /a=rtcp-mux/i.test(data.sdp);
        const hasBundle = /a=group:BUNDLE/i.test(data.sdp);
        const profile = (data.sdp.match(/m=audio \d+ ([A-Z/]+)/i) || [])[1];
        console.log('[sip] SDP summary', {
          origin: data.originator,
          profile,
          hasDtlsFingerprint: hasFingerprint,
          hasDtlsSetup: hasSetup,
          hasMux,
          hasBundle,
        });
      }
    });
    session.on('reinvite', () => console.log('[sip] reinvite', callId));
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

    if (this.calls.size === 0) {
      this.stopQualityPolling();
      this.stopConference();
    }
    // If we drop below 2 calls during a conference, tear it down.
    if (this.calls.size < 2 && this.conferenceCtx) {
      this.stopConference();
    }
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
  async call(rawNumber: string): Promise<void> {
    if (!this.ua) {
      console.error('[sip] call: UA not connected');
      throw new Error('SIP not connected');
    }
    if (!this.ua.isRegistered()) {
      console.warn('[sip] call: UA not registered yet (state will fail)');
    }
    const e164 = toE164(rawNumber);
    const target = `sip:${e164}@${this.realm}`;
    console.log('[sip] dialing', { rawNumber, target, registered: this.ua.isRegistered() });

    // Pre-flight mic permission — getUserMedia errors that happen inside
    // JsSIP can otherwise vanish silently and the call just dies.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // Don't keep this stream around — JsSIP will request its own. Just verify access.
      stream.getTracks().forEach((t) => t.stop());
      console.log('[sip] mic permission OK');
    } catch (e) {
      console.error('[sip] mic permission denied / unavailable', e);
      this.emit<CallEvent>('call', {
        state: 'ended',
        hangupCause: 'mic_permission_denied',
      });
      return;
    }

    applySpeakerSelection(this.primaryAudioEl);

    try {
      const session = this.ua.call(target, {
        mediaConstraints: { audio: true, video: false },
        pcConfig: {
          iceServers: [
            { urls: 'stun:stun.telnyx.com:3478' },
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
          // Prefer ICE connectivity even through restrictive NATs.
          iceTransportPolicy: 'all',
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require',
        },
        rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      });
      console.log('[sip] ua.call returned session', !!session, session?.id);
      // Defensive: attach listeners directly here as well, in case the
      // newRTCSession event hasn't fired yet (race conditions seen on Chrome).
      if (session && !this.calls.has(session.id)) {
        console.log('[sip] manually attaching session listeners');
        this.attachSessionListeners(session);
      }
    } catch (e) {
      console.error('[sip] ua.call threw', e);
      this.emit<CallEvent>('call', {
        state: 'ended',
        hangupCause: e instanceof Error ? e.message : 'call_failed',
      });
    }
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
        pcConfig: {
          iceServers: [
            { urls: 'stun:stun.telnyx.com:3478' },
            { urls: 'stun:stun.l.google.com:19302' },
          ],
        },
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
        // Swap hold music back to mic.
        if (getHoldMusicEnabled()) void this.stopHoldMusic(active);
      } else {
        active.session.hold();
        active.heldLocal = true;
        // Replace outgoing mic track with hold music so the held party
        // hears music instead of silence.
        if (getHoldMusicEnabled() && getHoldMusicDataUrl()) {
          void this.startHoldMusic(active);
        }
      }
    } catch (e) {
      console.warn('[sip] hold/unhold failed', e);
    }
    return active.heldLocal;
  }

  // ---------- 3-way conference (client-side Web Audio mixing) ----------
  // PJSIP-style audio mixing in the browser. For each call we build a tiny
  // routing graph:
  //   - User's mic → all calls' outgoing tracks (parties hear the user)
  //   - Each call's incoming → user's speaker AND every OTHER call's outgoing
  //   - All calls have their SIP direction set back to sendrecv (unhold)
  // Result: all three parties hear each other, hangups are independent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private conferenceCtx: AudioContext | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private conferenceMic: MediaStream | null = null;

  startConference(): boolean {
    if (this.calls.size < 2) {
      console.warn('[sip] conference needs at least 2 calls');
      return false;
    }
    try {
      const entries = Array.from(this.calls.values());
      // Unhold every call so SIP-level audio direction is sendrecv on all legs.
      for (const e of entries) {
        try {
          if (e.heldLocal) {
            e.session.unhold();
            e.heldLocal = false;
          }
        } catch (err) {
          console.warn('[sip] conference unhold failed for', e.id, err);
        }
      }

      // Build the audio context if not yet running.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ctx = (this.conferenceCtx ??= new Ctor());
      void ctx.resume();

      // For each call, capture its remote track as an AudioNode so we can mix.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const remoteSources: { entry: CallEntry; pc: RTCPeerConnection; node: MediaStreamAudioSourceNode }[] = [];
      for (const e of entries) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pc: RTCPeerConnection | null = (e.session as any).connection ?? null;
        if (!pc) continue;
        const remoteStream = new MediaStream();
        for (const receiver of pc.getReceivers()) {
          if (receiver.track?.kind === 'audio') remoteStream.addTrack(receiver.track);
        }
        if (remoteStream.getAudioTracks().length === 0) continue;
        const node = ctx.createMediaStreamSource(remoteStream);
        remoteSources.push({ entry: e, pc, node });
      }

      if (remoteSources.length < 2) {
        console.warn('[sip] conference: not enough remote streams ready');
        return false;
      }

      // Per-call outgoing destination: mic + all other calls' incoming.
      // After we build it, swap the call's outgoing track with this stream's
      // track via sender.replaceTrack().
      const outgoingDests = new Map<string, MediaStreamAudioDestinationNode>();
      for (const rs of remoteSources) {
        const dest = ctx.createMediaStreamDestination();
        outgoingDests.set(rs.entry.id, dest);
      }

      // Mic source — one shared node for all outgoing destinations.
      // Use a fresh getUserMedia so we don't reuse a stream that's still
      // wired to a closed AudioContext from a prior conference.
      return ((): boolean => {
        void navigator.mediaDevices.getUserMedia({ audio: true }).then(async (micStream) => {
          this.conferenceMic = micStream;
          const micNode = ctx.createMediaStreamSource(micStream);

          // Route mic into every outgoing destination.
          for (const [, dest] of outgoingDests) {
            micNode.connect(dest);
          }

          // Route each remote stream into:
          //   (a) the user's speaker (the primary audio element)
          //   (b) every OTHER call's outgoing destination
          // Speakers: we use a single AudioDestinationNode (ctx.destination)
          // so all remotes mix into the user's audio output.
          for (const rs of remoteSources) {
            rs.node.connect(ctx.destination); // user hears this call
            for (const [otherId, dest] of outgoingDests) {
              if (otherId !== rs.entry.id) {
                rs.node.connect(dest); // other party hears this call
              }
            }
          }

          // Replace each call's outgoing audio track with its mixed
          // destination's track.
          for (const rs of remoteSources) {
            const dest = outgoingDests.get(rs.entry.id);
            if (!dest) continue;
            const mixedTrack = dest.stream.getAudioTracks()[0];
            if (!mixedTrack) continue;
            const sender = rs.pc.getSenders().find((s) => s.track?.kind === 'audio');
            if (sender) {
              await sender.replaceTrack(mixedTrack);
              console.log('[sip] conference: replaced outgoing track on', rs.entry.id);
            }
          }
          console.log('[sip] conference active across', remoteSources.length, 'calls');
        }).catch((e) => {
          console.error('[sip] conference: failed to acquire mic', e);
        });
        return true;
      })();
    } catch (e) {
      console.error('[sip] startConference threw', e);
      return false;
    }
  }

  /** Tear down the conference audio graph (called on hangup of any leg). */
  private stopConference(): void {
    if (this.conferenceMic) {
      try { this.conferenceMic.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      this.conferenceMic = null;
    }
    if (this.conferenceCtx) {
      try { void this.conferenceCtx.close(); } catch { /* noop */ }
      this.conferenceCtx = null;
    }
  }

  // ---------- Hold music (Web Audio API + replaceTrack) ----------
  // Each call entry gets a tiny audio routing graph when hold music is
  // requested: <audio> element -> MediaElementSource -> MediaStreamDestination.
  // The resulting MediaStreamTrack replaces the outgoing mic track via
  // sender.replaceTrack(). When unhold fires, we swap back to a fresh mic.
  private async startHoldMusic(entry: CallEntry): Promise<void> {
    const dataUrl = getHoldMusicDataUrl();
    if (!dataUrl) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pc: RTCPeerConnection | null = (entry.session as any).connection ?? null;
    if (!pc) {
      console.warn('[sip] hold music: no peer connection');
      return;
    }
    try {
      const audioEl = new Audio(dataUrl);
      audioEl.loop = true;
      audioEl.autoplay = true;
      // crossOrigin only matters for remote URLs; for data: URLs it's a no-op.
      audioEl.crossOrigin = 'anonymous';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ctx = new ctor();
      if (ctx.state === 'suspended') await ctx.resume();
      const source = ctx.createMediaElementSource(audioEl);
      const dest = ctx.createMediaStreamDestination();
      source.connect(dest);
      const musicTrack = dest.stream.getAudioTracks()[0];
      if (!musicTrack) {
        console.warn('[sip] hold music: dest stream has no audio track');
        return;
      }
      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (!sender) {
        console.warn('[sip] hold music: no audio sender on peer connection');
        return;
      }
      await sender.replaceTrack(musicTrack);
      await audioEl.play();
      // Stash refs on the entry so we can clean up on unhold.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (entry as any).__holdMusic = { audioEl, ctx };
      console.log('[sip] hold music started for', entry.id);
    } catch (e) {
      console.warn('[sip] startHoldMusic failed', e);
    }
  }

  private async stopHoldMusic(entry: CallEntry): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stash = (entry as any).__holdMusic as { audioEl: HTMLAudioElement; ctx: AudioContext } | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pc: RTCPeerConnection | null = (entry.session as any).connection ?? null;
    try {
      if (stash) {
        try { stash.audioEl.pause(); } catch { /* noop */ }
        try { await stash.ctx.close(); } catch { /* noop */ }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (entry as any).__holdMusic;
      }
      if (pc) {
        // Get a fresh mic and swap it back in.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const micTrack = stream.getAudioTracks()[0];
        const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
        if (sender && micTrack) {
          await sender.replaceTrack(micTrack);
          console.log('[sip] hold music stopped, mic restored for', entry.id);
        }
      }
    } catch (e) {
      console.warn('[sip] stopHoldMusic failed', e);
    }
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
    this.stopConference();
    if (this.ua) {
      try { this.ua.stop(); } catch { /* noop */ }
      this.ua = null;
    }
  }
}

export const sipService = new SipService();
