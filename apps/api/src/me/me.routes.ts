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

// v0.10.0 Pillar 2 — Teams notification config.
//
// Three event types the user can opt in/out of independently. Stored as
// a comma-separated string in users.teams_notify_on (simpler than a
// JSONB array for what's at most three values).
const TEAMS_EVENT_TYPES = ['missed_call', 'sms', 'voicemail'] as const;
type TeamsEventType = (typeof TEAMS_EVENT_TYPES)[number];

// v0.10.1 — switched from per-user webhook URL to a tenant-wide Power
// Automate flow (TEAMS_TENANT_WEBHOOK_URL env var on the webhooks
// service). Users no longer manage a URL; they just toggle which event
// types they want cards for. The teamsWebhookUrl column stays in DB
// as nullable / unused for now to avoid a destructive migration —
// the notifier doesn't read it anymore.
const TeamsConfigSchema = z.object({
  // Array on the wire — easier for the client form to handle as checkboxes.
  // Convert to/from comma-separated string for storage.
  events: z.array(z.enum(TEAMS_EVENT_TYPES)).optional(),
});

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

  // ═══════════════════════════════════════════════════════════════════════
  // v0.10.0 Pillar 2 — Microsoft Teams notification config (Task 6).
  //
  // Each user maintains their own personal Incoming Webhook URL pointing
  // at a Teams channel of their choosing. We POST Adaptive Cards to it
  // on missed call / inbound SMS / voicemail completed events. Per-user
  // (not per-org) so each pilot user can route to their own DMs / a
  // private team / wherever. They control the opt-in independently.
  //
  // Endpoints:
  //   GET   /me/teams-config        — read current settings
  //   PATCH /me/teams-config        — update URL and/or event opt-ins
  //   POST  /me/teams-config/test   — send a sample card so the user
  //                                    can verify the URL works before
  //                                    relying on it for production
  //                                    events.
  // ═══════════════════════════════════════════════════════════════════════

  app.get(
    '/me/teams-config',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const me = (request.user as JwtPayload).sub;
      const user = await prisma.user.findUnique({
        where: { id: me },
        select: { teamsNotifyOn: true },
      });
      const eventsCsv = user?.teamsNotifyOn ?? '';
      const events = eventsCsv
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is TeamsEventType =>
          (TEAMS_EVENT_TYPES as readonly string[]).includes(s),
        );
      // v0.10.1 — tenantConfigured tells the UI whether to show the
      // event toggles at all. When the env var isn't set, Teams notifs
      // are effectively disabled tenant-wide and the UI shows an
      // "ask your admin to enable Teams notifications" empty state.
      return {
        tenantConfigured: Boolean((process.env.TEAMS_TENANT_WEBHOOK_URL ?? '').trim()),
        events,
        availableEvents: TEAMS_EVENT_TYPES,
      };
    },
  );

  app.patch(
    '/me/teams-config',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      const me = (request.user as JwtPayload).sub;
      const parsed = TeamsConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid input',
          details: parsed.error.flatten(),
        });
      }
      const { events } = parsed.data;
      const data: { teamsNotifyOn?: string | null } = {};
      if (events !== undefined) {
        // Dedup + sort for stable storage.
        const deduped = Array.from(new Set(events)).sort();
        data.teamsNotifyOn = deduped.length > 0 ? deduped.join(',') : null;
      }
      await prisma.user.update({ where: { id: me }, data });
      await recordAudit(me, 'user.teams_config_updated', me, {
        events: data.teamsNotifyOn ?? null,
      });
      return { ok: true };
    },
  );

  // v0.10.1 — Sends a sample Adaptive Card via the TENANT-WIDE Power
  // Automate flow (TEAMS_TENANT_WEBHOOK_URL env var). The flow reads
  // recipientEmail from the body and DMs the calling user via Flow bot.
  // Useful for the user to confirm they can receive cards in Teams
  // before relying on it for production missed-call / SMS / voicemail
  // events. Returns HTTP status from Teams so the UI can show
  // success/failure.
  app.post(
    '/me/teams-config/test',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      const me = (request.user as JwtPayload).sub;
      const tenantUrl = (process.env.TEAMS_TENANT_WEBHOOK_URL ?? '').trim();
      if (!tenantUrl) {
        return reply.code(503).send({
          error:
            'Teams notifications are not configured at the org level. Ask your admin to set TEAMS_TENANT_WEBHOOK_URL.',
        });
      }
      const user = await prisma.user.findUnique({
        where: { id: me },
        select: {
          firstName: true,
          email: true,
        },
      });
      if (!user?.email) {
        return reply.code(409).send({
          error: 'Your account has no email on file; cannot route a Teams card.',
        });
      }
      // Bare AdaptiveCard — the Power Automate flow's "Post adaptive
      // card" action wants the card body directly, not a Teams "message"
      // envelope. Matches the shape the notifier sends for real events.
      const card = {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: '✅ ACE Dialer Teams notifications connected',
            size: 'Large',
            weight: 'Bolder',
          },
          {
            type: 'TextBlock',
            text: `Hello ${user.firstName ?? user.email}, this is a test card from ACE Dialer. You'll receive cards here when you have a missed call, a new SMS, or a voicemail (per your opt-ins).`,
            wrap: true,
            isSubtle: true,
          },
          {
            type: 'TextBlock',
            text: 'Use the toggles in Settings → Personal → Teams notifications to mute event types you don\'t want.',
            wrap: true,
            isSubtle: true,
            spacing: 'Small',
          },
        ],
      };
      try {
        const res = await fetch(tenantUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipientEmail: user.email,
            eventType: 'test',
            card,
          }),
        });
        const text = await res.text().catch(() => '');
        if (!res.ok) {
          request.log.warn(
            { status: res.status, body: text.slice(0, 300) },
            '[me/teams-config/test] tenant webhook rejected card',
          );
          return reply.code(502).send({
            ok: false,
            status: res.status,
            error:
              res.status === 410
                ? 'Tenant webhook URL expired or deleted. Admin should re-create the Power Automate flow.'
                : `Teams returned HTTP ${res.status}: ${text.slice(0, 200)}`,
          });
        }
        return { ok: true, status: res.status };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(502).send({
          ok: false,
          error: `Failed to reach Teams webhook: ${msg}`,
        });
      }
    },
  );
}
