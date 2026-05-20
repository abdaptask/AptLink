import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import Login from './pages/Login';
import Layout from './pages/Layout';
import Dialpad from './pages/Dialpad';
import InCall from './pages/InCall';
import Recents from './pages/Recents';
import Voicemail from './pages/Voicemail';
import Contacts from './pages/Contacts';
import Favorites from './pages/Favorites';
import Messages from './pages/Messages';
import Settings from './pages/Settings';
import type { User } from './api';
import { getMe } from './api';

// Stash the user's per-account SIP creds into sessionStorage so SipContext
// can register Telnyx as THIS user instead of using build-time env vars.
// Cleared on logout / token expiry.
function persistSipCreds(u: User | null): void {
  if (u?.sipUsername) sessionStorage.setItem('ace_sip_username', u.sipUsername);
  else sessionStorage.removeItem('ace_sip_username');
  if (u?.sipPassword) sessionStorage.setItem('ace_sip_password', u.sipPassword);
  else sessionStorage.removeItem('ace_sip_password');
  if (u?.didNumber) sessionStorage.setItem('ace_did', u.didNumber);
  else sessionStorage.removeItem('ace_did');
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem('ace_token'));
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    getMe(token)
      .then((u) => {
        setUser(u);
        persistSipCreds(u);
      })
      .catch(() => {
        sessionStorage.removeItem('ace_token');
        persistSipCreds(null);
        setToken(null);
      })
      .finally(() => setLoading(false));
  }, [token]);

  function handleLoginSuccess(newToken: string, newUser: User) {
    sessionStorage.setItem('ace_token', newToken);
    persistSipCreds(newUser);
    setToken(newToken);
    setUser(newUser);
    navigate('/keypad');
  }

  function handleLogout() {
    sessionStorage.removeItem('ace_token');
    persistSipCreds(null);
    setToken(null);
    setUser(null);
    navigate('/login');
  }

  if (loading) return <div className="centered">Loading…</div>;

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/keypad" /> : <Login onSuccess={handleLoginSuccess} />}
      />
      <Route
        path="/"
        element={user ? <Layout user={user} onLogout={handleLogout} /> : <Navigate to="/login" />}
      >
        <Route index element={<Navigate to="/keypad" replace />} />
        <Route path="keypad" element={<Dialpad />} />
        <Route path="in-call" element={<InCall />} />
        <Route path="favorites" element={<Favorites />} />
        <Route path="messages" element={<Messages />} />
        <Route path="recents" element={<Recents />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="voicemail" element={<Voicemail />} />
        <Route path="settings" element={<Settings />} />
        <Route path="settings/:section" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to={user ? '/keypad' : '/login'} />} />
    </Routes>
  );
}
