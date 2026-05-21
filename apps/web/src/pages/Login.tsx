// Polished Login page — primary "Sign in with Microsoft" CTA, with
// break-glass password sign-in tucked into a discreet "Other ways to
// sign in" disclosure underneath.
//
// Visual structure:
//   - Outer .auth-shell-v2 — gradient backdrop, centered content
//   - .auth-card-v2 — glass-effect card with proper shadow + radius
//   - Brand block at top (icon + ACE Dialer wordmark + tagline)
//   - Microsoft button (dark variant per Microsoft brand guidance)
//   - "Other ways to sign in" link → expands to password form
//   - Footer line with "by ApTask" + version
import { useEffect, useState } from 'react';
import { Phone } from 'lucide-react';
import { login, getMicrosoftConfig, type User, type MicrosoftConfig } from '../api';
import { startOAuthFlow, buildMicrosoftAuthUrl, isElectron, getRedirectUri, consumeOAuthState } from '../lib/oauth';
import { exchangeMicrosoftCode } from '../api';

interface Props {
  onSuccess: (token: string, user: User) => void;
}

function consumeLogoutReason(): 'jwt_expired' | 'sip_failed' | null {
  try {
    const v = sessionStorage.getItem('ace_logout_reason');
    if (v) sessionStorage.removeItem('ace_logout_reason');
    if (v === 'jwt_expired' || v === 'sip_failed') return v;
  } catch { /* noop */ }
  return null;
}

function consumeSsoError(): string | null {
  try {
    const v = sessionStorage.getItem('ace_sso_error');
    if (v) sessionStorage.removeItem('ace_sso_error');
    return v;
  } catch { return null; }
}

export default function Login({ onSuccess }: Props) {
  const [config, setConfig] = useState<MicrosoftConfig | null>(null);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [startingSso, setStartingSso] = useState(false);
  const [logoutNotice, setLogoutNotice] = useState<string | null>(null);

  // Reset the "Redirecting…" state if the user comes back to the app
  // without completing OAuth (e.g. they closed the browser tab or cancelled
  // at Microsoft's login). Triggers on window focus + page visibility flip.
  useEffect(() => {
    if (!startingSso) return undefined;
    const reset = () => {
      // Small delay so we don't reset before the actual callback URL
      // can route us away from /login.
      window.setTimeout(() => {
        if (window.location.pathname === '/login' || window.location.hash.startsWith('#/login')) {
          setStartingSso(false);
        }
      }, 600);
    };
    window.addEventListener('focus', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('focus', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [startingSso]);

  useEffect(() => {
    const reason = consumeLogoutReason();
    if (reason === 'jwt_expired') {
      setLogoutNotice('Your session expired — please sign in again.');
    } else if (reason === 'sip_failed') {
      setLogoutNotice('Lost connection to the calling service — please sign in again.');
    }
    setSsoError(consumeSsoError());
    void getMicrosoftConfig().then(setConfig);

    // Phase 7 — Electron SSO callback subscription.
    // After the user signs in at Microsoft, the OS routes the
    // ace-dialer://auth/callback?code=... URL to our app, which forwards
    // it here via window.ace.onSsoCallback. We parse code+state, verify
    // state matches what we stashed, do the exchange, and onSuccess()
    // hands the JWT to App.tsx.
    if (!isElectron() || !window.ace) return;
    const unsub = window.ace.onSsoCallback(async (rawUrl: string) => {
      try {
        const url = new URL(rawUrl);
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          setSsoError(`Microsoft sign-in failed: ${url.searchParams.get('error_description') || oauthError}`);
          setStartingSso(false);
          return;
        }
        if (!code || !returnedState) {
          setSsoError('Sign-in returned without a code — please try again.');
          setStartingSso(false);
          return;
        }
        const { state: expectedState, codeVerifier } = consumeOAuthState();
        if (!expectedState || expectedState !== returnedState || !codeVerifier) {
          setSsoError('Sign-in session expired — please try again.');
          setStartingSso(false);
          return;
        }
        const redirectUri = 'ace-dialer://auth/callback';
        const { token, user } = await exchangeMicrosoftCode(code, redirectUri, codeVerifier);
        onSuccess(token, user);
      } catch (e) {
        const err = e as Error & { code?: string };
        setSsoError(
          err.code === 'not_invited'
            ? "Your ApTask account hasn't been invited to the dialer yet. Ask your admin."
            : err.code === 'account_disabled'
              ? 'Your dialer account has been deactivated. Contact your admin.'
              : err.message || 'Sign-in failed.',
        );
        setStartingSso(false);
      }
    });
    // Tell main process we're ready to receive any buffered cold-start URL.
    window.ace.notifyReadyForSso();
    return () => unsub();
  }, [onSuccess]);

  async function handleMicrosoftSignIn() {
    if (!config?.enabled || !config.clientId || !config.tenantId) return;
    setStartingSso(true);
    setError(null);
    try {
      const { state, codeChallenge } = await startOAuthFlow();
      const redirectUri = getRedirectUri();
      const url = buildMicrosoftAuthUrl({
        tenantId: config.tenantId,
        clientId: config.clientId,
        redirectUri,
        state,
        codeChallenge,
      });
      if (isElectron() && window.ace?.openExternal) {
        // Electron: open Microsoft authorize page in the system browser.
        // Microsoft blocks embedded webviews for OAuth and Conditional Access
        // policies usually require a full browser session for MFA. The OS
        // will then route ace-dialer://auth/callback back to our app via
        // the registered protocol handler (see preload.ts onSsoCallback).
        await window.ace.openExternal(url);
        // Don't reset startingSso — the user is now in another window and
        // will be redirected back to our app shortly.
      } else {
        // Web: full-page navigate to Microsoft.
        window.location.assign(url);
      }
    } catch (e) {
      setStartingSso(false);
      setError((e as Error).message || 'Could not start Microsoft sign-in');
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { token, user } = await login(email, password);
      onSuccess(token, user);
    } catch (err) {
      setError((err as Error).message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  const version =
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

  return (
    <div className="auth-shell-v2">
      {/* Soft animated gradient blobs in the background — pure CSS */}
      <div className="auth-bg-blob auth-bg-blob-1" aria-hidden="true" />
      <div className="auth-bg-blob auth-bg-blob-2" aria-hidden="true" />

      <div className="auth-card-v2">
        {/* Brand block */}
        <div className="auth-brand">
          <div className="auth-brand-mark" aria-hidden="true">
            <Phone size={22} strokeWidth={2.5} />
          </div>
          <h1 className="auth-brand-name">ACE Dialer</h1>
          <p className="auth-brand-tagline">Sign in with your ApTask account</p>
        </div>

        {logoutNotice && (
          <div role="alert" className="auth-banner-v2 auth-banner-warn-v2">
            {logoutNotice}
          </div>
        )}

        {ssoError && (
          <div role="alert" className="auth-banner-v2 auth-banner-error-v2">
            {ssoError}
          </div>
        )}

        {/* Primary CTA */}
        {config?.enabled ? (
          <button
            type="button"
            className="ms-signin-btn-v2"
            disabled={startingSso}
            onClick={handleMicrosoftSignIn}
          >
            <svg width="20" height="20" viewBox="0 0 23 23" aria-hidden="true">
              <rect x="1" y="1" width="10" height="10" fill="#F25022" />
              <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
              <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
              <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
            </svg>
            <span>{startingSso ? 'Redirecting to Microsoft…' : 'Sign in with Microsoft'}</span>
          </button>
        ) : config ? (
          <div className="auth-banner-v2 auth-banner-warn-v2">
            Single sign-on is not configured on the server. Contact your admin.
          </div>
        ) : (
          <button type="button" className="ms-signin-btn-v2" disabled>
            <span>Loading…</span>
          </button>
        )}

        {/* Break-glass: tucked-away password form */}
        <div className="auth-divider">
          <span>or</span>
        </div>

        <button
          type="button"
          className="auth-disclosure-btn-v2"
          onClick={() => setShowPasswordForm((v) => !v)}
        >
          {showPasswordForm ? 'Hide password sign-in' : 'Sign in with password (admin only)'}
        </button>

        {showPasswordForm && (
          <form onSubmit={handlePasswordSubmit} className="auth-pwd-form-v2">
            <label>
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@aptask.com"
                required
                autoComplete="email"
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
            {error && <div className="error">{error}</div>}
            <button type="submit" disabled={submitting} className="auth-pwd-submit">
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        {/* Footer */}
        <div className="auth-footer">
          <span>ACE Dialer · v{version}</span>
          <span className="auth-footer-sep">·</span>
          <span>by ApTask</span>
        </div>
      </div>
    </div>
  );
}
