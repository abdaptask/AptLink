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
//
// Safeguards (Phase 6.13 spec):
//   - Can't demote the LAST remaining active admin.
//   - Can't deactivate yourself (would brick the panel for you).
//   - Self-promote / self-demote of THIS user's own admin flag is blocked
//     to keep the audit trail clean; ask another admin to do it.
//
// We do NOT provision Telnyx (DID purchase + SIP credential creation) here.
// That's deferred to Phase 6b (#167) once we've nailed the Telnyx API.
// Admin can paste existing creds (sipUsername / sipPassword / didNumber)
// manually when inviting, which is enough to migrate the existing 150
// already-provisioned users.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '@ace/db';
import bcrypt from 'bcryptjs';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

// Inline guard. Runs after authenticate so request.user is populated.
async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const u = request.user as JwtPayload | undefined;
  if (!u?.isAdmin) {
    return reply.code(403).send({ error: 'Admin access required' });
  }
}

// Shape returned to the frontend table. Sensitive fields (sipPassword,
// passwordHash) are NEVER serialized — admins can RESET them but not read.
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

// Audit helper. Best-effort — we never want an audit-log write to fail
// the admin action itself, so we log + swallow.
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
        metadata: metadata as object | null,
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
  // Manual provisioning fallback — admin can paste already-existing Telnyx
  // creds. Optional because the standard flow is "invite by email only,
  // user signs in with Microsoft and binds via azureOid".
  sipUsername: z.string().max(120).nullable().optional(),
  sipPassword: z.string().max(200).nullable().optional(),
  didNumber: z.string().max(20).nullable().optional(),
  isAdmin: z.boolean().optional(),
  // If a local password is supplied, the user becomes a break-glass account
  // that can sign in WITHOUT Microsoft SSO. Optional.
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
  // Optional password reset (break-glass accounts). Pass null/empty to
  // clear (force SSO).
  localPassword: z.string().min(8).max(200).nullable().optional(),
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
      // Don't include sipPassword in the audit metadata (sensitive).
      if (parsed.data.sipPassword !== undefined) {
        data.sipPassword = parsed.data.sipPassword;
        auditMeta.sipPassword = { changed: true };
      }
      set('didNumber', target.didNumber, parsed.data.didNumber ?? undefined);

      // ----- isActive: can't deactivate self ------------------------------
      if (parsed.data.isActive !== undefined && parsed.data.isActive !== target.isActive) {
        if (id === actor.sub && parsed.data.isActive === false) {
          return reply
            .code(400)
            .send({ error: "You can't deactivate your own account." });
        }
        data.isActive = parsed.data.isActive;
        auditMeta.isActive = { from: target.isActive, to: parsed.data.isActive };
      }

      // ----- isAdmin: last-admin safeguard + no self-toggle ---------------
      if (parsed.data.isAdmin !== undefined && parsed.data.isAdmin !== target.isAdmin) {
        if (id === actor.sub) {
          return reply.code(400).send({
            error: "You can't change your own admin status. Ask another admin to do it.",
          });
        }
        if (parsed.data.isAdmin === false) {
          // Demoting an admin: make sure at least one other ACTIVE admin remains.
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

      // ----- localPassword: reset/set/clear ------------------------------
      if (parsed.data.localPassword !== undefined) {
        const newHash = parsed.data.localPassword
          ? await bcrypt.hash(parsed.data.localPassword, 10)
          : null;
        data.passwordHash = newHash;
        // If we just set a local password, flip provider to "local" so the
        // user can sign in via the break-glass form. Clearing a password
        // doesn't auto-flip back to microsoft.
        if (newHash) data.provider = 'local';
        auditMeta.passwordHash = newHash ? { reset: true } : { cleared: true };
      }

      if (Object.keys(data).length === 0) {
        // No-op patch. Return the unchanged user without writing an audit.
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

      // Choose the most specific action verb based on what changed. We
      // prefer named verbs ("user.promoted") over a generic "user.updated"
      // so the audit-log viewer can render an icon + summary easily.
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
}
