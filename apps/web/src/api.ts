
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
