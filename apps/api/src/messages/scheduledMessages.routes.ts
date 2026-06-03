// v0.10.59 — Scheduled SMS/MMS CRUD endpoints.
//
// Routes (all auth-required, per-user scoped):
//   GET    /me/scheduled-messages?status=pending  list pending (default) or any status
//   POST   /me/scheduled-messages                 schedule a new one
//   PATCH  /me/scheduled-messages/:id             edit body, mediaUrls, scheduledFor
//   DELETE /me/scheduled-messages/:id             cancel (status='canceled')
//
// Editing/canceling is only allowed while status='pending'. Once the
// worker has claimed the row ('sending') or sent it, the row is frozen.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '@ace/db';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

function toE164(raw: string): string {
  const cleaned = (raw ?? '').replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  return `+${cleaned}`;
}

interface CreateBody {
  toNumber: string;
  body?: string;
  mediaUrls?: string[];
  scheduledFor: string;  // ISO 8601 UTC
  userDidId?: number;    // optional pin; defaults to active at send time
}

interface UpdateBody {
  body?: string;
  mediaUrls?: string[];
  scheduledFor?: string;
}

export async function scheduledMessagesRoutes(app: FastifyInstance) {
  // ── GET /me/scheduled-messages ────────────────────────────────────────────
  app.get('/me/scheduled-messages', { onRequest: [app.authenticate] }, async (request: FastifyRequest) => {
    const user = request.user as JwtPayload;
    const query = request.query as { status?: string; threadKey?: string };
    const status = query.status ?? 'pending';
    const where: Record<string, unknown> = { userId: user.sub };
    if (status !== 'all') where.status = status;
    if (query.threadKey) where.toNumber = toE164(query.threadKey);
    const rows = await prisma.scheduledMessage.findMany({
      where,
      orderBy: { scheduledFor: 'asc' },
      take: 200,
      select: {
        id: true,
        toNumber: true,
        body: true,
        mediaUrls: true,
        scheduledFor: true,
        userDidId: true,
        status: true,
        attempts: true,
        lastError: true,
        telnyxMessageId: true,
        sentAt: true,
        createdAt: true,
      },
    });
    return { scheduledMessages: rows };
  });

  // ── POST /me/scheduled-messages ───────────────────────────────────────────
  app.post('/me/scheduled-messages', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const body = request.body as CreateBody;

    if (!body?.toNumber || !body.scheduledFor) {
      return reply.code(400).send({ error: 'toNumber and scheduledFor required' });
    }
    const text = body.body ?? '';
    const mediaUrls = body.mediaUrls ?? [];
    if (text.trim() === '' && mediaUrls.length === 0) {
      return reply.code(400).send({ error: 'body or mediaUrls required' });
    }
    const scheduledFor = new Date(body.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime())) {
      return reply.code(400).send({ error: 'scheduledFor is not a valid date' });
    }
    // Refuse anything more than 5 seconds in the past — caller's clock is
    // off or they mis-typed. (Slight grace window so a quick-send doesn't
    // race the worker.)
    if (scheduledFor.getTime() < Date.now() - 5_000) {
      return reply.code(400).send({ error: 'scheduledFor is in the past' });
    }

    // Resolve which UserDid to pin. If caller didn't supply one, default
    // to their currently-active DID so the message goes out from the
    // number they had selected when they scheduled it.
    let userDidId: number | null = body.userDidId ?? null;
    if (!userDidId) {
      const me = await prisma.user.findUnique({
        where: { id: user.sub },
        select: { activeUserDidId: true, userDids: { select: { id: true, isDefault: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] } },
      });
      userDidId = me?.activeUserDidId ?? me?.userDids[0]?.id ?? null;
    } else {
      // Validate the caller-supplied DID actually belongs to them.
      const owned = await prisma.userDid.findFirst({
        where: { id: userDidId, userId: user.sub },
        select: { id: true },
      });
      if (!owned) return reply.code(400).send({ error: 'userDidId does not belong to you' });
    }

    const row = await prisma.scheduledMessage.create({
      data: {
        userId: user.sub,
        toNumber: toE164(body.toNumber),
        body: text,
        mediaUrls,
        scheduledFor,
        userDidId,
        status: 'pending',
      },
      select: {
        id: true, toNumber: true, body: true, mediaUrls: true,
        scheduledFor: true, userDidId: true, status: true, createdAt: true,
      },
    });
    return row;
  });

  // ── PATCH /me/scheduled-messages/:id ──────────────────────────────────────
  // Edit a pending scheduled message. Refuses if already sent/sending/canceled.
  app.patch<{ Params: { id: string } }>(
    '/me/scheduled-messages/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });
      const body = request.body as UpdateBody;

      const existing = await prisma.scheduledMessage.findFirst({
        where: { id, userId: user.sub },
        select: { id: true, status: true },
      });
      if (!existing) return reply.code(404).send({ error: 'Not found' });
      if (existing.status !== 'pending') {
        return reply.code(409).send({
          error: `Cannot edit a scheduled message in status='${existing.status}'. Only pending messages can be edited.`,
        });
      }

      const data: Record<string, unknown> = {};
      if (typeof body.body === 'string') data.body = body.body;
      if (Array.isArray(body.mediaUrls)) data.mediaUrls = body.mediaUrls;
      if (typeof body.scheduledFor === 'string') {
        const when = new Date(body.scheduledFor);
        if (Number.isNaN(when.getTime())) {
          return reply.code(400).send({ error: 'scheduledFor is not a valid date' });
        }
        if (when.getTime() < Date.now() - 5_000) {
          return reply.code(400).send({ error: 'scheduledFor is in the past' });
        }
        data.scheduledFor = when;
      }
      if (Object.keys(data).length === 0) {
        return reply.code(400).send({ error: 'no editable fields supplied' });
      }

      const updated = await prisma.scheduledMessage.update({
        where: { id },
        data,
        select: {
          id: true, toNumber: true, body: true, mediaUrls: true,
          scheduledFor: true, userDidId: true, status: true, updatedAt: true,
        },
      });
      return updated;
    },
  );

  // ── DELETE /me/scheduled-messages/:id ─────────────────────────────────────
  // Soft cancel — flip status to 'canceled'. Refuses if already sent.
  app.delete<{ Params: { id: string } }>(
    '/me/scheduled-messages/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });

      const existing = await prisma.scheduledMessage.findFirst({
        where: { id, userId: user.sub },
        select: { id: true, status: true },
      });
      if (!existing) return reply.code(404).send({ error: 'Not found' });
      if (existing.status === 'sent') {
        return reply.code(409).send({ error: 'Already sent — cannot cancel.' });
      }
      if (existing.status === 'canceled') {
        return { ok: true, alreadyCanceled: true };
      }

      // We don't delete the row so audit-trace stays intact. Just flip status.
      await prisma.scheduledMessage.update({
        where: { id },
        data: { status: 'canceled' },
      });
      return { ok: true };
    },
  );
}
