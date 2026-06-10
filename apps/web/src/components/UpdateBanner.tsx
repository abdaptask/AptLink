// In-app banner that surfaces when a newer version of ACE Dialer is live.
//
// Two paths, depending on what the runtime supports:
//
//  A) ELECTRON with electron-updater (the new normal — Phase 7.1):
//     - Main process polls GitHub Releases every 60 min, downloads the new
//       installer SILENTLY in the background, and emits IPC events.
//     - We subscribe via window.ace.onUpdateAvailable / onUpdateDownloaded.
//     - When download finishes, show "Update ready — Restart to install"
//       with a single button that calls window.ace.installUpdate(). The
//       main process runs `autoUpdater.quitAndInstall()`, the new installer
//       runs, the app relaunches. Zero clicks beyond the restart button.
//
//  B) WEB BROWSER, or older Electron without the updater bridge (legacy):
//     - We fall back to polling the API's `/` endpoint every 15 min and
//       comparing the server version against the bundled __APP_VERSION__.
//     - When ahead, show a banner with:
//         - "Refresh now" (web) → reload the page so the new Vercel bundle
//           gets picked up.
//         - "Download installer" → opens GitHub Releases in the system
//           browser so the user can grab the new .dmg or .exe.
//
// Dismissal is keyed by candidate version so the banner reappears on the
// NEXT release even if the user dismissed the previous one.
import { useEffect, useState } from 'react';
import { Download, X, RefreshCcw, AlertTriangle } from 'lucide-react';
import { getApiVersion } from '../api';

const RELEASES_URL = 'https://github.com/abdaptask/AptLink/releases/latest';
const DISMISS_KEY_PREFIX = 'ace_update_dismissed_';
const POLL_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes (web/fallback path)

function parseSemver(v: string): number[] {
  return v.split(/[.\-+]/).map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}
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

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string | null }
  | { phase: 'downloading'; version: string | null; percent: number }
  | { phase: 'downloaded'; version: string | null }
  | { phase: 'error'; version: string | null; message: string } // v0.9.1 — failed download / install
  | { phase: 'server-ahead'; version: string }; // fallback path (web or legacy electron)

export default function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const [dismissed, setDismissed] = useState<boolean>(false);
  const [installing, setInstalling] = useState<boolean>(false);

  const localVersion =
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

  const ace = window.ace;
  const isElectron = !!ace?.isElectron;
  const hasAutoUpdater =
    isElectron &&
    typeof ace?.onUpdateAvailable === 'function' &&
    typeof ace?.onUpdateDownloaded === 'function' &&
    typeof ace?.installUpdate === 'function';

  // Path A — silent auto-update events from the Electron main process.
  useEffect(() => {
    if (!hasAutoUpdater) return;
    const unsubAvail = ace!.onUpdateAvailable!((info) => {
      setState({ phase: 'available', version: info.version });
    });
    const unsubProg = ace!.onUpdateProgress?.((info) => {
      setState((prev) => {
        const version = ('version' in prev) ? prev.version ?? null : null;
        return { phase: 'downloading', version, percent: info.percent };
      });
    });
    const unsubDone = ace!.onUpdateDownloaded!((info) => {
      setState({ phase: 'downloaded', version: info.version });
    });
    // v0.9.1 — also subscribe to errors. Without this, a failed download
    // (or, on Windows, an installer rejected for being unsigned) left the
    // banner stuck at "Downloading 100%" with no indication anything went
    // wrong. We carry forward whatever version we previously knew about
    // so the message still tells the user WHICH update failed.
    const unsubErr = ace!.onUpdateError?.((info) => {
      setState((prev) => {
        const version = ('version' in prev) ? prev.version ?? null : null;
        return { phase: 'error', version, message: info.message };
      });
    });

    // v0.8.8 — Rehydrate from the main process's state-mirror on mount.
    // electron-updater fires 'update-downloaded' exactly once. If this
    // component remounted (router change, dev hot-reload, React strict-
    // mode double-mount, etc.) between the download start and finish,
    // the event was lost forever and the banner stayed stuck at
    // "Downloading 100%". Querying the mirror on mount guarantees we
    // surface "Restart to install" no matter when we appeared.
    //
    // v0.9.1 — also rehydrate the 'error' phase. Previously we bailed
    // out when the mirror said 'error', which meant a download that
    // failed BEFORE the banner mounted was invisible forever.
    if (typeof ace!.getUpdateState === 'function') {
      void ace!.getUpdateState().then((s) => {
        if (!s || s.phase === 'idle' || s.phase === 'checking') return;
        if (s.phase === 'downloaded') {
          setState({ phase: 'downloaded', version: s.version ?? null });
        } else if (s.phase === 'downloading') {
          setState({ phase: 'downloading', version: s.version ?? null, percent: s.percent ?? 0 });
        } else if (s.phase === 'available') {
          setState({ phase: 'available', version: s.version ?? null });
        } else if (s.phase === 'error') {
          setState({ phase: 'error', version: s.version ?? null, message: s.message ?? 'Update failed' });
        }
      }).catch(() => { /* main process not ready yet — events will catch up */ });
    }

    return () => {
      unsubAvail?.();
      unsubProg?.();
      unsubDone?.();
      unsubErr?.();
    };
  }, [hasAutoUpdater, ace]);

  // Path B — fallback poll of API version (web browser, or old Electron
  // installs that don't have the auto-updater bridge yet).
  useEffect(() => {
    if (hasAutoUpdater) return;
    let cancelled = false;
    async function check() {
      const v = await getApiVersion();
      if (cancelled || !v) return;
      if (compareSemver(v, localVersion) > 0) {
        setState({ phase: 'server-ahead', version: v });
      }
    }
    void check();
    const id = window.setInterval(check, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [hasAutoUpdater, localVersion]);

  // Reset dismissal when the candidate version changes — a new release
  // surfaces fresh even if the previous one was dismissed.
  useEffect(() => {
    const v =
      state.phase === 'idle' ? null
      : state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded' ? state.version
      : state.version;
    if (!v) return;
    const key = DISMISS_KEY_PREFIX + v;
    setDismissed(sessionStorage.getItem(key) === '1');
  }, [state]);

  if (state.phase === 'idle') return null;
  if (dismissed) return null;

  function handleInstallNow() {
    if (!ace?.installUpdate) return;
    setInstalling(true);
    // Fire-and-forget — main quits the app and runs the installer; React
    // never gets a chance to re-render so we just show the "installing" UI
    // until the OS swaps us out.
    void ace.installUpdate().catch(() => setInstalling(false));
  }

  // Open the platform-specific installer directly instead of dumping the
  // user on the GitHub Releases page (which lists .exe, .dmg, .blockmap,
  // .yml, source tarballs, etc. — confusing). We hit the GitHub API at
  // click time, pick the right asset for the current OS, and open its
  // direct download URL. Falls back to the releases page if the API call
  // fails or no platform-matching asset is found.
  async function handleOpenReleases() {
    const ua = navigator.userAgent.toLowerCase();
    // crude but reliable: Windows asks for the .exe, everything else
    // (Mac and the rare Linux user) gets the .dmg / .AppImage / .deb.
    const wantExt = ua.includes('windows') || ua.includes('win64')
      ? '.exe'
      : ua.includes('mac') || ua.includes('darwin')
        ? '.dmg'
        : null;
    let directUrl: string | null = null;
    if (wantExt) {
      try {
        const apiUrl = 'https://api.github.com/repos/abdaptask/AptLink/releases/latest';
        const res = await fetch(apiUrl, { headers: { Accept: 'application/vnd.github+json' } });
        if (res.ok) {
          const data: { assets?: Array<{ name?: string; browser_download_url?: string }> } = await res.json();
          // Filter out blockmap / latest.yml / source archives — match
          // only the installer file the user actually wants. Take the
          // first hit whose name ends in the extension AND doesn't
          // contain 'blockmap'.
          const asset = data.assets?.find(
            (a) =>
              typeof a.name === 'string' &&
              a.name.toLowerCase().endsWith(wantExt) &&
              !a.name.toLowerCase().includes('blockmap'),
          );
          if (asset?.browser_download_url) directUrl = asset.browser_download_url;
        }
      } catch {
        /* network/API error — fall back to the releases page */
      }
    }
    const target = directUrl ?? RELEASES_URL;
    if (isElectron && ace?.openExternal) {
      void ace.openExternal(target);
    } else {
      window.open(target, '_blank', 'noopener,noreferrer');
    }
  }

  function handleRefresh() {
    window.location.reload();
  }

  async function handleRetry() {
    if (!ace?.checkForUpdates) return;
    // Reset the banner so the user sees fresh feedback. The main process
    // will fire 'update-available' → 'download-progress' → 'downloaded'
    // (or another 'error') as usual, and our subscribers will update state.
    setState({ phase: 'idle' });
    try {
      await ace.checkForUpdates();
    } catch {
      /* main returns an error object instead of throwing; the auto-updater
         'error' event (if any) will fire separately and re-populate state. */
    }
  }

  function handleDismiss() {
    const v =
      state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded' ? state.version
      : state.phase === 'server-ahead' ? state.version
      : state.phase === 'error' ? state.version
      : null;
    if (v) {
      sessionStorage.setItem(DISMISS_KEY_PREFIX + v, '1');
    }
    // For errors with no known version we still dismiss in-memory for the
    // session; the banner reappears on next launch / next failure.
    setDismissed(true);
  }

  // ------- Render -------
  const candidate =
    state.phase === 'server-ahead' ? state.version
    : (state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded' || state.phase === 'error') ? (state.version ?? '')
    : '';

  let title = 'Update available';
  let actions: React.ReactNode = null;

  if (state.phase === 'available') {
    title = 'Update available — downloading…';
    actions = (
      <span className="update-banner-versions">
        v{localVersion} → v{candidate || '?'}
      </span>
    );
  } else if (state.phase === 'downloading') {
    title = `Downloading update — ${Math.round(state.percent)}%`;
    actions = (
      <span className="update-banner-versions">
        v{localVersion} → v{candidate || '?'}
      </span>
    );
  } else if (state.phase === 'downloaded') {
    title = 'Update ready';
    actions = (
      <>
        <span className="update-banner-versions">
          v{localVersion} → v{candidate || '?'}
        </span>
        <button
          type="button"
          className="update-banner-cta"
          onClick={handleInstallNow}
          disabled={installing}
          title="Restart the app to install"
        >
          <Download size={14} />
          {installing ? 'Restarting…' : 'Restart to install'}
        </button>
      </>
    );
  } else if (state.phase === 'error') {
    // v0.9.1 — the previously-silent failure path. We tell the user the
    // auto-update couldn't finish, show the underlying message, and offer
    // a manual fallback (download the installer from GitHub Releases)
    // plus a Retry that re-kicks the electron-updater check.
    title = candidate
      ? `Update to v${candidate} failed`
      : 'Update failed';
    actions = (
      <>
        <span className="update-banner-versions" title={state.message}>
          {state.message.length > 80 ? state.message.slice(0, 77) + '…' : state.message}
        </span>
        <button
          type="button"
          className="update-banner-cta"
          onClick={handleOpenReleases}
          title={`Open ${RELEASES_URL}`}
        >
          <Download size={14} />
          Download installer
        </button>
        {ace?.checkForUpdates ? (
          <button
            type="button"
            className="update-banner-cta-secondary"
            onClick={() => void handleRetry()}
            title="Try the auto-update again"
          >
            <RefreshCcw size={14} />
            Retry
          </button>
        ) : null}
      </>
    );
  } else if (state.phase === 'server-ahead') {
    title = 'Update available';
    actions = (
      <>
        <span className="update-banner-versions">
          v{localVersion} → v{candidate}
        </span>
        {isElectron ? (
          <button
            type="button"
            className="update-banner-cta"
            onClick={handleOpenReleases}
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
              onClick={handleOpenReleases}
              title={`Open ${RELEASES_URL}`}
            >
              Desktop installers
            </button>
          </>
        )}
      </>
    );
  }

  return (
    <div
      className={state.phase === 'error' ? 'update-banner update-banner--error' : 'update-banner'}
      role={state.phase === 'error' ? 'alert' : 'status'}
      aria-live={state.phase === 'error' ? 'assertive' : 'polite'}
    >
      <span className="update-banner-icon" aria-hidden="true">
        {state.phase === 'error' ? <AlertTriangle size={16} /> : <Download size={16} />}
      </span>
      <span className="update-banner-text">
        <strong>{title}</strong>
      </span>
      <div className="update-banner-actions">
        {actions}
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
