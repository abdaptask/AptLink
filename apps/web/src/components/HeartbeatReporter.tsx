// v0.10.101 - Device heartbeat reporter. Mounts once at the app root.
// Generates a stable deviceId, reports platform + appVersion to
// /me/heartbeat on mount + focus + every 60s. If response signals
// forceUpdate, triggers Electron's autoUpdater.checkForUpdatesAndNotify().

import { useEffect, useRef } from 'react';
import { sendHeartbeat, ackForceUpdate } from '../api';

const DEVICE_ID_KEY = 'ace_device_id';

function getOrCreateDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (id && id.length >= 8) return id;
    id = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function detectPlatform(): string {
  if (typeof window === 'undefined') return 'unknown';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.ace?.isElectron) {
    const p = w.aceDesktop?.platform;
    if (p === 'win32') return 'electron-win';
    if (p === 'darwin') return 'electron-mac';
    if (p === 'linux') return 'electron-linux';
    return 'electron';
  }
  return 'web';
}

function detectOsLabel(): string {
  try {
    return navigator.userAgent.slice(0, 200);
  } catch {
    return '';
  }
}

declare const __APP_VERSION__: string | undefined;

function getAppVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const declared = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
  return (w.ace?.appVersion as string | undefined) || declared || '0.0.0';
}

export default function HeartbeatReporter() {
  const deviceIdRef = useRef<string>(getOrCreateDeviceId());
  const lastForceTriggerRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function beat() {
      if (cancelled) return;
      const token = sessionStorage.getItem('ace_token');
      if (!token) return;
      try {
        const r = await sendHeartbeat(token, {
          deviceId: deviceIdRef.current,
          platform: detectPlatform(),
          appVersion: getAppVersion(),
          osLabel: detectOsLabel(),
        });
        if (r.forceUpdate && r.forceUpdateRequestedAt && r.forceUpdateRequestedAt !== lastForceTriggerRef.current) {
          lastForceTriggerRef.current = r.forceUpdateRequestedAt;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            if (w.ace?.checkForUpdates) {
              console.info('[heartbeat] admin requested force-update - triggering autoUpdater');
              await w.ace.checkForUpdates();
            } else {
              console.info('[heartbeat] admin requested force-update - reloading web app');
              setTimeout(() => window.location.reload(), 500);
            }
          } catch (e) {
            console.warn('[heartbeat] force-update trigger failed', e);
          }
          await ackForceUpdate(token, deviceIdRef.current).catch(() => undefined);
        }
      } catch (e) {
        console.debug('[heartbeat] failed', e);
      }
    }

    const initialTimer = setTimeout(beat, 1000);
    const intervalTimer = setInterval(beat, 60_000);
    const onFocus = () => { void beat(); };
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return null;
}