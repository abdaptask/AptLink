// v0.10.22 — Phase 2 of the "Migrate Existing User to New Dialer" flow.
//
// After a DID is re-bound to the user's ACE connection in Telnyx, this
// function pulls the last 30 days of call + SMS history from Telnyx for
// that number and inserts it into ACE's Call + Message tables. The user
// opens Recents / Messages and sees their history reconstructed.
//
// Design:
//   - Fire-and-forget from the migrate endpoint (Promise<void>, never throws).
//   - Best-effort: if Telnyx's detail-records API isn't available on the
//     account tier, we log + bail. We don't fail the migration.
//   - Dedupe via the unique constraints on Call.telnyxCallId and
//     Message.telnyxMessageId — Prisma's createMany({ skipDuplicates: true })
//     handles overlap with rows already in the table (e.g. if the user had
//     this number partly working via ACE before formally migrating).
//   - Voicemails NOT included — Pulse-side voicemails are in Pulse's DB,
//     not Telnyx. Telnyx may have call recordings but not voicemail audio
//     specifically; out of scope for this phase.
//
// Why fire-and-forget vs synchronous?
//   - 30 days of CDRs for a busy number can be 500-2000+ records.
//   - Telnyx's paginated fetch + insert can take 10-30+ seconds.
//   - Blocking the migration HTTP response on that gives admins a bad UX:
//     they'd see a spinner that looks broken. Better to return immediately
//     and let the backfill stream rows in during the next minute.

import { prisma } from '@ace/db';
import * as telnyx from '../telnyx/numbers.js';

interface BackfillResult {
  callsInserted: number;
  callsSkipped: number;
  messagesInserted: number;
  messagesSkipped: number;
  errors: string[];
}

type LogFn = (obj: Record<string, unknown>, msg: string) => void;
const noopLog: LogFn = () => undefined;

/**
 * Pull 30d of voice + SMS history for `didNumber` from Telnyx and insert
 * into ACE's Call + Message tables. Fire-and-forget — never throws.
 */
export async function backfillMigratedDidHistory(
  args: {
    userId: number;
    userDidId: number;
    didNumber: string;          // E.164
    daysBack?: number;          // default 30
  },
  log: LogFn = noopLog,
): Promise<BackfillResult> {
  const daysBack = args.daysBack ?? 30;
  const result: BackfillResult = {
    callsInserted: 0,
    callsSkipped: 0,
    messagesInserted: 0,
    messagesSkipped: 0,
    errors: [],
  };

  log({ ...args }, '[backfill] start');

  // ─── Voice CDRs ────────────────────────────────────────────────────────
  try {
    const cdrs = await telnyx.listVoiceCdrsForNumber(args.didNumber, daysBack);
    log({ count: cdrs.length, didNumber: args.didNumber }, '[backfill] voice fetched');

    if (cdrs.length > 0) {
      const rows = cdrs
        .map((c) => mapVoiceCdrToCallRow(c, args.userId, args.userDidId))
        .filter((r): r is NonNullable<typeof r> => r !== null);

      // createMany with skipDuplicates: dedup by Call.telnyxCallId unique.
      const before = result.callsInserted;
      try {
        const inserted = await prisma.call.createMany({
          data: rows,
          skipDuplicates: true,
        });
        result.callsInserted += inserted.count;
        result.callsSkipped += rows.length - inserted.count;
      } catch (e) {
        result.errors.push(`call createMany: ${e instanceof Error ? e.message : String(e)}`);
      }
      log(
        { inserted: result.callsInserted - before, total: rows.length },
        '[backfill] voice inserted',
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`voice fetch: ${msg}`);
    log({ err: msg }, '[backfill] voice failed');
  }

  // ─── SMS MDRs ──────────────────────────────────────────────────────────
  try {
    const mdrs = await telnyx.listSmsForNumber(args.didNumber, daysBack);
    log({ count: mdrs.length, didNumber: args.didNumber }, '[backfill] sms fetched');

    if (mdrs.length > 0) {
      const rows = mdrs
        .map((m) => mapSmsMdrToMessageRow(m, args.userId, args.userDidId, args.didNumber))
        .filter((r): r is NonNullable<typeof r> => r !== null);

      const before = result.messagesInserted;
      try {
        const inserted = await prisma.message.createMany({
          data: rows,
          skipDuplicates: true,
        });
        result.messagesInserted += inserted.count;
        result.messagesSkipped += rows.length - inserted.count;
      } catch (e) {
        result.errors.push(`message createMany: ${e instanceof Error ? e.message : String(e)}`);
      }
      log(
        { inserted: result.messagesInserted - before, total: rows.length },
        '[backfill] sms inserted',
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`sms fetch: ${msg}`);
    log({ err: msg }, '[backfill] sms failed');
  }

  log({ result }, '[backfill] done');
  return result;
}

// ─── Mappers ────────────────────────────────────────────────────────────

function mapVoiceCdrToCallRow(
  c: telnyx.TelnyxVoiceCdr,
  userId: number,
  userDidId: number,
) {
  const telnyxCallId = c.id ?? c.call_id;
  if (!telnyxCallId || !c.from || !c.to || !c.started_at) return null;

  const durationSec = typeof c.duration === 'string'
    ? parseInt(c.duration, 10) || 0
    : (c.duration ?? 0);

  // Map Telnyx direction to our schema. Telnyx uses "inbound" / "outbound";
  // our schema uses the same strings.
  const direction = c.direction === 'inbound' ? 'inbound' : 'outbound';

  // Status: completed if answered + had duration; missed if inbound w/ 0 dur.
  let status: string;
  if (durationSec > 0) status = 'completed';
  else if (direction === 'inbound') status = 'missed';
  else status = 'failed';

  // Override with Telnyx's hangup_cause when available
  if (c.status) status = c.status;

  return {
    userId,
    telnyxCallId,
    direction,
    fromNumber: c.from,
    toNumber: c.to,
    status,
    startedAt: new Date(c.started_at),
    answeredAt: c.answered_at ? new Date(c.answered_at) : null,
    endedAt: c.ended_at ? new Date(c.ended_at) : null,
    durationSeconds: durationSec,
    hangupCause: c.hangup_cause ?? null,
    hangupSource: c.hangup_source ?? null,
    recordingUrl: c.recording_url ?? null,
    userDidId,
  };
}

function mapSmsMdrToMessageRow(
  m: telnyx.TelnyxSmsMdr,
  userId: number,
  userDidId: number,
  ourDidE164: string,
) {
  if (!m.id) return null;

  // Extract `from` phone number (Telnyx returns either string or object).
  const fromNumber = typeof m.from === 'string'
    ? m.from
    : m.from?.phone_number ?? '';
  // Extract `to` — first recipient only (Telnyx returns array).
  const toRaw = m.to;
  const toNumber = typeof toRaw === 'string'
    ? toRaw
    : Array.isArray(toRaw)
      ? toRaw[0]?.phone_number ?? ''
      : '';
  if (!fromNumber || !toNumber) return null;

  // Direction: outbound if WE sent it (from is our DID).
  // Telnyx sometimes returns "outbound-api" / "outbound" / "inbound" —
  // normalize against our DID instead of trusting Telnyx's string.
  const last10 = (s: string) => s.replace(/\D/g, '').slice(-10);
  const ourLast10 = last10(ourDidE164);
  const direction = last10(fromNumber) === ourLast10 ? 'outbound' : 'inbound';

  // threadKey = the OTHER party's number (regardless of direction).
  const threadKey = direction === 'outbound' ? toNumber : fromNumber;

  // Status mapping. Telnyx values we've seen: 'delivered', 'sent',
  // 'failed', 'received'. Our schema uses queued | sent | delivered | failed | received.
  const statusRaw = (m.status ?? '').toLowerCase();
  const status = ['queued', 'sent', 'delivered', 'failed', 'received'].includes(statusRaw)
    ? statusRaw
    : direction === 'inbound' ? 'received' : 'delivered';

  // Timestamp: prefer sent_at, fall back to received_at.
  const tsStr = m.sent_at ?? m.received_at;
  const sentAt = tsStr ? new Date(tsStr) : null;
  const deliveredAt = status === 'delivered' && tsStr ? new Date(tsStr) : null;

  return {
    userId,
    telnyxMessageId: m.id,
    threadKey,
    direction,
    fromNumber,
    toNumber,
    body: m.text ?? '',
    mediaUrls: m.media_urls ?? [],
    status,
    sentAt,
    deliveredAt,
    userDidId,
  };
}
