// ACE Dialer API — HTTP service.
// Phase 1: /health, /, /auth/login, /auth/me.
// Phase 5.1: /calls, /calls/:id.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './config.js';
import { authRoutes } from './auth/auth.routes.js';
import { callsRoutes } from './calls/calls.routes.js';

const SERVICE_NAME = 'ace-dialer-api';
const START_TIME = new Date().toISOString();

const app = Fastify({
  logger: { level: config.logLevel },
});

await app.register(cors, {
  origin:
    config.allowedOrigins.length === 1 && config.allowedOrigins[0] === '*'
      ? true
      : config.allowedOrigins,
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
  version: '0.3.0',
}));

app.get('/health', async () => ({
  status: 'ok',
  service: SERVICE_NAME,
  uptimeSeconds: Math.floor(process.uptime()),
  startedAt: START_TIME,
  timestamp: new Date().toISOString(),
}));

await app.register(authRoutes);
await app.register(callsRoutes);

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
