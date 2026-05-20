// Custom Voicemail Greeting.
//
// Flow:
//   1. Client POSTs an audio file as base64 JSON (same pattern as
//      /messages/upload for MMS).
//   2. We store the file in Supabase Storage (ace-media bucket) under
//      voicemail-greetings/u{userId}/...
//   3. We PATCH Telnyx with the greeting URL so callers hear the user's
//      greeting on no-answer instead of the default Telnyx voice.
//   4. We save the URL + filename on the User row.
//
// Telnyx phone_numbers/voicemail endpoint accepts a `greeting_audio_url`
// field on PATCH (it doesn't on POST — the POST is for enabling). The
// audio file must be publicly fetchable, which is why we use the public
// Supabase bucket (same one MMS uses).
//
// DELETE removes the greeting — both from Telnyx (so it falls back to
// default) and from the User row. The file in Supabase isn't deleted
// (kept for audit; cheap to store). User can upload a new one to replace.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@ace/db';
import { config } from '../config.js';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

const UploadSchema = z.object({
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1),
  // Base64-encoded file contents. Caps at 2 MB (matches hold-music limit).
  dataBase64: z.string().min(1),
});

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/m4a',
  'audio/mp4',
  'audio/x-m4a',
  'audio/ogg',
  'audio/aac',
]);

// Lazy-resolve the Telnyx-side phone_number_id and cache on the User row.
async function resolveTelnyxNumberId(
  userId: number,
  didNumber: string,
): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user?.telnyxNumberId) return user.telnyxNumberId;
  if (!config.telnyxApiKey) return null;
  const url = `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(didNumber)}&page[size]=10`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.telnyxApiKey}` },
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as {
    data?: Array<{ id?: string; phone_number?: string }>;
  };
  const match = body.data?.find((d) => d.phone_number === didNumber);
  if (!match?.id) return null;
  await prisma.user.update({
    where: { id: userId },
    data: { telnyxNumberId: match.id },
  });
  return match.id;
}

async function setTelnyxGreeting(
  numberId: string,
  greetingUrl: string | null,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!config.telnyxApiKey) {
    return { ok: false, status: 0, body: 'TELNYX_API_KEY not set' };
  }
  const voicemailUrl = `https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(numberId)}/voicemail`;

  // Telnyx's PATCH for voicemail validates the FULL document, not a partial.
  // If we omit `pin` or `enabled` it 422s with "can't be blank". So first
  // GET the current settings, then PATCH with all of them + the new
  // greeting URL layered on top.
  const getRes = await fetch(voicemailUrl, {
    headers: { Authorization: `Bearer ${config.telnyxApiKey}` },
  });
  let currentPin = '1234'; // fallback if GET fails or pin missing
  let currentEnabled = true;
  if (getRes.ok) {
    const j = (await getRes.json().catch(() => ({}))) as {
      data?: { enabled?: boolean; pin?: string };
    };
    if (typeof j.data?.pin === 'string' && j.data.pin) currentPin = j.data.pin;
    if (typeof j.data?.enabled === 'boolean') currentEnabled = j.data.enabled;
  }

  const res = await fetch(voicemailUrl, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.telnyxApiKey}`,
    },
    body: JSON.stringify({
      enabled: currentEnabled,
      pin: currentPin,
      greeting_audio_url: greetingUrl ?? '',
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export async function voicemailGreetingRoutes(app: FastifyInstance) {
  // GET /voicemail-greeting — current saved greeting, if any.
  app.get(
    '/voicemail-greeting',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const u = request.user as JwtPayload;
      const row = await prisma.user.findUnique({
        where: { id: u.sub },
        select: { voicemailGreetingUrl: true, voicemailGreetingFilename: true },
      });
      return {
        url: row?.voicemailGreetingUrl ?? null,
        filename: row?.voicemailGreetingFilename ?? null,
      };
    },
  );

  // POST /voicemail-greeting — replace the user's greeting with the uploaded audio.
  app.post(
    '/voicemail-greeting',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      const u = request.user as JwtPayload;
      const parsed = UploadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { filename, mimeType, dataBase64 } = parsed.data;
      if (!ALLOWED_MIMES.has(mimeType.toLowerCase())) {
        return reply.code(400).send({
          error: `Unsupported audio type: ${mimeType}. Use MP3, WAV, M4A, AAC, or OGG.`,
        });
      }
      if (!config.supabaseUrl || !config.supabaseServiceKey) {
        return reply.code(500).send({ error: 'Supabase Storage not configured' });
      }

      const bytes = Buffer.from(dataBase64, 'base64');
      if (bytes.length > MAX_BYTES) {
        return reply
          .code(413)
          .send({ error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB).` });
      }

      // User's DID and Telnyx number id are required.
      const user = await prisma.user.findUnique({ where: { id: u.sub } });
      if (!user?.didNumber) {
        return reply.code(400).send({
          error: 'Your account has no DID assigned. Add a phone number first.',
        });
      }
      const telnyxNumberId = await resolveTelnyxNumberId(u.sub, user.didNumber);
      if (!telnyxNumberId) {
        return reply.code(502).send({
          error: 'Could not look up Telnyx phone number id.',
        });
      }

      // Upload to Supabase Storage.
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const objectPath = `voicemail-greetings/u${u.sub}/${Date.now()}_${safeName}`;
      const uploadUrl = `${config.supabaseUrl}/storage/v1/object/${config.supabaseMediaBucket}/${objectPath}`;
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.supabaseServiceKey}`,
          'Content-Type': mimeType,
          'x-upsert': 'true',
        },
        body: bytes,
      });
      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => '');
        app.log.warn({ status: uploadRes.status, errText }, '[vm-greeting] supabase upload failed');
        return reply.code(502).send({
          error: 'Storage upload failed',
          details: errText,
        });
      }
      const publicUrl = `${config.supabaseUrl}/storage/v1/object/public/${config.supabaseMediaBucket}/${objectPath}`;

      // Tell Telnyx to use this URL as the greeting.
      const telnyx = await setTelnyxGreeting(telnyxNumberId, publicUrl);
      if (!telnyx.ok) {
        app.log.warn({ telnyx }, '[vm-greeting] Telnyx PATCH failed');
        return reply.code(502).send({
          error: 'Telnyx refused the greeting update',
          telnyxStatus: telnyx.status,
          telnyxBody: telnyx.body,
        });
      }

      // Persist on the User row.
      const saved = await prisma.user.update({
        where: { id: u.sub },
        data: {
          voicemailGreetingUrl: publicUrl,
          voicemailGreetingFilename: filename,
        },
        select: { voicemailGreetingUrl: true, voicemailGreetingFilename: true },
      });
      app.log.info(
        { userId: u.sub, url: publicUrl },
        '[vm-greeting] saved',
      );
      return {
        url: saved.voicemailGreetingUrl,
        filename: saved.voicemailGreetingFilename,
      };
    },
  );

  // DELETE /voicemail-greeting — revert to Telnyx default greeting.
  app.delete(
    '/voicemail-greeting',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      const u = request.user as JwtPayload;
      const user = await prisma.user.findUnique({ where: { id: u.sub } });
      if (!user) return reply.code(404).send({ error: 'User not found' });
      if (user.didNumber) {
        const telnyxNumberId = await resolveTelnyxNumberId(u.sub, user.didNumber);
        if (telnyxNumberId) {
          // Fire-and-forget — even if Telnyx is slow, we clear our DB row.
          await setTelnyxGreeting(telnyxNumberId, null).catch(() => undefined);
        }
      }
      await prisma.user.update({
        where: { id: u.sub },
        data: { voicemailGreetingUrl: null, voicemailGreetingFilename: null },
      });
      return { ok: true };
    },
  );
}
