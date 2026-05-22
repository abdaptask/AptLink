// Phase 6.13 — Admin Users panel.
//
// Endpoints for the in-app Users management UI. All routes require an
// authenticated user with isAdmin=true. Every mutation writes an AuditLog
// entry so a separate admin can review what happened and when.
//
// API surface:
//   GET    /admin/users              List all users (sorted by createdAt desc)
//   POST   /admin/users              Invite a new user (creates DB row, awaits first SSO)
//   PATCH  /admin/users/:id          Promote / demote / activate / deactivate / edit
//   GET    /admin/audit-logs         Recent admin actions (paginated, default 100)
//   POST   /admin/users/bulk-import  Phase 5 — CSV bulk-import (#189)
//
// Safeguards (Phase 6.13 spec):
//   - Can't demote the LAST remaining active admin.
//   - Can't deactivate yourself (would brick the panel for you).
//   - Can't change your own admin flag — ask another admin.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '@ace/db';
import bcrypt from 'bcryptjs';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const u = request.user as JwtPayload | undefined;
  if (!u?.isAdmin) {
    return reply.code(403).send({ error: 'Admin access required' });
  }
}

function publicUser(u: {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
  isActive: boolean;
  provider: string;
  sipUsername: string | null;
  didNumber: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    isAdmin: u.isAdmin,
    isActive: u.isActive,
    provider: u.provider,
    sipUsername: u.sipUsername,
    didNumber: u.didNumber,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

// Audit helper — best-effort. We never want an audit-log write to fail the
// admin action itself, so log + swallow.
async function recordAudit(
  actorUserId: number,
  action: string,
  targetUserId: number | null,
  metadata: Record<string, unknown> | null,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        targetUserId,
        // Prisma's JSON column accepts undefined (NULL) or a value, NOT a
        // bare null literal — that requires Prisma.JsonNull. Coerce.
        metadata: (metadata ?? undefined) as object | undefined,
      },
    });
  } catch (err) {
    console.warn('[audit] failed to write audit entry', { action, err });
  }
}

const InviteSchema = z.object({
  email: z.string().email(),
  firstName: z.string().max(80).nullable().optional(),
  lastName: z.string().max(80).nullable().optional(),
  sipUsername: z.string().max(120).nullable().optional(),
  sipPassword: z.string().max(200).nullable().optional(),
  didNumber: z.string().max(20).nullable().optional(),
  isAdmin: z.boolean().optional(),
  localPassword: z.string().min(8).max(200).nullable().optional(),
});

const UpdateSchema = z.object({
  firstName: z.string().max(80).nullable().optional(),
  lastName: z.string().max(80).nullable().optional(),
  sipUsername: z.string().max(120).nullable().optional(),
  sipPassword: z.string().max(200).nullable().optional(),
  didNumber: z.string().max(20).nullable().optional(),
  isAdmin: z.boolean().optional(),
  isActive: z.boolean().optional(),
  localPassword: z.string().min(8).max(200).nullable().optional(),
});

// Phase 5 (#189) — bulk import schema. Each row mirrors the CSV column set.
// Rows without sipPassword are accepted; user gets created but can't register
// against Telnyx until an admin fills the password in later (staged rollout).
const BulkRowSchema = z.object({
  email: z.string().email(),
  firstName: z.string().max(80).optional().nullable(),
  lastName: z.string().max(80).optional().nullable(),
  sipUsername: z.string().max(120).optional().nullable(),
  sipPassword: z.string().max(200).optional().nullable(),
  didNumber: z.string().max(20).optional().nullable(),
  isAdmin: z.boolean().optional().nullable(),
  phoneExtension: z.string().max(20).optional().nullable(),
});
const BulkImportSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  rows: z.array(BulkRowSchema).min(1).max(500),
});

export async function adminRoutes(app: FastifyInstance) {
  // ───────────────────────── GET /admin/users ─────────────────────────
  app.get(
    '/admin/users',
    { onRequest: [app.authenticate, requireAdmin] },
    async () => {
      const rows = await prisma.user.findMany({
        orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          isAdmin: true,
          isActive: true,
          provider: true,
          sipUsername: true,
          didNumber: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });
      return { items: rows.map(publicUser) };
    },
  );

  // ───────────────────────── POST /admin/users ────────────────────────
  app.post(
    '/admin/users',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const parsed = InviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { email, firstName, lastName, sipUsername, sipPassword, didNumber, isAdmin, localPassword } = parsed.data;
      const normEmail = email.trim().toLowerCase();

      const existing = await prisma.user.findUnique({ where: { email: normEmail }, select: { id: true } });
      if (existing) {
        return reply.code(409).send({ error: 'A user with this email already exists.' });
      }

      const passwordHash = localPassword ? await bcrypt.hash(localPassword, 10) : null;
      const created = await prisma.user.create({
        data: {
          email: normEmail,
          firstName: firstName ?? null,
          lastName: lastName ?? null,
          sipUsername: sipUsername ?? null,
          sipPassword: sipPassword ?? null,
          didNumber: didNumber ?? null,
          isAdmin: !!isAdmin,
          isActive: true,
          provider: localPassword ? 'local' : 'microsoft',
          passwordHash,
        },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          isAdmin: true, isActive: true, provider: true,
          sipUsername: true, didNumber: true, lastLoginAt: true, createdAt: true,
        },
      });

      await recordAudit(u.sub, 'user.invited', created.id, {
        email: normEmail,
        invitedAs: created.isAdmin ? 'admin' : 'user',
        provider: created.provider,
        hasLocalPassword: !!localPassword,
        hasSipCreds: !!(sipUsername && sipPassword),
        didNumber: didNumber ?? null,
      });

      return publicUser(created);
    },
  );

  // ───────────────────────── PATCH /admin/users/:id ───────────────────
  app.patch<{ Params: { id: string } }>(
    '/admin/users/:id',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });
      const parsed = UpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const target = await prisma.user.findUnique({ where: { id } });
      if (!target) return reply.code(404).send({ error: 'User not found' });

      const data: Record<string, unknown> = {};
      const auditMeta: Record<string, unknown> = {};

      const set = (field: string, prev: unknown, next: unknown) => {
        if (next === undefined) return;
        if (prev === next) return;
        data[field] = next;
        auditMeta[field] = { from: prev, to: next };
      };

      set('firstName', target.firstName, parsed.data.firstName ?? undefined);
      set('lastName', target.lastName, parsed.data.lastName ?? undefined);
      set('sipUsername', target.sipUsername, parsed.data.sipUsername ?? undefined);
      if (parsed.data.sipPassword !== undefined) {
        data.sipPassword = parsed.data.sipPassword;
        auditMeta.sipPassword = { changed: true };
      }
      set('didNumber', target.didNumber, parsed.data.didNumber ?? undefined);

      if (parsed.data.isActive !== undefined && parsed.data.isActive !== target.isActive) {
        if (id === actor.sub && parsed.data.isActive === false) {
          return reply
            .code(400)
            .send({ error: "You can't deactivate your own account." });
        }
        data.isActive = parsed.data.isActive;
        auditMeta.isActive = { from: target.isActive, to: parsed.data.isActive };
      }

      if (parsed.data.isAdmin !== undefined && parsed.data.isAdmin !== target.isAdmin) {
        if (id === actor.sub) {
          return reply.code(400).send({
            error: "You can't change your own admin status. Ask another admin to do it.",
          });
        }
        if (parsed.data.isAdmin === false) {
          const remaining = await prisma.user.count({
            where: { isAdmin: true, isActive: true, id: { not: id } },
          });
          if (remaining < 1) {
            return reply.code(400).send({
              error:
                "Can't demote the last admin. Promote someone else first or this account would be the only admin gone.",
            });
          }
        }
        data.isAdmin = parsed.data.isAdmin;
        auditMeta.isAdmin = { from: target.isAdmin, to: parsed.data.isAdmin };
      }

      if (parsed.data.localPassword !== undefined) {
        const newHash = parsed.data.localPassword
          ? await bcrypt.hash(parsed.data.localPassword, 10)
          : null;
        data.passwordHash = newHash;
        if (newHash) data.provider = 'local';
        auditMeta.passwordHash = newHash ? { reset: true } : { cleared: true };
      }

      if (Object.keys(data).length === 0) {
        return publicUser(target);
      }

      const updated = await prisma.user.update({
        where: { id },
        data,
        select: {
          id: true, email: true, firstName: true, lastName: true,
          isAdmin: true, isActive: true, provider: true,
          sipUsername: true, didNumber: true, lastLoginAt: true, createdAt: true,
        },
      });

      let action = 'user.updated';
      if (auditMeta.isAdmin) {
        action = (auditMeta.isAdmin as { to: boolean }).to ? 'user.promoted' : 'user.demoted';
      } else if (auditMeta.isActive) {
        action = (auditMeta.isActive as { to: boolean }).to ? 'user.activated' : 'user.deactivated';
      } else if (auditMeta.passwordHash) {
        action = 'user.password_reset';
      }
      await recordAudit(actor.sub, action, id, { email: target.email, changes: auditMeta });

      return publicUser(updated);
    },
  );

  // ───────────────────────── GET /admin/audit-logs ────────────────────
  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/admin/audit-logs',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request) => {
      const rawLimit = Number(request.query.limit ?? 100);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 500);
      const cursor = Number(request.query.cursor);
      const rows = await prisma.auditLog.findMany({
        take: limit + 1,
        orderBy: { id: 'desc' },
        ...(Number.isFinite(cursor) ? { skip: 1, cursor: { id: cursor } } : {}),
        include: {
          actor: { select: { id: true, email: true, firstName: true, lastName: true } },
          target: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, -1) : rows).map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actor
          ? {
              id: r.actor.id,
              email: r.actor.email,
              firstName: r.actor.firstName,
              lastName: r.actor.lastName,
            }
          : null,
        target: r.target
          ? {
              id: r.target.id,
              email: r.target.email,
              firstName: r.target.firstName,
              lastName: r.target.lastName,
            }
          : null,
        metadata: r.metadata,
        createdAt: r.createdAt.toISOString(),
      }));
      const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;
      return { items, nextCursor };
    },
  );

  // ───────────────────── POST /admin/users/bulk-import (#189) ─────────
  // Per-row upsert by email. dryRun=true validates + returns the preview
  // without writing. Returns per-row { status, error?, missingPassword }
  // so the frontend can show a result table.
  app.post(
    '/admin/users/bulk-import',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.user as JwtPayload;
      const parsed = BulkImportSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { dryRun, rows } = parsed.data;

      const inputEmails = rows.map((r) => r.email.trim().toLowerCase());
      const existing = await prisma.user.findMany({
        where: { email: { in: inputEmails } },
        select: { id: true, email: true },
      });
      const existingByEmail = new Map(existing.map((u) => [u.email, u.id]));

      type ItemResult = {
        row: number;
        email: string;
        status: 'created' | 'updated' | 'error' | 'skipped';
        missingPassword: boolean;
        error?: string;
        userId?: number;
      };
      const results: ItemResult[] = [];
      const seenEmails = new Set<string>();

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const rowNum = i + 1;
        const email = row.email.trim().toLowerCase();

        if (seenEmails.has(email)) {
          results.push({
            row: rowNum,
            email,
            status: 'error',
            missingPassword: false,
            error: 'Duplicate email in CSV',
          });
          continue;
        }
        seenEmails.add(email);

        const hasPassword = !!(row.sipPassword && row.sipPassword.trim());
        const existingId = existingByEmail.get(email);

        try {
          if (dryRun) {
            results.push({
              row: rowNum,
              email,
              status: existingId ? 'updated' : 'created',
              missingPassword: !hasPassword,
              userId: existingId,
            });
            continue;
          }

          if (existingId) {
            const data: Record<string, unknown> = {};
            if (row.firstName !== undefined && row.firstName !== null) data.firstName = row.firstName;
            if (row.lastName !== undefined && row.lastName !== null) data.lastName = row.lastName;
            if (row.sipUsername !== undefined && row.sipUsername !== null && row.sipUsername.trim()) data.sipUsername = row.sipUsername.trim();
            if (hasPassword) data.sipPassword = (row.sipPassword as string).trim();
            if (row.didNumber !== undefined && row.didNumber !== null && row.didNumber.trim()) data.didNumber = row.didNumber.trim();
            if (row.isAdmin === true || row.isAdmin === false) data.isAdmin = row.isAdmin;
            if (row.phoneExtension !== undefined && row.phoneExtension !== null) data.phoneExtension = row.phoneExtension;

            const updated = await prisma.user.update({
              where: { id: existingId },
              data,
              select: { id: true },
            });
            results.push({
              row: rowNum,
              email,
              status: 'updated',
              missingPassword: !hasPassword,
              userId: updated.id,
            });
          } else {
            const created = await prisma.user.create({
              data: {
                email,
                firstName: row.firstName ?? null,
                lastName: row.lastName ?? null,
                sipUsername: row.sipUsername?.trim() || null,
                sipPassword: hasPassword ? (row.sipPassword as string).trim() : null,
                didNumber: row.didNumber?.trim() || null,
                phoneExtension: row.phoneExtension ?? null,
                isAdmin: row.isAdmin === true,
                isActive: true,
                provider: 'microsoft',
                passwordHash: null,
              },
              select: { id: true },
            });
            results.push({
              row: rowNum,
              email,
              status: 'created',
              missingPassword: !hasPassword,
              userId: created.id,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({
            row: rowNum,
            email,
            status: 'error',
            missingPassword: !hasPassword,
            error: msg.includes('Unique constraint')
              ? 'sipUsername or didNumber is already assigned to another user'
              : msg.slice(0, 240),
          });
        }
      }

      const summary = {
        total: rows.length,
        created: results.filter((r) => r.status === 'created').length,
        updated: results.filter((r) => r.status === 'updated').length,
        errors: results.filter((r) => r.status === 'error').length,
        missingPasswords: results.filter((r) => r.missingPassword && r.status !== 'error').length,
        dryRun,
      };

      if (!dryRun) {
        await recordAudit(actor.sub, 'users.bulk_imported', null, {
          total: summary.total,
          created: summary.created,
          updated: summary.updated,
          errors: summary.errors,
          missingPasswords: summary.missingPasswords,
        });
      }

      return { summary, items: results };
    },
  );

  // ───────────────────── GET /admin/reports/live (Phase 8 — #204) ─────
  // P0 reporting slice — at-a-glance numbers for an admin dashboard.
  // Designed to be cheap: 6 separate queries that all hit indexed columns
  // and return small aggregates, no per-call full scans.
  // Refresh budget on the client: 15s. Each call is < 100ms in practice.
  app.get(
    '/admin/reports/live',
    { onRequest: [app.authenticate, requireAdmin] },
    async () => {
      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setUTCHours(0, 0, 0, 0);
      const startOfYesterday = new Date(startOfDay);
      startOfYesterday.setUTCDate(startOfDay.getUTCDate() - 1);
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

      // 1. Active calls right now: started but not ended yet, with a 4h
      //    sanity-cap so a stuck/dropped call doesn't show as active forever.
      const activeCallsNow = await prisma.call.count({
        where: {
          endedAt: null,
          startedAt: { gte: fourHoursAgo },
          status: { in: ['ringing', 'answered', 'initiated', 'connected'] },
        },
      });

      // 2. Today's calls — grouped by direction + status for an in/out/missed split.
      const todaysCallsRaw = await prisma.call.groupBy({
        by: ['direction', 'status'],
        where: { startedAt: { gte: startOfDay } },
        _count: { _all: true },
      });
      let inbound = 0, outbound = 0, missed = 0;
      for (const r of todaysCallsRaw) {
        const c = r._count._all;
        if (r.direction === 'inbound') {
          if (['missed', 'no_answer', 'rejected'].includes(r.status)) missed += c;
          else inbound += c;
        } else if (r.direction === 'outbound') {
          outbound += c;
        }
      }
      const todaysCallsTotal = inbound + outbound + missed;

      // 3. Yesterday's count for delta arrow.
      const yesterdayTotal = await prisma.call.count({
        where: {
          startedAt: { gte: startOfYesterday, lt: startOfDay },
        },
      });

      // 4. Today's SMS (inbound + outbound).
      const todaysSmsRaw = await prisma.message.groupBy({
        by: ['direction'],
        where: { createdAt: { gte: startOfDay } },
        _count: { _all: true },
      });
      const todaysSms = {
        sent: todaysSmsRaw.find((r) => r.direction === 'outbound')?._count._all ?? 0,
        received: todaysSmsRaw.find((r) => r.direction === 'inbound')?._count._all ?? 0,
      };

      // 5. Active users in the last 24h — anyone who's made a call OR sent/
      //    received a message. Best proxy for "online" without server-side
      //    SIP-presence tracking (which we'd need Telnyx Status webhooks for).
      const activeCallers = await prisma.call.findMany({
        where: { startedAt: { gte: last24h } },
        distinct: ['userId'],
        select: { userId: true },
      });
      const activeMessagers = await prisma.message.findMany({
        where: { createdAt: { gte: last24h } },
        distinct: ['userId'],
        select: { userId: true },
      });
      const activeUserIds = new Set<number>([
        ...activeCallers.map((c) => c.userId),
        ...activeMessagers.map((m) => m.userId),
      ]);

      // 6. Top callers today (top 5 by call count).
      const topCallersRaw = await prisma.call.groupBy({
        by: ['userId'],
        where: { startedAt: { gte: startOfDay } },
        _count: { _all: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 5,
      });
      const topCallerIds = topCallersRaw.map((r) => r.userId);
      const topCallerUsers =
        topCallerIds.length > 0
          ? await prisma.user.findMany({
              where: { id: { in: topCallerIds } },
              select: { id: true, email: true, firstName: true, lastName: true },
            })
          : [];
      const topCallerById = new Map(topCallerUsers.map((u) => [u.id, u]));
      const topCallers = topCallersRaw.map((r) => {
        const u = topCallerById.get(r.userId);
        return {
          userId: r.userId,
          email: u?.email ?? '(unknown)',
          name:
            [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() ||
            u?.email ?? '(unknown)',
          callCount: r._count._all,
        };
      });

      // 7. Recent missed calls (last 10, with the user who missed them).
      const missedRows = await prisma.call.findMany({
        where: {
          direction: 'inbound',
          status: { in: ['missed', 'no_answer'] },
          startedAt: { gte: last24h },
        },
        orderBy: { startedAt: 'desc' },
        take: 10,
        select: {
          id: true,
          fromNumber: true,
          startedAt: true,
          status: true,
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      });
      const recentMissed = missedRows.map((c) => ({
        id: c.id,
        fromNumber: c.fromNumber,
        startedAt: c.startedAt.toISOString(),
        status: c.status,
        userEmail: c.user.email,
        userName:
          [c.user.firstName, c.user.lastName].filter(Boolean).join(' ').trim() ||
          c.user.email,
      }));

      // 8. Hourly call buckets for today (24 buckets, indexed 0–23 UTC).
      const todaysCallsForChart = await prisma.call.findMany({
        where: { startedAt: { gte: startOfDay } },
        select: { startedAt: true, direction: true, status: true },
      });
      const hourly = Array.from({ length: 24 }, () => ({ inbound: 0, outbound: 0, missed: 0 }));
      for (const c of todaysCallsForChart) {
        const h = c.startedAt.getUTCHours();
        if (c.direction === 'inbound') {
          if (['missed', 'no_answer', 'rejected'].includes(c.status)) hourly[h].missed += 1;
          else hourly[h].inbound += 1;
        } else if (c.direction === 'outbound') {
          hourly[h].outbound += 1;
        }
      }

      // 9. Total user counts for context.
      const [totalUsers, activeUsers, adminUsers] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { isActive: true } }),
        prisma.user.count({ where: { isAdmin: true, isActive: true } }),
      ]);

      return {
        generatedAt: now.toISOString(),
        users: {
          total: totalUsers,
          active: activeUsers,
          admins: adminUsers,
          activeLast24h: activeUserIds.size,
        },
        calls: {
          activeNow: activeCallsNow,
          today: {
            total: todaysCallsTotal,
            inbound,
            outbound,
            missed,
          },
          yesterdayTotal,
          hourlyToday: hourly,
        },
        sms: {
          today: todaysSms,
        },
        topCallers,
        recentMissed,
      };
    },
  );
}
