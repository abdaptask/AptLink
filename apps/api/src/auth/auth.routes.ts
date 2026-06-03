// Auth endpoints. Phase 1: login + me. Refresh tokens come in Phase 2.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@ace/db';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

export async function authRoutes(app: FastifyInstance) {
  // POST /auth/login
  app.post('/auth/login', async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Same generic message for missing/disabled/wrong-password/SSO-only users
    // so we don't leak which account state caused the rejection.
    // `passwordHash` is nullable on the schema — SSO-only users have NULL,
    // so local-password login must refuse rather than calling bcrypt.compare
    // on a null hash (which would throw).
    if (!user || !user.isActive || !user.passwordHash) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
    };
    const token = await reply.jwtSign(payload);

    return reply.send({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        isAdmin: user.isAdmin,
        // Per-user SIP creds so the dialer can register as THIS user with
        // Telnyx instead of using the build-time VITE_SIP_* env vars.
        // sipPassword is sensitive — only flow it over HTTPS and never log it.
        sipUsername: user.sipUsername,
        sipPassword: user.sipPassword,
        didNumber: user.didNumber,
      },
    });
  });

  // GET /auth/me — requires a valid JWT.
  app.get('/auth/me', { onRequest: [app.authenticate] }, async (request: FastifyRequest) => {
    const jwtUser = request.user as JwtPayload;
    const user = await prisma.user.findUnique({ where: { id: jwtUser.sub } });
    if (!user) return { error: 'User not found' };
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      isAdmin: user.isAdmin,
      sipUsername: user.sipUsername,
      sipPassword: user.sipPassword,
      didNumber: user.didNumber,
      // v0.10.60 — Beta flag for the Connection Health smoothing + webhook
      // recovery behavior. Client reads this on login and toggles its
      // disconnect-display debounce + socket.io reconnect listener.
      connectionHealthBeta: user.connectionHealthBeta,
      // v0.10.75 — Ringtone preference ('classic' / 'modern' / 'chime' /
      // 'pulse'). NULL means use the default.
      ringtone: user.ringtone,
    };
  });

  // PATCH /auth/me — let a user update their own profile fields. Multi-user
  // routing depends on didNumber + sipUsername being correct, so users can
  // self-serve from Settings → Account.
  const UpdateMeSchema = z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    sipUsername: z.string().optional(),
    sipPassword: z.string().optional(),
    didNumber: z.string().optional(),
    // v0.10.75 — Ringtone preference. Accept any of the bundled slugs; we
    // don't validate against the exact union here so future presets added
    // on the client don't require an API redeploy. Client UI restricts to
    // the valid set.
    ringtone: z.string().max(32).nullable().optional(),
  });
  app.patch('/auth/me', { onRequest: [app.authenticate] }, async (request: FastifyRequest, reply) => {
    const jwtUser = request.user as JwtPayload;
    const parsed = UpdateMeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const updates: Record<string, string | null> = {};
    const b = parsed.data;
    if (b.firstName !== undefined)   updates.firstName = b.firstName || null;
    if (b.lastName !== undefined)    updates.lastName = b.lastName || null;
    if (b.sipUsername !== undefined) updates.sipUsername = b.sipUsername || null;
    if (b.sipPassword !== undefined) updates.sipPassword = b.sipPassword || null;
    if (b.didNumber !== undefined) {
      // Normalize to E.164 — strips whitespace/dashes, adds +1 if it looks like US.
      const cleaned = b.didNumber.replace(/[^\d+]/g, '');
      updates.didNumber = cleaned
        ? cleaned.startsWith('+')
          ? cleaned
          : cleaned.length === 11 && cleaned.startsWith('1')
            ? `+${cleaned}`
            : cleaned.length === 10
              ? `+1${cleaned}`
              : `+${cleaned}`
        : null;
    }
    // v0.10.75 — Ringtone slug pass-through.
    if (b.ringtone !== undefined) updates.ringtone = b.ringtone || null;

    try {
      const updated = await prisma.user.update({
        where: { id: jwtUser.sub },
        data: updates,
      });
      return {
        id: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
        isAdmin: updated.isAdmin,
        sipUsername: updated.sipUsername,
        didNumber: updated.didNumber,
      };
    } catch (e) {
      // Unique constraint violations on sipUsername / didNumber.
      const msg = e instanceof Error ? e.message : 'update failed';
      if (/unique/i.test(msg)) {
        return reply.code(409).send({
          error: 'A SIP username or DID number is already in use by another account.',
        });
      }
      return reply.code(500).send({ error: msg });
    }
  });
}
