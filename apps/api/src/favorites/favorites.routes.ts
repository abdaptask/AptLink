// Phase 6.11 — Favorites sync.
//
// Per-user list of starred contacts. Replaces the localStorage-only favorites
// store that lived in apps/web/src/lib/userPrefs.ts. Now persisted server-side
// so the same favorites appear in the browser, the Electron app, and across
// the user's machines.
//
// v0.10.66 — Multi-number favorites.
//
// Every Favorite now has one or more FavoriteNumber children, each carrying
// its own E.164 phone + label (Cell/Home/Work/Other) + sort order. The
// Favorite.phone column is still maintained as the "primary" mirror for
// back-compat with older clients that haven't picked up the multi-number UI.
//
// API surface:
//   GET    /favorites                          List favorites (numbers included)
//   POST   /favorites                          Add favorite (creates primary number)
//   PATCH  /favorites/:id                      Rename
//   DELETE /favorites/:id                      Remove (cascades to numbers)
//   GET    /favorites/:id/numbers              List a favorite's numbers
//   POST   /favorites/:id/numbers              Add another number to a favorite
//   PATCH  /favorites/:id/numbers/:numberId    Edit label/phone/primary
//   DELETE /favorites/:id/numbers/:numberId    Remove a number (refuses last)

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@ace/db';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

function toE164(raw: string): string {
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  return `+${cleaned}`;
}

const AddSchema = z.object({
  phone: z.string().min(7).max(20),
  firstName: z.string().max(80).nullable().optional(),
  lastName: z.string().max(80).nullable().optional(),
  label: z.string().max(160).nullable().optional(),
  // v0.10.66 — Optional label for the PRIMARY number. Defaults to "Mobile"
  // matching the backfill convention. Use 'Cell', 'Home', 'Work', 'Other'
  // for the quick-pick UI vibe; arbitrary strings are accepted.
  numberLabel: z.string().max(24).optional(),
});

const PatchSchema = z.object({
  firstName: z.string().max(80).nullable().optional(),
  lastName: z.string().max(80).nullable().optional(),
  label: z.string().max(160).nullable().optional(),
});

const AddNumberSchema = z.object({
  phone: z.string().min(7).max(20),
  label: z.string().max(24).default('Other'),
  isPrimary: z.boolean().optional(),
});

const PatchNumberSchema = z.object({
  phone: z.string().min(7).max(20).optional(),
  label: z.string().max(24).optional(),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

/**
 * v0.10.66 — Ensure a Favorite has at least one FavoriteNumber row.
 *
 * Called when we read a favorite that came in pre-multi-number. Mirrors the
 * legacy `Favorite.phone` into a FavoriteNumber with label="Mobile" and
 * isPrimary=true. Idempotent — the unique (favoriteId, phone) constraint
 * means a second call is a no-op. Cheap (one INSERT … ON CONFLICT DO NOTHING
 * per orphaned favorite, only runs the first time).
 */
async function ensureFavoriteHasNumber(fav: {
  id: number;
  phone: string;
  numbers: Array<{ id: number }>;
}): Promise<void> {
  if (fav.numbers.length > 0) return;
  try {
    await prisma.favoriteNumber.create({
      data: {
        favoriteId: fav.id,
        phone: fav.phone,
        label: 'Mobile',
        sortOrder: 0,
        isPrimary: true,
      },
    });
  } catch {
    // Race: another request created it in parallel. The @unique constraint
    // makes that a benign violation we can ignore.
  }
}

export async function favoritesRoutes(app: FastifyInstance) {
  // ── GET /favorites ──────────────────────────────────────────────────────
  app.get(
    '/favorites',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const u = request.user as JwtPayload;
      const rows = await prisma.favorite.findMany({
        where: { userId: u.sub },
        orderBy: { addedAt: 'desc' },
        select: {
          id: true,
          phone: true,
          firstName: true,
          lastName: true,
          label: true,
          addedAt: true,
          numbers: {
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              phone: true,
              label: true,
              sortOrder: true,
              isPrimary: true,
            },
          },
        },
      });
      // v0.10.66 — Backfill any pre-multi-number favorites we encounter.
      // First read after the schema migration may still see Favorites with
      // no FavoriteNumber children; lazy-create the legacy "Mobile" mirror
      // so the UI always sees a populated list.
      await Promise.all(rows.map(ensureFavoriteHasNumber));
      // Re-read numbers for any we just backfilled. Cheap because most
      // favorites already have numbers; only touched rows refetch.
      const needsRefetch = rows.some((r) => r.numbers.length === 0);
      if (needsRefetch) {
        const fresh = await prisma.favorite.findMany({
          where: { userId: u.sub },
          orderBy: { addedAt: 'desc' },
          select: {
            id: true,
            phone: true,
            firstName: true,
            lastName: true,
            label: true,
            addedAt: true,
            numbers: {
              orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                phone: true,
                label: true,
                sortOrder: true,
                isPrimary: true,
              },
            },
          },
        });
        return { items: fresh };
      }
      return { items: rows };
    },
  );

  // ── POST /favorites ─────────────────────────────────────────────────────
  app.post(
    '/favorites',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      const u = request.user as JwtPayload;
      const parsed = AddSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const e164 = toE164(parsed.data.phone);
      const joined = [parsed.data.firstName, parsed.data.lastName]
        .map((p) => (p ?? '').trim())
        .filter(Boolean)
        .join(' ');
      const label = parsed.data.label ?? (joined || null);
      const numberLabel = parsed.data.numberLabel ?? 'Mobile';

      // Upsert the Favorite row.
      const fav = await prisma.favorite.upsert({
        where: { userId_phone: { userId: u.sub, phone: e164 } },
        update: {
          firstName: parsed.data.firstName ?? undefined,
          lastName: parsed.data.lastName ?? undefined,
          label: label ?? undefined,
        },
        create: {
          userId: u.sub,
          phone: e164,
          firstName: parsed.data.firstName ?? null,
          lastName: parsed.data.lastName ?? null,
          label,
        },
        select: { id: true },
      });

      // Upsert the corresponding primary FavoriteNumber. ON CONFLICT we just
      // leave the existing row in place (don't downgrade isPrimary).
      try {
        await prisma.favoriteNumber.upsert({
          where: { favoriteId_phone: { favoriteId: fav.id, phone: e164 } },
          update: {},
          create: {
            favoriteId: fav.id,
            phone: e164,
            label: numberLabel,
            sortOrder: 0,
            isPrimary: true,
          },
        });
      } catch (e) {
        request.log.warn({ err: e, favId: fav.id }, '[favorites] number upsert failed');
      }

      // Return the full Favorite with its numbers (consistent with GET).
      const full = await prisma.favorite.findUnique({
        where: { id: fav.id },
        select: {
          id: true,
          phone: true,
          firstName: true,
          lastName: true,
          label: true,
          addedAt: true,
          numbers: {
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
            select: { id: true, phone: true, label: true, sortOrder: true, isPrimary: true },
          },
        },
      });
      return full;
    },
  );

  // ── PATCH /favorites/:id ────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/favorites/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const parsed = PatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const existing = await prisma.favorite.findFirst({
        where: { id, userId: u.sub },
        select: { id: true },
      });
      if (!existing) return reply.code(404).send({ error: 'Not found' });
      const joined = [parsed.data.firstName, parsed.data.lastName]
        .map((p) => (p ?? '').trim())
        .filter(Boolean)
        .join(' ');
      const label =
        parsed.data.label !== undefined
          ? parsed.data.label
          : joined || null;
      const row = await prisma.favorite.update({
        where: { id },
        data: {
          firstName: parsed.data.firstName ?? undefined,
          lastName: parsed.data.lastName ?? undefined,
          label,
        },
        select: {
          id: true,
          phone: true,
          firstName: true,
          lastName: true,
          label: true,
          addedAt: true,
          numbers: {
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
            select: { id: true, phone: true, label: true, sortOrder: true, isPrimary: true },
          },
        },
      });
      return row;
    },
  );

  // ── DELETE /favorites/:id ───────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/favorites/:id',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      // Cascade-deletes FavoriteNumber children automatically (schema rule).
      const result = await prisma.favorite.deleteMany({
        where: { id, userId: u.sub },
      });
      if (result.count === 0) return reply.code(404).send({ error: 'Not found' });
      return { ok: true };
    },
  );

  // ── POST /favorites/:id/numbers ─────────────────────────────────────────
  // Add another number (Cell/Home/Work/Other) to an existing favorite.
  app.post<{ Params: { id: string } }>(
    '/favorites/:id/numbers',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const favId = Number(request.params.id);
      if (!Number.isFinite(favId)) return reply.code(400).send({ error: 'Invalid id' });
      const parsed = AddNumberSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      // Ownership check.
      const fav = await prisma.favorite.findFirst({
        where: { id: favId, userId: u.sub },
        select: { id: true },
      });
      if (!fav) return reply.code(404).send({ error: 'Favorite not found' });

      const e164 = toE164(parsed.data.phone);

      // If isPrimary=true, demote any existing primaries on this favorite.
      if (parsed.data.isPrimary) {
        await prisma.favoriteNumber.updateMany({
          where: { favoriteId: favId, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      // Pick a sortOrder one larger than the highest existing.
      const last = await prisma.favoriteNumber.findFirst({
        where: { favoriteId: favId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      const nextSort = (last?.sortOrder ?? 0) + 10;

      try {
        const row = await prisma.favoriteNumber.create({
          data: {
            favoriteId: favId,
            phone: e164,
            label: parsed.data.label,
            sortOrder: nextSort,
            isPrimary: parsed.data.isPrimary ?? false,
          },
          select: { id: true, phone: true, label: true, sortOrder: true, isPrimary: true },
        });
        return row;
      } catch (e) {
        // Likely duplicate phone on the same favorite.
        return reply.code(409).send({
          error: 'duplicate_phone',
          message: `${e164} is already on this favorite.`,
          detail: e instanceof Error ? e.message : undefined,
        });
      }
    },
  );

  // ── PATCH /favorites/:id/numbers/:numberId ──────────────────────────────
  app.patch<{ Params: { id: string; numberId: string } }>(
    '/favorites/:id/numbers/:numberId',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const favId = Number(request.params.id);
      const numId = Number(request.params.numberId);
      if (!Number.isFinite(favId) || !Number.isFinite(numId)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const parsed = PatchNumberSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      // Verify ownership: the number's favorite must belong to this user.
      const num = await prisma.favoriteNumber.findFirst({
        where: { id: numId, favoriteId: favId, favorite: { userId: u.sub } },
        select: { id: true },
      });
      if (!num) return reply.code(404).send({ error: 'Number not found' });

      // If promoting to primary, demote the rest.
      if (parsed.data.isPrimary === true) {
        await prisma.favoriteNumber.updateMany({
          where: { favoriteId: favId, isPrimary: true, NOT: { id: numId } },
          data: { isPrimary: false },
        });
      }

      const data: Record<string, unknown> = {};
      if (parsed.data.phone !== undefined) data.phone = toE164(parsed.data.phone);
      if (parsed.data.label !== undefined) data.label = parsed.data.label;
      if (parsed.data.isPrimary !== undefined) data.isPrimary = parsed.data.isPrimary;
      if (parsed.data.sortOrder !== undefined) data.sortOrder = parsed.data.sortOrder;

      try {
        const row = await prisma.favoriteNumber.update({
          where: { id: numId },
          data,
          select: { id: true, phone: true, label: true, sortOrder: true, isPrimary: true },
        });
        return row;
      } catch (e) {
        return reply.code(409).send({
          error: 'update_failed',
          detail: e instanceof Error ? e.message : undefined,
        });
      }
    },
  );

  // ── DELETE /favorites/:id/numbers/:numberId ─────────────────────────────
  // Remove a number from a favorite. Refuses to remove the LAST one — if a
  // favorite has only one number, deleting it is equivalent to deleting the
  // whole favorite (which the user should do via DELETE /favorites/:id).
  app.delete<{ Params: { id: string; numberId: string } }>(
    '/favorites/:id/numbers/:numberId',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const favId = Number(request.params.id);
      const numId = Number(request.params.numberId);
      if (!Number.isFinite(favId) || !Number.isFinite(numId)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const num = await prisma.favoriteNumber.findFirst({
        where: { id: numId, favoriteId: favId, favorite: { userId: u.sub } },
        select: { id: true, isPrimary: true },
      });
      if (!num) return reply.code(404).send({ error: 'Number not found' });

      const total = await prisma.favoriteNumber.count({ where: { favoriteId: favId } });
      if (total <= 1) {
        return reply.code(409).send({
          error: 'last_number',
          message: 'Cannot remove the only number on a favorite. Delete the favorite instead.',
        });
      }

      await prisma.favoriteNumber.delete({ where: { id: numId } });

      // If we just removed the primary, promote another (lowest sortOrder).
      if (num.isPrimary) {
        const next = await prisma.favoriteNumber.findFirst({
          where: { favoriteId: favId },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          select: { id: true },
        });
        if (next) {
          await prisma.favoriteNumber.update({
            where: { id: next.id },
            data: { isPrimary: true },
          });
        }
      }

      return { ok: true };
    },
  );
}
