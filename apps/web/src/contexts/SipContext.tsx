import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { sipService, type SipState, type CallEvent } from '../services/sip';
import {
  createCall,
  updateCall,
  mergeCalls as apiMergeCalls,
  lookupCall,
  transferCallApi,
  addLegApi,
} from '../api';

export interface ServerActionResult {
  ok: boolean;
  error?: string;
  hint?: string;
}

interface SipContextValue {
  sipState: SipState;
  callState: CallEvent;
  incoming: CallEvent | null;
  /** call_control_id for the active leg, populated by the webhook after connect. */
  activeCallControlId: string | null;
  /** call_control_id for the held second leg (server-originated via /add-leg). */
  secondCallControlId: string | null;
  call: (number: string) => void;
  hangup: () => void;
  acceptCall: () => void;
  declineCall: () => void;
  toggleMute: () => boolean;
  toggleHold: () => boolean;
  isOnHold: () => boolean;
  /** Server-side transfer via Telnyx Call Control. */
  transferCall: (destination: string) => Promise<ServerActionResult>;
  sendDTMF: (digit: string) => void;
  // Phase 5.4 — conference / merge (server-side via Call Control)
  hasSecondCall: boolean;
  secondCallNumber: string | null;
  addCall: (number: string) => Promise<ServerActionResult>;
  swapCalls: () => void;
  mergeCalls: () => Promise<boolean>;
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
  const [activeCallControlId, setActiveCallControlId] = useState<string | null>(null);
  const [secondCallControlId, setSecondCallControlId] = useState<string | null>(null);
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
    const username = import.meta.env.VITE_SIP_USERNAME as string | undefined;
    const password = import.meta.env.VITE_SIP_PASSWORD as string | undefined;
    const callerNumber = import.meta.env.VITE_SIP_FROM_NUMBER as string | undefined;

    if (!username || !password) {
      console.warn('[sip] missing VITE_SIP_USERNAME or VITE_SIP_PASSWORD — calls disabled');
      setSipState('failed');
      return;
    }

    sipService.connect({ username, password, callerNumber });

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

    const offState = sipService.on<SipState>('state', (s) => setSipState(s));
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
        setCallState(e);
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

      // If a call ended and the SipService no longer has a held leg,
      // clear the second-call state.
      if (e.state === 'ended') {
        if (!sipService.getHeldCallId()) {
          setHasSecondCall(false);
          setSecondCallNumber(null);
        }
      }
    });

    return () => {
      offState();
      offCall();
      if (offAccept) offAccept();
      if (offDecline) offDecline();
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
    incoming,
    activeCallControlId,
    secondCallControlId,
    call: (number) => sipService.call(number),
    hangup: () => sipService.hangup(),
    acceptCall: () => sipService.acceptCall(),
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
      const telnyxCallId = callStateRef.current.callId;
      if (!token || !telnyxCallId) {
        return { ok: false, error: 'no_active_call' };
      }
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
              'Telnyx hasn’t registered this call leg. Link your SIP Connection to a Call Control App in the Telnyx portal (see docs/telnyx-call-control-setup.md step 2).',
          };
        }
      }
      const res = await transferCallApi(token, telnyxCallId, destination);
      return res;
    },
    sendDTMF: (digit) => sipService.sendDTMF(digit),
    hasSecondCall,
    secondCallNumber,
    // Phase 5.4 (rebuild): Add Call originates Leg B via Telnyx Call Control
    // (not the SDK). Server auto-bridges to Leg A on answer so the user hears
    // the new party immediately. The held-line strip + Merge button become
    // informational since the bridge happens automatically.
    //
    // If activeCallControlId isn't ready yet (webhook hasn't fired), we wait
    // up to 15s for it to arrive rather than failing immediately. This lets
    // the user tap Add Call right after a call connects without timing the
    // webhook race themselves.
    addCall: async (number) => {
      const token = sessionStorage.getItem('ace_token');
      const legATelnyxCallId = callStateRef.current.callId;
      if (!token || !legATelnyxCallId) {
        return { ok: false, error: 'no_active_call' };
      }

      // Wait for callControlId up to 15s if it hasn't arrived yet.
      if (!activeCallControlIdRef.current) {
        console.log('[add-call] waiting for callControlId…');
        const start = Date.now();
        while (!activeCallControlIdRef.current && Date.now() - start < 15_000) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!activeCallControlIdRef.current) {
          return {
            ok: false,
            error: 'no_call_control_id',
            hint:
              'Telnyx hasn’t registered this call leg. The SIP Connection probably isn’t linked to a Call Control App in the Telnyx portal yet — see docs/telnyx-call-control-setup.md (step 2).',
          };
        }
      }

      const res = await addLegApi(token, legATelnyxCallId, number);
      if (res.ok && res.legB) {
        setSecondCallNumber(res.legB.toNumber);
        setSecondCallControlId(res.legB.callControlId);
        setHasSecondCall(true);
      }
      return { ok: res.ok, error: res.error, hint: res.hint };
    },
    swapCalls: () => {
      // No-op for now in the server-mediated flow — both legs are bridged into
      // the user's single WebRTC stream once Add Call's auto-bridge fires.
      // Kept on the interface so the InCall UI doesn't have to special-case.
    },
    listAudioOutputs: () => sipService.listAudioOutputs(),
    setAudioOutput: (deviceId) => sipService.setAudioOutput(deviceId),
    mergeCalls: async () => {
      // In the new flow Add Call auto-bridges on answer, so by the time the
      // user can tap Merge they're already bridged. We still attempt an
      // explicit bridge_call as a belt-and-suspenders — if Telnyx returns
      // 409 ("already bridged") we treat it as success.
      const token = sessionStorage.getItem('ace_token');
      const legA = callState.callId;
      const legB = secondCallControlId; // server-side leg uses its own id
      if (!token || !legA || !legB) return false;
      try {
        await apiMergeCalls(token, legA, legB);
        setHasSecondCall(false);
        setSecondCallNumber(null);
        setSecondCallControlId(null);
        return true;
      } catch (e) {
        console.warn('[merge] failed', e);
        return false;
      }
    },
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
