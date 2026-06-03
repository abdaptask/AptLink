// Phase 5.3: SMS/MMS API endpoints.
//
// - GET  /messages/threads             list of conversations (last msg per other party)
// - GET  /messages/threads/:number     full thread with one number
// - POST /messages                     send SMS/MMS via Telnyx Messaging API
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '@ace/db';
import { config } from '../config.js';
import { sendMessageImmediate } from './sendMessage.js';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

interface SendMessageBody {
  to: string;
  body?: string;
  mediaUrls?: string[];
}

function toE164(raw: string): string {
  const cleaned = (raw ?? '').replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  return `+${cleaned}`;
}

export async function messagesRoutes(app: FastifyInstance) {
  // --- Unread count for bottom-nav badge ---
  // v0.10.26 — Switched from localStorage `since` timestamp to server-side
  // Message.readAt. Counts inbound messages where readAt IS NULL. Synced
  // across devices, survives cache clear. The `?since=` param is honored
  // for backwards compat with older clients but ignored in the readAt path.
  app.get(
    '/messages/unread/count',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const user = request.user as JwtPayload;
      const sinceRaw = (request.query as { since?: string }).since;
      // If a client still passes `since`, fall back to the legacy query
      // (date-based). Otherwise use readAt=null (server-side state).
      const where = sinceRaw
        ? {
            userId: user.sub,
            direction: 'inbound',
            createdAt: { gt: new Date(sinceRaw) },
          }
        : {
            userId: user.sub,
            direction: 'inbound',
            readAt: null,
          };
      const count = await prisma.message.count({ where });
      return { count };
    },
  );

  // --- List threads (last message per other party) ---
  app.get(
    '/messages/threads',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const user = request.user as JwtPayload;

      // Raw SQL is the cleanest way to get the most-recent message per threadKey.
      // We DISTINCT ON the thread_key after ordering by createdAt desc.
      // (Prisma's aggregations don't natively cover this in a single query.)
      // v0.10.0 Task 5 — LEFT JOIN user_dids to attach the line-badge fields
      // (label + colorHex). Done in-SQL rather than a follow-up Prisma query
      // since the messages-threads list is hit on every Messages tab open.
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          id: number;
          thread_key: string;
          direction: string;
          from_number: string;
          to_number: string;
          body: string;
          media_urls: string[] | null;
          status: string;
          created_at: Date;
          user_did_id: number | null;
          ud_label: string | null;
          ud_color_hex: string | null;
          ud_did_number: string | null;
        }>
      >(
        `SELECT DISTINCT ON (m.thread_key)
            m.id, m.thread_key, m.direction, m.from_number, m.to_number,
            m.body, m.media_urls, m.status, m.created_at, m.user_did_id,
            ud.label    AS ud_label,
            ud.color_hex AS ud_color_hex,
            ud.did_number AS ud_did_number
          FROM messages m
          LEFT JOIN user_dids ud ON ud.id = m.user_did_id
          WHERE m.user_id = $1
          ORDER BY m.thread_key, m.created_at DESC`,
        user.sub
      );

      // v0.10.26 — Pull unread counts per thread in one query, then map.
      // Counts inbound messages where readAt IS NULL, grouped by threadKey.
      const unreadRows = await prisma.message.groupBy({
        by: ['threadKey'],
        where: {
          userId: user.sub,
          direction: 'inbound',
          readAt: null,
        },
        _count: { _all: true },
      });
      const unreadByThread = new Map<string, number>(
        unreadRows.map((r) => [r.threadKey, r._count._all]),
      );

      // Sort by latest message time for the list view.
      rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return rows.map((r) => ({
        id: r.id,
        threadKey: r.thread_key,
        direction: r.direction,
        fromNumber: r.from_number,
        toNumber: r.to_number,
        body: r.body,
        mediaUrls: r.media_urls ?? [],
        status: r.status,
        createdAt: r.created_at,
        // v0.10.26 — Per-thread unread message count for the inbox dot.
        unreadCount: unreadByThread.get(r.thread_key) ?? 0,
        // v0.10.0 Task 5 — flattened UserDid for the line badge.
        // Null when this message was sent/received before the backfill
        // tagged it, or when the matched DID has since been deleted.
        userDid: r.user_did_id !== null && r.ud_label !== null
          ? {
              id: r.user_did_id,
              label: r.ud_label,
              colorHex: r.ud_color_hex,
              didNumber: r.ud_did_number,
            }
          : null,
      }));
    }
  );

  // --- Full thread with a single number ---
  app.get(
    '/messages/threads/:number',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const user = request.user as JwtPayload;
      const { number } = request.params as { number: string };
      const threadKey = toE164(decodeURIComponent(number));
      const msgs = await prisma.message.findMany({
        where: { userId: user.sub, threadKey },
        orderBy: { createdAt: 'asc' },
        // v0.10.0 Task 5 — UserDid for the line-badge tag.
        include: {
          userDid: {
            select: { id: true, label: true, colorHex: true, didNumber: true },
          },
        },
      });
      return msgs;
    }
  );

  // --- Send an outbound SMS/MMS ---
  app.post(
    '/messages',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const body = request.body as SendMessageBody;

      if (!body?.to || ((!body.body || body.body.trim() === '') && (!body.mediaUrls || body.mediaUrls.length === 0))) {
        return reply.code(400).send({ error: 'to + (body or mediaUrls) required' });
      }
      if (!config.telnyxApiKey) {
        return reply.code(500).send({ error: 'TELNYX_API_KEY not configured on server' });
      }

      const to = toE164(body.to);

      // v0.10.59 — Delegate to the shared sendMessageImmediate helper so
      // the scheduled-message worker uses the exact same codepath. Status
      // code translation happens here based on the result.code.
      const result = await sendMessageImmediate({
        userId: user.sub,
        toNumber: to,
        body: body.body ?? '',
        mediaUrls: body.mediaUrls ?? [],
      });
      if (!result.ok) {
        if (result.code === 'no_did_assigned') {
          app.log.warn({ userId: user.sub }, '[messages] outbound SMS refused: no DID');
          return reply.code(409).send({ error: result.code, message: result.message });
        }
        if (result.code === 'config_missing') {
          return reply.code(500).send({ error: result.message });
        }
        app.log.warn({ code: result.code, detail: result.detail }, '[messages] send failed');
        return reply.code(502).send({ error: result.code, message: result.message, details: result.detail });
      }
      return result.message;
    }
  );

  // --- MMS upload (base64 JSON to Supabase Storage public bucket) ---
  // Body: { filename: 'foo.jpg', mimeType: 'image/jpeg', dataBase64: '...' }
  // Returns: { url: 'https://...supabase.co/storage/v1/object/public/<bucket>/<path>' }
  app.post(
    '/messages/upload',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const body = request.body as {
        filename?: string;
        mimeType?: string;
        dataBase64?: string;
      };

      if (!body?.filename || !body?.dataBase64 || !body?.mimeType) {
        return reply.code(400).send({ error: 'filename, mimeType, dataBase64 required' });
      }
      if (!config.supabaseUrl || !config.supabaseServiceKey) {
        return reply.code(500).send({ error: 'Supabase Storage not configured' });
      }

      const bytes = Buffer.from(body.dataBase64, 'base64');
      // Hard cap: 10 MB. MMS itself is limited to 5 MB on most carriers.
      if (bytes.length > 10 * 1024 * 1024) {
        return reply.code(413).send({ error: 'file too large (max 10 MB)' });
      }

      // Sanitise filename, prefix with user + timestamp so paths don't collide.
      const safeName = body.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const objectPath = `u${user.sub}/${Date.now()}_${safeName}`;

      const uploadUrl = `${config.supabaseUrl}/storage/v1/object/${config.supabaseMediaBucket}/${objectPath}`;
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.supabaseServiceKey}`,
          'Content-Type': body.mimeType,
          'x-upsert': 'true',
        },
        body: bytes,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        app.log.warn({ status: res.status, errText, bucket: config.supabaseMediaBucket }, '[upload] supabase store failed');
        // Surface a more useful hint to the browser so pilot users can
        // diagnose without API log access. Map common Supabase responses
        // to a human-readable cause.
        let hint = 'Supabase Storage rejected the upload.';
        const lower = errText.toLowerCase();
        if (res.status === 404 || lower.includes('bucket not found')) {
          hint = `Bucket "${config.supabaseMediaBucket}" not found. Create it in Supabase → Storage and mark it Public.`;
        } else if (res.status === 401 || lower.includes('invalid api key') || lower.includes('jwt')) {
          hint = 'API server has a bad SUPABASE_SERVICE_ROLE_KEY. Re-copy the service_role key from Supabase → Settings → API.';
        } else if (lower.includes('row-level security') || lower.includes('not authorized')) {
          hint = 'RLS rejected the upload — the env var is probably the anon key. Use the service_role key.';
        } else if (lower.includes('mime') || lower.includes('content type')) {
          hint = 'Bucket has a MIME-type allowlist that rejected this file. Remove the restriction in the bucket settings.';
        }
        return reply.code(502).send({
          error: 'storage_upload_failed',
          status: res.status,
          hint,
          details: errText,
        });
      }

      const publicUrl = `${config.supabaseUrl}/storage/v1/object/public/${config.supabaseMediaBucket}/${objectPath}`;
      return { url: publicUrl };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // v0.10.26 — Server-side mark-as-read for SMS / MMS messages.
  //
  // Previous version: read state was localStorage-only via
  // `markThreadVisited` — not synced across devices, lost on cache clear.
  // New version: per-message Message.readAt timestamp. Auto-marks when
  // user opens a thread; manual toggle via PATCH endpoint.
  //
  // Endpoints:
  //   POST  /messages/threads/:number/read   — mark ALL inbound in thread read
  //   POST  /messages/threads/:number/unread — mark thread unread (latest only)
  //   PATCH /messages/:id/read               — toggle a specific message
  //                                            { read: true | false }
  // ═══════════════════════════════════════════════════════════════════════

  /** Helper: normalize a phone number param to last-10-digit comparison form. */
  function last10(s: string): string {
    return (s ?? '').replace(/\D/g, '').slice(-10);
  }

  // POST /messages/threads/:number/read
  // Marks ALL inbound, unread messages in the thread as read. Called by
  // the client on thread open. Idempotent.
  app.post<{ Params: { number: string } }>(
    '/messages/threads/:number/read',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const other = last10(request.params.number);
      if (other.length !== 10) {
        return reply.code(400).send({ error: 'Invalid thread number' });
      }
      // Match by threadKey last-10 to tolerate +1 / no-+1 storage drift.
      const result = await prisma.message.updateMany({
        where: {
          userId: user.sub,
          direction: 'inbound',
          readAt: null,
          threadKey: { contains: other },
        },
        data: { readAt: new Date() },
      });
      return { ok: true, marked: result.count };
    },
  );

  // POST /messages/threads/:number/unread
  // Marks the MOST RECENT inbound message in the thread as unread, so the
  // thread re-appears with an unread dot. Lets the user "mark as unread"
  // a thread they previously read but want to come back to.
  app.post<{ Params: { number: string } }>(
    '/messages/threads/:number/unread',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const other = last10(request.params.number);
      if (other.length !== 10) {
        return reply.code(400).send({ error: 'Invalid thread number' });
      }
      const latest = await prisma.message.findFirst({
        where: {
          userId: user.sub,
          direction: 'inbound',
          threadKey: { contains: other },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (!latest) {
        return reply.code(404).send({ error: 'No inbound message in this thread' });
      }
      await prisma.message.update({
        where: { id: latest.id },
        data: { readAt: null },
      });
      return { ok: true, messageId: latest.id };
    },
  );

  // PATCH /messages/:id/read   body: { read: boolean }
  // Toggle a specific message's read state. Used for per-message
  // unread/read actions.
  app.patch<{ Params: { id: string }; Body: { read?: boolean } }>(
    '/messages/:id/read',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const id = Number(request.params.id);
      if (!Number.isFinite(id)) {
        return reply.code(400).send({ error: 'Invalid id' });
      }
      const body = request.body ?? {};
      if (typeof body.read !== 'boolean') {
        return reply.code(400).send({ error: 'Expected { read: boolean }' });
      }
      const existing = await prisma.message.findFirst({
        where: { id, userId: user.sub },
        select: { id: true, direction: true },
      });
      if (!existing) return reply.code(404).send({ error: 'Not found' });
      if (existing.direction !== 'inbound') {
        return reply.code(400).send({ error: 'Outbound messages don\'t track read state' });
      }
      const updated = await prisma.message.update({
        where: { id },
        data: { readAt: body.read ? new Date() : null },
        select: { id: true, readAt: true },
      });
      return { ok: true, id: updated.id, readAt: updated.readAt };
    },
  );
}
