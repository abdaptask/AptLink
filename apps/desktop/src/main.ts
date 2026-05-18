// Electron main process — owns the application lifecycle, creates the window,
// and (Phase 5.2) handles the floating-ringer popup for inbound calls.
import { app, BrowserWindow, shell, Menu, ipcMain, screen } from 'electron';
import * as path from 'node:path';

let mainWindow: BrowserWindow | null = null;
let ringerWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ACE Dialer',
    backgroundColor: '#000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const session = mainWindow.webContents.session;
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  session.setPermissionCheckHandler(() => true);

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

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
