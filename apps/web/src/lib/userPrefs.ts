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

// ---------- Favorites (starred contacts) ----------
export interface FavoriteContact {
  /** E.164 number (or whatever the user typed). Stored as-is. */
  phone: string;
  /** Optional display label. Computed from firstName+lastName when those are
   *  set; falls back to JobDiva name / formatted phone otherwise. */
  label?: string | null;
  /** Contact first name (entered by the user when adding). */
  firstName?: string | null;
  /** Contact last name (entered by the user when adding). */
  lastName?: string | null;
  /** Timestamp it was starred (used for default sort). */
  addedAt: string;
}
const FAVORITES_KEY = 'ace_favorites';

function normalizeFavoritePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

export function getFavorites(): FavoriteContact[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is FavoriteContact => typeof v?.phone === 'string');
  } catch {
    return [];
  }
}
function saveFavorites(list: FavoriteContact[]): void {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent('ace:favoritesChanged'));
}

export function isFavorite(phone: string): boolean {
  if (!phone) return false;
  const target = normalizeFavoritePhone(phone);
  if (!target) return false;
  return getFavorites().some((f) => normalizeFavoritePhone(f.phone) === target);
}
export interface AddFavoriteOptions {
  /** Optional display label override. If not provided, we build one from
   *  firstName + lastName, or fall back to JobDiva / formatted phone. */
  label?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}
export function addFavorite(phone: string, opts?: AddFavoriteOptions | string | null): void {
  if (!phone) return;
  const target = normalizeFavoritePhone(phone);
  if (!target) return;
  // Back-compat: callers used to pass a plain label string as 2nd arg.
  const options: AddFavoriteOptions =
    typeof opts === 'string' || opts == null
      ? { label: opts ?? null }
      : opts;
  const list = getFavorites();
  if (list.some((f) => normalizeFavoritePhone(f.phone) === target)) return;
  // Synthesize label from name parts if user didn't pass one explicitly.
  const nameJoined = [options.firstName, options.lastName]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(' ');
  list.push({
    phone,
    label: options.label ?? (nameJoined || null),
    firstName: options.firstName ?? null,
    lastName: options.lastName ?? null,
    addedAt: new Date().toISOString(),
  });
  saveFavorites(list);
}
export function removeFavorite(phone: string): void {
  if (!phone) return;
  const target = normalizeFavoritePhone(phone);
  if (!target) return;
  const list = getFavorites().filter((f) => normalizeFavoritePhone(f.phone) !== target);
  saveFavorites(list);
}
export function toggleFavorite(phone: string, label?: string | null): boolean {
  if (isFavorite(phone)) { removeFavorite(phone); return false; }
  addFavorite(phone, label); return true;
}
/** Update first/last name (and derived label) for an existing favorite. */
export function updateFavoriteName(phone: string, firstName: string, lastName: string): void {
  if (!phone) return;
  const target = normalizeFavoritePhone(phone);
  if (!target) return;
  const list = getFavorites();
  const idx = list.findIndex((f) => normalizeFavoritePhone(f.phone) === target);
  if (idx === -1) return;
  const joined = [firstName, lastName].map((p) => p.trim()).filter(Boolean).join(' ');
  list[idx] = {
    ...list[idx],
    firstName: firstName.trim() || null,
    lastName: lastName.trim() || null,
    label: joined || null,
  };
  saveFavorites(list);
}

// ---------- Hold music ----------
// Stored as a data URL (base64) in localStorage. Cap the file size at 2 MB so
// we don't blow past the localStorage quota. For larger files we'd switch to
// IndexedDB but most hold-music loops are short MP3s well under this size.
const HOLD_MUSIC_KEY = 'ace_hold_music_data_url';
const HOLD_MUSIC_NAME_KEY = 'ace_hold_music_filename';
const HOLD_MUSIC_ENABLED_KEY = 'ace_hold_music_enabled';
export const HOLD_MUSIC_MAX_BYTES = 2 * 1024 * 1024;

export function getHoldMusicEnabled(): boolean {
  return localStorage.getItem(HOLD_MUSIC_ENABLED_KEY) === '1';
}
export function setHoldMusicEnabled(enabled: boolean): void {
  if (enabled) localStorage.setItem(HOLD_MUSIC_ENABLED_KEY, '1');
  else localStorage.removeItem(HOLD_MUSIC_ENABLED_KEY);
  window.dispatchEvent(new CustomEvent('ace:holdMusicChanged'));
}
export function getHoldMusicDataUrl(): string | null {
  return localStorage.getItem(HOLD_MUSIC_KEY);
}
export function getHoldMusicFilename(): string | null {
  return localStorage.getItem(HOLD_MUSIC_NAME_KEY);
}
export function setHoldMusicDataUrl(dataUrl: string, filename: string): void {
  localStorage.setItem(HOLD_MUSIC_KEY, dataUrl);
  localStorage.setItem(HOLD_MUSIC_NAME_KEY, filename);
  window.dispatchEvent(new CustomEvent('ace:holdMusicChanged'));
}
export function clearHoldMusic(): void {
  localStorage.removeItem(HOLD_MUSIC_KEY);
  localStorage.removeItem(HOLD_MUSIC_NAME_KEY);
  window.dispatchEvent(new CustomEvent('ace:holdMusicChanged'));
}

// ---------- Theme preference ----------
export type ThemePref = 'system' | 'light' | 'dark';
const THEME_KEY = 'ace_theme';

export function getTheme(): ThemePref {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function setTheme(theme: ThemePref): void {
  if (theme === 'system') localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, theme);
  applyTheme();
  window.dispatchEvent(new CustomEvent('ace:themeChanged'));
}

/** Resolve 'system' to the actual dark/light value the OS reports right now. */
export function resolvedTheme(): 'light' | 'dark' {
  const pref = getTheme();
  if (pref !== 'system') return pref;
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Apply the current theme to <html data-theme>. Idempotent — safe to call often. */
export function applyTheme(): void {
  if (typeof document === 'undefined') return;
  const value = resolvedTheme();
  document.documentElement.setAttribute('data-theme', value);
}

let systemListenerAttached = false;
/** Re-apply theme whenever the OS theme changes (only relevant when pref is 'system'). */
export function watchSystemTheme(): () => void {
  if (systemListenerAttached || typeof window === 'undefined') return () => {};
  systemListenerAttached = true;
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => {
    if (getTheme() === 'system') applyTheme();
  };
  // addEventListener is supported in modern browsers; older Safari needs addListener.
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler);
  else if (typeof mq.addListener === 'function') mq.addListener(handler);
  return () => {
    systemListenerAttached = false;
    if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', handler);
    else if (typeof mq.removeListener === 'function') mq.removeListener(handler);
  };
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
