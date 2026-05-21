// In-app banner that surfaces when a newer version of ACE Dialer is live.
//
// How it works:
//   1. On mount (and every 15 minutes after), poll the API's `/` endpoint
//      which returns the SERVER's published version.
//   2. Compare that to the bundled `__APP_VERSION__` (Vite-injected from
//      apps/web/package.json at build time).
//   3. If the server is newer AND the user hasn't dismissed this update yet,
//      show a non-blocking pill at the top of every page with:
//        - "v0.7.0 is available" (or whatever the new version is)
//        - "Download update" button → opens the GitHub Releases page in the
//           user's default browser (Electron uses shell.openExternal; web
//           opens a new tab). On web, also offer "Refresh now" since a fresh
//           page load is enough to pick up the new Vercel bundle.
//        - "✕" dismiss → sessionStorage flag so we don't nag for the rest
//          of this session.
//
// This is a stop-gap until we wire full electron-updater for silent
// download + restart-to-install. For the pilot it's enough to make sure
// nobody runs an outdated build for weeks without realizing it.
import { useEffect, useState } from 'react';
import { Download, X, RefreshCcw } from 'lucide-react';
import { getApiVersion } from '../api';

// User's GitHub releases page. Updated to publish actual installer assets
// via the build-desktop workflow.
const RELEASES_URL = 'https://github.com/abdaptask/acedialerv4/releases/latest';
const DISMISS_KEY_PREFIX = 'ace_update_dismissed_';
const POLL_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

// Parse "1.2.3" → [1, 2, 3]. Ignores anything non-numeric so "1.2.3-beta"
// still works (yields [1, 2, 3]).
function parseSemver(v: string): number[] {
  return v.split(/[.\-+]/).map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

// Returns positive if a > b, 0 if equal, negative if a < b.
function compareSemver(a: string, b: string): number {
  const aP = parseSemver(a);
  const bP = parseSemver(b);
  const len = Math.max(aP.length, bP.length);
  for (let i = 0; i < len; i++) {
    const diff = (aP[i] ?? 0) - (bP[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

declare const __APP_VERSION__: string | undefined;

export default function UpdateBanner() {
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(false);

  const localVersion =
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

  // Poll on mount, then every POLL_INTERVAL_MS. Single source of truth is
  // the API's `/` endpoint which returns { version: "0.6.0", ... }.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      const v = await getApiVersion();
      if (!cancelled && v) setServerVersion(v);
    }
    void check();
    const id = window.setInterval(check, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Re-check dismissal whenever the candidate version changes — we key the
  // sessionStorage flag by version, so the banner re-appears on the NEXT
  // release even if the user dismissed the previous one.
  useEffect(() => {
    if (!serverVersion) return;
    const key = DISMISS_KEY_PREFIX + serverVersion;
    setDismissed(sessionStorage.getItem(key) === '1');
  }, [serverVersion]);

  if (!serverVersion) return null;
  if (compareSemver(serverVersion, localVersion) <= 0) return null;
  if (dismissed) return null;

  const isElectron = !!window.ace?.isElectron;

  function handleDownload() {
    if (isElectron && window.ace?.openExternal) {
      window.ace.openExternal(RELEASES_URL);
    } else {
      window.open(RELEASES_URL, '_blank', 'noopener,noreferrer');
    }
  }

  function handleRefresh() {
    window.location.reload();
  }

  function handleDismiss() {
    const key = DISMISS_KEY_PREFIX + serverVersion;
    sessionStorage.setItem(key, '1');
    setDismissed(true);
  }

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner-icon" aria-hidden="true">
        <Download size={16} />
      </span>
      <span className="update-banner-text">
        <strong>Update available</strong>
        <span className="update-banner-versions">
          v{localVersion} → v{serverVersion}
        </span>
      </span>
      <div className="update-banner-actions">
        {isElectron ? (
          <button
            type="button"
            className="update-banner-cta"
            onClick={handleDownload}
            title={`Open ${RELEASES_URL}`}
          >
            <Download size={14} />
            Download installer
          </button>
        ) : (
          <>
            <button
              type="button"
              className="update-banner-cta"
              onClick={handleRefresh}
              title="Reload to pick up the new web bundle"
            >
              <RefreshCcw size={14} />
              Refresh now
            </button>
            <button
              type="button"
              className="update-banner-cta-secondary"
              onClick={handleDownload}
              title={`Open ${RELEASES_URL}`}
            >
              Desktop installers
            </button>
          </>
        )}
        <button
          type="button"
          className="update-banner-dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss"
          title="Dismiss for this session"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
