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
  Download as DownloadIcon,
  Phone,
  ChevronDown,
  Monitor,
  Star,
} from 'lucide-react';
import type { User } from '../api';
import {
  getMessagesUnreadCount,
  getMissedCallsCount,
  getVoicemailsUnreadCount,
  getInternalChatUnreadCount,
} from '../api';
import IncomingCall from '../components/IncomingCall';
import PostDeclineReply from '../components/PostDeclineReply';
import SmsNotifier from '../components/SmsNotifier';
import UpdateBanner from '../components/UpdateBanner';
import DidSwitcher from '../components/DidSwitcher';
import { useSip } from '../contexts/SipContext';
import { ensureNotificationPermission } from '../lib/notify';
import {
  getNotificationPrefs,
  getLastVisit,
  markTabVisited,
  type TabKey,
} from '../lib/userPrefs';
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

  // Bottom-nav unread/missed counts. Polled every 15s while the app is open.
  // When the user clicks a tab, mark that tab visited (resets its count).
  const [unread, setUnread] = useState<{ messages: number; missed: number; voicemail: number; chat: number }>({
    messages: 0, missed: 0, voicemail: 0, chat: 0,
  });
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const token = sessionStorage.getItem('ace_token');
      if (!token) return;
      try {
        const [m, c, v, chat] = await Promise.all([
          getMessagesUnreadCount(token, getLastVisit('messages')),
          getMissedCallsCount(token, getLastVisit('recents')),
          getVoicemailsUnreadCount(token),
          getInternalChatUnreadCount(token),
        ]);
        if (!cancelled) setUnread({ messages: m, missed: c, voicemail: v, chat });
      } catch { /* silent */ }
    };
    void refresh();
    const id = window.setInterval(refresh, 15000);
    // Also refresh when any tab visit event fires (clears the badge instantly).
    const onTabVisit = () => { void refresh(); };
    window.addEventListener('ace:tabVisited', onTabVisit);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('ace:tabVisited', onTabVisit);
    };
  }, []);

  // Stamp last-visit when route changes to one of the badged tabs.
  useEffect(() => {
    const path = location.pathname;
    if (path.startsWith('/messages')) markTabVisited('messages' as TabKey);
    else if (path.startsWith('/recents')) markTabVisited('recents' as TabKey);
    else if (path.startsWith('/voicemail')) markTabVisited('voicemail' as TabKey);
  }, [location.pathname]);

  // CLAUDE.md UI rule #3 — page scroll-to-top on every route change.
  // This was a recurring complaint (user flagged it 3+ times across the
  // v0.9.x sprint). Locking it here at the Layout level means it can't
  // get forgotten on any individual page. Fires immediately + on a
  // microtask + on a paint frame to cover React's render → layout
  // ordering quirks (some pages mount with content already rendered
  // and ignore an immediate scrollTo).
  useEffect(() => {
    const resetAll = () => {
      try {
        window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      } catch {
        window.scrollTo(0, 0);
      }
      // Any internal scroll containers — settings pane body, main
      // content area, generic .scroll-root — get reset too.
      const selectors = [
        '.app-content',
        '.settings-pane-body',
        '.scroll-root',
        '[data-scroll-root]',
      ];
      for (const sel of selectors) {
        document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
          el.scrollTop = 0;
        });
      }
    };
    resetAll();
    queueMicrotask(resetAll);
    const raf = requestAnimationFrame(resetAll);
    const timeout = window.setTimeout(resetAll, 50);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
    };
  }, [location.pathname]);
  const isElectron =
    typeof navigator !== 'undefined' &&
    /electron/i.test(navigator.userAgent);

  // User dropdown menu
  const [menuOpen, setMenuOpen] = useState(false);
  // Manual "Check for updates" status (Electron only). Shows inline below
  // the menu item: 'checking…' | 'no_update' | 'update_found' | 'error'. (#213)
  const [updateCheck, setUpdateCheck] = useState<{
    state: 'idle' | 'checking' | 'no_update' | 'update_found' | 'error';
    message?: string;
  }>({ state: 'idle' });
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
      {/* Mounted OUTSIDE IncomingCall so the quick-reply sheet survives the
          call's UI unmounting on decline. Listens for the
          ace:reply-after-decline window event. (#201 rebuild) */}
      <PostDeclineReply />
      <SmsNotifier />
      {/* Polls the API every 15 min — when the server reports a higher
          version than the bundled __APP_VERSION__, surfaces a pill at the
          top of every page so users on stale installs know to update. (#197) */}
      <UpdateBanner />

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

        {/* v0.10.0 — Center column of the header. Wraps the SIP status
            pill + DidSwitcher in a single flex container so they share
            the middle grid column. Without this wrapper, adding
            DidSwitcher as a fourth header child pushed the user-chip
            into an implicit second grid row (visible as a "skewed"
            layout). Keeping them together preserves the original 3-col
            header grid (left brand · center status+did · right user). */}
        <div className="app-header-center">
          <div className={`sip-status-pill ${sipPresentation.dot}`} role="status" title={`SIP: ${sipPresentation.label}`}>
            <span className={`sip-status-dot ${sipPresentation.dot}`} />
            <span className="sip-status-label">{sipPresentation.label}</span>
          </div>

          <DidSwitcher
            onSwitch={(did) => {
              // Outbound caller ID has been PATCHed on Telnyx via
              // /me/active-did. Calls placed after this point use the new
              // ani_override. SMS path reads User.activeUserDidId on every
              // /messages POST, so nothing to wire client-side beyond this
              // notification. Log purely for diagnostics.
              console.log('[layout] active DID switched to', did.label, did.didNumber);
            }}
          />
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
              {/* Manual "Check for updates" — only meaningful in Electron.
                  Auto-update should handle this, but the manual button is a
                  reliable fallback when the 60-min poll hasn't fired yet. (#213) */}
              {isElectron && window.ace?.checkForUpdates && (
                <>
                  <button
                    type="button"
                    className="user-menu-item"
                    role="menuitem"
                    disabled={updateCheck.state === 'checking'}
                    onClick={async () => {
                      setUpdateCheck({ state: 'checking' });
                      try {
                        const result = await window.ace!.checkForUpdates!();
                        setUpdateCheck({
                          state: result.state === 'no_update' ? 'no_update'
                            : result.state === 'update_found' ? 'update_found'
                            : 'error',
                          message: result.message,
                        });
                      } catch (err) {
                        setUpdateCheck({ state: 'error', message: (err as Error).message });
                      }
                    }}
                  >
                    <DownloadIcon size={16} /> {updateCheck.state === 'checking' ? 'Checking…' : 'Check for updates'}
                  </button>
                  {updateCheck.state !== 'idle' && updateCheck.state !== 'checking' && (
                    <div className={`user-menu-status ${updateCheck.state}`}>
                      {updateCheck.message ?? ''}
                    </div>
                  )}
                </>
              )}
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
        {/* v0.10.13 — Merged tab. Messages now lists BOTH SMS conversations
            (external phone numbers) and internal chats with teammates.
            Unread badge sums both event types so users see one number for
            "people waiting on me to reply". Old /chat route still exists
            as a deep link target; clicking a chat row in the Messages list
            navigates there. */}
        <NavLink to="/messages" className={({ isActive }) => (isActive || window.location.pathname.startsWith('/chat') ? 'tab active' : 'tab')}>
          <span className="tab-icon-wrap">
            <MessageSquare size={22} />
            {(unread.messages + unread.chat) > 0 && (
              <span className="tab-badge" aria-label={`${unread.messages + unread.chat} unread messages`}>
                {(unread.messages + unread.chat) > 99 ? '99+' : (unread.messages + unread.chat)}
              </span>
            )}
          </span>
          <span>Messages</span>
        </NavLink>
        <NavLink to="/recents" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          <span className="tab-icon-wrap">
            <Clock size={22} />
            {unread.missed > 0 && (
              <span className="tab-badge" aria-label={`${unread.missed} missed calls`}>
                {unread.missed > 99 ? '99+' : unread.missed}
              </span>
            )}
          </span>
          <span>Recents</span>
        </NavLink>
        <NavLink to="/keypad" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          <Grid3x3 size={22} /><span>Keypad</span>
        </NavLink>
        <NavLink to="/voicemail" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          <span className="tab-icon-wrap">
            <Voicemail size={22} />
            {unread.voicemail > 0 && (
              <span className="tab-badge" aria-label={`${unread.voicemail} unread voicemails`}>
                {unread.voicemail > 99 ? '99+' : unread.voicemail}
              </span>
            )}
          </span>
          <span>Voicemail</span>
        </NavLink>
      </nav>
    </div>
  );
}
