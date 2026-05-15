// Phase 5.2: full-screen / banner UI shown when an inbound call rings.
// Picks full-screen on /keypad (idle), banner everywhere else, so the user
// doesn't get yanked out of a tab they were working in.
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Phone, PhoneOff } from 'lucide-react';
import { useSip } from '../contexts/SipContext';
import { ringtone } from '../services/ringtone';

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

  // Start/stop the ringtone in lockstep with the incoming call state.
  useEffect(() => {
    if (incoming) {
      ringtone.start();
      return () => ringtone.stop();
    }
    return undefined;
  }, [incoming]);

  if (!incoming) return null;

  // Electron: always go full-screen (this IS the dialer, not a side widget).
  // Web: full-screen only on /keypad/login; slim banner on other tabs so the
  // user can keep glancing at Recents/Contacts while accepting.
  const isElectron =
    typeof navigator !== 'undefined' &&
    /electron/i.test(navigator.userAgent);
  const fullScreen =
    isElectron ||
    location.pathname === '/keypad' ||
    location.pathname === '/' ||
    location.pathname === '/login';

  const callerLabel = formatNumber(incoming.fromNumber ?? incoming.number);

  return fullScreen ? (
    <div className="incoming-fullscreen">
      <div className="incoming-fs-inner">
        <div className="incoming-tag">Incoming call</div>
        <div className="incoming-caller">{callerLabel}</div>
        <div className="incoming-subtle">…</div>
        <div className="incoming-actions">
          <button
            className="incoming-btn decline"
            onClick={declineCall}
            aria-label="Decline"
          >
            <PhoneOff size={28} />
          </button>
          <button
            className="incoming-btn accept"
            onClick={acceptCall}
            aria-label="Accept"
          >
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
        <button
          className="incoming-btn decline small"
          onClick={declineCall}
          aria-label="Decline"
        >
          <PhoneOff size={20} />
        </button>
        <button
          className="incoming-btn accept small"
          onClick={acceptCall}
          aria-label="Accept"
        >
          <Phone size={20} />
        </button>
      </div>
    </div>
  );
}
