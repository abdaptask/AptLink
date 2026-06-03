// Unified per-contact history endpoint.
// Returns every interaction (messages, calls, voicemails) with a given
// phone number so the UI can show "12 messages · 3 calls · 1 voicemail"
// plus a chronological timeline when the user wants to drill in.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '@ace/db';
import { dedupeCallLegs } from '../calls/calls.routes.js';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

// Normalize a phone for matching. We compare by last-10 digits so
// "+19737270611", "19737270611", and "(973) 727-0611" all match the same
// contact even if they were stored differently across tables.
function last10Digits(phone: string): string {
  return (phone ?? '').replace(/[^\d]/g, '').slice(-10);
}

export async function contactsRoutes(app: FastifyInstance) {
  app.get('/contacts/history', { onRequest: [app.authenticate] }, async (request: FastifyRequest, reply) => {
    const user = request.user as JwtPayload;
    const query = request.query as { phone?: string; limit?: string };

    const phoneRaw = (query.phone ?? '').trim();
    if (!phoneRaw) {
      return reply.code(400).send({ error: 'phone is required' });
    }
    const want = last10Digits(phoneRaw);
    if (want.length < 7) {
      return reply.code(400).send({ error: 'phone must include at least 7 digits' });
    }

    const limit = Math.min(Number(query.limit) || 50, 200);

    // We can't push the digit-normalized comparison into a Prisma where clause
    // easily (it would require raw SQL with regex_replace). Instead we fetch
    // a generous window and filter in JS — fine for per-user volumes.
    const [allMessages, allCalls, allVoicemails] = await Promise.all([
      prisma.message.findMany({
        where: { userId: user.sub },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      prisma.call.findMany({
        where: { userId: user.sub },
        orderBy: { startedAt: 'desc' },
        take: 500,
      }),
      prisma.voicemail.findMany({
        where: { userId: user.sub },
        orderBy: { receivedAt: 'desc' },
        take: 200,
      }),
    ]);

    const messages = allMessages
      .filter((m) => last10Digits(m.threadKey) === want)
      .slice(0, limit);
    // v0.10.55 — Collapse Telnyx Leg A + Leg B into one row per physical call.
    // Telnyx fires webhooks on BOTH legs of a single call (client SIP leg and
    // PSTN destination leg) — each with its own call_control_id, so naive
    // findMany returns 2 rows per call. The /calls Recents endpoint already
    // ran rows through dedupeCallLegs; the contact-history modal was missing
    // that step and showed 6 rows for 3 calls. Apply the same dedup here.
    const callsRaw = allCalls.filter((c) => {
      const other = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
      return last10Digits(other ?? '') === want;
    });
    const calls = dedupeCallLegs(callsRaw).slice(0, limit);
    const voicemails = allVoicemails
      .filter((v) => last10Digits(v.fromNumber) === want)
      .slice(0, limit);

    // Build a unified chronological timeline (newest first).
    interface TimelineEntry {
      type: 'message' | 'call' | 'voicemail';
      timestamp: string;
      id: number;
      direction?: string;
      // Subset of fields the UI needs to render.
      message?: { body: string | null; mediaUrls: string[]; status: string };
      call?: { status: string; durationSeconds: number; hangupCause: string | null; recordingUrl: string | null };
      voicemail?: { recordingUrl: string; durationSeconds: number; transcription: string | null };
    }
    const timeline: TimelineEntry[] = [];
    for (const m of messages) {
      timeline.push({
        type: 'message',
        id: m.id,
        timestamp: m.createdAt.toISOString(),
        direction: m.direction,
        message: {
          body: m.body,
          mediaUrls: (m.mediaUrls as string[] | null) ?? [],
          status: m.status,
        },
      });
    }
    for (const c of calls) {
      timeline.push({
        type: 'call',
        id: c.id,
        timestamp: c.startedAt.toISOString(),
        direction: c.direction,
        call: {
          status: c.status,
          durationSeconds: c.durationSeconds,
          hangupCause: c.hangupCause,
          recordingUrl: c.recordingUrl,
        },
      });
    }
    for (const v of voicemails) {
      timeline.push({
        type: 'voicemail',
        id: v.id,
        timestamp: v.receivedAt.toISOString(),
        direction: 'inbound',
        voicemail: {
          recordingUrl: v.recordingUrl,
          durationSeconds: v.durationSeconds,
          transcription: v.transcription,
        },
      });
    }
    timeline.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

    const lastInteraction = timeline[0]?.timestamp ?? null;

    return {
      phone: phoneRaw,
      summary: {
        messageCount: messages.length,
        callCount: calls.length,
        voicemailCount: voicemails.length,
        lastInteraction,
      },
      timeline: timeline.slice(0, limit),
    };
  });
}
