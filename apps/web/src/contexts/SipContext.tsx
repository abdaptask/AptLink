import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { sipService, type SipState, type CallEvent } from '../services/sip';
import { createCall, updateCall } from '../api';

interface SipContextValue {
  sipState: SipState;
  callState: CallEvent;
  incoming: CallEvent | null;
  call: (number: string) => void;
  hangup: () => void;
  acceptCall: () => void;
  declineCall: () => void;
  toggleMute: () => boolean;
  toggleHold: () => boolean;
  isOnHold: () => boolean;
  transferCall: (destination: string) => boolean;
  sendDTMF: (digit: string) => void;
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
  const logRef = useRef<Map<string, CallLogState>>(new Map());
  const rejectedRef = useRef<Set<string>>(new Set());
  const currentIncomingRef = useRef<string | null>(null);

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

  const value: SipContextValue = {
    sipState,
    callState,
    incoming,
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
    transferCall: (destination) => sipService.transfer(destination),
    sendDTMF: (digit) => sipService.sendDTMF(digit),
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
