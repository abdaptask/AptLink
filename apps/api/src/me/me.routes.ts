// v0.10.0 — User-self endpoints for multi-DID switching.
//
// Distinct from /auth/me (which returns the authenticated user's profile).
// These endpoints let a logged-in user enumerate the phone numbers they own
// and toggle which one is the active outbound identity for calls + SMS.
//
// Endpoints:
//   GET  /me/dids          — list this user's UserDid rows
//   POST /me/active-did    — switch the active outbound DID
//
// Both require an authenticated JWT. No admin gate — these operate on the
// caller's own data only.
//
// On /me/active-did:
//   - Refuses if the supplied userDidId doesn't belong to the caller.
//   - Updates User.activeUserDidId.
//   - Calls telnyx.setConnectionCallerIdOverride() to flip the outbound
//     caller-ID at Telnyx for subsequent calls. The PATCH propagates within
//     ~1 second on Telnyx's side — fast enough that users won't notice a lag.
//   - If the Telnyx PATCH fails, we still succeed the DB update and return
//     a warning in the response. Re-attempting the switch later (or any
//     server-side cron) can re-sync the override.
//   - Audit log entry on every successful switch.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@ace/db';
import * as telnyx from '../telnyx/numbers.js';
import { recordAudit } from '../lib/audit.js';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

const SwitchSchema = z.object({
  userDidId: z.number().int().positive(),
});

/**
 * Shape returned by GET /me/dids. Mirrors the UserDid prisma model but
 * deliberately strips telnyxNumberId + connectionId (Telnyx internal ids,
 * no client-side use). isActiveOutbound is a derived convenience flag so
 * the dropdown can highlight the currently-selected row without a separate
 * fetch of User.activeUserDidId.
 */
export interface UserDidPublic {
  id: number;
  didNumber: string;
  label: string;
  colorHex: string;
  isDefault: boolean;
  isActiveOutbound: boolean;
  ringGroupId: number | null;
  ivrMenuId: number | null;
}

export async function meRoutes(app: FastifyInstance) {
  // ── GET /me/dids ──────────────────────────────────────────────────────
  app.get(
    '/me/dids',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const me = (request.user as JwtPayload).sub;

      // Pull the user + their DIDs in one round-trip. The user row also
      // tells us activeUserDidId so we can derive isActiveOutbound below
      // without a second query.
      const user = await prisma.user.findUnique({
        where: { id: me },
        select: { activeUserDidId: true },
      });
      const activeId = user?.activeUserDidId ?? null;

      const dids = await prisma.userDid.findMany({
        where: { userId: me },
        orderBy: [
          // Default DID first so the dropdown's first option is always the
          // user's primary line, regardless of insertion order.
          { isDefault: 'desc' },
          { createdAt: 'asc' },
        ],
        select: {
          id: true,
          didNumber: true,
          label: true,
          colorHex: true,
          isDefault: true,
          ringGroupId: true,
          ivrMenuId: true,
        },
      });

      const out: UserDidPublic[] = dids.map((d) => ({
        id: d.id,
        didNumber: d.didNumber,
        label: d.label,
        colorHex: d.colorHex,
        isDefault: d.isDefault,
        // Fallback: if there's no activeUserDidId set yet (a user that
        // existed before v0.10.0's backfill happens to land), treat
        // isDefault as the active marker. Should always be at most one row.
        isActiveOutbound:
          activeId !== null
            ? d.id === activeId
            : d.isDefault,
        ringGroupId: d.ringGroupId,
        ivrMenuId: d.ivrMenuId,
      }));
      return { dids: out };
    },
  );

  // ── POST /me/active-did ───────────────────────────────────────────────
  app.post(
    '/me/active-did',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      const me = (request.user as JwtPayload).sub;
      const parsed = SwitchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { userDidId } = parsed.data;

      // Look up the target DID + verify it belongs to the caller in one
      // go. Strict ownership check — a user supplying someone else's
      // userDidId gets 404, not 403, so we don't leak the existence of
      // other users' DIDs.
      const target = await prisma.userDid.findFirst({
        where: { id: userDidId, userId: me },
        select: {
          id: true,
          didNumber: true,
          label: true,
          connectionId: true,
        },
      });
      if (!target) {
        return reply.code(404).send({ error: 'DID not found for this user' });
      }

      // Update the pointer first (DB write is cheap + idempotent). If the
      // Telnyx PATCH fails next, the dialer header still shows the new
      // selection and the user can retry — the SMS path uses
      // activeUserDidId immediately, no Telnyx round-trip required.
      await prisma.user.update({
        where: { id: me },
        data: { activeUserDidId: userDidId },
      });

      // Update Telnyx's outbound caller-ID override on the connection
      // that handles this user's calls. We need the connectionId for
      // that PATCH. If the UserDid row doesn't have it cached yet (older
      // rows from before v0.10.0's backfill), we skip the Telnyx update
      // and return a warning — the SMS path still works, just outbound
      // calls keep the previous caller ID until someone updates the
      // connection cache (admin "Repair" button, or first invite from
      // this user).
      let telnyxUpdated = false;
      let telnyxWarning: string | null = null;
      if (target.connectionId) {
        const res = await telnyx.setConnectionCallerIdOverride(
          target.connectionId,
          target.didNumber,
        );
        if (res.ok) {
          telnyxUpdated = true;
        } else {
          telnyxWarning = `Telnyx PATCH returned ${res.status}: ${JSON.stringify(res.error)}`;
          request.log.warn(
            { userId: me, userDidId, status: res.status, error: res.error },
            '[me/active-did] Telnyx caller-id override update failed',
          );
        }
      } else {
        telnyxWarning =
          'No Telnyx connectionId cached on this DID — outbound caller ID may not switch immediately.';
      }

      await recordAudit(me, 'user.active_did_switched', me, {
        userDidId,
        didNumber: target.didNumber,
        label: target.label,
        telnyxUpdated,
        telnyxWarning,
      });

      return {
        ok: true,
        userDidId,
        didNumber: target.didNumber,
        label: target.label,
        telnyxUpdated,
        ...(telnyxWarning ? { warning: telnyxWarning } : {}),
      };
    },
  );
}
