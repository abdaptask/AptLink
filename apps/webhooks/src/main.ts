// ACE Dialer Webhooks — Telnyx inbound webhook receiver.
// Phase 5.1: persist call lifecycle events to the database.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { prisma } from '@ace/db';
import { transcribeAndUpdateVoicemail } from './deepgram.js';
import {
  notifyInboundSms,
  scheduleMissedCallNotification,
  scheduleVoicemailTimeoutFallback,
} from './teamsNotifier.js';
// v0.10.79 — parallel email-channel notifications (per-user opt-in,
// default off). Same trigger points as Teams; independent opt-in via
// User.emailNotifyOn.
import {
  notifyInboundSmsByEmail,
  scheduleMissedCallEmail,
  scheduleVoicemailEmailTimeoutFallback,
} from './emailNotifier.js';

const SERVICE_NAME = 'ace-dialer-webhooks';
const START_TIME = new Date().toISOString();
const TELNYX_API_KEY = process.env.TELNYX_API_KEY ?? '';

// Phase 5.7 — multi-user routing.
// PILOT_USER_ID is the fallback when we can't match a webhook event to a
// specific user (e.g. SMS to a number not assigned to anyone yet). Existing
// data shouldn't break.
const FALLBACK_USER_ID = Number(process.env.PILOT_USER_ID ?? 1);

// Normalize a phone for matching across stored formats. Compare on last-10.
function last10(p: string | undefined | null): string {
  return (p ?? '').replace(/[^\d]/g, '').slice(-10);
}

/**
 * Find which user this webhook event belongs to. Strategy:
 *   - If we have a SIP username (Telnyx puts it in sip_username for SIP
 *     events), match users.sip_username.
 *   - Otherwise compare last-10 of the candidate phone numbers (from / to)
 *     against the UserDid table. Whichever side matches a known DID gives
 *     us BOTH the owning user_id and the specific user_did_id that was
 *     touched (used by Task 5 to tag inbound rows with the line badge).
 *   - Fall back to FALLBACK_USER_ID if nothing matches.
 */
async function resolveUserId(opts: {
  sipUsername?: string | null;
  fromNumber?: string | null;
  toNumber?: string | null;
}): Promise<number> {
  const { userId } = await resolveUserAndDid(opts);
  return userId;
}

/**
 * v0.10.0 Task 5 — extended resolver that also returns which UserDid
 * matched. Used by the inbound webhook handlers to populate
 * Call.userDidId / Message.userDidId / Voicemail.userDidId so the UI
 * can render a colored line badge per row.
 *
 * Returns:
 *   - userId:    the owning user (or FALLBACK_USER_ID if no match)
 *   - userDidId: the specific UserDid row matched by to_number or
 *                from_number, or null if we fell back via SIP username
 *                (no DID context) or no DID matched at all.
 *
 * Match priority for userDidId:
 *   1. to_number  → user's INBOUND-side line (most common case)
 *   2. from_number → user's OUTBOUND-side line (the DID they called from)
 *
 * Last-10-digits comparison tolerates Telnyx-vs-storage formatting drift.
 */
async function resolveUserAndDid(opts: {
  sipUsername?: string | null;
  fromNumber?: string | null;
  toNumber?: string | null;
  /** v0.10.24 — REQUIRED for correct line attribution. Inbound matches
   *  toNumber (the dialed DID = which line rang). Outbound matches
   *  fromNumber (the caller ID = which line was used). Old code matched
   *  both, which produced wrong results when toNumber was a SIP URI. */
  direction?: 'inbound' | 'outbound';
}): Promise<{ userId: number; userDidId: number | null }> {
  // 1. SIP username (exact match). Tells us the user but not which of
  // their DIDs was touched — we resolve userDidId via to/from numbers
  // separately below.
  let userId: number | null = null;
  if (opts.sipUsername) {
    const u = await prisma.user.findFirst({
      where: { sipUsername: opts.sipUsername },
      select: { id: true },
    });
    if (u) userId = u.id;
  }

  // 2. DID match (gives us userDidId) — direction-aware.
  //
  // v0.10.24 — Match the CORRECT number based on direction.
  //   - inbound:  match toNumber (which of OUR lines was rung)
  //   - outbound: match fromNumber (which of OUR lines was used as caller ID)
  //   - unknown direction: defensively match toNumber only, never fromNumber
  //     (fromNumber-as-our-line is only valid for outbound; getting it wrong
  //     on inbound stamps the caller's number as our user's line)
  //
  // Why this matters: Telnyx delivers the recipient leg of a TexML-routed
  // call with toNumber set to a SIP URI (not the dialed DID), which last10
  // strips to nothing. The PREVIOUS code fell through to fromNumber and
  // matched the CALLER's caller-ID against our UserDids — sometimes by
  // coincidence (caller's number happened to be one of our DIDs, e.g.
  // self-calls during testing). Catastrophic line attribution either way.
  let userDidId: number | null = null;
  const matchAgainst =
    opts.direction === 'outbound' ? opts.fromNumber : opts.toNumber;
  const matchLast10 = last10(matchAgainst ?? '');
  if (matchLast10.length === 10) {
    // Restrict the lookup to the identified user's DIDs when we know
    // who it is. Cross-user matches would be a different kind of bug.
    const allDids = await prisma.userDid.findMany({
      where: userId !== null
        ? { userId }
        : { userId: { not: null } },
      select: { id: true, userId: true, didNumber: true },
    });
    const match = allDids.find((d) => last10(d.didNumber) === matchLast10);
    if (match) {
      userDidId = match.id;
      if (userId === null) userId = match.userId ?? null;
    }
  }

  return {
    userId: userId ?? FALLBACK_USER_ID,
    userDidId,
  };
}

// Decode the client_state Telnyx echoes back on every call event. We use it
// to carry "what to do when this leg answers" instructions:
//   - bridgeTo   (legacy 2-leg bridge — still supported as fallback)
//   - joinConfId (new: join this leg to an existing Telnyx Conference)
interface ClientState {
  bridgeTo?: string;
  autoBridge?: boolean;
  joinConfId?: string;
  endConfOnExit?: boolean;
  originatorUserId?: number;
}
function decodeClientState(s: string | undefined | null): ClientState | null {
  if (!s) return null;
  try {
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as ClientState;
  } catch {
    return null;
  }
}

// Bridge two Telnyx legs together via the Voice API (legacy fallback for
// the old Add Call flow — used only when client_state lacks joinConfId).
// Phase 6.11 - number blocking: REJECT inbound call via Telnyx Call
// Control with cause USER_BUSY. Previously we used /actions/hangup,
// but Telnyx treated that as "no answer" and routed to Hosted Voicemail.
// With reject+USER_BUSY, Telnyx returns SIP 486 to the caller and
// SKIPS voicemail fallthrough - caller hears a busy signal.
//
// Fail-open: if the API key isn't set or the request fails, log and
// let the call through.
async function rejectCallByControlId(
  callControlId: string,
): Promise<{ ok: boolean; status?: number; error?: unknown }> {
  if (!TELNYX_API_KEY) return { ok: false, error: 'TELNYX_API_KEY not set on webhooks service' };
  const res = await fetch(
    `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/reject`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({ cause: 'USER_BUSY' }),
    },
  );
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...(res.ok ? {} : { error: body }) };
}

// Phase 6.8 - number blocking: check whether `fromNumber` is on `userId`'s
// blocklist. Compares last-10 digits to tolerate carrier formatting
// differences. Fail-open: any DB error returns false (allow the call).
async function isFromNumberBlockedForUser(
  userId: number,
  fromNumber: string | null | undefined,
): Promise<boolean> {
  if (!fromNumber || !userId) return false;
  const last10 = fromNumber.replace(/[^\d]/g, '').slice(-10);
  if (!last10) return false;
  try {
    const rows = await prisma.blockedNumber.findMany({
      where: { userId },
      select: { number: true },
    });
    return rows.some((r) => r.number.replace(/[^\d]/g, '').slice(-10) === last10);
  } catch (e) {
    console.warn('[blocked] lookup failed; treating as not blocked', e);
    return false;
  }
}

async function bridgeLegs(legA: string, legB: string): Promise<{ ok: boolean; status?: number; error?: unknown }> {
  if (!TELNYX_API_KEY) return { ok: false, error: 'TELNYX_API_KEY not set on webhooks service' };
  const res = await fetch(
    `https://api.telnyx.com/v2/calls/${encodeURIComponent(legA)}/actions/bridge`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({ call_control_id: legB }),
    },
  );
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...(res.ok ? {} : { error: body }) };
}

// Join a leg into an existing Telnyx Conference. Used by the new Add Call
// flow — server originates Leg B via Call Control, then this fires on
// call.answered to put Leg B into the same conference room as Leg A.
async function joinConference(
  conferenceId: string,
  callControlId: string,
  opts: { endConfOnExit?: boolean } = {},
): Promise<{ ok: boolean; status?: number; error?: unknown }> {
  if (!TELNYX_API_KEY) return { ok: false, error: 'TELNYX_API_KEY not set on webhooks service' };
  const res = await fetch(
    `https://api.telnyx.com/v2/conferences/${encodeURIComponent(conferenceId)}/actions/join`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        call_control_id: callControlId,
        end_conference_on_exit: opts.endConfOnExit ?? false,
      }),
    },
  );
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...(res.ok ? {} : { error: body }) };
}

// Phase 5.7 — multi-user. PILOT_NUMBER is the fallback DID used for inbound
// voicemails when we can't resolve a user. New users get their own DID via
// users.did_number → the resolveUserId() helper above routes events.
const PILOT_NUMBER = process.env.PILOT_TELNYX_NUMBER ?? '+17322001305';

// Voicemail capture is handled by Telnyx's built-in hosted voicemail
// (enabled per-DID via POST /v2/phone_numbers/{id}/voicemail). Telnyx
// rings the SIP Connection, falls to voicemail on no-answer, records,
// and fires `calls.voicemail.completed` to this webhook — see the
// case-handler in the call event switch below. No Call Control gymnastics
// required (we tried; it caused looped events and wrong caller ID).

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  ignoreTrailingSlash: true,
});

await app.register(cors, { origin: false });
// Phase 6.6 - parse application/x-www-form-urlencoded bodies.
// Required for Telnyx TexML callbacks (Telnyx sends form-encoded POSTs
// to action URLs like /texml/dial-status). Without this, Fastify returns
// 415 Unsupported Media Type and Telnyx plays the "application error" prompt.
await app.register(formbody);

// Log every non-health request so we can confirm whether Telnyx ever hits us.
app.addHook('onRequest', async (request) => {
  if (request.url.startsWith('/health')) return;
  app.log.info(
    {
      method: request.method,
      url: request.url,
      ua: request.headers['user-agent'],
      ip: request.ip,
    },
    '[req] incoming'
  );
});

app.get('/', async () => ({ service: SERVICE_NAME, status: 'ok' }));
app.get('/health', async () => ({
  status: 'ok',
  service: SERVICE_NAME,
  uptimeSeconds: Math.floor(process.uptime()),
  startedAt: START_TIME,
  timestamp: new Date().toISOString(),
}));

// ---------- Telnyx call webhook handler ----------
// Telnyx posts JSON like:
// { data: { event_type: 'call.initiated' | 'call.answered' | 'call.hangup' | ...,
//           payload: { call_session_id, call_control_id, direction, from, to,
//                      start_time, end_time, hangup_cause, hangup_source, ... } } }
app.post('/webhooks/telnyx/calls', async (request) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = request.body as any;
    const event = body?.data;
    if (!event) {
      app.log.warn('[telnyx] webhook with no data');
      return { received: true };
    }

    const payload = event.payload ?? {};
    // Phase 5.4 rebuild: key each row by call_control_id (one row PER LEG),
    // not call_session_id (which is shared across both legs and used to be
    // overwriting them). The sessionId column groups sibling legs.
    const callControlId: string | undefined = payload.call_control_id;
    const sessionId: string | undefined = payload.call_session_id;
    const callId: string | undefined = callControlId ?? sessionId;
    if (!callId) {
      app.log.warn('[telnyx] no call id in payload');
      return { received: true };
    }

    const direction = payload.direction === 'outgoing' ? 'outbound' : 'inbound';
    const fromNumber: string = payload.from ?? '';
    const toNumber: string = payload.to ?? '';

    app.log.info(
      { eventType: event.event_type, callControlId, sessionId, direction, fromNumber, toNumber },
      '[telnyx] call event'
    );

    switch (event.event_type) {
      case 'call.initiated': {
        // v0.10.0 Task 5 — also resolve userDidId so the new Call row
        // carries a line tag for the Recents badge. resolveUserAndDid
        // returns the matched UserDid id by comparing to/from against
        // user_dids.did_number.
        const { userId: ownerUserId, userDidId } = await resolveUserAndDid({
          sipUsername: payload.sip_username ?? payload.client_username ?? null,
          fromNumber,
          toNumber,
          direction,           // v0.10.24 — direction-aware line attribution
        });

        // Phase 6.8 - number blocking: for INBOUND calls only, check if
        // the recipient user has blocked the caller. If so, hang up at
        // the Telnyx layer and store the row with status=blocked so the
        // user sees it in Recents.
        const blocked =
          direction === 'inbound' &&
          (await isFromNumberBlockedForUser(ownerUserId, fromNumber));
        if (blocked) {
          app.log.info(
            { ownerUserId, fromNumber, callControlId },
            '[blocked] inbound call from blocked number - rejecting with USER_BUSY',
          );
          if (callControlId) {
            void rejectCallByControlId(callControlId).catch((e) =>
              app.log.warn({ err: e }, '[blocked] reject API failed'),
            );
          }
        }

        await prisma.call.upsert({
          where: { telnyxCallId: callId },
          update: {
            status: blocked ? 'blocked' : 'initiated',
            ...(callControlId ? { callControlId } : {}),
            ...(userDidId ? { userDidId } : {}),
          },
          create: {
            userId: ownerUserId,
            telnyxCallId: callId,
            sessionId: payload.call_session_id ?? null,
            callControlId: callControlId ?? null,
            direction,
            fromNumber,
            toNumber,
            status: blocked ? 'blocked' : 'initiated',
            startedAt: payload.start_time ? new Date(payload.start_time) : new Date(),
            userDidId,
          },
        });

        break;
      }

      case 'call.answered':
      case 'call.bridged': {
        await prisma.call.updateMany({
          where: { telnyxCallId: callId },
          data: {
            status: 'answered',
            answeredAt: new Date(),
            ...(callControlId ? { callControlId } : {}),
          },
        });

        // Phase 5.4 (rebuild): server-originated Leg B carries a client_state
        // telling us either to auto-bridge (legacy) or to join a Conference
        // (new — proper 3-way with independent hangup behavior).
        if (event.event_type === 'call.answered' && callControlId) {
          const state = decodeClientState(payload.client_state);
          if (state?.joinConfId) {
            app.log.info({ confId: state.joinConfId, leg: callControlId }, '[webhook] auto-joining conference');
            const result = await joinConference(state.joinConfId, callControlId, {
              endConfOnExit: state.endConfOnExit ?? false,
            });
            if (!result.ok) {
              app.log.error({ result }, '[webhook] auto-join failed');
            } else {
              app.log.info({ confId: state.joinConfId, leg: callControlId }, '[webhook] auto-join success');
            }
          } else if (state?.bridgeTo && state.autoBridge !== false) {
            app.log.info({ legA: state.bridgeTo, legB: callControlId }, '[webhook] auto-bridging on answer (legacy)');
            const result = await bridgeLegs(state.bridgeTo, callControlId);
            if (!result.ok) {
              app.log.error({ result }, '[webhook] auto-bridge failed');
            } else {
              app.log.info({ legA: state.bridgeTo, legB: callControlId }, '[webhook] auto-bridge success');
            }
          }
        }
        break;
      }

      case 'call.hangup': {
        const startedAt = payload.start_time ? new Date(payload.start_time) : null;
        const endedAt = payload.end_time ? new Date(payload.end_time) : new Date();
        let duration = 0;
        if (startedAt) {
          duration = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
        }
        const hangupCause: string = payload.hangup_cause ?? 'unknown';
        const hangupSource: string = payload.hangup_source ?? '';
        // Classify the call's final status. The previous logic defaulted
        // anything unfamiliar to "failed", which mis-labelled forwarded
        // calls (Telnyx uses cause codes like "redirected" / "transferred"
        // for those). The new mapping is generous: only explicit failure
        // signals count as failed. Everything else is "completed" — the
        // call happened, even if it took a non-default path.
        const lc = hangupCause.toLowerCase();
        const status: string = (() => {
          if (lc === 'no_answer' || lc === 'no_user_response') return 'no_answer';
          if (lc === 'call_rejected' || lc === 'rejected') return 'rejected';
          if (lc === 'user_busy' || lc === 'busy') return 'rejected';
          // Forwarded / transferred — call DID route, just not to the dialer.
          if (lc.includes('forward') || lc.includes('transfer') || lc.includes('redirect')) {
            return 'forwarded';
          }
          // Known healthy terminations.
          if (
            lc === 'normal_clearing' ||
            lc === 'normal_termination' ||
            lc === 'originator_cancel'
          ) {
            return 'completed';
          }
          // Default to completed rather than failed for unknown causes —
          // the carrier accepted and routed the call; whatever happened
          // downstream isn't necessarily a failure from the user's POV.
          // The actual cause string is preserved on the row so we can
          // distinguish later if needed.
          app.log.info(
            { hangupCause, hangupSource },
            '[call] unrecognised hangup_cause; treating as completed',
          );
          return 'completed';
        })();

        // Phase 6.12 - preserve blocked status. If the row was already
        // marked 'blocked' by call.initiated (because the caller is on
        // the recipient's blocklist), do NOT let the subsequent hangup
        // event downgrade it to "rejected" or "completed". Only update
        // the bookkeeping fields (endedAt / duration / cause), leave the
        // status field alone.
        const existing = await prisma.call.findUnique({
          where: { telnyxCallId: callId },
          select: { status: true },
        });
        const preserveStatus = existing?.status === 'blocked';
        const updated = await prisma.call.updateMany({
          where: { telnyxCallId: callId },
          data: {
            ...(preserveStatus ? {} : { status }),
            endedAt,
            durationSeconds: duration,
            hangupCause,
            hangupSource: payload.hangup_source ?? null,
          },
        });
        if (updated.count === 0 && startedAt) {
          const ownerUserId = await resolveUserId({
            sipUsername: payload.sip_username ?? payload.client_username ?? null,
            fromNumber,
            toNumber,
          });
          await prisma.call.create({
            data: {
              userId: ownerUserId,
              telnyxCallId: callId,
              sessionId: payload.call_session_id ?? null,
              direction,
              fromNumber,
              toNumber,
              status,
              startedAt,
              endedAt,
              durationSeconds: duration,
              hangupCause,
              hangupSource: payload.hangup_source ?? null,
            },
          });
        }

        // v0.10.0 Task 8 / v0.10.2 fix — Teams missed-call notification.
        //
        // Semantics: an inbound call is "missed" whenever it ENDED
        // WITHOUT BEING ANSWERED, regardless of hangup_cause. That
        // means:
        //   - no_answer / no_user_response  → missed
        //   - rejected / user_busy          → missed
        //   - originator_cancel              → missed (caller hung up before pickup)
        //   - normal_clearing on unanswered → missed
        //   - normal_clearing on answered   → NOT missed (was answered)
        //
        // Earlier we gated this on status string mapping, but the
        // status-classifier collapses originator_cancel into 'completed'
        // which then SKIPPED the scheduler. Result: when a caller cancels
        // before pickup, the user got no notification.
        //
        // Correct gate: direction === 'inbound' AND answeredAt IS NULL.
        // We also still skip 'blocked' rows (user-initiated suppression).
        // The 30s grace window in scheduleMissedCallNotification handles
        // suppression when a voicemail arrives for the same call.
        const row = await prisma.call.findUnique({
          where: { telnyxCallId: callId },
          select: {
            id: true,
            userId: true,
            direction: true,
            answeredAt: true,
            status: true,
          },
        });
        if (
          row?.userId &&
          row.direction === 'inbound' &&
          !row.answeredAt &&
          row.status !== 'blocked'
        ) {
          scheduleMissedCallNotification({
            userId: row.userId,
            callDbId: row.id,
            telnyxCallId: callId,
          });
          // v0.10.79 — parallel email notification (per-user opt-in,
          // default off via User.emailNotifyOn). Independent of Teams.
          scheduleMissedCallEmail({
            userId: row.userId,
            callDbId: row.id,
            telnyxCallId: callId,
          });
        }

        break;
      }

      case 'call.recording.saved': {
        // Generic call recording (manual record-while-talking) — attach the
        // URL to the call row. Voicemails come through a separate event
        // (`calls.voicemail.completed`) handled below.
        const rawUrls = payload.recording_urls?.mp3 ?? payload.recording_urls ?? [];
        const recordingUrls: string[] = Array.isArray(rawUrls)
          ? rawUrls
          : typeof rawUrls === 'string'
            ? [rawUrls]
            : [];
        if (recordingUrls.length > 0) {
          await prisma.call.updateMany({
            where: { telnyxCallId: callId },
            data: { recordingUrl: recordingUrls[0] },
          });
        }
        break;
      }

      case 'calls.voicemail.completed': {
        // Telnyx Hosted Voicemail. Enabled per-DID via
        //   POST https://api.telnyx.com/v2/phone_numbers/{id}/voicemail
        //   { "enabled": true, "pin": "..." }
        // Telnyx rings the DID's SIP Connection; on no-answer it captures
        // the recording and posts THIS event to us.
        const vmFrom: string = payload.from ?? '';
        const vmTo: string = payload.to ?? '';
        const recordingUrl: string | null = payload.recording_url ?? null;
        // Telnyx may use any of these field names for duration depending on
        // event flavor — try them in order. `recording_duration_millis`
        // is ms, others are seconds. Log the raw payload so we can pin
        // down the actual field shipped for hosted voicemail.
        const durRaw =
          payload.recording_duration ??
          payload.duration ??
          (payload.recording_duration_millis != null
            ? Number(payload.recording_duration_millis) / 1000
            : null) ??
          (payload.recording?.duration ?? null);
        const durSec = Number(durRaw ?? 0);
        if (!recordingUrl) {
          app.log.warn({ payload }, '[vm] calls.voicemail.completed missing recording_url');
          break;
        }
        // Diagnostic — log all the duration-shaped fields we tried so we
        // can confirm which one actually carries the value going forward.
        app.log.info(
          {
            recording_duration: payload.recording_duration,
            duration: payload.duration,
            recording_duration_millis: payload.recording_duration_millis,
            recordingObjDuration: payload.recording?.duration,
            chosen: durSec,
          },
          '[vm] duration field probe',
        );
        try {
          // v0.10.0 Task 5 — resolve userDidId for the line-badge tag.
          // Voicemails are always inbound by definition; the DID we
          // care about is the to_number (the line the caller dialed).
          const { userId: ownerUserId, userDidId } = await resolveUserAndDid({
            fromNumber: vmFrom,
            toNumber: vmTo,
            direction: 'inbound',
          });
          // Pre-fill transcription from Telnyx if they happen to include it
          // (we don't pay them for it, but if it's there, use it as a head-
          // start before our Deepgram call returns).
          const telnyxText: string | null = payload.transcription_text ?? null;
          // v0.10.0 — Dedup by telnyx_call_id. Telnyx fires both
          // `calls.voicemail.completed` (Telnyx Hosted Voicemail flow)
          // AND `call.recording.saved` with client_state='voicemail' (the
          // legacy /webhooks/telnyx/voicemail path below) for the same
          // call. Without this check we'd create two Voicemail rows for
          // a single message — which is exactly what the user just saw.
          const dupCheck = callId
            ? await prisma.voicemail.findFirst({
                where: { telnyxCallId: callId },
                select: { id: true },
              })
            : null;
          if (dupCheck) {
            app.log.info(
              { telnyxCallId: callId, existingVoicemailId: dupCheck.id },
              '[vm] dedup: voicemail with this telnyxCallId already exists, skipping create',
            );
            break;
          }
          const created = await prisma.voicemail.create({
            data: {
              userId: ownerUserId,
              telnyxCallId: callId,
              fromNumber: vmFrom,
              toNumber: vmTo,
              recordingUrl,
              durationSeconds: Math.max(1, Math.round(durSec)),
              transcription: telnyxText,
              receivedAt: new Date(),
              userDidId,
            },
            select: { id: true },
          });
          app.log.info(
            { fromNumber: vmFrom, recordingUrl, durationSeconds: durSec, voicemailId: created.id },
            '[vm] voicemail saved from Telnyx Hosted Voicemail',
          );
          // Fire-and-forget Deepgram transcription if we don't already have
          // a transcript from Telnyx. The webhook response goes back to
          // Telnyx within ms; Deepgram runs in the background and updates
          // the row when done (~2-5 sec for short voicemails). UI polls
          // until the transcription field populates.
          if (!telnyxText) {
            void transcribeAndUpdateVoicemail(created.id, recordingUrl, ownerUserId);
          }

          // v0.10.0 Task 8 — Teams voicemail card.
          // Two firing paths (deduped in the notifier's in-memory Set):
          //   - Deepgram path: transcribeAndUpdateVoicemail calls
          //     notifyVoicemail({reason:'transcribed'}) after writing
          //     the transcript. Richest card (transcript filled in).
          //   - Timeout fallback (scheduled here): if Deepgram hasn't
          //     fired within 30s — or we already had a Telnyx
          //     transcript and skipped Deepgram — send the card with
          //     whatever transcript exists. Dedup Set guarantees only
          //     one card per voicemail row.
          scheduleVoicemailTimeoutFallback({
            userId: ownerUserId,
            voicemailId: created.id,
          });
          // v0.10.79 — parallel email voicemail notification. Same
          // two-path firing (transcribed from Deepgram OR 30s timeout)
          // with its own in-memory dedup Set in emailNotifier.
          scheduleVoicemailEmailTimeoutFallback({
            userId: ownerUserId,
            voicemailId: created.id,
          });
        } catch (e) {
          app.log.error({ err: e }, '[vm] failed to write Voicemail row');
        }
        break;
      }

      default:
        // Unhandled event types are fine — we just log.
        app.log.debug({ eventType: event.event_type }, '[telnyx] unhandled event type');
    }

    return { received: true };
  } catch (e) {
    app.log.error({ err: e }, '[telnyx] handler error');
    return { received: true, error: String(e) };
  }
});

// Phase 5.3 — Telnyx SMS / MMS webhook.
// Telnyx event types we care about:
//   - message.received       inbound SMS/MMS landed on our number
//   - message.sent           outbound accepted by Telnyx (we already wrote the row)
//   - message.delivered      outbound delivered to handset
//   - message.failed         outbound failed
//   - message.finalized      Telnyx's "we're done with this message"
app.post('/webhooks/telnyx/sms', async (request) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = request.body as any;
    const event = body?.data;
    if (!event) {
      app.log.warn('[telnyx] sms webhook with no data');
      return { received: true };
    }

    const payload = event.payload ?? {};
    const telnyxMessageId: string | undefined = payload.id;
    const eventType: string = event.event_type ?? '';
    if (!telnyxMessageId) {
      app.log.warn({ eventType }, '[telnyx] sms event missing id');
      return { received: true };
    }

    const text: string = payload.text ?? '';
    const mediaUrls: string[] = Array.isArray(payload.media)
      ? payload.media.map((m: { url?: string }) => m?.url).filter((u: unknown): u is string => typeof u === 'string')
      : [];
    const fromNumber: string = payload.from?.phone_number ?? '';
    const toNumber: string = Array.isArray(payload.to) && payload.to[0]?.phone_number
      ? payload.to[0].phone_number
      : payload.to?.phone_number ?? '';

    app.log.info(
      { eventType, telnyxMessageId, fromNumber, toNumber, mediaCount: mediaUrls.length },
      '[telnyx] sms event'
    );

    switch (eventType) {
      case 'message.received': {
        // Inbound: from = the PSTN caller, to = our DID. Route to whichever
        // user owns this DID (Phase 5.7 multi-user).
        // v0.10.0 Task 5 — also resolve userDidId so the inbound row carries
        // a line-tag for the UI badge.
        const threadKey = fromNumber; // the other party
        const { userId: ownerUserId, userDidId } = await resolveUserAndDid({
          toNumber, fromNumber,
          direction: 'inbound',
        });

        // Phase 6.8 - number blocking: silently drop SMS from blocked
        // senders. We ack the webhook (Telnyx requires 200) but skip
        // storing the message, so it never appears in the user's inbox.
        if (await isFromNumberBlockedForUser(ownerUserId, fromNumber)) {
          app.log.info(
            { ownerUserId, fromNumber, telnyxMessageId },
            '[blocked] inbound SMS from blocked number - dropping',
          );
          break;
        }

        // v0.10.3 — Don't use upsert here. Telnyx retries the
        // message.received webhook on any non-2xx response and
        // sometimes even on slow 2xx responses. Upsert would update
        // the existing row, and our old code then re-fired the Teams
        // notification each retry → duplicate cards. Fix: explicit
        // findUnique → create-or-update branch, fire notification ONLY
        // on first-time create.
        const existingMessage = await prisma.message.findUnique({
          where: { telnyxMessageId },
          select: { id: true },
        });

        if (existingMessage) {
          // Retry / re-delivery — just refresh status, don't re-notify.
          await prisma.message.update({
            where: { telnyxMessageId },
            data: { status: 'received' },
          });
          app.log.info(
            { telnyxMessageId, messageId: existingMessage.id },
            '[sms] retry / duplicate webhook — refreshed status, no card sent',
          );
        } else {
          const created = await prisma.message.create({
            data: {
              userId: ownerUserId,
              telnyxMessageId,
              threadKey,
              direction: 'inbound',
              fromNumber,
              toNumber,
              body: text,
              mediaUrls,
              status: 'received',
              sentAt: payload.received_at ? new Date(payload.received_at) : new Date(),
              userDidId,
            },
            select: { id: true, direction: true },
          });
          // First-time inbound delivery — fire Teams card.
          if (created.direction === 'inbound') {
            void notifyInboundSms({
              userId: ownerUserId,
              messageDbId: created.id,
            }).catch((e) =>
              app.log.warn({ err: e }, '[teams] notifyInboundSms threw'),
            );
            // v0.10.79 — parallel email notification. One email per
            // inbound SMS (no coalescing — per product decision).
            void notifyInboundSmsByEmail({
              userId: ownerUserId,
              messageDbId: created.id,
            }).catch((e) =>
              app.log.warn({ err: e }, '[email] notifyInboundSms threw'),
            );
          }
        }
        break;
      }

      case 'message.sent':
      case 'message.queued': {
        await prisma.message.updateMany({
          where: { telnyxMessageId },
          data: { status: 'sent', sentAt: new Date() },
        });
        break;
      }

      case 'message.delivered': {
        await prisma.message.updateMany({
          where: { telnyxMessageId },
          data: { status: 'delivered', deliveredAt: new Date() },
        });
        break;
      }

      case 'message.sending_failed':
      case 'message.failed':
      case 'message.finalized': {
        // For finalized, status comes from the payload itself.
        const finalStatus: string =
          eventType === 'message.finalized'
            ? payload.to?.[0]?.status ?? payload.status ?? 'sent'
            : 'failed';
        await prisma.message.updateMany({
          where: { telnyxMessageId },
          data: {
            status: finalStatus === 'delivered' ? 'delivered' : finalStatus,
            errors: payload.errors ?? undefined,
            deliveredAt: finalStatus === 'delivered' ? new Date() : undefined,
          },
        });
        break;
      }

      default:
        app.log.debug({ eventType }, '[telnyx] unhandled sms event');
    }

    return { received: true };
  } catch (e) {
    app.log.error({ err: e }, '[telnyx] sms handler error');
    return { received: true, error: String(e) };
  }
});

app.post('/webhooks/telnyx/failover', async (request) => {
  app.log.info({ payload: request.body }, '[telnyx] failover event');
  return { received: true };
});

// ---------- Phase 5.6: TexML inbound flow ----------
// Point a Telnyx TexML application at this URL on your DID's voice settings.
// When a PSTN call comes in, Telnyx fetches this and follows the instructions:
//   1. Dial the WebRTC user for up to 25s.
//   2. If the user is busy / declines / times out, fall through to greet + record.
//   3. The recording finalisation hits /webhooks/telnyx/voicemail which inserts
//      a Voicemail row.
//
// Configure once: Telnyx Portal → Voice → TexML Applications → New →
//   Webhook URL: https://<this-host>/texml/inbound  Method: POST or GET
//   Then on your DID → Voice settings → assign this TexML application.
//
// Env vars consumed:
//   PILOT_SIP_USERNAME   the WebRTC user's SIP credential username
//                        (URI becomes sip:<username>@sip.telnyx.com)
//   PILOT_VOICEMAIL_GREETING (optional) override the default Polly greeting
// Escape XML special chars (mostly for the user-supplied greeting).
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// v0.10.14 — Look up the called DID's owner so we can dial THEIR
// Credential Connection. Without this, every user except whoever owns
// PILOT_SIP_CONNECTION_ID gets inbound calls misrouted (Telnyx
// rejects in <500ms because the wrong connection has no matching SIP
// user registered → 366ms call.hangup → caller hears nothing).
//
// Telnyx posts the called DID as `To` in the TexML callback body
// (or query string for GET). Last-10-digit match tolerates
// formatting drift. If we can't find an owner, we fall through to
// the env-var pilot connection (legacy behaviour, used for any
// orphan DID not yet bound to a user).
//
// v0.10.14 + self-heal — UserDid.connectionId can be NULL for two
// reasons:
//   1. Pre-v0.10.0 users got backfilled UserDid rows from User.didNumber
//      but the legacy User row never tracked connection_id locally.
//   2. The regular-invite + bulk-import code paths in admin.routes.ts
//      don't pass connectionId to ensureUserDid (only auto-provision +
//      pending-invite do).
// To make per-DID TexML routing work universally without a separate
// backfill migration, this function now lazily looks up the
// connection_id from Telnyx when UserDid.connectionId is NULL, and
// persists the result back to the UserDid row. First inbound call
// for an affected user pays the round-trip; every subsequent call is
// served from the local row.
async function resolveCalledConnection(
  request: { body?: unknown; query?: unknown },
): Promise<{ connectionId: string | null; userId: number | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (request.body ?? {}) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (request.query ?? {}) as any;
  const to: string =
    (typeof body.To === 'string' && body.To) ||
    (typeof query.To === 'string' && query.To) ||
    (typeof body.to === 'string' && body.to) ||
    (typeof query.to === 'string' && query.to) ||
    '';
  if (!to) return { connectionId: null, userId: null };
  const last10 = to.replace(/[^\d]/g, '').slice(-10);
  if (last10.length !== 10) return { connectionId: null, userId: null };
  try {
    const all = await prisma.userDid.findMany({
      select: { id: true, didNumber: true, connectionId: true, userId: true },
    });
    const match = all.find(
      (d) => d.didNumber.replace(/[^\d]/g, '').slice(-10) === last10,
    );
    if (!match) return { connectionId: null, userId: null };

    // Happy path: row has the connection_id locally.
    if (match.connectionId) {
      return { connectionId: match.connectionId, userId: match.userId };
    }

    // Lazy backfill: look up Telnyx for the actual DID → connection
    // binding, persist back to the row so we never round-trip again.
    if (!TELNYX_API_KEY) {
      app.log.warn(
        { didNumber: match.didNumber, userId: match.userId },
        '[texml] UserDid.connectionId is NULL and TELNYX_API_KEY not set — falling back to pilot',
      );
      return { connectionId: null, userId: match.userId };
    }
    try {
      const lookupRes = await fetch(
        `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(match.didNumber)}`,
        { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } },
      );
      if (!lookupRes.ok) {
        app.log.warn(
          { didNumber: match.didNumber, status: lookupRes.status },
          '[texml] Telnyx lookup for backfill failed',
        );
        return { connectionId: null, userId: match.userId };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lookupBody = (await lookupRes.json()) as any;
      const numberInfo = lookupBody?.data?.[0];
      const fetchedConnectionId: string | undefined = numberInfo?.connection_id;
      if (!fetchedConnectionId) {
        app.log.warn(
          { didNumber: match.didNumber },
          '[texml] Telnyx returned no connection_id for DID — falling back to pilot',
        );
        return { connectionId: null, userId: match.userId };
      }
      // Persist back so future calls (any user, any DID) don't re-round-trip.
      await prisma.userDid.update({
        where: { id: match.id },
        data: { connectionId: fetchedConnectionId },
      });
      app.log.info(
        {
          userDidId: match.id,
          userId: match.userId,
          didNumber: match.didNumber,
          connectionId: fetchedConnectionId,
        },
        '[texml] backfilled UserDid.connectionId from Telnyx',
      );
      return { connectionId: fetchedConnectionId, userId: match.userId };
    } catch (e) {
      app.log.warn(
        { err: e instanceof Error ? e.message : String(e), didNumber: match.didNumber },
        '[texml] Telnyx lookup threw — falling back to pilot',
      );
      return { connectionId: null, userId: match.userId };
    }
  } catch (e) {
    app.log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      '[texml] resolveCalledConnection lookup failed',
    );
    return { connectionId: null, userId: null };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const texmlHandler = async (request: any): Promise<string> => {
  // v0.10.14 — try to resolve the called DID's owner first. Fall back
  // to the env-var pilot connection if we can't (legacy behaviour for
  // orphan / unassigned DIDs).
  const resolved = await resolveCalledConnection(request);
  const sipConnectionId =
    resolved.connectionId ||
    process.env.PILOT_SIP_CONNECTION_ID ||
    '2960617014202206103';
  app.log.info(
    {
      resolvedConnectionId: resolved.connectionId,
      resolvedUserId: resolved.userId,
      chose: sipConnectionId,
      fellBackToPilot: !resolved.connectionId,
    },
    '[texml] routing decision',
  );

  // Build an ABSOLUTE URL for the Dial action - Telnyx requires absolute URLs.
  const proto = (request?.headers?.['x-forwarded-proto'] as string) ?? 'https';
  const host = (request?.headers?.host as string) ?? 'ace-dialer-webhooks.onrender.com';
  const baseUrl = (process.env.WEBHOOKS_PUBLIC_URL ?? `${proto}://${host}`).replace(/\/+$/, '');
  const dialStatusAction = `${baseUrl}/texml/dial-status`;

  // Phase 6.5 - Hold & Accept friendly inbound flow.
  //
  // Old flow: <Dial><Sip/></Dial> immediately followed by <Say>+<Record>.
  // When a second concurrent call came in, the SIP endpoint returned 486
  // Busy on the new INVITE; TexML treated <Dial> as failed and fell
  // straight through to <Record>. Result: caller hit voicemail with no
  // ringing, and Hold & Accept never got a chance to show.
  //
  // New flow: <Dial> has an action URL so dialStatusHandler can branch on
  // DialCallStatus - busy -> polite hangup, no-answer/failed -> voicemail,
  // completed -> nothing. Timeout bumped to 45s so the user has room to
  // see the IncomingCall UI and tap Hold & Accept.
  const xml = sipConnectionId
    ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="45" action="${xmlEscape(dialStatusAction)}" method="POST">
    <Sip>sip:${xmlEscape(sipConnectionId)}@sip.telnyx.com</Sip>
  </Dial>
</Response>`
    : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Service not yet configured.</Say>
  <Hangup/>
</Response>`;

  return xml;
};

// Phase 6.5 - Dial action handler. Telnyx POSTs (or GETs) here when
// <Dial> finishes. We branch on DialCallStatus:
//   completed/answered -> empty Response (call already done)
//   busy                -> polite hangup (don't dump caller into voicemail)
//   no-answer / failed  -> fall through to voicemail Record
//   canceled            -> fall through to voicemail Record
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dialStatusHandler = (request: any): string => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (request?.body ?? {}) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (request?.query ?? {}) as any;
  const status: string = (body.DialCallStatus ?? query.DialCallStatus ?? '').toString().toLowerCase();

  const proto = (request?.headers?.['x-forwarded-proto'] as string) ?? 'https';
  const host = (request?.headers?.host as string) ?? 'ace-dialer-webhooks.onrender.com';
  const baseUrl = (process.env.WEBHOOKS_PUBLIC_URL ?? `${proto}://${host}`).replace(/\/+$/, '');
  const recordAction = `${baseUrl}/webhooks/telnyx/voicemail`;
  const greeting =
    process.env.PILOT_VOICEMAIL_GREETING ??
    "You've reached ACE Dialer. Please leave a message after the tone, then press pound or hang up.";

  app.log.info({ status }, '[texml] dial-status received');

  if (status === 'completed' || status === 'answered') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response/>`;
  }
  if (status === 'busy') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">The party you are trying to reach is on another call. Please try again in a moment.</Say>
  <Hangup/>
</Response>`;
  }
  // Default + no-answer / failed / canceled -> voicemail.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${xmlEscape(greeting)}</Say>
  <Record maxLength="120" playBeep="true" action="${xmlEscape(recordAction)}" method="POST" finishOnKey="#" />
  <Hangup/>
</Response>`;
};

app.get('/texml/inbound', async (request, reply) => {
  const xml = await texmlHandler(request);
  app.log.info({ length: xml.length }, '[texml] inbound served');
  reply.type('application/xml; charset=utf-8').send(xml);
});
app.post('/texml/inbound', async (request, reply) => {
  const xml = await texmlHandler(request);
  app.log.info({ length: xml.length }, '[texml] inbound served');
  reply.type('application/xml; charset=utf-8').send(xml);
});

// Phase 6.5 - TexML <Dial action="..."> callback. Telnyx POSTs DialCallStatus
// here when the dial finishes; we branch to voicemail / hangup / no-op.
app.get('/texml/dial-status', async (request, reply) => {
  const xml = dialStatusHandler(request);
  app.log.info({ length: xml.length }, '[texml] dial-status served (GET)');
  reply.type('application/xml; charset=utf-8').send(xml);
});
app.post('/texml/dial-status', async (request, reply) => {
  const xml = dialStatusHandler(request);
  app.log.info({ length: xml.length }, '[texml] dial-status served (POST)');
  reply.type('application/xml; charset=utf-8').send(xml);
});

// Phase 5.6 — Voicemail recording webhook.
// Telnyx Call Control flow: on no-answer, transfer the call to a recording
// action that records the caller's message and fires a webhook to this URL
// (or call.recording.saved with a custom client_state tag we set in the flow).
// Accepts both shapes:
//   - data.event_type === 'call.recording.saved' WITH client_state === 'voicemail'
//   - top-level { from, to, recording_url, duration_seconds, transcription, telnyx_call_id }
app.post('/webhooks/telnyx/voicemail', async (request) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = request.body as any;

    // Variant A — Telnyx native event envelope.
    const event = body?.data;
    let fromNumber: string | undefined;
    let toNumber: string | undefined;
    let recordingUrl: string | undefined;
    let durationSeconds = 0;
    let telnyxCallId: string | undefined;
    let receivedAt: Date = new Date();
    let transcription: string | undefined;

    if (event?.payload) {
      const payload = event.payload;
      fromNumber = payload.from;
      toNumber = payload.to;
      const urls = payload.recording_urls?.mp3 ?? payload.recording_urls ?? [];
      recordingUrl = Array.isArray(urls) ? urls[0] : urls;
      durationSeconds = payload.recording_duration_millis
        ? Math.floor(payload.recording_duration_millis / 1000)
        : 0;
      telnyxCallId = payload.call_session_id ?? payload.call_control_id;
      if (payload.start_time) receivedAt = new Date(payload.start_time);
      transcription = payload.transcription?.text;
    } else {
      // Variant B — minimal custom shape.
      fromNumber = body?.from;
      toNumber = body?.to;
      recordingUrl = body?.recording_url;
      durationSeconds = Number(body?.duration_seconds ?? 0);
      telnyxCallId = body?.telnyx_call_id;
      transcription = body?.transcription;
      if (body?.received_at) receivedAt = new Date(body.received_at);
    }

    if (!fromNumber || !recordingUrl) {
      app.log.warn({ body }, '[telnyx] voicemail webhook missing from or recording_url');
      return { received: true };
    }

    // Phase 5.7 — route the voicemail to the user that owns the called DID.
    // v0.10.0 Task 5 — also resolve userDidId for line-badge tagging.
    const { userId: ownerUserId, userDidId } = await resolveUserAndDid({
      toNumber, fromNumber,
      direction: 'inbound',
    });

    // Phase 6.12 - drop blocked voicemails. Telnyx Hosted Voicemail still
    // triggers on USER_BUSY (Telnyx Support confirmed they can't disable
    // that trigger), so a blocked caller's recording arrives here. Drop
    // it silently — the user never sees it.
    if (await isFromNumberBlockedForUser(ownerUserId, fromNumber)) {
      app.log.info(
        { ownerUserId, fromNumber, telnyxCallId },
        '[blocked] voicemail from blocked number - dropping',
      );
      return { received: true };
    }

    // v0.10.0 — Dedup by telnyx_call_id. The Telnyx Hosted Voicemail
    // handler above ALSO writes to this table; if Telnyx fires both
    // event types for the same call, we'd produce two rows. Skip
    // creation if a row with this telnyxCallId already exists.
    if (telnyxCallId) {
      const dupCheck = await prisma.voicemail.findFirst({
        where: { telnyxCallId },
        select: { id: true },
      });
      if (dupCheck) {
        app.log.info(
          { telnyxCallId, existingVoicemailId: dupCheck.id },
          '[telnyx] legacy voicemail dedup: row with this telnyxCallId already exists, skipping',
        );
        return { received: true };
      }
    }

    await prisma.voicemail.create({
      data: {
        userId: ownerUserId,
        telnyxCallId: telnyxCallId ?? null,
        fromNumber,
        toNumber: toNumber ?? PILOT_NUMBER,
        recordingUrl,
        durationSeconds,
        transcription: transcription ?? null,
        receivedAt,
        userDidId,
      },
    });

    app.log.info({ fromNumber, recordingUrl, durationSeconds }, '[telnyx] voicemail recorded');
    return { received: true };
  } catch (e) {
    app.log.error({ err: e }, '[telnyx] voicemail handler error');
    return { received: true, error: String(e) };
  }
});

// Catch-all for any path we didn't register — helps diagnose if Telnyx is posting
// to a slightly different URL than we expect. Using setNotFoundHandler avoids
// colliding with the CORS plugin's OPTIONS route on '/*'.
app.setNotFoundHandler((request, reply) => {
  app.log.warn(
    {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    },
    '[catch-all] unmatched request'
  );
  reply.code(404).send({ error: 'not found', path: request.url });
});

const port = Number(process.env.PORT ?? 3002);
const host = '0.0.0.0';

try {
  await app.listen({ port, host });
  app.log.info({ port, host }, `[${SERVICE_NAME}] listening`);
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
