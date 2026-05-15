import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { MessageSquare, Clock, User as UserIcon, Grid3x3, Voicemail, LogOut, Settings as SettingsIcon } from 'lucide-react';
import type { User } from '../api';
import IncomingCall from '../components/IncomingCall';
import { useSip } from '../contexts/SipContext';

interface Props {
  user: User;
  onLogout: () => void;
}

export default function Layout({ user, onLogout }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { callState } = useSip();
  const isElectron =
    typeof navigator !== 'undefined' &&
    /electron/i.test(navigator.userAgent);

  // Auto-navigate to the InCall screen when a call connects (covers both
  // outbound dials and inbound calls the user accepts via the floating ringer).
  useEffect(() => {
    if (callState.state === 'connected' && location.pathname !== '/in-call') {
      navigate('/in-call');
    }
  }, [callState.state, location.pathname, navigate]);

  return (
    <div className="app-shell">
      <IncomingCall />

      <header className="app-header">
        <span className="brand">ACE Dialer</span>
        <span className="version">v{__APP_VERSION__}{isElectron ? ' · Desktop' : ' · Web'}</span>
        <span className="who">{user.firstName ?? user.email}</span>
        <div className="header-actions">
          <button className="icon-btn" onClick={() => navigate('/settings')} aria-label="Settings">
            <SettingsIcon size={18} />
          </button>
          <button className="icon-btn" onClick={onLogout} aria-label="Sign out">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <main className="app-content">
        <Outlet />
      </main>

      <nav className="tab-bar">
        <NavLink to="/messages" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          <MessageSquare size={22} /><span>Messages</span>
        </NavLink>
        <NavLink to="/recents" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          <Clock size={22} /><span>Recents</span>
        </NavLink>
        <NavLink to="/contacts" className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
          <UserIcon size={22} /><span>Contacts</span>
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
