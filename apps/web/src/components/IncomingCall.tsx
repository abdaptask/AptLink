// Phase 5.2: full-screen UI when an inbound call rings.
// In Electron, the floating ringer popup (managed by main process) ALSO
// appears with Accept/Decline buttons, so the user never misses a call
// even when the main window is minimized.
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Phone, PhoneOff } from 'lucide-react';
import { useSip } from '../contexts/SipContext';
import { ringtone } from '../services/ringtone';
import { useJobDivaContact } from '../hooks/useJobDivaContact';

function formatNumber(n: string | undefined): string {
  if (!n) return 'Unknown';
  const digits = n.replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return n;
}

export default function IncomingCall() {
  const { incoming, acceptCall, declineCall } = useSip();
  const location = useLocation();
  const navigate = useNavigate();

  const handleAccept = () => {
    acceptCall();
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
        <div className="incoming-subtle">…</div>
        <div className="incoming-actions">
          <button className="incoming-btn decline" onClick={declineCall} aria-label="Decline">
            <PhoneOff size={28} />
          </button>
          <button className="incoming-btn accept" onClick={handleAccept} aria-label="Accept">
            <Phone size={28} />
          </button>
        </div>
      </div>
    </div>
  ) : (
    <div className="incoming-banner" role="alert">
      <div className="incoming-banner-text">
        <div className="incoming-banner-tag">Incoming call</div>
        <div className="incoming-banner-caller">{callerLabel}</div>
      </div>
      <div className="incoming-banner-actions">
        <button className="incoming-btn decline small" onClick={declineCall} aria-label="Decline">
          <PhoneOff size={20} />
        </button>
        <button className="incoming-btn accept small" onClick={handleAccept} aria-label="Accept">
          <Phone size={20} />
        </button>
      </div>
    </div>
  );
}
