// ACE Dialer API — HTTP service.
// Phase 1: /health, /, /auth/login, /auth/me.
// Phase 5.1: /calls, /calls/:id.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './config.js';
import { authRoutes } from './auth/auth.routes.js';
import { microsoftAuthRoutes } from './auth/microsoft.routes.js';
import { blockedRoutes } from './blocked/blocked.routes.js';
import { callForwardingRoutes } from './callForwarding/callForwarding.routes.js';
import { callsRoutes } from './calls/calls.routes.js';
import { favoritesRoutes } from './favorites/favorites.routes.js';
import { internalChatRoutes } from './internalChat/internalChat.routes.js';
import { messagesRoutes } from './messages/messages.routes.js';
import { voicemailsRoutes } from './voicemails/voicemails.routes.js';
import { voicemailGreetingRoutes } from './voicemailGreeting/voicemailGreeting.routes.js';
import { jobDivaRoutes } from './jobdiva/jobdiva.routes.js';
import { contactsRoutes } from './contacts/contacts.routes.js';

const SERVICE_NAME = 'ace-dialer-api';
const START_TIME = new Date().toISOString();

const app = Fastify({
  logger: { level: config.logLevel },
  // 16 MB body limit so base64-encoded MMS uploads fit (max 10 MB payload).
  bodyLimit: 16 * 1024 * 1024,
});

await app.register(cors, {
  // Reflect the request's Origin header instead of using wildcard `true`.
  // Required because: (a) CORS spec forbids combining `*` with credentials,
  // and (b) Electron pages load from file:// which sends Origin: null —
  // those would be rejected by a strict allowlist. We reflect any origin
  // because JWT auth means we don't need a cross-origin allowlist for
  // session-cookie protection. When ALLOWED_ORIGINS is set (e.g. in prod
  // hardening) we restrict to that allowlist.
  origin: (origin, cb) => {
    if (config.allowedOrigins.length === 1 && config.allowedOrigins[0] === '*') {
      cb(null, true);
      return;
    }
    if (!origin || config.allowedOrigins.includes(origin)) {
      cb(null, true);
      return;
    }
    cb(null, false);
  },
  credentials: true,
});

await app.register(jwt, {
  secret: config.jwtSecret,
  sign: { expiresIn: config.jwtExpiresIn },
});

app.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Unauthorised' });
  }
});

app.get('/', async () => ({
  service: SERVICE_NAME,
  status: 'ok',
  version: '0.6.1',
  // Feature flags — boolean only, no values leaked. Lets a developer verify
  // env vars are loaded without exposing secrets.
  features: {
    telnyxApiKey: Boolean(config.telnyxApiKey),
    telnyxMessagingProfileId: Boolean(config.telnyxMessagingProfileId),
    telnyxCcConnectionId: Boolean(config.telnyxCcConnectionId),
  },
}));

app.get('/health', async () => ({
  status: 'ok',
  service: SERVICE_NAME,
  uptimeSeconds: Math.floor(process.uptime()),
  startedAt: START_TIME,
  timestamp: new Date().toISOString(),
}));

await app.register(authRoutes);
await app.register(microsoftAuthRoutes);
await app.register(blockedRoutes);
await app.register(callForwardingRoutes);
await app.register(callsRoutes);
await app.register(favoritesRoutes);
await app.register(internalChatRoutes);
await app.register(messagesRoutes);
await app.register(voicemailsRoutes);
await app.register(voicemailGreetingRoutes);
await app.register(jobDivaRoutes);
await app.register(contactsRoutes);

const host = '0.0.0.0';
try {
  await app.listen({ port: config.port, host });
  app.log.info({ port: config.port, host }, `[${SERVICE_NAME}] listening`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, `[${SERVICE_NAME}] shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));