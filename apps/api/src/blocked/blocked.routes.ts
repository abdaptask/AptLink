// Phase 6.8 — Number blocking.
//
// Per-user blocklist of inbound phone numbers. When an inbound call or SMS
// arrives, the webhook handler checks the recipient user's blocklist; if
// the calling/sending number matches, the call is hung up and the SMS is
// silently dropped (not stored).
//
// API surface:
//   GET    /blocked-numbers              List current user's blocked entries
//   POST   /blocked-numbers              Add a number to block { number, reason? }
//   DELETE /blocked-numbers/:id          Remove a blocked entry by row id
//
// Numbers are stored E.164 normalized. Matching at webhook time is done
// on last-10 digits to be tolerant of carrier formatting differences
// (same convention as the rest of the dialer's phone matching).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@ace/db';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

// E.164 normalizer — matches the convention used elsewhere in the dialer.
// US/CA 10-digit becomes +1XXXXXXXXXX; 11-digit starting with 1 gets +;
// anything else gets a + prefix and is left to whatever the user typed.
function toE164(raw: string): string {
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  return `+${cleaned}`;
}

const AddSchema = z.object({
  number: z.string().min(7).max(20),
  reason: z.string().max(200).optional(),
});

export async function blockedRoutes(app: FastifyInstance) {
  // List blocked numbers for the logged-in user.
  app.get(
    '/blocked-numbers',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const u = request.user as JwtPayload;
      const rows = await prisma.blockedNumber.findMany({
        where: { userId: u.sub },
        orderBy: { createdAt: 'desc' },
        select: { id: true, number: true, reason: true, createdAt: true },
      });
      return { items: rows };
    },
  );

  // Add a number to the blocklist.
  app.post(
    '/blocked-numbers',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      const u = request.user as JwtPayload;
      const parsed = AddSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const e164 = toE164(parsed.data.number);
      // Upsert in case the user blocks the same number twice — the unique
      // (userId, number) constraint would otherwise throw P2002. Keep the
      // newest `reason` if provided.
      const row = await prisma.blockedNumber.upsert({
        where: { userId_number: { userId: u.sub, number: e164 } },
        update: { reason: parsed.data.reason ?? undefined },
        create: {
          userId: u.sub,
          number: e164,
          reason: parsed.data.reason ?? null,
        },
        select: { id: true, number: true, reason: true, createdAt: true },
      });
      return row;
    },
  );

  // Remove a blocked entry.
  app.delete(
    '/blocked-numbers/:id',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const u = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      // Guard: only delete a row that belongs to this user. If we just did
      // `delete where id=X` a user could delete someone else's block by
      // guessing the id. The `where userId+id` combo makes that impossible.
      const result = await prisma.blockedNumber.deleteMany({
        where: { id, userId: u.sub },
      });
      if (result.count === 0) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return { ok: true };
    },
  );
}

/**
 * Helper used by webhook handlers. Returns true if the given fromNumber
 * is on the user's blocklist. Comparison is on last-10 digits so that
 * "+15555551234" and "15555551234" both match a stored "+15555551234".
 *
 * Returns false on any DB error — fail open (allow the call/SMS through)
 * rather than fail closed (silently drop legit calls), which would be
 * harder for the user to debug.
 */
export async function isBlockedForUser(
  userId: number,
  fromNumber: string | null | undefined,
): Promise<boolean> {
  if (!fromNumber) return false;
  const last10 = fromNumber.replace(/[^\d]/g, '').slice(-10);
  if (!last10) return false;
  try {
    const rows = await prisma.blockedNumber.findMany({
      where: { userId },
      select: { number: true },
    });
    return rows.some((r) => r.number.replace(/[^\d]/g, '').slice(-10) === last10);
  } catch {
    return false;
  }
}
