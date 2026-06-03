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
//
// Phase 6.11 — favorites are now SERVER-SIDE so they sync across every device
// (browser, Windows .exe, Mac .dmg, mobile web) the user logs into. The
// localStorage store still exists as a one-shot migration source: the first
// time a logged-in client boots, anything in localStorage that isn't on the
// server gets uploaded, after which we stop reading from localStorage.
//
// The public API stays SYNCHRONOUS (`getFavoriteName`, `isFavorite`, etc.)
// because dozens of render-time call sites depend on cheap lookups. We back
// it with an in-memory Map that gets hydrated at app boot from the API. Each
// mutate (`addFavorite`, `removeFavorite`, `updateFavoriteName`) updates the
// Map optimistically for instant UI feedback, then fires the matching API
// call in the background. The `ace:favoritesChanged` event is dispatched on
// every change so React surfaces re-render.
import {
  listFavorites as apiListFavorites,
  addFavoriteApi,
  patchFavorite as apiPatchFavorite,
  deleteFavoriteApi,
  type FavoriteRow,
} from '../api';

export interface FavoriteContact {
  /** Server-side row id. Populated once the POST returns; undefined for
   *  optimistically-added entries that haven't synced yet. */
  id?: number;
  /** E.164 number (or whatever the user typed). Stored as-is.
   *  v0.10.66 — Still treated as the "primary" number for tap-to-call. The
   *  full list of numbers (with labels Cell/Home/Work/Other) lives on
   *  `numbers` below. The primary is also mirrored as one of those rows. */
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
  /** v0.10.66 — Multi-number support. Each contact can carry several phone
   *  numbers (Cell / Home / Work / Other) each labeled and ordered. The
   *  primary number is mirrored as one of these rows AND on `phone` above
   *  for back-compat. Optional during the transition window — pre-v0.10.66
   *  cached entries don't have it; treat undefined as "primary-only". */
  numbers?: Array<{
    id: number;
    phone: string;
    label: string;
    sortOrder: number;
    isPrimary: boolean;
  }>;
}

const FAVORITES_KEY = 'ace_favorites';
const MIGRATION_FLAG_KEY = 'ace_favorites_migrated_v1';

// In-memory cache. Key = last-10 digits of the phone, so lookups are tolerant
// of "+15551234567" vs "(555) 123-4567" vs "5551234567" formatting drift.
const favoritesByKey = new Map<string, FavoriteContact>();

// In-flight POSTs keyed by last-10. Lets removeFavorite() wait for a pending
// add to settle (so we have the server-assigned id) before issuing DELETE.
const pendingAdds = new Map<string, Promise<FavoriteRow | null>>();

function normalizeFavoritePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

function favKey(phone: string | null | undefined): string {
  if (!phone) return '';
  return phone.replace(/[^\d]/g, '').slice(-10);
}

function rowToContact(row: FavoriteRow): FavoriteContact {
  return {
    id: row.id,
    phone: row.phone,
    firstName: row.firstName,
    lastName: row.lastName,
    label: row.label,
    addedAt: row.addedAt,
    // v0.10.66 — Forward the numbers list when the server included it.
    numbers: row.numbers,
  };
}

function emit(): void {
  window.dispatchEvent(new CustomEvent('ace:favoritesChanged'));
}

/**
 * Hydrate the in-memory favorites cache from the server. Call this once at
 * app boot (after login) -- it triggers the legacy-localStorage migration on
 * first run, then dispatches `ace:favoritesChanged` so every mounted page
 * picks up the synced favorites.
 *
 * Safe to call multiple times; subsequent calls just refresh the cache.
 */
export async function loadFavoritesFromServer(token?: string): Promise<void> {
  const t = token ?? sessionStorage.getItem('ace_token') ?? '';
  if (!t) return;
  try {
    const rows = await apiListFavorites(t);
    favoritesByKey.clear();
    for (const row of rows) {
      const key = favKey(row.phone);
      if (key) favoritesByKey.set(key, rowToContact(row));
    }
    // One-shot migration: push any localStorage-only entries up to the server,
    // then mark migration done so we never look at localStorage again.
    await migrateLocalFavoritesIfNeeded(t);
    emit();
  } catch (err) {
    // Network down / API unreachable: fall back to localStorage for read-only
    // until next boot. This keeps the dialer usable offline.
    console.warn('[favorites] could not hydrate from server, using local cache', err);
    seedCacheFromLocalStorage();
    emit();
  }
}

function seedCacheFromLocalStorage(): void {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const v of parsed) {
      if (!v || typeof v.phone !== 'string') continue;
      const key = favKey(v.phone);
      if (key && !favoritesByKey.has(key)) {
        favoritesByKey.set(key, {
          phone: v.phone,
          firstName: v.firstName ?? null,
          lastName: v.lastName ?? null,
          label: v.label ?? null,
          addedAt: v.addedAt ?? new Date().toISOString(),
        });
      }
    }
  } catch {
    /* swallow -- localStorage is best-effort */
  }
}

async function migrateLocalFavoritesIfNeeded(token: string): Promise<void> {
  if (localStorage.getItem(MIGRATION_FLAG_KEY)) return;
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) {
      localStorage.setItem(MIGRATION_FLAG_KEY, '1');
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      localStorage.setItem(MIGRATION_FLAG_KEY, '1');
      return;
    }
    let uploaded = 0;
    for (const v of parsed) {
      if (!v || typeof v.phone !== 'string') continue;
      const key = favKey(v.phone);
      if (!key) continue;
      if (favoritesByKey.has(key)) continue; // server already has it
      try {
        const row = await addFavoriteApi(token, {
          phone: v.phone,
          firstName: v.firstName ?? null,
          lastName: v.lastName ?? null,
          label: v.label ?? null,
        });
        favoritesByKey.set(favKey(row.phone), rowToContact(row));
        uploaded += 1;
      } catch (err) {
        console.warn('[favorites] migration: could not upload', v.phone, err);
      }
    }
    if (uploaded > 0) console.info(`[favorites] migrated ${uploaded} local favorites to server`);
  } catch (err) {
    console.warn('[favorites] migration failed', err);
  } finally {
    // Mark done either way so we don't loop on broken localStorage.
    localStorage.setItem(MIGRATION_FLAG_KEY, '1');
  }
}

/** Clear the cache on logout so a different user doesn't inherit them. */
export function clearFavoritesCache(): void {
  favoritesByKey.clear();
  pendingAdds.clear();
  emit();
}

export function getFavorites(): FavoriteContact[] {
  return Array.from(favoritesByKey.values()).sort(
    (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime(),
  );
}

export function isFavorite(phone: string | null | undefined): boolean {
  const key = favKey(phone);
  return !!key && favoritesByKey.has(key);
}

/**
 * Phase 6.10 / 6.11 -- return the friendly name saved for a phone number in
 * Favorites, or null if the number isn't favorited. Used in Recents,
 * IncomingCall, InCall, Messages, Voicemail to show "Adam Smith" instead of
 * the raw number when the caller is in the user's favorites list.
 *
 * Lookup order inside a favorite:
 *   1. firstName + lastName  (most common -- what the Add Favorite modal saves)
 *   2. label                 (legacy back-compat)
 *   3. null                  (favorite exists but no name attached)
 */
export function getFavoriteName(phone: string | null | undefined): string | null {
  const key = favKey(phone);
  if (!key) return null;
  const match = favoritesByKey.get(key);
  if (!match) {
    // Fall back to local-form lookup (handles short codes, intl numbers
    // whose last 10 don't normalize cleanly).
    if (phone) {
      const stripped = normalizeFavoritePhone(phone);
      for (const f of favoritesByKey.values()) {
        if (normalizeFavoritePhone(f.phone) === stripped) {
          const full = [f.firstName, f.lastName].filter(Boolean).join(' ').trim();
          if (full) return full;
          if (f.label) return f.label;
        }
      }
    }
    return null;
  }
  const full = [match.firstName, match.lastName].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (match.label) return match.label;
  return null;
}

export interface AddFavoriteOptions {
  /** Optional display label override. If not provided, we build one from
   *  firstName + lastName, or fall back to JobDiva / formatted phone. */
  label?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export function addFavorite(
  phone: string,
  opts?: AddFavoriteOptions | string | null,
): void {
  if (!phone) return;
  const key = favKey(phone);
  if (!key) return;
  if (favoritesByKey.has(key)) return; // already starred -- idempotent
  // Back-compat: callers used to pass a plain label string as 2nd arg.
  const options: AddFavoriteOptions =
    typeof opts === 'string' || opts == null
      ? { label: typeof opts === 'string' ? opts : null }
      : opts;
  const nameJoined = [options.firstName, options.lastName]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const optimistic: FavoriteContact = {
    phone,
    label: options.label ?? (nameJoined || null),
    firstName: options.firstName ?? null,
    lastName: options.lastName ?? null,
    addedAt: new Date().toISOString(),
  };
  favoritesByKey.set(key, optimistic);
  emit();
  // Fire-and-forget server sync.
  const token = sessionStorage.getItem('ace_token');
  if (!token) return;
  const p = addFavoriteApi(token, {
    phone,
    firstName: options.firstName ?? null,
    lastName: options.lastName ?? null,
    label: options.label ?? null,
  })
    .then((row) => {
      favoritesByKey.set(favKey(row.phone), rowToContact(row));
      pendingAdds.delete(key);
      emit();
      return row;
    })
    .catch((err) => {
      console.warn('[favorites] add did not sync to server', err);
      pendingAdds.delete(key);
      return null;
    });
  pendingAdds.set(key, p);
}

export function removeFavorite(phone: string): void {
  if (!phone) return;
  const key = favKey(phone);
  if (!key) return;
  const entry = favoritesByKey.get(key);
  if (!entry) return;
  favoritesByKey.delete(key);
  emit();
  const token = sessionStorage.getItem('ace_token');
  if (!token) return;
  // If a POST is still in flight for this number, wait for it to settle so
  // we have a server id to DELETE against. Otherwise we'd leak the row.
  (async () => {
    let id = entry.id;
    const pending = pendingAdds.get(key);
    if (!id && pending) {
      const settled = await pending;
      if (settled && typeof settled === 'object' && 'id' in settled) {
        id = settled.id;
      }
    }
    if (id) {
      try {
        await deleteFavoriteApi(token, id);
      } catch (err) {
        console.warn('[favorites] delete did not sync to server', err);
      }
    }
  })();
}

export function toggleFavorite(phone: string, label?: string | null): boolean {
  if (isFavorite(phone)) {
    removeFavorite(phone);
    return false;
  }
  addFavorite(phone, label);
  return true;
}

/** Update first/last name (and derived label) for an existing favorite. */
export function updateFavoriteName(
  phone: string,
  firstName: string,
  lastName: string,
): void {
  if (!phone) return;
  const key = favKey(phone);
  if (!key) return;
  const existing = favoritesByKey.get(key);
  if (!existing) return;
  const joined = [firstName, lastName].map((p) => p.trim()).filter(Boolean).join(' ');
  const updated: FavoriteContact = {
    ...existing,
    firstName: firstName.trim() || null,
    lastName: lastName.trim() || null,
    label: joined || null,
  };
  favoritesByKey.set(key, updated);
  emit();
  const token = sessionStorage.getItem('ace_token');
  if (!token) return;
  (async () => {
    // Wait for any in-flight add to land so we have an id to PATCH.
    let id = existing.id;
    const pending = pendingAdds.get(key);
    if (!id && pending) {
      const settled = await pending;
      if (settled && typeof settled === 'object' && 'id' in settled) {
        id = settled.id;
      }
    }
    if (!id) return;
    try {
      const row = await apiPatchFavorite(token, id, {
        firstName: updated.firstName,
        lastName: updated.lastName,
        label: updated.label,
      });
      favoritesByKey.set(favKey(row.phone), rowToContact(row));
      emit();
    } catch (err) {
      console.warn('[favorites] rename did not sync to server', err);
    }
  })();
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

// ---------- Last-visit timestamps (bottom-nav unread badges) ----------
// Track when the user last opened each tab so the API can count items
// newer than that point. Cheaper than per-item read flags.
export type TabKey = 'messages' | 'recents' | 'voicemail';
function visitKey(tab: TabKey): string {
  return `ace_last_visit_${tab}`;
}
export function getLastVisit(tab: TabKey): string {
  return localStorage.getItem(visitKey(tab)) || new Date(0).toISOString();
}
export function markTabVisited(tab: TabKey): void {
  localStorage.setItem(visitKey(tab), new Date().toISOString());
  window.dispatchEvent(new CustomEvent('ace:tabVisited', { detail: { tab } }));
}

// ---------- Per-thread last-visit (for unread highlight per message thread)
// Key = E.164 of the other party. Stored as ISO timestamp.
function threadVisitKey(threadKey: string): string {
  return `ace_last_visit_thread_${threadKey.replace(/[^\d+]/g, '')}`;
}
export function getThreadLastVisit(threadKey: string): string {
  return localStorage.getItem(threadVisitKey(threadKey)) || new Date(0).toISOString();
}
export function markThreadVisited(threadKey: string): void {
  localStorage.setItem(threadVisitKey(threadKey), new Date().toISOString());
  window.dispatchEvent(
    new CustomEvent('ace:threadVisited', { detail: { threadKey } }),
  );
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
  /** v0.10.26 — Show toast/desktop notification for new voicemails. */
  voicemailNotification: boolean;
}

const NOTIF_KEY = 'ace_notification_prefs';

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  inAppToast: true,
  ringtone: true,
  ringtoneVolume: 0.7,
  desktopNotification: true,
  smsNotification: true,
  voicemailNotification: true,
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
