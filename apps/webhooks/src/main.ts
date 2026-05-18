// ACE Dialer Webhooks — Telnyx inbound webhook receiver.
// Phase 5.1: persist call lifecycle events to the database.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { prisma } from '@ace/db';

const SERVICE_NAME = 'ace-dialer-webhooks';
const START_TIME = new Date().toISOString();
const TELNYX_API_KEY = process.env.TELNYX_API_KEY ?? '';

// Decode the client_state Telnyx echoes back on every call event. We use it
// to carry "what to do when this leg answers" instructions (e.g. auto-bridge
// to leg A for an Add Call / Merge flow).
interface ClientState {
  bridgeTo?: string;        // call_control_id of the leg to auto-bridge with
  autoBridge?: boolean;     // default true if bridgeTo present
  originatorUserId?: number;
}
function decodeClientState(s: string | undefined | null): ClientState | null {
  if (!s) return null;
  try {
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as ClientState;
  } catch {
    return null;
  }
}

// Bridge two Telnyx legs together via the Voice API. Called from the webhook
// when leg B (server-originated via Call Control) answers and carries a
// client_state telling us to bridge with leg A.
async function bridgeLegs(legA: string, legB: string): Promise<{ ok: boolean; status?: number; error?: unknown }> {
  if (!TELNYX_API_KEY) return { ok: false, error: 'TELNYX_API_KEY not set on webhooks service' };
  const res = await fetch(
    `https://api.telnyx.com/v2/calls/${encodeURIComponent(legA)}/actions/bridge`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({ call_control_id: legB }),
    },
  );
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...(res.ok ? {} : { error: body }) };
}

// Phase 5: pilot has one user. Hardcoded until multi-user support lands.
const PILOT_USER_ID = 1;
const PILOT_NUMBER = process.env.PILOT_TELNYX_NUMBER ?? '+17322001305';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  ignoreTrailingSlash: true,
});

await app.register(cors, { origin: false });

// Log every non-health request so we can confirm whether Telnyx ever hits us.
app.addHook('onRequest', async (request) => {
  if (request.url.startsWith('/health')) return;
  app.log.info(
    {
      method: request.method,
      url: request.url,
      ua: request.headers['user-agent'],
      ip: request.ip,
    },
    '[req] incoming'
  );
});

app.get('/', async () => ({ service: SERVICE_NAME, status: 'ok' }));
app.get('/health', async () => ({
  status: 'ok',
  service: SERVICE_NAME,
  uptimeSeconds: Math.floor(process.uptime()),
  startedAt: START_TIME,
  timestamp: new Date().toISOString(),
}));

// ---------- Telnyx call webhook handler ----------
// Telnyx posts JSON like:
// { data: { event_type: 'call.initiated' | 'call.answered' | 'call.hangup' | ...,
//           payload: { call_session_id, call_control_id, direction, from, to,
//                      start_time, end_time, hangup_cause, hangup_source, ... } } }
app.post('/webhooks/telnyx/calls', async (request) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = request.body as any;
    const event = body?.data;
    if (!event) {
      app.log.warn('[telnyx] webhook with no data');
      return { received: true };
    }

    const payload = event.payload ?? {};
    const callId: string | undefined = payload.call_session_id ?? payload.call_control_id;
    if (!callId) {
      app.log.warn('[telnyx] no call id in payload');
      return { received: true };
    }

    const direction = payload.direction === 'outgoing' ? 'outbound' : 'inbound';
    const fromNumber: string = payload.from ?? '';
    const toNumber: string = payload.to ?? '';
    const callControlId: string | undefined = payload.call_control_id;

    app.log.info(
      { eventType: event.event_type, callId, direction, fromNumber, toNumber },
      '[telnyx] call event'
    );

    switch (event.event_type) {
      case 'call.initiated': {
        await prisma.call.upsert({
          where: { telnyxCallId: callId },
          update: {
            status: 'initiated',
            ...(callControlId ? { callControlId } : {}),
          },
          create: {
            userId: PILOT_USER_ID,
            telnyxCallId: callId,
            sessionId: payload.call_session_id ?? null,
            callControlId: callControlId ?? null,
            direction,
            fromNumber,
            toNumber,
            status: 'initiated',
            startedAt: payload.start_time ? new Date(payload.start_time) : new Date(),
          },
        });
        break;
      }

      case 'call.answered':
      case 'call.bridged': {
        await prisma.call.updateMany({
          where: { telnyxCallId: callId },
          data: {
            status: 'answered',
            answeredAt: new Date(),
            ...(callControlId ? { callControlId } : {}),
          },
        });

        // Phase 5.4 (rebuild): server-originated Leg B carries a client_state
        // telling us to auto-bridge with Leg A as soon as it answers.
        // This is what makes "Add Call" actually merge — the user (still on
        // Leg A's WebRTC stream) starts hearing Leg B the moment they answer.
        if (event.event_type === 'call.answered' && callControlId) {
          const state = decodeClientState(payload.client_state);
          if (state?.bridgeTo && state.autoBridge !== false) {
            app.log.info({ legA: state.bridgeTo, legB: callControlId }, '[webhook] auto-bridging on answer');
            const result = await bridgeLegs(state.bridgeTo, callControlId);
            if (!result.ok) {
              app.log.error({ result }, '[webhook] auto-bridge failed');
            } else {
              app.log.info({ legA: state.bridgeTo, legB: callControlId }, '[webhook] auto-bridge success');
            }
          }
        }
        break;
      }

      case 'call.hangup': {
        const startedAt = payload.start_time ? new Date(payload.start_time) : null;
        const endedAt = payload.end_time ? new Date(payload.end_time) : new Date();
        let duration = 0;
        if (startedAt) {
          duration = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
        }
        const hangupCause: string = payload.hangup_cause ?? 'unknown';
        const status =
          hangupCause === 'normal_clearing' || hangupCause === 'normal_termination'
            ? 'completed'
            : hangupCause === 'no_answer'
              ? 'no_answer'
              : 'failed';

        // Try update first; if no record (we missed call.initiated), insert.
        const updated = await prisma.call.updateMany({
          where: { telnyxCallId: callId },
          data: {
            status,
            endedAt,
            durationSeconds: duration,
            hangupCause,
            hangupSource: payload.hangup_source ?? null,
          },
        });
        if (updated.count === 0 && startedAt) {
          await prisma.call.create({
            data: {
              userId: PILOT_USER_ID,
              telnyxCallId: callId,
              sessionId: payload.call_session_id ?? null,
              direction,
              fromNumber,
              toNumber,
              status,
              startedAt,
              endedAt,
              durationSeconds: duration,
              hangupCause,
              hangupSource: payload.hangup_source ?? null,
            },
          });
        }
        break;
      }

      case 'call.recording.saved': {
        const recordingUrls: string[] = payload.recording_urls?.mp3 ?? payload.recording_urls ?? [];
        if (recordingUrls.length > 0) {
          await prisma.call.updateMany({
            where: { telnyxCallId: callId },
            data: { recordingUrl: recordingUrls[0] },
          });
        }
        break;
      }

      default:
        // Unhandled event types are fine — we just log.
        app.log.debug({ eventType: event.event_type }, '[telnyx] unhandled event type');
    }

    return { received: true };
  } catch (e) {
    app.log.error({ err: e }, '[telnyx] handler error');
    return { received: true, error: String(e) };
  }
});

// Phase 5.3 — Telnyx SMS / MMS webhook.
// Telnyx event types we care about:
//   - message.received       inbound SMS/MMS landed on our number
//   - message.sent           outbound accepted by Telnyx (we already wrote the row)
//   - message.delivered      outbound delivered to handset
//   - message.failed         outbound failed
//   - message.finalized      Telnyx's "we're done with this message"
app.post('/webhooks/telnyx/sms', async (request) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = request.body as any;
    const event = body?.data;
    if (!event) {
      app.log.warn('[telnyx] sms webhook with no data');
      return { received: true };
    }

    const payload = event.payload ?? {};
    const telnyxMessageId: string | undefined = payload.id;
    const eventType: string = event.event_type ?? '';
    if (!telnyxMessageId) {
      app.log.warn({ eventType }, '[telnyx] sms event missing id');
      return { received: true };
    }

    const text: string = payload.text ?? '';
    const mediaUrls: string[] = Array.isArray(payload.media)
      ? payload.media.map((m: { url?: string }) => m?.url).filter((u: unknown): u is string => typeof u === 'string')
      : [];
    const fromNumber: string = payload.from?.phone_number ?? '';
    const toNumber: string = Array.isArray(payload.to) && payload.to[0]?.phone_number
      ? payload.to[0].phone_number
      : payload.to?.phone_number ?? '';

    app.log.info(
      { eventType, telnyxMessageId, fromNumber, toNumber, mediaCount: mediaUrls.length },
      '[telnyx] sms event'
    );

    switch (eventType) {
      case 'message.received': {
        // Inbound: from = the PSTN caller, to = our DID.
        const threadKey = fromNumber; // the other party
        await prisma.message.upsert({
          where: { telnyxMessageId },
          update: { status: 'received' },
          create: {
            userId: PILOT_USER_ID,
            telnyxMessageId,
            threadKey,
            direction: 'inbound',
            fromNumber,
            toNumber,
            body: text,
            mediaUrls,
            status: 'received',
            sentAt: payload.received_at ? new Date(payload.received_at) : new Date(),
          },
        });
        break;
      }

      case 'message.sent':
      case 'message.queued': {
        await prisma.message.updateMany({
          where: { telnyxMessageId },
          data: { status: 'sent', sentAt: new Date() },
        });
        break;
      }

      case 'message.delivered': {
        await prisma.message.updateMany({
          where: { telnyxMessageId },
          data: { status: 'delivered', deliveredAt: new Date() },
        });
        break;
      }

      case 'message.sending_failed':
      case 'message.failed':
      case 'message.finalized': {
        // For finalized, status comes from the payload itself.
        const finalStatus: string =
          eventType === 'message.finalized'
            ? payload.to?.[0]?.status ?? payload.status ?? 'sent'
            : 'failed';
        await prisma.message.updateMany({
          where: { telnyxMessageId },
          data: {
            status: finalStatus === 'delivered' ? 'delivered' : finalStatus,
            errors: payload.errors ?? undefined,
            deliveredAt: finalStatus === 'delivered' ? new Date() : undefined,
          },
        });
        break;
      }

      default:
        app.log.debug({ eventType }, '[telnyx] unhandled sms event');
    }

    return { received: true };
  } catch (e) {
    app.log.error({ err: e }, '[telnyx] sms handler error');
    return { received: true, error: String(e) };
  }
});

app.post('/webhooks/telnyx/failover', async (request) => {
  app.log.info({ payload: request.body }, '[telnyx] failover event');
  return { received: true };
});

// ---------- Phase 5.6: TexML inbound flow ----------
// Point a Telnyx TexML application at this URL on your DID's voice settings.
// When a PSTN call comes in, Telnyx fetches this and follows the instructions:
//   1. Dial the WebRTC user for up to 25s.
//   2. If the user is busy / declines / times out, fall through to greet + record.
//   3. The recording finalisation hits /webhooks/telnyx/voicemail which inserts
//      a Voicemail row.
//
// Configure once: Telnyx Portal → Voice → TexML Applications → New →
//   Webhook URL: https://<this-host>/texml/inbound  Method: POST or GET
//   Then on your DID → Voice settings → assign this TexML application.
//
// Env vars consumed:
//   PILOT_SIP_USERNAME   the WebRTC user's SIP credential username
//                        (URI becomes sip:<username>@sip.telnyx.com)
//   PILOT_VOICEMAIL_GREETING (optional) override the default Polly greeting
// Escape XML special chars (mostly for the user-supplied greeting).
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const texmlHandler = (request: any): string => {
  const sipUser = process.env.PILOT_SIP_USERNAME ?? '';
  const greeting =
    process.env.PILOT_VOICEMAIL_GREETING ??
    "You've reached ACE Dialer. Please leave a message after the tone, then press pound or hang up.";

  if (!sipUser) {
    app.log.warn('[texml] PILOT_SIP_USERNAME not set; returning hangup-only flow');
  }

  // Build an ABSOLUTE URL for the Record action — Telnyx requires absolute
  // URLs for callbacks. Prefer an explicit env var, fall back to the host
  // header Telnyx hit us on (Render sets x-forwarded-proto correctly).
  const proto = (request?.headers?.['x-forwarded-proto'] as string) ?? 'https';
  const host = (request?.headers?.host as string) ?? 'ace-dialer-webhooks.onrender.com';
  const baseUrl = (process.env.WEBHOOKS_PUBLIC_URL ?? `${proto}://${host}`).replace(/\/+$/, '');
  const recordAction = `${baseUrl}/webhooks/telnyx/voicemail`;

  // Telnyx's TexML reference is a Twilio-compatible subset. Sticking to the
  // safe core verbs/attributes to avoid parser errors:
  //   <Dial><Sip>…</Sip></Dial>            → bridge to SIP target
  //   timeout                              → seconds before no-answer fallthrough
  //   <Say voice="alice">                  → standard TTS voice; Polly.* voices
  //                                          aren't always accepted.
  //   <Record action maxLength playBeep>   → record + POST to action URL
  //   <Hangup/>                            → end the call
  const xml = sipUser
    ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="25">
    <Sip>sip:${xmlEscape(sipUser)}@sip.telnyx.com</Sip>
  </Dial>
  <Say voice="alice">${xmlEscape(greeting)}</Say>
  <Record maxLength="120" playBeep="true" action="${xmlEscape(recordAction)}" method="POST" finishOnKey="#" />
  <Hangup/>
</Response>`
    : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Service not yet configured.</Say>
  <Hangup/>
</Response>`;

  return xml;
};

app.get('/texml/inbound', async (request, reply) => {
  const xml = texmlHandler(request);
  app.log.info({ length: xml.length, sipUser: Boolean(process.env.PILOT_SIP_USERNAME) }, '[texml] inbound served');
  reply.type('application/xml; charset=utf-8').send(xml);
});
app.post('/texml/inbound', async (request, reply) => {
  const xml = texmlHandler(request);
  app.log.info({ length: xml.length, sipUser: Boolean(process.env.PILOT_SIP_USERNAME) }, '[texml] inbound served');
  reply.type('application/xml; charset=utf-8').send(xml);
});

// Phase 5.6 — Voicemail recording webhook.
// Telnyx Call Control flow: on no-answer, transfer the call to a recording
// action that records the caller's message and fires a webhook to this URL
// (or call.recording.saved with a custom client_state tag we set in the flow).
// Accepts both shapes:
//   - data.event_type === 'call.recording.saved' WITH client_state === 'voicemail'
//   - top-level { from, to, recording_url, duration_seconds, transcription, telnyx_call_id }
app.post('/webhooks/telnyx/voicemail', async (request) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = request.body as any;

    // Variant A — Telnyx native event envelope.
    const event = body?.data;
    let fromNumber: string | undefined;
    let toNumber: string | undefined;
    let recordingUrl: string | undefined;
    let durationSeconds = 0;
    let telnyxCallId: string | undefined;
    let receivedAt: Date = new Date();
    let transcription: string | undefined;

    if (event?.payload) {
      const payload = event.payload;
      fromNumber = payload.from;
      toNumber = payload.to;
      const urls = payload.recording_urls?.mp3 ?? payload.recording_urls ?? [];
      recordingUrl = Array.isArray(urls) ? urls[0] : urls;
      durationSeconds = payload.recording_duration_millis
        ? Math.floor(payload.recording_duration_millis / 1000)
        : 0;
      telnyxCallId = payload.call_session_id ?? payload.call_control_id;
      if (payload.start_time) receivedAt = new Date(payload.start_time);
      transcription = payload.transcription?.text;
    } else {
      // Variant B — minimal custom shape.
      fromNumber = body?.from;
      toNumber = body?.to;
      recordingUrl = body?.recording_url;
      durationSeconds = Number(body?.duration_seconds ?? 0);
      telnyxCallId = body?.telnyx_call_id;
      transcription = body?.transcription;
      if (body?.received_at) receivedAt = new Date(body.received_at);
    }

    if (!fromNumber || !recordingUrl) {
      app.log.warn({ body }, '[telnyx] voicemail webhook missing from or recording_url');
      return { received: true };
    }

    await prisma.voicemail.create({
      data: {
        userId: PILOT_USER_ID,
        telnyxCallId: telnyxCallId ?? null,
        fromNumber,
        toNumber: toNumber ?? PILOT_NUMBER,
        recordingUrl,
        durationSeconds,
        transcription: transcription ?? null,
        receivedAt,
      },
    });

    app.log.info({ fromNumber, recordingUrl, durationSeconds }, '[telnyx] voicemail recorded');
    return { received: true };
  } catch (e) {
    app.log.error({ err: e }, '[telnyx] voicemail handler error');
    return { received: true, error: String(e) };
  }
});

// Catch-all for any path we didn't register — helps diagnose if Telnyx is posting
// to a slightly different URL than we expect. Using setNotFoundHandler avoids
// colliding with the CORS plugin's OPTIONS route on '/*'.
app.setNotFoundHandler((request, reply) => {
  app.log.warn(
    {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    },
    '[catch-all] unmatched request'
  );
  reply.code(404).send({ error: 'not found', path: request.url });
});

const port = Number(process.env.PORT ?? 3002);
const host = '0.0.0.0';

try {
  await app.listen({ port, host });
  app.log.info({ port, host }, `[${SERVICE_NAME}] listening`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, `[${SERVICE_NAME}] shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
