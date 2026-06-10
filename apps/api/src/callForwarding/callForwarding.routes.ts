// Call Forwarding — GET + PUT the current user's forwarding settings.
// Persists to the User row AND provisions Telnyx so the carrier actually
// honors the forwarding when calls land on the DID. Pattern mirrors Pulse's
// "Call Forwarding" feature (Settings → Call Forwarding panel).
//
// Telnyx API used:
//   PATCH https://api.telnyx.com/v2/phone_numbers/{id}/voice
//   { "call_forwarding": {
//       "call_forwarding_enabled": true|false,
//       "forwards_to": "+E164",
//       "forwarding_type": "always" | "on_failure"
//     } }
//
// Modes:
//   - "always"     — every inbound call goes straight to the forward number.
//   - "on_failure" — only on no-answer / busy / unreachable.
//   - off          — the DID rings normally (voicemail still applies on no-answer).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@ace/db';
import { config } from '../config.js';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

const SaveSchema = z.object({
  enabled: z.boolean(),
  // E.164 — required only when `enabled` is true.
  number: z.string().optional().nullable(),
  mode: z.enum(['always', 'on_failure']).optional().nullable(),
});

function e164(raw: string | null | undefined): string {
  const cleaned = (raw ?? '').replace(/[^\d+]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  return `+${cleaned}`;
}

// Find the Telnyx-side phone_number_id for a DID we own. Cached on the
// UserDid row after the first lookup. If not yet stored, query Telnyx, find
// the matching number, persist the id.
async function resolveTelnyxNumberId(
  userId: number,
  didNumber: string,
): Promise<string | null> {
  const didRow = await prisma.userDid.findFirst({
    where: { userId, didNumber },
  });
  if (didRow?.telnyxNumberId) return didRow.telnyxNumberId;
  if (!config.telnyxApiKey) return null;
  // Telnyx supports a filter[phone_number] query param.
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
  if (didRow) {
    await prisma.userDid.update({
      where: { id: didRow.id },
      data: { telnyxNumberId: match.id },
    });
  }
  return match.id;
}

// PATCH the voice settings on this DID to enable/disable call forwarding.
async function applyForwardingToTelnyx(
  numberId: string,
  opts: { enabled: boolean; forwardsTo: string; mode: 'always' | 'on_failure' },
): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!config.telnyxApiKey) {
    return { ok: false, status: 0, body: 'TELNYX_API_KEY not set on API' };
  }
  const url = `https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(numberId)}/voice`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.telnyxApiKey}`,
    },
    body: JSON.stringify({
      call_forwarding: {
        call_forwarding_enabled: opts.enabled,
        forwards_to: opts.enabled ? opts.forwardsTo : '',
        forwarding_type: opts.enabled ? opts.mode : 'always',
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export async function callForwardingRoutes(app: FastifyInstance) {
  app.get(
    '/auth/call-forwarding',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const u = request.user as JwtPayload;
      const row = await prisma.user.findUnique({
        where: { id: u.sub },
        select: {
          forwardingEnabled: true,
          forwardingNumber: true,
          forwardingMode: true,
        },
      });
      return {
        enabled: row?.forwardingEnabled ?? false,
        number: row?.forwardingNumber ?? null,
        mode: row?.forwardingMode ?? 'on_failure',
      };
    },
  );

  app.put(
    '/auth/call-forwarding',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      const u = request.user as JwtPayload;
      const parsed = SaveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { enabled } = parsed.data;
      const number = enabled ? e164(parsed.data.number ?? '') : '';
      const mode = (parsed.data.mode ?? 'on_failure') as 'always' | 'on_failure';

      if (enabled && !number) {
        return reply
          .code(400)
          .send({ error: 'Forwarding number required when enabling.' });
      }

      // Need the user's default DID to find the Telnyx number id.
      const defaultDid = await prisma.userDid.findFirst({
        where: { userId: u.sub, isDefault: true },
      });
      if (!defaultDid?.didNumber) {
        return reply
          .code(400)
          .send({ error: 'Your account has no default DID assigned yet. Add a phone number first.' });
      }

      const telnyxNumberId = await resolveTelnyxNumberId(u.sub, defaultDid.didNumber);
      if (!telnyxNumberId) {
        return reply.code(502).send({
          error: 'Could not look up Telnyx phone number id. Check TELNYX_API_KEY + that the DID is on this account.',
        });
      }

      // Provision Telnyx side first — if Telnyx refuses, don't persist a
      // setting the carrier won't actually honor.
      const telnyx = await applyForwardingToTelnyx(telnyxNumberId, {
        enabled,
        forwardsTo: number,
        mode,
      });
      if (!telnyx.ok) {
        app.log.warn({ telnyx }, '[forwarding] Telnyx PATCH failed');
        return reply.code(502).send({
          error: 'Telnyx rejected the call-forwarding update',
          telnyxStatus: telnyx.status,
          telnyxBody: telnyx.body,
        });
      }

      // Persist in our DB.
      const saved = await prisma.user.update({
        where: { id: u.sub },
        data: {
          forwardingEnabled: enabled,
          forwardingNumber: enabled ? number : null,
          forwardingMode: enabled ? mode : null,
        },
        select: {
          forwardingEnabled: true,
          forwardingNumber: true,
          forwardingMode: true,
        },
      });
      app.log.info(
        { userId: u.sub, enabled, number, mode },
        '[forwarding] saved',
      );
      return {
        enabled: saved.forwardingEnabled,
        number: saved.forwardingNumber,
        mode: saved.forwardingMode,
      };
    },
  );
}
