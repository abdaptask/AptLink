// Telnyx WebRTC service. Replaces the JsSIP-based implementation.
// Telnyx's SDK handles SDP munging, TURN credentials, codec negotiation, and DTLS-SRTP
// internally — all the things we were fighting manually with JsSIP.
import { TelnyxRTC } from '@telnyx/webrtc';

export type SipState = 'disconnected' | 'connecting' | 'registered' | 'failed';
export type CallState = 'idle' | 'calling' | 'ringing' | 'connected' | 'ended' | 'incoming';

export interface SipConfig {
  username: string;
  password: string;
  callerNumber?: string;
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
      console.warn('[sip] setSinkId failed', e.message)
    );
  }
}

export class SipService {
  private client: TelnyxRTC | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private currentCall: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private incomingCall: any = null;
  private callerNumber: string = '';
  private audioEl: HTMLAudioElement;
  private listeners: Map<string, Set<Listener>> = new Map();

  constructor() {
    this.audioEl = document.createElement('audio');
    this.audioEl.autoplay = true;
    this.audioEl.id = 'ace-remote-audio';
    document.body.appendChild(this.audioEl);
    applySpeakerSelection(this.audioEl);
  }

  on<T = unknown>(event: string, handler: Listener<T>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler as Listener);
    return () => this.listeners.get(event)?.delete(handler as Listener);
  }

  private emit<T = unknown>(event: string, payload: T): void {
    this.listeners.get(event)?.forEach((h) => h(payload));
  }

  connect(config: SipConfig): void {
    if (this.client) this.disconnect();

    this.callerNumber = config.callerNumber ?? '';

    this.client = new TelnyxRTC({
      login: config.username,
      password: config.password,
    });

    this.client.on('telnyx.ready', () => {
      console.log('[sip] telnyx.ready');
      this.emit<SipState>('state', 'registered');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.on('telnyx.error', (e: any) => {
      console.warn('[sip] telnyx.error', e);
      this.emit<SipState>('state', 'failed');
    });

    this.client.on('telnyx.socket.close', () => {
      console.log('[sip] socket closed');
      this.emit<SipState>('state', 'disconnected');
    });

    this.client.on('telnyx.socket.open', () => {
      console.log('[sip] socket open');
      this.emit<SipState>('state', 'connecting');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.on('telnyx.notification', (notif: any) => {
      const call = notif.call;
      if (!call) return;

      console.log('[sip] call state', call.state, {
        id: call.id,
        rawDirection: call.direction,
        options: call.options,
        cause: call.cause,
        causeCode: call.causeCode,
        sipCode: call.sipCode,
        sipReason: call.sipReason,
      });

      // Robust direction detection. The Telnyx SDK's call.direction field
      // isn't always reliable (varies by version), so we also infer from:
      //   - call.options.remoteCallerNumber: set on inbound only by some SDK versions
      //   - whether we initiated the call (this.currentCall set in our call() method)
      //   - whether the call's destination matches OUR number (= someone dialed us)
      const sdkDir = String(call.direction ?? '').toLowerCase();
      const destNumber: string | undefined = call.options?.destinationNumber;
      const remoteCaller: string | undefined =
        call.options?.remoteCallerNumber ?? call.options?.callerNumber;
      const weInitiated = this.currentCall && this.currentCall.id === call.id;

      let direction: 'inbound' | 'outbound';
      if (sdkDir === 'inbound' || sdkDir === 'incoming') {
        direction = 'inbound';
      } else if (sdkDir === 'outbound' || sdkDir === 'outgoing') {
        direction = 'outbound';
      } else if (weInitiated) {
        direction = 'outbound';
      } else if (destNumber && this.callerNumber && destNumber === this.callerNumber) {
        // Call destined to OUR number that we didn't initiate -> inbound.
        direction = 'inbound';
      } else if (remoteCaller && !weInitiated) {
        direction = 'inbound';
      } else {
        direction = 'outbound';
      }

      const fromNumber = direction === 'outbound' ? this.callerNumber : remoteCaller;
      const toNumber = direction === 'outbound' ? destNumber : this.callerNumber;

      const baseEvent: CallEvent = {
        state: 'idle',
        callId: call.id,
        fromNumber,
        toNumber,
        direction,
        number: direction === 'inbound' ? remoteCaller : destNumber,
      };

      switch (call.state) {
        case 'new':
        case 'trying':
        case 'requesting':
          this.currentCall = call;
          this.emit<CallEvent>('call', { ...baseEvent, state: 'calling' });
          break;
        case 'ringing':
        case 'early':
          if (direction === 'inbound') {
            // SDK tells us about a NEW incoming call. Hold it on the side,
            // don't promote to currentCall until the user accepts.
            this.incomingCall = call;
            this.emit<CallEvent>('call', { ...baseEvent, state: 'incoming' });
          } else {
            this.currentCall = call;
            this.emit<CallEvent>('call', { ...baseEvent, state: 'ringing' });
          }
          break;
        case 'answering':
        case 'active':
          // For inbound, this is the moment the user (or auto-answer) picked up.
          // Promote the incomingCall to currentCall if applicable.
          if (this.incomingCall && this.incomingCall.id === call.id) {
            this.currentCall = this.incomingCall;
            this.incomingCall = null;
          } else {
            this.currentCall = call;
          }
          this.emit<CallEvent>('call', { ...baseEvent, state: 'connected' });
          if (call.remoteStream && this.audioEl) {
            this.audioEl.srcObject = call.remoteStream;
            this.audioEl.play().catch(() => {});
            applySpeakerSelection(this.audioEl);
          }
          break;
        case 'hangup':
        case 'destroy':
        case 'purge':
          this.emit<CallEvent>('call', {
            ...baseEvent,
            state: 'ended',
            hangupCause: call.cause ?? call.sipReason ?? undefined,
          });
          if (this.incomingCall && this.incomingCall.id === call.id) {
            this.incomingCall = null;
          }
          if (this.currentCall && this.currentCall.id === call.id) {
            this.currentCall = null;
          }
          break;
      }
    });

    this.emit<SipState>('state', 'connecting');
    this.client.connect();
  }

  call(rawNumber: string): void {
    if (!this.client) throw new Error('SIP not connected');
    const e164 = toE164(rawNumber);
    console.log('[sip] dialing', { rawNumber, e164, callerNumber: this.callerNumber });

    applySpeakerSelection(this.audioEl);

    this.currentCall = this.client.newCall({
      destinationNumber: e164,
      callerNumber: this.callerNumber,
      callerName: 'ACE Dialer',
      audio: true,
      video: false,
      remoteElement: 'ace-remote-audio',
    });
    this.emit<CallEvent>('call', {
      state: 'calling',
      number: e164,
      callId: this.currentCall?.id,
      fromNumber: this.callerNumber,
      toNumber: e164,
      direction: 'outbound',
    });
  }

  // Accept the currently ringing inbound call.
  acceptCall(): void {
    if (!this.incomingCall) {
      console.warn('[sip] acceptCall called but no incoming call');
      return;
    }
    applySpeakerSelection(this.audioEl);
    if (typeof this.incomingCall.answer === 'function') {
      this.incomingCall.answer();
    } else {
      console.warn('[sip] incoming call has no answer() method');
    }
  }

  // Reject the currently ringing inbound call.
  declineCall(): void {
    if (!this.incomingCall) return;
    if (typeof this.incomingCall.hangup === 'function') {
      this.incomingCall.hangup();
    }
    this.incomingCall = null;
  }

  hangup(): void {
    if (this.currentCall && typeof this.currentCall.hangup === 'function') {
      this.currentCall.hangup();
    }
  }

  // Hold / unhold the active call. Returns true if call is now on hold.
  toggleHold(): boolean {
    if (!this.currentCall) return false;
    try {
      if (this.currentCall.held) {
        if (typeof this.currentCall.unhold === 'function') this.currentCall.unhold();
        return false;
      }
      if (typeof this.currentCall.hold === 'function') this.currentCall.hold();
      return true;
    } catch (e) {
      console.warn('[sip] hold/unhold failed', e);
      return Boolean(this.currentCall.held);
    }
  }

  isOnHold(): boolean {
    return Boolean(this.currentCall?.held);
  }

  // Blind-transfer to a destination number. Telnyx SDK exposes transfer(target).
  transfer(rawDestination: string): boolean {
    if (!this.currentCall) return false;
    if (typeof this.currentCall.transfer !== 'function') return false;
    try {
      const e164 = toE164(rawDestination);
      this.currentCall.transfer(e164);
      return true;
    } catch (e) {
      console.warn('[sip] transfer failed', e);
      return false;
    }
  }

  // Pick a different audio output device (speaker selection).
  async setAudioOutput(deviceId: string): Promise<void> {
    localStorage.setItem('ace_speaker', deviceId);
    if (!this.audioEl) return;
    if (!('setSinkId' in this.audioEl)) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.audioEl as any).setSinkId(deviceId);
    } catch (e) {
      console.warn('[sip] setSinkId failed', e);
    }
  }

  async listAudioOutputs(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'audiooutput');
    } catch {
      return [];
    }
  }

  toggleMute(): boolean {
    if (!this.currentCall) return false;
    if (typeof this.currentCall.toggleAudioMute === 'function') {
      this.currentCall.toggleAudioMute();
      return Boolean(this.currentCall.audioMuted);
    }
    return false;
  }

  sendDTMF(digit: string): void {
    if (this.currentCall && typeof this.currentCall.dtmf === 'function') {
      this.currentCall.dtmf(digit);
    }
  }

  disconnect(): void {
    this.hangup();
    this.declineCall();
    this.client?.disconnect();
    this.client = null;
    this.currentCall = null;
    this.incomingCall = null;
  }
}

export const sipService = new SipService();
