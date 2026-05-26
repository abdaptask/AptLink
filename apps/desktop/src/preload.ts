// Preload — bridges Electron main process and renderer in a sandboxed way.
// Anything exposed via contextBridge becomes window.ace.* in the renderer.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aceDesktop', {
  version: process.versions.electron,
  platform: process.platform,
  arch: process.arch,
});

// Phase 5.2: incoming-call bridge.
// - onIncomingCall(): renderer tells main "a call is ringing, surface a popup"
// - acceptCall() / declineCall(): the FLOATING RINGER window calls these when
//   the user clicks Accept or Decline; main forwards to the MAIN window's
//   SipContext (via ace:accept-request / ace:decline-request).
// - onAcceptRequest / onDeclineRequest: the MAIN window subscribes so it can
//   call sipService.acceptCall() / declineCall() when the floating ringer fires.
// - onCallEnded(): main tells the floater (and any listener) to close when the
//   call resolves so the floater goes away.
contextBridge.exposeInMainWorld('ace', {
  isElectron: true,
  appVersion: process.env.npm_package_version,
  onIncomingCall: (number?: string, callId?: string) => {
    ipcRenderer.send('ace:incoming-call', { number, callId });
  },
  acceptCall: () => ipcRenderer.send('ace:accept'),
  declineCall: () => ipcRenderer.send('ace:decline'),
  notifyCallEnded: () => ipcRenderer.send('ace:call-ended'),
  onAcceptRequest: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('ace:accept-request', handler);
    return () => ipcRenderer.removeListener('ace:accept-request', handler);
  },
  onDeclineRequest: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('ace:decline-request', handler);
    return () => ipcRenderer.removeListener('ace:decline-request', handler);
  },
  onClose: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('ace:close-ringer', handler);
    return () => ipcRenderer.removeListener('ace:close-ringer', handler);
  },
  // For the ringer window to read the caller info passed in the URL.
  getQueryParam: (name: string): string | null => {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch {
      return null;
    }
  },
  // ── Microsoft SSO bridge (Phase 7) ──
  // openExternal: ask main to open a https:// URL in the system browser
  // (used for the Microsoft authorize page — Microsoft blocks embedded
  // webviews for OAuth + Conditional Access often requires a real browser).
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('ace:open-external', url),
  // onSsoCallback: renderer subscribes so it gets the ace-dialer://auth/callback
  // URL the OS handed us when Microsoft redirected back. Returns an unsubscribe
  // function for the React useEffect cleanup pattern.
  onSsoCallback: (cb: (url: string) => void) => {
    const handler = (_e: unknown, url: string) => cb(url);
    ipcRenderer.on('ace:sso-callback', handler);
    return () => ipcRenderer.removeListener('ace:sso-callback', handler);
  },
  // notifyReadyForSso: renderer pings main when it's ready to receive
  // cold-start protocol URLs (used to flush a buffered URL from the
  // first launch's argv).
  notifyReadyForSso: () => ipcRenderer.send('ace:sso-ready'),

  // ── Silent auto-update bridge (Phase 7.1) ──
  // Renderer subscribes so UpdateBanner can show a "Restart to install"
  // button once electron-updater has downloaded the new version in the
  // background. Returns an unsubscribe fn for the React useEffect pattern.
  onUpdateAvailable: (cb: (info: { version: string | null }) => void) => {
    const handler = (_e: unknown, info: { version: string | null }) => cb(info);
    ipcRenderer.on('ace:update-available', handler);
    return () => ipcRenderer.removeListener('ace:update-available', handler);
  },
  onUpdateProgress: (cb: (info: { percent: number }) => void) => {
    const handler = (_e: unknown, info: { percent: number }) => cb(info);
    ipcRenderer.on('ace:update-progress', handler);
    return () => ipcRenderer.removeListener('ace:update-progress', handler);
  },
  onUpdateDownloaded: (cb: (info: { version: string | null }) => void) => {
    const handler = (_e: unknown, info: { version: string | null }) => cb(info);
    ipcRenderer.on('ace:update-downloaded', handler);
    return () => ipcRenderer.removeListener('ace:update-downloaded', handler);
  },
  // v0.9.1 — auto-update failure event. Fires for any electron-updater
  // 'error' (download failed, installer rejected by Windows, GitHub 403,
  // etc.). UpdateBanner subscribes so the user actually SEES the failure
  // instead of staring at a stuck "Downloading 100%" forever.
  onUpdateError: (cb: (info: { message: string }) => void) => {
    const handler = (_e: unknown, info: { message: string }) => cb(info);
    ipcRenderer.on('ace:update-error', handler);
    return () => ipcRenderer.removeListener('ace:update-error', handler);
  },
  // v0.8.8 — query the current auto-update state on demand. Closes the
  // "stuck at 100%" gap where the UpdateBanner mounted AFTER electron-
  // updater already fired the one-shot 'update-downloaded' event. The
  // banner now polls this on mount and immediately flips to "Restart to
  // install" if the download has already completed.
  getUpdateState: (): Promise<{
    phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
    version?: string | null;
    percent?: number;
    message?: string;
  }> => ipcRenderer.invoke('ace:get-update-state'),
  // Trigger install-now. Main process quits, runs the installer, and
  // relaunches the new build.
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke('ace:install-update'),
  // Manual check-for-updates from the user-dropdown menu. Returns one of:
  //   { state: 'no_update', message }
  //   { state: 'update_found', version, message }   (download starts in bg)
  //   { state: 'error', message }
  checkForUpdates: (): Promise<{ state: string; version?: string | null; message?: string }> =>
    ipcRenderer.invoke('ace:check-for-updates'),
});
