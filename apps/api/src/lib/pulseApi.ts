// v0.10.36 — Pulse REST API client for migration backfill.
//
// Talks to Pulse's public REST API at https://pulse.aptask.com/api/2.0/...
// using the same JWT auth the existing Pulse front-end uses.
//
// Auth model:
//   - Calls are fetched with a PER-USER JWT (obtained by logging in as
//     that user with their Pulse password at migrate time) because
//     /telnyx/getCallLogs is scoped to the JWT's own user_id and has no
//     admin override.
//   - SMS bodies are NOT served by any REST endpoint a regular user JWT
//     can reach (verified live 2026-05-29 for user_id=55):
//       * /messages/getAllChatByUser returns conversation envelopes with
//         `dialog: []` hardcoded (populate-loop is commented out in
//         pulse-master Server/services/messageService.js).
//       * /messages/<conv_id> returns 401 Unauthorized in production.
//     So SMS continues to come from the MySQL path in pulseBackfill.ts.
//
// Env vars:
//   PULSE_API_BASE_URL  — e.g. "https://pulse.aptask.com/api/2.0"
//                         (no trailing slash). When unset, all functions
//                         no-op silently — safe to ship dormant.
//
// Pulse's JWT scheme is `Authorization: JWT <token>` — NOT `Bearer`.
// (Verified in pulse-master/Server/api/middleware/auth.js — passportJWT
//  ExtractJwt.fromAuthHeaderWithScheme('JWT').)

import { request } from 'node:https';
import { URL } from 'node:url';

// ─── Response types ─────────────────────────────────────────────────────

export interface PulseRestCallRow {
  id: number;
  sid: string | null;
  // Pulse production returns "incoming" / "outgoing" (not "inbound"/"outbound").
  // Verified live for user_id=55 on 2026-05-29.
  direction: string | null;
  // Pulse stores phone numbers as raw integers (no leading +, e.g. 17327344818).
  // Accept number | string and normalize in the caller.
  from: string | number | null;
  to: string | number | null;
  status: string | null;
  duration: number | null;
  createdAt: string;
  updatedAt: string | null;
  chat_user_id: number | null;
  first_name: string | null;
  last_name: string | null;
  recording_url_conferrence?: string | null;
  recording_conferrence_duration?: number | null;
}

// ─── HTTP helper ────────────────────────────────────────────────────────

function getBaseUrl(): string | null {
  const raw = (process.env.PULSE_API_BASE_URL ?? '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

interface PulseHttpResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

async function pulseGet<T = unknown>(
  path: string,
  jwt: string,
  timeoutMs = 20_000,
): Promise<PulseHttpResult<T>> {
  const base = getBaseUrl();
  if (!base) return { ok: false, status: 0, data: null, error: 'PULSE_API_BASE_URL unset' };
  const url = new URL(base + path);
  return new Promise((resolve) => {
    const req = request(
      {
        method: 'GET',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          Authorization: `JWT ${jwt}`,
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          let parsed: unknown = null;
          try { parsed = JSON.parse(body); } catch { /* leave null */ }
          if (status >= 200 && status < 300) {
            resolve({ ok: true, status, data: parsed as T });
          } else {
            resolve({ ok: false, status, data: null, error: body.slice(0, 500) });
          }
        });
      },
    );
    req.on('error', (err) => resolve({ ok: false, status: 0, data: null, error: err.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Pulse GET ${path} timed out`));
    });
    req.end();
  });
}

async function pulsePost<T = unknown>(
  path: string,
  body: unknown,
  timeoutMs = 20_000,
): Promise<PulseHttpResult<T>> {
  const base = getBaseUrl();
  if (!base) return { ok: false, status: 0, data: null, error: 'PULSE_API_BASE_URL unset' };
  const url = new URL(base + path);
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  return new Promise((resolve) => {
    const req = request(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          let parsed: unknown = null;
          try { parsed = JSON.parse(txt); } catch { /* leave null */ }
          if (status >= 200 && status < 300) {
            resolve({ ok: true, status, data: parsed as T });
          } else {
            resolve({ ok: false, status, data: null, error: txt.slice(0, 500) });
          }
        });
      },
    );
    req.on('error', (err) => resolve({ ok: false, status: 0, data: null, error: err.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Pulse POST ${path} timed out`));
    });
    req.write(payload);
    req.end();
  });
}

// ─── Login ──────────────────────────────────────────────────────────────

/**
 * Log in to Pulse with email + password. Returns the JWT on success.
 * Body: { email, password }. The token field name varies between Pulse
 * versions ("token", "jwt", or nested under "data"); we try all.
 * Returns null on any failure.
 */
export async function loginToPulse(email: string, password: string): Promise<string | null> {
  if (!email || !password) return null;
  const res = await pulsePost<Record<string, unknown>>('/login', { email, password });
  if (!res.ok || !res.data) return null;
  const d = res.data as Record<string, unknown>;
  const candidates: unknown[] = [
    d.token,
    d.jwt,
    (d.data as Record<string, unknown> | undefined)?.token,
    (d.data as Record<string, unknown> | undefined)?.jwt,
    (d.data as Record<string, unknown> | undefined)?.access_token,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 20) return c;
  }
  return null;
}

// ─── JWT payload decode ─────────────────────────────────────────────────
//
// Pulse signs its own JWTs; we decode the payload only (no signature
// verify — we're trusting the token we just received from Pulse's own
// login response). Schema from pulse-master Server/services/userService.js
// userLogin().

export interface PulseJwtPayload {
  id: number;
  email: string;
  first_name?: string;
  last_name?: string;
  mobile_no?: string;
  voip_number?: string;
  caller_phone_number?: string;
  personal_email?: string;
  ext?: string;
  bot_id?: number;
  tenent_id?: number;
}

export function decodePulseJwt(jwt: string): PulseJwtPayload | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (typeof obj.id !== 'number' || typeof obj.email !== 'string') return null;
    return {
      id: obj.id,
      email: obj.email,
      first_name: typeof obj.first_name === 'string' ? obj.first_name : undefined,
      last_name: typeof obj.last_name === 'string' ? obj.last_name : undefined,
      mobile_no: typeof obj.mobile_no === 'string' ? obj.mobile_no : undefined,
      voip_number: typeof obj.voip_number === 'string' ? obj.voip_number : undefined,
      caller_phone_number: typeof obj.caller_phone_number === 'string'
        ? obj.caller_phone_number : undefined,
      personal_email: typeof obj.personal_email === 'string' ? obj.personal_email : undefined,
      ext: typeof obj.ext === 'string' ? obj.ext : undefined,
      bot_id: typeof obj.bot_id === 'number' ? obj.bot_id : undefined,
      tenent_id: typeof obj.tenent_id === 'number' ? obj.tenent_id : undefined,
    };
  } catch {
    return null;
  }
}

// ─── Call logs ──────────────────────────────────────────────────────────

/**
 * Fetch the user's call history from Pulse, filtered to the last N days
 * client-side. Requires a JWT issued for the target user (Pulse's
 * /telnyx/getCallLogs is scoped to the JWT's own user_id).
 * Returns [] on any failure.
 */
export async function getCallLogsAsUser(args: {
  userJwt: string;
  daysBack: number;
}): Promise<PulseRestCallRow[]> {
  if (!args.userJwt) return [];
  const res = await pulseGet<unknown>('/telnyx/getCallLogs', args.userJwt);
  if (!res.ok || !res.data) return [];
  let rows: unknown[] = [];
  if (Array.isArray(res.data)) {
    rows = res.data;
  } else if (typeof res.data === 'object') {
    const d = res.data as Record<string, unknown>;
    if (Array.isArray(d.data)) rows = d.data as unknown[];
    else if (Array.isArray(d.rows)) rows = d.rows as unknown[];
  }

  const cutoff = Date.now() - args.daysBack * 86400_000;
  return rows
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r): PulseRestCallRow => ({
      id: Number(r.id ?? 0),
      sid: typeof r.sid === 'string' ? r.sid : null,
      direction: typeof r.direction === 'string' ? r.direction : null,
      from: (typeof r.from === 'string' || typeof r.from === 'number') ? r.from : null,
      to: (typeof r.to === 'string' || typeof r.to === 'number') ? r.to : null,
      status: typeof r.status === 'string' ? r.status : null,
      duration: typeof r.duration === 'number' ? r.duration
        : (typeof r.duration === 'string' ? parseInt(r.duration, 10) || 0 : 0),
      createdAt: String(r.createdAt ?? r.created_at ?? ''),
      updatedAt: r.updatedAt == null ? null : String(r.updatedAt),
      chat_user_id: typeof r.chat_user_id === 'number' ? r.chat_user_id : null,
      first_name: typeof r.first_name === 'string' ? r.first_name : null,
      last_name: typeof r.last_name === 'string' ? r.last_name : null,
      recording_url_conferrence: typeof r.recording_url_conferrence === 'string'
        ? r.recording_url_conferrence : null,
      recording_conferrence_duration: typeof r.recording_conferrence_duration === 'number'
        ? r.recording_conferrence_duration : null,
    }))
    .filter((r) => {
      if (!r.createdAt) return false;
      const t = new Date(r.createdAt).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
}
