// Thin wrapper around JsSIP. Phase 4.5: outbound calls only.
import JsSIP from 'jssip';

export type SipState = 'disconnected' | 'connecting' | 'registered' | 'failed';
export type CallState = 'idle' | 'calling' | 'ringing' | 'connected' | 'ended';

export interface SipConfig {
  wsUri: string;
  uri: string;
  authorizationUser: string;
  password: string;
  displayName?: string;
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

function buildAudioConstraints(): MediaStreamConstraints['audio'] {
  const micId = localStorage.getItem('ace_mic');
  if (micId && micId !== 'default') {
    return { deviceId: { exact: micId } };
  }
  return true;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ua: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private currentSession: any = null;
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
    if (this.ua) this.disconnect();

    const socket = new JsSIP.WebSocketInterface(config.wsUri);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.ua = new (JsSIP as any).UA({
      uri: config.uri,
      password: config.password,
      authorization_user: config.authorizationUser,
      display_name: config.displayName,
      sockets: [socket],
      register: true,
      session_timers: false,
    });

    this.ua.on('connecting', () => this.emit<SipState>('state', 'connecting'));
    this.ua.on('connected', () => this.emit<SipState>('state', 'connecting'));
    this.ua.on('disconnected', () => this.emit<SipState>('state', 'disconnected'));
    this.ua.on('registered', () => this.emit<SipState>('state', 'registered'));
    this.ua.on('unregistered', () => this.emit<SipState>('state', 'disconnected'));
    this.ua.on('registrationFailed', () => this.emit<SipState>('state', 'failed'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.ua.on('newRTCSession', (data: any) => {
      this.bindSession(data.session);
    });

    this.ua.start();
  }

  call(rawNumber: string): void {
    if (!this.ua) throw new Error('SIP not connected');
    const e164 = toE164(rawNumber);
    const targetUri = `sip:${e164}@sip.telnyx.com`;
    console.log('[sip] dialing', { rawNumber, e164, targetUri });

    applySpeakerSelection(this.audioEl);

    this.currentSession = this.ua.call(targetUri, {
      mediaConstraints: { audio: buildAudioConstraints(), video: false },
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      pcConfig: {
        iceServers: [
          { urls: 'stun:stun.telnyx.com:3478' },
          { urls: 'stun:stun.l.google.com:19302' },
        ],
      },
    });
    this.bindSession(this.currentSession);
    this.emit<CallEvent>('call', { state: 'calling', number: e164 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bindSession(session: any): void {
    this.currentSession = session;

    session.on('progress', () => this.emit<CallEvent>('call', { state: 'ringing' }));
    session.on('accepted', () => this.emit<CallEvent>('call', { state: 'connected' }));
    session.on('confirmed', () => this.emit<CallEvent>('call', { state: 'connected' }));
    session.on('ended', () => {
      this.emit<CallEvent>('call', { state: 'ended' });
      this.currentSession = null;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.on('failed', (e: any) => {
      const reason = e?.cause ?? e?.message?.reason_phrase ?? 'failed';
      console.warn('[sip] call failed', { reason, raw: e });
      this.emit<CallEvent>('call', { state: 'ended', reason });
      this.currentSession = null;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.on('peerconnection', (data: any) => {
      const pc: RTCPeerConnection = data.peerconnection;
      pc.addEventListener('track', (ev: RTCTrackEvent) => {
        if (ev.streams && ev.streams[0]) {
          this.audioEl.srcObject = ev.streams[0];
          applySpeakerSelection(this.audioEl);
        }
      });
    });
  }

  hangup(): void {
    this.currentSession?.terminate();
  }

  toggleMute(): boolean {
    if (!this.currentSession) return false;
    const isMuted = this.currentSession.isMuted().audio;
    if (isMuted) this.currentSession.unmute({ audio: true });
    else this.currentSession.mute({ audio: true });
    return !isMuted;
  }

  sendDTMF(digit: string): void {
    this.currentSession?.sendDTMF(digit);
  }

  disconnect(): void {
    this.currentSession?.terminate();
    this.ua?.stop();
    this.ua = null;
    this.currentSession = null;
  }
}

export const sipService = new SipService();
