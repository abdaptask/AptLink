// Voicemail endpoints. Phase 5.6.
// Voicemail records are inserted by the webhook handler when Telnyx finishes
// recording an unanswered call. The user endpoints below read + mark as
// listened.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '@ace/db';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

// Hard retention period for voicemails. Anything older than this is
// auto-deleted on the next list fetch. Frontend renders an "Auto-deletes
// in X days" countdown using the same constant.
export const VOICEMAIL_RETENTION_DAYS = 30;

// Delete voicemails older than the retention window FOR THIS USER.
// Lazy approach — runs on every /voicemails list fetch, so we don't need
// a long-running cron. The cost is O(rows deleted) DELETE which uses the
// (userId, receivedAt) index; trivial for normal volumes.
async function purgeExpired(userId: number): Promise<number> {
  const cutoff = new Date(Date.now() - VOICEMAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const res = await prisma.voicemail.deleteMany({
    where: { userId, receivedAt: { lt: cutoff } },
  });
  return res.count;
}

export async function voicemailsRoutes(app: FastifyInstance) {
  // GET /voicemails — list newest-first, capped at 100. Also purges any
  // voicemails past the 30-day retention window before returning, so the
  // user never sees expired rows.
  app.get('/voicemails', { onRequest: [app.authenticate] }, async (request: FastifyRequest) => {
    const user = request.user as JwtPayload;
    const purged = await purgeExpired(user.sub);
    if (purged > 0) {
      app.log.info({ userId: user.sub, purged }, '[voicemail] auto-deleted expired rows');
    }
    const items = await prisma.voicemail.findMany({
      where: { userId: user.sub },
      orderBy: { receivedAt: 'desc' },
      take: 100,
      // v0.10.0 Task 5 — include UserDid for the line-badge tag.
      include: {
        userDid: {
          select: { id: true, label: true, colorHex: true, didNumber: true },
        },
      },
    });
    return items;
  });

  // GET /voicemails/retention — what the frontend uses to compute the
  // "auto-deletes in X days" countdown. Exposing as an endpoint keeps the
  // value server-controlled — if we ever change retention to 60 or 90 days,
  // the frontend updates automatically without a redeploy.
  app.get('/voicemails/retention', { onRequest: [app.authenticate] }, async () => {
    return { days: VOICEMAIL_RETENTION_DAYS };
  });

  // GET /voicemails/unread/count — small endpoint to populate the tab badge.
  app.get('/voicemails/unread/count', { onRequest: [app.authenticate] }, async (request: FastifyRequest) => {
    const user = request.user as JwtPayload;
    // Also purge here so the badge doesn't count expired rows.
    await purgeExpired(user.sub);
    const count = await prisma.voicemail.count({
      where: { userId: user.sub, listenedAt: null },
    });
    return { count };
  });

  // v0.10.2 Task 9 — single voicemail metadata for the playback page.
  // Used by /voicemail/:id/play to render caller info + transcript.
  // Guards on userId so a user can't fetch someone else's voicemail.
  app.get('/voicemails/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };
    const vmId = Number(id);
    if (!Number.isFinite(vmId)) {
      return reply.code(400).send({ error: 'Invalid id' });
    }
    const vm = await prisma.voicemail.findFirst({
      where: { id: vmId, userId: user.sub },
      include: {
        userDid: {
          select: { id: true, label: true, colorHex: true, didNumber: true },
        },
      },
    });
    if (!vm) return reply.code(404).send({ error: 'Not found' });
    return vm;
  });

  // v0.10.2 Task 9 — audio proxy. Telnyx hosted-voicemail recordings
  // live behind a Bearer-auth-protected URL on api.telnyx.com — the
  // browser can't fetch them directly. We proxy: authenticate the
  // requesting user via JWT, verify they own the voicemail, fetch the
  // upstream MP3 with our Telnyx API key, stream the bytes back with
  // an audio Content-Type so the HTML5 <audio> tag plays it.
  //
  // We DON'T cache the upstream URL — it's tied to our Telnyx account
  // and rotating credentials means a stale URL would 401 anyway. Each
  // playback fetches fresh.
  app.get(
    '/voicemails/:id/audio',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const { id } = request.params as { id: string };
      const vmId = Number(id);
      if (!Number.isFinite(vmId)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const vm = await prisma.voicemail.findFirst({
        where: { id: vmId, userId: user.sub },
        select: { id: true, recordingUrl: true },
      });
      if (!vm) return reply.code(404).send({ error: 'Not found' });
      if (!vm.recordingUrl) {
        return reply.code(404).send({ error: 'No recording available' });
      }
      const telnyxKey = process.env.TELNYX_API_KEY;
      try {
        const headers: Record<string, string> = {};
        // Only attach Telnyx Bearer when the URL is actually on
        // api.telnyx.com. Some legacy rows might point at signed S3
        // URLs from older test setups — sending Bearer on those is
        // harmless but explicit-gating avoids leaking the key.
        if (telnyxKey && /(^|\.)telnyx\.com\//.test(vm.recordingUrl)) {
          headers.Authorization = `Bearer ${telnyxKey}`;
        }
        const upstream = await fetch(vm.recordingUrl, { method: 'GET', headers });
        if (!upstream.ok) {
          request.log.warn(
            { voicemailId: vm.id, status: upstream.status },
            '[voicemail] upstream audio fetch failed',
          );
          return reply.code(502).send({
            error: `Failed to fetch audio: HTTP ${upstream.status}`,
          });
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        // Telnyx recordings are MP3. Set explicit Content-Type so the
        // browser's <audio> element plays without guessing. Allow
        // caching since the recording itself is immutable.
        reply
          .header('Content-Type', upstream.headers.get('content-type') ?? 'audio/mpeg')
          .header('Content-Length', String(buf.length))
          .header('Cache-Control', 'private, max-age=3600')
          .header('Accept-Ranges', 'bytes');
        return reply.send(buf);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        request.log.error({ err: msg }, '[voicemail] audio proxy error');
        return reply.code(502).send({ error: `Audio proxy error: ${msg}` });
      }
    },
  );

  // PATCH /voicemails/:id  { listened?: boolean }
  app.patch('/voicemails/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };
    const body = (request.body as { listened?: boolean }) ?? {};
    const existing = await prisma.voicemail.findFirst({
      where: { id: Number(id), userId: user.sub },
    });
    if (!existing) return reply.code(404).send({ error: 'Not found' });
    const data: Record<string, unknown> = {};
    if (body.listened === true) data.listenedAt = new Date();
    else if (body.listened === false) data.listenedAt = null;
    const updated = await prisma.voicemail.update({
      where: { id: existing.id },
      data,
    });
    return updated;
  });

  // PATCH /voicemails/bulk  { ids: number[], listened: boolean }
  // Bulk mark multiple voicemails as listened/unlistened. Used by the
  // select-mode toolbar.
  app.patch('/voicemails/bulk', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const body = (request.body as { ids?: number[]; listened?: boolean }) ?? {};
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return reply.code(400).send({ error: 'ids[] required' });
    }
    if (typeof body.listened !== 'boolean') {
      return reply.code(400).send({ error: 'listened (boolean) required' });
    }
    const result = await prisma.voicemail.updateMany({
      where: { id: { in: body.ids.map((i) => Number(i)) }, userId: user.sub },
      data: { listenedAt: body.listened ? new Date() : null },
    });
    return { ok: true, count: result.count };
  });

  // DELETE /voicemails/:id
  app.delete('/voicemails/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };
    const existing = await prisma.voicemail.findFirst({
      where: { id: Number(id), userId: user.sub },
    });
    if (!existing) return reply.code(404).send({ error: 'Not found' });
    await prisma.voicemail.delete({ where: { id: existing.id } });
    return { ok: true };
  });
}
