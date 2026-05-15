// Call history endpoints. Phase 5.1 — outbound history; inbound lands in 5.2.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '@ace/db';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

export async function callsRoutes(app: FastifyInstance) {
  app.get('/calls', { onRequest: [app.authenticate] }, async (request: FastifyRequest) => {
    const user = request.user as JwtPayload;
    const calls = await prisma.call.findMany({
      where: { userId: user.sub },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    return calls;
  });

  app.get('/calls/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const { id } = request.params as { id: string };
    const call = await prisma.call.findFirst({
      where: { id: Number(id), userId: user.sub },
    });
    if (!call) return reply.code(404).send({ error: 'Not found' });
    return call;
  });
}
