// v0.10.34 — Pulse MySQL backfill for migration history.
//
// When migrating a user from Pulse to ACE, we want their last 30 days
// of SMS + call history populated. Telnyx's async report API handles
// the part Telnyx has, but some Pulse setups route SMS through other
// channels (Twilio shared sender, etc.) and store the history only in
// Pulse's own DB. This module reads from Pulse's MySQL when the
// PULSE_DB_* env vars are configured.
//
// Env vars (all required to activate):
//   PULSE_DB_HOST       — e.g. "pulse-prod-mysql.aptask.com"
//   PULSE_DB_PORT       — typically 3306
//   PULSE_DB_USER       — read-only credentials recommended
//   PULSE_DB_PASS
//   PULSE_DB_NAME       — e.g. "pulse_production"
//
// When env vars are missing, all functions return [] silently — safe
// to deploy this code before credentials are populated. Once env vars
// are set on Render, the next migration triggers a Pulse query
// automatically.

import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;
let initFailed = false;

function getPool(): mysql.Pool | null {
  if (initFailed) return null;
  if (pool) return pool;
  const host = (process.env.PULSE_DB_HOST ?? '').trim();
  const user = (process.env.PULSE_DB_USER ?? '').trim();
  const password = (process.env.PULSE_DB_PASS ?? '').trim();
  const database = (process.env.PULSE_DB_NAME ?? '').trim();
  if (!host || !user || !password || !database) {
    return null;
  }
  const port = parseInt((process.env.PULSE_DB_PORT ?? '3306').trim(), 10);
  try {
    pool = mysql.createPool({
      host, port, user, password, database,
      waitForConnections: true,
      connectionLimit: 5,
      // Connect timeout: don't hang the migration forever if Pulse
      // is unreachable. Backfill is best-effort.
      connectTimeout: 10_000,
      // Idle connections close after 30s — Pulse DB doesn't need to
      // keep our pool alive while we're not migrating.
      idleTimeout: 30_000,
    });
    return pool;
  } catch (e) {
    console.error('[pulseBackfill] failed to create MySQL pool', e);
    initFailed = true;
    return null;
  }
}

/**
 * Look up a Pulse user_id by email. Returns null if not found OR if
 * env vars aren't configured.
 */
export async function findPulseUserIdByEmail(email: string): Promise<number | null> {
  const p = getPool();
  if (!p) return null;
  try {
    // Pulse uses a `users` table with email column. (Confirmed via
    // schema inspection of pulse-master/Server/V3/prisma/schema.prisma.)
    const [rows] = await p.query<mysql.RowDataPacket[]>(
      'SELECT user_id FROM users WHERE email = ? LIMIT 1',
      [email],
    );
    if (rows.length === 0) return null;
    const id = rows[0].user_id;
    return typeof id === 'number' ? id : Number(id);
  } catch (e) {
    console.error('[pulseBackfill] findPulseUserIdByEmail failed', { email, error: e });
    return null;
  }
}

// ─── SMS backfill from Pulse `messages` table ────────────────────────────

export interface PulseMessageRow {
  id: number;
  sms_id: string | null;
  message: string;
  message_type: string | null;
  media: string | null;
  status: string | null;
  from_user_id: number;
  to_user_id: number;
  from_type: string | null;   // 'c' = chat_user (external), 'r' = recruiter (Pulse user)
  to_type: string | null;
  created_at: Date;
  contact_phone: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
}

/**
 * Pull a user's SMS history from Pulse for the last N days. Returns []
 * if env vars missing OR query fails (best-effort).
 *
 * The Pulse `messages` table uses internal Pulse user IDs for from/to,
 * not phone numbers. The phone number of the external party (the
 * contact) lives in `chat_user.mobile_no`. We JOIN to get it.
 */
export async function getPulseMessagesForUser(args: {
  pulseUserId: number;
  daysBack: number;
}): Promise<PulseMessageRow[]> {
  const p = getPool();
  if (!p) return [];
  try {
    const [rows] = await p.query<mysql.RowDataPacket[]>(
      `SELECT
         m.id, m.sms_id, m.message, m.message_type, m.media, m.status,
         m.from_user_id, m.to_user_id, m.from_type, m.to_type, m.created_at,
         cu.mobile_no AS contact_phone,
         cu.first_name AS contact_first_name,
         cu.last_name AS contact_last_name
       FROM messages m
       LEFT JOIN chat_user cu
         ON cu.id = (CASE WHEN m.from_type = 'c' THEN m.from_user_id ELSE m.to_user_id END)
       WHERE m.message_type = 'sms'
         AND (m.from_user_id = ? OR m.to_user_id = ?)
         AND m.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY m.created_at ASC`,
      [args.pulseUserId, args.pulseUserId, args.daysBack],
    );
    return rows as unknown as PulseMessageRow[];
  } catch (e) {
    console.error('[pulseBackfill] getPulseMessagesForUser failed', { args, error: e });
    return [];
  }
}

// ─── Call history backfill from Pulse `twilio_call_logs` table ──────────

export interface PulseCallRow {
  id: number;
  user_id: number | null;
  chat_user_id: number | null;
  first_name: string | null;
  last_name: string | null;
  from: bigint | string | null;
  to: bigint | string | null;
  direction: string | null;
  endReason: string | null;
  status: string | null;
  duration: number | null;
  createdAt: Date;
  sid: string | null;
  call_session_id: string | null;
  call_type: string | null;
  recording_url: string | null;
  recording_duration: number | null;
  start_time: Date | null;
  end_time: Date | null;
  is_recording_read: number | null;
  is_recording: number | boolean | null;
  answer_time: Date | null;
  voicemail_url: string | null;
}

/**
 * Pull a user's call history from Pulse for the last N days.
 * twilio_call_logs is misleadingly named — it stores all call data
 * regardless of carrier (Telnyx, Twilio, etc).
 */
export async function getPulseCallsForUser(args: {
  pulseUserId: number;
  daysBack: number;
}): Promise<PulseCallRow[]> {
  const p = getPool();
  if (!p) return [];
  try {
    const [rows] = await p.query<mysql.RowDataPacket[]>(
      `SELECT
         id, user_id, chat_user_id, first_name, last_name,
         CAST(\`from\` AS CHAR) AS \`from\`,
         CAST(\`to\` AS CHAR) AS \`to\`,
         direction, endReason, status, duration, createdAt,
         sid, call_session_id, call_type, recording_url,
         recording_duration, start_time, end_time,
         is_recording_read, is_recording, answer_time, voicemail_url
       FROM twilio_call_logs
       WHERE user_id = ?
         AND createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY createdAt ASC`,
      [args.pulseUserId, args.daysBack],
    );
    return rows as unknown as PulseCallRow[];
  } catch (e) {
    console.error('[pulseBackfill] getPulseCallsForUser failed', { args, error: e });
    return [];
  }
}

/**
 * Diagnostic — search Pulse users by email substring (case-insensitive).
 * Returns up to 20 matches. Useful when the user's email in ACE doesn't
 * match what's in Pulse (different domain, casing, etc.). Lets admins
 * find the right pulseUserId without needing a MySQL client.
 */
export async function searchPulseUsers(query: string): Promise<Array<{
  user_id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}>> {
  const p = getPool();
  if (!p) return [];
  try {
    const [rows] = await p.query<mysql.RowDataPacket[]>(
      `SELECT user_id, email, first_name, last_name
       FROM users
       WHERE email LIKE ?
          OR first_name LIKE ?
          OR last_name LIKE ?
       ORDER BY user_id DESC
       LIMIT 20`,
      [`%${query}%`, `%${query}%`, `%${query}%`],
    );
    return rows as unknown as Array<{
      user_id: number;
      email: string | null;
      first_name: string | null;
      last_name: string | null;
    }>;
  } catch (e) {
    console.error('[pulseBackfill] searchPulseUsers failed', { query, error: e });
    return [];
  }
}

/** Cleanup — call this if the API server shuts down gracefully. */
export async function closePulsePool(): Promise<void> {
  if (pool) {
    try { await pool.end(); } catch { /* noop */ }
    pool = null;
  }
}
