// Custom Voicemail Greeting API.
//
// v0.10.100 - Two greetings per user (no-answer + busy). The legacy
// /voicemail-greeting endpoints (v0.10.99 single-greeting model) keep
// working as aliases for the noanswer variant so v0.10.99 clients
// continue to function during the rollout window.
//
// Flow:
//   1. Client POSTs an audio file (or in-app recording Blob) as base64
//      JSON to POST /voicemail-greeting/:type (type = noanswer | busy).
//   2. We store the file in Supabase Storage (ace-media bucket) under
//      voicemail-greetings/u{userId}/{type}/...
//   3. We save the URL + filename on the User row and flip mode='audio'.
//
// The Call Control voicemail webhook (apps/webhooks/src/voicemailCallControl.ts)
// reads the active variant's URL/text/mode on each inbound voicemail-bound
// call and plays the right greeting.

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
  // v0.10.100 - MediaRecorder output (in-app recording).
  'audio/webm',
]);

// v0.10.100 - Type-aware helpers map a 'noanswer' vs 'busy' request to
// the corresponding User-row columns.
type GreetingType = 'noanswer' | 'busy';

interface GreetingColumns {
  url: 'voicemailGreetingUrl' | 'voicemailBusyGreetingUrl';
  filename: 'voicemailGreetingFilename' | 'voicemailBusyGreetingFilename';
  text: 'voicemailGreetingText' | 'voicemailBusyGreetingText';
  mode: 'voicemailGreetingMode' | 'voicemailBusyGreetingMode';
}

const NOANSWER_COLS: GreetingColumns = {
  url: 'voicemailGreetingUrl',
  filename: 'voicemailGreetingFilename',
  text: 'voicemailGreetingText',
  mode: 'voicemailGreetingMode',
};
const BUSY_COLS: GreetingColumns = {
  url: 'voicemailBusyGreetingUrl',
  filename: 'voicemailBusyGreetingFilename',
  text: 'voicemailBusyGreetingText',
  mode: 'voicemailBusyGreetingMode',
};
function colsFor(type: GreetingType): GreetingColumns {
  return type === 'busy' ? BUSY_COLS : NOANSWER_COLS;
}

const ALLOWED_TYPES = new Set<GreetingType>(['noanswer', 'busy']);

export async function voicemailGreetingRoutes(app: FastifyInstance) {
  app.get(
    '/voicemail-greeting',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const u = request.user as JwtPayload;
      const row = await prisma.user.findUnique({
        where: { id: u.sub },
        select: {
          voicemailGreetingUrl: true,
          voicemailGreetingFilename: true,
          voicemailGreetingText: true,
          voicemailGreetingMode: true,
          voicemailBusyGreetingUrl: true,
          voicemailBusyGreetingFilename: true,
          voicemailBusyGreetingText: true,
          voicemailBusyGreetingMode: true,
        },
      });
      return {
        url: row?.voicemailGreetingUrl ?? null,
        filename: row?.voicemailGreetingFilename ?? null,
        text: row?.voicemailGreetingText ?? null,
        mode: row?.voicemailGreetingMode ?? null,
        noanswer: {
          url: row?.voicemailGreetingUrl ?? null,
          filename: row?.voicemailGreetingFilename ?? null,
          text: row?.voicemailGreetingText ?? null,
          mode: row?.voicemailGreetingMode ?? null,
        },
        busy: {
          url: row?.voicemailBusyGreetingUrl ?? null,
          filename: row?.voicemailBusyGreetingFilename ?? null,
          text: row?.voicemailBusyGreetingText ?? null,
          mode: row?.voicemailBusyGreetingMode ?? null,
        },
      };
    },
  );

  app.put<{ Params: { type: string } }>(
    '/voicemail-greeting/:type/tts',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const type = request.params.type as GreetingType;
      if (!ALLOWED_TYPES.has(type)) {
        return reply.code(400).send({ error: 'Invalid type (use noanswer or busy)' });
      }
      const parsed = z.object({ text: z.string().trim().min(1).max(500) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const c = colsFor(type);
      const saved = await prisma.user.update({
        where: { id: u.sub },
        data: { [c.text]: parsed.data.text, [c.mode]: 'tts' },
        select: { [c.text]: true, [c.mode]: true },
      });
      return {
        text: (saved as unknown as Record<string, string | null>)[c.text],
        mode: (saved as unknown as Record<string, string | null>)[c.mode],
      };
    },
  );

  app.put<{ Params: { type: string } }>(
    '/voicemail-greeting/:type/mode',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const type = request.params.type as GreetingType;
      if (!ALLOWED_TYPES.has(type)) {
        return reply.code(400).send({ error: 'Invalid type (use noanswer or busy)' });
      }
      const parsed = z.object({ mode: z.enum(['audio', 'tts', 'default']) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid mode (audio, tts, or default)' });
      }
      const c = colsFor(type);
      const saved = await prisma.user.update({
        where: { id: u.sub },
        data: { [c.mode]: parsed.data.mode },
        select: { [c.mode]: true },
      });
      return { mode: (saved as unknown as Record<string, string | null>)[c.mode] };
    },
  );

  app.post<{ Params: { type: string } }>(
    '/voicemail-greeting/:type',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const type = request.params.type as GreetingType;
      if (!ALLOWED_TYPES.has(type)) {
        return reply.code(400).send({ error: 'Invalid type (use noanswer or busy)' });
      }
      const parsed = UploadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { filename, mimeType, dataBase64 } = parsed.data;
      const normalizedMime = mimeType.toLowerCase().split(';')[0].trim();
      if (!ALLOWED_MIMES.has(normalizedMime)) {
        return reply.code(400).send({
          error: `Unsupported audio type: ${mimeType}. Use MP3, WAV, M4A, AAC, OGG, or WebM.`,
        });
      }
      if (!config.supabaseUrl || !config.supabaseServiceKey) {
        return reply.code(500).send({ error: 'Supabase Storage not configured' });
      }

      const bytes = Buffer.from(dataBase64, 'base64');
      if (bytes.length > MAX_BYTES) {
        return reply.code(413).send({ error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB).` });
      }

      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const objectPath = `voicemail-greetings/u${u.sub}/${type}/${Date.now()}_${safeName}`;
      const uploadUrl = `${config.supabaseUrl}/storage/v1/object/${config.supabaseMediaBucket}/${objectPath}`;
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.supabaseServiceKey}`,
          'Content-Type': normalizedMime,
          'x-upsert': 'true',
        },
        body: bytes,
      });
      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => '');
        app.log.warn(
          { status: uploadRes.status, errText, type },
          '[vm-greeting] supabase upload failed',
        );
        return reply.code(502).send({ error: 'Storage upload failed', details: errText });
      }
      const publicUrl = `${config.supabaseUrl}/storage/v1/object/public/${config.supabaseMediaBucket}/${objectPath}`;

      const c = colsFor(type);
      const saved = await prisma.user.update({
        where: { id: u.sub },
        data: {
          [c.url]: publicUrl,
          [c.filename]: filename,
          [c.mode]: 'audio',
        },
        select: { [c.url]: true, [c.filename]: true, [c.mode]: true },
      });
      app.log.info({ userId: u.sub, url: publicUrl, type }, '[vm-greeting] saved');
      return {
        url: (saved as unknown as Record<string, string | null>)[c.url],
        filename: (saved as unknown as Record<string, string | null>)[c.filename],
        mode: (saved as unknown as Record<string, string | null>)[c.mode],
      };
    },
  );

  app.delete<{ Params: { type: string } }>(
    '/voicemail-greeting/:type',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const type = request.params.type as GreetingType;
      if (!ALLOWED_TYPES.has(type)) {
        return reply.code(400).send({ error: 'Invalid type (use noanswer or busy)' });
      }
      const user = await prisma.user.findUnique({ where: { id: u.sub } });
      if (!user) return reply.code(404).send({ error: 'User not found' });
      const c = colsFor(type);
      await prisma.user.update({
        where: { id: u.sub },
        data: { [c.url]: null, [c.filename]: null },
      });
      return { ok: true };
    },
  );

  // ------ Legacy v0.10.99 shim endpoints (alias to noanswer). ------
  app.put(
    '/voicemail-greeting/tts',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const parsed = z.object({ text: z.string().trim().min(1).max(500) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const saved = await prisma.user.update({
        where: { id: u.sub },
        data: { voicemailGreetingText: parsed.data.text, voicemailGreetingMode: 'tts' },
        select: { voicemailGreetingText: true, voicemailGreetingMode: true },
      });
      return { text: saved.voicemailGreetingText, mode: saved.voicemailGreetingMode };
    },
  );

  app.put(
    '/voicemail-greeting/mode',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const parsed = z.object({ mode: z.enum(['audio', 'tts', 'default']) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid mode (audio, tts, or default)' });
      }
      const saved = await prisma.user.update({
        where: { id: u.sub },
        data: { voicemailGreetingMode: parsed.data.mode },
        select: { voicemailGreetingMode: true },
      });
      return { mode: saved.voicemailGreetingMode };
    },
  );

  app.delete(
    '/voicemail-greeting',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const u = request.user as JwtPayload;
      const user = await prisma.user.findUnique({ where: { id: u.sub } });
      if (!user) return reply.code(404).send({ error: 'User not found' });
      await prisma.user.update({
        where: { id: u.sub },
        data: { voicemailGreetingUrl: null, voicemailGreetingFilename: null },
      });
      return { ok: true };
    },
  );
}