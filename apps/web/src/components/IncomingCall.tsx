// Phase 5.2: full-screen UI when an inbound call rings.
// In Electron, the floating ringer popup (managed by main process) ALSO
// appears with Accept/Decline buttons, so the user never misses a call
// even when the main window is minimized.
//
// Phase 6.3 — Hold & Accept (Pulse-style): when there's already a connected
// call, we show a third button between Decline and Accept. Tapping it holds
// the current call and answers the new one; the held call shows up in the
// InCall held-strip (same plumbing as Add Call).
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Phone, PhoneOff, PhoneForwarded } from 'lucide-react';
import { useSip } from '../contexts/SipContext';
import { ringtone } from '../services/ringtone';
import { useJobDivaContact } from '../hooks/useJobDivaContact';
import { notify } from '../lib/notify';
import { formatPhone } from '../lib/phone';

function formatNumber(n: string | undefined): string {
  return formatPhone(n) || 'Unknown';
}

export default function IncomingCall() {
  const { incoming, acceptCall, declineCall, holdAndAcceptCall, callState, hasSecondCall } = useSip();
  const location = useLocation();
  const navigate = useNavigate();

  // Show "Hold & Accept" only when there's an active connected call AND we
  // don't already have 2 calls in play. With 2 calls already, the user
  // should hang one up before adding a third — JsSIP supports it but the UI
  // can only show two pills cleanly.
  const hasActiveCall = callState.state === 'connected';
  const canHoldAndAccept = hasActiveCall && !hasSecondCall;

  const handleAccept = () => {
    acceptCall();
    navigate('/in-call');
  };

  const handleHoldAndAccept = () => {
    holdAndAcceptCall();
    navigate('/in-call');
  };

  useEffect(() => {
    if (incoming) {
      ringtone.start();
      return () => ringtone.stop();
    }
    return undefined;
  }, [incoming]);

  // Call the hook unconditionally (rules of hooks). It's safe with undefined.
  const callerNumber = incoming?.fromNumber ?? incoming?.number;
  const jd = useJobDivaContact(callerNumber);

  // Fire an OS desktop notification when the tab is hidden so users don't miss
  // calls while the window is in the background. Respects notification prefs.
  useEffect(() => {
    if (!incoming) return;
    const label = jd?.name ?? formatNumber(callerNumber);
    void notify({
      title: 'Incoming call',
      body: label,
      tag: `incoming-${incoming.callId ?? 'x'}`,
      prefKey: 'desktopNotification',
      onClick: () => {
        navigate('/in-call');
      },
    });
  }, [incoming, jd, callerNumber, navigate]);

  if (!incoming) return null;

  // Electron: always go full-screen. Web: full-screen on idle, banner elsewhere.
  const isElectron =
    typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent);
  const fullScreen =
    isElectron ||
    location.pathname === '/keypad' ||
    location.pathname === '/' ||
    location.pathname === '/login';

  const callerLabel = jd?.name ?? formatNumber(callerNumber);

  return fullScreen ? (
    <div className="incoming-fullscreen">
      <div className="incoming-fs-inner">
        <div className="incoming-tag">Incoming call</div>
        <div className="incoming-caller">{callerLabel}</div>
        <div className="incoming-subtle">
          {canHoldAndAccept ? 'You’re already on a call' : '…'}
        </div>
        <div className="incoming-actions">
          <div className="incoming-action-stack">
            <button className="incoming-btn decline" onClick={declineCall} aria-label="Decline">
              <PhoneOff size={32} />
            </button>
            <div className="incoming-action-label">Decline</div>
          </div>
          {canHoldAndAccept && (
            <div className="incoming-action-stack">
              <button
                className="incoming-btn hold-accept"
                onClick={handleHoldAndAccept}
                aria-label="Hold current call and accept"
                title="Hold current call and accept"
              >
                <PhoneForwarded size={30} />
              </button>
              <div className="incoming-action-label">Hold &amp; Accept</div>
            </div>
          )}
          <div className="incoming-action-stack">
            <button className="incoming-btn accept" onClick={handleAccept} aria-label="Accept">
              <Phone size={32} />
            </button>
            <div className="incoming-action-label">Accept</div>
          </div>
        </div>
      </div>
    </div>
  ) : (
    <div className="incoming-banner" role="alert">
      <div className="incoming-banner-text">
        <div className="incoming-banner-tag">
          Incoming call{canHoldAndAccept ? ' · in-call' : ''}
        </div>
        <div className="incoming-banner-caller">{callerLabel}</div>
      </div>
      <div className="incoming-banner-actions">
        <button className="incoming-btn decline small" onClick={declineCall} aria-label="Decline">
          <PhoneOff size={20} />
        </button>
        {canHoldAndAccept && (
          <button
            className="incoming-btn hold-accept small"
            onClick={handleHoldAndAccept}
            aria-label="Hold current call and accept"
            title="Hold current call and accept"
          >
            <PhoneForwarded size={18} />
          </button>
        )}
        <button className="incoming-btn accept small" onClick={handleAccept} aria-label="Accept">
          <Phone size={20} />
        </button>
      </div>
    </div>
  );
}
