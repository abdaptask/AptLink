// ===========================================================================
// v0.10.119 — TeXML voicemail flow (Phase 2 trial, +16467379912 only).
//
// Architecture (see docs/telnyx-call-control-setup.md → "TeXML voicemail"
// section for the user-facing summary):
//
//   PSTN caller dials a TeXML-migrated DID
//      │
//      ▼
//   Telnyx routes call to OUR TeXML Application
//   (Application's Voice URL → GET /texml/voicemail)
//      │
//      ▼  (we look up UserDid by 'to' query → know which user owns it)
//   Return TeXML:
//      <Response>
//        <Dial action="/texml/voicemail/dial-status"
//              timeout="25"
//              answerOnBridge="true">
//          <Sip>sip:<sipUsername>@sip.telnyx.com</Sip>
//        </Dial>
//      </Response>
//      │
//      ▼  (Telnyx tries the SIP <Sip> URI for up to 25 sec)
//   If picked up → call bridges, two-way audio, no further TeXML.
//   If no-answer / busy / failed → Telnyx POSTs DialCallStatus to
//   /texml/voicemail/dial-status, which returns Play + Record TeXML.
//      │
//      ▼
//   <Response>
//     <Play>https://<supabase>/voicemail-greetings/<file>.mp3</Play>  (or <Say> if no greeting)
//     <Record maxLength="120"
//             playBeep="true"
//             timeout="3"
//             trim="trim-silence"
//             action="/texml/voicemail/recording-complete" />
//   </Response>
//      │
//      ▼ Telnyx records → POSTs recording-complete with RecordingUrl
//   We reshape the payload and feed it into the same internal handler
//   that today's Hosted-VM 'calls.voicemail.completed' uses (Deepgram
//   transcription + Voicemail row insert + Call row "missed" upsert).
//
// Boot-time bootstrap:
//   On webhooks service startup, ensureTeXMLApp() POSTs to
//   /v2/texml_applications if no App ID is cached in the SystemConfig
//   table. Stores the resulting App ID under key 'telnyx.texml_vm.app_id'.
//   Admins reading the SystemConfig table can see the App ID; the admin
//   migration endpoint reads it from there too.
//
// Trial scope (locked to one DID until validation):
//   TEXML_TRIAL_DIDS env var = comma-separated E.164 allowlist. The admin
//   migration endpoint refuses to migrate a DID that isn't in this set.
//   For Phase 2 trial set TEXML_TRIAL_DIDS=+16467379912.
//
// Safety net:
//   We INTENTIONALLY leave Hosted Voicemail enabled on the DID when we
//   migrate to TeXML. Telnyx prefers TeXML if the App is reachable; if
//   our TeXML endpoint 5xx's or times out, Telnyx falls back to Hosted
//   VM with the default greeting. Better than a hangup beep.
// ===========================================================================

import { prisma } from '@ace/db';

const TELNYX_API = 'https://api.telnyx.com/v2';
const SYSTEM_CONFIG_KEY_APP_ID = 'telnyx.texml_vm.app_id';

// ---------------------------------------------------------------------------
// SystemConfig helpers — small key/value cache. value column is TEXT, so
// JSON-encode if you need structured values. Reads are uncached because
// the table is tiny and called at boot (rare path).
// ---------------------------------------------------------------------------
async function getSystemConfig(key: string): Promise<string | null> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function setSystemConfig(key: string, value: string, note?: string): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { key },
    update: { value, note },
    create: { key, value, note },
  });
}

// ---------------------------------------------------------------------------
// ensureTeXMLApp — at webhooks-service boot, make sure a Telnyx TeXML
// Application exists with our Voice URL configured. If we already have an
// ID cached in SystemConfig, verify it's still valid (GET the App). If it's
// gone or never existed, create a fresh one and cache the new ID.
//
// The Application's Voice URL points at this webhooks service. That URL
// must be publicly reachable by Telnyx's edge — set WEBHOOKS_PUBLIC_BASE_URL
// in env to override autodetection (always set this on Render — autodetect
// only works in dev with a localhost tunnel).
//
// Returns the App ID. Throws on misconfiguration (missing API key, missing
// public URL). Callers should catch and log rather than crash boot —
// existing Hosted VM and Call Control voicemail flows continue working
// without this.
// ---------------------------------------------------------------------------
export async function ensureTeXMLApp(opts: {
  telnyxApiKey: string;
  publicBaseUrl: string; // e.g. https://acedialer-webhooks.onrender.com
  log?: (obj: Record<string, unknown>, msg: string) => void;
}): Promise<string> {
  const log = opts.log ?? ((o, m) => console.info(m, o));
  if (!opts.telnyxApiKey) throw new Error('ensureTeXMLApp: TELNYX_API_KEY required');
  if (!opts.publicBaseUrl) throw new Error('ensureTeXMLApp: WEBHOOKS_PUBLIC_BASE_URL required');

  const voiceUrl = `${opts.publicBaseUrl.replace(/\/+$/, '')}/texml/voicemail`;
  const statusCallbackUrl = `${opts.publicBaseUrl.replace(/\/+$/, '')}/texml/voicemail/app-status`;
  const FRIENDLY_NAME = 'ACE Dialer — TeXML Voicemail';

  // Step 1: see if we already have a cached App ID.
  const cachedId = await getSystemConfig(SYSTEM_CONFIG_KEY_APP_ID);
  if (cachedId) {
    // Verify it still exists at Telnyx (admin may have deleted it).
    const res = await fetch(`${TELNYX_API}/texml_applications/${encodeURIComponent(cachedId)}`, {
      headers: { Authorization: `Bearer ${opts.telnyxApiKey}` },
    });
    if (res.ok) {
      const json = (await res.json().catch(() => ({}))) as {
        data?: { id?: string; voice_url?: string };
      };
      const currentVoiceUrl = json?.data?.voice_url ?? '';
      if (currentVoiceUrl !== voiceUrl) {
        // URL drifted — patch it back to what we expect. Common when
        // the webhooks service moves to a new Render URL.
        log(
          { cachedId, currentVoiceUrl, expectedVoiceUrl: voiceUrl },
          '[texml] App voice_url drifted - patching',
        );
        await fetch(`${TELNYX_API}/texml_applications/${encodeURIComponent(cachedId)}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.telnyxApiKey}`,
          },
          body: JSON.stringify({ voice_url: voiceUrl, status_callback: statusCallbackUrl }),
        });
      }
      log({ appId: cachedId, voiceUrl }, '[texml] App verified at Telnyx');
      return cachedId;
    }
    log({ cachedId, status: res.status }, '[texml] cached App ID stale - will recreate');
  }

  // Step 2: create a fresh App.
  const createRes = await fetch(`${TELNYX_API}/texml_applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.telnyxApiKey}`,
    },
    body: JSON.stringify({
      friendly_name: FRIENDLY_NAME,
      voice_url: voiceUrl,
      voice_method: 'GET',
      status_callback: statusCallbackUrl,
      status_callback_method: 'POST',
      // We rely on Telnyx's default ANSWER->RECORD behavior; no fallback URL
      // (the safety-net is Hosted VM on the DID, not a fallback TeXML).
      active: true,
    }),
  });
  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => '');
    throw new Error(
      `Telnyx POST /texml_applications failed: ${createRes.status} ${errText.slice(0, 300)}`,
    );
  }
  const createJson = (await createRes.json()) as { data?: { id?: string } };
  const newId = createJson?.data?.id;
  if (!newId) throw new Error('Telnyx returned no App ID on create');

  await setSystemConfig(SYSTEM_CONFIG_KEY_APP_ID, newId, 'Telnyx TeXML Application for voicemail');
  log({ appId: newId, voiceUrl }, '[texml] created new TeXML Application');
  return newId;
}

// Public accessor used by other modules (admin migration endpoint reads this
// to know what to PATCH each DID's connection_id to).
export async function getTeXMLAppId(): Promise<string | null> {
  return getSystemConfig(SYSTEM_CONFIG_KEY_APP_ID);
}

// ---------------------------------------------------------------------------
// XML escape — TeXML responses are XML, so any user-controlled string that
// goes into an attribute or element text needs escaping. We only ever put
// the SIP username and (optionally) a greeting URL into the response, both
// of which are tightly controlled, but the helper is here for safety.
// ---------------------------------------------------------------------------
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// buildDialTeXML — first TeXML response for an inbound call. Tries to ring
// the user's SIP credential for up to 25 seconds. action= URL is hit by
// Telnyx with DialCallStatus when the dial finishes (answered / failed /
// no-answer / busy).
//
// answerOnBridge="true" — keeps Telnyx-side billing accurate (caller isn't
// billed until the dialed leg actually answers, not when our TeXML responds).
//
// If sipUsername is missing (broken user record), we skip the Dial and go
// straight to the greeting + record. Better than a hangup.
// ---------------------------------------------------------------------------
export function buildDialTeXML(opts: {
  sipUsername: string | null;
  publicBaseUrl: string;
  callerId?: string | null; // optional: pass through the original caller ID
}): string {
  const baseUrl = opts.publicBaseUrl.replace(/\/+$/, '');
  const dialActionUrl = `${baseUrl}/texml/voicemail/dial-status`;
  const recordingActionUrl = `${baseUrl}/texml/voicemail/recording-complete`;

  if (!opts.sipUsername) {
    // No SIP user to ring — go straight to voicemail with default greeting.
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      '  <Say voice="Polly.Joanna">The person you are calling is not available. Please leave a message after the tone.</Say>',
      `  <Record maxLength="120" playBeep="true" timeout="3" trim="trim-silence" action="${xmlEscape(recordingActionUrl)}" />`,
      '</Response>',
    ].join('\n');
  }

  const sipTarget = `sip:${xmlEscape(opts.sipUsername)}@sip.telnyx.com`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Dial action="${xmlEscape(dialActionUrl)}" timeout="25" answerOnBridge="true">`,
    `    <Sip>${sipTarget}</Sip>`,
    '  </Dial>',
    '</Response>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// buildVoicemailTeXML — second-leg TeXML when Dial fell through to voicemail.
// Plays greeting (custom Supabase URL or Polly fallback) then records.
// ---------------------------------------------------------------------------
export function buildVoicemailTeXML(opts: {
  greetingUrl: string | null;
  ownerFirstName: string | null; // used in Polly fallback greeting
  publicBaseUrl: string;
}): string {
  const baseUrl = opts.publicBaseUrl.replace(/\/+$/, '');
  const recordingActionUrl = `${baseUrl}/texml/voicemail/recording-complete`;

  // Greeting: custom recording OR Polly TTS with owner's name.
  const greetingLine = opts.greetingUrl
    ? `  <Play>${xmlEscape(opts.greetingUrl)}</Play>`
    : `  <Say voice="Polly.Joanna">You have reached ${xmlEscape(opts.ownerFirstName ?? 'this user')}. Please leave a message after the tone.</Say>`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    greetingLine,
    `  <Record maxLength="120" playBeep="true" timeout="3" trim="trim-silence" action="${xmlEscape(recordingActionUrl)}" />`,
    '</Response>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Lookup helper — given the To E.164 number Telnyx sends in the TeXML
// request, resolve the owning UserDid + user. Returns null if the DID
// isn't in our database (orphan / misconfigured).
//
// We DO NOT filter on texmlMigratedAt here. If Telnyx is hitting our
// TeXML endpoint at all, the DID is connected to our TeXML App, so it
// must be migrated. Trust the routing.
// ---------------------------------------------------------------------------
export async function lookupDidOwner(
  toE164: string,
): Promise<{
  userDidId: number;
  userId: number | null;
  sipUsername: string | null;
  firstName: string | null;
  greetingUrl: string | null;
} | null> {
  // Normalize: Telnyx may send either "+16467379912" or "16467379912"; our
  // DB stores E.164 with the leading +.
  const normalized = toE164.startsWith('+') ? toE164 : `+${toE164}`;
  const userDid = await prisma.userDid.findFirst({
    where: { didNumber: normalized },
    select: {
      id: true,
      userId: true,
      greetingUrl: true,
      user: { select: { sipUsername: true, firstName: true } },
    },
  });
  if (!userDid) return null;
  return {
    userDidId: userDid.id,
    userId: userDid.userId ?? null,
    sipUsername: userDid.user?.sipUsername ?? null,
    firstName: userDid.user?.firstName ?? null,
    greetingUrl: userDid.greetingUrl ?? null,
  };
}
