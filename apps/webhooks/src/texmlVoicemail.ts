// ===========================================================================
// v0.10.119 - TeXML voicemail flow (Phase 2 trial, +16467379912 only).
//
// Architecture:
//   PSTN caller dials a TeXML-migrated DID
//      -> Telnyx routes call to our TeXML Application
//      -> Application's Voice URL: GET /texml/voicemail
//      -> We return TeXML: <Dial action=".../dial-status" timeout=25 answerOnBridge=true>
//                            <Sip>sip:USER@sip.telnyx.com</Sip>
//                          </Dial>
//      -> Telnyx tries the SIP URI for 25 sec
//         If answered: call bridges, no further TeXML
//         If no-answer/busy/failed: Telnyx POSTs DialCallStatus to /dial-status
//           which returns Play + Record TeXML
//      -> Record goes to /recording-complete which feeds the same
//         internal handler the Hosted-VM flow uses (Deepgram + Voicemail row)
//
// Greetings reuse the v0.10.100 User-level stack:
//   User.voicemailGreetingMode in { 'audio', 'tts', 'default' }
//     'audio'   -> <Play>(voicemailGreetingUrl)
//     'tts'     -> <Say>(voicemailGreetingText)
//     'default' / null -> <Say>("You have reached <First>. Please leave a message after the tone.")
//   Trial uses only the no-answer variant. The busy-variant columns exist
//   on User but TeXML ignores them.
//
// Boot:
//   ensureTeXMLApp() creates / reuses a Telnyx TeXML Application whose
//   voice_url points at our /texml/voicemail. App ID cached in
//   SystemConfig under 'telnyx.texml_vm.app_id'.
//
// Trial scope: TEXML_TRIAL_DIDS env var = comma-separated E.164 allowlist.
// For Phase 2 set TEXML_TRIAL_DIDS=+16467379912.
//
// Safety net: we INTENTIONALLY leave Hosted Voicemail enabled on the DID.
// Telnyx prefers TeXML; on 5xx falls back to Hosted VM with default greeting.
// ===========================================================================

import { prisma } from '@ace/db';

const TELNYX_API = 'https://api.telnyx.com/v2';
const SYSTEM_CONFIG_KEY_APP_ID = 'telnyx.texml_vm.app_id';

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

export async function ensureTeXMLApp(opts: {
  telnyxApiKey: string;
  publicBaseUrl: string;
  log?: (obj: Record<string, unknown>, msg: string) => void;
}): Promise<string> {
  const log = opts.log ?? ((o, m) => console.info(m, o));
  if (!opts.telnyxApiKey) throw new Error('ensureTeXMLApp: TELNYX_API_KEY required');
  if (!opts.publicBaseUrl) throw new Error('ensureTeXMLApp: WEBHOOKS_PUBLIC_URL required');

  const voiceUrl = `${opts.publicBaseUrl.replace(/\/+$/, '')}/texml/voicemail`;
  const statusCallbackUrl = `${opts.publicBaseUrl.replace(/\/+$/, '')}/texml/voicemail/app-status`;
  const FRIENDLY_NAME = 'ACE Dialer - TeXML Voicemail';

  const cachedId = await getSystemConfig(SYSTEM_CONFIG_KEY_APP_ID);
  if (cachedId) {
    const res = await fetch(`${TELNYX_API}/texml_applications/${encodeURIComponent(cachedId)}`, {
      headers: { Authorization: `Bearer ${opts.telnyxApiKey}` },
    });
    if (res.ok) {
      const json = (await res.json().catch(() => ({}))) as {
        data?: { id?: string; voice_url?: string };
      };
      const currentVoiceUrl = json?.data?.voice_url ?? '';
      if (currentVoiceUrl !== voiceUrl) {
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

export async function getTeXMLAppId(): Promise<string | null> {
  return getSystemConfig(SYSTEM_CONFIG_KEY_APP_ID);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface GreetingConfig {
  mode: 'audio' | 'tts' | 'default' | null;
  url: string | null;
  text: string | null;
}

export function buildDialTeXML(opts: {
  sipUsername: string | null;
  publicBaseUrl: string;
  callerId?: string | null;
}): string {
  const baseUrl = opts.publicBaseUrl.replace(/\/+$/, '');
  const dialActionUrl = `${baseUrl}/texml/voicemail/dial-status`;
  const recordingActionUrl = `${baseUrl}/texml/voicemail/recording-complete`;

  if (!opts.sipUsername) {
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

export function buildVoicemailTeXML(opts: {
  greeting: GreetingConfig;
  ownerFirstName: string | null;
  publicBaseUrl: string;
}): string {
  const baseUrl = opts.publicBaseUrl.replace(/\/+$/, '');
  const recordingActionUrl = `${baseUrl}/texml/voicemail/recording-complete`;

  let greetingLine: string;
  if (opts.greeting.mode === 'audio' && opts.greeting.url) {
    greetingLine = `  <Play>${xmlEscape(opts.greeting.url)}</Play>`;
  } else if (opts.greeting.mode === 'tts' && opts.greeting.text) {
    greetingLine = `  <Say voice="Polly.Joanna">${xmlEscape(opts.greeting.text)}</Say>`;
  } else {
    const who = opts.ownerFirstName ?? 'this user';
    greetingLine = `  <Say voice="Polly.Joanna">You have reached ${xmlEscape(who)}. Please leave a message after the tone.</Say>`;
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    greetingLine,
    `  <Record maxLength="120" playBeep="true" timeout="3" trim="trim-silence" action="${xmlEscape(recordingActionUrl)}" />`,
    '</Response>',
  ].join('\n');
}

export async function lookupDidOwner(
  toE164: string,
): Promise<{
  userDidId: number;
  userId: number | null;
  sipUsername: string | null;
  firstName: string | null;
  greeting: GreetingConfig;
} | null> {
  const normalized = toE164.startsWith('+') ? toE164 : `+${toE164}`;
  const userDid = await prisma.userDid.findFirst({
    where: { didNumber: normalized },
    select: {
      id: true,
      userId: true,
      user: {
        select: {
          sipUsername: true,
          firstName: true,
          voicemailGreetingUrl: true,
          voicemailGreetingText: true,
          voicemailGreetingMode: true,
        },
      },
    },
  });
  if (!userDid) return null;
  const modeRaw = (userDid.user?.voicemailGreetingMode ?? null) as string | null;
  const mode: GreetingConfig['mode'] =
    modeRaw === 'audio' || modeRaw === 'tts' || modeRaw === 'default' ? modeRaw : null;
  return {
    userDidId: userDid.id,
    userId: userDid.userId ?? null,
    sipUsername: userDid.user?.sipUsername ?? null,
    firstName: userDid.user?.firstName ?? null,
    greeting: {
      mode,
      url: userDid.user?.voicemailGreetingUrl ?? null,
      text: userDid.user?.voicemailGreetingText ?? null,
    },
  };
}


// ---------------------------------------------------------------------------
// buildDialStatusTeXML - called when Telnyx POSTs DialCallStatus to our
// /texml/voicemail/dial-status endpoint. We branch on the status:
//   completed / answered -> empty <Response/> (call already done)
//   busy                 -> Play greeting + Record (treat busy as
//                           "go to voicemail"; matches the v0.10.100
//                           busy-greeting behavior even though for the
//                           trial we use a single greeting for both cases)
//   no-answer / failed / canceled / anything else -> Play greeting + Record
//
// We need the same greeting + ownerFirstName context that buildVoicemailTeXML
// uses. The caller (route handler in main.ts) re-looks-up the DID owner via
// lookupDidOwner using the To number that Telnyx echoes back in this
// callback's body, so we get the right user even though this is a separate
// HTTP request from the initial /texml/voicemail dial.
// ---------------------------------------------------------------------------
export function buildDialStatusTeXML(opts: {
  dialCallStatus: string;
  greeting: GreetingConfig;
  ownerFirstName: string | null;
  publicBaseUrl: string;
}): string {
  const status = (opts.dialCallStatus ?? '').toLowerCase();

  // Call already completed — nothing more to do. Empty Response tells
  // Telnyx to just terminate the call cleanly.
  if (status === 'completed' || status === 'answered') {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<Response/>';
  }

  // Everything else (busy, no-answer, failed, canceled, ...) falls
  // through to voicemail. buildVoicemailTeXML handles the greeting
  // selection (audio / tts / default).
  return buildVoicemailTeXML({
    greeting: opts.greeting,
    ownerFirstName: opts.ownerFirstName,
    publicBaseUrl: opts.publicBaseUrl,
  });
}
