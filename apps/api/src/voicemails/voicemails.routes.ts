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
