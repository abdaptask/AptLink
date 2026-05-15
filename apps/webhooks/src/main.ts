// ACE Dialer Webhooks — Telnyx inbound webhook receiver.
// Phase 5.1: persist call lifecycle events to the database.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { prisma } from '@ace/db';

const SERVICE_NAME = 'ace-dialer-webhooks';
const START_TIME = new Date().toISOString();

// Phase 5: pilot has one user. Hardcoded until multi-user support lands.
const PILOT_USER_ID = 1;
const PILOT_NUMBER = process.env.PILOT_TELNYX_NUMBER ?? '+15758001313';

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

    app.log.info(
      { eventType: event.event_type, callId, direction, fromNumber, toNumber },
      '[telnyx] call event'
    );

    switch (event.event_type) {
      case 'call.initiated': {
        await prisma.call.upsert({
          where: { telnyxCallId: callId },
          update: { status: 'initiated' },
          create: {
            userId: PILOT_USER_ID,
            telnyxCallId: callId,
            sessionId: payload.call_session_id ?? null,
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
          },
        });
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

// SMS webhook stub — Phase 5.3 fills this in.
app.post('/webhooks/telnyx/sms', async (request) => {
  app.log.info({ payload: request.body }, '[telnyx] sms event (stub)');
  return { received: true };
});

app.post('/webhooks/telnyx/failover', async (request) => {
  app.log.info({ payload: request.body }, '[telnyx] failover event');
  return { received: true };
});

// Catch-all for any path we didn't register — helps diagnose if Telnyx is posting
// to a slightly different URL than we expect.
app.all('/*', async (request, reply) => {
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
