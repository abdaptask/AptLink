// v0.10.2 Pillar 2 / Task 10 — Universal-action redirect pages.
//
// These routes are the targets of action buttons in Teams Adaptive
// Cards (Call back / Send text / Reply). They unify desktop + web
// behaviour:
//
//   1. Try to launch the desktop ACE Dialer via the custom protocol
//      ace-dialer://call?to=... (or ...sms?to=...). On the user's
//      desktop the protocol handler (Electron main process — see
//      apps/desktop/src/main.ts) catches this and focuses the app
//      with the recipient pre-filled.
//
//   2. After ~1.2s — long enough for the OS to launch the protocol
//      handler if it exists — fall back to the in-browser dialer.
//      Navigate to /keypad?to=... or /messages?to=... so the user
//      can act from the web app instead. This also covers mobile,
//      where there's no desktop app.
//
// If the user IS logged in, navigation to /keypad / /messages uses
// the existing Dialpad / Messages pages (their query-param handlers
// already accept `?to=`). If NOT logged in, App.tsx's route guard
// stashes the requested URL in ace_return_to and bounces to /login;
// after SSO the user lands back here and the auto-flow completes.
//
// Visible UI is a tiny holding screen — "Opening ACE Dialer…" with a
// fallback button — so the user understands what's happening if the
// protocol launch is blocked or slow.

import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Loader2, ArrowRight } from 'lucide-react';

interface AutoRouteProps {
  /** 'call' for /auto/call, 'sms' for /auto/sms. Drives the protocol
   *  scheme suffix + the eventual web route the fallback navigates to. */
  action: 'call' | 'sms';
}

export default function AutoRoute({ action }: AutoRouteProps) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const to = params.get('to') ?? '';
  const [protocolTried, setProtocolTried] = useState(false);

  useEffect(() => {
    if (!to) {
      // Missing required param — bounce to keypad/messages without it.
      navigate(action === 'call' ? '/keypad' : '/messages', { replace: true });
      return;
    }

    // v0.10.6 — switched from a hidden-iframe protocol launch to
    // window.location.href. Modern Chrome / Edge block iframe-driven
    // custom-protocol launches as a silent-redirect security measure,
    // which made the previous implementation always fall back to web
    // even when the desktop app was installed.
    //
    // window.location.href is the standard pattern (Slack/Zoom/Teams
    // all use it). The browser shows a native "Open <app>?" dialog
    // on first launch; once the user clicks Allow + checks
    // "Always allow", subsequent clicks open the desktop directly
    // with no prompt. If the user clicks Cancel, the browser stays
    // on this page and the 3s fallback timer below kicks in.
    //
    // We bump the fallback delay to 3s (was 1.2s) so the user has
    // time to interact with the browser dialog before we navigate
    // away. If the protocol handler takes over, the desktop app is
    // already focused — the residual navigation in this tab is
    // harmless background noise.
    const url = `ace-dialer://${action}?to=${encodeURIComponent(to)}`;
    try {
      window.location.href = url;
    } catch {
      /* harmless — we'll just rely on the fallback */
    }
    setProtocolTried(true);

    const timer = setTimeout(() => {
      const webRoute =
        action === 'call'
          ? `/keypad?to=${encodeURIComponent(to)}`
          : `/messages?to=${encodeURIComponent(to)}`;
      navigate(webRoute, { replace: true });
    }, 3000);

    return () => clearTimeout(timer);
  }, [to, action, navigate]);

  const label = action === 'call' ? 'Opening the dialer' : 'Opening the composer';
  const fallbackText =
    action === 'call'
      ? 'Open in browser dialer'
      : 'Open in browser composer';
  const fallbackRoute =
    action === 'call'
      ? `/keypad?to=${encodeURIComponent(to)}`
      : `/messages?to=${encodeURIComponent(to)}`;

  return (
    <div className="auto-route-page">
      <div className="auto-route-card">
        <Loader2 size={28} className="spin" />
        <h2>{label}…</h2>
        <p className="muted">
          {protocolTried
            ? 'If the desktop app didn\'t open, use the button below.'
            : 'Launching ACE Dialer…'}
        </p>
        <button
          type="button"
          className="settings-btn"
          onClick={() => navigate(fallbackRoute, { replace: true })}
        >
          {fallbackText} <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}
