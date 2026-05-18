// Telnyx WebRTC service.
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private secondCall: any = null; // Phase 5.4 — second simultaneous call (held)
  private heldLocal: boolean = false; // Locally tracked hold state (the SDK's .held is unreliable)
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
            this.incomingCall = call;
            this.emit<CallEvent>('call', { ...baseEvent, state: 'incoming' });
          } else {
            this.currentCall = call;
            this.emit<CallEvent>('call', { ...baseEvent, state: 'ringing' });
          }
          break;
        case 'answering':
        case 'active':
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
            // Active call ended — reset hold state.
            this.heldLocal = false;
            // If a held second call exists, promote it to active.
            if (this.secondCall) {
              try {
                if (typeof this.secondCall.unhold === 'function') this.secondCall.unhold();
              } catch { /* noop */ }
              this.currentCall = this.secondCall;
              this.secondCall = null;
            } else {
              this.currentCall = null;
            }
          }
          if (this.secondCall && this.secondCall.id === call.id) {
            this.secondCall = null;
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

  // Phase 5.4: add a second simultaneous call. Holds the existing currentCall
  // (becomes secondCall in held state) and starts a new active call.
  addCall(rawNumber: string): void {
    if (!this.client) throw new Error('SIP not connected');
    if (!this.currentCall) {
      // No active call → behave like a normal call.
      this.call(rawNumber);
      return;
    }
    // Move currentCall to secondCall (held) and put it on hold.
    try {
      if (typeof this.currentCall.hold === 'function') this.currentCall.hold();
    } catch (e) {
      console.warn('[sip] hold for addCall failed', e);
    }
    this.secondCall = this.currentCall;

    const e164 = toE164(rawNumber);
    console.log('[sip] addCall dialing', { e164 });
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

  // Swap which call is active. The held one becomes current; the current one
  // is put on hold and becomes held.
  swapCalls(): void {
    if (!this.currentCall || !this.secondCall) return;
    try {
      if (typeof this.currentCall.hold === 'function') this.currentCall.hold();
      if (typeof this.secondCall.unhold === 'function') this.secondCall.unhold();
    } catch (e) {
      console.warn('[sip] swap failed', e);
    }
    const tmp = this.currentCall;
    this.currentCall = this.secondCall;
    this.secondCall = tmp;
  }

  // Telnyx call IDs for the active + held calls (used by the conference endpoint).
  getActiveCallId(): string | null {
    return this.currentCall?.id ?? null;
  }
  getHeldCallId(): string | null {
    return this.secondCall?.id ?? null;
  }

  acceptCall(): void {
    if (!this.incomingCall) {
      console.warn('[sip] acceptCall called but no incoming call');
      return;
    }
    applySpeakerSelection(this.audioEl);
    if (typeof this.incomingCall.answer === 'function') {
      this.incomingCall.answer();
    }
  }

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

  toggleHold(): boolean {
    if (!this.currentCall) return false;
    try {
      if (this.heldLocal) {
        if (typeof this.currentCall.unhold === 'function') {
          this.currentCall.unhold();
        } else if (typeof this.currentCall.toggleHold === 'function') {
          this.currentCall.toggleHold();
        }
        this.heldLocal = false;
        return false;
      } else {
        if (typeof this.currentCall.hold === 'function') {
          this.currentCall.hold();
        } else if (typeof this.currentCall.toggleHold === 'function') {
          this.currentCall.toggleHold();
        }
        this.heldLocal = true;
        return true;
      }
    } catch (e) {
      console.warn('[sip] hold/unhold failed', e);
      return this.heldLocal;
    }
  }

  isOnHold(): boolean {
    return this.heldLocal;
  }

  transfer(rawDestination: string): boolean {
    if (!this.currentCall) {
      console.warn('[sip] transfer: no active call');
      return false;
    }
    const e164 = toE164(rawDestination);
    // Try the SDK's transfer methods in order of preference.
    // Different @telnyx/webrtc versions expose this differently.
    const c = this.currentCall;
    const candidates: Array<[string, () => unknown]> = [
      ['transfer', () => c.transfer?.(e164)],
      ['blindTransfer', () => c.blindTransfer?.(e164)],
      ['deflect', () => c.deflect?.(e164)],
    ];
    for (const [name, fn] of candidates) {
      try {
        if (typeof (c as Record<string, unknown>)[name] === 'function') {
          console.log('[sip] transfer via', name, '→', e164);
          fn();
          return true;
        }
      } catch (e) {
        console.warn(`[sip] ${name} threw`, e);
      }
    }
    console.warn(
      '[sip] no transfer method on call object. Available:',
      Object.keys(c).filter((k) => typeof (c as Record<string, unknown>)[k] === 'function'),
    );
    return false;
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
    if (this.secondCall && typeof this.secondCall.hangup === 'function') {
      try { this.secondCall.hangup(); } catch { /* noop */ }
    }
    this.client?.disconnect();
    this.client = null;
    this.currentCall = null;
    this.incomingCall = null;
    this.secondCall = null;
    this.heldLocal = false;
  }
}

export const sipService = new SipService();
