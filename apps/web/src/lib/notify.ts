// Browser desktop notifications. Wraps the Notification API with sensible
// defaults: respects the user's notification preferences (Settings →
// Notifications), only fires when the tab is hidden (so we don't double-up
// with the in-app banner), focuses the window on click.

import { getNotificationPrefs } from './userPrefs';

let permissionPromise: Promise<NotificationPermission> | null = null;

/** Request the OS notification permission, lazily. Safe to call repeatedly. */
export function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return Promise.resolve('denied');
  }
  if (Notification.permission === 'granted') return Promise.resolve('granted');
  if (Notification.permission === 'denied')  return Promise.resolve('denied');
  if (permissionPromise) return permissionPromise;
  permissionPromise = Notification.requestPermission()
    .then((p) => { permissionPromise = null; return p; })
    .catch(() => { permissionPromise = null; return 'denied'as NotificationPermission; });
  return permissionPromise;
}

export interface NotifyOptions {
  /** Notification title (shown bold). */
  title: string;
  /** Body text. */
  body?: string;
  /** Stable tag — re-using a tag replaces the previous notification rather than stacking. */
  tag?: string;
  /** Show even if window is focused. Default: false (only fires when tab is hidden). */
  alwaysShow?: boolean;
  /** Optional click handler — receives the Notification event. Default: focus this window. */
  onClick?: () => void;
  /** Skip the preference gate. Default false (respect user pref). */
  bypassPref?: boolean;
  /** Which preference to consult. Default 'desktopNotification'. */
  prefKey?: 'desktopNotification' | 'smsNotification';
  /** Icon URL — defaults to favicon. */
  icon?: string;
}

/** Fire a notification if all the gates pass. Returns true if it was shown. */
export async function notify(opts: NotifyOptions): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return false;

  const prefs = getNotificationPrefs();
  if (!opts.bypassPref) {
    const key = opts.prefKey ?? 'desktopNotification';
    if (key === 'desktopNotification' && !prefs.desktopNotification) return false;
    if (key === 'smsNotification' && !prefs.smsNotification) return false;
  }

  // Only show when the tab is hidden, unless overridden. This avoids
  // double-notifying when the user is clearly already looking at the app.
  if (!opts.alwaysShow && document.visibilityState === 'visible') return false;

  const permission = await ensureNotificationPermission();
  if (permission !== 'granted') return false;

  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: opts.icon ?? '/favicon.ico',
      silent: false,
    });
    n.onclick = () => {
      window.focus();
      n.close();
      if (opts.onClick) {
        try { opts.onClick(); } catch (e) { console.warn('[notify] onClick threw', e); }
      }
    };
    return true;
  } catch (e) {
    console.warn('[notify] failed', e);
    return false;
  }
}
