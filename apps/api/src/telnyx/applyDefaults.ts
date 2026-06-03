// v0.10.64 — ACE Telnyx defaults helpers.
//
// Centralizes the "every new or migrated user's Telnyx config must look
// like THIS" rules in one place. Two surfaces:
//
//   applyAceConnectionDefaults(connectionId, country)
//     Tunes the Credential Connection AFTER it's created from the template.
//     Most settings (audio enhancements, codecs, channel limits, SRTP,
//     SHAKEN/STIR, etc.) come from the template clone in
//     createConnectionFromTemplate. This helper applies the few per-user
//     overrides the template can't provide — namely anchorsite based on
//     the user's country.
//
//   applyAcePhoneNumberDefaults(numberId)
//     Tunes the phone_number resource AFTER it's been routed to a
//     Credential Connection. Sets HD voice, CNAM listing (caller ID name
//     = "ApTask"), voicemail enabled, voicemail PIN = "12345".
//     These are NOT part of the credential connection clone — they live
//     on the phone_number resource and must be PATCHed separately.
//
// Both functions are best-effort: they LOG warnings on failure but never
// throw. The user is already created at the point we call these, so a
// Telnyx config hiccup shouldn't roll back the migration; admin can use
// the future "Re-apply ACE Telnyx defaults" button to retry.

import { config } from '../config.js';

interface PatchResult {
  ok: boolean;
  status: number;
  detail?: unknown;
}

/**
 * Internal helper — single Telnyx PATCH with the API key + body.
 * Returns a flat ok/status/detail so callers can log without throwing.
 */
async function telnyxPatch(path: string, body: Record<string, unknown>): Promise<PatchResult> {
  if (!config.telnyxApiKey) {
    return { ok: false, status: 0, detail: 'TELNYX_API_KEY missing' };
  }
  try {
    const res = await fetch(`https://api.telnyx.com/v2${path}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.telnyxApiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, status: res.status, detail: txt };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Translate ACE's User.country code to a Telnyx anchorsite_override value.
 *
 * Telnyx's anchorsite_override accepts named sites ("Chennai", "Mumbai",
 * "Ashburn, VA", etc.) or the special "Latency" routing token that picks
 * the closest site dynamically. Our policy: India users → Chennai (lowest
 * latency for the 95% in-country); everyone else → "Latency" (Telnyx
 * picks per-call). Two-letter ISO codes accepted, case-insensitive.
 */
export function anchorsiteForCountry(country: string | null | undefined): string {
  const c = (country ?? '').trim().toUpperCase();
  if (c === 'IN' || c === 'INDIA') return 'Chennai';
  return 'Latency';
}

/**
 * v0.10.64 — Apply per-user ACE defaults to a freshly-created Credential
 * Connection. Currently this just sets anchorsite_override based on
 * country (Chennai for India, Latency for everyone else). All other
 * settings — audio enhancements, codecs, channel limits, SRTP mandatory,
 * SHAKEN/STIR header, OPUS-first ordering, etc. — come from the template
 * clone in createConnectionFromTemplate and don't need to be re-applied
 * here.
 *
 * Returns the PATCH result so callers can include it in step logs. Never
 * throws.
 */
export async function applyAceConnectionDefaults(
  connectionId: string,
  country: string | null | undefined,
): Promise<PatchResult> {
  const anchor = anchorsiteForCountry(country);
  return telnyxPatch(`/credential_connections/${connectionId}`, {
    anchorsite_override: anchor,
  });
}

/**
 * v0.10.64 — Apply per-DID ACE defaults to a phone number. Sets:
 *
 *   • hd_voice: true        — HD audio codec when both ends support
 *   • cnam_listing_enabled: true with cnam_listing_details: "ApTask"
 *                            (so caller-ID receivers see "ApTask" instead
 *                             of the raw number)
 *   • voicemail: enabled, pin "12345"
 *
 * Telnyx splits these settings across two sub-resources on phone_number:
 *  - /phone_numbers/:id/voice         → hd_voice
 *  - /phone_numbers/:id/voice         → cnam_listing fields
 *  - /phone_numbers/:id/voicemail     → voicemail enable + pin
 *
 * We submit them as separate PATCHes and report on each. A failure on
 * one doesn't block the others.
 *
 * NOTE: Voicemail PIN "12345" is a tenant-wide default per admin policy.
 * If you change the policy, update the constant below.
 */
const ACE_DEFAULT_VOICEMAIL_PIN = '12345';
const ACE_DEFAULT_CALLER_ID_NAME = 'ApTask';

export interface ApplyPhoneNumberDefaultsResult {
  voice: PatchResult;
  voicemail: PatchResult;
}

export async function applyAcePhoneNumberDefaults(
  numberId: string,
): Promise<ApplyPhoneNumberDefaultsResult> {
  // Voice (HD voice + CNAM listing) — single PATCH on the /voice sub-resource.
  const voice = await telnyxPatch(`/phone_numbers/${numberId}/voice`, {
    // Telnyx field name. HD voice means Opus or AMR-WB advertised in SDP.
    hd_voice_enabled: true,
    // CNAM (Caller ID Name) outbound display.
    // Two related fields exist on Telnyx; we set both so the field rename
    // in any future API version doesn't silently drop our setting.
    cnam_listing_enabled: true,
    cnam_listing_details: ACE_DEFAULT_CALLER_ID_NAME,
  });

  // Voicemail — separate sub-resource.
  const voicemail = await telnyxPatch(`/phone_numbers/${numberId}/voicemail`, {
    enabled: true,
    pin: ACE_DEFAULT_VOICEMAIL_PIN,
  });

  return { voice, voicemail };
}
