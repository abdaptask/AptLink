import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { sipService, type SipState, type CallEvent, type CallQuality } from '../services/sip';
import {
  createCall,
  updateCall,
  mergeCalls as apiMergeCalls,
  lookupCall,
  transferCallApi,
  addLegApi,
  getTurnCredentials,
} from '../api';
import { createSipWatchdog } from '../lib/sessionGuard';

export interface ServerActionResult {
  ok: boolean;
  error?: string;
  hint?: string;
}

interface SipContextValue {
  sipState: SipState;
  callState: CallEvent;
  callQuality: CallQuality;
  incoming: CallEvent | null;
  /** call_control_id for the active leg, populated by the webhook after connect. */
  activeCallControlId: string | null;
  /** call_control_id for the held second leg (server-originated via /add-leg). */
  secondCallControlId: string | null;
  call: (number: string) => void;
  /** End the ACTIVE call only. Any held call promotes to active. */
  hangup: () => void;
  /** End a specific (e.g., held) call by its SIP session id. */
  hangupCall: (callId: string) => void;
  acceptCall: () => void;
  /** Put the currently active call on hold and answer the incoming call.
   *  No-op if there's no incoming. Falls back to plain accept if there's
   *  no active call to hold. */
  holdAndAcceptCall: () => void;
  declineCall: () => void;
  toggleMute: () => boolean;
  toggleHold: () => Promise<boolean>;
  isOnHold: () => boolean;
  /** Server-side transfer via Telnyx Call Control. */
  transferCall: (destination: string) => Promise<ServerActionResult>;
  sendDTMF: (digit: string) => void;
  // Phase 6.1 — JsSIP-level multi-call support
  hasSecondCall: boolean;
  /** Display label of the held call (number / contact). */
  secondCallNumber: string | null;
  /** SIP session id of the held call — used by per-call hangup. */
  secondCallId: string | null;
  addCall: (number: string) => Promise<ServerActionResult>;
  swapCalls: () => void;
  mergeCalls: () => Promise<boolean>;
  /** True after a successful merge — both calls are now bridged in a 3-way
   * conference. The UI keeps showing both numbers with per-call hangup so
   * the user can drop either party. */
  conferenceActive: boolean;
  /** Label of the call that was previously "active" before merge — used as
   * the second participant's display name during conference. */
  conferenceOtherNumber: string | null;
  /** Session id of the second participant during conference. */
  conferenceOtherId: string | null;
  /** Mute or unmute a specific participant in the active conference. */
  toggleConferenceParticipantMute: (callId: string) => boolean;
  /** Returns true if the given participant is currently muted. */
  isConferenceParticipantMuted: (callId: string) => boolean;
  // Audio device selection
  listAudioOutputs: () => Promise<MediaDeviceInfo[]>;
  setAudioOutput: (deviceId: string) => Promise<void>;
}

const SipContext = createContext<SipContextValue | null>(null);

interface CallLogState {
  callId: string;
  startedAt: number;
  posted: boolean;
  answeredAt?: number;
  ended?: boolean;
}

export function SipProvider({ children }: { children: React.ReactNode }) {
  const [sipState, setSipState] = useState<SipState>('disconnected');
  const [callState, setCallState] = useState<CallEvent>({ state: 'idle' });
  const [incoming, setIncoming] = useState<CallEvent | null>(null);
  const [hasSecondCall, setHasSecondCall] = useState(false);
  const [secondCallNumber, setSecondCallNumber] = useState<string | null>(null);
  const [secondCallId, setSecondCallId] = useState<string | null>(null);
  const [conferenceActive, setConferenceActive] = useState(false);
  const [conferenceOtherNumber, setConferenceOtherNumber] = useState<string | null>(null);
  const [conferenceOtherId, setConferenceOtherId] = useState<string | null>(null);
  const [activeCallControlId, setActiveCallControlId] = useState<string | null>(null);
  const [secondCallControlId, setSecondCallControlId] = useState<string | null>(null);
  const [callQuality, setCallQuality] = useState<CallQuality>({ level: 'unknown', jitter: 0, loss: 0, rtt: null });
  const logRef = useRef<Map<string, CallLogState>>(new Map());
  const rejectedRef = useRef<Set<string>>(new Set());
  const currentIncomingRef = useRef<string | null>(null);
  const ccPollRef = useRef<number | null>(null);
  // Mirror of activeCallControlId for use inside async functions (setState
  // captures are stale by the time addCall awaits the poll).
  const activeCallControlIdRef = useRef<string | null>(null);
  useEffect(() => { activeCallControlIdRef.current = activeCallControlId; }, [activeCallControlId]);
  const callStateRef = useRef<CallEvent>(callState);
  useEffect(() => { callStateRef.current = callState; }, [callState]);

  useEffect(() => {
    // Per-user SIP creds, written to sessionStorage by App.tsx persistSipCreds
    // after getMe() returns. There's a known race where SipContext mounts
    // before persistSipCreds has run — we used to flip to 'failed' and never
    // retry, which is what showed "Connection failed" on login.
    //
    // Fix (#212): if creds are missing on the initial read, we DON'T fail
    // hard. We mark sipState='connecting' and listen for the
    // ace:sip-creds-updated event App.tsx dispatches when creds land. As
    // soon as that fires, we re-read sessionStorage and connect. Also covers
    // SSO callback flows and password updates from Settings → Account.
    let connected = false;
    function readAndConnect(): boolean {
      const sessionSipUsername = sessionStorage.getItem('ace_sip_username');
      const sessionSipPassword = sessionStorage.getItem('ace_sip_password');
      const sessionDid = sessionStorage.getItem('ace_did');

      const username =
        sessionSipUsername ||
        (import.meta.env.VITE_SIP_USERNAME as string | undefined);
      const password =
        sessionSipPassword ||
        (import.meta.env.VITE_SIP_PASSWORD as string | undefined);
      const callerNumber =
        sessionDid ||
        (import.meta.env.VITE_SIP_FROM_NUMBER as string | undefined);

      if (!username || !password) {
        return false;
      }

      console.log('[sip] connecting as', username, 'caller=', callerNumber);
      // v0.10.18 — Use env-var override if set; otherwise let the SIP
      // service use its default. We removed timezone-based auto-routing
      // here because it failed for India users whose Windows OS clock
      // is set to US timezones for work-hours alignment (the typical
      // ApTask offshore setup), AND Vercel env vars don't propagate
      // to the GitHub Actions desktop build environment. Instead we
      // changed the default endpoint in services/sip.ts to
      // `wss://rtc.telnyx.com:443` (port 443, HTTPS-standard, works
      // for all users regardless of region). The VITE_SIP_WSS_URI
      // env var still works as an override for testing / future
      // regional tuning.
      const wssUri = import.meta.env.VITE_SIP_WSS_URI as string | undefined;

      // v0.9.13 — Connect immediately with Telnyx-TURN-only so the user
      // isn't delayed by the Cloudflare-credentials round-trip. Then
      // asynchronously fetch Cloudflare TURN and trigger a reconnect when
      // it lands so future ICE renegotiations include the extra relay path.
      sipService.connect({ username, password, callerNumber, wssUri });
      connected = true;

      const token = sessionStorage.getItem('ace_token');
      if (token) {
        void (async () => {
          const turn = await getTurnCredentials(token);
          if (turn.iceServers.length > 0) {
            console.log('[sip] cloudflare TURN added, provider=', turn.provider);
            sipService.updateExtraIceServers(turn.iceServers);
          } else {
            console.log('[sip] no extra TURN provider; Telnyx TURN only (provider=', turn.provider, ')');
          }
        })();
      }
      return true;
    }

    if (!readAndConnect()) {
      // No creds yet — stay in 'connecting' state and wait for the
      // App.tsx persistSipCreds → ace:sip-creds-updated handshake.
      console.log('[sip] creds not in sessionStorage yet; waiting for App to populate…');
      setSipState('connecting');
      const onCredsUpdated = () => {
        if (connected) return;
        if (readAndConnect()) {
          console.log('[sip] connected after creds-updated event');
          window.removeEventListener('ace:sip-creds-updated', onCredsUpdated);
        }
      };
      window.addEventListener('ace:sip-creds-updated', onCredsUpdated);
      // Safety fallback: poll sessionStorage every 500ms for up to 20s in
      // case the event listener missed it (mount-order edge case). After
      // 20s with no creds, set 'failed' so the user sees something.
      let polls = 0;
      const pollId = window.setInterval(() => {
        polls += 1;
        if (connected) { window.clearInterval(pollId); return; }
        if (readAndConnect()) {
          console.log('[sip] connected after sessionStorage poll');
          window.clearInterval(pollId);
          window.removeEventListener('ace:sip-creds-updated', onCredsUpdated);
        } else if (polls >= 40) {
          window.clearInterval(pollId);
          window.removeEventListener('ace:sip-creds-updated', onCredsUpdated);
          console.warn('[sip] no SIP credentials after 20s — giving up.');
          setSipState('failed');
        }
      }, 500);
    }

    // #214 — Wildcard unregister on window/app close. Without this, when
    // the user force-quits or the app crashes, our Contact lingers in
    // Telnyx's registrar for up to 600s. On next launch a fresh Contact
    // is registered alongside the orphan; Telnyx then forks every inbound
    // INVITE to BOTH Contacts, and the resulting race is exactly what
    // broke inbound Accept (INVALID_STATE_ERROR / cause:Canceled).
    //
    // v0.10.25 — CRITICAL fix. The previous version ALSO listened to
    // pagehide and called disconnect() on it. In Electron, pagehide
    // fires when the renderer is hidden (window minimized to system tray,
    // Cmd+H on macOS, etc.) — NOT just on real destroy. Calling
    // disconnect() in that case unregistered the user from Telnyx, so
    // every incoming call while the app was "in background" went straight
    // to voicemail. End-state: users reporting "calls go to voicemail
    // when my dialer isn't the front window" — exactly this bug.
    //
    // Fix: guard pagehide with event.persisted. persisted === true means
    // the page is going to bfcache and will resume; never disconnect.
    // persisted === false in pagehide *could* mean a real unload, but in
    // Electron it's ambiguous (also fires on window hide). To stay safe,
    // we now ONLY disconnect on beforeunload — that's the reliable
    // "page is really going away" signal in Electron. The bfcache orphan-
    // contact case is rare and self-heals on next launch.
    const onUnload = () => {
      try { sipService.disconnect(); } catch { /* noop */ }
    };
    window.addEventListener('beforeunload', onUnload);

    // v0.10.9 — Subscribe to system power events from Electron main.
    // Fires on system resume from sleep + screen unlock. We force-refresh
    // SIP registration immediately so the user's first call after a long
    // idle/sleep doesn't drop into voicemail because Telnyx evicted the
    // contact during the heartbeat-can't-fire period.
    const offSipWake = window.ace?.onSipWake?.((data) => {
      console.log('[sip] wake event', data);
      sipService.refreshRegistration(`wake:${data.reason}`);
    });

    const offAccept = window.ace?.onAcceptRequest?.(() => {
      sipService.acceptCall();
    });
    const offDecline = window.ace?.onDeclineRequest?.(() => {
      if (currentIncomingRef.current) {
        rejectedRef.current.add(currentIncomingRef.current);
      }
      sipService.declineCall();
      setIncoming(null);
    });

    // SIP-failed watchdog: if the SIP UA stays in 'failed' for 30s the
    // user has effectively been disconnected (creds rotated, network died,
    // Telnyx outage, etc.). Feed every state change in; the watchdog only
    // fires session-expired after the grace window elapses.
    const sipWatchdog = createSipWatchdog();
    const offState = sipService.on<SipState>('state', (s) => {
      setSipState(s);
      sipWatchdog.report(s);
    });
    const offQuality = sipService.on<CallQuality>('quality', (q) => setCallQuality(q));
    const offCall = sipService.on<CallEvent>('call', (e) => {
      if (e.state === 'incoming') {
        setIncoming(e);
        currentIncomingRef.current = e.callId ?? null;
        if (window.ace?.onIncomingCall) {
          try {
            window.ace.onIncomingCall(e.fromNumber ?? e.number, e.callId);
          } catch (err) {
            console.warn('[sip] electron bridge failed', err);
          }
        }
      } else {
        // Only update the main callState when this event is for the active
        // call (or there's no active call at all). Events on a held call —
        // e.g., the user tapping the held-strip's hangup button — must not
        // clobber the active call's display.
        const activeId = sipService.getActiveCallId();
        const isActiveEvent = !activeId || !e.callId || e.callId === activeId;
        if (isActiveEvent) {
          setCallState(e);
        } else {
          console.log('[sip-ctx] ignoring event for non-active call', e.callId, 'state:', e.state);
        }
        setIncoming((prev) => {
          if (!prev) return prev;
          if (prev.callId === e.callId) {
            currentIncomingRef.current = null;
            if (window.ace?.notifyCallEnded) {
              try { window.ace.notifyCallEnded(); } catch { /* noop */ }
            }
            return null;
          }
          if (e.state === 'ended') {
            currentIncomingRef.current = null;
            if (window.ace?.notifyCallEnded) {
              try { window.ace.notifyCallEnded(); } catch { /* noop */ }
            }
            return null;
          }
          return prev;
        });
      }
      void logCallEvent(e, logRef.current, rejectedRef.current);

      // When ANY call ends, recompute the held-call state from sipService.
      // After cleanupCall promotes a survivor to active, getHeldCallId()
      // returns null in the 2-call → 1-call collapse case.
      if (e.state === 'ended') {
        const heldId = sipService.getHeldCallId();
        if (!heldId) {
          setHasSecondCall(false);
          setSecondCallNumber(null);
          setSecondCallId(null);
          // If we were in conference and a participant dropped, we're now
          // a normal single call — clear the conference state too.
          setConferenceActive(false);
          setConferenceOtherNumber(null);
          setConferenceOtherId(null);
        } else {
          setSecondCallId(heldId);
        }
      }
    });

    return () => {
      sipWatchdog.stop();
      offState();
      offCall();
      offQuality();
      if (offAccept) offAccept();
      if (offDecline) offDecline();
      if (offSipWake) offSipWake();
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
      sipService.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After the call connects, poll the API for the Telnyx call_control_id
  // (populated by the call.initiated/answered webhook). Up to ~15s of retries
  // at 1s intervals. The id is required for Transfer / Add Call / Merge.
  useEffect(() => {
    if (ccPollRef.current) {
      window.clearInterval(ccPollRef.current);
      ccPollRef.current = null;
    }
    setActiveCallControlId(null);

    if (callState.state !== 'connected') return;
    const telnyxCallId = callState.callId;
    if (!telnyxCallId) return;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;

    // Hints for the API's fuzzy fallback — the SDK's call.id often doesn't
    // match Telnyx's call_session_id (which is what the webhook stores under),
    // so we also pass destination + direction so the server can find the
    // recent matching row.
    const hints: { to?: string; direction?: 'inbound' | 'outbound' } = {};
    if (callState.direction === 'outbound') {
      hints.direction = 'outbound';
      hints.to = callState.toNumber ?? callState.number;
    } else if (callState.direction === 'inbound') {
      hints.direction = 'inbound';
      hints.to = callState.fromNumber ?? callState.number;
    }

    let attempts = 0;
    const maxAttempts = 15;
    const tryFetch = async () => {
      attempts += 1;
      const row = await lookupCall(token, telnyxCallId, hints);
      if (row?.callControlId) {
        setActiveCallControlId(row.callControlId);
        if (ccPollRef.current) {
          window.clearInterval(ccPollRef.current);
          ccPollRef.current = null;
        }
        console.log('[sip] resolved callControlId', row.callControlId, '(via', row.telnyxCallId === telnyxCallId ? 'exact' : 'fuzzy', 'match)');
      } else if (attempts >= maxAttempts) {
        if (ccPollRef.current) {
          window.clearInterval(ccPollRef.current);
          ccPollRef.current = null;
        }
        console.warn('[sip] callControlId never arrived — webhook not firing? Verify SIP Connection is linked to a Call Control App.');
      }
    };
    void tryFetch();
    ccPollRef.current = window.setInterval(() => { void tryFetch(); }, 1000);
    return () => {
      if (ccPollRef.current) {
        window.clearInterval(ccPollRef.current);
        ccPollRef.current = null;
      }
    };
  }, [callState.state, callState.callId]);

  const value: SipContextValue = {
    sipState,
    callState,
    callQuality,
    incoming,
    activeCallControlId,
    secondCallControlId,
    call: (number) => sipService.call(number),
    hangup: () => sipService.hangup(),
    hangupCall: (callId: string) => sipService.hangupCall(callId),
    acceptCall: () => sipService.acceptCall(),
    holdAndAcceptCall: () => {
      // Capture the current active call's display info BEFORE the swap so
      // we can show it in the held-strip after the incoming becomes active.
      const current = callStateRef.current;
      const priorOther =
        current.direction === 'inbound'
          ? current.fromNumber ?? current.number
          : current.toNumber ?? current.number;
      const heldId = sipService.holdActiveAndAccept();
      // If holdActiveAndAccept returned an id, the prior active is now held —
      // populate the second-call state so InCall's held-strip renders.
      if (heldId) {
        setSecondCallNumber(priorOther ?? null);
        setSecondCallId(heldId);
        setHasSecondCall(true);
      }
      // Clear the incoming banner so the IncomingCall component unmounts;
      // SipContext's onCall handler also does this on the 'accepted' event,
      // but doing it eagerly avoids a flash of the third button after tap.
      setIncoming(null);
      currentIncomingRef.current = null;
      if (window.ace?.notifyCallEnded) {
        try { window.ace.notifyCallEnded(); } catch { /* noop */ }
      }
    },
    declineCall: () => {
      if (incoming?.callId) rejectedRef.current.add(incoming.callId);
      sipService.declineCall();
      setIncoming(null);
    },
    toggleMute: () => sipService.toggleMute(),
    toggleHold: () => sipService.toggleHold(),
    isOnHold: () => sipService.isOnHold(),
    // Phase 5.4 (rebuild): Transfer goes through the API → Telnyx Call Control.
    // Waits up to 10s for the leg's callControlId to arrive if needed.
    transferCall: async (destination) => {
      const token = sessionStorage.getItem('ace_token');
      if (!token) return { ok: false, error: 'not_authenticated' };
      if (!activeCallControlIdRef.current) {
        const start = Date.now();
        while (!activeCallControlIdRef.current && Date.now() - start < 10_000) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!activeCallControlIdRef.current) {
          return {
            ok: false,
            error: 'no_call_control_id',
            hint:
              'Telnyx hasn’t registered this call leg yet. Check Render webhook logs.',
          };
        }
      }
      const res = await transferCallApi(token, activeCallControlIdRef.current, destination);
      return res;
    },
    sendDTMF: (digit) => sipService.sendDTMF(digit),
    hasSecondCall,
    secondCallNumber,
    secondCallId,
    // Phase 6.1 — Add Call via JsSIP (multiple concurrent SIP sessions).
    // sipService.addCall puts the active call on SIP hold (RE-INVITE with
    // sendonly direction) and starts a brand new SIP session for the new
    // number. From here, two independent SIP dialogs are alive locally.
    addCall: async (number) => {
      const current = callStateRef.current;
      if (!current.callId || current.state !== 'connected') {
        return { ok: false, error: 'no_active_call', hint: 'You need an active connected call before adding another.' };
      }
      try {
        // Remember the prior active call so the held-strip UI can display
        // its number AND we can hang it up via its session id.
        const priorOther =
          current.direction === 'inbound'
            ? current.fromNumber ?? current.number
            : current.toNumber ?? current.number;
        setSecondCallNumber(priorOther ?? null);
        setSecondCallId(current.callId ?? null);
        setHasSecondCall(true);
        sipService.addCall(number);
        return { ok: true };
      } catch (e) {
        setHasSecondCall(false);
        setSecondCallNumber(null);
        setSecondCallId(null);
        return {
          ok: false,
          error: 'add_call_failed',
          hint: e instanceof Error ? e.message : 'Add Call failed',
        };
      }
    },
    swapCalls: () => {
      const priorActive = callStateRef.current;
      const priorOther =
        priorActive.direction === 'inbound'
          ? priorActive.fromNumber ?? priorActive.number
          : priorActive.toNumber ?? priorActive.number;
      const priorActiveId = priorActive.callId ?? null;
      sipService.swapCalls();
      // After swap, prior active becomes the held one; show its info on
      // the held strip and remember its session id for hangup.
      setSecondCallNumber(priorOther ?? null);
      setSecondCallId(priorActiveId);
    },
    listAudioOutputs: () => sipService.listAudioOutputs(),
    setAudioOutput: (deviceId) => sipService.setAudioOutput(deviceId),
    mergeCalls: async () => {
      // Phase 6.2 — true 3-way conference via Web Audio API mixing.
      // sipService.startConference() (added below) wires mic + both calls'
      // remote streams together so all three parties hear each other.
      try {
        // Capture both numbers + ids BEFORE merge so we can render two
        // matching conference pills with per-call hangup. The "active"
        // call drives `callState`; the "second" call's info we already
        // tracked via hasSecondCall.
        const otherNumber = secondCallNumber;
        const otherId = secondCallId;
        const ok = sipService.startConference();
        if (ok) {
          // Switch from "active + held" to "two-party conference". Both
          // calls remain alive, but neither is on hold and both should be
          // displayed identically.
          setHasSecondCall(false);
          setSecondCallNumber(null);
          setSecondCallControlId(null);
          setConferenceActive(true);
          setConferenceOtherNumber(otherNumber);
          setConferenceOtherId(otherId);
        }
        return ok;
      } catch (e) {
        console.warn('[merge] failed', e);
        return false;
      }
    },
    conferenceActive,
    conferenceOtherNumber,
    conferenceOtherId,
    toggleConferenceParticipantMute: (callId: string) => {
      const wasMuted = sipService.isConferenceParticipantMuted(callId);
      if (wasMuted) {
        sipService.unmuteConferenceParticipant(callId);
      } else {
        sipService.muteConferenceParticipant(callId);
      }
      return !wasMuted;
    },
    isConferenceParticipantMuted: (callId: string) =>
      sipService.isConferenceParticipantMuted(callId),
  };

  return <SipContext.Provider value={value}>{children}</SipContext.Provider>;
}

export function useSip(): SipContextValue {
  const ctx = useContext(SipContext);
  if (!ctx) throw new Error('useSip must be used inside <SipProvider>');
  return ctx;
}

async function logCallEvent(
  event: CallEvent,
  log: Map<string, CallLogState>,
  rejected: Set<string>,
): Promise<void> {
  const token = sessionStorage.getItem('ace_token');
  if (!token) return;
  if (!event.callId) return;

  let entry = log.get(event.callId);

  if (!entry) {
    entry = { callId: event.callId, startedAt: Date.now(), posted: false };
    log.set(event.callId, entry);

    if (event.fromNumber && event.toNumber) {
      try {
        await createCall(token, {
          telnyxCallId: event.callId,
          direction: event.direction ?? 'outbound',
          fromNumber: event.fromNumber,
          toNumber: event.toNumber,
          status: stateToStatus(event.state, event.hangupCause),
          startedAt: new Date(entry.startedAt).toISOString(),
        });
        entry.posted = true;
      } catch (e) {
        console.warn('[call-log] createCall failed', e);
      }
    }
  }

  if (event.state === 'connected' && !entry.answeredAt) {
    entry.answeredAt = Date.now();
    if (entry.posted) {
      try {
        await updateCall(token, event.callId, {
          status: 'answered',
          answeredAt: new Date(entry.answeredAt).toISOString(),
        });
      } catch (e) {
        console.warn('[call-log] updateCall(answered) failed', e);
      }
    }
  }

  if (event.state === 'ended' && !entry.ended) {
    entry.ended = true;
    const endedAt = Date.now();
    const durationSeconds = entry.answeredAt
      ? Math.max(0, Math.floor((endedAt - entry.answeredAt) / 1000))
      : 0;
    const cause = (event.hangupCause ?? '').toLowerCase();
    const wasRejected = event.callId ? rejected.has(event.callId) : false;
    const status = entry.answeredAt
      ? 'completed'
      : wasRejected
        ? 'rejected'
        : cause === 'no_answer'
          ? 'no_answer'
          : cause === 'normal_clearing'
            ? 'completed'
            : event.direction === 'inbound'
              ? 'missed'
              : 'failed';

    if (entry.posted) {
      try {
        await updateCall(token, event.callId, {
          status,
          endedAt: new Date(endedAt).toISOString(),
          durationSeconds,
          hangupCause: event.hangupCause ?? null,
        });
      } catch (e) {
        console.warn('[call-log] updateCall(ended) failed', e);
      }
    }
  }
}

function stateToStatus(state: CallEvent['state'], hangupCause?: string): string {
  switch (state) {
    case 'calling':
      return 'initiated';
    case 'ringing':
      return 'ringing';
    case 'incoming':
      return 'ringing';
    case 'connected':
      return 'answered';
    case 'ended':
      return hangupCause ? 'completed' : 'failed';
    default:
      return 'initiated';
  }
}
