
const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ||
  'https://ace-dialer-api.onrender.com';

export interface User {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
  // Phase 5.7 — multi-user. Optional because older API responses don't include them.
  sipUsername?: string | null;
  /** Sensitive — only present on /auth/login + /auth/me. The SipContext uses
   *  this to register against Telnyx as the logged-in user. */
  sipPassword?: string | null;
  didNumber?: string | null;
}

export interface UpdateMeInput {
  firstName?: string | null;
  lastName?: string | null;
  sipUsername?: string | null;
  sipPassword?: string | null;
  didNumber?: string | null;
}

export async function updateMe(token: string, input: UpdateMeInput): Promise<User> {
  const res = await fetch(`${API_URL}/auth/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'update failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface LoginResponse {
  token: string;
  user: User;
}

// v0.10.0 Task 5 — Line-badge data shape attached to Call/Message/Voicemail
// rows so the UI can render a colored "Main / Sales / Personal" pill
// showing which of the user's DIDs the interaction landed on.
export interface RowUserDid {
  id: number;
  label: string;
  colorHex: string;
  didNumber: string | null;
}

export interface CallRecord {
  id: number;
  telnyxCallId: string;
  direction: 'inbound' | 'outbound' | string;
  fromNumber: string;
  toNumber: string;
  status: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  hangupCause: string | null;
  recordingUrl: string | null;
  userDid?: RowUserDid | null;
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Login failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function getMe(token: string): Promise<User> {
  const res = await fetch(`${API_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// v0.10.0 — Multi-DID per user. The dialer header renders a dropdown of
// these so a user with multiple numbers can switch which one is the
// active outbound identity. Backend tracks the active selection in
// User.activeUserDidId so it survives logout / device switch.
export interface UserDidRow {
  id: number;
  didNumber: string;
  label: string;
  colorHex: string;
  isDefault: boolean;
  isActiveOutbound: boolean;
  ringGroupId: number | null;
  ivrMenuId: number | null;
}
export interface UserDidsResponse {
  dids: UserDidRow[];
}
export async function getMyDids(token: string): Promise<UserDidRow[]> {
  const res = await fetch(`${API_URL}/me/dids`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as UserDidsResponse;
  return body.dids;
}

export interface SwitchActiveDidResult {
  ok: boolean;
  userDidId: number;
  didNumber: string;
  label: string;
  telnyxUpdated: boolean;
  warning?: string;
  error?: string;
}
export async function switchActiveDid(
  token: string,
  userDidId: number,
): Promise<SwitchActiveDidResult> {
  const res = await fetch(`${API_URL}/me/active-did`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ userDidId }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<SwitchActiveDidResult> & {
    error?: string;
  };
  if (!res.ok) {
    return {
      ok: false,
      userDidId,
      didNumber: '',
      label: '',
      telnyxUpdated: false,
      error: body.error || `HTTP ${res.status}`,
    };
  }
  return body as SwitchActiveDidResult;
}

// v0.9.13 — Fetch optional extra TURN servers (Cloudflare). Returns an
// empty array when the backend isn't configured for Cloudflare TURN; the
// SIP service already includes Telnyx TURN unconditionally, so callers
// can treat this as "best-effort failover."
export interface TurnCredentialsResponse {
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  provider?: string;
}
export async function getTurnCredentials(token: string): Promise<TurnCredentialsResponse> {
  try {
    const res = await fetch(`${API_URL}/turn-credentials`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { iceServers: [], provider: 'http-error' };
    return (await res.json()) as TurnCredentialsResponse;
  } catch {
    // Network error — silently fall through. Telnyx TURN is enough for
    // 95% of users; no point blocking login on a Cloudflare hiccup.
    return { iceServers: [], provider: 'fetch-throw' };
  }
}

// Bottom-nav unread/missed badge counts.
// Each endpoint takes a `since` ISO timestamp; the client passes its
// last-visit time so we only count items the user hasn't seen yet.
export async function getMessagesUnreadCount(token: string, since: string): Promise<number> {
  const res = await fetch(
    `${API_URL}/messages/unread/count?since=${encodeURIComponent(since)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return 0;
  const j = await res.json();
  return Number(j?.count ?? 0);
}
export async function getMissedCallsCount(token: string, since: string): Promise<number> {
  const res = await fetch(
    `${API_URL}/calls/missed/count?since=${encodeURIComponent(since)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return 0;
  const j = await res.json();
  return Number(j?.count ?? 0);
}
export async function getVoicemailsUnreadCount(token: string): Promise<number> {
  const res = await fetch(
    `${API_URL}/voicemails/unread/count`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return 0;
  const j = await res.json();
  return Number(j?.count ?? 0);
}

export async function getCalls(token: string): Promise<CallRecord[]> {
  const res = await fetch(`${API_URL}/calls`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface CreateCallInput {
  telnyxCallId: string;
  direction?: 'inbound' | 'outbound';
  fromNumber: string;
  toNumber: string;
  status?: string;
  startedAt?: string;
}

export async function createCall(token: string, input: CreateCallInput): Promise<CallRecord> {
  const res = await fetch(`${API_URL}/calls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface UpdateCallInput {
  status?: string;
  answeredAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number;
  hangupCause?: string | null;
}

export async function updateCall(
  token: string,
  idOrTelnyxCallId: string | number,
  input: UpdateCallInput
): Promise<CallRecord> {
  const res = await fetch(`${API_URL}/calls/${idOrTelnyxCallId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- Phase 5.5: Call recording (server-side via Telnyx Call Control) ----------
// UI isn't wired yet — these helpers stay so Voicemail.tsx and any future
// Record button can call them directly.
export interface RecordingActionResult {
  ok: boolean;
  error?: string;
  hint?: string;
}

// All these now take the leg's Telnyx callControlId (NOT the SDK's call.id).
// SipContext resolves the CC id via lookupCall() and passes it here.
export async function startRecording(token: string, callControlId: string): Promise<RecordingActionResult> {
  const res = await fetch(`${API_URL}/calls/${encodeURIComponent(callControlId)}/recording/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, ...(body as object) };
}

export async function stopRecording(token: string, callControlId: string): Promise<RecordingActionResult> {
  const res = await fetch(`${API_URL}/calls/${encodeURIComponent(callControlId)}/recording/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, ...(body as object) };
}

// Phase 5.4: bridge two legs into a 3-way conference. Both args are CC ids.
export async function mergeCalls(token: string, legAControlId: string, legBControlId: string): Promise<void> {
  const res = await fetch(`${API_URL}/calls/conference`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ legA: legAControlId, legB: legBControlId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'merge failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

// Phase 5.4 (rebuild): look up the Call Control ID for a leg by its
// telnyxCallId. Returns null if the webhook hasn't populated it yet — caller
// should retry. Used to gate Transfer / Add Call / Merge in the UI until the
// id is available.
export interface CallLookup {
  id: number;
  telnyxCallId: string;
  callControlId: string | null;
  sessionId: string | null;
  direction: string;
  fromNumber: string;
  toNumber: string;
  status: string;
}
export async function lookupCall(
  token: string,
  telnyxCallId: string,
  hints?: { to?: string; direction?: 'inbound' | 'outbound' },
): Promise<CallLookup | null> {
  const params = new URLSearchParams();
  if (hints?.to) params.set('to', hints.to);
  if (hints?.direction) params.set('direction', hints.direction);
  const qs = params.toString();
  const url =
    `${API_URL}/calls/by-telnyx/${encodeURIComponent(telnyxCallId)}` +
    (qs ? `?${qs}` : '');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return (await res.json()) as CallLookup;
}

// Phase 5.4 (rebuild): server-side transfer via Call Control. Takes the
// leg's Telnyx callControlId (not the SDK's call.id).
export interface TransferResult { ok: boolean; error?: string; hint?: string }
export async function transferCallApi(token: string, callControlId: string, to: string): Promise<TransferResult> {
  const res = await fetch(`${API_URL}/calls/${encodeURIComponent(callControlId)}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, ...(body as object) };
}

// Phase 5.4 (rebuild): server-originated Add Call. Telnyx dials Leg B and
// auto-bridges to Leg A when answered (via client_state). The user (still on
// Leg A's WebRTC stream) hears Leg B once they pick up.
export interface AddLegResult {
  ok: boolean;
  legB?: { telnyxCallId: string; callControlId: string; toNumber: string };
  error?: string;
  hint?: string;
}
export async function addLegApi(
  token: string,
  legAControlId: string,
  destination: string,
): Promise<AddLegResult> {
  const res = await fetch(`${API_URL}/calls/add-leg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ legAControlId, destination, autoBridge: true }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, ...(body as object) };
}

// ---------- Phase 5.6: Voicemail ----------
export interface VoicemailRecord {
  id: number;
  fromNumber: string;
  toNumber: string;
  recordingUrl: string;
  durationSeconds: number;
  transcription: string | null;
  receivedAt: string;
  listenedAt: string | null;
  userDid?: RowUserDid | null;
}

export async function getVoicemails(token: string): Promise<VoicemailRecord[]> {
  const res = await fetch(`${API_URL}/voicemails`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getUnreadVoicemailCount(token: string): Promise<number> {
  const res = await fetch(`${API_URL}/voicemails/unread/count`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return 0;
  const j = await res.json().catch(() => ({ count: 0 }));
  return j.count ?? 0;
}

// Call Forwarding settings (per-user). When enabled, inbound calls to the
// user's DID forward to the chosen number — either always or only on
// no-answer (depends on `mode`). Save provisions Telnyx automatically.
export interface CallForwardingSettings {
  enabled: boolean;
  number: string | null;
  mode: 'always' | 'on_failure' | null;
}
export async function getCallForwarding(token: string): Promise<CallForwardingSettings> {
  const res = await fetch(`${API_URL}/auth/call-forwarding`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
export async function saveCallForwarding(
  token: string,
  input: { enabled: boolean; number?: string | null; mode?: 'always' | 'on_failure' },
): Promise<CallForwardingSettings> {
  const res = await fetch(`${API_URL}/auth/call-forwarding`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Custom voicemail greeting — replaces Telnyx's default robot greeting
// with the user's own audio file. Stored in Supabase Storage; URL passed
// to Telnyx via PATCH /v2/phone_numbers/{id}/voicemail.
export interface VoicemailGreeting {
  url: string | null;
  filename: string | null;
}
export async function getVoicemailGreeting(token: string): Promise<VoicemailGreeting> {
  const res = await fetch(`${API_URL}/voicemail-greeting`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { url: null, filename: null };
  return res.json();
}
export async function uploadVoicemailGreeting(
  token: string,
  file: File,
): Promise<VoicemailGreeting> {
  // Read as base64 to match the JSON-body upload pattern the API expects.
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result as string;
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const res = await fetch(`${API_URL}/voicemail-greeting`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type || 'audio/mpeg',
      dataBase64,
    }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      telnyxStatus?: number;
      telnyxBody?: unknown;
      details?: unknown;
    };
    // Surface Telnyx's own error verbatim. Helps diagnose which field
    // they're rejecting (greeting_audio_url vs something else).
    const detail =
      err.telnyxBody
        ? `: ${JSON.stringify(err.telnyxBody)}`
        : err.details
          ? `: ${typeof err.details === 'string' ? err.details : JSON.stringify(err.details)}`
          : '';
    // eslint-disable-next-line no-console
    console.error('[vm-greeting] upload failed', err);
    throw new Error((err.error || `HTTP ${res.status}`) + detail);
  }
  return res.json();
}
export async function deleteVoicemailGreeting(token: string): Promise<void> {
  await fetch(`${API_URL}/voicemail-greeting`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// How many days a voicemail is retained before auto-delete. Server-controlled
// so changing the retention period doesn't require a frontend deploy.
export async function getVoicemailRetentionDays(token: string): Promise<number> {
  const res = await fetch(`${API_URL}/voicemails/retention`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return 30;
  const j = (await res.json()) as { days?: number };
  return Number(j.days ?? 30);
}

// Bulk mark voicemails as listened/unlistened — used by the select-mode toolbar.
export async function bulkMarkVoicemails(
  token: string,
  ids: number[],
  listened: boolean,
): Promise<{ count: number }> {
  const res = await fetch(`${API_URL}/voicemails/bulk`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ids, listened }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function markVoicemailListened(token: string, id: number, listened: boolean): Promise<void> {
  await fetch(`${API_URL}/voicemails/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ listenedAt: listened ? new Date().toISOString() : null }),
  });
}

export async function deleteVoicemail(token: string, id: number): Promise<void> {
  await fetch(`${API_URL}/voicemails/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---------- Phase 5.3: Messages ----------
export interface MessageRecord {
  id: number;
  telnyxMessageId: string;
  threadKey: string;
  direction: 'inbound' | 'outbound' | string;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrls: string[];
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  userDid?: RowUserDid | null;
}

export interface ThreadSummary {
  id: number;
  threadKey: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrls: string[];
  status: string;
  createdAt: string;
  userDid?: RowUserDid | null;
}

export async function getThreads(token: string): Promise<ThreadSummary[]> {
  const res = await fetch(`${API_URL}/messages/threads`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getThread(token: string, number: string): Promise<MessageRecord[]> {
  const res = await fetch(
    `${API_URL}/messages/threads/${encodeURIComponent(number)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface SendMessageInput {
  to: string;
  body?: string;
  mediaUrls?: string[];
}

export async function sendMessage(token: string, input: SendMessageInput): Promise<MessageRecord> {
  const res = await fetch(`${API_URL}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'send failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function uploadMedia(token: string, file: File): Promise<{ url: string }> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result as string;
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

  const res = await fetch(`${API_URL}/messages/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      dataBase64,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'upload failed' }));
    // Prefer the API's `hint` (human-readable) over the raw error code.
    // Also include status + details so the developer console shows everything.
    const msg = err.hint || err.error || `HTTP ${res.status}`;
    if (err.details) console.error('[mms upload] supabase error:', err.status, err.details);
    throw new Error(msg);
  }
  return res.json();
}

// ---------- Phase 5.x: Unified contact history ----------
export interface ContactHistorySummary {
  messageCount: number;
  callCount: number;
  voicemailCount: number;
  lastInteraction: string | null;
}
export interface ContactTimelineEntry {
  type: 'message' | 'call' | 'voicemail';
  id: number;
  timestamp: string;
  direction?: string;
  message?: { body: string | null; mediaUrls: string[]; status: string };
  call?: {
    status: string;
    durationSeconds: number;
    hangupCause: string | null;
    recordingUrl: string | null;
  };
  voicemail?: {
    recordingUrl: string;
    durationSeconds: number;
    transcription: string | null;
  };
}
export interface ContactHistory {
  phone: string;
  summary: ContactHistorySummary;
  timeline: ContactTimelineEntry[];
}

export async function getContactHistory(token: string, phone: string): Promise<ContactHistory | null> {
  const res = await fetch(
    `${API_URL}/contacts/history?phone=${encodeURIComponent(phone)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  return (await res.json()) as ContactHistory;
}

// ---------- Phase 5.5: JobDiva contact lookup ----------
export interface JobDivaContact {
  name: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  jobTitle?: string;
  email?: string;
}

export async function lookupJobDivaContact(
  token: string,
  phone: string,
): Promise<JobDivaContact | null> {
  const res = await fetch(
    `${API_URL}/jobdiva/contact?phone=${encodeURIComponent(phone)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as
    | { found: boolean; contact?: JobDivaContact }
    | null;
  if (!json?.found || !json.contact) return null;
  return json.contact;
}

// ===========================================================================
// Phase 6.8 — Number blocking
//
// Per-user blocklist of inbound phone numbers. Calls from blocked numbers
// hang up at the carrier layer; SMS from blocked numbers is silently dropped
// before reaching the user's inbox.
// ===========================================================================

export interface BlockedNumber {
  id: number;
  number: string;
  reason: string | null;
  createdAt: string;
}

export async function getBlockedNumbers(token: string): Promise<BlockedNumber[]> {
  const res = await fetch(`${API_URL}/blocked-numbers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { items: BlockedNumber[] };
  return json.items;
}

export async function addBlockedNumber(
  token: string,
  input: { number: string; reason?: string },
): Promise<BlockedNumber> {
  const res = await fetch(`${API_URL}/blocked-numbers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as BlockedNumber;
}

export async function removeBlockedNumber(token: string, id: number): Promise<void> {
  const res = await fetch(`${API_URL}/blocked-numbers/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
// ===========================================================================
// Phase 6.11 — Favorites sync
//
// Server-side per-user favorites. Replaces the localStorage-only store that
// used to live in lib/userPrefs.ts. The lib still exposes a synchronous API
// (getFavoriteName, isFavorite, addFavorite, etc.) backed by an in-memory
// cache hydrated from these endpoints at app boot.
// ===========================================================================

export interface FavoriteRow {
  id: number;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  label: string | null;
  addedAt: string;
}

export async function listFavorites(token: string): Promise<FavoriteRow[]> {
  const res = await fetch(`${API_URL}/favorites`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { items: FavoriteRow[] };
  return json.items;
}

export async function addFavoriteApi(
  token: string,
  input: {
    phone: string;
    firstName?: string | null;
    lastName?: string | null;
    label?: string | null;
  },
): Promise<FavoriteRow> {
  const res = await fetch(`${API_URL}/favorites`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as FavoriteRow;
}

export async function patchFavorite(
  token: string,
  id: number,
  input: {
    firstName?: string | null;
    lastName?: string | null;
    label?: string | null;
  },
): Promise<FavoriteRow> {
  const res = await fetch(`${API_URL}/favorites/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as FavoriteRow;
}

export async function deleteFavoriteApi(token: string, id: number): Promise<void> {
  const res = await fetch(`${API_URL}/favorites/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}



// ─────────────────────────────────────────────────────────────────
// Internal Chat — dialer-user ↔ dialer-user messaging (not external SMS).
// Lives entirely in our DB; intended for short notes between teammates.
// ─────────────────────────────────────────────────────────────────

// v0.9.15 — presence: live status the Chat UI uses to sort and section
// the teammates list. Same 4-state model as admin Presence dashboard:
//   - 'on_call': teammate is on a phone call right now
//   - 'active':  any dialer activity in last 10 min
//   - 'recent':  activity within last 60 min
//   - 'idle':    no activity in 60+ min (or never)
// `presence` is optional in the type for backward compatibility with any
// caller that hasn't been redeployed yet, but the production API always
// returns it.
export type ChatPresence = 'on_call' | 'active' | 'recent' | 'idle';
export interface InternalChatUser {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  presence?: ChatPresence;
  lastActivity?: string | null;
}

export interface InternalChatThread {
  otherId: number;
  lastMessage: string;
  mediaUrl: string | null;
  lastAt: string;
  lastSenderId: number;
  unreadCount: number;
  otherUser: InternalChatUser | null;
}

export interface InternalChatMessage {
  id: number;
  senderId: number;
  recipientId: number;
  threadKey: string;
  body: string;
  mediaUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

export async function getInternalChatUsers(token: string): Promise<InternalChatUser[]> {
  const res = await fetch(`${API_URL}/internal-chat/users`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to load users (${res.status})`);
  return res.json();
}

export async function getInternalChatThreads(token: string): Promise<InternalChatThread[]> {
  const res = await fetch(`${API_URL}/internal-chat/threads`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to load chat threads (${res.status})`);
  return res.json();
}

export async function getInternalChatThread(
  token: string,
  otherUserId: number,
): Promise<InternalChatMessage[]> {
  const res = await fetch(`${API_URL}/internal-chat/threads/${otherUserId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to load conversation (${res.status})`);
  return res.json();
}

export async function sendInternalChatMessage(
  token: string,
  recipientId: number,
  body: string,
  mediaUrl?: string | null,
): Promise<InternalChatMessage> {
  const res = await fetch(`${API_URL}/internal-chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ recipientId, body, mediaUrl: mediaUrl ?? null }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `Failed to send (${res.status})`);
  }
  return res.json();
}

export async function markInternalChatThreadRead(
  token: string,
  otherUserId: number,
): Promise<{ ok: boolean; marked: number }> {
  const res = await fetch(`${API_URL}/internal-chat/threads/${otherUserId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { ok: false, marked: 0 };
  return res.json();
}

export async function getInternalChatUnreadCount(token: string): Promise<number> {
  const res = await fetch(`${API_URL}/internal-chat/unread/count`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return 0;
  const json = await res.json().catch(() => ({ count: 0 }));
  return Number(json?.count ?? 0);
}

// ---------------------------------------------------------------
// Microsoft Entra ID SSO helpers (Phase 7).
// ---------------------------------------------------------------

export interface MicrosoftConfig {
  clientId: string | null;
  tenantId: string | null;
  enabled: boolean;
}

export async function getMicrosoftConfig(): Promise<MicrosoftConfig> {
  try {
    const res = await fetch(`${API_URL}/auth/microsoft/config`);
    if (!res.ok) return { clientId: null, tenantId: null, enabled: false };
    return res.json();
  } catch {
    return { clientId: null, tenantId: null, enabled: false };
  }
}

export async function exchangeMicrosoftCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ token: string; user: User }> {
  const res = await fetch(`${API_URL}/auth/microsoft/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirectUri, codeVerifier }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    const msg = body.message || body.error || `Sign-in failed (HTTP ${res.status})`;
    const err = new Error(msg) as Error & { code?: string };
    err.code = body.error;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Phase 6.12 — Version check for in-app "Update available" banner.
//
// Hits the API's root endpoint and returns the published version string,
// e.g. "0.6.0". UpdateBanner compares this to the bundled `__APP_VERSION__`
// (Vite-injected from apps/web/package.json) and surfaces a pill at the top
// of every page when the server is ahead. Returns null on any error so the
// banner stays hidden when the API is unreachable.
// ---------------------------------------------------------------------------
export async function getApiVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/`);
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return typeof json?.version === 'string' ? json.version : null;
  } catch {
    return null;
  }
}

// ===========================================================================
// Phase 6.13 — Admin Users panel
//
// Server-side admin endpoints for the in-app Users panel. All guarded by
// isAdmin server-side; the frontend just hides the nav entries for non-admins.
// ===========================================================================

export interface AdminUserRow {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
  isActive: boolean;
  provider: string;
  sipUsername: string | null;
  didNumber: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export async function listAdminUsers(token: string): Promise<AdminUserRow[]> {
  const res = await fetch(`${API_URL}/admin/users`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { items: AdminUserRow[] };
  return json.items;
}

export interface InviteAdminUserInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  sipUsername?: string | null;
  sipPassword?: string | null;
  didNumber?: string | null;
  isAdmin?: boolean;
  localPassword?: string | null;
}

export async function inviteAdminUser(
  token: string,
  input: InviteAdminUserInput,
): Promise<AdminUserRow> {
  const res = await fetch(`${API_URL}/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as AdminUserRow;
}

/// Auto-provision a brand-new user (no Pulse history): purchases a Telnyx
/// DID, creates SIP credentials, binds messaging profile, and sends the
/// welcome email — all in one call. Returns the full step log so the UI
/// can show which sub-step succeeded or failed.
export interface InviteNewUserInput {
  email: string;
  firstName?: string;
  lastName?: string;
  /// 'new' (default) = purchase a fresh local DID from Telnyx (~$0.45)
  /// 'unassigned'    = pick an ACE-owned DID that isn't routed anywhere ($0)
  didMode?: 'new' | 'unassigned';
  newDidAreaCode?: string;
  /// E.164 of the unassigned DID the admin picked. Required when didMode='unassigned'.
  unassignedDidNumber?: string;
  isAdmin?: boolean;
  sendEmail?: boolean;
}
export interface InviteNewUserResult {
  ok: boolean;
  user?: AdminUserRow;
  didNumber?: string;
  sipUsername?: string;
  emailSent?: boolean;
  steps?: Array<{ step: string; ok: boolean; error?: string }>;
  error?: string;
}
export async function inviteNewUserAutoProvision(
  token: string,
  input: InviteNewUserInput,
): Promise<InviteNewUserResult> {
  const res = await fetch(`${API_URL}/admin/users/invite-new`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as InviteNewUserResult;
  if (!res.ok) {
    return {
      ok: false,
      error:
        typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`,
      steps: 'steps' in body ? (body as { steps?: InviteNewUserResult['steps'] }).steps : undefined,
    };
  }
  return body;
}

export interface UpdateAdminUserInput {
  firstName?: string | null;
  lastName?: string | null;
  sipUsername?: string | null;
  sipPassword?: string | null;
  didNumber?: string | null;
  isAdmin?: boolean;
  isActive?: boolean;
  localPassword?: string | null;
}

export async function updateAdminUser(
  token: string,
  id: number,
  input: UpdateAdminUserInput,
): Promise<AdminUserRow> {
  const res = await fetch(`${API_URL}/admin/users/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as AdminUserRow;
}

/// v0.9.8 — Hard-delete a User row with full Telnyx cleanup (un-assign DID,
/// delete Credential Connection, delete any linked PendingUser). If the User
/// has call/SMS/voicemail history, Postgres FK constraints block the row
/// delete and we ANONYMIZE instead (v0.9.12): the email is tombstoned to
/// `deleted-{id}@deleted.ace.local` so the unique-constraint slot frees up
/// for re-invite, and every piece of PII (name, SIP creds, DID, SSO link)
/// is cleared. `deletedHard=false` and `status='anonymized'` signal that path.
export interface DeleteUserHardResult {
  ok: boolean;
  deletedHard: boolean;
  status: 'deleted' | 'anonymized';
  message: string;
  didReleased?: string | null;
  connectionDeleted?: string | null;
  pendingDeleted?: number | null;
  steps?: Array<{ step: string; ok: boolean; error?: string }>;
  error?: string;
}
export async function deleteUserHard(
  token: string,
  id: number,
): Promise<DeleteUserHardResult> {
  const res = await fetch(`${API_URL}/admin/users/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as Partial<DeleteUserHardResult> & {
    error?: string;
  };
  if (!res.ok) {
    return {
      ok: false,
      deletedHard: false,
      status: 'anonymized',
      message: body.error || `HTTP ${res.status}`,
      steps: body.steps,
      error: body.error || `HTTP ${res.status}`,
    };
  }
  return body as DeleteUserHardResult;
}

export interface AuditLogEntry {
  id: number;
  action: string;
  actor: {
    id: number;
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
  target: {
    id: number;
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
  metadata: unknown;
  createdAt: string;
}

export interface AuditLogPage {
  items: AuditLogEntry[];
  nextCursor: number | null;
}

export async function listAuditLogs(
  token: string,
  opts?: { limit?: number; cursor?: number },
): Promise<AuditLogPage> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.cursor) params.set('cursor', String(opts.cursor));
  const qs = params.toString();
  const res = await fetch(`${API_URL}/admin/audit-logs${qs ? '?' + qs : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AuditLogPage;
}

// ===========================================================================
// Phase 5 (#189) — Bulk import users from CSV
// ===========================================================================

export interface BulkImportRow {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  sipUsername?: string | null;
  sipPassword?: string | null;
  didNumber?: string | null;
  isAdmin?: boolean | null;
  phoneExtension?: string | null;
}

export interface BulkImportItemResult {
  row: number;
  email: string;
  status: 'created' | 'updated' | 'error' | 'skipped';
  missingPassword: boolean;
  error?: string;
  userId?: number;
}

export interface BulkImportResult {
  summary: {
    total: number;
    created: number;
    updated: number;
    errors: number;
    missingPasswords: number;
    dryRun: boolean;
  };
  items: BulkImportItemResult[];
}

export async function bulkImportUsers(
  token: string,
  rows: BulkImportRow[],
  dryRun: boolean,
): Promise<BulkImportResult> {
  const res = await fetch(`${API_URL}/admin/users/bulk-import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ rows, dryRun }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as BulkImportResult;
}

// ===========================================================================
// Phase 8 (#204) — Live Ops Dashboard
// ===========================================================================

export interface LiveOpsReport {
  generatedAt: string;
  users: {
    total: number;
    active: number;
    admins: number;
    activeLast24h: number;
  };
  calls: {
    activeNow: number;
    today: {
      total: number;
      inbound: number;
      outbound: number;
      missed: number;
    };
    yesterdayTotal: number;
    hourlyToday: Array<{ inbound: number; outbound: number; missed: number }>;
  };
  sms: {
    today: { sent: number; received: number };
  };
  topCallers: Array<{
    userId: number;
    email: string;
    name: string;
    callCount: number;
  }>;
  recentMissed: Array<{
    id: number;
    fromNumber: string;
    startedAt: string;
    status: string;
    userEmail: string;
    userName: string;
  }>;
}

export async function getLiveOpsReport(token: string): Promise<LiveOpsReport> {
  const res = await fetch(`${API_URL}/admin/reports/live`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as LiveOpsReport;
}

// ===========================================================================
// Phase 8 reports (v0.8.0)
//   - GET /admin/reports/presence (#211)
//   - GET /admin/reports/usage (#205)
//   - GET /admin/reports/quality (#206)
// ===========================================================================

export type PresenceStatus = 'on_call' | 'active' | 'recent' | 'idle';

export interface PresenceItem {
  id: number;
  email: string;
  name: string;
  didNumber: string | null;
  isAdmin: boolean;
  status: PresenceStatus;
  lastActivity: string | null;
  currentCall: {
    fromNumber: string;
    toNumber: string;
    direction: string;
    startedAt: string;
    status: string;
  } | null;
  todayCalls: number;
  todayBreakdown: { inbound: number; outbound: number; missed: number };
}

export interface PresenceReport {
  generatedAt: string;
  counts: { on_call: number; active: number; recent: number; idle: number };
  items: PresenceItem[];
}

export async function getPresenceReport(token: string): Promise<PresenceReport> {
  const res = await fetch(`${API_URL}/admin/reports/presence`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PresenceReport;
}

export interface UsageReport {
  range: string;
  generatedAt: string;
  byUser: Array<{
    userId: number;
    email: string;
    name: string;
    didNumber: string | null;
    totalCalls: number;
    inbound: number;
    outbound: number;
    missed: number;
    talkSeconds: number;
    smsSent: number;
    smsReceived: number;
  }>;
  byDay: Array<{ date: string; inbound: number; outbound: number; missed: number }>;
}

export async function getUsageReport(token: string, range: 'today' | '7d' | '30d' = '7d'): Promise<UsageReport> {
  const res = await fetch(`${API_URL}/admin/reports/usage?range=${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as UsageReport;
}

export interface QualityReport {
  range: string;
  generatedAt: string;
  missedRateByUser: Array<{
    userId: number;
    email: string;
    name: string;
    missed: number;
    answered: number;
    shortCalls: number;
    missedRate: number;
  }>;
  hangupCauses: Array<{ cause: string; count: number }>;
  totals: { shortCalls: number; totalCalls: number };
  heatmap: number[][]; // 7 rows (days, 0=Sun) x 24 cols (hours UTC)
}

export async function getQualityReport(token: string, range: '7d' | '30d' = '7d'): Promise<QualityReport> {
  const res = await fetch(`${API_URL}/admin/reports/quality?range=${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as QualityReport;
}

// ===========================================================================
// Phase 8.1 reports (v0.8.1)
//   - GET /admin/reports/cost (#207)
//   - GET /admin/reports/recruiter (#208)
//   - GET /admin/reports/alerts (#210)
// ===========================================================================

export interface CostReport {
  range: string;
  generatedAt: string;
  pricing: { inboundPerMin: number; outboundPerMin: number; perSms: number; didMonthly: number };
  totals: {
    voiceCost: number;
    smsCost: number;
    didRentalMonthly: number;
    projectedMonthly: number;
    activeDids: number;
  };
  byUser: Array<{
    userId: number; email: string; name: string; didNumber: string | null;
    inboundMinutes: number; outboundMinutes: number; smsCount: number;
    inboundCost: number; outboundCost: number; smsCost: number; totalCost: number;
  }>;
  didMinutes: Array<{ did: string; minutes: number }>;
}
export async function getCostReport(token: string, range: '7d' | '30d' = '30d'): Promise<CostReport> {
  const res = await fetch(`${API_URL}/admin/reports/cost?range=${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as CostReport;
}

export interface RecruiterReport {
  range: string;
  generatedAt: string;
  days: number;
  team: {
    totalDialed: number; totalConnected: number; totalUnique: number;
    conversationRate: number; avgUniquePerUser: number; activeRecruiters: number;
  };
  byUser: Array<{
    userId: number; email: string; name: string;
    totalDialed: number; uniqueNumbers: number; activeDays: number;
    avgUniquePerDay: number; connectedOver30s: number; conversationRate: number;
  }>;
}
export async function getRecruiterReport(token: string, range: '7d' | '30d' = '7d'): Promise<RecruiterReport> {
  const res = await fetch(`${API_URL}/admin/reports/recruiter?range=${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as RecruiterReport;
}

export interface AlertsReport {
  generatedAt: string;
  counts: { critical: number; warn: number; info: number };
  alerts: Array<{
    severity: 'info' | 'warn' | 'critical';
    type: string;
    message: string;
    userId?: number;
    userEmail?: string;
    userName?: string;
  }>;
}
export async function getAlertsReport(token: string): Promise<AlertsReport> {
  const res = await fetch(`${API_URL}/admin/reports/alerts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AlertsReport;
}

// ─── Phase 8 (#216-220): Pulse-to-ACE migration via PendingUser staging ────

export interface PendingUserRow {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  pulseVoipExt: string;
  pulseVoipNumber: string;
  pulseExtPassword: string;
  pulseConnectionName?: string | null;
  pulseUserStatus?: string | null;
}

export interface PendingUser {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  pulseVoipExt: string;
  pulseVoipNumber: string;
  pulseConnectionName: string | null;
  pulseUserStatus: string | null;
  status: 'pending' | 'invited' | 'skipped';
  hasPassword: boolean;
  /// True when status='invited' AND the linked User row has logged in
  /// at least once. Lets the UI show a derived "Accepted" state.
  hasLoggedIn?: boolean;
  invitedAt: string | null;
  invitedUserId: number | null;
  importBatchId: string | null;
  importedAt: string;
}

export interface PendingUserList {
  items: PendingUser[];
  counts: {
    pending: number;
    /// "Invited but not yet logged in" — the API subtracts the
    /// accepted slice so totals don't double-count.
    invited: number;
    skipped: number;
    /// Derived: invited rows whose linked User has logged in.
    accepted: number;
  };
}

export interface PendingUserImportResult {
  batchId: string;
  inserted: number;
  updated: number;
  errors: Array<{ row: number; email: string; error: string }>;
}

export interface InvitePendingInput {
  // 'existing'   = keep the user's current Pulse DID
  // 'new'        = purchase a fresh local US DID from Telnyx
  // 'unassigned' = pick an existing ACE-owned DID that isn't routed anywhere
  didMode: 'existing' | 'new' | 'unassigned';
  credsMode: 'existing' | 'new';
  repointWebhook: boolean;
  sendEmail: boolean;
  newDidAreaCode?: string;
  /// E.164 of the unassigned DID the admin picked. Required when didMode==='unassigned'.
  unassignedDidNumber?: string;
}

/// Unassigned Telnyx numbers we already own (not routed to any voice or
/// messaging connection). Powers the "pick from existing inventory" UI.
export interface UnassignedTelnyxNumber {
  id: string;
  phoneNumber: string;            // E.164
  areaCode: string | null;
  status: string;
  regionLabel: string | null;
}
export async function listUnassignedTelnyxNumbers(
  token: string,
): Promise<UnassignedTelnyxNumber[]> {
  const res = await fetch(`${API_URL}/admin/telnyx/unassigned-numbers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { items: UnassignedTelnyxNumber[] };
  return body.items ?? [];
}

export interface InvitePendingResult {
  ok: boolean;
  userId?: number;
  didNumber?: string;
  sipUsername?: string;
  credsCreated?: boolean;
  didPurchased?: boolean;
  webhookRepointed?: boolean;
  emailSent?: boolean;
  steps?: Array<{ step: string; ok: boolean; error?: string }>;
  error?: string;
}

export async function listPendingUsers(
  token: string,
  status:
    | 'pending'
    | 'invited'
    | 'accepted'
    | 'skipped'
    | 'all' = 'pending',
): Promise<PendingUserList> {
  // "accepted" is a UI-side derived bucket (status='invited' + hasLoggedIn);
  // the API doesn't know that filter name, so we ask for all invited rows
  // and the caller filters client-side using PendingUser.hasLoggedIn.
  const serverStatus = status === 'accepted' ? 'invited' : status;
  const params = serverStatus === 'all' ? '' : `?status=${serverStatus}`;
  const res = await fetch(`${API_URL}/admin/pending-users${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PendingUserList;
}

export async function importPendingUsers(
  token: string,
  rows: PendingUserRow[],
): Promise<PendingUserImportResult> {
  const res = await fetch(`${API_URL}/admin/pending-users/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(
      typeof errBody === 'object' && errBody !== null && 'error' in errBody
        ? String((errBody as { error: unknown }).error)
        : `HTTP ${res.status}`,
    );
  }
  return (await res.json()) as PendingUserImportResult;
}

export async function invitePendingUser(
  token: string,
  id: number,
  input: InvitePendingInput,
): Promise<InvitePendingResult> {
  const res = await fetch(`${API_URL}/admin/pending-users/${id}/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as InvitePendingResult;
  if (!res.ok) {
    return {
      ok: false,
      error:
        typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`,
      steps: 'steps' in body ? (body as { steps?: InvitePendingResult['steps'] }).steps : undefined,
    };
  }
  return body;
}

/// v0.9.7 — DELETE now returns a step-log when the row was an invited user
/// (so the UI can show what was cleaned up in Telnyx + DB). For PENDING rows
/// the response is `{ ok: true, steps: [...] }` with a single step.
export interface DeletePendingUserResult {
  ok: boolean;
  didReleased?: string | null;
  connectionDeleted?: string | null;
  deletedUserId?: number | null;
  steps?: Array<{ step: string; ok: boolean; error?: string }>;
}
export async function deletePendingUser(
  token: string,
  id: number,
): Promise<DeletePendingUserResult> {
  const res = await fetch(`${API_URL}/admin/pending-users/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(
      typeof errBody === 'object' && errBody !== null && 'error' in errBody
        ? String((errBody as { error: unknown }).error)
        : `HTTP ${res.status}`,
    );
  }
  return (await res.json().catch(() => ({ ok: true }))) as DeletePendingUserResult;
}

/// v0.9.7 — re-run Telnyx config for an already-invited user (idempotent fix).
/// Returns the same step-log shape as invitePendingUser so the UI can show it
/// in the existing ResultModal.
export async function verifyPendingUser(
  token: string,
  id: number,
): Promise<InvitePendingResult> {
  const res = await fetch(`${API_URL}/admin/pending-users/${id}/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as InvitePendingResult;
  if (!res.ok) {
    return {
      ok: false,
      error:
        typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`,
      steps: 'steps' in body ? (body as { steps?: InvitePendingResult['steps'] }).steps : undefined,
    };
  }
  return body;
}

/// v0.9.7 — edit any field on a PendingUser row. For INVITED rows, Pulse
/// ext/number/password are frozen server-side (returns 400 if you try to
/// change them); name+email mirror onto the linked User row automatically.
export interface PendingUserPatch {
  firstName?: string | null;
  lastName?: string | null;
  email?: string;
  pulseVoipExt?: string;
  pulseVoipNumber?: string;
  pulseExtPassword?: string;
  pulseConnectionName?: string | null;
  pulseUserStatus?: string | null;
}
export async function editPendingUser(
  token: string,
  id: number,
  patch: PendingUserPatch,
): Promise<{ ok: true; row: PendingUser; mirroredToUser: boolean }> {
  const res = await fetch(`${API_URL}/admin/pending-users/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(
      typeof errBody === 'object' && errBody !== null && 'error' in errBody
        ? String((errBody as { error: unknown }).error)
        : `HTTP ${res.status}`,
    );
  }
  return (await res.json()) as { ok: true; row: PendingUser; mirroredToUser: boolean };
}

/// Returns the unredacted SIP credentials for a single staged user. Every
/// call is audit-logged server-side. Used by the invite-modal "Reveal
/// credentials" button so the admin can verify what's about to be migrated.
export interface PendingUserCredentials {
  email: string;
  pulseVoipExt: string;
  pulseVoipNumber: string;
  pulseExtPassword: string;
  pulseConnectionName: string | null;
}
export async function getPendingUserCredentials(
  token: string,
  id: number,
): Promise<PendingUserCredentials> {
  const res = await fetch(`${API_URL}/admin/pending-users/${id}/credentials`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PendingUserCredentials;
}
