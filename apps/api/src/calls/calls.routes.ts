// Call history endpoints. Phase 5.1 — client-side logging.
// The web app reports call lifecycle here (start / end) because Telnyx
// Call Control webhooks don't fire for SDK-originated WebRTC calls.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '@ace/db';
import { config } from '../config.js';
import { dial, transfer, encodeClientState } from '../telnyx/callControl.js';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

interface CreateCallBody {
  telnyxCallId: string;
  direction?: 'inbound' | 'outbound';
  fromNumber: string;
  toNumber: string;
  status?: string;
  startedAt?: string;
}

interface UpdateCallBody {
  status?: string;
  answeredAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number;
  hangupCause?: string | null;
}

export async function callsRoutes(app: FastifyInstance) {
  app.get('/calls', { onRequest: [app.authenticate] }, async (request: FastifyRequest) => {
    const user = request.user as JwtPayload;
    const calls = await prisma.call.findMany({
      where: { userId: user.sub },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    return calls;
  });

  app.get('/calls/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };
    const call = await prisma.call.findFirst({
      where: { id: Number(id), userId: user.sub },
    });
    if (!call) return reply.code(404).send({ error: 'Not found' });
    return call;
  });

  app.post('/calls', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const body = request.body as CreateCallBody;

    if (!body?.telnyxCallId || !body?.fromNumber || !body?.toNumber) {
      return reply
        .code(400)
        .send({ error: 'telnyxCallId, fromNumber, and toNumber are required' });
    }

    const direction = body.direction === 'inbound' ? 'inbound' : 'outbound';
    const startedAt = body.startedAt ? new Date(body.startedAt) : new Date();
    const status = body.status ?? 'initiated';

    const call = await prisma.call.upsert({
      where: { telnyxCallId: body.telnyxCallId },
      update: { status },
      create: {
        userId: user.sub,
        telnyxCallId: body.telnyxCallId,
        direction,
        fromNumber: body.fromNumber,
        toNumber: body.toNumber,
        status,
        startedAt,
      },
    });

    return call;
  });

  app.patch('/calls/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };
    const body = (request.body as UpdateCallBody) ?? {};

    const where = /^\d+$/.test(id)
      ? { id: Number(id), userId: user.sub }
      : { telnyxCallId: id, userId: user.sub };

    const existing = await prisma.call.findFirst({ where });
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    const data: Record<string, unknown> = {};
    if (body.status !== undefined) data.status = body.status;
    if (body.answeredAt !== undefined)
      data.answeredAt = body.answeredAt ? new Date(body.answeredAt) : null;
    if (body.endedAt !== undefined)
      data.endedAt = body.endedAt ? new Date(body.endedAt) : null;
    if (body.durationSeconds !== undefined) data.durationSeconds = body.durationSeconds;
    if (body.hangupCause !== undefined) data.hangupCause = body.hangupCause;

    const call = await prisma.call.update({
      where: { id: existing.id },
      data,
    });

    return call;
  });

  // ---------- Phase 5.5: Call recording (start / stop) ----------
  // The web client calls this when the user taps Record. We look up the
  // call's Call Control ID and POST to Telnyx's recording action. Telnyx
  // fires `call.recording.saved` to our webhook with the recording URL,
  // which the webhook handler writes onto the call row.
  // Record start/stop — URL param is the CC ID (not SDK's call.id).
  app.post('/calls/:callControlId/recording/start', { onRequest: [app.authenticate] }, async (_request, reply) => {
    const { callControlId } = _request.params as { callControlId: string };
    if (!config.telnyxApiKey) {
      return reply.code(501).send({ error: 'TELNYX_API_KEY not set on the API server' });
    }
    try {
      const res = await fetch(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/record_start`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.telnyxApiKey}`,
          },
          body: JSON.stringify({ format: 'mp3', channels: 'dual' }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return reply.code(502).send({ error: 'telnyx_record_start_failed', status: res.status, details: body });
      }
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({
        error: 'telnyx_request_failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  app.post('/calls/:callControlId/recording/stop', { onRequest: [app.authenticate] }, async (_request, reply) => {
    const { callControlId } = _request.params as { callControlId: string };
    if (!config.telnyxApiKey) {
      return reply.code(501).send({ error: 'TELNYX_API_KEY not set on the API server' });
    }
    try {
      const res = await fetch(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/record_stop`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.telnyxApiKey}`,
          },
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return reply.code(502).send({ error: 'telnyx_record_stop_failed', status: res.status, details: body });
      }
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({
        error: 'telnyx_request_failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ---------- Phase 5.4: Conference (merge two legs) ----------
  // The web client calls this when the user taps "Merge". Server-side we look
  // up each leg's Call Control ID (captured by the webhook from Telnyx's
  // call.initiated / call.answered events) and use Telnyx's bridge action to
  // join them so all three parties hear each other.
  //
  // Prerequisites:
  //   - TELNYX_API_KEY env var on this service.
  //   - Call Control enabled on the SIP connection (Telnyx portal → SIP
  //     connection → API V2 / Call Control).
  //   - Webhook URL registered against that connection so call_control_id
  //     reaches our database.
  // Conference / Merge — body carries Call Control IDs directly (not SDK ids).
  app.post('/calls/conference', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = (request.body as { legA?: string; legB?: string }) ?? {};
    if (!body.legA || !body.legB) {
      return reply.code(400).send({ error: 'legA and legB are required (callControlIds)' });
    }
    if (!config.telnyxApiKey) {
      return reply.code(501).send({
        error: 'TELNYX_API_KEY not set on the API server',
        hint: 'Set TELNYX_API_KEY in the Render dashboard for ace-dialer-api, then redeploy.',
      });
    }
    try {
      const res = await fetch(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(body.legA)}/actions/bridge`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.telnyxApiKey}`,
          },
          body: JSON.stringify({ call_control_id: body.legB }),
        },
      );
      const responseBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        app.log.warn({ status: res.status, body: responseBody }, '[calls] telnyx bridge failed');
        return reply.code(502).send({
          error: 'telnyx_bridge_failed',
          status: res.status,
          details: responseBody,
        });
      }
      app.log.info({ legA: body.legA, legB: body.legB }, '[calls] conference bridged');
      return { ok: true, telnyx: responseBody };
    } catch (e) {
      app.log.error({ err: e }, '[calls] bridge request error');
      return reply.code(502).send({
        error: 'telnyx_request_failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ---------- Phase 5.4 (rebuild): Lookup callControlId for a leg ----------
  // The frontend polls this after a call connects so it can hand the ID to
  // /transfer, /add-leg, /conference, and /recording endpoints.
  //
  // Two-stage lookup because the Telnyx WebRTC SDK assigns its own call.id
  // (an InviteID-style UUID) on the client, while Telnyx's webhook fires
  // events keyed by `call_session_id` — a DIFFERENT UUID. Those don't match,
  // so an exact lookup on the SDK's id usually returns nothing.
  //
  //   Stage 1: exact match on telnyxCallId (works if SDK id == session id).
  //   Stage 2: fuzzy fallback — most recent row for this user where toNumber
  //            matches, callControlId is present, and startedAt is within
  //            the last 60s. This is what catches the SDK/webhook mismatch.
  app.get('/calls/by-telnyx/:telnyxCallId', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const { telnyxCallId } = request.params as { telnyxCallId: string };
    const query = request.query as { to?: string; direction?: string };
    const SELECT = {
      id: true,
      telnyxCallId: true,
      callControlId: true,
      sessionId: true,
      direction: true,
      fromNumber: true,
      toNumber: true,
      status: true,
    } as const;

    // Stage 1: exact ID match.
    const exact = await prisma.call.findFirst({
      where: { telnyxCallId, userId: user.sub },
      select: SELECT,
    });
    if (exact?.callControlId) return exact;

    // Stage 2: fuzzy fallback by destination + recency. Only applies when
    // the caller hands us a `to` query param so we know what to match on.
    if (query.to) {
      // Normalize phone numbers to digits-only for comparison so e.g.
      // "+19737270611" matches "19737270611".
      const wantDigits = query.to.replace(/[^\d]/g, '');
      const since = new Date(Date.now() - 60_000);
      const recents = await prisma.call.findMany({
        where: {
          userId: user.sub,
          callControlId: { not: null },
          startedAt: { gte: since },
          ...(query.direction ? { direction: query.direction } : {}),
        },
        orderBy: { startedAt: 'desc' },
        take: 10,
        select: SELECT,
      });
      const match = recents.find((r) => {
        const haveDigits = (r.toNumber ?? '').replace(/[^\d]/g, '');
        return haveDigits.endsWith(wantDigits) || wantDigits.endsWith(haveDigits);
      });
      if (match) {
        app.log.info(
          { sdkCallId: telnyxCallId, matched: match.telnyxCallId, callControlId: match.callControlId },
          '[lookup] fuzzy match on destination + recency',
        );
        return match;
      }
    }

    return exact ?? reply.code(404).send({ error: 'Call not found' });
  });

  // ---------- Phase 5.4 (rebuild): Transfer via Call Control ----------
  // The Telnyx WebRTC SDK doesn't expose a .transfer() method on the call
  // object, so transfer has to happen server-side using the leg's
  // call_control_id. The URL param is the CC ID (NOT the SDK's call.id) —
  // the frontend resolves it via /calls/by-telnyx/:id and passes it here.
  app.post('/calls/:callControlId/transfer', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const { callControlId } = request.params as { callControlId: string };
    const body = (request.body as { to?: string }) ?? {};
    if (!body.to) return reply.code(400).send({ error: 'to is required' });
    if (!config.telnyxApiKey) {
      return reply.code(501).send({ error: 'TELNYX_API_KEY not set' });
    }

    // Best-effort lookup of the originating "from" number. If we don't have
    // a row (shouldn't happen — webhook creates one — but be safe), fall
    // back to the pilot DID.
    const callRow = await prisma.call.findFirst({
      where: { callControlId, userId: user.sub },
      select: { fromNumber: true },
    });

    const from = callRow?.fromNumber || config.pilotFromNumber;
    app.log.info({ callControlId, to: body.to, from }, '[transfer] dispatching');
    const result = await transfer(callControlId, { to: body.to, from });
    if (!result.ok) {
      // Telnyx error envelope is usually { errors: [{ code, title, detail, ... }] }
      // Surface the first error's detail to the UI so the user sees the real cause.
      const errObj = result.error as { errors?: Array<{ code?: string; title?: string; detail?: string; meta?: unknown }> } | undefined;
      const firstErr = errObj?.errors?.[0];
      const userMessage = firstErr
        ? `${firstErr.title ?? 'Transfer failed'}: ${firstErr.detail ?? ''} (code ${firstErr.code ?? '?'})`
        : `Telnyx returned HTTP ${result.status}`;
      app.log.warn({ status: result.status, error: result.error, callControlId, to: body.to }, '[transfer] telnyx rejected');
      return reply.code(502).send({
        error: 'telnyx_transfer_failed',
        status: result.status,
        details: result.error,
        hint: userMessage,
      });
    }
    app.log.info({ callControlId, to: body.to }, '[transfer] dispatched');
    return { ok: true };
  });

  // ---------- Phase 5.4 (rebuild): Server-originated Add Call (Leg B) ----------
  // Originates the second leg via Call Control (not the WebRTC SDK), so we
  // have its call_control_id immediately and don't have to race a webhook.
  // The leg's `client_state` carries the active leg's call_control_id; when
  // Telnyx fires `call.answered` on leg B, the webhook handler reads the
  // client_state and bridges leg B onto leg A → both parties hear each other,
  // plus the user on leg A. Effectively a 3-way conference.
  app.post('/calls/add-leg', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const body = (request.body as { legAControlId?: string; destination?: string; autoBridge?: boolean }) ?? {};
    if (!body.legAControlId || !body.destination) {
      return reply.code(400).send({ error: 'legAControlId and destination are required' });
    }

    if (!config.telnyxApiKey) {
      return reply.code(501).send({ error: 'TELNYX_API_KEY not set' });
    }
    if (!config.telnyxCcConnectionId) {
      return reply.code(501).send({
        error: 'TELNYX_CC_CONNECTION_ID not set',
        hint: 'Set TELNYX_CC_CONNECTION_ID to your Call Control Application connection ID in the Telnyx portal.',
      });
    }

    // Normalize destination to E.164 (Telnyx requires + prefix).
    const cleaned = body.destination.replace(/[^\d+]/g, '');
    const e164 =
      cleaned.startsWith('+')
        ? cleaned
        : cleaned.length === 11 && cleaned.startsWith('1')
          ? `+${cleaned}`
          : cleaned.length === 10
            ? `+1${cleaned}`
            : `+${cleaned}`;

    const clientState = encodeClientState({
      bridgeTo: body.legAControlId,
      autoBridge: body.autoBridge !== false, // default true
      originatorUserId: user.sub,
    });

    const dialResult = await dial({
      to: e164,
      from: config.pilotFromNumber,
      connectionId: config.telnyxCcConnectionId,
      clientState,
    });

    if (!dialResult.ok) {
      app.log.warn({ status: dialResult.status, error: dialResult.error }, '[add-leg] telnyx dial failed');
      return reply.code(502).send({
        error: 'telnyx_dial_failed',
        status: dialResult.status,
        details: dialResult.error,
      });
    }

    const legBControlId = dialResult.data?.data?.call_control_id;
    const legBSessionId = dialResult.data?.data?.call_session_id;
    const legBCallLegId = dialResult.data?.data?.call_leg_id;

    if (!legBControlId) {
      app.log.error({ data: dialResult.data }, '[add-leg] telnyx response missing call_control_id');
      return reply.code(502).send({ error: 'telnyx_response_invalid' });
    }

    // Persist Leg B so the rest of the app (recording, conference merge, etc.)
    // can find it by its telnyxCallId. We use the call_leg_id as our local
    // telnyxCallId since that's what the SDK would normally generate.
    const localCallId = legBCallLegId ?? legBControlId;
    await prisma.call.upsert({
      where: { telnyxCallId: localCallId },
      update: { callControlId: legBControlId, sessionId: legBSessionId ?? null, status: 'initiated' },
      create: {
        userId: user.sub,
        telnyxCallId: localCallId,
        sessionId: legBSessionId ?? null,
        callControlId: legBControlId,
        direction: 'outbound',
        fromNumber: config.pilotFromNumber,
        toNumber: e164,
        status: 'initiated',
        startedAt: new Date(),
      },
    });

    app.log.info(
      { legA: body.legAControlId, legB: legBControlId, to: e164 },
      '[add-leg] originated leg B via call control',
    );

    return {
      ok: true,
      legB: {
        telnyxCallId: localCallId,
        callControlId: legBControlId,
        toNumber: e164,
      },
    };
  });
}
