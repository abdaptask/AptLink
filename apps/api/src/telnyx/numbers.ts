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
 *
 * Telnyx splits voice and messaging settings across separate sub-resources.
 * The base /phone_numbers/:id PATCH only accepts voice-related fields
 * (connection_id, etc.) and rejects messaging_profile_id with error 10027.
 * The messaging settings live on /phone_numbers/:id/messaging — see
 * https://developers.telnyx.com/docs/api/v2/numbers/Number-Configurations#updatePhoneNumberWithMessagingSettings
 */
export function assignNumberMessagingProfile(
  numberId: string,
  messagingProfileId: string,
): Promise<TelnyxResult<SingleResponse<PhoneNumber>>> {
  return call(`/phone_numbers/${numberId}/messaging`, {
    method: 'PATCH',
    body: JSON.stringify({ messaging_profile_id: messagingProfileId }),
  });
}

/**
 * v0.9.7 — Un-assign a DID (clears connection_id, returns it to the
 * unassigned pool). Also clears messaging_profile_id via the /messaging
 * sub-endpoint. Idempotent. Used by the delete-invited-user cleanup flow.
 */
export async function unassignNumber(numberId: string): Promise<TelnyxResult<unknown>> {
  // Clear voice connection
  const voice = await call(`/phone_numbers/${numberId}`, {
    method: 'PATCH',
    body: JSON.stringify({ connection_id: null }),
  });
  if (!voice.ok) return voice;
  // Clear messaging profile (separate sub-resource)
  return call(`/phone_numbers/${numberId}/messaging`, {
    method: 'PATCH',
    body: JSON.stringify({ messaging_profile_id: null }),
  });
}

/**
 * v0.9.7 — Delete a Telnyx Credential Connection. Used by the delete-
 * invited-user cleanup flow. The DID assigned to it MUST be unassigned
 * first or Telnyx refuses (orphan DIDs).
 */
export function deleteCredentialConnection(
  connectionId: string,
): Promise<TelnyxResult<unknown>> {
  return call(`/credential_connections/${connectionId}`, { method: 'DELETE' });
}

/**
 * v0.10.21 — Deactivate a Credential Connection without deleting it.
 * Sets active=false. SIP REGISTER from that connection's credentials stops
 * working immediately. Reversible — can be PATCH'd back to active=true.
 *
 * Used by the "deactivate-or-delete after migration" admin prompt: after
 * a DID is re-bound from Pulse to ACE, the admin chooses whether the old
 * Pulse Credential Connection should be deactivated (recoverable) or
 * deleted (irreversible).
 */
export function deactivateCredentialConnection(
  connectionId: string,
): Promise<TelnyxResult<SingleResponse<FullCredentialConnection>>> {
  return call(`/credential_connections/${connectionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false }),
  });
}

/**
 * v0.9.7 — Fetch the FULL config of a single Credential Connection by id.
 * Used as the "template" probe: at invite time we read the working
 * `ace-dialer` connection (the one Abdulla uses today) and mirror its
 * settings on every new connection — so new users get a fully-configured
 * SIP endpoint without any admin guesswork.
 *
 * v0.9.11 — expanded to cover EVERY field Telnyx returns on
 *   GET /v2/credential_connections/:id so the template clone can be
 *   byte-for-byte except for per-user identity (connection_name, user_name,
 *   password) and the user's own DID for ani_override. The critical fields
 *   the previous version was silently dropping:
 *     • sip_uri_calling_preference  (the "Receive SIP URI calls" toggle)
 *     • outbound.encrypted_media    (mislabelled — actually lives on outbound)
 *     • outbound.ani_override       ("Caller ID Override" — set per-user)
 *     • outbound.ani_override_type  (must be "always" for the override to show)
 *     • outbound.localization
 *     • outbound.t38_reinvite_source
 *     • outbound.instant_ringback_enabled
 *     • inbound.dnis_number_format / isup_headers_enabled / sip_region
 *     • inbound.generate_ringback_tone / timeout_1xx_secs / timeout_2xx_secs
 *     • inbound.shaken_stir_enabled
 *     • rtcp_settings (full)
 *     • dtmf_type / send_invite_to_url / active / default_routing_method
 *     • transport_protocol
 */
export interface FullCredentialConnection {
  id: string;
  connection_name: string;
  user_name: string;
  password?: string;
  active?: boolean;
  anchorsite_override?: string;
  // Top-level encrypted_media kept for backwards-compat with older Telnyx
  // payloads (current API surfaces it on outbound.encrypted_media instead).
  encrypted_media?: string | null;
  webhook_event_url?: string;
  webhook_api_version?: string;
  webhook_event_failover_url?: string;
  webhook_timeout_secs?: number | null;
  sip_uri_calling_preference?: string;     // "disabled" | "unrestricted" | "enabled" — Auth+Routing "Receive SIP URI calls"
  transport_protocol?: string;             // "UDP" | "TCP" | "TLS"
  default_routing_method?: string;         // "sequential" | "round-robin"
  dtmf_type?: string;                      // "RFC 2833" | "Inband" | "SIP INFO"
  send_invite_to_url?: boolean;
  ios_push_credential_id?: string | null;
  android_push_credential_id?: string | null;
  tags?: string[];
  inbound?: {
    codecs?: string[];
    channel_limit?: number;
    sip_subdomain?: string | null;
    sip_subdomain_receive_settings?: string;
    default_routing_method?: string;
    dnis_number_format?: string;
    isup_headers_enabled?: boolean;
    sip_region?: string;
    generate_ringback_tone?: boolean;
    timeout_1xx_secs?: number;
    timeout_2xx_secs?: number;
    shaken_stir_enabled?: boolean;
    ani_number_format?: string;
  };
  // v0.9.11+ — Telnyx "Audio Enhancements" sub-objects (Krisp Viva noise
  // suppression + jitter buffer). Live at the TOP LEVEL of the connection
  // resource, not under inbound. We don't enumerate the inner field names
  // here — Telnyx ships new options periodically (engine variants,
  // attenuation_limit, config: 'inbound_only' | 'outbound_only' | 'both',
  // etc.). The clone builder spreads the whole object so any field shape
  // works without code changes.
  noise_suppression?: Record<string, unknown>;
  jitter_buffer?: Record<string, unknown>;
  /// Catch-all for any field Telnyx adds in the future. The clone builder
  /// spreads safe fields (anything that isn't id/timestamps/identity) so
  /// new account-level features just work.
  [key: string]: unknown;
  outbound?: {
    outbound_voice_profile_id?: string;
    channel_limit?: number;
    ani_override?: string | null;
    ani_override_type?: string;            // "always" | "normal" | "never"
    localization?: string;
    t38_reinvite_source?: string;
    instant_ringback_enabled?: boolean;
    encrypted_media?: string | null;       // "SRTP" | "DTLS" | null
    generate_ringback_tone?: boolean;
  };
  rtcp_settings?: {
    port?: string;
    capture_enabled?: boolean;
    report_frequency_secs?: number;
  };
}

export function fetchCredentialConnection(
  connectionId: string,
): Promise<TelnyxResult<SingleResponse<FullCredentialConnection>>> {
  return call(`/credential_connections/${connectionId}`, { method: 'GET' });
}

// v0.10.21 — Generic connection lookup that works across all Telnyx connection
// types (credential, FQDN, IP, SIP). The /credential_connections/{id} endpoint
// returns 404 for non-credential connections, which made the migrate picker
// show "Unknown connection" for any DID bound to a different connection type.
// /connections/{id} works for ALL types — returns connection_name always,
// user_name only on credential connections (null for others).
export interface GenericConnection {
  id: string;
  connection_name: string;
  /** Only present on credential connections; null/undefined for FQDN/IP/SIP. */
  user_name?: string | null;
  /** Connection type — useful for showing in the picker. */
  connection_type?: string;
  active?: boolean;
  [key: string]: unknown;
}
export function fetchAnyConnection(
  connectionId: string,
): Promise<TelnyxResult<SingleResponse<GenericConnection>>> {
  return call(`/connections/${connectionId}`, { method: 'GET' });
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

/**
 * v0.9.7 — Resolve the template connection id from config. Prefers a
 * directly-configured TELNYX_TEMPLATE_CONNECTION_ID; otherwise looks up
 * TELNYX_TEMPLATE_CONNECTION_DID via findNumberByE164 → number.connection_id.
 * Returns null if neither is configured / the DID isn't routed to a
 * connection. Used by the invite + verify endpoints.
 */
export async function resolveTemplateConnectionId(): Promise<TelnyxResult<string | null>> {
  if (config.telnyxTemplateConnectionId) {
    return { ok: true, status: 200, data: config.telnyxTemplateConnectionId };
  }
  if (!config.telnyxTemplateConnectionDid) {
    return { ok: true, status: 200, data: null };
  }
  const lookup = await findNumberByE164(config.telnyxTemplateConnectionDid);
  if (!lookup.ok) return { ok: false, status: lookup.status, error: lookup.error };
  const connId = lookup.data?.connection_id ?? null;
  return { ok: true, status: 200, data: connId };
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
  // v0.9.7 — Optional template-derived overrides. When createConnectionFromTemplate
  // calls into here, it passes the working connection's outbound voice profile id
  // (CRITICAL — without it the user can't place calls) plus the anchorsite/
  // encrypted_media values it observed on the template. Telnyx accepts these in
  // the POST body; sub-object fields (inbound.codecs etc.) must be set via a
  // follow-up PATCH (see patchCredentialConnection).
  outboundVoiceProfileId?: string;
  anchorsiteOverride?: string;
  encryptedMedia?: string | null;
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
    // Telnyx probe of the existing ACE connection. Template overrides
    // (when provided by createConnectionFromTemplate) win.
    anchorsite_override: input.anchorsiteOverride ?? 'Latency',
    encrypted_media: input.encryptedMedia === null ? null : (input.encryptedMedia ?? 'SRTP'),
    webhook_api_version: '2',
    webhook_event_url: input.webhookEventUrl ?? config.telnyxWebhookUrl ?? '',
  };
  // outbound is a sub-object in the POST body; Telnyx accepts
  // outbound.outbound_voice_profile_id at create time.
  if (input.outboundVoiceProfileId) {
    body.outbound = { outbound_voice_profile_id: input.outboundVoiceProfileId };
  }
  return call('/credential_connections', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * v0.9.7 — Generic PATCH on a Credential Connection. Used after create to
 * apply sub-object settings (inbound.codecs, inbound.channel_limit,
 * outbound.channel_limit, etc.) that Telnyx rejects in the POST body but
 * accepts in a follow-up PATCH on /credential_connections/:id.
 *
 * Telnyx docs:
 *   https://developers.telnyx.com/api/connections/update-credential-connection
 */
export function patchCredentialConnection(
  connectionId: string,
  patch: Record<string, unknown>,
): Promise<TelnyxResult<SingleResponse<FullCredentialConnection>>> {
  return call(`/credential_connections/${connectionId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/**
 * v0.9.11 — small helper used by the template-clone PATCH builders. Returns
 * the value when it's defined, else `undefined` so the caller can drop the
 * key. Telnyx rejects unknown fields with HTTP 422; this filter prevents us
 * from accidentally sending `undefined` keys (which JSON.stringify drops
 * anyway, but more importantly it stops us from sending half-formed
 * sub-objects like { ani_override: undefined } which Telnyx may interpret
 * as "clear the field").
 */
export function cloneable<T>(value: T | undefined | null, options?: { allowNull?: boolean }): T | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return options?.allowNull ? null : undefined;
  return value;
}

/**
 * v0.9.11 — build an inbound sub-object that mirrors the template byte-for-
 * byte. Filters out undefined keys so we don't send junk to Telnyx.
 */
function buildInboundCloneFromTemplate(
  tpl: FullCredentialConnection,
): Record<string, unknown> {
  const inb: Record<string, unknown> = {};
  const src = tpl.inbound ?? {};
  if (src.codecs && src.codecs.length > 0) inb.codecs = src.codecs;
  if (typeof src.channel_limit === 'number') inb.channel_limit = src.channel_limit;
  // sip_subdomain CAN legitimately be null; pass it through so we preserve
  // template intent (e.g. template explicitly nulled the subdomain).
  if (src.sip_subdomain !== undefined) inb.sip_subdomain = src.sip_subdomain;
  if (src.sip_subdomain_receive_settings) {
    inb.sip_subdomain_receive_settings = src.sip_subdomain_receive_settings;
  }
  if (src.default_routing_method) inb.default_routing_method = src.default_routing_method;
  if (src.dnis_number_format) inb.dnis_number_format = src.dnis_number_format;
  if (typeof src.isup_headers_enabled === 'boolean') {
    inb.isup_headers_enabled = src.isup_headers_enabled;
  }
  if (src.sip_region) inb.sip_region = src.sip_region;
  if (typeof src.generate_ringback_tone === 'boolean') {
    inb.generate_ringback_tone = src.generate_ringback_tone;
  }
  if (typeof src.timeout_1xx_secs === 'number') inb.timeout_1xx_secs = src.timeout_1xx_secs;
  if (typeof src.timeout_2xx_secs === 'number') inb.timeout_2xx_secs = src.timeout_2xx_secs;
  if (typeof src.shaken_stir_enabled === 'boolean') {
    inb.shaken_stir_enabled = src.shaken_stir_enabled;
  }
  if (src.ani_number_format) inb.ani_number_format = src.ani_number_format;
  return inb;
}

/**
 * v0.9.11 — build an outbound sub-object that mirrors the template byte-for-
 * byte EXCEPT for ani_override which the caller can override per-user (so
 * each user's Caller ID Override is their OWN DID, not the template's).
 *
 * Pass `aniOverride` to set Caller ID Override; pass null to explicitly
 * clear it; omit to inherit the template's value verbatim.
 */
function buildOutboundCloneFromTemplate(
  tpl: FullCredentialConnection,
  overrides?: { aniOverride?: string | null },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = tpl.outbound ?? {};
  if (src.outbound_voice_profile_id) {
    out.outbound_voice_profile_id = src.outbound_voice_profile_id;
  }
  if (typeof src.channel_limit === 'number') out.channel_limit = src.channel_limit;

  // Caller ID Override — per-user. If the caller passed an explicit
  // aniOverride, use that; otherwise inherit the template's value (which
  // for the +17322001305 template is the template's own DID — usually NOT
  // what we want for a new user, hence the override).
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'aniOverride')) {
    out.ani_override = overrides.aniOverride ?? null;
  } else if (src.ani_override !== undefined) {
    out.ani_override = src.ani_override;
  }
  if (src.ani_override_type) out.ani_override_type = src.ani_override_type;
  if (src.localization) out.localization = src.localization;
  if (src.t38_reinvite_source) out.t38_reinvite_source = src.t38_reinvite_source;
  if (typeof src.instant_ringback_enabled === 'boolean') {
    out.instant_ringback_enabled = src.instant_ringback_enabled;
  }
  // encrypted_media nominally lives on the outbound sub-object in the
  // current Telnyx schema. Older payloads put it at the top level; we mirror
  // whichever the template surfaces.
  if (src.encrypted_media !== undefined) out.encrypted_media = src.encrypted_media;
  if (typeof src.generate_ringback_tone === 'boolean') {
    out.generate_ringback_tone = src.generate_ringback_tone;
  }
  return out;
}

/**
 * v0.9.11 — build the top-level (non-sub-object) clone fields from the
 * template. Excludes identity fields the caller MUST set per-user
 * (connection_name, user_name, password).
 */
function buildTopLevelCloneFromTemplate(
  tpl: FullCredentialConnection,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (tpl.anchorsite_override) body.anchorsite_override = tpl.anchorsite_override;
  // Top-level encrypted_media is the legacy location; preserve if Telnyx
  // returns it that way (otherwise we cover it via outbound.encrypted_media).
  if (tpl.encrypted_media !== undefined) body.encrypted_media = tpl.encrypted_media;
  if (tpl.webhook_event_url) body.webhook_event_url = tpl.webhook_event_url;
  if (tpl.webhook_api_version) body.webhook_api_version = tpl.webhook_api_version;
  if (tpl.webhook_event_failover_url !== undefined) {
    body.webhook_event_failover_url = tpl.webhook_event_failover_url;
  }
  if (tpl.webhook_timeout_secs !== undefined && tpl.webhook_timeout_secs !== null) {
    body.webhook_timeout_secs = tpl.webhook_timeout_secs;
  }
  if (tpl.sip_uri_calling_preference) {
    body.sip_uri_calling_preference = tpl.sip_uri_calling_preference;
  }
  if (tpl.transport_protocol) body.transport_protocol = tpl.transport_protocol;
  if (tpl.default_routing_method) body.default_routing_method = tpl.default_routing_method;
  if (tpl.dtmf_type) body.dtmf_type = tpl.dtmf_type;
  if (typeof tpl.send_invite_to_url === 'boolean') {
    body.send_invite_to_url = tpl.send_invite_to_url;
  }
  if (typeof tpl.active === 'boolean') body.active = tpl.active;
  if (tpl.rtcp_settings) {
    const rtcp: Record<string, unknown> = {};
    if (tpl.rtcp_settings.port) rtcp.port = tpl.rtcp_settings.port;
    if (typeof tpl.rtcp_settings.capture_enabled === 'boolean') {
      rtcp.capture_enabled = tpl.rtcp_settings.capture_enabled;
    }
    if (typeof tpl.rtcp_settings.report_frequency_secs === 'number') {
      rtcp.report_frequency_secs = tpl.rtcp_settings.report_frequency_secs;
    }
    if (Object.keys(rtcp).length > 0) body.rtcp_settings = rtcp;
  }

  // v0.9.12 — Audio Enhancements (Krisp + jitter buffer). Spread the WHOLE
  // sub-objects verbatim; Telnyx ships new fields in here periodically
  // (engine variants, attenuation_limit, etc.) and we don't want to drop
  // them. Confirmed on +17322001305: noise_suppression.engine =
  // "krisp_viva_tel_lite", config = "both", attenuation_limit slider, and
  // jitter_buffer { enabled, min_ms, max_ms }.
  if (tpl.noise_suppression && typeof tpl.noise_suppression === 'object') {
    body.noise_suppression = { ...tpl.noise_suppression };
  }
  if (tpl.jitter_buffer && typeof tpl.jitter_buffer === 'object') {
    body.jitter_buffer = { ...tpl.jitter_buffer };
  }

  // v0.9.12 — passthrough for any UNKNOWN top-level field Telnyx returns.
  // We never know in advance what new connection-level settings Telnyx will
  // launch. Spread anything not in this denylist so future features just
  // work without code changes. Denylist = identity + meta + sub-objects we
  // already handled above.
  const HANDLED_OR_META = new Set([
    'id', 'record_type', 'created_at', 'updated_at',
    'connection_name', 'user_name', 'password',
    'ios_push_credential_id', 'android_push_credential_id', 'tags',
    'anchorsite_override', 'encrypted_media', 'webhook_event_url',
    'webhook_api_version', 'webhook_event_failover_url', 'webhook_timeout_secs',
    'sip_uri_calling_preference', 'transport_protocol', 'default_routing_method',
    'dtmf_type', 'send_invite_to_url', 'active', 'rtcp_settings',
    'noise_suppression', 'jitter_buffer',
    'inbound', 'outbound',
  ]);
  for (const [k, v] of Object.entries(tpl)) {
    if (HANDLED_OR_META.has(k)) continue;
    if (v === undefined) continue;
    // Sub-objects: shallow-clone so callers can safely mutate.
    body[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as object) } : v;
  }

  return body;
}

/**
 * v0.9.11 — build the FULL clone PATCH body that mirrors the template
 * byte-for-byte, with optional per-user overrides for fields that should
 * differ per user (most importantly, ani_override → user's own DID).
 * Exported so the verify endpoint can reuse the exact same payload shape
 * to repair an already-invited user's connection.
 */
export function buildTemplateCloneBody(
  tpl: FullCredentialConnection,
  overrides?: { aniOverride?: string | null },
): Record<string, unknown> {
  const body = buildTopLevelCloneFromTemplate(tpl);
  const inb = buildInboundCloneFromTemplate(tpl);
  if (Object.keys(inb).length > 0) body.inbound = inb;
  const out = buildOutboundCloneFromTemplate(tpl, overrides);
  if (Object.keys(out).length > 0) body.outbound = out;
  // strip any explicit undefined values just in case (defence-in-depth)
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) delete body[k];
  }
  return body;
}

/**
 * v0.9.7 — Build a "clone of the proven-working connection" for a NEW user.
 *
 * v0.9.11 — REWRITTEN to copy EVERYTHING from the template (every field
 * Telnyx returns on GET /v2/credential_connections/:id), not just a handful.
 * Previously we were silently dropping sip_uri_calling_preference,
 * outbound.encrypted_media, outbound.localization, rtcp_settings, dtmf_type,
 * and a dozen other fields — which is why invited users were missing
 * "Receive SIP URI calls" + "Outbound encrypted media" + Caller ID Override
 * tabs in their Telnyx config.
 *
 * Pipeline:
 *   1. Fetch the template connection's full config.
 *   2. POST a new connection with the SAME identity-free body shape as the
 *      template (Telnyx accepts the full clone body at create time except
 *      for active/sip_uri_calling_preference on some account tiers — those
 *      are re-applied via PATCH).
 *   3. PATCH the new connection with the FULL clone body so any field the
 *      POST silently dropped gets re-stamped.
 *
 * If the template fetch fails, the caller should fall back to a plain
 * createCredentialConnection() and log a warning — never block the invite.
 *
 * NOTE: ani_override (Caller ID Override) is NOT set by this function. The
 * caller MUST follow up with setConnectionCallerIdOverride() once the
 * user's DID is known — that's the only field whose value depends on per-
 * user state (the user's DID), not on the template.
 */
export interface CreateConnectionFromTemplateInput {
  connectionName: string;
  userName: string;
  password?: string;
  templateConnectionId: string;
}
export interface CreateConnectionFromTemplateResult {
  ok: boolean;
  connection?: CredentialConnection;
  templateApplied: boolean;          // true when the PATCH step succeeded
  warnings: string[];
  error?: unknown;
}
export async function createConnectionFromTemplate(
  input: CreateConnectionFromTemplateInput,
): Promise<CreateConnectionFromTemplateResult> {
  const warnings: string[] = [];

  // Step 1 — fetch template
  const tplRes = await fetchCredentialConnection(input.templateConnectionId);
  if (!tplRes.ok || !tplRes.data) {
    return {
      ok: false,
      templateApplied: false,
      warnings: [`fetchCredentialConnection failed: ${JSON.stringify(tplRes.error)}`],
      error: tplRes.error,
    };
  }
  const tpl = tplRes.data.data;

  // Step 2 — POST new connection. Telnyx accepts most clone fields at create
  // time. We deliberately DO NOT set ani_override here (no per-user DID yet)
  // and we DO NOT set `active: false` even if the template is inactive
  // (a new connection should default to active=true so the user can REGISTER
  // immediately — admin can flip it off later if needed).
  //
  // Identity fields (connection_name, user_name, password) are set
  // separately. Everything else mirrors the template via the clone-body
  // helpers so we never silently drop a field.
  const password = input.password ?? generateSipPassword();
  const cloneBody = buildTemplateCloneBody(tpl);
  // POST must include identity fields. We also explicitly default
  // active=true so a deactivated template doesn't spawn deactivated users.
  const createBody: Record<string, unknown> = {
    ...cloneBody,
    connection_name: input.connectionName,
    user_name: input.userName,
    password,
    active: true,
  };
  // Telnyx requires webhook_api_version=2 if webhook_event_url is set;
  // belt-and-suspenders in case template lacked it.
  if (createBody.webhook_event_url && !createBody.webhook_api_version) {
    createBody.webhook_api_version = '2';
  }

  const createRes = await call<SingleResponse<CredentialConnection>>(
    '/credential_connections',
    { method: 'POST', body: JSON.stringify(createBody) },
  );
  if (!createRes.ok || !createRes.data) {
    return {
      ok: false,
      templateApplied: false,
      warnings,
      error: createRes.error,
    };
  }
  const newConn = createRes.data.data;

  // Step 3 — PATCH to re-stamp every clone field. Telnyx silently drops a
  // handful of sub-object fields from the POST body (varies by account
  // tier + API version); the PATCH catches the rest. We send the exact
  // same body shape as the POST (sans identity fields) so anything missed
  // gets corrected.
  const patchBody = buildTemplateCloneBody(tpl);
  let templateApplied = false;
  if (Object.keys(patchBody).length > 0) {
    const patchRes = await patchCredentialConnection(newConn.id, patchBody);
    if (patchRes.ok) {
      templateApplied = true;
    } else {
      warnings.push(`PATCH template settings failed: ${JSON.stringify(patchRes.error)}`);
    }
  } else {
    // Nothing to patch — POST already covered everything.
    templateApplied = true;
  }

  return { ok: true, connection: newConn, templateApplied, warnings };
}

/**
 * v0.9.11 — Set the Caller ID Override on a Credential Connection.
 *
 * The "Caller ID Override" field in the Telnyx Portal's Outbound tab maps
 * to `outbound.ani_override` on the connection (NOT to a field on the DID
 * itself — `PATCH /v2/phone_numbers/:id` does not accept caller_id_override
 * for credential connections).
 *
 * For ACE invited users we want the user's OWN DID to always be presented
 * as the caller ID on outbound calls placed via the WebRTC dialer, so:
 *   outbound.ani_override      = the user's E.164 DID (e.g. "+17325551234")
 *   outbound.ani_override_type = "always"
 *
 * Returns the Telnyx PATCH result so the caller can log success / error.
 */
export function setConnectionCallerIdOverride(
  connectionId: string,
  callerIdE164: string,
): Promise<TelnyxResult<SingleResponse<FullCredentialConnection>>> {
  return patchCredentialConnection(connectionId, {
    outbound: {
      ani_override: callerIdE164,
      ani_override_type: 'always',
    },
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

// v0.10.20 — "Migrate Existing User to New Dialer" flow.
//
// MigrationCandidate is a Telnyx DID that:
//   • HAS a connection_id set (currently routed somewhere — usually Pulse)
//   • Is NOT yet in ACE's UserDid table (caller filters that)
//
// The admin route GET /admin/telnyx/migration-candidates calls this, then
// cross-references against the local DB to drop any already-claimed DIDs.
export interface MigrationCandidate {
  id: string;                       // Telnyx number id (for PATCH later)
  phoneNumber: string;              // E.164
  areaCode: string | null;
  status: string;                   // "active" | "pending" | ...
  sourceConnectionId: string;       // The current connection — likely Pulse.
  // v0.10.20 — enriched server-side via fetchCredentialConnection so the
  // picker can show humanReadable identification ('Pulse: jdoe@aptask
  // (SIP user: aptask123)') instead of an opaque UUID.
  connectionName: string | null;
  sipUsername: string | null;
  messagingProfileId: string | null;
  regionLabel: string | null;
}

export async function listMigrationCandidates(): Promise<TelnyxResult<MigrationCandidate[]>> {
  const out: MigrationCandidate[] = [];
  let page = 1;
  const pageSize = 250;
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
      // Migration candidates: DIDs currently routed to ANY connection.
      // We don't try to identify "Pulse vs ACE" at this layer — admin route
      // strips out connection_ids that ACE already owns by checking the
      // local UserDid table.
      if (n.connection_id) {
        out.push({
          id: n.id,
          phoneNumber: n.phone_number,
          areaCode: extractUsAreaCode(n.phone_number),
          status: n.status,
          sourceConnectionId: n.connection_id,
          connectionName: null,        // enriched by admin route
          sipUsername: null,           // enriched by admin route
          messagingProfileId: n.messaging_profile_id ?? null,
          regionLabel: n.region_information?.[0]?.region_name ?? null,
        });
      }
    }

    const totalPages = res.data?.meta?.total_pages ?? page;
    if (batch.length < pageSize || page >= totalPages) break;
    page += 1;
  }

  out.sort((a, b) => (a.areaCode ?? 'zzz').localeCompare(b.areaCode ?? 'zzz'));
  return { ok: true, status: 200, data: out };
}
