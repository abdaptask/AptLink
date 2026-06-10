// ACE Dialer Webhooks — Fastify application instance and routing definition.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { Queue } from 'bullmq';
import { prisma } from '@ace/db';
import { getTelnyxStatus } from './telnyxStatus.js';
import {
  buildDialTeXML,
  buildVoicemailTeXML,
  buildDialStatusTeXML,
  lookupDidOwner,
} from './texmlVoicemail.js';

const SERVICE_NAME = 'ace-dialer-webhooks';
const TELNYX_API_KEY = process.env.TELNYX_API_KEY ?? '';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

// Setup Redis connection options parsed from REDIS_URL.
const redisUrlObj = new URL(REDIS_URL);
const redisConnectionOptions = {
  host: redisUrlObj.hostname,
  port: Number(redisUrlObj.port || 6379),
  username: redisUrlObj.username || undefined,
  password: redisUrlObj.password || undefined,
  tls: redisUrlObj.protocol === 'rediss:' ? {} : undefined,
  maxRetriesPerRequest: null,
};

export const webhookQueue = new Queue('telnyx-webhooks', {
  connection: redisConnectionOptions,
});

const PILOT_NUMBER = process.env.PILOT_TELNYX_NUMBER ?? '+17322001305';

export const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  ignoreTrailingSlash: true,
});

await app.register(cors, { origin: false });
await app.register(formbody);

// Log every non-health request
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
  startedAt: new Date().toISOString(),
  timestamp: new Date().toISOString(),
}));

app.get('/telnyx-status', async () => {
  return getTelnyxStatus();
});

// Telnyx Call Control voicemail observer. Enqueues CC events for background processing.
app.post('/webhooks/telnyx/voicemail-cc', async (request) => {
  try {
    const body = request.body as any;
    const event = body?.data;
    if (!event) {
      app.log.warn('[vm-cc] webhook with no data');
      return { received: true };
    }
    await webhookQueue.add('voicemail-cc', { event });
  } catch (e) {
    app.log.error({ err: e instanceof Error ? e.message : String(e) }, '[vm-cc] enqueue failed');
  }
  return { received: true };
});

// ---------- Telnyx call webhook handler ----------
app.post('/webhooks/telnyx/calls', async (request) => {
  try {
    const body = request.body as any;
    const event = body?.data;
    if (!event) {
      app.log.warn('[telnyx] webhook with no data');
      return { received: true };
    }

    const payload = event.payload ?? {};
    const callControlId: string | undefined = payload.call_control_id;
    const sessionId: string | undefined = payload.call_session_id;
    const callId: string | undefined = callControlId ?? sessionId;
    if (!callId) {
      app.log.warn('[telnyx] no call id in payload');
      return { received: true };
    }

    app.log.info(
      { eventType: event.event_type, callControlId, sessionId },
      '[telnyx] call event - enqueuing'
    );

    await webhookQueue.add('call', {
      eventType: event.event_type,
      payload,
    });

    return { received: true };
  } catch (e) {
    app.log.error({ err: e }, '[telnyx] calls enqueue error');
    return { received: true, error: String(e) };
  }
});

// Telnyx SMS / MMS webhook.
app.post('/webhooks/telnyx/sms', async (request) => {
  try {
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

    app.log.info(
      { eventType, telnyxMessageId },
      '[telnyx] sms event - enqueuing'
    );

    await webhookQueue.add('sms', {
      eventType,
      payload,
    });

    return { received: true };
  } catch (e) {
    app.log.error({ err: e }, '[telnyx] sms enqueue error');
    return { received: true, error: String(e) };
  }
});

app.post('/webhooks/telnyx/failover', async (request) => {
  app.log.info({ payload: request.body }, '[telnyx] failover event');
  return { received: true };
});

// ---------- TexML inbound flow (Synchronous callback) ----------
async function resolveCalledConnection(
  request: { body?: unknown; query?: unknown },
): Promise<{ connectionId: string | null; userId: number | null }> {
  const body = (request.body ?? {}) as any;
  const query = (request.query ?? {}) as any;
  const to: string =
    (typeof body.To === 'string' && body.To) ||
    (typeof query.To === 'string' && query.To) ||
    (typeof body.to === 'string' && body.to) ||
    (typeof query.to === 'string' && query.to) ||
    '';
  if (!to) return { connectionId: null, userId: null };
  const last10 = to.replace(/[^\d]/g, '').slice(-10);
  if (last10.length !== 10) return { connectionId: null, userId: null };
  try {
    const all = await prisma.userDid.findMany({
      select: { id: true, didNumber: true, connectionId: true, userId: true },
    });
    const match = all.find(
      (d) => d.didNumber.replace(/[^\d]/g, '').slice(-10) === last10,
    );
    if (!match) return { connectionId: null, userId: null };

    if (match.connectionId) {
      return { connectionId: match.connectionId, userId: match.userId };
    }

    if (!TELNYX_API_KEY) {
      app.log.warn(
        { didNumber: match.didNumber, userId: match.userId },
        '[texml] UserDid.connectionId is NULL and TELNYX_API_KEY not set — falling back to pilot',
      );
      return { connectionId: null, userId: match.userId };
    }
    try {
      const lookupRes = await fetch(
        `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(match.didNumber)}`,
        { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } },
      );
      if (!lookupRes.ok) {
        app.log.warn(
          { didNumber: match.didNumber, status: lookupRes.status },
          '[texml] Telnyx lookup for backfill failed',
        );
        return { connectionId: null, userId: match.userId };
      }
      const lookupBody = (await lookupRes.json()) as any;
      const numberInfo = lookupBody?.data?.[0];
      const fetchedConnectionId: string | undefined = numberInfo?.connection_id;
      if (!fetchedConnectionId) {
        app.log.warn(
          { didNumber: match.didNumber },
          '[texml] Telnyx returned no connection_id for DID — falling back to pilot',
        );
        return { connectionId: null, userId: match.userId };
      }
      await prisma.userDid.update({
        where: { id: match.id },
        data: { connectionId: fetchedConnectionId },
      });
      app.log.info(
        {
          userDidId: match.id,
          userId: match.userId,
          didNumber: match.didNumber,
          connectionId: fetchedConnectionId,
        },
        '[texml] backfilled UserDid.connectionId from Telnyx',
      );
      return { connectionId: fetchedConnectionId, userId: match.userId };
    } catch (e) {
      app.log.warn(
        { err: e instanceof Error ? e.message : String(e), didNumber: match.didNumber },
        '[texml] Telnyx lookup threw — falling back to pilot',
      );
      return { connectionId: null, userId: match.userId };
    }
  } catch (e) {
    app.log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      '[texml] resolveCalledConnection lookup failed',
    );
    return { connectionId: null, userId: null };
  }
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const texmlHandler = async (request: any): Promise<string> => {
  const resolved = await resolveCalledConnection(request);
  const sipConnectionId =
    resolved.connectionId ||
    process.env.PILOT_SIP_CONNECTION_ID ||
    '2960617014202206103';
  app.log.info(
    {
      resolvedConnectionId: resolved.connectionId,
      resolvedUserId: resolved.userId,
      chose: sipConnectionId,
      fellBackToPilot: !resolved.connectionId,
    },
    '[texml] routing decision',
  );

  const proto = (request?.headers?.['x-forwarded-proto'] as string) ?? 'https';
  const host = (request?.headers?.host as string) ?? 'ace-dialer-webhooks.onrender.com';
  const baseUrl = (process.env.WEBHOOKS_PUBLIC_URL ?? `${proto}://${host}`).replace(/\/+$/, '');
  const dialStatusAction = `${baseUrl}/texml/dial-status`;

  const xml = sipConnectionId
    ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="45" action="${xmlEscape(dialStatusAction)}" method="POST">
    <Sip>sip:${xmlEscape(sipConnectionId)}@sip.telnyx.com</Sip>
  </Dial>
</Response>`
    : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Service not yet configured.</Say>
  <Hangup/>
</Response>`;

  return xml;
};

const dialStatusHandler = (request: any): string => {
  const body = (request?.body ?? {}) as any;
  const query = (request?.query ?? {}) as any;
  const status: string = (body.DialCallStatus ?? query.DialCallStatus ?? '').toString().toLowerCase();

  const proto = (request?.headers?.['x-forwarded-proto'] as string) ?? 'https';
  const host = (request?.headers?.host as string) ?? 'ace-dialer-webhooks.onrender.com';
  const baseUrl = (process.env.WEBHOOKS_PUBLIC_URL ?? `${proto}://${host}`).replace(/\/+$/, '');
  const recordAction = `${baseUrl}/webhooks/telnyx/voicemail`;
  const greeting =
    process.env.PILOT_VOICEMAIL_GREETING ??
    "You've reached ACE Dialer. Please leave a message after the tone, then press pound or hang up.";

  app.log.info({ status }, '[texml] dial-status received');

  if (status === 'completed' || status === 'answered') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response/>`;
  }
  if (status === 'busy') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">The party you are trying to reach is on another call. Please try again in a moment.</Say>
  <Hangup/>
</Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${xmlEscape(greeting)}</Say>
  <Record maxLength="120" playBeep="true" action="${xmlEscape(recordAction)}" method="POST" finishOnKey="#" />
  <Hangup/>
</Response>`;
};

app.get('/texml/inbound', async (request, reply) => {
  const xml = await texmlHandler(request);
  app.log.info({ length: xml.length }, '[texml] inbound served');
  reply.type('application/xml; charset=utf-8').send(xml);
});
app.post('/texml/inbound', async (request, reply) => {
  const xml = await texmlHandler(request);
  app.log.info({ length: xml.length }, '[texml] inbound served');
  reply.type('application/xml; charset=utf-8').send(xml);
});

app.get('/texml/dial-status', async (request, reply) => {
  const xml = dialStatusHandler(request);
  app.log.info({ length: xml.length }, '[texml] dial-status served (GET)');
  reply.type('application/xml; charset=utf-8').send(xml);
});
app.post('/texml/dial-status', async (request, reply) => {
  const xml = dialStatusHandler(request);
  app.log.info({ length: xml.length }, '[texml] dial-status served (POST)');
  reply.type('application/xml; charset=utf-8').send(xml);
});

// ===========================================================================
// TeXML voicemail trial routes (Synchronous voice XML generation)
// ===========================================================================
function texmlPublicBaseUrl(request: { headers?: Record<string, unknown> }): string {
  const envBase = (process.env.WEBHOOKS_PUBLIC_URL ?? '').trim();
  if (envBase) return envBase.replace(/\/+$/, '');
  const headers = request.headers ?? {};
  const proto = (headers['x-forwarded-proto'] as string) ?? 'https';
  const host = (headers['host'] as string) ?? 'ace-dialer-webhooks.onrender.com';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function extractToNumber(request: any): string {
  const body = (request?.body ?? {}) as any;
  const query = (request?.query ?? {}) as any;
  return (
    (typeof body.To === 'string' && body.To) ||
    (typeof query.To === 'string' && query.To) ||
    (typeof body.to === 'string' && body.to) ||
    (typeof query.to === 'string' && query.to) ||
    ''
  );
}

function extractFromNumber(request: any): string | null {
  const body = (request?.body ?? {}) as any;
  const query = (request?.query ?? {}) as any;
  const v =
    (typeof body.From === 'string' && body.From) ||
    (typeof query.From === 'string' && query.From) ||
    (typeof body.from === 'string' && body.from) ||
    (typeof query.from === 'string' && query.from) ||
    '';
  return v || null;
}

async function voicemailEntryHandler(
  request: { headers?: Record<string, unknown>; body?: unknown; query?: unknown },
): Promise<string> {
  const to = extractToNumber(request);
  const baseUrl = texmlPublicBaseUrl(request);
  if (!to) {
    app.log.warn({ headers: request.headers }, '[texml-vm] entry: no To number in request');
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      '  <Say voice="Polly.Joanna">We could not route your call. Please try again later.</Say>',
      '  <Hangup/>',
      '</Response>',
    ].join('\n');
  }
  const owner = await lookupDidOwner(to);
  if (!owner) {
    app.log.warn({ to }, '[texml-vm] entry: unknown DID, falling through to default greeting');
    return buildVoicemailTeXML({
      greeting: { mode: null, url: null, text: null },
      ownerFirstName: null,
      publicBaseUrl: baseUrl,
      didNumber: to,
    });
  }
  app.log.info(
    {
      to,
      userDidId: owner.userDidId,
      userId: owner.userId,
      sipUsername: owner.sipUsername,
      greetingMode: owner.greeting.mode,
    },
    '[texml-vm] entry: building Dial TeXML',
  );
  return buildDialTeXML({
    sipUsername: owner.sipUsername,
    publicBaseUrl: baseUrl,
    callerId: extractFromNumber(request),
    didNumber: to,
  });
}

app.get('/texml/voicemail', async (request, reply) => {
  const xml = await voicemailEntryHandler(request);
  app.log.info({ length: xml.length }, '[texml-vm] entry served (GET)');
  reply.type('application/xml; charset=utf-8').send(xml);
});
app.post('/texml/voicemail', async (request, reply) => {
  const xml = await voicemailEntryHandler(request);
  app.log.info({ length: xml.length }, '[texml-vm] entry served (POST)');
  reply.type('application/xml; charset=utf-8').send(xml);
});

app.post('/texml/voicemail/app-status', async (request, reply) => {
  const body = (request.body ?? {}) as any;
  app.log.info(
    {
      callStatus: body.CallStatus,
      callSid: body.CallSid,
      from: body.From,
      to: body.To,
    },
    '[texml-vm] app-status received',
  );
  reply.code(200).send('');
});

async function voicemailDialStatusHandler(
  request: { headers?: Record<string, unknown>; body?: unknown; query?: unknown },
): Promise<string> {
  const body = (request.body ?? {}) as any;
  const query = (request.query ?? {}) as any;
  const status: string =
    (typeof body.DialCallStatus === 'string' && body.DialCallStatus) ||
    (typeof query.DialCallStatus === 'string' && query.DialCallStatus) ||
    '';
  const queryAny = (request.query ?? {}) as any;
  const didFromQuery: string =
    (typeof queryAny.did === 'string' && queryAny.did) || '';
  const to = didFromQuery || extractToNumber(request);
  const baseUrl = texmlPublicBaseUrl(request);
  app.log.info(
    { to, didFromQuery, dialCallStatus: status },
    '[texml-vm] dial-status received',
  );
  const defaultGreeting = { mode: null, url: null, text: null } as const;
  let ownerFirstName: string | null = null;
  let greeting: { mode: 'audio' | 'tts' | 'default' | null; url: string | null; text: string | null } =
    { ...defaultGreeting };
  if (to) {
    const owner = await lookupDidOwner(to);
    if (owner) {
      ownerFirstName = owner.firstName;
      greeting = owner.greeting;
    }
  }
  return buildDialStatusTeXML({
    dialCallStatus: status,
    greeting,
    ownerFirstName,
    publicBaseUrl: baseUrl,
    didNumber: to,
  });
}

app.post('/texml/voicemail/dial-status', async (request, reply) => {
  const xml = await voicemailDialStatusHandler(request);
  app.log.info({ length: xml.length }, '[texml-vm] dial-status served (POST)');
  reply.type('application/xml; charset=utf-8').send(xml);
});
app.get('/texml/voicemail/dial-status', async (request, reply) => {
  const xml = await voicemailDialStatusHandler(request);
  app.log.info({ length: xml.length }, '[texml-vm] dial-status served (GET)');
  reply.type('application/xml; charset=utf-8').send(xml);
});

// Recording-complete callback. Enqueues the VM processing.
app.post('/texml/voicemail/recording-complete', async (request, reply) => {
  app.log.info(
    {
      query: request.query,
      bodyKeys: Object.keys((request.body ?? {}) as Record<string, unknown>),
    },
    '[texml-vm] recording-complete HIT - enqueuing',
  );
  try {
    const body = (request.body ?? {}) as any;
    const queryAny = (request.query ?? {}) as any;
    const didFromQuery: string | undefined =
      (typeof queryAny.did === 'string' && queryAny.did) || undefined;
    const fromNumber: string | undefined =
      (typeof body.From === 'string' && body.From) || (typeof body.from === 'string' && body.from) || undefined;
    const toNumber: string | undefined =
      didFromQuery ||
      (typeof body.To === 'string' && body.To) || (typeof body.to === 'string' && body.to) || undefined;
    const recordingUrl: string | undefined =
      (typeof body.RecordingUrl === 'string' && body.RecordingUrl) ||
      (typeof body.recording_url === 'string' && body.recording_url) ||
      undefined;
    const durationSeconds = Number(body.RecordingDuration ?? body.recording_duration ?? 0) || 0;
    const telnyxCallId: string | undefined =
      (typeof body.CallSid === 'string' && body.CallSid) || undefined;

    if (!fromNumber || !recordingUrl) {
      app.log.warn({ body }, '[texml-vm] recording-complete missing From or RecordingUrl');
      reply.type('application/xml; charset=utf-8').send('<?xml version="1.0" encoding="UTF-8"?>\n<Response/>');
      return;
    }

    await webhookQueue.add('voicemail', {
      fromNumber,
      toNumber,
      recordingUrl,
      durationSeconds,
      telnyxCallId,
      receivedAt: new Date().toISOString(),
      source: 'texml-vm',
    });
  } catch (e) {
    app.log.error({ err: e }, '[texml-vm] recording-complete handler error');
  }
  reply.type('application/xml; charset=utf-8').send('<?xml version="1.0" encoding="UTF-8"?>\n<Response/>');
});

// ---------- Voicemail recording webhook (Hosted VM) ----------
app.post('/webhooks/telnyx/voicemail', async (request) => {
  try {
    const body = request.body as any;
    const event = body?.data;
    let fromNumber: string | undefined;
    let toNumber: string | undefined;
    let recordingUrl: string | undefined;
    let durationSeconds = 0;
    let telnyxCallId: string | undefined;
    let receivedAt: string = new Date().toISOString();
    let transcription: string | undefined;
    let connectionId: string | undefined;

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
      if (payload.start_time) receivedAt = new Date(payload.start_time).toISOString();
      transcription = payload.transcription?.text;
      connectionId = payload.connection_id;
    } else {
      fromNumber = body?.from;
      toNumber = body?.to;
      recordingUrl = body?.recording_url;
      durationSeconds = Number(body?.duration_seconds ?? 0);
      telnyxCallId = body?.telnyx_call_id;
      transcription = body?.transcription;
      if (body?.received_at) receivedAt = new Date(body.received_at).toISOString();
      connectionId = body?.connection_id;
    }

    if (!fromNumber || !recordingUrl) {
      app.log.warn({ body }, '[telnyx] voicemail webhook missing from or recording_url');
      return { received: true };
    }

    await webhookQueue.add('voicemail', {
      fromNumber,
      toNumber,
      recordingUrl,
      durationSeconds,
      telnyxCallId,
      receivedAt,
      transcription,
      connectionId,
      source: 'hosted-vm',
    });
    return { received: true };
  } catch (e) {
    app.log.error({ err: e }, '[telnyx] voicemail handler error');
    return { received: true, error: String(e) };
  }
});
