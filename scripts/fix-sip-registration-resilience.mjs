// Make SIP registration robust against browser throttling / tab switching
// so users don't have to Ctrl+Shift+R to recover.
//
// Three changes to apps/web/src/services/sip.ts:
//   1. Bump register_expires from 60s to 600s (10 min) — bigger buffer
//      against background-tab timer throttling.
//   2. Add a 20-second heartbeat that fires ua.register() unconditionally
//      while the page is visible. Even if Chrome throttles to 1Hz, this
//      hits within a minute of real time. Keeps WebSocket warm + refreshes
//      registration before Telnyx can expire it.
//   3. Visibility handler upgrade: if we come back and the WebSocket is
//      dead (or stuck), tear down the UA and rebuild from scratch instead
//      of just calling register() on a corpse.
//   4. Public reconnect() method that tears down + rebuilds the UA — used
//      by the new "Reconnect" button in the header status indicator.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '..', 'apps', 'web', 'src', 'services', 'sip.ts');
let text = readFileSync(file, 'utf8');
const nl = text.includes('\r\n') ? '\r\n' : '\n';

function count(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

if (text.includes('heartbeatTimer')) {
  console.log('ABORT: heartbeat already present — script already ran.');
  process.exit(1);
}

// --- 1. Bump register_expires to 600 --------------------------------------

const oldRegisterBlock = [
  '      // Re-register every 60 seconds. Browsers throttle background-tab',
  '      // timers heavily after ~5 minutes, so a longer expiry means the',
  '      // refresh can be missed and Telnyx silently drops our registration.',
  '      // 60s is short enough to keep the registration alive across most',
  '      // throttling windows, and inexpensive (a single SIP REGISTER message).',
  '      register: true,',
  '      register_expires: 60,',
].join(nl);

const newRegisterBlock = [
  '      // Phase 6.9 — registration resilience.',
  '      // 600s expiry gives a 10-minute buffer against background-tab timer',
  '      // throttling. We pair this with a 20s active heartbeat (see',
  '      // installRegistrationHeartbeat below) that calls ua.register()',
  '      // unconditionally so Telnyx never sees us as expired.',
  '      register: true,',
  '      register_expires: 600,',
].join(nl);

if (count(text, oldRegisterBlock) !== 1) {
  console.log('ABORT: register_expires block not found exactly once.');
  process.exit(1);
}
text = text.replace(oldRegisterBlock, newRegisterBlock);

// --- 2 + 3. Replace installVisibilityRecovery with stronger handler -------

const oldVisInstall = [
  '    // Recover from background-tab throttling.',
  '    // When the tab becomes visible again, check the SIP UA state and force',
  '    // a re-register if it\'s drifted offline. Without this, the dialer',
  '    // silently fails to receive inbound calls after sitting in a background',
  '    // tab for a few minutes — because the registration timer was throttled',
  '    // and Telnyx dropped the registration server-side.',
  '    this.installVisibilityRecovery();',
  '  }',
  '',
  '  private visibilityHandler: (() => void) | null = null;',
  '  private installVisibilityRecovery(): void {',
  '    // Idempotent — don\'t double-attach if connect() is ever called twice.',
  '    if (this.visibilityHandler) return;',
  '    this.visibilityHandler = () => {',
  "      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;",
  '      if (!this.ua) return;',
  '      try {',
  '        const isRegistered = this.ua.isRegistered?.() ?? false;',
  '        const isConnected = this.ua.isConnected?.() ?? false;',
  "        console.log('[sip] visibility=visible — connected:', isConnected, 'registered:', isRegistered);",
  '        if (!isConnected) {',
  "          // WebSocket got torn down. JsSIP's auto-reconnect should kick in,",
  '          // but we nudge it just in case.',
  "          try { this.ua.start(); } catch (e) { console.warn('[sip] visibility ua.start threw', e); }",
  '        } else if (!isRegistered) {',
  '          // Socket alive, but registration lapsed. Force a new REGISTER.',
  "          try { this.ua.register(); } catch (e) { console.warn('[sip] visibility register threw', e); }",
  '        }',
  '      } catch (e) {',
  "        console.warn('[sip] visibility handler error', e);",
  '      }',
  '    };',
  "    document.addEventListener('visibilitychange', this.visibilityHandler);",
  "    // Also fire on `focus` for good measure — some browsers don't always",
  '    // emit visibilitychange when alt-tabbing to the window.',
  "    window.addEventListener('focus', this.visibilityHandler);",
  '  }',
].join(nl);

const newVisInstall = [
  '    // Recover from background-tab throttling + actively keep registration',
  '    // alive even when the tab is in the foreground. See block below.',
  '    this.installVisibilityRecovery();',
  '    this.installRegistrationHeartbeat();',
  '    this.saveConfigForReconnect(config);',
  '  }',
  '',
  '  /** Saved connect() config, used by reconnect() to rebuild the UA. */',
  '  private lastConfig: SipConfig | null = null;',
  '  private saveConfigForReconnect(config: SipConfig): void {',
  '    this.lastConfig = config;',
  '  }',
  '',
  '  /**',
  '   * Phase 6.9 — Manual reconnect. Tears down the existing UA completely',
  '   * and starts a fresh one with the saved config. Exposed so the React',
  "   * status indicator can show a 'Reconnect' button as a one-tap recovery",
  "   * when the UA gets stuck. The user shouldn't need Ctrl+Shift+R anymore.",
  '   */',
  '  reconnect(): void {',
  "    console.log('[sip] manual reconnect — tearing down UA');",
  '    const cfg = this.lastConfig;',
  '    try { this.ua?.stop(); } catch { /* noop */ }',
  '    this.ua = null;',
  '    if (this.heartbeatTimer) {',
  '      clearInterval(this.heartbeatTimer);',
  '      this.heartbeatTimer = null;',
  '    }',
  '    if (!cfg) {',
  "      console.warn('[sip] reconnect: no saved config — refresh the page');",
  '      return;',
  '    }',
  '    // Tiny delay so JsSIP fully tears down its WebSocket before we',
  '    // start a new one. Without this, the new UA can race with the dying',
  '    // socket and end up in a bad state.',
  '    setTimeout(() => this.connect(cfg), 250);',
  '  }',
  '',
  '  private visibilityHandler: (() => void) | null = null;',
  '  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;',
  '',
  '  /**',
  '   * Phase 6.9 — proactive registration heartbeat. Calls ua.register()',
  '   * every 20s so we refresh well within the 600s expiry, even when the',
  '   * browser is throttling background timers. Cheap (one SIP REGISTER per',
  "   * 20s) and the only reliable way to keep the WebRTC client's presence",
  '   * alive across tab switches.',
  '   */',
  '  private installRegistrationHeartbeat(): void {',
  '    if (this.heartbeatTimer) return;',
  '    this.heartbeatTimer = setInterval(() => {',
  '      if (!this.ua) return;',
  '      try {',
  '        const isConnected = this.ua.isConnected?.() ?? false;',
  '        const isRegistered = this.ua.isRegistered?.() ?? false;',
  '        if (!isConnected) {',
  "          // Socket died — full reconnect needed.",
  "          console.log('[sip] heartbeat: socket dead, triggering reconnect');",
  '          this.reconnect();',
  '          return;',
  '        }',
  '        // Send REGISTER refresh. JsSIP queues it through the same socket.',
  '        // Idempotent — Telnyx accepts repeated registrations from the',
  '        // same Contact and just refreshes the expiry.',
  '        try { this.ua.register(); } catch (e) {',
  "          console.warn('[sip] heartbeat register threw', e);",
  '        }',
  '        if (!isRegistered) {',
  "          console.log('[sip] heartbeat: was unregistered, forcing register');",
  '        }',
  '      } catch (e) {',
  "        console.warn('[sip] heartbeat error', e);",
  '      }',
  '    }, 20_000);',
  '  }',
  '',
  '  private installVisibilityRecovery(): void {',
  "    // Idempotent — don't double-attach if connect() is ever called twice.",
  '    if (this.visibilityHandler) return;',
  '    this.visibilityHandler = () => {',
  "      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;",
  '      if (!this.ua) return;',
  '      try {',
  '        const isRegistered = this.ua.isRegistered?.() ?? false;',
  '        const isConnected = this.ua.isConnected?.() ?? false;',
  "        console.log('[sip] visibility=visible — connected:', isConnected, 'registered:', isRegistered);",
  '        if (!isConnected) {',
  '          // WebSocket died while backgrounded. Full UA rebuild — calling',
  '          // start() on a dead UA often leaves it stuck.',
  '          this.reconnect();',
  '        } else if (!isRegistered) {',
  '          // Socket alive, but registration lapsed. Force a new REGISTER.',
  "          try { this.ua.register(); } catch (e) { console.warn('[sip] visibility register threw', e); }",
  '        }',
  '      } catch (e) {',
  "        console.warn('[sip] visibility handler error', e);",
  '      }',
  '    };',
  "    document.addEventListener('visibilitychange', this.visibilityHandler);",
  "    window.addEventListener('focus', this.visibilityHandler);",
  '  }',
].join(nl);

if (count(text, oldVisInstall) !== 1) {
  console.log(`ABORT: visibility-install block not found exactly once (got ${count(text, oldVisInstall)}).`);
  process.exit(1);
}
text = text.replace(oldVisInstall, newVisInstall);

writeFileSync(file, text, 'utf8');
console.log('Patched apps/web/src/services/sip.ts:');
console.log('  - register_expires bumped 60 -> 600 seconds');
console.log('  - new installRegistrationHeartbeat (every 20s)');
console.log('  - visibility handler now does full UA rebuild on dead socket');
console.log('  - new public reconnect() method for the Reconnect button');
console.log('New line count:', text.split(nl).length);
