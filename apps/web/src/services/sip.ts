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
  /**
   * v0.9.13 — Additional ICE servers to add to the default Telnyx STUN+TURN
   * set. Cloudflare TURN credentials live here when the backend's
   * GET /turn-credentials endpoint returns them. Optional and may be undefined
   * — if it's not set, we fall back to Telnyx-TURN-only which is enough for
   * 95% of NAT topologies.
   */
  extraIceServers?: RTCIceServer[];
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
 * Audio constraints applied to every getUserMedia call we make.
 *
 * Why all this matters:
 *   - echoCancellation: REQUIRED. Without it the remote party hears their
 *     own voice come back as echo (especially when the user is on speakers
 *     instead of a headset). Chrome defaults this to true, Safari does NOT.
 *   - noiseSuppression: filters keyboard taps, AC hum, breathing.
 *   - autoGainControl: keeps the user's voice at a consistent level so the
 *     other party doesn't have to crank their volume up and down.
 *   - sampleRate 48000: matches Opus (the codec Telnyx negotiates) so the
 *     browser doesn't have to resample mid-call.
 *   - channelCount 1: voice is mono — saves bandwidth.
 *   - deviceId: honors the mic the user chose in Settings → Audio.
 */
function buildAudioConstraints(): MediaTrackConstraints {
  const micId = localStorage.getItem('ace_mic');
  // IMPORTANT: use `ideal` (not exact/hard) for sampleRate and channelCount.
  // Hard constraints fail silently on Bluetooth headsets, USB phones, and
  // older mics — the browser then either returns no audio or falls back to
  // a low-quality default that makes the user sound like they're in a pipe.
  // With `ideal`, the browser tries 48kHz/mono first but accepts the device's
  // native format if it can't comply.
  // Browser audio processing is per-track. For VoIP on a wired headset (boom
  // mic close to mouth) we keep echo cancellation and AGC on, but DISABLE
  // noiseSuppression — Chrome's RNNoise filter is aggressive and produces
  // the "speaking from a tunnel / pipe" sound recipients complain about.
  // Telnyx-side NS should also be off (one suppression pass at most, ideally
  // none if the user is in a quiet space).
  const constraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
  };
  if (micId && micId !== 'default') {
    // `ideal` here too — if the saved device was unplugged, fall back to
    // the default mic instead of refusing to acquire audio.
    constraints.deviceId = { ideal: micId };
  }
  // `latency` isn't in TS's MediaTrackConstraints type but is honored by
  // Chrome — ~20ms is the sweet spot for real-time voice. Cast through any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (constraints as any).latency = { ideal: 0.02 };
  return constraints;
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
    if (this.ua) {
      // An old UA exists. Evict its Contact at Telnyx via wildcard
      // unregister BEFORE we tear down the WebSocket, then defer the new
      // UA creation by ~350ms so the unregister REGISTER frame flushes
      // and Telnyx processes it before our new REGISTER arrives. Without
      // this delay, the new REGISTER can land at Telnyx FIRST and then
      // get evicted by our own wildcard unregister — leaving us silently
      // unregistered while the UI thinks we're online. This is exactly
      // the failure mode behind the dual-Contact INVITE-fork bug.
      this.scheduleCleanup(this.ua);
      this.ua = null;
      setTimeout(() => this._doConnect(config), 350);
      return;
    }
    this._doConnect(config);
  }

  /**
   * Internal: send a SPECIFIC-Contact unregister on the given (old) UA,
   * then close its socket ~250ms later so the REGISTER frame has time to
   * flush over the WebSocket before close. Caller is expected to set
   * this.ua = null immediately so subsequent operations don't touch the
   * dying UA.
   *
   * v0.8.8: switched from `unregister({all:true})` (Contact:*) to plain
   * `unregister()` (Contact:<thisDevice>;expires=0). Wildcard form evicts
   * ALL Contacts for the same SIP user — which would kick OTHER devices
   * out of the registrar whenever this device quits. Specific-Contact
   * unregister evicts only this device's Contact.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private scheduleCleanup(oldUa: any): void {
    try { oldUa?.unregister?.(); } catch (e) {
      console.warn('[sip] cleanup unregister threw', e);
    }
    setTimeout(() => {
      try { oldUa?.stop?.(); } catch { /* noop */ }
    }, 250);
  }

  private _doConnect(config: SipConfig): void {
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
      // Phase 6.9 — registration resilience.
      // 600s expiry gives a 10-minute buffer against background-tab timer
      // throttling. We pair this with a 20s active heartbeat (see
      // installRegistrationHeartbeat below) that calls ua.register()
      // unconditionally so Telnyx never sees us as expired.
      register: true,
      register_expires: 600,
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
      // Successful REGISTER — clear the first-login retry counter so a
      // later daytime hiccup gets the full 3-retry budget again.
      this.regFailCount = 0;
      if (this.regRetryTimer) {
        clearTimeout(this.regRetryTimer);
        this.regRetryTimer = null;
      }
      this.emit<SipState>('state', 'registered');
    });
    this.ua.on('unregistered', () => {
      console.log('[sip] unregistered');
      this.emit<SipState>('state', 'disconnected');
    });
    // v0.9.13 — auto-retry on registrationFailed.
    //
    // Symptom this fixes: brand-new user signs in via the welcome email
    // within seconds of admin pressing Invite. Telnyx's /credential_connections
    // provisioning API returns 201 instantly, but their SIP registrar is a
    // separate distributed service that takes ~5-15s to replicate the new
    // credential. The very first REGISTER hits the registrar before
    // replication completes, returns 401/403, JsSIP fires registrationFailed
    // exactly once, and we used to flip to 'failed' state and sit there
    // forever — user had to Ctrl+Shift+R to get online.
    //
    // Fix: exponential backoff retry. 2s → 4s → 8s (14s total window,
    // comfortably covers the Telnyx propagation delay). After 3 failures
    // we give up and surface 'failed' so the user sees Disconnected and
    // can investigate (genuinely bad creds shouldn't auto-retry forever
    // — that just hammers Telnyx). Counter resets on 'registered' so a
    // later transient failure gets the full 3-retry budget.
    //
    // We stay in 'connecting' state during the retry window so the UI
    // shows a smooth Connecting → Online transition instead of a red
    // Disconnected flashing back to green.
    //
    // v0.9.14 — CRITICAL guard against tearing down active calls.
    // v0.9.13's retry was too aggressive: when a routine REGISTER refresh
    // failed mid-call (common on flaky India ↔ US links), we called
    // reconnect() which destroys the UA + every in-flight session. The
    // caller's dialer showed the call drop, they immediately redialed,
    // and the recipient's cell phone rang again. From the recipient's
    // perspective this looked like "constantly ringing even while on a
    // call with him" because each successful call only lasted as long
    // as the next REGISTER heartbeat. The guard: skip the teardown if
    // any RTCSession is active. JsSIP's own registrar will keep retrying
    // the REGISTER refresh on its existing 600s expiry window — no need
    // for us to kill the UA. We still apply the retry for cold-start
    // failures (no active call → safe to tear down).
    this.ua.on('registrationFailed', (e: { cause?: string }) => {
      const hasActiveCall = this.calls.size > 0 || this.incomingCallId !== null;
      if (hasActiveCall) {
        console.warn(
          `[sip] registrationFailed during active call (calls=${this.calls.size}, incoming=${this.incomingCallId ? 'yes' : 'no'}) — skipping retry, letting JsSIP handle refresh internally`,
          e.cause,
        );
        // Don't increment regFailCount, don't tear down. The existing
        // registration (TTL up to 600s) keeps the call's SIP routing alive
        // long enough for the conversation to finish, and JsSIP retries
        // REGISTER refreshes on its own timer.
        return;
      }

      this.regFailCount += 1;
      console.warn(
        `[sip] registrationFailed (attempt ${this.regFailCount}/${SipService.MAX_REG_RETRIES})`,
        e.cause,
      );
      if (this.regFailCount >= SipService.MAX_REG_RETRIES) {
        console.warn('[sip] giving up after', this.regFailCount, 'failed registrations');
        this.emit<SipState>('state', 'failed');
        return;
      }
      // 2s, 4s, 8s — exponential backoff.
      const backoffMs = 2_000 * Math.pow(2, this.regFailCount - 1);
      console.log(`[sip] retrying registration in ${backoffMs}ms…`);
      // Keep showing 'connecting' to the UI — smoother UX than failed→connecting→registered flicker.
      this.emit<SipState>('state', 'connecting');
      if (this.regRetryTimer) clearTimeout(this.regRetryTimer);
      this.regRetryTimer = setTimeout(() => {
        this.regRetryTimer = null;
        if (!this.lastConfig) {
          console.warn('[sip] retry: no saved config — cannot reconnect');
          this.emit<SipState>('state', 'failed');
          return;
        }
        // Re-check active-call guard at the moment of teardown — a call
        // could have arrived during the 2-8s backoff window.
        const stillSafe = this.calls.size === 0 && this.incomingCallId === null;
        if (!stillSafe) {
          console.warn('[sip] retry-time check: active call appeared during backoff, skipping teardown');
          return;
        }
        // reconnect() tears down the UA + does wildcard unregister so
        // Telnyx evicts any half-state Contact, then connect()s fresh.
        this.reconnect();
      }, backoffMs);
    });

    // Each new outgoing or incoming call is a "newRTCSession" event.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.ua.on('newRTCSession', (data: any) => {
      const session: RTCSession = data.session;
      this.attachSessionListeners(session);
    });

    this.emit<SipState>('state', 'connecting');
    this.ua.start();

    // Recover from background-tab throttling + actively keep registration
    // alive even when the tab is in the foreground. See block below.
    this.installVisibilityRecovery();
    this.installRegistrationHeartbeat();
    this.saveConfigForReconnect(config);
  }

  /** Saved connect() config, used by reconnect() to rebuild the UA. */
  private lastConfig: SipConfig | null = null;

  /**
   * v0.9.13 — Build the ICE servers list used by both outbound call() and
   * inbound answer() PeerConnections. Includes:
   *   1) STUN (Telnyx + Google) for direct-connection NAT discovery
   *   2) Telnyx TURN, authenticated with the user's SIP credentials. This
   *      relays media through Telnyx's global TURN footprint when ICE can't
   *      find a direct path — the typical case for users behind symmetric
   *      NAT (corporate networks, many Indian/SE Asian ISPs). Without this,
   *      SIP signaling succeeds but RTP gets blackholed and both sides hear
   *      silence after answering. UDP first (fastest), then TCP fallback,
   *      then TLS-443 fallback for networks that block UDP and non-443 TCP.
   *   3) Optional extra servers — currently used to layer Cloudflare TURN as
   *      a failover when CLOUDFLARE_TURN_KEY_ID/API_TOKEN are set on the API.
   */
  /**
   * v0.9.13 — Layer in additional ICE servers after the initial connect.
   * Used by SipContext to add Cloudflare TURN once the API's
   * /turn-credentials round-trip finishes (which happens asynchronously so
   * it doesn't delay the initial REGISTER). The next call() or answer()
   * will pick these up. Existing in-flight calls keep their original ICE
   * config (PeerConnections don't accept iceServers updates mid-session).
   */
  updateExtraIceServers(extraIceServers: RTCIceServer[]): void {
    if (!this.lastConfig) return;
    this.lastConfig = { ...this.lastConfig, extraIceServers };
    // v0.9.14 — log the full ice-servers payload after merging so we can
    // verify Cloudflare's TURN URLs + credentials are reaching the browser
    // intact. Without this, "cloudflare TURN added" prints true even when
    // the response has empty urls or malformed credentials, and ICE fails
    // silently at gathering time. Anything weird here (empty urls array,
    // missing credential, wrong scheme like `turn:` vs `turns:`) jumps out.
    try {
      const merged = this.buildIceServers();
      console.log('[sip] ice servers after Cloudflare merge:', JSON.stringify(merged, null, 2));
    } catch (e) {
      console.warn('[sip] failed to log merged ice servers', e);
    }
  }

  private buildIceServers(): RTCIceServer[] {
    const cfg = this.lastConfig;
    const turnUser = cfg?.username ?? '';
    const turnPass = cfg?.password ?? '';
    const servers: RTCIceServer[] = [
      { urls: 'stun:stun.telnyx.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    // Only add Telnyx TURN if we actually have SIP credentials. Without
    // them the TURN authentication challenge would fail and we'd just be
    // adding latency for nothing.
    if (turnUser && turnPass) {
      servers.push(
        { urls: 'turn:turn.telnyx.com:3478?transport=udp', username: turnUser, credential: turnPass },
        { urls: 'turn:turn.telnyx.com:3478?transport=tcp', username: turnUser, credential: turnPass },
        // TLS-443 fallback for restrictive networks (corporate firewalls
        // that allow only outbound 443/TCP).
        { urls: 'turns:turn.telnyx.com:443?transport=tcp', username: turnUser, credential: turnPass },
      );
    }
    if (cfg?.extraIceServers?.length) {
      servers.push(...cfg.extraIceServers);
    }
    return servers;
  }

  /**
   * v0.9.13 — first-login registration-retry state. Survives across
   * reconnect() calls because both fields are on `this` (not on the UA
   * instance, which we throw away on every reconnect). regFailCount
   * resets to 0 on a successful 'registered' event so a later daytime
   * hiccup gets the full retry budget.
   */
  private regFailCount = 0;
  private regRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_REG_RETRIES = 3;
  private saveConfigForReconnect(config: SipConfig): void {
    this.lastConfig = config;
  }

  /**
   * Phase 6.9 — Manual reconnect. Tears down the existing UA completely
   * and starts a fresh one with the saved config. Exposed so the React
   * status indicator can show a 'Reconnect' button as a one-tap recovery
   * when the UA gets stuck. The user shouldn't need Ctrl+Shift+R anymore.
   */
  reconnect(): void {
    console.log('[sip] manual reconnect — wildcard unregister + tear down UA');
    const cfg = this.lastConfig;
    // Wildcard unregister BEFORE stop so Telnyx evicts our Contact
    // immediately rather than waiting 600s for it to expire. Without this
    // the old Contact lingers and Telnyx forks the next INVITE to both
    // the dead Contact and the new one — that fork race is what was
    // making inbound Accept fail with INVALID_STATE_ERROR.
    if (this.ua) {
      this.scheduleCleanup(this.ua);
      this.ua = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!cfg) {
      console.warn('[sip] reconnect: no saved config — refresh the page');
      return;
    }
    // 350ms gives the wildcard REGISTER frame time to flush and lets
    // Telnyx process the eviction BEFORE the new UA's REGISTER arrives.
    setTimeout(() => this.connect(cfg), 350);
  }

  private visibilityHandler: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Phase 6.9 — proactive registration heartbeat. Calls ua.register()
   * every 20s so we refresh well within the 600s expiry, even when the
   * browser is throttling background timers. Cheap (one SIP REGISTER per
   * 20s) and the only reliable way to keep the WebRTC client's presence
   * alive across tab switches.
   */
  private installRegistrationHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ua) return;
      try {
        const isConnected = this.ua.isConnected?.() ?? false;
        const isRegistered = this.ua.isRegistered?.() ?? false;
        if (!isConnected) {
          // Socket died — full reconnect needed.
          console.log('[sip] heartbeat: socket dead, triggering reconnect');
          this.reconnect();
          return;
        }
        // Send REGISTER refresh. JsSIP queues it through the same socket.
        // Idempotent — Telnyx accepts repeated registrations from the
        // same Contact and just refreshes the expiry.
        try { this.ua.register(); } catch (e) {
          console.warn('[sip] heartbeat register threw', e);
        }
        if (!isRegistered) {
          console.log('[sip] heartbeat: was unregistered, forcing register');
        }
      } catch (e) {
        console.warn('[sip] heartbeat error', e);
      }
    }, 20_000);
  }

  private installVisibilityRecovery(): void {
    // Idempotent — don't double-attach if connect() is ever called twice.
    if (this.visibilityHandler) return;
    this.visibilityHandler = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      if (!this.ua) return;
      try {
        const isRegistered = this.ua.isRegistered?.() ?? false;
        const isConnected = this.ua.isConnected?.() ?? false;
        console.log('[sip] visibility=visible — connected:', isConnected, 'registered:', isRegistered);
        if (!isConnected) {
          // WebSocket died while backgrounded. Full UA rebuild — calling
          // start() on a dead UA often leaves it stuck.
          this.reconnect();
        } else if (!isRegistered) {
          // Socket alive, but registration lapsed. Force a new REGISTER.
          try { this.ua.register(); } catch (e) { console.warn('[sip] visibility register threw', e); }
        }
      } catch (e) {
        console.warn('[sip] visibility handler error', e);
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('focus', this.visibilityHandler);
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
      // CRITICAL for Add Call: promote this new session to active BEFORE
      // emitting 'calling' so SipContext's "ignore non-active events" filter
      // lets this event through. Without this, the 2nd call's calling/ringing
      // states never reach the UI (and the ringback hook never fires).
      // Any pre-existing call has already been held by addCall() above.
      this.activeCallId = callId;
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

    // ICE candidate trickle — v0.8.10
    //
    // JsSIP's _createLocalDescription waits for one of two signals before
    // sending the SIP request/response:
    //   (a) RTCPeerConnection.iceGatheringState === 'complete', OR
    //   (b) an 'icecandidate' event with candidate === null (end-of-candidates)
    //
    // On Chromium-Electron-Windows neither reliably fires within Telnyx's
    // 5-second progress-timeout window. Result: createLocalDescription hangs
    // forever, the 200 OK is never sent, and Telnyx CANCELs the call with
    // Q.850 cause=807 PROGRESS_TIMEOUT.
    //
    // JsSIP exposes an escape hatch: every 'icecandidate' event includes a
    // ready() callback. Calling it tells JsSIP \"stop waiting -- send the
    // SIP message NOW with whatever candidates we already collected.\"
    // host + srflx covers nearly every real-world NAT scenario.
    //
    // Strategy: on the first server-reflexive (srflx) candidate fire
    // ready() immediately. Safety net: 1500ms hard timeout from the first
    // candidate, so even if srflx never arrives we don't hang past Telnyx's
    // progress timer.
    let iceReadyCalled = false;
    let iceReadyTimer: number | null = null;
    const fireReady = (ready: () => void, reason: string): void => {
      if (iceReadyCalled) return;
      iceReadyCalled = true;
      if (iceReadyTimer !== null) {
        window.clearTimeout(iceReadyTimer);
        iceReadyTimer = null;
      }
      console.log('[sip] forcing JsSIP iceReady -', reason);
      try { ready(); } catch (e) { console.warn('[sip] ready() threw', e); }
    };
    session.on('icecandidate', (data: {
      candidate?: { candidate?: string; type?: string; protocol?: string; address?: string };
      ready?: () => void;
    }) => {
      const cand = data?.candidate;
      const ready = data?.ready;
      console.log('[sip] icecandidate', cand?.type, cand?.protocol, cand?.address);
      if (!ready) return;
      if (!iceReadyCalled && cand?.type === 'srflx') {
        fireReady(ready, 'srflx ' + (cand.address ?? ''));
        return;
      }
      if (!iceReadyCalled && iceReadyTimer === null) {
        iceReadyTimer = window.setTimeout(() => {
          fireReady(ready, 'timeout-1500ms');
        }, 1500);
      }
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
        // Opus tuning runs on BOTH local and remote SDP so both sides know
        // we want FEC, no DTX, mono, ~24kbps, 20ms ptime. (In Opus the fmtp
        // describes what the SENDER produces, so we set our own outbound
        // params in our local offer/answer; the remote-SDP munge tells the
        // far side what to expect.)
        const tuneOpus = (sdp: string): { sdp: string; mutated: boolean } => {
          let s = sdp;
          let m = false;
          const opusMatch = s.match(/a=rtpmap:(\d+)\s+opus\//i);
          if (opusMatch) {
            const pt = opusMatch[1];
            const fmtpRe = new RegExp(`a=fmtp:${pt}[^\\r\\n]*`);
            const opusParams = 'useinbandfec=1;usedtx=0;stereo=0;maxaveragebitrate=32000;maxplaybackrate=48000;minptime=10;ptime=20';
            if (fmtpRe.test(s)) {
              s = s.replace(fmtpRe, `a=fmtp:${pt} ${opusParams}`);
            } else {
              s = s.replace(opusMatch[0], `${opusMatch[0]}\r\na=fmtp:${pt} ${opusParams}`);
            }
            m = true;
          }
          return { sdp: s, mutated: m };
        };

        if (data.originator === 'remote') {
          // For remote SDP, add the WebRTC attributes Chrome requires that
          // Telnyx's FreeSWITCH backend doesn't emit by default:
          //   - a=rtcp-mux         (mux RTP+RTCP on same port)
          //   - a=group:BUNDLE 0   (bundle media streams)
          //   - a=rtcp-rsize       (reduced-size RTCP)
          // Without these, Chrome's setRemoteDescription throws and JsSIP
          // surfaces "Bad Media Description".
          let s = data.sdp;
          let mutated = false;
          if (!/a=rtcp-mux/m.test(s)) {
            s = s.replace(/(m=audio[^\n]*\n)/g, '$1a=rtcp-mux\r\n');
            mutated = true;
          }
          if (!/a=group:BUNDLE/m.test(s)) {
            s = s.replace(/(\n)(m=)/, '$1a=group:BUNDLE 0\r\n$2');
            mutated = true;
          }
          if (!/a=rtcp-rsize/m.test(s)) {
            s = s.replace(/(m=audio[^\n]*\n)/g, '$1a=rtcp-rsize\r\n');
            mutated = true;
          }
          const tuned = tuneOpus(s);
          s = tuned.sdp;
          mutated = mutated || tuned.mutated;
          if (mutated) {
            console.log('[sip] munged remote SDP for Chrome compatibility + Opus tuning');
            data.sdp = s;
          }
        } else if (data.originator === 'local') {
          // Apply Opus tuning to our outgoing offer too — this is what
          // actually controls the quality of OUR voice (FEC, ptime, bitrate).
          // Without this, Chrome's default Opus params apply.
          const tuned = tuneOpus(data.sdp);
          if (tuned.mutated) {
            console.log('[sip] tuned local SDP Opus params for outbound voice');
            data.sdp = tuned.sdp;
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
    // Snapshot the 'ended' event BEFORE we mutate state so the receiver can
    // compare e.callId against the post-cleanup activeCallId to decide
    // whether to swap callState to a promoted call.
    const endedEvent: CallEvent = { ...this.buildEvent(entry, 'ended'), hangupCause: cause };

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

    // If a HELD call remains, promote it to active and unhold.
    // Bug fix: previously this took the first call regardless of state,
    // which falsely promoted still-ringing incoming calls to 'connected'
    // when the active call ended. Only promote calls that were explicitly
    // placed on hold (heldLocal === true). Ringing/incoming sessions are
    // left alone so their natural lifecycle plays out.
    let promotedEvent: CallEvent | null = null;
    if (!this.activeCallId && this.calls.size > 0) {
      const next = Array.from(this.calls.values()).find(
        (c) => c.heldLocal && c.id !== this.incomingCallId,
      );
      if (next) {
        this.activeCallId = next.id;
        // Bug fix: previously this called next.session.unhold() directly,
        // which is a no-op for music-hold (we never sent a SIP hold —
        // just swapped the outgoing track to the music stream). Result:
        // music kept playing on the outgoing sender after promotion, and
        // the user had to tap Hold/Resume 2-3 times before the mic was
        // back. unholdCallWithMusicIfConfigured handles both paths:
        // music-hold -> stopHoldMusic (restores fresh mic track);
        // SIP-hold -> session.unhold().
        void this.unholdCallWithMusicIfConfigured(next);
        if (next.audioEl) {
          this.primaryAudioEl.srcObject = next.audioEl.srcObject;
        }
        this.primaryAudioEl.muted = false;
        promotedEvent = this.buildEvent(next, 'connected');
        console.log('[sip] promoted held call to active:', next.id);
      }
    }

    // Now emit — the 'ended' first (so logs/persistence run), then the
    // 'connected' for the promoted call (so the UI swaps to it cleanly).
    this.emit<CallEvent>('call', endedEvent);
    if (promotedEvent) {
      this.emit<CallEvent>('call', promotedEvent);
    }

    if (this.calls.size === 0) {
      this.stopQualityPolling();
      this.stopConference();
    }
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
    // IVR support: split on ',' or ';' so the user can pre-encode extension
    // navigation, e.g., "5551234567,,802" dials 5551234567, waits, then
    // auto-sends DTMF "802" once the call connects. Each comma = ~1s pause.
    const ivrSplit = rawNumber.split(/[,;]/);
    const dialPart = ivrSplit[0];
    const postDialChunks = ivrSplit.slice(1);

    const e164 = toE164(dialPart);
    const target = `sip:${e164}@${this.realm}`;
    console.log('[sip] dialing', {
      rawNumber,
      target,
      registered: this.ua.isRegistered(),
      postDialChunks: postDialChunks.length,
    });

    // Pre-flight mic permission — getUserMedia errors that happen inside
    // JsSIP can otherwise vanish silently and the call just dies.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints(),
        video: false,
      });
      // Log what the browser ACTUALLY applied — `getSettings()` reveals the
      // negotiated values (the browser may downgrade `ideal` to whatever the
      // device actually supports). Useful for diagnosing "still muffled" cases.
      try {
        const track = stream.getAudioTracks()[0];
        if (track) {
          const s = track.getSettings();
          console.log('[sip] mic track settings:', {
            deviceId: s.deviceId,
            label: track.label,
            sampleRate: s.sampleRate,
            channelCount: s.channelCount,
            echoCancellation: s.echoCancellation,
            noiseSuppression: s.noiseSuppression,
            autoGainControl: s.autoGainControl,
          });
        }
      } catch { /* getSettings unsupported */ }
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
        mediaConstraints: { audio: buildAudioConstraints(), video: false },
        pcConfig: {
          iceServers: this.buildIceServers(),
          iceTransportPolicy: 'all',
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require',
        },
        rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      });
      console.log('[sip] ua.call returned session', !!session, session?.id);
      if (session && !this.calls.has(session.id)) {
        console.log('[sip] manually attaching session listeners');
        this.attachSessionListeners(session);
      }
      // If the user typed an IVR string (digits,DTMF,DTMF...), schedule the
      // post-dial DTMF tones once the call is confirmed-connected. Each
      // chunk is preceded by a 1-second pause (per comma in the input).
      if (session && postDialChunks.length > 0) {
        const sendPostDial = async () => {
          for (const chunk of postDialChunks) {
            await new Promise((r) => setTimeout(r, 1000));
            const digits = chunk.replace(/[^0-9*#]/g, '');
            for (const d of digits) {
              try {
                session.sendDTMF(d);
              } catch (err) {
                console.warn('[sip] post-dial DTMF send failed', err);
              }
              await new Promise((r) => setTimeout(r, 200));
            }
            console.log('[sip] post-dial sent', digits);
          }
        };
        // Fire once the SIP dialog is established (ACK exchanged).
        session.on('confirmed', () => { void sendPostDial(); });
      }
    } catch (e) {
      console.error('[sip] ua.call threw', e);
      this.emit<CallEvent>('call', {
        state: 'ended',
        hangupCause: e instanceof Error ? e.message : 'call_failed',
      });
    }
  }

  /**
   * Hold a call using the music-aware path used everywhere we hold.
   * Centralised so Add Call, Swap, and Hold & Accept all behave the same:
   *   - If music is configured: swap outgoing track to music (don't SIP-hold,
   *     because session.hold() sets RTP to inactive and the music track
   *     never reaches the remote).
   *   - Otherwise: plain session.hold() — silent for the held party.
   * Either way the audio element is muted so the held leg's voice doesn't
   * bleed into the new call's audio.
   */
  private async holdCallWithMusicIfConfigured(entry: CallEntry): Promise<void> {
    if (entry.heldLocal) return;
    const musicWanted = getHoldMusicEnabled() && Boolean(getHoldMusicDataUrl());
    if (musicWanted) {
      if (entry.audioEl) entry.audioEl.muted = true;
      await this.startHoldMusic(entry);
    } else {
      try {
        entry.session.hold();
      } catch (e) {
        console.warn('[sip] hold failed', e);
      }
      if (entry.audioEl) entry.audioEl.muted = true;
    }
    entry.heldLocal = true;
  }

  /** Reverse of holdCallWithMusicIfConfigured. */
  private async unholdCallWithMusicIfConfigured(entry: CallEntry): Promise<void> {
    if (!entry.heldLocal) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wasMusicHold = !!(entry as any).__holdMusic;
    if (wasMusicHold) {
      await this.stopHoldMusic(entry);
    } else {
      try {
        entry.session.unhold();
      } catch (e) {
        console.warn('[sip] unhold failed', e);
      }
    }
    if (entry.audioEl) entry.audioEl.muted = false;
    entry.heldLocal = false;
  }

  /** Start a second concurrent call — used by Add Call. */
  addCall(rawNumber: string): void {
    if (!this.ua) throw new Error('SIP not connected');
    // Hold the currently active call before starting a new one. While held,
    // mute its per-call <audio> element AND the primary audio element so we
    // don't get "audio in a pipe" — phantom RTP from the held leg playing
    // underneath the new call's ringback.
    const current = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    if (current) {
      void this.holdCallWithMusicIfConfigured(current);
      // Clear primary so we don't keep playing the held leg's stream.
      this.primaryAudioEl.srcObject = null;
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
      void this.holdCallWithMusicIfConfigured(current);
    }
    if (next) {
      void this.unholdCallWithMusicIfConfigured(next);
      this.activeCallId = next.id;
      // Route the now-active call's stream to the primary speaker.
      if (next.audioEl) {
        this.primaryAudioEl.srcObject = next.audioEl.srcObject;
      }
      this.primaryAudioEl.muted = false;
      // Emit a 'call' event for the now-active session so the UI's callState
      // reflects the swap (number, direction, etc. all update).
      this.emit<CallEvent>('call', this.buildEvent(next, 'connected'));
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
    if (!id) {
      console.warn('[sip] acceptCall: no incomingCallId', {
        callsSize: this.calls.size,
        activeCallId: this.activeCallId,
      });
      return;
    }
    const entry = this.calls.get(id);
    if (!entry) {
      console.warn('[sip] acceptCall: no entry for incomingCallId=', id, {
        callsSize: this.calls.size,
      });
      return;
    }
    // v0.8.9 -- fire-and-forget the async answer path so click handlers
    // stay synchronous. Inside _answerIncoming we preflight gUM (with a
    // 3-second timeout), then call session.answer() with a pre-acquired
    // MediaStream + the full pcConfig mirror of outbound.
    void this._answerIncoming(entry);
  }


  /**
   * v0.8.9 — Centralised inbound answer path used by both `acceptCall()`
   * and `holdActiveAndAccept()`.
   *
   * Why this exists:
   *   1) JsSIP's own getUserMedia (the one invoked when you pass
   *      `mediaConstraints` to session.answer()) can silently hang the
   *      entire answer pipeline on Chromium-Electron-Windows. We preflight
   *      ourselves with a 3-second ceiling, then hand the resolved
   *      MediaStream to JsSIP via the `mediaStream` option so its internal
   *      gUM is skipped entirely.
   *   2) Inbound pcConfig was previously a subset of outbound's. Outbound
   *      works (ringback proves the media path is established end-to-end).
   *      Mirroring outbound's full pcConfig — iceTransportPolicy,
   *      bundlePolicy, rtcpMuxPolicy, plus the third Google STUN server —
   *      onto inbound eliminates the createLocalDescription() hang seen in
   *      JsSIP debug for v0.8.8 on Windows.
   *   3) If the preflight times out, we strip a stale `ace_mic` device id
   *      from localStorage so the next call falls back to System Default,
   *      and we send 480 "Mic Unavailable" to the caller instead of leaving
   *      them ringing into nothing.
   */
  private async _answerIncoming(entry: CallEntry): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statusBefore = (entry.session as any)?._status;
    console.log('[sip] acceptCall', {
      id: entry.id,
      sessionStatus: statusBefore,
      direction: entry.session?.direction,
      callsSize: this.calls.size,
      activeCallId: this.activeCallId,
    });

    // Preflight mic with a hard 3-second ceiling.
    let stream: MediaStream | null = null;
    try {
      const gum = navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints(),
        video: false,
      });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('mic_acquire_timeout')), 3000),
      );
      stream = await Promise.race([gum, timeout]);
      const track = stream.getAudioTracks()[0];
      console.log('[sip] inbound mic acquired', {
        label: track?.label,
        deviceId: track?.getSettings?.().deviceId,
      });
    } catch (e) {
      console.error('[sip] inbound answer: mic acquire failed', e);
      // If we requested a specific deviceId and that hung, strip it so
      // the next call falls back to System Default.
      try {
        const stored = localStorage.getItem('ace_mic');
        if (stored && stored !== 'default') {
          console.warn('[sip] clearing stale ace_mic device id', stored);
          localStorage.removeItem('ace_mic');
        }
      } catch { /* noop */ }
      // Tell the caller we can't answer instead of leaving them ringing.
      try { entry.session.terminate({ status_code: 480, reason_phrase: 'Mic Unavailable' }); } catch { /* noop */ }
      this.emit<CallEvent>('call', {
        state: 'ended',
        callId: entry.id,
        hangupCause: 'mic_acquire_failed',
      });
      return;
    }

    applySpeakerSelection(this.primaryAudioEl);
    try {
      entry.session.answer({
        // Pass our pre-acquired stream so JsSIP skips its own (hang-prone)
        // getUserMedia call inside the answer pipeline.
        mediaStream: stream,
        pcConfig: {
          iceServers: this.buildIceServers(),
          iceTransportPolicy: 'all',
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require',
        },
        rtcAnswerConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      });
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statusAfter = (entry.session as any)?._status;
      console.warn('[sip] answer failed', e, {
        sessionStatus: statusAfter,
        sessionStatusBefore: statusBefore,
        incomingCallId: this.incomingCallId,
        activeCallId: this.activeCallId,
        callsSize: this.calls.size,
      });
      // JsSIP didn't take ownership of our stream — release it.
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    }
  }

  /**
   * Phase 6.3 — Hold & Accept (Pulse-style).
   *
   * Used when a second call rings while the user is already in an active
   * call. Puts the current call on hold (with hold music if configured,
   * silent SIP hold otherwise), then answers the incoming. After the
   * incoming session reaches 'accepted' it auto-becomes activeCallId
   * (handled in attachSessionListeners via session.on('accepted')). The
   * previously-active call survives as the held leg — exactly the same
   * shape as Add Call, so the existing held-strip UI in InCall picks it
   * up via SipContext.hasSecondCall.
   *
   * Returns the held call's id (so SipContext can populate secondCallId)
   * or null if there's no active call to hold or no incoming to answer.
   *
   * Hold-music path mirrors toggleHold():
   *   - JsSIP's session.hold() sends RE-INVITE with `inactive` direction —
   *     RTP pauses both ways, so a follow-up replaceTrack(music) would never
   *     reach the remote party.
   *   - So when music is configured we SKIP session.hold() and just swap
   *     the outgoing audio sender's track to the music stream. The remote
   *     hears music, RTP keeps flowing, and we mute the user's local audio
   *     element so the held caller's voice doesn't bleed into the new call.
   *   - If no music is configured we fall back to plain SIP hold (silence
   *     to the remote — same as before).
   */
  holdActiveAndAccept(): string | null {
    const incomingId = this.incomingCallId;
    if (!incomingId) return null;
    const incoming = this.calls.get(incomingId);
    if (!incoming) return null;

    const activeId = this.activeCallId;
    const active = activeId ? this.calls.get(activeId) : null;
    if (!active) {
      // No active call — fall through to a plain accept.
      this.acceptCall();
      return null;
    }

    // 1. Hold the currently active call (with hold music if configured).
    void this.holdCallWithMusicIfConfigured(active);
    // Clear the primary stream — the new call will replace it once accepted.
    this.primaryAudioEl.srcObject = null;
    this.primaryAudioEl.muted = false;

    // 2. Answer the incoming via the centralised _answerIncoming path
    //    (preflight gUM + full pcConfig). session.on('accepted') will
    //    promote it to activeCallId and emit the 'connected' event the UI
    //    listens for. Errors inside _answerIncoming send 480 to the caller
    //    and emit 'ended'; we don't need a try/catch here because the
    //    async work is fire-and-forget.
    void this._answerIncoming(incoming).catch((e) => {
      console.warn('[sip] hold-and-accept: _answerIncoming rejected', e);
      // Best-effort: unhold the original so the user isn't stuck with both
      // calls in a broken state.
      void this.unholdCallWithMusicIfConfigured(active);
    });

    // Return the now-held call's id so SipContext can track it as the
    // "second" call (drives the held-strip in InCall).
    return activeId;
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

  /**
   * Hang up the ACTIVE call only. Held calls survive and are auto-promoted
   * to active by cleanupCall() (existing behavior in session.on('ended')).
   * Use hangupCall(id) to end a specific (e.g., held) call, or hangupAll()
   * to terminate everything.
   */
  hangup(): void {
    const active = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    if (!active) return;
    try {
      active.session.terminate();
    } catch (e) {
      console.warn('[sip] hangup threw', e);
    }
    // session.on('ended') fires cleanupCall which removes from `this.calls`
    // and promotes the held call to active if there is one.
  }

  /** Terminate a specific call (by SIP session id). */
  hangupCall(callId: string): void {
    const entry = this.calls.get(callId);
    if (!entry) return;
    try {
      entry.session.terminate();
    } catch (e) {
      console.warn('[sip] hangupCall threw', e);
    }
  }

  /** Force-end every active call. Use for logout / SIP disconnect. */
  hangupAll(): void {
    const all = Array.from(this.calls.values());
    for (const entry of all) {
      try {
        entry.session.terminate();
      } catch (e) {
        console.warn('[sip] hangupAll: terminate threw for', entry.id, e);
      }
    }
  }

  async toggleHold(): Promise<boolean> {
    const active = this.activeCallId ? this.calls.get(this.activeCallId) : null;
    if (!active) return false;
    const musicWanted = getHoldMusicEnabled() && Boolean(getHoldMusicDataUrl());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wasMusicHold = !!(active as any).__holdMusic;
    try {
      if (active.heldLocal) {
        // ---- Unhold ----
        // Two paths because we hold differently depending on music:
        //  (a) Music-hold: we swapped the outgoing track but skipped SIP hold,
        //      so we just restore the mic track. Don't call session.unhold()
        //      (there's nothing to unhold).
        //  (b) Silent SIP hold: we did call session.hold(); reverse it.
        if (wasMusicHold) {
          await this.stopHoldMusic(active);
        } else {
          try { active.session.unhold(); } catch (e) { console.warn('[sip] unhold threw', e); }
        }
        active.heldLocal = false;
      } else {
        // ---- Hold ----
        // CRITICAL: JsSIP's session.hold() sends a RE-INVITE with
        //   a=inactive (no audio either way) by default. If we then
        //   replaceTrack(music) the remote NEVER hears it — RTP is paused.
        // So when music is wanted we skip SIP hold entirely and just swap
        // the outgoing track. The remote party hears music + we mute the
        // local audio element so the caller's voice doesn't bleed into the
        // user's headset. heldLocal flag still drives the UI.
        if (musicWanted) {
          if (active.audioEl) active.audioEl.muted = true;
          this.primaryAudioEl.muted = true;
          await this.startHoldMusic(active);
        } else {
          // No music configured — fall back to standard SIP hold (silence
          // to the remote party).
          try { active.session.hold(); } catch (e) { console.warn('[sip] hold threw', e); }
        }
        active.heldLocal = true;
      }
    } catch (e) {
      console.warn('[sip] hold/unhold failed', e);
    }
    // Make sure the primary audio element is unmuted again when we unhold.
    if (!active.heldLocal) {
      if (active.audioEl) active.audioEl.muted = false;
      this.primaryAudioEl.muted = false;
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
  /** Per-participant audio graph state — used by mute/unmute. We keep
   *  references so we can disconnect/reconnect a participant's source from
   *  the speaker and from every other call's outgoing destination, hiding
   *  their voice from everyone in the conference. */
  private conferenceParticipants: Map<
    string,
    {
      sourceNode: MediaStreamAudioSourceNode;
      // Outgoing destinations of all OTHER participants — disconnect these
      // to silence this participant for everyone else.
      otherDests: MediaStreamAudioDestinationNode[];
      muted: boolean;
    }
  > = new Map();

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
        void navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints() }).then(async (micStream) => {
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
          this.conferenceParticipants.clear();
          for (const rs of remoteSources) {
            rs.node.connect(ctx.destination); // user hears this call
            const otherDests: MediaStreamAudioDestinationNode[] = [];
            for (const [otherId, dest] of outgoingDests) {
              if (otherId !== rs.entry.id) {
                rs.node.connect(dest); // other party hears this call
                otherDests.push(dest);
              }
            }
            // Track so mute/unmute can disconnect/reconnect this participant
            // from every "outbound to others" path plus the speaker.
            this.conferenceParticipants.set(rs.entry.id, {
              sourceNode: rs.node,
              otherDests,
              muted: false,
            });
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

  /**
   * Mute a participant in an active conference. After muting, neither the
   * user nor any other party can hear this person, but they still hear
   * everyone (their inbound track is untouched). Returns true if state
   * changed, false otherwise (e.g., not in conference or unknown id).
   */
  muteConferenceParticipant(callId: string): boolean {
    const p = this.conferenceParticipants.get(callId);
    if (!p || p.muted) return false;
    const ctx = this.conferenceCtx;
    if (!ctx) return false;
    try {
      // Disconnect from speaker so we don't hear them.
      p.sourceNode.disconnect(ctx.destination);
    } catch { /* node may not be connected on some browsers — ignore */ }
    for (const dest of p.otherDests) {
      try {
        p.sourceNode.disconnect(dest);
      } catch { /* same */ }
    }
    p.muted = true;
    console.log('[sip] muted conference participant', callId);
    return true;
  }

  /** Reverse muteConferenceParticipant. */
  unmuteConferenceParticipant(callId: string): boolean {
    const p = this.conferenceParticipants.get(callId);
    if (!p || !p.muted) return false;
    const ctx = this.conferenceCtx;
    if (!ctx) return false;
    p.sourceNode.connect(ctx.destination);
    for (const dest of p.otherDests) {
      p.sourceNode.connect(dest);
    }
    p.muted = false;
    console.log('[sip] unmuted conference participant', callId);
    return true;
  }

  isConferenceParticipantMuted(callId: string): boolean {
    return !!this.conferenceParticipants.get(callId)?.muted;
  }

  /** Tear down the conference audio graph (called on hangup of any leg).
   *  Any remaining call has its outgoing sender pointed at the (now dead)
   *  MediaStreamDestination — we must replace that with a fresh mic track
   *  so the surviving call still hears the user. */
  private stopConference(): void {
    const hadConference = !!this.conferenceCtx;
    this.conferenceParticipants.clear();
    if (this.conferenceMic) {
      try { this.conferenceMic.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      this.conferenceMic = null;
    }
    if (this.conferenceCtx) {
      try { void this.conferenceCtx.close(); } catch { /* noop */ }
      this.conferenceCtx = null;
    }
    if (hadConference && this.calls.size > 0) {
      // Fire-and-forget: restore mic on every remaining call's sender.
      void (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: buildAudioConstraints(),
          });
          const micTrack = stream.getAudioTracks()[0];
          if (!micTrack) return;
          for (const entry of this.calls.values()) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pc: RTCPeerConnection | null = (entry.session as any).connection ?? null;
            if (!pc) continue;
            const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
            if (sender) {
              try {
                // Clone for each sender so each has its own track instance.
                await sender.replaceTrack(micTrack.clone());
                console.log('[sip] post-conference mic restored for', entry.id);
              } catch (e) {
                console.warn('[sip] post-conference replaceTrack failed', entry.id, e);
              }
            }
          }
          // We've cloned the track for each sender; stop the original.
          micTrack.stop();
        } catch (e) {
          console.error('[sip] post-conference mic restore failed', e);
        }
      })();
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
        const stream = await navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints() });
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
    // Tear down registration heartbeat — otherwise it can fire one last
    // time after disconnect() and trigger a stray reconnect().
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // v0.9.13 — also cancel any pending first-login retry so a logout/
    // page-close during the 2-8s backoff window doesn't fire a stray
    // reconnect() against a torn-down service.
    if (this.regRetryTimer) {
      clearTimeout(this.regRetryTimer);
      this.regRetryTimer = null;
    }
    this.regFailCount = 0;
    if (this.ua) {
      // Wildcard unregister BEFORE close so Telnyx evicts our Contact
      // right now instead of leaving an orphan to linger for up to 600s
      // (the REGISTER expiry). The 250ms socket-close delay inside
      // scheduleCleanup lets the REGISTER frame flush over the WSS
      // socket before stop() closes it.
      this.scheduleCleanup(this.ua);
      this.ua = null;
    }
  }
}

export const sipService = new SipService();
