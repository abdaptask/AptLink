import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import Login from './pages/Login';
import MicrosoftCallback from './pages/MicrosoftCallback';
import Layout from './pages/Layout';
import Dialpad from './pages/Dialpad';
import InCall from './pages/InCall';
import Recents from './pages/Recents';
import Voicemail from './pages/Voicemail';
import VoicemailPlay from './pages/VoicemailPlay';
import AutoRoute from './pages/AutoRoute';
import Contacts from './pages/Contacts';
import Favorites from './pages/Favorites';
import Messages from './pages/Messages';
import Chat from './pages/Chat';
import Settings from './pages/Settings';
import type { User } from './api';
import { getMe } from './api';
import { installSessionGuard, onSessionExpired } from './lib/sessionGuard';
import { loadFavoritesFromServer, clearFavoritesCache } from './lib/userPrefs';

// Install the fetch interceptor once, at module load — before any
// component issues an API call. Subsequent calls are no-ops.
installSessionGuard();

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
  // v0.10.60 — Persist the beta flag so SipContext can opt this session
  // into the Connection Health smoothing (disconnect debounce + new
  // 'reconnecting' state). Default false when missing on the server response.
  if (u?.connectionHealthBeta) sessionStorage.setItem('ace_conn_health_beta', '1');
  else sessionStorage.removeItem('ace_conn_health_beta');
  // v0.10.75 — Persist ringtone preference so services/ringtone.ts can
  // read it synchronously when an incoming call rings.
  if (u?.ringtone) sessionStorage.setItem('ace_ringtone', u.ringtone);
  else sessionStorage.removeItem('ace_ringtone');
  // Notify SipContext so it can register against Telnyx now that the creds
  // are in sessionStorage. This kills the login-race where SipContext's
  // useEffect read empty creds and went to 'failed' before User loaded. (#212)
  window.dispatchEvent(new CustomEvent('ace:sip-creds-updated'));
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
        // Pull this user's favorites from the server so they're available
        // across every device they sign into. (Phase 6.11)
        void loadFavoritesFromServer(token);
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
    // Pull favorites for the freshly-logged-in user, so their universal
    // contact list is ready before they land on /keypad. (Phase 6.11)
    void loadFavoritesFromServer(newToken);
    // v0.10.2 — returnTo support. If the user was redirected to /login
    // from a deep link (e.g. a Teams voicemail card → /voicemail/123/play),
    // bring them back to that URL after SSO instead of dumping them on
    // /keypad. ace_return_to is set by the route guard below when an
    // unauthenticated request hits a protected URL.
    let target = '/keypad';
    try {
      const returnTo = sessionStorage.getItem('ace_return_to');
      if (returnTo && returnTo !== '/login' && returnTo !== '/') {
        target = returnTo;
        sessionStorage.removeItem('ace_return_to');
      }
    } catch { /* sessionStorage can throw in private mode — fall back to /keypad */ }
    navigate(target);
  }

  function handleLogout() {
    sessionStorage.removeItem('ace_token');
    persistSipCreds(null);
    // Wipe the favorites cache so a different user on the same machine
    // doesn't inherit them. (Phase 6.11)
    clearFavoritesCache();
    setToken(null);
    setUser(null);
    navigate('/login');
  }

  // v0.10.4 Task 10 — Desktop deep-link handler. When the OS hands us an
  // ace-dialer://call?to=... or ace-dialer://sms?to=... URL (originating
  // from a Teams Adaptive Card button via the /auto/call page), the main
  // process forwards via IPC. We navigate to the matching in-app page
  // with the recipient prefilled. The web fallback (AutoRoute.tsx) handles
  // the same flow for browser-only users; this hook is the desktop-fast
  // path that avoids the AutoRoute redirect step.
  useEffect(() => {
    if (!window.ace?.onDeepLink) return;
    const unsub = window.ace.onDeepLink((data) => {
      if (!data?.to) return;
      const route =
        data.action === 'call'
          ? `/keypad?to=${encodeURIComponent(data.to)}`
          : `/messages?to=${encodeURIComponent(data.to)}`;
      navigate(route);
    });
    // Tell main to flush any cold-start deep link buffered before mount.
    window.ace.notifyReadyForDeepLink?.();
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for session-expired events from the fetch interceptor (401 from
  // any API call) or the SIP watchdog (SipContext stayed 'failed' too long).
  // Both routes converge here so the user can't end up on a stale screen
  // staring at empty data or a dead status indicator.
  useEffect(() => {
    return onSessionExpired((reason) => {
      // If we're already on /login there's nothing to do — also covers the
      // "401 from the login call itself" case so we don't bounce-loop.
      if (window.location.pathname === '/login') return;
      console.warn('[session] expired —', reason, '→ /login');
      // Best-effort: leave a hint for the Login page so it can show a
      // toast like "Your session expired — please log in again."
      try { sessionStorage.setItem('ace_logout_reason', reason); } catch { /* noop */ }
      handleLogout();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="centered">Loading…</div>;

  return (
    <Routes>
      <Route
        path="/auth/microsoft/callback"
        element={<MicrosoftCallback onSuccess={handleLoginSuccess} />}
      />
      <Route
        path="/login"
        element={user ? <Navigate to="/keypad" /> : <Login onSuccess={handleLoginSuccess} />}
      />
      {/* v0.10.70 — Auto-route pages render WITHOUT the auth gate so a
          Teams card click can fire `ace-dialer://` BEFORE the user is
          redirected to /login. Without this, an unauthenticated browser
          hitting /auto/sms got bounced to /login first, the protocol
          launch never ran, and the Teams Reply button always landed on
          the web app's SSO login (the v0.10.67 fix only handled the
          inside-Electron case, not the unauthenticated-browser case).
          The AutoRoute component doesn't need auth — it just attempts
          the protocol redirect and falls back to /messages or /keypad
          after 8s. The fallback DOES hit the auth gate, which is fine:
          if the protocol handler launched Electron, the browser tab
          doesn't matter; if it didn't, the user still needs to log in
          to use the web fallback. */}
      <Route path="/auto/call" element={<AutoRoute action="call" />} />
      <Route path="/auto/sms" element={<AutoRoute action="sms" />} />
      <Route
        path="/"
        element={
          user
            ? <Layout user={user} onLogout={handleLogout} />
            : (() => {
                // v0.10.2 — stash the requested URL so handleLoginSuccess
                // can bounce the user back here after MS SSO. Without this
                // a Teams card click → SSO → /keypad dumps the user away
                // from the voicemail they were trying to play.
                try {
                  const here = window.location.pathname + window.location.search;
                  if (here && here !== '/login') {
                    sessionStorage.setItem('ace_return_to', here);
                  }
                } catch { /* sessionStorage can throw in private mode */ }
                return <Navigate to="/login" />;
              })()
        }
      >
        <Route index element={<Navigate to="/keypad" replace />} />
        <Route path="keypad" element={<Dialpad />} />
        <Route path="in-call" element={<InCall />} />
        <Route path="favorites" element={<Favorites />} />
        <Route path="messages" element={<Messages />} />
        <Route path="chat" element={<Chat />} />
        <Route path="recents" element={<Recents />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="voicemail" element={<Voicemail />} />
        <Route path="voicemail/:id/play" element={<VoicemailPlay />} />
        <Route path="settings" element={<Settings />} />
        <Route path="settings/:section" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to={user ? '/keypad' : '/login'} />} />
    </Routes>
  );
}
