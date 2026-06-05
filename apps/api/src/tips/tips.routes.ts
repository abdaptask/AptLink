// v0.10.92 — Feature Tips routes.
//
// Endpoints:
//   GET    /me/tips             list enabled tips for the calling user
//                               (admin sees all enabled; non-admin excludes adminOnly)
//   POST   /admin/tips          admin creates a custom tip
//   PATCH  /admin/tips/:id      admin edits title / body / icon / enabled / adminOnly
//                               (built-in tips: only isEnabled can be toggled)
//   DELETE /admin/tips/:id      admin deletes a CUSTOM tip (not built-in)
//
// The frontend's TipBanner polls /me/tips on mount and rotates through the
// list, displaying one tip at a time for a minimum of 10 seconds (auto-
// advance at ~12s in practice).
//
// Built-in seeding happens via seedDefaultTipsIfEmpty(), exported separately
// so the API entrypoint can call it on boot.

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
  reply: { code: (n: number) => { send: (b: unknown) => void } },
) {
  const u = request.user as JwtPayload | undefined;
  if (!u?.isAdmin) {
    return reply.code(403).send({ error: 'Admin required' });
  }
}

const CreateTipSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(500),
  icon: z.string().trim().max(8).optional(),
  adminOnly: z.boolean().optional().default(false),
});

const UpdateTipSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(500).optional(),
  icon: z.string().trim().max(8).nullable().optional(),
  adminOnly: z.boolean().optional(),
  isEnabled: z.boolean().optional(),
});

export async function tipsRoutes(app: FastifyInstance) {
  // ── GET /me/tips ────────────────────────────────────────────────────────
  // Return only ENABLED tips. Non-admin users don't see adminOnly tips.
  // Sorted by isBuiltIn DESC, createdAt ASC so the default tips appear
  // first and custom ones land at the bottom (admins typically want their
  // additions to follow the curated content).
  app.get('/me/tips', { onRequest: [app.authenticate] }, async (request) => {
    const u = request.user as JwtPayload;
    const rows = await prisma.tip.findMany({
      where: {
        isEnabled: true,
        ...(u.isAdmin ? {} : { adminOnly: false }),
      },
      orderBy: [{ isBuiltIn: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        title: true,
        body: true,
        icon: true,
        adminOnly: true,
        isBuiltIn: true,
      },
    });
    return { tips: rows };
  });

  // ── GET /admin/tips ─────────────────────────────────────────────────────
  // Admin-only view returning ALL tips (enabled + disabled, built-in +
  // custom) for the Settings → Admin → Tips management page.
  app.get(
    '/admin/tips',
    { onRequest: [app.authenticate, requireAdmin] },
    async () => {
      const rows = await prisma.tip.findMany({
        orderBy: [{ isBuiltIn: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          title: true,
          body: true,
          icon: true,
          adminOnly: true,
          isEnabled: true,
          isBuiltIn: true,
          createdAt: true,
          createdBy: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      });
      return { tips: rows };
    },
  );

  // ── POST /admin/tips ────────────────────────────────────────────────────
  app.post(
    '/admin/tips',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const parsed = CreateTipSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const created = await prisma.tip.create({
        data: {
          title: parsed.data.title,
          body: parsed.data.body,
          icon: parsed.data.icon || null,
          adminOnly: parsed.data.adminOnly ?? false,
          isEnabled: true,
          isBuiltIn: false,
          createdById: u.sub,
        },
        select: {
          id: true, title: true, body: true, icon: true,
          adminOnly: true, isEnabled: true, isBuiltIn: true, createdAt: true,
        },
      });
      return created;
    },
  );

  // ── PATCH /admin/tips/:id ───────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/admin/tips/:id',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });
      const parsed = UpdateTipSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const existing = await prisma.tip.findUnique({
        where: { id },
        select: { isBuiltIn: true },
      });
      if (!existing) return reply.code(404).send({ error: 'Tip not found' });
      // For built-in tips, only allow toggling isEnabled (preserves their
      // curated copy). Title/body/icon edits on built-ins go through a
      // delete-then-recreate flow if admin really wants to override them.
      if (existing.isBuiltIn) {
        const allowed: Record<string, unknown> = {};
        if (parsed.data.isEnabled !== undefined) allowed.isEnabled = parsed.data.isEnabled;
        if (Object.keys(allowed).length === 0) {
          return reply.code(403).send({
            error: 'Built-in tips can only have their enabled state toggled. Title/body/icon edits aren\'t supported. Create a custom tip instead.',
          });
        }
        const updated = await prisma.tip.update({
          where: { id },
          data: allowed,
          select: {
            id: true, title: true, body: true, icon: true,
            adminOnly: true, isEnabled: true, isBuiltIn: true, createdAt: true,
          },
        });
        return updated;
      }
      // Custom tip — all fields editable.
      const data: Record<string, unknown> = {};
      if (parsed.data.title !== undefined) data.title = parsed.data.title;
      if (parsed.data.body !== undefined) data.body = parsed.data.body;
      if (parsed.data.icon !== undefined) data.icon = parsed.data.icon || null;
      if (parsed.data.adminOnly !== undefined) data.adminOnly = parsed.data.adminOnly;
      if (parsed.data.isEnabled !== undefined) data.isEnabled = parsed.data.isEnabled;
      const updated = await prisma.tip.update({
        where: { id },
        data,
        select: {
          id: true, title: true, body: true, icon: true,
          adminOnly: true, isEnabled: true, isBuiltIn: true, createdAt: true,
        },
      });
      return updated;
    },
  );

  // ── DELETE /admin/tips/:id ──────────────────────────────────────────────
  // Only custom tips can be deleted. Built-ins must be toggled isEnabled=false
  // instead so they can be re-enabled later without losing curated copy.
  app.delete<{ Params: { id: string } }>(
    '/admin/tips/:id',
    { onRequest: [app.authenticate, requireAdmin] },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });
      const existing = await prisma.tip.findUnique({
        where: { id },
        select: { isBuiltIn: true },
      });
      if (!existing) return reply.code(404).send({ error: 'Tip not found' });
      if (existing.isBuiltIn) {
        return reply.code(403).send({
          error: 'Built-in tips can\'t be deleted. Disable instead via PATCH { isEnabled: false }.',
        });
      }
      await prisma.tip.delete({ where: { id } });
      return { ok: true };
    },
  );
}

// ─── Default tip seed ──────────────────────────────────────────────────────
//
// Called once at API startup. If the tips table is empty, populates it with
// the curated default list below. Idempotent — re-running has no effect when
// rows already exist (so we don't duplicate seeds across redeploys).
//
// To add a new built-in tip after this list has been seeded, either:
//   1. Manually INSERT via SQL (preferred — keeps the seed list as
//      documentation of the original ship state)
//   2. Add it here AND in a one-off migration that inserts only the new row
//      (since `seedDefaultTipsIfEmpty` does nothing once rows exist).
const DEFAULT_TIPS: Array<{
  title: string;
  body: string;
  icon: string;
  adminOnly: boolean;
}> = [
  {
    icon: '⏰',
    title: 'Schedule an SMS to send later',
    body: 'In Messages, tap the clock icon next to Send to pick a future date and time. Perfect for follow-ups across time zones.',
    adminOnly: false,
  },
  {
    icon: '💬',
    title: 'Save Quick Replies for common SMS',
    body: 'Settings → Personal → Quick replies. Save templates you send often and insert them into a message with one tap.',
    adminOnly: false,
  },
  {
    icon: '⭐',
    title: 'Star your favorite contacts',
    body: 'Tap the star on any contact in Recents to pin them to the Favorites tab for one-tap dialing.',
    adminOnly: false,
  },
  {
    icon: '📞',
    title: 'Set up call forwarding',
    body: 'Going off-shift? Settings → Calling → Call forwarding routes incoming calls to your cell when ACE is closed.',
    adminOnly: false,
  },
  {
    icon: '🚫',
    title: 'Block a number',
    body: 'Right-click any caller in Recents → Block. They go straight to voicemail and you stop seeing notifications.',
    adminOnly: false,
  },
  {
    icon: '📝',
    title: 'Read voicemails as transcripts',
    body: 'Every voicemail auto-transcribes. Read what they said in the Voicemail tab without ever pressing play.',
    adminOnly: false,
  },
  {
    icon: '🎙️',
    title: 'Record a custom voicemail greeting',
    body: 'Settings → Calling → Voicemail greeting. Replace the default with your own voice so callers hear you.',
    adminOnly: false,
  },
  {
    icon: '🔔',
    title: 'Pick a custom ringtone',
    body: 'Settings → Personal → Ringtone. Choose from the library or pick whatever sound matches your style.',
    adminOnly: false,
  },
  {
    icon: '📧',
    title: 'Email me when I miss something',
    body: 'Settings → Personal → Notifications → Email tab. Get an email for missed calls, voicemails, or SMS when ACE isn\'t open.',
    adminOnly: false,
  },
  {
    icon: '🟣',
    title: 'Forward alerts to Microsoft Teams',
    body: 'Settings → Personal → Notifications → Teams tab. Send missed-call / SMS / voicemail cards to your Teams chat.',
    adminOnly: false,
  },
  {
    icon: '☎️',
    title: 'Switch between phone lines',
    body: 'If you have multiple DIDs, click your active line at the top of the dialer to pick which one places outbound calls.',
    adminOnly: false,
  },
  {
    icon: '🎵',
    title: 'Set hold music for your callers',
    body: 'Settings → Calling → Hold music. Choose what callers hear when you put them on hold.',
    adminOnly: false,
  },
  {
    icon: '🩺',
    title: 'Download diagnostic logs when something\'s off',
    body: 'Settings → Personal → Diagnostics → Download logs. Email the file to your admin so support can pinpoint exactly what happened.',
    adminOnly: false,
  },
  {
    icon: '🎤',
    title: 'Pick the right microphone',
    body: 'Settings → Calling → Microphone. Choose your headset, Bluetooth, or built-in mic before your next call.',
    adminOnly: false,
  },
  {
    icon: '🔊',
    title: 'Choose your speaker output',
    body: 'Settings → Calling → Speaker. Send call audio to a specific speaker — useful when juggling multiple devices.',
    adminOnly: false,
  },
  {
    icon: '📊',
    title: 'See your daily activity recap',
    body: 'On your first sign-in each day, the banner at the top shows yesterday\'s call / SMS / voicemail totals.',
    adminOnly: false,
  },
  {
    icon: '🟢',
    title: 'Connection status dot, top right',
    body: 'Green = Online. Amber = Reconnecting. Red = Disconnected. Hover for details, click for connection diagnostics.',
    adminOnly: false,
  },
  {
    icon: '🔍',
    title: 'Search across Recents and Messages',
    body: 'The search bar at the top of Recents and Messages finds any caller, number, or text body — handy for long histories.',
    adminOnly: false,
  },
  {
    icon: '⌨️',
    title: 'In-call keypad for menu navigation',
    body: 'Mid-call, the keypad button sends DTMF tones — useful for IVRs that ask you to press 1, 2, 3.',
    adminOnly: false,
  },
  {
    icon: '🎯',
    title: 'Send praise to a teammate',
    body: 'Admin → Send praise (under Settings). Celebrate a new hire, an offer, a birthday, an anniversary — broadcast or one-to-one.',
    adminOnly: true,
  },
];

export async function seedDefaultTipsIfEmpty(): Promise<void> {
  const existing = await prisma.tip.count();
  if (existing > 0) {
    console.log(`[tips] ${existing} tips already in DB — skipping default seed`);
    return;
  }
  await prisma.tip.createMany({
    data: DEFAULT_TIPS.map((t) => ({
      title: t.title,
      body: t.body,
      icon: t.icon,
      adminOnly: t.adminOnly,
      isEnabled: true,
      isBuiltIn: true,
    })),
  });
  console.log(`[tips] seeded ${DEFAULT_TIPS.length} default tips`);
}
