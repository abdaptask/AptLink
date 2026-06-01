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
import {
  findPulseUserIdByEmail,
  getPulseMessagesForUser,
  getPulseCallsForUser,
  type PulseMessageRow,
  type PulseCallRow,
} from './pulseBackfill.js';

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

  const startTime = new Date(Date.now() - daysBack * 86400_000).toISOString();
  const endTime = new Date().toISOString();

  // ─── Voice CDRs via async Telnyx Reports API ──────────────────────────
  //
  // Sync /v2/detail_records doesn't support phone filtering — verified
  // empirically (it returned 0 even when CSV export had 61 rows for the
  // same number/window). The async usage-report API DOES support filtering
  // and is what powers Telnyx Portal's "Export CSV" button.
  try {
    const voiceCsv = await fetchCdrCsvViaReport(args.didNumber, startTime, endTime, log);
    if (voiceCsv) {
      const rows = parseCsvRows(voiceCsv);
      const callRows = rows
        .map((r) => mapTelnyxCsvRowToCall(r, args.userId, args.userDidId))
        .filter((r): r is NonNullable<typeof r> => r !== null);
      log({ count: callRows.length, didNumber: args.didNumber }, '[backfill] voice fetched');

      if (callRows.length > 0) {
        const before = result.callsInserted;
        try {
          const inserted = await prisma.call.createMany({
            data: callRows,
            skipDuplicates: true,
          });
          result.callsInserted += inserted.count;
          result.callsSkipped += callRows.length - inserted.count;
        } catch (e) {
          result.errors.push(`call createMany: ${e instanceof Error ? e.message : String(e)}`);
        }
        log(
          { inserted: result.callsInserted - before, total: callRows.length },
          '[backfill] voice inserted',
        );
      }
    } else {
      log({ didNumber: args.didNumber }, '[backfill] voice report unavailable — skipping');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`voice fetch: ${msg}`);
    log({ err: msg }, '[backfill] voice failed');
  }

  // ─── SMS MDRs via async Telnyx Reports API ────────────────────────────
  try {
    const smsCsv = await fetchMdrCsvViaReport(args.didNumber, startTime, endTime, log);
    if (smsCsv) {
      const rows = parseCsvRows(smsCsv);
      const msgRows = rows
        .map((r) => mapTelnyxCsvRowToMessage(r, args.userId, args.userDidId, args.didNumber))
        .filter((r): r is NonNullable<typeof r> => r !== null);
      log({ count: msgRows.length, didNumber: args.didNumber }, '[backfill] sms fetched');

      if (msgRows.length > 0) {
        const before = result.messagesInserted;
        try {
          const inserted = await prisma.message.createMany({
            data: msgRows,
            skipDuplicates: true,
          });
          result.messagesInserted += inserted.count;
          result.messagesSkipped += msgRows.length - inserted.count;
        } catch (e) {
          result.errors.push(`message createMany: ${e instanceof Error ? e.message : String(e)}`);
        }
        log(
          { inserted: result.messagesInserted - before, total: msgRows.length },
          '[backfill] sms inserted',
        );
      }
    } else {
      log({ didNumber: args.didNumber }, '[backfill] sms report unavailable — skipping');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`sms fetch: ${msg}`);
    log({ err: msg }, '[backfill] sms failed');
  }

  // ─── Pulse DB backfill (best-effort, env-var gated) ──────────────────
  //
  // v0.10.34 — Pull from Pulse MySQL when the PULSE_DB_* env vars are
  // set. Catches users whose history isn't in Telnyx (Pulse may have
  // routed via Twilio for some accounts, etc.). Reads ONCE during the
  // migration; the data ends up in ACE's Postgres, after which there's
  // no ongoing Pulse dependency.
  //
  // Lookup chain:
  //   1. Find user's email in ACE
  //   2. Find their pulse user_id by email match in Pulse's users table
  //   3. Pull messages + twilio_call_logs filtered by that pulse user_id
  //   4. Map to ACE Call/Message rows, insert with skipDuplicates
  //
  // If PULSE_DB_* not configured, all sub-calls return [] silently.
  try {
    const aceUser = await prisma.user.findUnique({
      where: { id: args.userId },
      select: { email: true },
    });
    if (aceUser?.email) {
      const pulseUserId = await findPulseUserIdByEmail(aceUser.email);
      if (pulseUserId !== null) {
        log({ pulseUserId, email: aceUser.email }, '[backfill] Pulse user_id resolved');

        // SMS from Pulse messages table
        const pulseMessages = await getPulseMessagesForUser({ pulseUserId, daysBack });
        log({ count: pulseMessages.length }, '[backfill] Pulse messages fetched');
        if (pulseMessages.length > 0) {
          const msgRows = pulseMessages
            .map((r) => mapPulseMessageRowToMessage(r, args.userId, args.userDidId, args.didNumber))
            .filter((r): r is NonNullable<typeof r> => r !== null);
          if (msgRows.length > 0) {
            try {
              const inserted = await prisma.message.createMany({
                data: msgRows,
                skipDuplicates: true,
              });
              result.messagesInserted += inserted.count;
              result.messagesSkipped += msgRows.length - inserted.count;
              log({ inserted: inserted.count, total: msgRows.length }, '[backfill] Pulse messages inserted');
            } catch (e) {
              result.errors.push(`Pulse message createMany: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }

        // Calls from Pulse twilio_call_logs table
        const pulseCalls = await getPulseCallsForUser({ pulseUserId, daysBack });
        log({ count: pulseCalls.length }, '[backfill] Pulse calls fetched');
        if (pulseCalls.length > 0) {
          const callRows = pulseCalls
            .map((r) => mapPulseCallRowToCall(r, args.userId, args.userDidId))
            .filter((r): r is NonNullable<typeof r> => r !== null);
          if (callRows.length > 0) {
            try {
              const inserted = await prisma.call.createMany({
                data: callRows,
                skipDuplicates: true,
              });
              result.callsInserted += inserted.count;
              result.callsSkipped += callRows.length - inserted.count;
              log({ inserted: inserted.count, total: callRows.length }, '[backfill] Pulse calls inserted');
            } catch (e) {
              result.errors.push(`Pulse call createMany: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      } else {
        log({ email: aceUser.email }, '[backfill] no matching Pulse user_id — skipping Pulse backfill');
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`Pulse backfill: ${msg}`);
    log({ err: msg }, '[backfill] Pulse backfill failed (non-fatal)');
  }

  log({ result }, '[backfill] done');
  return result;
}

// ─── Pulse row → ACE schema mappers ─────────────────────────────────────

function mapPulseMessageRowToMessage(
  row: PulseMessageRow,
  userId: number,
  userDidId: number,
  ourDidE164: string,
) {
  // Pulse direction:
  //   from_type='c' (chat_user external) + to_type='r' (recruiter) → inbound
  //   from_type='r' (recruiter) + to_type='c' (chat_user) → outbound
  const direction = row.from_type === 'c' ? 'inbound' : 'outbound';

  // Build phone numbers. Pulse stores user_ids not numbers, but the
  // external contact's number is on chat_user.mobile_no (we JOINed it
  // in as contact_phone).
  const last10 = (s: string) => s.replace(/\D/g, '').slice(-10);
  const ourLast10 = last10(ourDidE164);
  let contactE164 = (row.contact_phone ?? '').trim();
  if (contactE164 && !contactE164.startsWith('+')) {
    // Pulse sometimes stores phone numbers without the + prefix.
    const digits = contactE164.replace(/\D/g, '');
    contactE164 = digits.length === 10 ? `+1${digits}` :
      digits.length === 11 && digits.startsWith('1') ? `+${digits}` :
      `+${digits}`;
  }
  if (!contactE164) return null;

  const fromNumber = direction === 'inbound' ? contactE164 : ourDidE164;
  const toNumber = direction === 'inbound' ? ourDidE164 : contactE164;
  const threadKey = contactE164;

  // Dedup key: prefer Telnyx message id if present; otherwise synthesize
  // from Pulse's row id with a prefix so it can't collide with native
  // Telnyx IDs in our DB.
  const telnyxMessageId = (row.sms_id ?? '').trim() || `pulse-${row.id}`;

  // Status: Pulse stores strings like "delivered", "received", "failed".
  const statusRaw = (row.status ?? '').toLowerCase().trim();
  const status = ['queued', 'sent', 'delivered', 'failed', 'received'].includes(statusRaw)
    ? statusRaw
    : direction === 'inbound' ? 'received' : 'delivered';

  // Media: Pulse stores URL(s) in `media` column. Comma-separated if multiple.
  const mediaUrls = row.media
    ? row.media.split(',').map((u) => u.trim()).filter((u) => u.length > 0)
    : [];

  // Avoid unused-var lint warning; helper retained for future need.
  void ourLast10;

  return {
    userId,
    telnyxMessageId,
    threadKey,
    direction,
    fromNumber,
    toNumber,
    body: row.message ?? '',
    mediaUrls,
    status,
    sentAt: row.created_at,
    deliveredAt: status === 'delivered' ? row.created_at : null,
    userDidId,
  };
}

function mapPulseCallRowToCall(
  row: PulseCallRow,
  userId: number,
  userDidId: number,
) {
  // Normalize phone number BigInt/string to E.164.
  const norm = (raw: bigint | string | null | undefined): string => {
    if (raw === null || raw === undefined) return '';
    const s = typeof raw === 'bigint' ? raw.toString() : String(raw);
    const digits = s.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return digits.length > 0 ? `+${digits}` : '';
  };
  const fromNumber = norm(row.from);
  const toNumber = norm(row.to);
  if (!fromNumber || !toNumber) return null;

  const direction = row.direction?.toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
  const durationSeconds = row.duration ?? 0;

  // Status mapping. Pulse uses various strings; normalize.
  let status = 'completed';
  if (durationSeconds === 0) {
    status = direction === 'inbound' ? 'missed' : 'failed';
  }
  if (row.call_type === 'voicemail') status = 'voicemail';

  // Dedup key — prefer Telnyx call sid, fall back to Pulse row id.
  const telnyxCallId = (row.sid || row.call_session_id || `pulse-call-${row.id}`).trim();

  return {
    userId,
    telnyxCallId,
    direction,
    fromNumber,
    toNumber,
    status,
    startedAt: row.start_time ?? row.createdAt,
    answeredAt: row.answer_time ?? null,
    endedAt: row.end_time ?? null,
    durationSeconds,
    hangupCause: row.endReason ?? null,
    recordingUrl: row.recording_url ?? row.voicemail_url ?? null,
    userDidId,
  };
}

// ─── Async Telnyx Report helpers ────────────────────────────────────────

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 60;            // 60 × 3s = 3 minutes max wait

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Request a CDR report from Telnyx, poll until done, download the CSV.
 * Returns null on any failure (best-effort — we never throw).
 */
async function fetchCdrCsvViaReport(
  phoneNumber: string,
  startTime: string,
  endTime: string,
  log: LogFn,
): Promise<string | null> {
  const create = await telnyx.requestCdrReport({ startTime, endTime, phoneNumber });
  if (!create.ok || !create.data?.data?.id) {
    log(
      { status: create.status, error: create.error, triedPath: create.path },
      '[backfill] CDR report create failed (all candidate paths tried)',
    );
    return null;
  }
  const reportId = create.data.data.id;
  const path = create.path ?? '/cdr_usage_reports';
  log({ reportId, phoneNumber, path }, '[backfill] CDR report requested');

  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const status = await telnyx.getCdrReportStatus(reportId, path);
    if (!status.ok || !status.data?.data) continue;
    const st = status.data.data.status;
    if (st === 'COMPLETE' || st === 'COMPLETED') {
      const url = status.data.data.report_url;
      if (!url) {
        log({ reportId }, '[backfill] CDR report complete but no URL');
        return null;
      }
      log({ reportId, attempt: i + 1 }, '[backfill] CDR report complete, downloading');
      return telnyx.downloadReportCsv(url);
    }
    if (st === 'FAILED') {
      log({ reportId }, '[backfill] CDR report FAILED');
      return null;
    }
  }
  log({ reportId }, '[backfill] CDR report timed out');
  return null;
}

async function fetchMdrCsvViaReport(
  phoneNumber: string,
  startTime: string,
  endTime: string,
  log: LogFn,
): Promise<string | null> {
  const create = await telnyx.requestMdrReport({ startTime, endTime, phoneNumber });
  if (!create.ok || !create.data?.data?.id) {
    log(
      { status: create.status, error: create.error, triedPath: create.path },
      '[backfill] MDR report create failed (all candidate paths tried)',
    );
    return null;
  }
  const reportId = create.data.data.id;
  const path = create.path ?? '/mdr_usage_reports';
  log({ reportId, phoneNumber, path }, '[backfill] MDR report requested');

  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const status = await telnyx.getMdrReportStatus(reportId, path);
    if (!status.ok || !status.data?.data) continue;
    const st = status.data.data.status;
    if (st === 'COMPLETE' || st === 'COMPLETED') {
      const url = status.data.data.report_url;
      if (!url) {
        log({ reportId }, '[backfill] MDR report complete but no URL');
        return null;
      }
      log({ reportId, attempt: i + 1 }, '[backfill] MDR report complete, downloading');
      return telnyx.downloadReportCsv(url);
    }
    if (st === 'FAILED') {
      log({ reportId }, '[backfill] MDR report FAILED');
      return null;
    }
  }
  log({ reportId }, '[backfill] MDR report timed out');
  return null;
}

// ─── CSV parsing (reused logic from admin.routes.ts CSV upload) ─────────

function parseCsvRows(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = vals[j] ?? '';
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQuotes = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function mapTelnyxCsvRowToCall(
  row: Record<string, string>,
  userId: number,
  userDidId: number,
) {
  const telnyxCallId = (row['Call UUID'] || row['Unique CDR ID'] || '').trim();
  const fromNumber = (row['Originating Number'] || '').trim();
  const toNumber = (row['Terminating number'] || row['Full Terminating number'] || '').trim();
  const startStr = (row['Start Timestamp(UTC)'] || row['Start Timestamp'] || '').trim();
  if (!telnyxCallId || !fromNumber || !toNumber || !startStr) return null;

  const direction = (row['Direction'] || '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
  const startedAt = new Date(startStr.replace(' ', 'T') + 'Z');
  const answeredStr = (row['Answer Timestamp'] || '').trim();
  const answeredAt = answeredStr ? new Date(answeredStr.replace(' ', 'T') + 'Z') : null;
  const endedStr = (row['End Timestamp'] || '').trim();
  const endedAt = endedStr ? new Date(endedStr.replace(' ', 'T') + 'Z') : null;
  const durationSeconds = parseInt(row['Call duration'] || '0', 10) || 0;
  const hangupCause = (row['Hangup cause'] || '').trim() || null;

  let status: string;
  if (durationSeconds > 0) status = 'completed';
  else if (direction === 'inbound') status = 'missed';
  else status = 'failed';

  return {
    userId,
    telnyxCallId,
    direction,
    fromNumber,
    toNumber,
    status,
    startedAt,
    answeredAt,
    endedAt,
    durationSeconds,
    hangupCause,
    userDidId,
  };
}

// v0.10.29 — Verified against actual Telnyx MDR CSV column names.
function mapTelnyxCsvRowToMessage(
  row: Record<string, string>,
  userId: number,
  userDidId: number,
  ourDidE164: string,
) {
  const telnyxMessageId = (
    row['Unique Mdr ID'] || row['Unique MDR ID'] ||
    row['Message ID'] || row['MessageID'] || row['ID'] || ''
  ).trim();
  const fromNumber = (row['Originating Number'] || row['From'] || '').trim();
  const toNumber = (row['Terminating number'] || row['To'] || '').trim();
  const tsStr = (
    row['SendTimestamp(UTC)'] || row['CreateTimestamp(UTC)'] ||
    row['Created At'] || row['Start Timestamp'] || row['Sent At'] || ''
  ).trim();
  const completeStr = (row['CompleteTimestamp(UTC)'] || '').trim();
  if (!telnyxMessageId || !fromNumber || !toNumber) return null;

  const last10 = (s: string) => s.replace(/\D/g, '').slice(-10);
  const ourLast10 = last10(ourDidE164);
  let direction = (row['Direction'] || '').toLowerCase();
  if (direction !== 'inbound' && direction !== 'outbound') {
    direction = last10(fromNumber) === ourLast10 ? 'outbound' : 'inbound';
  }
  const threadKey = direction === 'outbound' ? toNumber : fromNumber;
  const body = (row['Message Body'] || row['Body'] || row['Text'] || '').trim();
  const statusRaw = (row['Status_v2'] || row['Status'] || '').toLowerCase().trim();
  const status = ['queued', 'sent', 'delivered', 'failed', 'received'].includes(statusRaw)
    ? statusRaw
    : direction === 'inbound' ? 'received' : 'delivered';
  const sentAt = tsStr ? new Date(tsStr.replace(' ', 'T') + 'Z') : null;
  const deliveredAt = completeStr
    ? new Date(completeStr.replace(' ', 'T') + 'Z')
    : (status === 'delivered' && sentAt ? sentAt : null);
  const mediaSize = parseInt(row['Total Media Size'] || '0', 10) || 0;

  return {
    userId,
    telnyxMessageId,
    threadKey,
    direction,
    fromNumber,
    toNumber,
    body: body || (mediaSize > 0 ? '[MMS]' : ''),
    mediaUrls: [],
    status,
    sentAt,
    deliveredAt,
    userDidId,
  };
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
