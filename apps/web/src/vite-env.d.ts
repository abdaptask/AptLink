/// <reference types="vite/client" />

// Injected by vite.config.ts at build time.
declare const __APP_VERSION__: string;

// Electron preload bridge (apps/desktop/src/preload.ts).
interface AceElectronBridge {
  isElectron: boolean;
  appVersion?: string;
  onIncomingCall: (number?: string, callId?: string) => void;
  acceptCall: () => void;
  declineCall: () => void;
  notifyCallEnded: () => void;
  onAcceptRequest: (cb: () => void) => () => void;
  onDeclineRequest: (cb: () => void) => () => void;
  onClose: (cb: () => void) => () => void;
  getQueryParam: (name: string) => string | null;
  // Phase 7 — Microsoft SSO bridge
  openExternal: (url: string) => Promise<boolean>;
  onSsoCallback: (cb: (url: string) => void) => () => void;
  notifyReadyForSso: () => void;
  // v0.10.4 Task 10 — Deep-link bridge (Teams card buttons)
  onDeepLink?: (
    cb: (data: { action: 'call' | 'sms'; to: string }) => void,
  ) => () => void;
  notifyReadyForDeepLink?: () => void;
  // Phase 7.1 — silent auto-update bridge
  onUpdateAvailable?: (cb: (info: { version: string | null }) => void) => () => void;
  onUpdateProgress?: (cb: (info: { percent: number }) => void) => () => void;
  onUpdateDownloaded?: (cb: (info: { version: string | null }) => void) => () => void;
  // v0.9.1 — surfaced when electron-updater errors out (download failed,
  // installer rejected, GitHub 403, etc.). Optional so older preloads
  // (without the bridge) still type-check.
  onUpdateError?: (cb: (info: { message: string }) => void) => () => void;
  installUpdate?: () => Promise<boolean>;
  checkForUpdates?: () => Promise<{ state: string; version?: string | null; message?: string }>;
  // v0.8.8 — state-mirror query for the auto-update banner to rehydrate
  // on mount and never miss the one-shot 'update-downloaded' event.
  getUpdateState?: () => Promise<{
    phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
    version?: string | null;
    percent?: number;
    message?: string;
  }>;
}
interface Window {
  ace?: AceElectronBridge;
}
