// v0.10.74 — Admin Praise / Announcements.
//
// Routes:
//   GET    /me/praises             unread praises for the logged-in user
//   POST   /me/praises/:id/read    mark a praise as read (creates PraiseRead)
//   GET    /admin/praises          admin's send history (last 100)
//   POST   /admin/praises          admin creates a praise
//   DELETE /admin/praises/:id      admin removes a praise (cascade-deletes reads)
//
// The "unread for me" query is the tricky one — for targeted praise it's
// just toUserId=me; for broadcast (toUserId=null) we need to confirm there
// isn't already a PraiseRead row for me. Done with a NOT EXISTS subquery
// via Prisma's raw SQL since Prisma's relational filters don't naturally
// express "no row exists in the join table".
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@ace/db';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

// Valid category values. Mirrored on the frontend in PraiseModal's
// CATEGORY_META map and in Settings.tsx's BroadcastAdminSection grouping.
//
// v0.10.93 — Repurposed from a praise-only system into a general
// broadcast platform. The DB table and code paths still use the
// `Praise` model name for compatibility, but the UI is now branded
// "Broadcast" and supports five category groups (Celebrations,
// Announcements, Alerts, Reminders, Welcomes). When adding a new
// category, add it to all THREE locations:
//   1. This CATEGORY_VALUES list
//   2. apps/web/src/api.ts -- PraiseCategory type
//   3. apps/web/src/components/PraiseModal.tsx -- CATEGORY_META map
const CATEGORY_VALUES = [
  // Celebrations (legacy praise categories)
  'new_hire', 'new_offer', 'birthday', 'anniversary', 'custom',
  // v0.10.93 — Announcements
  'announcement', 'update_required', 'maintenance', 'holiday', 'policy_update',
  // v0.10.93 — Alerts
  'alert_urgent', 'service_outage',
  // v0.10.93 — Reminders
  'reminder', 'training',
  // v0.10.93 — Welcomes
  'welcome',
] as const;
type Category = typeof CATEGORY_VALUES[number];

const CreatePraiseSchema = z.object({
  category: z.enum(CATEGORY_VALUES),
  /// NULL or omitted = broadcast to all active users.
  toUserId: z.number().int().positive().nullable().optional(),
  recipientName: z.string().trim().min(0).max(120).optional(),
  message: z.string().trim().min(1).max(500),
  /// v0.10.89 — Optional admin-authored headline override. When empty/
  /// omitted, recipient modal falls back to the category default
  /// ("Welcome aboard {recipientName}", "Happy birthday", etc.).
  headline: z.string().trim().min(0).max(120).optional(),
});

// requireAdmin helper — same shape as elsewhere in admin.routes.ts.
async function requireAdmin(
  request: FastifyRequest,
  reply: { code: (n: number) => { send: (body: unknown) => void } },
) {
  const user = request.user as JwtPayload;
  if (!user?.isAdmin) {
    return reply.code(403).send({ error: 'Admin required' });
  }
}

export async function praisesRoutes(app: FastifyInstance) {
  // ── GET /me/praises ────────────────────────────────────────────────────
  // Returns all unread praises targeted at this user OR broadcast to all.
  // "Unread" = no PraiseRead row exists for (praise.id, me).
  app.get('/me/praises', { onRequest: [app.authenticate] }, async (request: FastifyRequest) => {
    const u = request.user as JwtPayload;
    const rows = await prisma.praise.findMany({
      where: {
        OR: [
          { toUserId: u.sub },
          { toUserId: null }, // broadcast
        ],
        // Exclude praises this user has already dismissed.
        reads: { none: { userId: u.sub } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        category: true,
        recipientName: true,
        headline: true,
        message: true,
        createdAt: true,
        toUserId: true,
        fromUser: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        toUser: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });
    return { praises: rows };
  });

  // ── POST /me/praises/:id/read ──────────────────────────────────────────
  // Mark a praise as read by this user. Idempotent (the @@unique on
  // PraiseRead makes a second call a benign upsert no-op).
  app.post<{ Params: { id: string } }>(
    '/me/praises/:id/read',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });

      // Sanity check the user is allowed to mark this praise (targeted at
      // them, or broadcast). Stops a random user from marking someone
      // else's targeted praise.
      const praise = await prisma.praise.findUnique({
        where: { id },
        select: { id: true, toUserId: true },
      });
      if (!praise) return reply.code(404).send({ error: 'Praise not found' });
      const isForMe = praise.toUserId === null || praise.toUserId === u.sub;
      if (!isForMe) return reply.code(403).send({ error: 'Not addressed to you' });

      // Upsert so concurrent reads don't error.
      try {
        await prisma.praiseRead.upsert({
          where: { praiseId_userId: { praiseId: id, userId: u.sub } },
          update: {},
          create: { praiseId: id, userId: u.sub },
        });
      } catch (e) {
        request.log.warn({ err: e, praiseId: id, userId: u.sub }, '[praise] read upsert failed');
      }
      return { ok: true };
    },
  );

  // ── GET /admin/praises ─────────────────────────────────────────────────
  // History of praises this admin sent. Last 100 most recent.
  app.get('/admin/praises', { onRequest: [app.authenticate, requireAdmin] }, async (request) => {
    const u = request.user as JwtPayload;
    const rows = await prisma.praise.findMany({
      where: { fromUserId: u.sub },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        category: true,
        recipientName: true,
        headline: true,
        message: true,
        createdAt: true,
        toUserId: true,
        toUser: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        _count: { select: { reads: true } },
      },
    });
    return { praises: rows };
  });

  // ── POST /admin/praises ────────────────────────────────────────────────
  // Admin creates a praise. toUserId optional — omit/null for broadcast.
  app.post('/admin/praises', { onRequest: [app.authenticate, requireAdmin] }, async (request, reply) => {
    const u = request.user as JwtPayload;
    const parsed = CreatePraiseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const { category, toUserId, recipientName, message } = parsed.data;

    // If toUserId set, verify the user exists + is active.
    if (toUserId !== null && toUserId !== undefined) {
      const target = await prisma.user.findUnique({
        where: { id: toUserId },
        select: { id: true, isActive: true, firstName: true, lastName: true },
      });
      if (!target) {
        return reply.code(404).send({ error: 'Recipient user not found' });
      }
      if (!target.isActive) {
        return reply.code(409).send({ error: 'Recipient is deactivated' });
      }
    }

    const created = await prisma.praise.create({
      data: {
        fromUserId: u.sub,
        toUserId: toUserId ?? null,
        category: category as Category,
        recipientName: (recipientName ?? '').trim() || null,
        // v0.10.89 — Optional admin-authored headline. Falls back to NULL
        // (= recipient modal uses category default) when blank/omitted.
        headline: (parsed.data.headline ?? '').trim() || null,
        message,
      },
      select: {
        id: true,
        category: true,
        recipientName: true,
        headline: true,
        message: true,
        createdAt: true,
        toUserId: true,
        fromUser: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        toUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
    return created;
  });

  // ── DELETE /admin/praises/:id ──────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/admin/praises/:id',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });

      // Only the admin who created it can delete (light scoping; you could
      // also allow any admin to delete any praise, but per-creator scoping
      // makes "I sent this by mistake" recovery feel safer).
      const praise = await prisma.praise.findFirst({
        where: { id, fromUserId: u.sub },
        select: { id: true },
      });
      if (!praise) return reply.code(404).send({ error: 'Praise not found' });

      // PraiseRead rows cascade-delete via the schema's onDelete: Cascade.
      await prisma.praise.delete({ where: { id } });
      return { ok: true };
    },
  );
}
