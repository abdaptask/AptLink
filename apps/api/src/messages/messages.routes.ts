// Phase 5.3: SMS/MMS API endpoints.
//
// - GET  /messages/threads             list of conversations (last msg per other party)
// - GET  /messages/threads/:number     full thread with one number
// - POST /messages                     send SMS/MMS via Telnyx Messaging API
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '@ace/db';
import { config } from '../config.js';

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
  // --- List threads (last message per other party) ---
  app.get(
    '/messages/threads',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const user = request.user as JwtPayload;

      // Raw SQL is the cleanest way to get the most-recent message per threadKey.
      // We DISTINCT ON the thread_key after ordering by createdAt desc.
      // (Prisma's aggregations don't natively cover this in a single query.)
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
        }>
      >(
        `SELECT DISTINCT ON (thread_key)
            id, thread_key, direction, from_number, to_number, body,
            media_urls, status, created_at
          FROM messages
          WHERE user_id = $1
          ORDER BY thread_key, created_at DESC`,
        user.sub
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
      const fromNumber = config.pilotFromNumber;
      const text = body.body ?? '';
      const mediaUrls = body.mediaUrls ?? [];

      // Call Telnyx Messaging API.
      const telnyxBody: Record<string, unknown> = {
        from: fromNumber,
        to,
        text,
      };
      if (mediaUrls.length > 0) telnyxBody.media_urls = mediaUrls;
      if (config.telnyxMessagingProfileId) {
        telnyxBody.messaging_profile_id = config.telnyxMessagingProfileId;
      }

      let telnyxResponse: { id?: string; status?: string; errors?: unknown } = {};
      try {
        const res = await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.telnyxApiKey}`,
          },
          body: JSON.stringify(telnyxBody),
        });
        const json = (await res.json()) as { data?: typeof telnyxResponse; errors?: unknown };
        if (!res.ok) {
          app.log.warn({ status: res.status, errors: json.errors }, '[messages] telnyx send failed');
          return reply.code(502).send({ error: 'telnyx_send_failed', details: json.errors });
        }
        telnyxResponse = json.data ?? {};
      } catch (e) {
        app.log.error({ err: e }, '[messages] telnyx request error');
        return reply.code(502).send({ error: 'telnyx_request_failed' });
      }

      const telnyxMessageId = telnyxResponse.id ?? `local-${Date.now()}`;
      const saved = await prisma.message.create({
        data: {
          userId: user.sub,
          telnyxMessageId,
          threadKey: to,
          direction: 'outbound',
          fromNumber,
          toNumber: to,
          body: text,
          mediaUrls,
          status: telnyxResponse.status ?? 'queued',
          sentAt: new Date(),
        },
      });
      return saved;
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
        app.log.warn({ status: res.status, errText }, '[upload] supabase store failed');
        return reply.code(502).send({ error: 'storage_upload_failed', details: errText });
      }

      const publicUrl = `${config.supabaseUrl}/storage/v1/object/public/${config.supabaseMediaBucket}/${objectPath}`;
      return { url: publicUrl };
    }
  );
}
