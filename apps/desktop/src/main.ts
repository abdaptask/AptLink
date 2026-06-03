// Electron main process — owns the application lifecycle, creates the window,
// handles the floating-ringer popup for inbound calls, and (Phase 6.4) hides
// the window to the system tray on close so active calls keep running.
import { app, BrowserWindow, shell, Menu, ipcMain, screen, Tray, nativeImage, powerMonitor } from 'electron';
import * as path from 'node:path';
// electron-updater handles the entire silent-update lifecycle: poll GitHub
// Releases, download the new installer in the background, and offer to restart.
// Mac auto-update REQUIRES the app be signed + notarized (we have both). On
// Windows it works regardless of signing. Configured via the `publish` block
// in package.json which points at our GH repo.
import { autoUpdater } from 'electron-updater';

let mainWindow: BrowserWindow | null = null;
let ringerWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/**
 * When true, the close-button handler bypasses the hide-to-tray behavior
 * and actually lets the window destroy itself. We flip this to true from
 * the Tray "Quit" menu item and from the app menu's Quit role so users
 * have an explicit way to exit. Without this guard, app.quit() would just
 * trigger another close-event that we'd intercept and hide.
 */
let isQuittingForReal = false;
// ────────────────────────────────────────────────────────────────────────
// Microsoft SSO deep-link handling (Phase 7).
//
// We register ace-dialer:// as a custom URL scheme so when Microsoft
// redirects the user's browser to ace-dialer://auth/callback?code=... the
// OS launches (or focuses) our app and we can deliver the auth code to
// the renderer for exchange.
//
// macOS uses the 'open-url' event. Windows/Linux pass the URL as a
// second-instance argv string, which we capture via 'second-instance'.
// ────────────────────────────────────────────────────────────────────────

/** Pulled out of argv on cold-start when Windows launches the app FROM the
 *  protocol URL. Held until mainWindow finishes loading so we can deliver
 *  it once the renderer is ready to receive. */
let pendingSsoUrl: string | null = null;

/** v0.10.4 — Same pattern for deep links (call / sms from Teams cards).
 *  When the OS launches us cold from `ace-dialer://call?to=...`, we
 *  buffer the action here until the renderer signals it's ready via
 *  'ace:deep-link-ready'. */
interface PendingDeepLink {
  action: 'call' | 'sms';
  to: string;
}
let pendingDeepLink: PendingDeepLink | null = null;

/** Find an ace-dialer:// URL in an argv array. Windows passes it as the
 *  last positional argument when the OS launches us from a protocol click. */
function findProtocolUrl(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('ace-dialer://')) return arg;
  }
  return null;
}

/** Deliver the SSO callback URL to the main window's renderer. If the
 *  window doesn't exist yet (cold start), buffer in `pendingSsoUrl` and
 *  flush after the renderer signals it's ready via 'ace:sso-ready'. */
function handleSsoCallback(url: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('ace:sso-callback', url);
    pendingSsoUrl = null;
  } else {
    pendingSsoUrl = url;
  }
}

/** v0.10.4 Task 10 — Deliver a deep-link action to the renderer. Mirrors
 *  handleSsoCallback's pattern. Used for ace-dialer://call?to=...
 *  and ace-dialer://sms?to=... events triggered from Teams card
 *  buttons (via the /auto/call and /auto/sms web pages). */
function handleDeepLink(action: 'call' | 'sms', to: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('ace:deep-link', { action, to });
    pendingDeepLink = null;
  } else {
    pendingDeepLink = { action, to };
  }
}

/** v0.10.4 Task 10 — Route a protocol URL by its path / host segment.
 *  ace-dialer://auth/callback?code=...   → SSO callback (existing)
 *  ace-dialer://call?to=+1...            → focus dialer + prefill (NEW)
 *  ace-dialer://sms?to=+1...             → focus composer + prefill (NEW)
 *  Anything else → no-op (log only).
 *
 *  URL parser quirk: for ace-dialer://call?to=..., the WHATWG URL
 *  parser treats "call" as the HOST. For ace-dialer://auth/callback
 *  it treats "auth" as the host and "/callback" as the path. So our
 *  router checks hostname first, falling through to a substring
 *  match for the SSO case (defensive against parsing differences). */
function routeProtocolUrl(url: string) {
  try {
    // SSO callback uses a sub-path so URL parsing puts "auth" in
    // hostname; we explicitly match the substring for robustness
    // across platforms (Windows vs macOS sometimes hand us slightly
    // different normalized strings).
    if (url.includes('auth/callback')) {
      handleSsoCallback(url);
      return;
    }
    const parsed = new URL(url);
    const action = parsed.hostname;
    if (action === 'call' || action === 'sms') {
      const to = parsed.searchParams.get('to') ?? '';
      if (!to) {
        console.warn('[deep-link] missing ?to= param', url);
        return;
      }
      handleDeepLink(action, to);
      return;
    }
    console.warn('[deep-link] unrecognised action', { url, host: action });
  } catch (e) {
    console.warn('[deep-link] failed to parse', url, e instanceof Error ? e.message : e);
  }
}



function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // v0.10.73 — Bumped minWidth/minHeight to ensure the dialpad fits at
    // common Windows DPI scalings. At 125% scaling (very common on
    // 1920×1080 laptops), the previous minHeight=600 gave CSS only ~480px
    // of vertical space — not enough for the full keypad. The top row
    // (1-2-3 + number input) was clipping off the visible area in
    // Roshni's case. New values give ~640 CSS pixels at 125% which fits
    // the keypad comfortably; the new in-app overflow:auto on .dialpad
    // is the belt-and-suspenders fallback when the user still drags the
    // window smaller than this.
    minWidth: 900,
    minHeight: 800,
    title: 'ACE Dialer',
    backgroundColor: '#000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // CRITICAL: don't throttle the page when the window is hidden.
      // When the user X's out, the window is hidden (not destroyed) so
      // any active call keeps running. With background throttling on
      // (the default), setInterval/setTimeout get clamped to 1Hz and
      // the JsSIP register-refresh timer misses its 60s window — Telnyx
      // drops the registration and the next inbound call goes to
      // voicemail. Off = the renderer stays as responsive when hidden
      // as when visible.
      backgroundThrottling: false,
    },
  });

  const session = mainWindow.webContents.session;
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  session.setPermissionCheckHandler(() => true);

  // v0.10.33 — Spell checker + right-click suggestion menu.
  //
  // Electron has a built-in Chromium spellchecker that shows the red
  // squiggles on typos in any <textarea> or contentEditable. BUT the
  // default Electron right-click menu does NOT include suggestions —
  // you get the browser's HTML context menu (Copy/Paste/etc) with no
  // dictionary suggestions. To get the "spelled wrong, here are 3
  // alternatives" Outlook-like UX, we have to listen for the context-
  // menu event and build a Menu ourselves using params.dictionary-
  // Suggestions.
  try {
    session.setSpellCheckerEnabled(true);
    // Locale auto-detects from system but force en-US as a sane fallback.
    session.setSpellCheckerLanguages(['en-US']);
  } catch (e) {
    console.warn('[spellcheck] setup failed', e);
  }

  mainWindow.webContents.on('context-menu', (_event, params) => {
    // Only show our menu when the right-click is on editable content
    // OR there are spelling suggestions to offer. Otherwise let Chromium
    // handle non-editable right-click normally (copy link, etc).
    if (!params.isEditable && params.dictionarySuggestions.length === 0) return;

    const template: Electron.MenuItemConstructorOptions[] = [];

    // Spelling suggestions at the top — clicking one replaces the
    // misspelled word in place via webContents.replaceMisspelling.
    if (params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions) {
        template.push({
          label: suggestion,
          click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
        });
      }
      template.push({ type: 'separator' });
    }

    // "Add to dictionary" — Electron persists this per-user in their
    // local spellchecker dictionary so subsequent typings of this word
    // don't get squiggled.
    if (params.misspelledWord) {
      template.push({
        label: `Add "${params.misspelledWord}" to dictionary`,
        click: () =>
          session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      template.push({ type: 'separator' });
    }

    // Standard editor actions.
    template.push(
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    );

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow ?? undefined });
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    if (process.env.ACE_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    const indexPath = path.join(process.resourcesPath, 'web', 'index.html');
    mainWindow.loadFile(indexPath);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Phase 6.4 — hide-to-tray on close.
  // Without this, clicking the window X on Windows quits the whole app
  // (and any active call audio dies with it). With this, the window
  // hides and the renderer keeps running — the user can keep talking,
  // and the tray icon (created on app ready) lets them bring the window
  // back. The `isQuittingForReal` guard lets the tray Quit menu item
  // and the OS-level shutdown actually exit.
  mainWindow.on('close', (event) => {
    if (isQuittingForReal) return;
    event.preventDefault();
    mainWindow?.hide();
    // First-time UX hint — a balloon popup on Windows so users discover
    // that the app is still running in the tray instead of assuming it
    // closed. macOS hides apps to the menu bar natively, no balloon needed.
    if (process.platform === 'win32' && tray && !tray.isDestroyed()) {
      try {
        tray.displayBalloon({
          title: 'ACE Dialer is still running',
          content: 'Calls keep working in the background. Right-click the tray icon to quit.',
        });
      } catch { /* noop */ }
    }
  });
}

// ---------- System tray ----------
function createTray(): void {
  if (tray) return;
  // 16x16 PNG looks crisp on Windows tray and macOS menu bar at @1x; on
  // HiDPI displays Electron asks for the @2x image automatically (which
  // we don't ship — Electron upscales the 16x16). Bundled at build time
  // via the extraResources in package.json.
  const iconCandidates = [
    path.join(process.resourcesPath, 'assets', 'tray-icon-16.png'),
    path.join(__dirname, '..', 'assets', 'tray-icon-16.png'),
    path.join(__dirname, '..', '..', 'assets', 'tray-icon-16.png'),
  ];
  let img = nativeImage.createEmpty();
  for (const candidate of iconCandidates) {
    const loaded = nativeImage.createFromPath(candidate);
    if (!loaded.isEmpty()) {
      img = loaded;
      break;
    }
  }
  // On macOS, marking as a template image makes the icon adapt to the
  // menu bar's light/dark mode automatically.
  if (process.platform === 'darwin') {
    try { img.setTemplateImage(true); } catch { /* noop */ }
  }
  try {
    tray = new Tray(img);
  } catch (e) {
    console.warn('[tray] failed to create tray icon', e);
    return;
  }
  tray.setToolTip('ACE Dialer');

  const showWindow = () => {
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open ACE Dialer', click: showWindow },
    { type: 'separator' },
    {
      label: 'Quit (end any active call)',
      click: () => {
        isQuittingForReal = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  // Single-click on the tray icon restores the window — the most
  // discoverable shortcut. Right-click still opens the context menu.
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// ---------- Floating ringer window ----------
function createRingerWindow(callerNumber?: string): void {
  if (ringerWindow && !ringerWindow.isDestroyed()) {
    try {
      ringerWindow.show();
      ringerWindow.focus();
    } catch { /* noop */ }
    return;
  }

  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const w = 440;
  const h = 240;
  const x = wa.x + wa.width - w - 24;
  const y = wa.y + wa.height - h - 24;

  ringerWindow = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    backgroundColor: '#0a3a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  try { ringerWindow.setAlwaysOnTop(true, 'screen-saver'); } catch { /* noop */ }

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Incoming Call</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: linear-gradient(180deg, #0a3a2e 0%, #0a1f1a 100%);
    color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
    Roboto, sans-serif; user-select: none; -webkit-app-region: drag; }
  .wrap { padding: 20px 24px; display: flex; flex-direction: column;
    justify-content: space-between; height: 100%; box-sizing: border-box; }
  .tag { font-size: 12px; opacity: .7; letter-spacing: .08em;
    text-transform: uppercase; }
  .caller { font-size: 28px; font-weight: 700; margin-top: 6px;
    word-break: break-all; }
  .row { display: flex; justify-content: space-around; gap: 16px;
    margin-top: 14px; -webkit-app-region: no-drag; }
  button { width: 72px; height: 72px; border-radius: 50%; border: none;
    color: #fff; cursor: pointer; display: flex; align-items: center;
    justify-content: center; box-shadow: 0 6px 18px rgba(0,0,0,.35);
    transition: transform .1s; }
  button:active { transform: scale(.95); }
  button.accept { background: #22c55e; }
  button.decline { background: #ef4444; }
  button svg { width: 30px; height: 30px; fill: none; stroke: #fff;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
</style></head>
<body>
  <div class="wrap">
    <div>
      <div class="tag">Incoming call</div>
      <div class="caller" id="caller">…</div>
    </div>
    <div class="row">
      <button class="decline" id="decline" title="Decline">
        <svg viewBox="0 0 24 24"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
      </button>
      <button class="accept" id="accept" title="Accept">
        <svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
    </div>
  </div>
  <script>
    (function () {
      document.getElementById('accept').addEventListener('click', function () {
        if (window.ace) window.ace.acceptCall();
      });
      document.getElementById('decline').addEventListener('click', function () {
        if (window.ace) window.ace.declineCall();
      });
      if (window.ace && window.ace.onClose) {
        window.ace.onClose(function () { window.close(); });
      }
    })();
  </script>
</body></html>`;

  function formatNumber(n: string | undefined): string {
    if (!n) return 'Unknown';
    const d = n.replace(/[^\d]/g, '');
    if (d.length === 11 && d.startsWith('1')) {
      return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    }
    if (d.length === 10) {
      return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    }
    return n;
  }

  ringerWindow.loadURL(
    'data:text/html;charset=utf-8;base64,' + Buffer.from(html).toString('base64'),
  );

  ringerWindow.webContents.once('did-finish-load', () => {
    const safe = formatNumber(callerNumber).replace(/'/g, "\\'");
    ringerWindow?.webContents
      .executeJavaScript(`document.getElementById('caller').textContent = '${safe}';`)
      .catch(() => { /* noop */ });
  });

  ringerWindow.once('ready-to-show', () => {
    ringerWindow?.show();
  });

  ringerWindow.on('closed', () => {
    ringerWindow = null;
  });
}

function closeRingerWindow(): void {
  if (ringerWindow && !ringerWindow.isDestroyed()) {
    try {
      ringerWindow.webContents.send('ace:close-ringer');
      ringerWindow.close();
    } catch { /* noop */ }
  }
  ringerWindow = null;
}

// ----- IPC: incoming call from the main window -----
ipcMain.on('ace:incoming-call', (_event, payload: { number?: string; callId?: string }) => {
  const win = mainWindow;
  if (!win) return;

  try {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.setAlwaysOnTop(true);
    win.focus();
    setTimeout(() => {
      try { win.setAlwaysOnTop(false); } catch { /* noop */ }
    }, 2500);
    if (process.platform === 'win32') win.flashFrame(true);
  } catch (e) {
    console.error('[main] surface failed', e);
  }

  createRingerWindow(payload?.number);
});

ipcMain.on('ace:accept', () => {
  try {
    mainWindow?.webContents.send('ace:accept-request');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (e) {
    console.error('[main] accept forward failed', e);
  }
  closeRingerWindow();
});

ipcMain.on('ace:decline', () => {
  try {
    mainWindow?.webContents.send('ace:decline-request');
  } catch (e) {
    console.error('[main] decline forward failed', e);
  }
  closeRingerWindow();
});

ipcMain.on('ace:call-ended', () => {
  closeRingerWindow();
  try {
    if (mainWindow && process.platform === 'win32') mainWindow.flashFrame(false);
  } catch { /* noop */ }
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'services' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }] as Electron.MenuItemConstructorOptions[])
      : []),
    { label: 'File', submenu: [isMac ? { role: 'close' as const } : { role: 'quit' as const }] },
    { label: 'Edit', submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ] },
    { label: 'View', submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Register ace-dialer:// as the default app for that protocol on the OS.
// Without this, Windows shows a "no app to open this link" dialog when
// Microsoft redirects. On Mac, this gets recorded in Info.plist by
// electron-builder, but we register at runtime too as a safety net for
// dev mode where the .plist isn't installed.
if (process.defaultApp) {
  // We're running under `electron .` in dev — pass argv[1] (the script
  // path) to setAsDefaultProtocolClient so Windows knows what to launch.
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('ace-dialer', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('ace-dialer');
}

// Single-instance lock — if the OS tries to launch us a second time (which
// happens when the protocol fires while we're already running), the
// 'second-instance' event fires on the existing instance instead. We pull
// the protocol URL from that event's argv and forward to the main window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = findProtocolUrl(argv);
    if (url) routeProtocolUrl(url);
    // Always surface the main window when launched-again
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// macOS routes protocol launches through 'open-url' instead of argv.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('ace-dialer://')) routeProtocolUrl(url);
});

// Cold-start: Windows passes the protocol URL in our own argv when the
// OS launches us from a clean state. Capture it now and hand it off as
// soon as the renderer signals it's ready.
{
  const url = findProtocolUrl(process.argv);
  if (url) {
    // Route directly — if it's SSO it'll set pendingSsoUrl; if it's a
    // deep link it'll set pendingDeepLink. The renderer flushes whichever
    // is present when it signals ready.
    routeProtocolUrl(url);
  }
}

// Renderer says "I'm ready to receive SSO callbacks" — flush anything
// we buffered during cold-start.
ipcMain.on('ace:sso-ready', () => {
  if (pendingSsoUrl) handleSsoCallback(pendingSsoUrl);
});

// v0.10.4 Task 10 — Renderer says "I'm ready to receive deep-link
// actions" (call / sms from Teams cards). Flush any buffered cold-start
// deep link. Listening separately from SSO so the renderer can decide
// when it has the UI mounted vs. just the auth flow ready.
ipcMain.on('ace:deep-link-ready', () => {
  if (pendingDeepLink) {
    handleDeepLink(pendingDeepLink.action, pendingDeepLink.to);
  }
});

// ────────────────────────────────────────────────────────────────────────
// v0.10.9 — System power events: keep SIP registered across sleep/wake.
//
// Symptom we're fixing: first call after machine wakes from sleep went
// straight to voicemail. Root cause: while the machine was asleep, the
// SIP register heartbeat (20s setInterval in the renderer) couldn't fire,
// the 600s SIP expiry lapsed, Telnyx evicted the contact, and the
// inbound INVITE had nowhere to deliver → TexML fallthrough to voicemail.
//
// The renderer already has a `visibilitychange` listener that re-registers
// when the window becomes visible, but that event doesn't fire on
// machine wake-from-sleep / screen unlock — those are OS-level events
// only the main process can hook.
//
// Approach: subscribe to powerMonitor 'resume' (sleep → wake) and
// 'unlock-screen' (Windows lock screen unlocked, macOS keychain
// unlocked). Each event sends an IPC `ace:sip-wake` to the renderer,
// which forces an immediate SIP register check + reconnect if needed.
// Idempotent — re-registering an already-registered UA is a no-op on
// Telnyx side, just refreshes the expiry timer.
function sendSipWake(reason: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[power-monitor] ${reason} → ace:sip-wake`);
    mainWindow.webContents.send('ace:sip-wake', { reason });
  }
}
app.whenReady().then(() => {
  // powerMonitor is only available after app.ready
  powerMonitor.on('resume', () => sendSipWake('system resume'));
  powerMonitor.on('unlock-screen', () => sendSipWake('screen unlock'));
  // Some Windows builds also fire 'user-did-become-active' after long
  // idle periods. Harmless extra trigger.
  powerMonitor.on('user-did-become-active', () =>
    sendSipWake('user became active'),
  );
});

// Renderer asks us to open the Microsoft authorize URL in the system
// browser — we do NOT load it inside the Electron window because
// Microsoft blocks embedded webviews for OAuth (and Conditional Access
// policies often require a full browser session for MFA).
ipcMain.handle('ace:open-external', async (_event, url: string) => {
  if (typeof url !== 'string') return false;
  if (!/^https:\/\//i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});


// ────────────────────────────────────────────────────────────────────────
// Silent auto-update (electron-updater)
//
// Flow:
//   1. On app launch + every 60 minutes after, check GH Releases for a
//      higher version than the installed one.
//   2. If found, download the new installer in the background (no UI).
//   3. When the download finishes, send 'ace:update-downloaded' to the
//      renderer so UpdateBanner can show a "Restart to install" button.
//   4. Renderer calls 'ace:install-update' → autoUpdater.quitAndInstall()
//      quits the app, runs the installer, relaunches the new build.
//
// We intentionally DON'T call autoUpdater.checkForUpdatesAndNotify() —
// that uses native OS notifications which most users dismiss and forget.
// Surfacing inside the app gives a much more reliable nudge.
// ────────────────────────────────────────────────────────────────────────
let autoUpdateInitialized = false;

// v0.8.8 — State-mirror for auto-update events. electron-updater emits
// 'update-downloaded' exactly once. If the renderer's UpdateBanner had
// unmounted/remounted (route change, hot reload, React strict-mode mount
// double, etc.) between the download starting and finishing, the event
// was lost forever and the banner stayed stuck at "Downloading 100%".
// We now mirror state here and expose 'ace:get-update-state' so the
// renderer can rehydrate on mount.
type UpdateStateMirror =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string | null }
  | { phase: 'downloading'; version: string | null; percent: number }
  | { phase: 'downloaded'; version: string | null }
  | { phase: 'error'; message: string };
let lastUpdateState: UpdateStateMirror = { phase: 'idle' };

function versionFromMirror(): string | null {
  if (lastUpdateState.phase === 'available' ||
      lastUpdateState.phase === 'downloading' ||
      lastUpdateState.phase === 'downloaded') {
    return lastUpdateState.version;
  }
  return null;
}

function initAutoUpdater() {
  if (autoUpdateInitialized) return;
  autoUpdateInitialized = true;

  // In dev (no DEV_SERVER_URL hint means we're packaged, but extra safety:)
  // electron-updater fails politely when run from an unpackaged dev build,
  // so we don't need to guard against that explicitly.

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // v0.9.4 — TEMPORARY: bypass Windows code-signing verification because
  // we don't have an EV cert yet (see task #194 / #233). Without this,
  // electron-updater refuses to install ANY update on Windows since
  // package.json declares publisherName: "ApTask" but our GitHub Actions
  // workflow doesn't actually sign the EXE — so the publisher-name match
  // check fails and the user sees "Update failed: not signed by the
  // application owner". MITM risk is low since downloads come from GitHub
  // Releases over HTTPS; remove this override once we wire the EV cert in.
  if (process.platform === 'win32') {
    // The property is undocumented but recognised by NsisUpdater; making
    // it a no-op resolver tells electron-updater to skip the signature
    // verification step entirely.
    (autoUpdater as unknown as {
      verifyUpdateCodeSignature?: (publisherNames: string[], file: string) => Promise<string | null>;
    }).verifyUpdateCodeSignature = async () => null;
  }

  autoUpdater.on('checking-for-update', () => {
    console.log('[auto-update] checking for update');
    lastUpdateState = { phase: 'checking' };
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[auto-update] update available', info?.version);
    lastUpdateState = { phase: 'available', version: info?.version ?? null };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ace:update-available', { version: info?.version ?? null });
    }
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[auto-update] up to date');
    lastUpdateState = { phase: 'idle' };
  });
  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress?.percent ?? 0);
    lastUpdateState = { phase: 'downloading', version: versionFromMirror(), percent: pct };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ace:update-progress', { percent: pct });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[auto-update] update downloaded', info?.version);
    lastUpdateState = { phase: 'downloaded', version: info?.version ?? null };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ace:update-downloaded', { version: info?.version ?? null });
    }
  });
  autoUpdater.on('error', (err) => {
    const message = err?.message ?? String(err);
    console.warn('[auto-update] error', message);
    lastUpdateState = { phase: 'error', message };
    // v0.9.1 — also forward to the renderer so UpdateBanner can surface
    // the failure. Previously we only updated the mirror, so the banner
    // sat silently on "Downloading 100%" forever when (e.g.) the Windows
    // installer was rejected because it isn't code-signed yet, or when
    // GitHub returned a 403 mid-download.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ace:update-error', { message });
    }
  });

  // First check shortly after launch (give the renderer a moment to mount
  // the UpdateBanner subscription), then poll hourly.
  setTimeout(() => { void autoUpdater.checkForUpdates().catch(() => {}); }, 15_000);
  setInterval(() => { void autoUpdater.checkForUpdates().catch(() => {}); }, 60 * 60 * 1000);
}

// v0.8.8 — IPC handler: renderer queries this on UpdateBanner mount to
// rehydrate state and avoid missing the one-shot 'update-downloaded'
// event. Closes the "stuck at 100%" gap.
ipcMain.handle('ace:get-update-state', async () => lastUpdateState);

// Renderer asks main to install the downloaded update. quitAndInstall closes
// every window, runs the installer, and relaunches the new build. The
// `isQuittingForReal` flag lets the window-close handler skip its
// hide-to-tray behavior so we actually exit instead of just hiding.
// Manual "Check for updates" — invoked from the user-dropdown menu item.
// Returns a status the renderer can show inline. The actual update events
// (available / downloaded) still flow through the normal autoUpdater event
// handlers, so the existing UpdateBanner machinery still works on top.
ipcMain.handle('ace:check-for-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) {
      return { state: 'no_update', message: 'You are on the latest version.' };
    }
    const remote = result.updateInfo?.version;
    const local = autoUpdater.currentVersion?.version;
    if (remote && local && remote === local) {
      return { state: 'no_update', version: local, message: 'You are on the latest version.' };
    }
    return {
      state: 'update_found',
      version: remote ?? null,
      message: remote ? `v${remote} is downloading…` : 'Update found — downloading…',
    };
  } catch (err) {
    // electron-updater dumps the raw HTTP response on failure, which is
    // ugly + leaks GitHub server internals. Map the common cases to a
    // human-friendly message so users don't see HTML cookies + headers.
    const raw = err instanceof Error ? err.message : String(err);
    let friendly = 'Could not reach the update server. Please try again later.';
    if (/404|not[\s-]?found/i.test(raw)) {
      friendly = "Update server unreachable. The release feed may be private or temporarily down. Try again in a few minutes.";
    } else if (/ENOTFOUND|ETIMEDOUT|network|getaddrinfo/i.test(raw)) {
      friendly = 'No internet connection. Check your network and try again.';
    } else if (/403|forbidden/i.test(raw)) {
      friendly = 'Update server denied the request (auth). Contact your administrator.';
    }
    // Log the full error to main-process console so we can diagnose later
    // if the user pastes their `~/Library/Logs/ACE Dialer/main.log`.
    console.warn('[auto-update] manual check failed:', raw);
    return { state: 'error', message: friendly };
  }
});

ipcMain.handle('ace:install-update', async () => {
  isQuittingForReal = true;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
});

app.whenReady().then(() => {
  buildMenu();
  createTray();
  createWindow();
  // Kick the silent-update lifecycle. Polls GH Releases on a 60-min loop.
  initAutoUpdater();
  app.on('activate', () => {
    // macOS: dock click. If we have no windows, build one — but if the
    // window exists and is hidden (close-to-tray), surface it instead.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

// Phase 6.4 — do NOT quit when the last window closes.
// The tray icon is the canonical "still running" signal; users quit
// explicitly via Tray → Quit, the app menu, or Cmd+Q. This means a
// call in progress survives the user X-ing out the main window.
app.on('window-all-closed', () => {
  // Intentionally empty. Quit only on `app.quit()` from the Tray menu
  // or the OS shutdown signal (which sets isQuittingForReal first).
});

// Flip the guard on real quit signals so the close-handler doesn't
// fight them. Triggered by Cmd+Q on Mac, Alt+F4 → File→Quit, OS shutdown,
// and our Tray Quit menu item.
app.on('before-quit', () => {
  isQuittingForReal = true;
});

// Tear down the tray icon on actual quit so the Windows tray doesn't
// keep a stale icon around.
app.on('quit', () => {
  if (tray && !tray.isDestroyed()) {
    try { tray.destroy(); } catch { /* noop */ }
    tray = null;
  }
});
