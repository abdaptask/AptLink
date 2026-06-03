// v0.10.76 — Admin-uploaded ringtones (tenant-wide library).
//
// Routes:
//   GET    /me/ringtones                List active ringtones (data URL + name).
//                                       Used by the per-user picker in
//                                       Settings → Personal → Ringtone AND
//                                       by services/ringtone.ts when an
//                                       incoming call needs to play the
//                                       user's chosen upload.
//   GET    /admin/ringtones             Admin: list ALL ringtones (incl. inactive)
//   POST   /admin/ringtones             Admin: upload a new ringtone
//   PATCH  /admin/ringtones/:id         Admin: rename / reorder / toggle active
//   DELETE /admin/ringtones/:id         Admin: hard-delete a ringtone
//
// Audio is stored as a base64 data URL (same pattern as v0.10.48 hold music).
// Expect ~50-200KB per ringtone; reject anything >500KB to keep DB rows
// reasonable. Frontend should resize/compress before upload if needed.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@ace/db';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

async function requireAdmin(
  request: FastifyRequest,
  reply: { code: (n: number) => { send: (body: unknown) => void } },
) {
  const user = request.user as JwtPayload;
  if (!user?.isAdmin) {
    return reply.code(403).send({ error: 'Admin required' });
  }
}

// Cap upload size at ~500KB encoded (base64 inflates by ~33%, so raw audio
// ~375KB). Plenty for a 5-10 second MP3 at typical bitrates.
const MAX_DATA_URL_BYTES = 500_000;

const CreateRingtoneSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /// Must start with "data:audio/" — we validate format on the server even
  /// though the client also enforces. Defensive in case someone hand-rolls
  /// the API call.
  dataUrl: z.string()
    .startsWith('data:audio/')
    .max(MAX_DATA_URL_BYTES),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const PatchRingtoneSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
});

export async function ringtonesRoutes(app: FastifyInstance) {
  // ── GET /me/ringtones ──────────────────────────────────────────────────
  // Every authenticated user can read the active ringtone list. Returns
  // the full data URLs so the picker can preview + the IncomingCall
  // component can play the user's selection without an extra round-trip.
  app.get('/me/ringtones', { onRequest: [app.authenticate] }, async () => {
    const rows = await prisma.ringtone.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        dataUrl: true,
        sortOrder: true,
      },
    });
    return { ringtones: rows };
  });

  // ── GET /admin/ringtones ───────────────────────────────────────────────
  // Admin gets the FULL list — includes inactive — for management UI.
  // Same shape as /me but with isActive + uploadedBy.
  app.get('/admin/ringtones', { onRequest: [app.authenticate, requireAdmin] }, async () => {
    const rows = await prisma.ringtone.findMany({
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        dataUrl: true,
        sortOrder: true,
        isActive: true,
        uploadedBy: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { ringtones: rows };
  });

  // ── POST /admin/ringtones ──────────────────────────────────────────────
  app.post('/admin/ringtones', { onRequest: [app.authenticate, requireAdmin] }, async (request, reply) => {
    const actor = request.user as JwtPayload;
    const parsed = CreateRingtoneSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    // Pick a sortOrder one larger than the highest existing.
    const last = await prisma.ringtone.findFirst({
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const nextSort = parsed.data.sortOrder ?? (last?.sortOrder ?? 0) + 10;

    const created = await prisma.ringtone.create({
      data: {
        name: parsed.data.name,
        dataUrl: parsed.data.dataUrl,
        sortOrder: nextSort,
        uploadedBy: actor.sub,
      },
      select: {
        id: true,
        name: true,
        sortOrder: true,
        isActive: true,
        createdAt: true,
      },
    });
    return created;
  });

  // ── PATCH /admin/ringtones/:id ─────────────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/admin/ringtones/:id',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });
      const parsed = PatchRingtoneSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const data: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) data.name = parsed.data.name;
      if (parsed.data.sortOrder !== undefined) data.sortOrder = parsed.data.sortOrder;
      if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
      if (Object.keys(data).length === 0) {
        return reply.code(400).send({ error: 'No fields to update' });
      }
      try {
        const updated = await prisma.ringtone.update({
          where: { id },
          data,
          select: { id: true, name: true, sortOrder: true, isActive: true, updatedAt: true },
        });
        return updated;
      } catch (e) {
        return reply.code(404).send({ error: 'Ringtone not found', detail: e instanceof Error ? e.message : undefined });
      }
    },
  );

  // ── DELETE /admin/ringtones/:id ────────────────────────────────────────
  // Hard delete — removes the row entirely. Existing User.ringtone
  // references to upload:<id> will fall back to the default preset on
  // next play. Admin should typically prefer isActive=false for soft delete
  // to preserve history, but hard delete is available for cleanup of test
  // uploads or copyright takedowns.
  app.delete<{ Params: { id: string } }>(
    '/admin/ringtones/:id',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });
      try {
        await prisma.ringtone.delete({ where: { id } });
        return { ok: true };
      } catch (e) {
        return reply.code(404).send({ error: 'Ringtone not found', detail: e instanceof Error ? e.message : undefined });
      }
    },
  );
}
