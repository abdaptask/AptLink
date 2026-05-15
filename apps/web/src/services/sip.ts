// Telnyx WebRTC service. Replaces the JsSIP-based implementation.
// Telnyx's SDK handles SDP munging, TURN credentials, codec negotiation, and DTLS-SRTP
// internally — all the things we were fighting manually with JsSIP.
import { TelnyxRTC } from '@telnyx/webrtc';

export type SipState = 'disconnected' | 'connecting' | 'registered' | 'failed';
export type CallState = 'idle' | 'calling' | 'ringing' | 'connected' | 'ended';

export interface SipConfig {
  username: string;
  password: string;
  callerNumber?: string;
}

export interface CallEvent {
  state: CallState;
  number?: string;
  reason?: string;
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
      this.currentCall = call;
      console.log('[sip] call state', call.state, {
        id: call.id,
        cause: call.cause,
        causeCode: call.causeCode,
        sipCode: call.sipCode,
        sipReason: call.sipReason,
      });

      switch (call.state) {
        case 'new':
        case 'trying':
        case 'requesting':
          this.emit<CallEvent>('call', {
            state: 'calling',
            number: call.options?.destinationNumber,
          });
          break;
        case 'ringing':
        case 'early':
          this.emit<CallEvent>('call', { state: 'ringing' });
          break;
        case 'answering':
        case 'active':
          this.emit<CallEvent>('call', { state: 'connected' });
          // SDK attaches remoteStream automatically via remoteElement option, but be safe.
          if (call.remoteStream && this.audioEl) {
            this.audioEl.srcObject = call.remoteStream;
            this.audioEl.play().catch(() => {});
            applySpeakerSelection(this.audioEl);
          }
          break;
        case 'hangup':
        case 'destroy':
        case 'purge':
          this.emit<CallEvent>('call', { state: 'ended' });
          this.currentCall = null;
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
    this.emit<CallEvent>('call', { state: 'calling', number: e164 });
  }

  hangup(): void {
    if (this.currentCall && typeof this.currentCall.hangup === 'function') {
      this.currentCall.hangup();
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
    this.client?.disconnect();
    this.client = null;
    this.currentCall = null;
  }
}

export const sipService = new SipService();
