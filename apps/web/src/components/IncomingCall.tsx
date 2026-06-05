// Phase 5.2: full-screen UI when an inbound call rings.
// In Electron, the floating ringer popup (managed by main process) ALSO
// appears with Accept/Decline buttons, so the user never misses a call
// even when the main window is minimized.
//
// Phase 6.3 — Hold & Accept (Pulse-style): when there's already a connected
// call, we show a third button between Decline and Accept. Tapping it holds
// the current call and answers the new one; the held call shows up in the
// InCall held-strip (same plumbing as Add Call).
//
// Phase 7.2 — Reply with message (iOS-style): a 3rd action button on the
// ringing screen. Tapping it IMMEDIATELY declines the call AND dispatches
// a window event that PostDeclineReply (mounted in Layout, OUTSIDE this
// component) picks up to surface a clean quick-reply sheet. Decoupling
// keeps the reply UI alive after this component unmounts on decline.
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Phone, PhoneOff, PhoneForwarded, MessageSquare } from 'lucide-react';
import { useSip } from '../contexts/SipContext';
import { ringtone } from '../services/ringtone';
import { useJobDivaContact } from '../hooks/useJobDivaContact';
import { notify } from '../lib/notify';
import { formatPhone } from '../lib/phone';
import { getFavoriteName } from '../lib/userPrefs';
import { getRecentInboundCall, type RowUserDid } from '../api';

function formatNumber(n: string | undefined): string {
  return formatPhone(n) || 'Unknown';
}

export default function IncomingCall() {
  const { incoming, acceptCall, declineCall, holdAndAcceptCall, callState, hasSecondCall } = useSip();
  const location = useLocation();
  const navigate = useNavigate();

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

  const callerNumber = incoming?.fromNumber ?? incoming?.number;
  const jd = useJobDivaContact(callerNumber);

  // v0.10.9 — Look up which of the user's DIDs the call landed on so we
  // can render a line badge ("Incoming on Main · (732) 200-1305") on
  // the ringer. The SIP INVITE doesn't carry the dialed DID, only our
  // SIP credential. The webhooks service already stamped userDidId on
  // the Call row (resolveUserAndDid by to_number match) before TexML
  // even fired the dialing, so by the time the ringer mounts we can
  // ask the API for the most-recent inbound call from this caller.
  // Renders empty + then fades the badge in once the lookup returns
  // (typically <300ms). Re-fetched on each new incoming.callId.
  const [calledLine, setCalledLine] = useState<RowUserDid | null>(null);
  useEffect(() => {
    if (!incoming?.callId || !callerNumber) {
      setCalledLine(null);
      return;
    }
    let cancelled = false;
    const token = sessionStorage.getItem('ace_token');
    if (!token) return;
    void getRecentInboundCall(token, callerNumber).then((call) => {
      if (cancelled) return;
      setCalledLine(call?.userDid ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [incoming?.callId, callerNumber]);

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

  const isElectron =
    typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent);
  const fullScreen =
    isElectron ||
    canHoldAndAccept ||
    location.pathname === '/keypad' ||
    location.pathname === '/' ||
    location.pathname === '/login';

  const callerLabel = getFavoriteName(callerNumber) ?? jd?.name ?? formatNumber(callerNumber);

  // Reply button: only for real phone numbers (not SIP-URI internal calls),
  // and hidden during Hold & Accept (3 buttons already shown).
  const replyableNumber = (callerNumber || '').replace(/[\s()-]/g, '');
  const canReply = !canHoldAndAccept && /^\+?\d/.test(replyableNumber);

  function handleReplyWithMessage() {
    const to = callerNumber;
    if (!to) return;
    // Dispatch the open-the-modal event BEFORE we decline. Layout's
    // PostDeclineReply listens for this and stays mounted regardless of
    // our own state. Order matters slightly: dispatch first so the
    // listener captures the payload synchronously, then declineCall
    // unmounts this component.
    window.dispatchEvent(new CustomEvent('ace:reply-after-decline', {
      detail: { number: to, label: callerLabel },
    }));
    declineCall();
  }

  // v0.10.9 \u2014 Line badge text shown under the caller name on the ringer.
  // Empty until the recent-inbound lookup returns; then "on Main \u00b7 (732) 200-1305".
  const lineBadge = calledLine
    ? `on ${calledLine.label} \u00b7 ${formatPhone(calledLine.didNumber) || calledLine.didNumber}`
    : null;

  return fullScreen ? (
    <div className="incoming-fullscreen">
      <div className="incoming-fs-inner">
        <div className="incoming-tag">Incoming call</div>
        <div className="incoming-caller">{callerLabel}</div>
        {lineBadge && (
          <div
            className="incoming-line-badge"
            style={{ '--line-color': calledLine?.colorHex } as React.CSSProperties}
          >
            <span className="incoming-line-swatch" />
            <span className="incoming-line-text">{lineBadge}</span>
          </div>
        )}
        <div className="incoming-subtle">
          {canHoldAndAccept ? 'You\u2019re already on a call' : '\u2026'}
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
          {canReply && (
            <div className="incoming-action-stack">
              <button
                className="incoming-btn reply"
                onClick={handleReplyWithMessage}
                aria-label="Reply with message"
                title="Reply with a text message and decline the call"
              >
                <MessageSquare size={28} />
              </button>
              <div className="incoming-action-label">Reply with Text</div>
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
          Incoming call{canHoldAndAccept ? ' \u00b7 in-call' : ''}
          {lineBadge && (
            <span
              className="incoming-line-badge incoming-line-badge-compact"
              style={{ '--line-color': calledLine?.colorHex } as React.CSSProperties}
            >
              <span className="incoming-line-swatch" />
              <span className="incoming-line-text">{lineBadge}</span>
            </span>
          )}
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
        {canReply && (
          <button
            className="incoming-btn reply small"
            onClick={handleReplyWithMessage}
            aria-label="Reply with message"
            title="Reply with a text message and decline the call"
          >
            <MessageSquare size={18} />
          </button>
        )}
        <button className="incoming-btn accept small" onClick={handleAccept} aria-label="Accept">
          <Phone size={20} />
        </button>
      </div>
    </div>
  );
}
