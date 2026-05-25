// Telnyx Number / Credential Connection helpers — used by the on-demand
// invite endpoint (POST /admin/pending-users/:id/invite). All functions
// are PURE WRAPPERS around the Telnyx v2 REST API; they make NO calls
// until the invite endpoint explicitly invokes them.
//
// Docs:
//   Numbers:               https://developers.telnyx.com/api/numbers
//   Available numbers:     https://developers.telnyx.com/api/numbers/search-numbers
//   Number orders:         https://developers.telnyx.com/api/numbers/create-number-order
//   Credential connections https://developers.telnyx.com/api/connections/list-credential-connections
//
// Why this lives separate from callControl.ts:
//   • callControl.ts handles per-CALL operations (dial, hangup, transfer)
//   • numbers.ts handles per-USER provisioning (buy DID, create cred conn)
//   • Same TelnyxResult<T> shape, same auth, same BASE — just different surface
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

const BASE = 'https://api.telnyx.com/v2';

export interface TelnyxResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: unknown;
}

async function call<T = unknown>(path: string, init: RequestInit): Promise<TelnyxResult<T>> {
  if (!config.telnyxApiKey) {
    return { ok: false, status: 0, error: 'TELNYX_API_KEY not set' };
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.telnyxApiKey}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, ...(res.ok ? { data: body } : { error: body }) };
}

// ─────────────────────────── Types we expect back ────────────────────────────

export interface AvailableNumber {
  phone_number: string;          // E.164 — e.g. "+17325551234"
  phone_number_type: string;     // "local" | "toll_free" | "mobile" | ...
  cost_information?: {
    currency: string;            // "USD"
    upfront_cost: string;        // "0.45"
    monthly_cost: string;        // "0.45"
  };
  region_information?: Array<{
    region_type: string;         // "state" | "rate_center" | "country_code" | ...
    region_name: string;
  }>;
  reservable: boolean;
}

export interface PhoneNumber {
  id: string;                    // Telnyx-internal number id (used in PATCH)
  phone_number: string;          // E.164
  connection_id?: string;        // SIP Connection currently routing this number
  messaging_profile_id?: string; // Messaging Profile currently handling SMS
  status: string;                // "active" | "pending" | ...
  region_information?: Array<{ region_name?: string; region_type?: string }>;
}

export interface CredentialConnection {
  id: string;                    // Telnyx-internal connection id
  connection_name: string;
  user_name: string;             // SIP REGISTER username
  password?: string;             // present on create response; redacted on subsequent reads
  webhook_event_url?: string;
  active: boolean;
}

interface ListResponse<T> {
  data: T[];
  meta?: { total_results?: number; total_pages?: number };
}

interface SingleResponse<T> {
  data: T;
}

// ──────────────────────────── 1. Search numbers ──────────────────────────────

/**
 * Find available US local numbers in a given area code.
 * Returns up to 10 candidates with pricing and region info.
 *
 * Called by the invite endpoint when the admin picks "new DID" — we surface
 * the first candidate (or let the UI show choices if needed). Read-only:
 * does NOT reserve or purchase anything.
 */
export function searchAvailableLocal(
  areaCode: string,
  limit = 10,
): Promise<TelnyxResult<ListResponse<AvailableNumber>>> {
  const qs = new URLSearchParams({
    'filter[country_code]': 'US',
    'filter[national_destination_code]': areaCode,
    'filter[phone_number_type]': 'local',
    'filter[features][]': 'voice',
    'filter[limit]': String(limit),
  });
  return call(`/available_phone_numbers?${qs.toString()}`, { method: 'GET' });
}

// ──────────────────────────── 2. Purchase a DID ─────────────────────────────

/**
 * Order a specific phone number. Telnyx fulfills synchronously for
 * already-reservable US numbers (returns 'success' status with the new
 * phone_number resource embedded in `phone_numbers[0]`).
 *
 * This is a BILLABLE call — only fire from the invite endpoint after
 * the admin clicks Confirm.
 */
export interface NumberOrder {
  id: string;
  status: string;                              // "success" | "pending" | "failure"
  phone_numbers: Array<{
    id: string;
    phone_number: string;
    status: string;
  }>;
}
export function purchaseDid(
  phoneNumber: string,
  connectionId?: string,                       // optional: assign to this connection at order time
): Promise<TelnyxResult<SingleResponse<NumberOrder>>> {
  const body: Record<string, unknown> = {
    phone_numbers: [{ phone_number: phoneNumber }],
  };
  if (connectionId) body.connection_id = connectionId;
  return call('/number_orders', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ───────────────────────── 3. Look up a number we own ───────────────────────

/**
 * Find a phone number we already own by its E.164 string. Returns the
 * Telnyx-internal `id` we need for PATCH operations (e.g. reroute the
 * number to a different Connection).
 *
 * Used by the invite endpoint in the "use existing DID + reroute" path
 * to flip the user's Pulse DID over to ACE's Connection.
 */
export async function findNumberByE164(
  phoneNumber: string,
): Promise<TelnyxResult<PhoneNumber | null>> {
  const qs = new URLSearchParams({
    'filter[phone_number]': phoneNumber,
    'page[size]': '1',
  });
  const res = await call<ListResponse<PhoneNumber>>(`/phone_numbers?${qs.toString()}`, {
    method: 'GET',
  });
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  const first = res.data?.data?.[0] ?? null;
  return { ok: true, status: res.status, data: first };
}

// ─────────────────── 4. Assign DID to a SIP Connection ──────────────────────

/**
 * Route a phone number to a Credential Connection. Inbound calls to this
 * number will hit whatever client is registered against that connection.
 *
 * For "use existing DID + repoint webhook" path, callers will:
 *   1) findNumberByE164(pulseVoipNumber) → get number id
 *   2) assignDidToConnection(numberId, aceConnectionId)  ← this
 *   3) patchConnectionWebhook(aceConnectionId, ACE_WEBHOOK_URL)
 */
export function assignDidToConnection(
  numberId: string,
  connectionId: string,
): Promise<TelnyxResult<SingleResponse<PhoneNumber>>> {
  return call(`/phone_numbers/${numberId}`, {
    method: 'PATCH',
    body: JSON.stringify({ connection_id: connectionId }),
  });
}

/**
 * Bind a number to ACE's Messaging Profile so inbound SMS flows to ACE's
 * messaging webhook. Called from the invite flow regardless of which DID
 * mode the admin picked — by the time the user logs in, their texts
 * should arrive in ACE, not the old dialer.
 */
export function assignNumberMessagingProfile(
  numberId: string,
  messagingProfileId: string,
): Promise<TelnyxResult<SingleResponse<PhoneNumber>>> {
  return call(`/phone_numbers/${numberId}`, {
    method: 'PATCH',
    body: JSON.stringify({ messaging_profile_id: messagingProfileId }),
  });
}

// ───────────────────── 5. Look up a Credential Connection ───────────────────

/**
 * Find a Credential Connection by its display name (the `connection_name`
 * field in Telnyx). The CSV's `connection_name` column lets us find each
 * Pulse user's connection without storing the Telnyx id ahead of time.
 *
 * Returns null if not found.
 */
export async function findConnectionByName(
  connectionName: string,
): Promise<TelnyxResult<CredentialConnection | null>> {
  const qs = new URLSearchParams({
    'filter[connection_name]': connectionName,
    'page[size]': '5',
  });
  const res = await call<ListResponse<CredentialConnection>>(
    `/credential_connections?${qs.toString()}`,
    { method: 'GET' },
  );
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  // Telnyx filter is a prefix/contains match — be strict about exact name.
  const exact = (res.data?.data ?? []).find((c) => c.connection_name === connectionName) ?? null;
  return { ok: true, status: res.status, data: exact };
}

// ───────────────────── 6. Create a Credential Connection ────────────────────

/**
 * Generate a secure random SIP password.
 * 18 bytes of URL-safe base64 → 24-char password, no shell-escape concerns
 * for `:` or `@` or other URL-reserved chars.
 */
export function generateSipPassword(): string {
  return randomBytes(18)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Create a fresh Telnyx Credential Connection. Used by the invite endpoint
 * when the admin picks "generate new SIP creds" (instead of reusing the
 * Pulse `voip_ext` + `ext_password`).
 *
 * `connectionName` becomes the human-readable label in the Telnyx dashboard
 * (use the user's first name or email-local for clarity). `userName`
 * becomes the SIP REGISTER username the dialer logs in with. If you don't
 * pass a `password`, we generate a secure one and include it in the response.
 *
 * webhookEventUrl defaults to ACE's webhook so new connections route call
 * events to our backend. Override if testing.
 */
export interface CreateCredentialConnectionInput {
  connectionName: string;
  userName: string;
  password?: string;             // optional — auto-generated if missing
  webhookEventUrl?: string;      // optional — defaults to config.telnyxWebhookUrl
}
export function createCredentialConnection(
  input: CreateCredentialConnectionInput,
): Promise<TelnyxResult<SingleResponse<CredentialConnection>>> {
  const password = input.password ?? generateSipPassword();
  const body: Record<string, unknown> = {
    connection_name: input.connectionName,
    user_name: input.userName,
    password,
    // Sensible ACE defaults so new connections behave like the existing
    // `ace-dialer` connection: latency-optimized routing, Krisp noise
    // suppression, encrypted media. Mirrors what we observed in the
    // Telnyx probe of the existing ACE connection.
    anchorsite_override: 'Latency',
    encrypted_media: 'SRTP',
    webhook_api_version: '2',
    webhook_event_url: input.webhookEventUrl ?? config.telnyxWebhookUrl ?? '',
  };
  return call('/credential_connections', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ─────────────────── 7. Repoint a connection's webhook URL ──────────────────

/**
 * PATCH a Credential Connection's webhook URL. Used by the invite endpoint
 * for the "repoint webhook to ACE" toggle — flips a Pulse user's connection
 * from pulse.aptask.com → ace-dialer-webhooks.onrender.com so call events
 * start flowing into ACE's database instead of Pulse.
 *
 * This is the "instant cutover" lever: once we PATCH this, Pulse stops
 * receiving call events for the user (their dialer still REGISTERs, but
 * Pulse can't log anything because no webhook fires their way).
 */
export function patchConnectionWebhook(
  connectionId: string,
  newWebhookUrl: string,
): Promise<TelnyxResult<SingleResponse<CredentialConnection>>> {
  return call(`/credential_connections/${connectionId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      webhook_event_url: newWebhookUrl,
      webhook_api_version: '2',
    }),
  });
}

// ───────────────────────── 8. Utility — area code from E.164 ────────────────

/**
 * Extract the 3-digit US area code from an E.164-ish phone number.
 *   "+17325551234" → "732"
 *   "7325551234"   → "732"
 *   "+44..."       → null   (non-US)
 * Used to pass to searchAvailableLocal() when the admin picks "new DID"
 * and we want to match the user's existing Pulse area code.
 */
export function extractUsAreaCode(phoneNumber: string): string | null {
  const digits = phoneNumber.replace(/[^\d]/g, '');
  // US numbers in E.164 are 11 digits starting with '1' (or 10 if no country code)
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1, 4);
  if (digits.length === 10) return digits.slice(0, 3);
  return null;
}

// ───────────── 9. List unassigned numbers we already own ──────────────────

/**
 * Returns Telnyx phone numbers we own that are NOT currently routed to any
 * voice connection AND not bound to any messaging profile. Lets the admin
 * pick from the existing inventory instead of buying a new DID — useful
 * when ApTask has previously ported in numbers or has leftover inventory.
 *
 * Paginates through /v2/phone_numbers and filters client-side; Telnyx
 * doesn't expose a server-side "connection_id is null" filter.
 */
export interface UnassignedNumber {
  id: string;
  phoneNumber: string;
  areaCode: string | null;
  status: string;
  regionLabel: string | null;
}

export async function listUnassignedNumbers(): Promise<TelnyxResult<UnassignedNumber[]>> {
  const out: UnassignedNumber[] = [];
  let page = 1;
  const pageSize = 250;            // Telnyx max
  // Hard cap pages so we don't loop forever on a huge inventory.
  const MAX_PAGES = 8;

  while (page <= MAX_PAGES) {
    const qs = new URLSearchParams({
      'page[number]': String(page),
      'page[size]': String(pageSize),
    });
    const res = await call<ListResponse<PhoneNumber>>(
      `/phone_numbers?${qs.toString()}`,
      { method: 'GET' },
    );
    if (!res.ok) return { ok: false, status: res.status, error: res.error };
    const batch = res.data?.data ?? [];

    for (const n of batch) {
      // Truly unassigned: no voice connection AND no messaging profile.
      if (!n.connection_id && !n.messaging_profile_id) {
        out.push({
          id: n.id,
          phoneNumber: n.phone_number,
          areaCode: extractUsAreaCode(n.phone_number),
          status: n.status,
          regionLabel: n.region_information?.[0]?.region_name ?? null,
        });
      }
    }

    // Stop when we've gone past the last page.
    const totalPages = res.data?.meta?.total_pages ?? page;
    if (batch.length < pageSize || page >= totalPages) break;
    page += 1;
  }

  // Sort by area code so the dropdown is predictable.
  out.sort((a, b) => (a.areaCode ?? 'zzz').localeCompare(b.areaCode ?? 'zzz'));
  return { ok: true, status: 200, data: out };
}
