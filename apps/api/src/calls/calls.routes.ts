// Call history endpoints. Phase 5.1 — client-side logging.
// The web app reports call lifecycle here (start / end) because Telnyx
// Call Control webhooks don't fire for SDK-originated WebRTC calls.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '@ace/db';
import { config } from '../config.js';
import { dial, transfer, encodeClientState, normalizeToE164, conferenceCreate, conferenceJoin, listLegsBySession } from '../telnyx/callControl.js';

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
  // --- Missed-call count for bottom-nav badge ---
  // Counts inbound calls that didn't connect (missed/no_answer/rejected/failed)
  // since `?since=<ISO>`. The web client tracks last-visit-to-recents in
  // localStorage and passes it here, so we don't need a per-call viewed flag.
  app.get(
    '/calls/missed/count',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const user = request.user as JwtPayload;
      const sinceRaw = (request.query as { since?: string }).since;
      const since = sinceRaw ? new Date(sinceRaw) : new Date(0);
      const count = await prisma.call.count({
        where: {
          userId: user.sub,
          direction: 'inbound',
          status: { in: ['missed', 'no_answer', 'rejected', 'failed'] },
          startedAt: { gt: since },
        },
      });
      return { count };
    },
  );

  app.get('/calls', { onRequest: [app.authenticate] }, async (request: FastifyRequest) => {
    const user = request.user as JwtPayload;
    // Filter out server-internal call rows the user shouldn't see:
    //   - SIP URI targets (e.g. sip:userabdulla74993@sip.telnyx.com) from
    //     legacy Call Control flows where the webhook itself originated a
    //     leg to bridge to the WebRTC user. Those are infrastructure, not
    //     phone calls the user made.
    //   - Empty/placeholder phone numbers.
    // Result: Recents shows only real PSTN/external calls, like an iPhone.
    const calls = await prisma.call.findMany({
      where: {
        userId: user.sub,
        AND: [
          { NOT: { toNumber: { startsWith: 'sip:' } } },
          { NOT: { fromNumber: { startsWith: 'sip:' } } },
          { NOT: { toNumber: '' } },
          { NOT: { fromNumber: '' } },
        ],
      },
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

    // Normalize 'to' to E.164 — Telnyx error code 10016 rejects anything else.
    const toE164 = normalizeToE164(body.to);
    const from = callRow?.fromNumber || config.pilotFromNumber;
    app.log.info({ callControlId, to: toE164, from, rawTo: body.to }, '[transfer] dispatching');
    const result = await transfer(callControlId, { to: toE164, from });
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

  // ---------- Phase 5.4 (rebuild v2): Add Call via Telnyx Conference ----------
  // Replaces the legacy "bridge" flow. Conference gives us proper N-way
  // semantics: each leg can hang up independently without ending the call
  // for the others. The user's WebRTC leg ends the conference on exit so
  // their hangup tears it down for everyone else (matches iPhone behavior).
  //
  // Flow:
  //   1. Look up Leg A's PSTN leg row (callControlId match)
  //   2. Find its sessionId, then list all sibling legs in the same session.
  //      That sibling is the WebRTC leg (the user's side).
  //   3. Create a Telnyx Conference with the WebRTC leg as the initial
  //      participant (end_conference_on_exit: true). This means the user
  //      hears the conference mix and ending the user's leg ends everything.
  //   4. Join the PSTN A leg to the conference (end_conference_on_exit: false).
  //   5. Originate Leg B via Call Control with client_state.joinConfId set.
  //      The webhook handler joins Leg B to the conference on call.answered.
  app.post('/calls/add-leg', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const body = (request.body as { legAControlId?: string; destination?: string }) ?? {};
    if (!body.legAControlId || !body.destination) {
      return reply.code(400).send({ error: 'legAControlId and destination are required' });
    }
    if (!config.telnyxApiKey) {
      return reply.code(501).send({ error: 'TELNYX_API_KEY not set' });
    }
    if (!config.telnyxCcConnectionId) {
      return reply.code(501).send({
        error: 'TELNYX_CC_CONNECTION_ID not set',
        hint: 'Set TELNYX_CC_CONNECTION_ID to your Call Control Application connection ID.',
      });
    }

    // Step 1+2: find Leg A's row + its sibling WebRTC leg in the same session.
    // Conference works only if we have BOTH legs (WC + PSTN). If the webhook
    // only captured the PSTN side, we'd disconnect the user's audio by moving
    // PSTN into a conference — so we fall back to legacy bridge in that case.
    const legARow = await prisma.call.findFirst({
      where: { callControlId: body.legAControlId, userId: user.sub },
      select: { id: true, sessionId: true, telnyxCallId: true },
    });
    const sessionLegs = legARow?.sessionId
      ? await prisma.call.findMany({
          where: {
            sessionId: legARow.sessionId,
            userId: user.sub,
            callControlId: { not: null },
          },
          select: { callControlId: true, direction: true, fromNumber: true, toNumber: true },
        })
      : [];
    let otherLeg = sessionLegs.find((l) => l.callControlId !== body.legAControlId);
    let otherLegSource: 'db' | 'telnyx' | 'none' = otherLeg ? 'db' : 'none';

    // Fallback: Telnyx only emits webhooks for the PSTN side of SDK calls,
    // so our DB usually has just one row. Query Telnyx's REST API for all
    // legs sharing this session — that's where the WebRTC client leg lives.
    if (!otherLeg && legARow?.sessionId) {
      const legsResult = await listLegsBySession(legARow.sessionId);
      if (legsResult.ok && Array.isArray(legsResult.data?.data)) {
        const allLegs = legsResult.data!.data;
        const sibling = allLegs.find(
          (l) => l.call_control_id !== body.legAControlId && l.is_alive,
        );
        if (sibling) {
          otherLeg = {
            callControlId: sibling.call_control_id,
            direction: 'inbound', // best guess — the WC leg
            fromNumber: sibling.from ?? '',
            toNumber: sibling.to ?? '',
          };
          otherLegSource = 'telnyx';
        }
        app.log.info(
          {
            sessionId: legARow.sessionId,
            legsReturned: allLegs.length,
            legsDetail: allLegs.map((l) => ({
              cc: l.call_control_id,
              alive: l.is_alive,
              from: l.from,
              to: l.to,
            })),
          },
          '[add-leg] queried Telnyx for session legs',
        );
      } else {
        app.log.warn(
          { status: legsResult.status, error: legsResult.error },
          '[add-leg] Telnyx legs query failed',
        );
      }
    }

    app.log.info(
      {
        legAControlId: body.legAControlId,
        legASessionId: legARow?.sessionId,
        sessionLegsFoundInDb: sessionLegs.length,
        sessionLegsDetail: sessionLegs.map((l) => ({
          cc: l.callControlId,
          dir: l.direction,
          from: l.fromNumber,
          to: l.toNumber,
        })),
        otherLeg: otherLeg ? { cc: otherLeg.callControlId, dir: otherLeg.direction, source: otherLegSource } : null,
      },
      '[add-leg] inspected session',
    );

    const toE164 = normalizeToE164(body.destination);
    let confId: string | null = null;
    let clientState: string;

    if (otherLeg?.callControlId) {
      // ✅ Have both legs — use proper Conference (true 3-way, independent hangups).
      const confName = `addcall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      app.log.info(
        { confName, userLeg: otherLeg.callControlId, sessionId: legARow?.sessionId },
        '[add-leg] using Conference flow (both legs captured)',
      );
      const confResult = await conferenceCreate(confName, otherLeg.callControlId, {
        endConfOnExit: true, // user's leg ending = end conference for all
        beepEnabled: 'never',
      });
      if (!confResult.ok) {
        app.log.warn({ status: confResult.status, error: confResult.error }, '[add-leg] conference create failed');
        return reply.code(502).send({
          error: 'telnyx_conference_create_failed',
          status: confResult.status,
          details: confResult.error,
        });
      }
      confId = confResult.data?.data?.id ?? null;
      if (!confId) {
        return reply.code(502).send({ error: 'telnyx_response_invalid' });
      }
      // Join the PSTN A leg too.
      const joinAResult = await conferenceJoin(confId, body.legAControlId, { endConfOnExit: false });
      if (!joinAResult.ok) {
        app.log.warn({ status: joinAResult.status, error: joinAResult.error }, '[add-leg] join legA to conf failed');
      }
      clientState = encodeClientState({
        joinConfId: confId,
        endConfOnExit: false,
        originatorUserId: user.sub,
      });
    } else {
      // ⚠️ Only have the PSTN leg — fall back to legacy bridge. When B answers
      // the webhook will bridge B↔A; the WebRTC client gets unbridged from A
      // (briefly) but the existing call stays connected until then. Cascading
      // hangups apply (when one party drops, the bridge tears down).
      app.log.info(
        { legA: body.legAControlId, sessionId: legARow?.sessionId },
        '[add-leg] using LEGACY bridge flow (WebRTC sibling not captured)',
      );
      clientState = encodeClientState({
        bridgeTo: body.legAControlId,
        autoBridge: true,
        originatorUserId: user.sub,
      });
    }
    const dialResult = await dial({
      to: toE164,
      from: config.pilotFromNumber,
      connectionId: config.telnyxCcConnectionId,
      clientState,
    });
    if (!dialResult.ok) {
      app.log.warn({ status: dialResult.status, error: dialResult.error }, '[add-leg] dial failed');
      return reply.code(502).send({
        error: 'telnyx_dial_failed',
        status: dialResult.status,
        details: dialResult.error,
      });
    }

    const legBControlId = dialResult.data?.data?.call_control_id;
    const legBSessionId = dialResult.data?.data?.call_session_id;
    const legBLegId = dialResult.data?.data?.call_leg_id;
    if (!legBControlId) {
      return reply.code(502).send({ error: 'telnyx_response_invalid' });
    }

    await prisma.call.upsert({
      where: { telnyxCallId: legBControlId },
      update: { sessionId: legBSessionId ?? null, status: 'initiated' },
      create: {
        userId: user.sub,
        telnyxCallId: legBControlId,
        sessionId: legBSessionId ?? null,
        callControlId: legBControlId,
        direction: 'outbound',
        fromNumber: config.pilotFromNumber,
        toNumber: toE164,
        status: 'initiated',
        startedAt: new Date(),
      },
    });

    app.log.info(
      { confId, legA: body.legAControlId, legB: legBControlId, to: toE164, mode: confId ? 'conference' : 'bridge' },
      '[add-leg] setup complete; leg B dialing',
    );

    return {
      ok: true,
      ...(confId ? { conferenceId: confId } : {}),
      legB: {
        telnyxCallId: legBLegId ?? legBControlId,
        callControlId: legBControlId,
        toNumber: toE164,
      },
    };
  });
}
