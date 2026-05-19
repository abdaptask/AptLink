// Centralised access to user-editable preferences persisted in localStorage.
// Settings page is the single editor; other features (Messages compose row,
// IncomingCall, ringtone, etc.) read from here so behaviour stays consistent.

// ---------- Quick replies (SMS templates) ----------
const QUICK_REPLIES_KEY = 'ace_quick_replies';

export const DEFAULT_QUICK_REPLIES: string[] = [
  "I'll call you back shortly.",
  "On my way.",
  "Can't talk right now — text me.",
  "In a meeting, will follow up.",
  "Got your message, thanks!",
];

export function getQuickReplies(): string[] {
  try {
    const raw = localStorage.getItem(QUICK_REPLIES_KEY);
    if (raw === null) return DEFAULT_QUICK_REPLIES;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_QUICK_REPLIES;
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  } catch {
    return DEFAULT_QUICK_REPLIES;
  }
}

export function setQuickReplies(replies: string[]): void {
  const cleaned = replies.map((r) => r.trim()).filter((r) => r.length > 0);
  localStorage.setItem(QUICK_REPLIES_KEY, JSON.stringify(cleaned));
  // Notify any open listeners (Messages compose row, etc.) so they refresh.
  window.dispatchEvent(new CustomEvent('ace:quickRepliesChanged'));
}

export function resetQuickReplies(): void {
  localStorage.removeItem(QUICK_REPLIES_KEY);
  window.dispatchEvent(new CustomEvent('ace:quickRepliesChanged'));
}

// ---------- Notification preferences ----------
export interface NotificationPrefs {
  /** Show an in-app toast for incoming calls. */
  inAppToast: boolean;
  /** Play the synth ringtone on incoming calls. */
  ringtone: boolean;
  /** Volume of the ringtone, 0-1. */
  ringtoneVolume: number;
  /** Pop a desktop OS notification when the window is hidden. */
  desktopNotification: boolean;
  /** Show toast/sound for new inbound SMS. */
  smsNotification: boolean;
}

const NOTIF_KEY = 'ace_notification_prefs';

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  inAppToast: true,
  ringtone: true,
  ringtoneVolume: 0.7,
  desktopNotification: true,
  smsNotification: true,
};

export function getNotificationPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(NOTIF_KEY);
    if (!raw) return DEFAULT_NOTIFICATION_PREFS;
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return { ...DEFAULT_NOTIFICATION_PREFS, ...parsed };
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

export function setNotificationPrefs(prefs: Partial<NotificationPrefs>): NotificationPrefs {
  const next = { ...getNotificationPrefs(), ...prefs };
  localStorage.setItem(NOTIF_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('ace:notificationPrefsChanged'));
  return next;
}
