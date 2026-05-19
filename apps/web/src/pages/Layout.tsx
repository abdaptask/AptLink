import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  MessageSquare,
  Clock,
  User as UserIcon,
  Grid3x3,
  Voicemail,
  LogOut,
  Settings as SettingsIcon,
  Phone,
  ChevronDown,
  Monitor,
  Star,
} from 'lucide-react';
import type { User } from '../api';
import IncomingCall from '../components/IncomingCall';
import SmsNotifier from '../components/SmsNotifier';
import { useSip } from '../contexts/SipContext';
import { ensureNotificationPermission } from '../lib/notify';
import { getNotificationPrefs } from '../lib/userPrefs';
import { formatPhone } from '../lib/phone';

function userInitials(user: User): string {
  if (user.firstName) {
    const last = user.lastName ?? '';
    return ((user.firstName[0] ?? '') + (last[0] ?? '')).toUpperCase() || 'U';
  }
  const email = user.email ?? '';
  return (email[0] ?? 'U').toUpperCase();
}

// Hue from a simple hash so the avatar color stays stable per user but varies
// across users. Saturation/lightness fixed so it always looks good on bg.
function userAvatarHue(user: User): number {
  const key = (user.email ?? '') + (user.firstName ?? '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function formatNumberShort(n: string | undefined | null): string {
  return formatPhone(n);
}

interface Props {
  user: User;
  onLogout: () => void;
}

export default function Layout({ user, onLogout }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { callState, sipState } = useSip();
  const isElectron =
    typeof navigator !== 'undefined' &&
    /electron/i.test(navigator.userAgent);

  // User dropdown menu
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const initials = userInitials(user);
  const hue = userAvatarHue(user);
  const displayName = user.firstName
    ? `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`
    : user.email;

  // Ask the browser for desktop-notification permission once after login
  // if the user has either notification pref enabled. We don't prompt
  // immediately on app load (which Chrome treats as spammy) — we wait until
  // the user has navigated past login. Layout mount = post-login.
  useEffect(() => {
    const prefs = getNotificationPrefs();
    if (prefs.desktopNotification || prefs.smsNotification) {
      void ensureNotificationPermission();
    }
  }, []);

  // SIP status presentation
  const sipPresentation = (() => {
    switch (sipState) {
      case 'registered': return { label: 'Online', dot: 'ok' };
      case 'connecting': return { label: 'Connecting…', dot: 'warn' };
      case 'failed':     return { label: 'Offline', dot: 'err' };
      default:           return { label: 'Disconnected', dot: 'err' };
    }
  })();

  // Auto-navigate to InCall only on the *transition* into 'connected'
  // (otherwise we'd fight Add-Call → keypad navigation).
  const prevStateRef = useRef(callState.state);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = callState.state;
    if (callState.state === 'connected' && prev !== 'connected' && location.pathname !== '/in-call') {
      navigate('/in-call');
    }
  }, [callState.state, location.pathname, navigate]);

  // Show a "return to call" banner whenever we're not on /in-call but
  // there's still an active call in progress.
  const hasActiveCall =
    (callState.state === 'calling' ||
      callState.state === 'ringing' ||
      callState.state === 'connected') &&
    location.pathname !== '/in-call';
  const activeOther =
    callState.direction === 'inbound'
      ? callState.fromNumber ?? callState.number
      : callState.toNumber ?? callState.number;

  return (
    <div className="app-shell">
      <IncomingCall />
      <SmsNotifier />

      {hasActiveCall && (
        <button
          type="button"
          className="return-to-call-banner"
          onClick={() => navigate('/in-call')}
          aria-label="Return to active call"
        >
          <span className="rtc-icon">
            <Phone size={14} />
          </span>
          <span className="rtc-text">
            <span className="rtc-tag">On call</span>
            <span className="rtc-num">{formatNumberShort(activeOther) || 'Active call'}</span>
          </span>
          <span className="rtc-back">Tap to return</span>
        </button>
      )}

      <header className="app-header">
        <div className="app-header-left">
          <div className="brand-mark" aria-hidden="true">
            <Phone size={14} strokeWidth={2.5} />
          </div>
          <div className="brand-block">
            <span className="brand">ACE Dialer</span>
            <span className="version">
              v{__APP_VERSION__}
              <span className="version-sep">·</span>
              {isElectron ? <Monitor size={10} aria-hidden="true" /> : null}
              {isElectron ? 'Desktop' : 'Web'}
            </span>
          </div>
        </div>

        <div className={`sip-status-pill ${sipPresentation.dot}`} role="status" title={`SIP: ${sipPresentation.label}`}>
          <span className={`sip-status-dot ${sipPresentation.dot}`} />
          <span className="sip-status-label">{sipPresentation.label}</span>
        </div>

        <div className="header-user" ref={menuRef}>
          <button
            type="button"
            className={`user-chip ${menuOpen ? 'open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span
              className="user-avatar"
              style={{
                background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 30) % 360} 70% 45%))`,
              }}
            >
              {initials}
            </span>
            <span className="user-name">{user.firstName ?? user.email}</span>
            <ChevronDown size={14} className="user-chev" />
          </button>

          {menuOpen && (
            <div className="user-menu" role="menu">
              <div className="user-menu-header">
                <span
                  className="user-avatar large"
                  style={{
                    background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 30) % 360} 70% 45%))`,
                  }}
                >
                  {initials}
                </span>
                <div className="user-menu-id">
                  <div className="user-menu-name">{displayName}</div>
                  <div className="user-menu-email">{user.email}</div>
                </div>
              </div>
              <button
                type="button"
                className="user-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  navigate('/settings');
                }}
              >
                <SettingsIcon size={16} /> Settings
              </button>
              <button
                type="button"
                className="user-menu-item danger"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
              >
                <LogOut size={16} /> Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="app-content">
        <Outlet />
      </main>

      <nav className="tab-bar">
        <NavLink to="/favorites" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          <Star size={22} /><span>Favorites</span>
        </NavLink>
        <NavLink to="/messages" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          <MessageSquare size={22} /><span>Messages</span>
        </NavLink>
        <NavLink to="/recents" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          <Clock size={22} /><span>Recents</span>
        </NavLink>
        <NavLink to="/keypad" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          <Grid3x3 size={22} /><span>Keypad</span>
        </NavLink>
        <NavLink to="/voicemail" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          <Voicemail size={22} /><span>Voicemail</span>
        </NavLink>
      </nav>
    </div>
  );
}
