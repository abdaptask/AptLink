// Internal Chat — dialer-user-to-dialer-user messaging.
// Separate from the SMS surface (which goes to external phone numbers via
// Telnyx). These messages stay inside our database; the socket service
// pushes them in real time.
//
// Routes:
//   GET  /internal-chat/users        — list other users you can chat with
//   GET  /internal-chat/threads      — list of your conversations (newest first)
//   GET  /internal-chat/threads/:id  — one conversation's messages
//   POST /internal-chat              — send a message
//   PATCH /internal-chat/:id/read    — mark a single message as read
//   POST  /internal-chat/threads/:id/read — mark every unread in this thread
//   GET  /internal-chat/unread/count — for bottom-nav badge
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@ace/db';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

// Canonical thread key from two user ids — lower id first so it's stable
// regardless of who sent the most recent message.
function threadKeyFor(a: number, b: number): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${lo}_${hi}`;
}

const SendSchema = z.object({
  recipientId: z.number().int().positive(),
  body: z.string().optional().default(''),
  mediaUrl: z.string().url().optional().nullable(),
});

export async function internalChatRoutes(app: FastifyInstance) {
  // List other users — basics only, no SIP creds. Excludes the caller.
  app.get(
    '/internal-chat/users',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const me = (request.user as JwtPayload).sub;
      const users = await prisma.user.findMany({
        where: { id: { not: me }, isActive: true },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
        orderBy: [{ firstName: 'asc' }, { email: 'asc' }],
      });
      return users;
    },
  );

  // Conversations list — one row per other-user, with last-message preview.
  app.get(
    '/internal-chat/threads',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const me = (request.user as JwtPayload).sub;
      // Pull every message I'm involved in; group by other-user-id in memory.
      // For 1-3 pilot users this is trivial; if it grows, swap for a SQL
      // DISTINCT ON query.
      const rows = await prisma.internalMessage.findMany({
        where: { OR: [{ senderId: me }, { recipientId: me }] },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      const seen = new Map<number, {
        otherId: number;
        lastMessage: string;
        mediaUrl: string | null;
        lastAt: string;
        lastSenderId: number;
        unreadCount: number;
      }>();
      for (const m of rows) {
        const otherId = m.senderId === me ? m.recipientId : m.senderId;
        const existing = seen.get(otherId);
        const isUnreadForMe = m.recipientId === me && m.readAt === null;
        if (!existing) {
          seen.set(otherId, {
            otherId,
            lastMessage: m.body || (m.mediaUrl ? '\u{1F4CE} attachment' : ''),
            mediaUrl: m.mediaUrl,
            lastAt: m.createdAt.toISOString(),
            lastSenderId: m.senderId,
            unreadCount: isUnreadForMe ? 1 : 0,
          });
        } else if (isUnreadForMe) {
          existing.unreadCount += 1;
        }
      }
      // Decorate with names.
      const ids = Array.from(seen.keys());
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, firstName: true, lastName: true, email: true },
      });
      const userById = new Map(users.map((u) => [u.id, u]));
      return Array.from(seen.values()).map((t) => ({
        ...t,
        otherUser: userById.get(t.otherId) ?? null,
      }));
    },
  );

  // Full message history for one conversation (with another user id).
  app.get(
    '/internal-chat/threads/:otherUserId',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const me = (request.user as JwtPayload).sub;
      const { otherUserId } = request.params as { otherUserId: string };
      const otherId = Number(otherUserId);
      const messages = await prisma.internalMessage.findMany({
        where: { threadKey: threadKeyFor(me, otherId) },
        orderBy: { createdAt: 'asc' },
      });
      return messages;
    },
  );

  // Send a message. The socket service is responsible for pushing the
  // event to the recipient if they're online — see io.emit in apps/socket.
  app.post(
    '/internal-chat',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      const me = (request.user as JwtPayload).sub;
      const parsed = SendSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid', details: parsed.error.flatten() });
      }
      const { recipientId, body, mediaUrl } = parsed.data;
      if (recipientId === me) {
        return reply.code(400).send({ error: 'Cannot message yourself' });
      }
      if (!body.trim() && !mediaUrl) {
        return reply.code(400).send({ error: 'Empty message' });
      }
      const saved = await prisma.internalMessage.create({
        data: {
          senderId: me,
          recipientId,
          threadKey: threadKeyFor(me, recipientId),
          body: body.trim(),
          mediaUrl: mediaUrl ?? null,
        },
      });
      return saved;
    },
  );

  // Mark every unread in a thread as read for the caller. Used when the
  // user opens the conversation.
  app.post(
    '/internal-chat/threads/:otherUserId/read',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const me = (request.user as JwtPayload).sub;
      const { otherUserId } = request.params as { otherUserId: string };
      const otherId = Number(otherUserId);
      const result = await prisma.internalMessage.updateMany({
        where: {
          threadKey: threadKeyFor(me, otherId),
          recipientId: me,
          readAt: null,
        },
        data: { readAt: new Date() },
      });
      return { ok: true, marked: result.count };
    },
  );

  // Unread count for the whole user — drives the bottom-nav badge.
  app.get(
    '/internal-chat/unread/count',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const me = (request.user as JwtPayload).sub;
      const count = await prisma.internalMessage.count({
        where: { recipientId: me, readAt: null },
      });
      return { count };
    },
  );
}
