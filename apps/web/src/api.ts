
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
  // v0.10.60 — Beta opt-in for the Connection Health smoothing + webhook
  // recovery behavior. Optional for back-compat with older API responses.
  connectionHealthBeta?: boolean;
  // v0.10.75 — Ringtone preference. One of the bundled slugs in
  // services/ringtone.ts. NULL = use the default ('classic').
  ringtone?: string | null;
}

export interface UpdateMeInput {
  firstName?: string | null;
  lastName?: string | null;
  sipUsername?: string | null;
  sipPassword?: string | null;
  didNumber?: string | null;
  // v0.10.75 — Ringtone slug.
  ringtone?: string | null;
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
// v0.10.0 Pillar 2 — Microsoft Teams notification config.
// v0.10.1 — Switched to tenant-wide Power Automate flow. Users no longer
// manage a webhook URL; the admin configures one tenant URL (env var
// TEAMS_TENANT_WEBHOOK_URL on the API + webhooks services). Users only
// pick which event types they want cards for.
export type TeamsEventType = 'missed_call' | 'sms' | 'voicemail';
export interface TeamsConfig {
  /** True when TEAMS_TENANT_WEBHOOK_URL is set on the API service.
   *  When false the UI shows an "ask your admin" empty state. */
  tenantConfigured: boolean;
  events: TeamsEventType[];
  availableEvents?: TeamsEventType[];
}
export async function getTeamsConfig(token: string): Promise<TeamsConfig> {
  const res = await fetch(`${API_URL}/me/teams-config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
export async function updateTeamsConfig(
  token: string,
  input: { events?: TeamsEventType[] },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/me/teams-config`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  return { ok: true };
}
export async function testTeamsConfig(
  token: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const res = await fetch(`${API_URL}/me/teams-config/test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    status?: number;
    error?: string;
  };
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  return { ok: Boolean(body.ok), status: body.status };
}

// v0.10.79 — Per-user email notifications. Mirrors the Teams config API
// (same 3 event types) but stored independently in User.emailNotifyOn.
// Default OFF for all users — they opt in via Settings → Email
// notifications. Reuses ApTask's existing SendGrid + from-address.
export type EmailNotifyEventType = 'missed_call' | 'sms' | 'voicemail';
export interface EmailNotificationsConfig {
  /** True when SENDGRID_API_KEY is set on the API service. When false the
   *  UI shows an "ask your admin" empty state. */
  emailConfigured: boolean;
  /** The user's email on file. Surfaced so the UI can show "we'll send to
   *  abdulla@aptask.com" with no ambiguity. */
  email: string | null;
  events: EmailNotifyEventType[];
  availableEvents?: EmailNotifyEventType[];
}
export async function getEmailNotifications(token: string): Promise<EmailNotificationsConfig> {
  const res = await fetch(`${API_URL}/me/email-notifications`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
export async function updateEmailNotifications(
  token: string,
  input: { events?: EmailNotifyEventType[] },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/me/email-notifications`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  return { ok: true };
}
export async function testEmailNotification(
  token: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const res = await fetch(`${API_URL}/me/email-notifications/test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    status?: number;
    error?: string;
  };
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  return { ok: Boolean(body.ok), status: body.status };
}

// v0.10.0 Task 27 — Admin: list a specific user's DIDs (read-only).
export interface AdminUserDidRow {
  id: number;
  didNumber: string;
  telnyxNumberId: string | null;
  connectionId: string | null;
  label: string;
  colorHex: string;
  isDefault: boolean;
  createdAt: string;
}
export async function getAdminUserDids(token: string, userId: number): Promise<AdminUserDidRow[]> {
  const res = await fetch(`${API_URL}/admin/users/${userId}/dids`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.dids ?? [];
}

// v0.10.0 Task 27 — Admin: add a DID to an existing user.
// Two modes: source='unassigned' (pick existing inventory) or
// source='purchase' (buy a brand-new DID in the given area code — BILLABLE).
export interface AddUserDidBody {
  source: 'unassigned' | 'purchase';
  didNumber?: string;             // required when source='unassigned'
  purchaseAreaCode?: string;      // required when source='purchase' (3-digit US)
  label?: string;
  colorHex?: string;
  isDefault?: boolean;
}
export interface AddUserDidResult {
  ok: boolean;
  userDid?: { id: number; didNumber: string; label: string; colorHex: string; isDefault: boolean };
  purchased?: boolean;
  purchasedNumber?: string | null;
  error?: string;
}
export async function addUserDid(
  token: string,
  userId: number,
  input: AddUserDidBody,
): Promise<AddUserDidResult> {
  const res = await fetch(`${API_URL}/admin/users/${userId}/dids`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({})) as Partial<AddUserDidResult> & { error?: string };
  if (!res.ok) {
    return { ok: false, error: body.error || `HTTP ${res.status}` };
  }
  return body as AddUserDidResult;
}

// v0.10.0 Task 27 — Admin: edit a UserDid's label / color / default flag.
export interface PatchUserDidBody {
  label?: string;
  colorHex?: string;
  isDefault?: boolean;
}
export async function patchUserDid(
  token: string,
  userId: number,
  userDidId: number,
  input: PatchUserDidBody,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/admin/users/${userId}/dids/${userDidId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  return { ok: true };
}

// v0.10.0 Task 27 — Admin: remove a DID from a user. Refuses if it's
// the only one. Telnyx-side: also unassigns the number so it returns
// to the unassigned pool, where another user can pick it up.
export async function removeUserDid(
  token: string,
  userId: number,
  userDidId: number,
): Promise<{ ok: boolean; telnyxUnassigned?: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/admin/users/${userId}/dids/${userDidId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({})) as { telnyxUnassigned?: boolean; error?: string };
  if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  return { ok: true, telnyxUnassigned: body.telnyxUnassigned };
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

// v0.10.9 — Look up the most-recent inbound call for the current user
// (optionally filtered by caller's E.164). Used by the IncomingCall ringer
// to render a line badge showing which of the user's DIDs was dialed.
// The SIP INVITE itself only carries our SIP credential; the dialed DID
// is on the Call row via the webhook's resolveUserAndDid().
export async function getRecentInboundCall(
  token: string,
  fromNumber?: string | null,
): Promise<CallRecord | null> {
  const qs = fromNumber ? `?fromNumber=${encodeURIComponent(fromNumber)}` : '';
  const res = await fetch(`${API_URL}/calls/recent-inbound${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { call?: CallRecord | null };
  return body.call ?? null;
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

// v0.10.2 Task 9 — single voicemail metadata + audio for the playback page.
export async function getVoicemail(token: string, id: number): Promise<VoicemailRecord> {
  const res = await fetch(`${API_URL}/voicemails/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Fetches the voicemail audio as a Blob URL so an HTML5 <audio> element
 *  can play it. The audio endpoint requires JWT auth (Bearer header), and
 *  <audio src> can't carry headers — Blob URL is the standard workaround.
 *  Caller is responsible for URL.revokeObjectURL on cleanup. */
export async function getVoicemailAudioBlob(
  token: string,
  id: number,
): Promise<string> {
  const res = await fetch(`${API_URL}/voicemails/${id}/audio`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
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
// v0.10.99 — VoicemailGreeting now includes text + mode for the Call Control
// voicemail flow. mode: 'audio' = play voicemailGreetingUrl on inbound calls
// that fall to voicemail; 'tts' = synthesize voicemailGreetingText via TTS;
// 'default' = fall back to "You've reached <firstName>'s voicemail" stock.
export type VoicemailGreetingMode = 'audio' | 'tts' | 'default';
// v0.10.100 — Per-greeting (no-answer vs busy) variant. Each variant has
// its own URL/filename/text/mode, configured independently in Settings.
export type VoicemailGreetingType = 'noanswer' | 'busy';
export interface VoicemailGreetingVariant {
  url: string | null;
  filename: string | null;
  text: string | null;
  mode: VoicemailGreetingMode | null;
}
export interface VoicemailGreeting extends VoicemailGreetingVariant {
  // v0.10.100 — Per-type breakdown. Top-level url/filename/text/mode
  // remain for v0.10.99 backward compatibility (they mirror noanswer).
  noanswer?: VoicemailGreetingVariant;
  busy?: VoicemailGreetingVariant;
}
function emptyVariant(): VoicemailGreetingVariant {
  return { url: null, filename: null, text: null, mode: null };
}
export async function getVoicemailGreeting(token: string): Promise<VoicemailGreeting> {
  const res = await fetch(`${API_URL}/voicemail-greeting`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return { url: null, filename: null, text: null, mode: null,
             noanswer: emptyVariant(), busy: emptyVariant() };
  }
  const j = (await res.json()) as VoicemailGreeting;
  // Defensive: older API (v0.10.99) doesn't send noanswer/busy. Fill in.
  if (!j.noanswer) j.noanswer = { url: j.url, filename: j.filename, text: j.text ?? null, mode: j.mode ?? null };
  if (!j.busy) j.busy = emptyVariant();
  return j;
}
export async function setVoicemailGreetingText(
  token: string,
  text: string,
  type: VoicemailGreetingType = 'noanswer',
): Promise<{ text: string; mode: VoicemailGreetingMode }> {
  const res = await fetch(`${API_URL}/voicemail-greeting/${type}/tts`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
export async function setVoicemailGreetingMode(
  token: string,
  mode: VoicemailGreetingMode,
  type: VoicemailGreetingType = 'noanswer',
): Promise<{ mode: VoicemailGreetingMode }> {
  const res = await fetch(`${API_URL}/voicemail-greeting/${type}/mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
// v0.10.100 — Upload supports both File objects (from <input type="file">)
// and Blob objects (from MediaRecorder for in-app recording). Pass
// filename explicitly when uploading a Blob; for File it defaults to file.name.
export async function uploadVoicemailGreeting(
  token: string,
  fileOrBlob: File | Blob,
  type: VoicemailGreetingType = 'noanswer',
  filenameOverride?: string,
): Promise<VoicemailGreetingVariant> {
  const filename = filenameOverride
    ?? (fileOrBlob instanceof File ? fileOrBlob.name : `recording-${Date.now()}.webm`);
  const mimeType = fileOrBlob.type || 'audio/mpeg';

  // Read as base64 to match the JSON-body upload pattern the API expects.
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result as string;
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(fileOrBlob);
  });
  const res = await fetch(`${API_URL}/voicemail-greeting/${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ filename, mimeType, dataBase64 }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      details?: unknown;
    };
    const detail =
      err.details
        ? `: ${typeof err.details === 'string' ? err.details : JSON.stringify(err.details)}`
        : '';
    // eslint-disable-next-line no-console
    console.error('[vm-greeting] upload failed', err);
    throw new Error((err.error || `HTTP ${res.status}`) + detail);
  }
  return res.json();
}
export async function deleteVoicemailGreeting(
  token: string,
  type: VoicemailGreetingType = 'noanswer',
): Promise<void> {
  await fetch(`${API_URL}/voicemail-greeting/${type}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ──────────────────────────────────────────────────────────────────
// v0.10.100 — Admin migration to Call Control voicemail (per-user).
// Replaces "DID → SIP credential → Hosted VM" with "DID → ACE Voicemail
// Voice API app → ring softphone, fall to custom greeting on no-answer."
// ──────────────────────────────────────────────────────────────────
export interface VoicemailMigrationDid {
  id: number;
  didNumber: string;
  label: string;
  isDefault: boolean;
  migratedAt: string | null;
  currentConnectionId: string | null;
  previousConnectionId: string | null;
  previousHostedVmEnabled: boolean | null;
}
export interface VoicemailMigrationStatus {
  user: { id: number; email: string; name: string; sipUsername: string | null };
  ccAppConfigured: boolean;
  totalDids: number;
  migratedDids: number;
  dids: VoicemailMigrationDid[];
}
export interface VoicemailMigrationResult {
  didId: number;
  didNumber: string;
  status: 'migrated' | 'already_migrated' | 'rolled_back' | 'failed';
  previousConnectionId?: string | null;
  previousHostedVmEnabled?: boolean | null;
  restoredConnectionId?: string | null;
  restoredHostedVmEnabled?: boolean | null;
  error?: string;
}
export interface VoicemailMigrationResponse {
  ok: boolean;
  user: { id: number; email: string; name: string };
  summary: { successCount: number; alreadyCount?: number; failCount: number; total: number };
  results: VoicemailMigrationResult[];
  message?: string;
}
export async function getVoicemailMigrationStatus(
  token: string,
  userId: number,
): Promise<VoicemailMigrationStatus> {
  const res = await fetch(`${API_URL}/admin/users/${userId}/voicemail-migration`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
export async function migrateUserToCallControlVoicemail(
  token: string,
  userId: number,
): Promise<VoicemailMigrationResponse> {
  const res = await fetch(`${API_URL}/admin/users/${userId}/voicemail-migrate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}
export async function rollbackUserFromCallControlVoicemail(
  token: string,
  userId: number,
): Promise<VoicemailMigrationResponse> {
  const res = await fetch(`${API_URL}/admin/users/${userId}/voicemail-rollback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
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
  // v0.10.72 — Telnyx error envelope. Populated when a message hits
  // status='failed' or 'delivery_failed'. The shape varies — usually
  // { errors: [{ code: '30007', title: '...', detail: '...' }] } — so
  // we type as unknown and let telnyxErrorBlurb() parse defensively.
  errors?: unknown;
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
  /** v0.10.26 — number of inbound messages in this thread not yet read. */
  unreadCount: number;
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

// v0.10.26 — Mark all inbound messages in a thread as read (auto-fires
// when user opens the thread).
export async function markThreadRead(token: string, number: string): Promise<{ marked: number }> {
  const res = await fetch(
    `${API_URL}/messages/threads/${encodeURIComponent(number)}/read`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// v0.10.26 — Mark the most-recent inbound message in a thread as unread,
// so the thread re-appears with an unread dot. Wired to a "Mark as
// unread" action in the threads list.
export async function markThreadUnread(token: string, number: string): Promise<void> {
  const res = await fetch(
    `${API_URL}/messages/threads/${encodeURIComponent(number)}/unread`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// v0.10.26 — Toggle a SINGLE message's read state (per-message granularity).
export async function setMessageReadState(
  token: string,
  messageId: number,
  read: boolean,
): Promise<void> {
  const res = await fetch(`${API_URL}/messages/${messageId}/read`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ read }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export interface SendMessageInput {
  to: string;
  body?: string;
  mediaUrls?: string[];
}

// v0.10.72 — Custom error class so the UI can extract the Telnyx error
// details (code, title, full envelope) and run them through the friendly
// blurb mapper. Previously sendMessage threw a generic Error whose
// .message was just "telnyx_send_failed" or "HTTP 502" — the actual
// Telnyx code (30007 etc.) was on `err.details` and got swallowed at
// the throw site.
export class SendMessageError extends Error {
  /** Top-level error string from the backend ("telnyx_send_failed" etc.) */
  code: string;
  /** Raw Telnyx error envelope when the backend forwarded one. */
  details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.details = details;
  }
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
    const body = await res.json().catch(() => ({})) as {
      error?: string;
      message?: string;
      details?: unknown;
    };
    throw new SendMessageError(
      body.error ?? `http_${res.status}`,
      body.message ?? body.error ?? `HTTP ${res.status}`,
      body.details,
    );
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

// v0.10.66 — Multi-number favorites.
export interface FavoriteNumberRow {
  id: number;
  phone: string;
  label: string;
  sortOrder: number;
  isPrimary: boolean;
}

export interface FavoriteRow {
  id: number;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  label: string | null;
  addedAt: string;
  // v0.10.66 — Optional for back-compat with older API responses; server
  // always returns it from /favorites GET/POST/PATCH on v0.10.66+.
  numbers?: FavoriteNumberRow[];
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

// v0.10.66 — Per-favorite number management.
export async function addFavoriteNumber(
  token: string,
  favoriteId: number,
  input: { phone: string; label?: string; isPrimary?: boolean },
): Promise<FavoriteNumberRow | { error: string }> {
  const res = await fetch(`${API_URL}/favorites/${favoriteId}/numbers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: (body as { error?: string; message?: string }).message ?? (body as { error?: string }).error ?? `HTTP ${res.status}` };
  }
  return body as FavoriteNumberRow;
}

export async function patchFavoriteNumber(
  token: string,
  favoriteId: number,
  numberId: number,
  input: { phone?: string; label?: string; isPrimary?: boolean; sortOrder?: number },
): Promise<FavoriteNumberRow | { error: string }> {
  const res = await fetch(`${API_URL}/favorites/${favoriteId}/numbers/${numberId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  }
  return body as FavoriteNumberRow;
}

export async function deleteFavoriteNumber(
  token: string,
  favoriteId: number,
  numberId: number,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/favorites/${favoriteId}/numbers/${numberId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: (body as { error?: string; message?: string }).message ?? (body as { error?: string }).error ?? `HTTP ${res.status}` };
  }
  return body as { ok: boolean };
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
  // Legacy single-DID field. Use userDids for the source of truth.
  // Kept for backward compatibility with older flows.
  didNumber: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  // v0.10.40 — Full list of this user's DIDs. Empty array when the
  // endpoint didn't include them (e.g. POST /admin/users response).
  userDids: Array<{
    id: number;
    didNumber: string;
    label: string | null;
    isDefault: boolean;
  }>;
  // v0.10.60 — Beta opt-in. Optional for back-compat with older API
  // responses (where this field didn't exist).
  connectionHealthBeta?: boolean;
  // v0.10.64 — Country (IN / US / Other) for Telnyx anchorsite selection.
  // Optional because older API responses don't include it.
  country?: string | null;
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
  // v0.10.64 — Country for Telnyx anchorsite selection. Defaults to 'IN'
  // on the server when omitted.
  country?: string;
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

// v0.10.51 — Admin visibility into all users' blocked numbers + override.
export interface AdminBlockedNumber {
  id: number;
  number: string;
  reason: string | null;
  createdAt: string;
  userId: number;
  user: {
    id: number;
    email: string;
    firstName: string | null;
    lastName: string | null;
    isActive: boolean;
  };
}
export async function listAdminBlockedNumbers(token: string): Promise<AdminBlockedNumber[]> {
  const res = await fetch(`${API_URL}/admin/blocked-numbers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; items?: AdminBlockedNumber[] };
  return body.items ?? [];
}
export async function adminRemoveBlockedNumber(token: string, id: number): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/admin/blocked-numbers/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error) : `HTTP ${res.status}`,
    };
  }
  return body as { ok: boolean };
}

// v0.10.52 — Tenant SMS templates.
export interface SmsTemplate {
  id: number;
  category: string;
  name: string;
  body: string;
  sortOrder: number;
  isActive?: boolean;
  updatedBy?: number | null;
  createdAt?: string;
  updatedAt?: string;
}
export interface SmsTemplateInput {
  category: string;
  name: string;
  body: string;
  sortOrder?: number;
  isActive?: boolean;
}
export async function listMySmsTemplates(token: string): Promise<SmsTemplate[]> {
  const res = await fetch(`${API_URL}/me/sms-templates`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; templates?: SmsTemplate[] };
  return body.templates ?? [];
}
export async function listAdminSmsTemplates(token: string): Promise<SmsTemplate[]> {
  const res = await fetch(`${API_URL}/admin/sms-templates`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; templates?: SmsTemplate[] };
  return body.templates ?? [];
}
export async function createSmsTemplate(token: string, input: SmsTemplateInput): Promise<{ ok: boolean; template?: SmsTemplate; error?: string }> {
  const res = await fetch(`${API_URL}/admin/sms-templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}` };
  return body as { ok: boolean; template: SmsTemplate };
}
export async function updateSmsTemplate(token: string, id: number, input: Partial<SmsTemplateInput>): Promise<{ ok: boolean; template?: SmsTemplate; error?: string }> {
  const res = await fetch(`${API_URL}/admin/sms-templates/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}` };
  return body as { ok: boolean; template: SmsTemplate };
}
export async function archiveSmsTemplate(token: string, id: number): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/admin/sms-templates/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}` };
  return body as { ok: boolean };
}
export async function seedSmsTemplateDefaults(token: string): Promise<{ ok: boolean; inserted?: number; skipped?: number; note?: string; error?: string }> {
  const res = await fetch(`${API_URL}/admin/sms-templates/seed-defaults`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}` };
  return body as { ok: boolean; inserted: number; skipped: number };
}

// v0.10.76 — Admin-uploaded ringtones (tenant-wide library).
export interface UploadedRingtone {
  id: number;
  name: string;
  dataUrl: string;
  sortOrder: number;
  isActive?: boolean;
  uploadedBy?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export async function listMyRingtones(token: string): Promise<UploadedRingtone[]> {
  const res = await fetch(`${API_URL}/me/ringtones`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { ringtones?: UploadedRingtone[] };
  return json.ringtones ?? [];
}

export async function listAdminRingtones(token: string): Promise<UploadedRingtone[]> {
  const res = await fetch(`${API_URL}/admin/ringtones`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { ringtones?: UploadedRingtone[] };
  return json.ringtones ?? [];
}

export async function createRingtone(
  token: string,
  input: { name: string; dataUrl: string; sortOrder?: number },
): Promise<UploadedRingtone | { error: string }> {
  const res = await fetch(`${API_URL}/admin/ringtones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  return body as UploadedRingtone;
}

export async function updateRingtone(
  token: string,
  id: number,
  input: { name?: string; sortOrder?: number; isActive?: boolean },
): Promise<UploadedRingtone | { error: string }> {
  const res = await fetch(`${API_URL}/admin/ringtones/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  return body as UploadedRingtone;
}

export async function deleteRingtone(token: string, id: number): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/admin/ringtones/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  return body as { ok: boolean };
}

// v0.10.74 — Admin Praise / Announcements.
// v0.10.93 — Broadcast categories. Originally "Praise" was the only kind
// of pop-up message admins could send to users; v0.10.93 expanded the
// system into a general broadcast platform with multiple type-groups:
// Celebrations (the old praise), Announcements, Alerts, Reminders, Welcomes.
// Keep in sync with apps/api/src/praises/praises.routes.ts CATEGORY_VALUES.
export type PraiseCategory =
  // Celebrations (legacy)
  | 'new_hire' | 'new_offer' | 'birthday' | 'anniversary' | 'custom'
  // Announcements
  | 'announcement' | 'update_required' | 'maintenance' | 'holiday' | 'policy_update'
  // Alerts
  | 'alert_urgent' | 'service_outage'
  // Reminders
  | 'reminder' | 'training'
  // Welcomes
  | 'welcome';

export interface Praise {
  id: number;
  category: PraiseCategory;
  recipientName: string | null;
  /** v0.10.89 — Admin-authored headline override. When null, the
   *  recipient modal uses the category default ("Welcome aboard …",
   *  "Happy birthday", etc.) instead. */
  headline?: string | null;
  message: string;
  createdAt: string;
  toUserId: number | null;
  fromUser: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    email: string;
  };
  toUser?: {
    id: number;
    firstName: string | null;
    lastName: string | null;
  } | null;
  // _count.reads on admin-history responses; absent on /me/praises.
  _count?: { reads: number };
}

export interface CreatePraiseInput {
  category: PraiseCategory;
  /** null/undefined = broadcast to everyone */
  toUserId?: number | null;
  recipientName?: string;
  message: string;
  /** v0.10.89 — Optional headline override. Empty/omitted → recipient
   *  modal falls back to category default. */
  headline?: string;
}

export async function listMyPraises(token: string): Promise<Praise[]> {
  const res = await fetch(`${API_URL}/me/praises`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { praises?: Praise[] };
  return json.praises ?? [];
}

export async function markPraiseRead(token: string, praiseId: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_URL}/me/praises/${praiseId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  return body as { ok: boolean };
}

export async function listAdminPraises(token: string): Promise<Praise[]> {
  const res = await fetch(`${API_URL}/admin/praises`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { praises?: Praise[] };
  return json.praises ?? [];
}

export async function createPraise(token: string, input: CreatePraiseInput): Promise<Praise | { error: string }> {
  const res = await fetch(`${API_URL}/admin/praises`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  }
  return body as Praise;
}

export async function deletePraise(token: string, id: number): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/admin/praises/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  }
  return body as { ok: boolean };
}

// v0.10.92 — Feature Tips. Used by TipBanner (rotating floating card) +
// the admin Tips management page.
export interface Tip {
  id: number;
  title: string;
  body: string;
  icon: string | null;
  adminOnly: boolean;
  isBuiltIn: boolean;
}
export interface AdminTip extends Tip {
  isEnabled: boolean;
  createdAt: string;
  createdBy?: { id: number; firstName: string | null; lastName: string | null; email: string } | null;
}
export async function listMyTips(token: string): Promise<Tip[]> {
  const res = await fetch(`${API_URL}/me/tips`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { tips?: Tip[] };
  return body.tips ?? [];
}
export async function listAdminTips(token: string): Promise<AdminTip[]> {
  const res = await fetch(`${API_URL}/admin/tips`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { tips?: AdminTip[] };
  return body.tips ?? [];
}
export async function createTip(
  token: string,
  input: { title: string; body: string; icon?: string; adminOnly?: boolean },
): Promise<AdminTip | { error: string }> {
  const res = await fetch(`${API_URL}/admin/tips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  return body as AdminTip;
}
export async function updateTip(
  token: string,
  id: number,
  input: Partial<{ title: string; body: string; icon: string | null; adminOnly: boolean; isEnabled: boolean }>,
): Promise<AdminTip | { error: string }> {
  const res = await fetch(`${API_URL}/admin/tips/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  return body as AdminTip;
}
export async function deleteTip(token: string, id: number): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/admin/tips/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  return body as { ok: boolean };
}

// v0.10.59 — Scheduled messages (one-off).
export interface ScheduledMessage {
  id: number;
  toNumber: string;
  body: string;
  mediaUrls: string[];
  scheduledFor: string;       // ISO
  userDidId: number | null;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'canceled';
  attempts?: number;
  lastError?: string | null;
  telnyxMessageId?: string | null;
  sentAt?: string | null;
  createdAt: string;
}
export interface ScheduledMessageInput {
  toNumber: string;
  body?: string;
  mediaUrls?: string[];
  scheduledFor: string;       // ISO UTC
  userDidId?: number;
}
export interface ScheduledMessagePatch {
  body?: string;
  mediaUrls?: string[];
  scheduledFor?: string;      // ISO UTC
}

export async function listMyScheduledMessages(
  token: string,
  opts?: { status?: 'pending' | 'sent' | 'failed' | 'canceled' | 'all'; threadKey?: string },
): Promise<ScheduledMessage[]> {
  const params = new URLSearchParams();
  if (opts?.status) params.set('status', opts.status);
  if (opts?.threadKey) params.set('threadKey', opts.threadKey);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API_URL}/me/scheduled-messages${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { scheduledMessages?: ScheduledMessage[] };
  return json.scheduledMessages ?? [];
}

export async function createScheduledMessage(
  token: string,
  input: ScheduledMessageInput,
): Promise<ScheduledMessage | { error: string }> {
  const res = await fetch(`${API_URL}/me/scheduled-messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  }
  return body as ScheduledMessage;
}

export async function updateScheduledMessage(
  token: string,
  id: number,
  patch: ScheduledMessagePatch,
): Promise<ScheduledMessage | { error: string }> {
  const res = await fetch(`${API_URL}/me/scheduled-messages/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  }
  return body as ScheduledMessage;
}

export async function cancelScheduledMessage(
  token: string,
  id: number,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/me/scheduled-messages/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  }
  return body as { ok: boolean };
}

// v0.10.48 — Tenant hold music. Read by every user; written by admin.
export interface TenantHoldMusic {
  ok: boolean;
  dataUrl: string | null;
  filename: string | null;
  error?: string;
}
export async function getTenantHoldMusic(token: string): Promise<TenantHoldMusic> {
  const res = await fetch(`${API_URL}/me/hold-music`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as TenantHoldMusic;
  if (!res.ok) {
    return {
      ok: false, dataUrl: null, filename: null,
      error: typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error) : `HTTP ${res.status}`,
    };
  }
  return body;
}
export async function setTenantHoldMusic(
  token: string,
  input: { dataUrl: string; filename: string },
): Promise<{ ok: boolean; filename?: string; error?: string }> {
  const res = await fetch(`${API_URL}/admin/hold-music`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error) : `HTTP ${res.status}`,
    };
  }
  return body as { ok: boolean; filename?: string };
}
export async function clearTenantHoldMusic(token: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/admin/hold-music`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error) : `HTTP ${res.status}`,
    };
  }
  return body as { ok: boolean };
}

// v0.10.47 — Daily activity summary for the "Yesterday's activity"
// banner. Counts are scoped to the authenticated user (no admin gate).
export interface ActivitySummary {
  ok: boolean;
  since?: string;
  until?: string;
  missedCalls?: number;
  newSms?: number;
  voicemails?: number;
  error?: string;
}
export async function getActivitySummary(
  token: string,
  args: { since: Date; until: Date },
): Promise<ActivitySummary> {
  const q = new URLSearchParams({
    since: args.since.toISOString(),
    until: args.until.toISOString(),
  });
  const res = await fetch(`${API_URL}/me/activity-summary?${q.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as ActivitySummary;
  if (!res.ok) {
    return {
      ok: false,
      error: typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`,
    };
  }
  return body;
}

// v0.10.37 — Unified "Migrate user from Pulse" wizard. One endpoint that
// logs into Pulse, creates the ACE user, rebinds the DID, and runs the
// 30-day backfill — all in one call. Password is sent once over HTTPS,
// used once on the server, never persisted.
export interface MigrateFromPulseInput {
  pulseEmail: string;
  pulsePassword: string;
  isAdmin?: boolean;
  daysBack?: number;
  // v0.10.58 — Optional manual DID override. When provided, the migration
  // ignores whatever number Pulse has on the user's profile and uses this
  // value for the Telnyx lookup. Use case: Pulse data is stale / wrong.
  // Accepts E.164, 11-digit, 10-digit US, or formatted strings — server
  // normalizes to E.164.
  didOverride?: string;
  // v0.10.64 — Country for Telnyx anchorsite selection.
  // 'IN' → Chennai (low latency for the 95% India team)
  // anything else → 'Latency' (Telnyx picks per-call)
  // Default 'IN' if omitted by the client.
  country?: string;
}
export interface MigrateFromPulseResult {
  ok: boolean;
  user?: AdminUserRow;
  pulseUserId?: number;
  didNumber?: string;
  sipUsername?: string;
  callsInserted?: number;
  callsSkipped?: number;
  messagesInserted?: number;
  messagesSkipped?: number;
  backfillErrors?: string[];
  durationMs?: number;
  steps?: Array<{ step: string; ok: boolean; error?: string }>;
  error?: string;
  // v0.10.81 — Migration debug. Populated when Telnyx says it doesn't own
  // the primary voip_number. Surfaces the OTHER phone-shaped fields the
  // Pulse JWT contained, with each one's Telnyx ownership status, so admin
  // doesn't have to SQL-spelunk Pulse for the right DID.
  phoneCandidates?: Array<{
    /** Which Pulse JWT field this came from: voip_number, mobile_no, etc. */
    field: string;
    /** Raw value as Pulse stored it (formatting preserved for the admin). */
    raw: string;
    /** Our E.164 normalization, used for Telnyx lookup + retry. */
    e164: string;
    /** Ownership result: owned by us, not on Telnyx, or API blew up. */
    telnyxStatus: 'owned' | 'not_found' | 'error';
  }>;
  // v0.10.82 — Populated on the "DID already in ACE" failure path. Tells
  // admin WHO already owns the DID so they don't have to look up the user
  // ID separately. sameAsTarget=true means it's a prior failed attempt
  // for the same person (admin can delete + retry).
  existingOwner?: {
    userId: number;
    email: string;
    firstName: string | null;
    lastName: string | null;
    isActive: boolean;
    sameAsTarget: boolean;
  } | null;
}
export async function migrateUserFromPulse(
  token: string,
  input: MigrateFromPulseInput,
): Promise<MigrateFromPulseResult> {
  const res = await fetch(`${API_URL}/admin/users/migrate-from-pulse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as MigrateFromPulseResult;
  if (!res.ok) {
    return {
      ok: false,
      error: typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`,
      steps: 'steps' in body ? (body as { steps?: MigrateFromPulseResult['steps'] }).steps : undefined,
    };
  }
  return body;
}

// v0.10.38 — Per-user "Refresh from Pulse" — kebab-menu button. Backend
// resolves the user's pulseUserId from the audit log + their default DID.
// Optional pulseUserPassword unlocks call refresh too; without it, only SMS.
export interface RefreshFromPulseInput {
  pulseUserPassword?: string;
  daysBack?: number;
  // v0.10.39 — Manual override for pre-wizard ACE users (no audit log
  // entry yet with their Pulse user_id). Used once seeds the mapping.
  pulseUserIdOverride?: number;
  // v0.10.40 — Pick WHICH of the user's ACE lines this history attaches
  // to. Defaults server-side to the user's isDefault DID if omitted.
  userDidId?: number;
}
export interface RefreshFromPulseResult {
  ok: boolean;
  userId?: number;
  userEmail?: string;
  pulseUserId?: number;
  didNumber?: string;
  callsRequested?: boolean;
  callsInserted?: number;
  callsSkipped?: number;
  messagesInserted?: number;
  messagesSkipped?: number;
  errors?: string[];
  durationMs?: number;
  error?: string;
  // v0.10.41 — Diagnostic counts straight from Pulse MySQL. Lets admin
  // distinguish "Pulse has 0 SMS for this user" from "Pulse has SMS but
  // our query isn't catching them". null when Pulse DB unreachable.
  pulseCounts?: {
    totalAllTime: number;
    totalSms: number;
    smsLastNDays: number;
  } | null;
}
export async function refreshUserFromPulse(
  token: string,
  userId: number,
  input: RefreshFromPulseInput = {},
): Promise<RefreshFromPulseResult> {
  const res = await fetch(`${API_URL}/admin/users/${userId}/refresh-from-pulse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as RefreshFromPulseResult;
  if (!res.ok) {
    return {
      ok: false,
      error: typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`,
    };
  }
  return body;
}

// v0.10.38 — Bulk-refresh SMS for all migrated users. SMS only (calls
// would require per-user passwords we don't store).
export interface BulkRefreshPulseSmsInput {
  daysBack?: number;
  maxUsers?: number;
}
export interface BulkRefreshPulseSmsResult {
  ok: boolean;
  totalUsers: number;
  totalUsersInRegistry?: number;
  totalCallsInserted: number;
  totalMessagesInserted: number;
  totalDurationMs: number;
  results: Array<{
    userId: number;
    email: string;
    pulseUserId: number;
    didNumber: string | null;
    callsInserted: number;
    callsSkipped: number;
    messagesInserted: number;
    messagesSkipped: number;
    errors: string[];
    durationMs: number;
    skipped?: string;
  }>;
  note?: string;
  error?: string;
}
export async function bulkRefreshPulseSms(
  token: string,
  input: BulkRefreshPulseSmsInput = {},
): Promise<BulkRefreshPulseSmsResult> {
  const res = await fetch(`${API_URL}/admin/users/bulk-refresh-pulse-sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as BulkRefreshPulseSmsResult;
  if (!res.ok) {
    return {
      ok: false,
      totalUsers: 0,
      totalCallsInserted: 0,
      totalMessagesInserted: 0,
      totalDurationMs: 0,
      results: [],
      error: typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`,
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
  // v0.10.60 — Per-user beta opt-in for Connection Health.
  connectionHealthBeta?: boolean;
  // v0.10.64 — Country tag (IN / US / Other) for Telnyx anchorsite.
  country?: string | null;
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
  // v0.10.92 — Message quality merged into the same report. Frontend
  // renders this in the same Quality & Health page alongside calls.
  messages?: {
    totalMessages: number;
    byStatus: Record<string, number>;
    outboundCount: number;
    outboundFailures: number;
    outboundDeliveryRate: number;
    failureCauses: Array<{
      cause: string;
      count: number;
      samples: Array<{
        id: number;
        toNumber: string;
        sentAt: string;
        errorCode: string | null;
      }>;
    }>;
  };
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

// v0.10.20 — "Migrate Existing User to New Dialer" flow.
//
// MigrationCandidate is a Telnyx DID currently bound to ANOTHER connection
// (likely Pulse). Admin re-binds it to a target ACE user via migrateDidToUser.
export interface MigrationCandidate {
  id: string;
  phoneNumber: string;              // E.164
  areaCode: string | null;
  status: string;
  sourceConnectionId: string;       // Connection it's currently on (Pulse).
  // v0.10.20 — enriched server-side for picker readability.
  connectionName: string | null;
  sipUsername: string | null;
  messagingProfileId: string | null;
  regionLabel: string | null;
}
export async function listMigrationCandidates(
  token: string,
): Promise<MigrationCandidate[]> {
  const res = await fetch(`${API_URL}/admin/telnyx/migration-candidates`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { items: MigrationCandidate[] };
  return body.items ?? [];
}

export interface MigrateDidResult {
  ok: boolean;
  userDid?: {
    id: number;
    didNumber: string;
    label: string;
    colorHex: string;
    isDefault: boolean;
  };
  previousConnectionId?: string;
  error?: string;
}
// v0.10.22 — Microsoft Graph OAuth for the ACE Bot Teams notifier.
// Tenant-wide admin setting: connect once via the OAuth flow, then all
// Teams DMs (line_assigned, missed_call, voicemail, SMS) route through
// Microsoft Graph using the acebot@aptask.com service account's refresh
// token. Status endpoint shows whether we're connected and when tokens
// were last refreshed.
export interface MsGraphStatus {
  connected: boolean;
  account?: string;
  expiresAt?: string;             // ISO timestamp (access token expiry)
  lastRefreshAt?: string;
}
export async function getMsGraphStatus(token: string): Promise<MsGraphStatus> {
  const res = await fetch(`${API_URL}/admin/microsoft/oauth/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MsGraphStatus;
}
export async function initiateMsGraphConnect(
  token: string,
): Promise<{ redirectUrl: string }> {
  const res = await fetch(`${API_URL}/admin/microsoft/oauth/initiate`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as { redirectUrl: string };
}
export async function disconnectMsGraph(token: string): Promise<void> {
  const res = await fetch(`${API_URL}/admin/microsoft/oauth/disconnect`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// v0.10.21 — "What to do with the old SIP connection?" cleanup prompt that
// fires after a successful migration. Two actions:
//   action: 'deactivate' — PATCH active=false (reversible)
//   action: 'delete'     — DELETE the credential connection (IRREVERSIBLE)
// Backend refuses if any UserDid still references this connectionId.
export interface CleanupConnectionResult {
  ok: boolean;
  action?: 'deactivate' | 'delete';
  error?: string;
}
export async function cleanupTelnyxConnection(
  token: string,
  connectionId: string,
  action: 'deactivate' | 'delete',
  reason?: string,
): Promise<CleanupConnectionResult> {
  const res = await fetch(
    `${API_URL}/admin/telnyx/connections/${encodeURIComponent(connectionId)}/cleanup`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
    },
  );
  const body = (await res.json().catch(() => ({}))) as CleanupConnectionResult;
  if (!res.ok) {
    return { ok: false, error: body.error ?? `HTTP ${res.status}` };
  }
  // Spread body first, then force ok: true so the server's "ok" can't override us.
  return { ...body, ok: true };
}

export async function migrateDidToUser(
  token: string,
  userId: number,
  input: {
    didNumber: string;
    label: string;
    colorHex: string;
    isDefault?: boolean;
  },
): Promise<MigrateDidResult> {
  const res = await fetch(`${API_URL}/admin/users/${userId}/dids/migrate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as MigrateDidResult;
  if (!res.ok) {
    return { ok: false, error: body.error ?? `HTTP ${res.status}` };
  }
  // Spread first, then force ok: true so the server's "ok" can't override us
  // if it ever returned an unexpected value.
  return { ...body, ok: true };
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
// ──────────────────────────────────────────────────────────────────────
// v0.10.101 — Device heartbeat + admin device management.
// ──────────────────────────────────────────────────────────────────────
export interface HeartbeatResult {
  ok: boolean;
  forceUpdate: boolean;
  forceUpdateRequestedAt: string | null;
}

export async function sendHeartbeat(
  token: string,
  payload: { deviceId: string; platform: string; appVersion: string; osLabel?: string | null },
): Promise<HeartbeatResult> {
  const res = await fetch(`${API_URL}/me/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function ackForceUpdate(token: string, deviceId: string): Promise<void> {
  await fetch(`${API_URL}/me/heartbeat/ack-update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId }),
  });
}

export interface UserDeviceRow {
  id: number;
  deviceId: string;
  platform: string;
  appVersion: string;
  osLabel: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  forceUpdateRequestedAt: string | null;
  forceUpdateAckedAt: string | null;
}

export async function getUserDevices(token: string, userId: number): Promise<UserDeviceRow[]> {
  const res = await fetch(`${API_URL}/admin/users/${userId}/devices`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { devices: UserDeviceRow[] };
  return j.devices;
}

export async function requestDeviceForceUpdate(
  token: string,
  userId: number,
  deviceId: string,
): Promise<void> {
  const res = await fetch(
    `${API_URL}/admin/users/${userId}/devices/${encodeURIComponent(deviceId)}/force-update`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}
