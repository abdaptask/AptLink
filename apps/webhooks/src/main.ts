// ACE Dialer Webhooks — Telnyx inbound webhook receiver.
// Phase 5.1: persist call lifecycle events to the database.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { prisma } from '@ace/db';

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
 *     against users.did_number. Whichever side matches a known DID is the
 *     owner.
 *   - Fall back to FALLBACK_USER_ID if nothing matches.
 */
async function resolveUserId(opts: {
  sipUsername?: string | null;
  fromNumber?: string | null;
  toNumber?: string | null;
}): Promise<number> {
  // 1. SIP username (exact match)
  if (opts.sipUsername) {
    const u = await prisma.user.findFirst({
      where: { sipUsername: opts.sipUsername },
      select: { id: true },
    });
    if (u) return u.id;
  }
  // 2. DID match — last10 digits of either from or to.
  const candidates = [opts.toNumber, opts.fromNumber]
    .map(last10)
    .filter((d) => d.length === 10);
  if (candidates.length > 0) {
    const allUsersWithDid = await prisma.user.findMany({
      where: { didNumber: { not: null } },
      select: { id: true, didNumber: true },
    });
    for (const c of candidates) {
      const match = allUsersWithDid.find((u) => last10(u.didNumber) === c);
      if (match) return match.id;
    }
  }
  return FALLBACK_USER_ID;
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

// SIP realm to dial when bridging an inbound call to the WebRTC user.
// Default: sip.telnyx.com. For credential-based connections this is correct.
const SIP_REALM = process.env.SIP_REALM ?? 'sip.telnyx.com';

// ---------- Telnyx Call Control helpers (voicemail flow) ----------
// Programmatic answer + dial-out + speak + record. Used by the Voicemail
// Option B flow: PSTN call → answer → dial sip:USERNAME → on no-answer/decline,
// speak greeting + record on the parent leg.

async function tcc(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!TELNYX_API_KEY) {
    return { ok: false, status: 0, data: 'TELNYX_API_KEY not set' };
  }
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TELNYX_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Encode arbitrary state as base64 so Telnyx echoes it back on subsequent
// events for this leg. Lets us track multi-step flows across webhooks.
function encodeClientState(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

async function answerCall(callControlId: string, clientState?: string): Promise<{ ok: boolean; data: unknown }> {
  return tcc(`/calls/${encodeURIComponent(callControlId)}/actions/answer`, {
    ...(clientState ? { client_state: clientState } : {}),
  });
}

async function speakOnCall(callControlId: string, text: string, opts: { clientState?: string } = {}): Promise<{ ok: boolean; data: unknown }> {
  return tcc(`/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
    payload: text,
    voice: 'female',
    language: 'en-US',
    ...(opts.clientState ? { client_state: opts.clientState } : {}),
  });
}

async function recordStartOnCall(callControlId: string, clientState?: string): Promise<{ ok: boolean; data: unknown }> {
  return tcc(`/calls/${encodeURIComponent(callControlId)}/actions/record_start`, {
    format: 'mp3',
    channels: 'single',
    ...(clientState ? { client_state: clientState } : {}),
  });
}

async function hangupCall(callControlId: string): Promise<{ ok: boolean; data: unknown }> {
  return tcc(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {});
}

// Originate a new outbound leg via Call Control. Returns the new
// call_control_id immediately (no need to wait for webhook).
async function dialOutbound(opts: {
  to: string;
  from: string;
  connectionId: string;
  clientState: string;
  timeoutSecs?: number;
}): Promise<{ ok: boolean; callControlId?: string; data: unknown }> {
  const r = await tcc('/calls', {
    to: opts.to,
    from: opts.from,
    connection_id: opts.connectionId,
    client_state: opts.clientState,
    timeout_secs: opts.timeoutSecs ?? 25,
    ...(opts.timeoutSecs ? { time_limit_secs: opts.timeoutSecs + 10 } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ccid = (r.data as any)?.data?.call_control_id;
  return { ok: r.ok, callControlId: ccid, data: r.data };
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  ignoreTrailingSlash: true,
});

await app.register(cors, { origin: false });

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
        const ownerUserId = await resolveUserId({
          sipUsername: payload.sip_username ?? payload.client_username ?? null,
          fromNumber,
          toNumber,
        });
        await prisma.call.upsert({
          where: { telnyxCallId: callId },
          update: {
            status: 'initiated',
            ...(callControlId ? { callControlId } : {}),
          },
          create: {
            userId: ownerUserId,
            telnyxCallId: callId,
            sessionId: payload.call_session_id ?? null,
            callControlId: callControlId ?? null,
            direction,
            fromNumber,
            toNumber,
            status: 'initiated',
            startedAt: payload.start_time ? new Date(payload.start_time) : new Date(),
          },
        });

        // Voicemail flow (Option B). When an inbound PSTN call arrives at
        // this connection AND there's no client_state (so it's a fresh
        // inbound, not a server-originated leg from Add Call), we take over
        // the call: answer it, dial out to the SIP user with a 25-second
        // timeout, and on no-answer fall through to greeting + record.
        const incomingClientState = decodeClientState(payload.client_state);
        const isFreshInbound =
          direction === 'inbound' &&
          callControlId &&
          !incomingClientState?.bridgeTo &&
          !incomingClientState?.joinConfId &&
          !(incomingClientState as { vmFlow?: string } | null)?.vmFlow;
        if (isFreshInbound) {
          // Find the SIP user that owns this DID.
          const owner = await prisma.user.findUnique({
            where: { id: ownerUserId },
            select: { sipUsername: true },
          });
          const sipUser = owner?.sipUsername ?? process.env.PILOT_SIP_USERNAME;
          const connectionIdEnv = process.env.PILOT_SIP_CONNECTION_ID;
          if (!sipUser || !connectionIdEnv) {
            app.log.warn(
              { sipUser: Boolean(sipUser), connectionIdEnv: Boolean(connectionIdEnv) },
              '[vm] missing PILOT_SIP_USERNAME or PILOT_SIP_CONNECTION_ID — cannot start voicemail flow',
            );
          } else {
            // Step 1: answer the parent leg so we can control it. State
            // tells later events "this leg is mid-vm-flow".
            const parentState = encodeClientState({
              vmFlow: 'parent',
              parentLeg: callControlId,
              fromNumber,
              toNumber,
              ownerUserId,
            });
            const ans = await answerCall(callControlId, parentState);
            app.log.info({ ok: ans.ok }, '[vm] answered parent leg');

            // Step 2: dial out to the SIP user with a 25s ring timeout.
            // We tag the dialed leg's client_state so its events identify
            // back to the parent.
            const dialState = encodeClientState({
              vmFlow: 'dial',
              parentLeg: callControlId,
              fromNumber,
              toNumber,
              ownerUserId,
            });
            const dial = await dialOutbound({
              to: `sip:${sipUser}@${SIP_REALM}`,
              from: fromNumber || PILOT_NUMBER,
              connectionId: connectionIdEnv,
              clientState: dialState,
              timeoutSecs: 25,
            });
            app.log.info(
              { ok: dial.ok, dialedCcId: dial.callControlId, to: sipUser },
              '[vm] dialed SIP user',
            );
          }
        }
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

        // Voicemail flow — Step 3: the dialed leg answered (dialer picked
        // up). Bridge it to the parent inbound call so caller and dialer
        // can talk. No voicemail needed.
        if (event.event_type === 'call.answered' && callControlId) {
          const state = decodeClientState(payload.client_state) as
            | { vmFlow?: string; parentLeg?: string }
            | null;
          if (state?.vmFlow === 'dial' && state.parentLeg) {
            const r = await bridgeLegs(state.parentLeg, callControlId);
            app.log.info({ ok: r.ok }, '[vm] bridged dialed leg → parent');
          }
        }

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
        const status =
          hangupCause === 'normal_clearing' || hangupCause === 'normal_termination'
            ? 'completed'
            : hangupCause === 'no_answer'
              ? 'no_answer'
              : 'failed';

        // Try update first; if no record (we missed call.initiated), insert.
        const updated = await prisma.call.updateMany({
          where: { telnyxCallId: callId },
          data: {
            status,
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

        // Voicemail flow — Step 4: the dialed leg ended without ever being
        // answered (no-answer, declined, busy). The parent leg is still
        // alive (we answered it). Speak the greeting + start recording on
        // the parent. The Record action fires call.recording.saved when
        // done, which we handle below.
        {
          const hangupState = decodeClientState(payload.client_state) as
            | { vmFlow?: string; parentLeg?: string; fromNumber?: string; toNumber?: string; ownerUserId?: number }
            | null;
          const wasDialAttempt = hangupState?.vmFlow === 'dial' && hangupState.parentLeg;
          const dialerNeverAnswered =
            hangupCause === 'no_answer' ||
            hangupCause === 'call_rejected' ||
            hangupCause === 'normal_clearing' ||
            hangupCause === 'timeout' ||
            hangupCause === 'user_busy';
          if (wasDialAttempt && dialerNeverAnswered && hangupState.parentLeg) {
            app.log.info(
              { parentLeg: hangupState.parentLeg, cause: hangupCause },
              '[vm] dialed leg ended without bridge → starting voicemail on parent',
            );
            const greeting =
              process.env.PILOT_VOICEMAIL_GREETING ??
              "You've reached ACE Dialer. Please leave a message after the tone, then hang up.";
            // Tag the parent with vmFlow='recording' so call.recording.saved
            // knows to save a Voicemail row (not just a call recording).
            const recState = encodeClientState({
              vmFlow: 'recording',
              parentLeg: hangupState.parentLeg,
              fromNumber: hangupState.fromNumber ?? fromNumber,
              toNumber: hangupState.toNumber ?? toNumber,
              ownerUserId: hangupState.ownerUserId,
            });
            const sp = await speakOnCall(hangupState.parentLeg, greeting, { clientState: recState });
            app.log.info({ ok: sp.ok }, '[vm] spoke greeting on parent');
            const rec = await recordStartOnCall(hangupState.parentLeg, recState);
            app.log.info({ ok: rec.ok }, '[vm] record_start on parent');
          }
        }
        break;
      }

      case 'call.recording.saved': {
        const recordingUrls: string[] = payload.recording_urls?.mp3 ?? payload.recording_urls ?? [];
        const recState = decodeClientState(payload.client_state) as
          | { vmFlow?: string; fromNumber?: string; toNumber?: string; ownerUserId?: number }
          | null;
        if (recState?.vmFlow === 'recording' && recordingUrls.length > 0) {
          // Voicemail flow — Step 5: caller finished speaking, save the
          // voicemail row + hang up the parent leg so we don't keep it open.
          try {
            const ownerUserId =
              recState.ownerUserId ??
              (await resolveUserId({
                fromNumber: recState.fromNumber ?? null,
                toNumber: recState.toNumber ?? null,
              }));
            const durSec = Number(payload.recording_duration_millis ?? 0) / 1000;
            await prisma.voicemail.create({
              data: {
                userId: ownerUserId,
                telnyxCallId: callId,
                fromNumber: recState.fromNumber ?? fromNumber ?? '',
                toNumber: recState.toNumber ?? toNumber ?? '',
                recordingUrl: recordingUrls[0],
                durationSeconds: Math.max(1, Math.round(durSec)),
                transcription: payload.transcription_text ?? null,
                receivedAt: new Date(),
              },
            });
            app.log.info({ recording: recordingUrls[0] }, '[vm] voicemail row created');
          } catch (e) {
            app.log.error({ err: e }, '[vm] failed to write Voicemail row');
          }
          // Hang up the parent leg so we don't keep the line open.
          if (callControlId) await hangupCall(callControlId).catch(() => undefined);
        } else if (recordingUrls.length > 0) {
          // Generic call recording — attach to call row (existing behavior).
          await prisma.call.updateMany({
            where: { telnyxCallId: callId },
            data: { recordingUrl: recordingUrls[0] },
          });
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
        const threadKey = fromNumber; // the other party
        const ownerUserId = await resolveUserId({ toNumber, fromNumber });
        await prisma.message.upsert({
          where: { telnyxMessageId },
          update: { status: 'received' },
          create: {
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
          },
        });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const texmlHandler = (request: any): string => {
  const sipUser = process.env.PILOT_SIP_USERNAME ?? '';
  const greeting =
    process.env.PILOT_VOICEMAIL_GREETING ??
    "You've reached ACE Dialer. Please leave a message after the tone, then press pound or hang up.";

  if (!sipUser) {
    app.log.warn('[texml] PILOT_SIP_USERNAME not set; returning hangup-only flow');
  }

  // Build an ABSOLUTE URL for the Record action — Telnyx requires absolute
  // URLs for callbacks. Prefer an explicit env var, fall back to the host
  // header Telnyx hit us on (Render sets x-forwarded-proto correctly).
  const proto = (request?.headers?.['x-forwarded-proto'] as string) ?? 'https';
  const host = (request?.headers?.host as string) ?? 'ace-dialer-webhooks.onrender.com';
  const baseUrl = (process.env.WEBHOOKS_PUBLIC_URL ?? `${proto}://${host}`).replace(/\/+$/, '');
  const recordAction = `${baseUrl}/webhooks/telnyx/voicemail`;

  // Telnyx's TexML reference is a Twilio-compatible subset. Sticking to the
  // safe core verbs/attributes to avoid parser errors:
  //   <Dial><Sip>…</Sip></Dial>            → bridge to SIP target
  //   timeout                              → seconds before no-answer fallthrough
  //   <Say voice="alice">                  → standard TTS voice; Polly.* voices
  //                                          aren't always accepted.
  //   <Record action maxLength playBeep>   → record + POST to action URL
  //   <Hangup/>                            → end the call
  const xml = sipUser
    ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="25">
    <Sip>sip:${xmlEscape(sipUser)}@sip.telnyx.com</Sip>
  </Dial>
  <Say voice="alice">${xmlEscape(greeting)}</Say>
  <Record maxLength="120" playBeep="true" action="${xmlEscape(recordAction)}" method="POST" finishOnKey="#" />
  <Hangup/>
</Response>`
    : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Service not yet configured.</Say>
  <Hangup/>
</Response>`;

  return xml;
};

app.get('/texml/inbound', async (request, reply) => {
  const xml = texmlHandler(request);
  app.log.info({ length: xml.length, sipUser: Boolean(process.env.PILOT_SIP_USERNAME) }, '[texml] inbound served');
  reply.type('application/xml; charset=utf-8').send(xml);
});
app.post('/texml/inbound', async (request, reply) => {
  const xml = texmlHandler(request);
  app.log.info({ length: xml.length, sipUser: Boolean(process.env.PILOT_SIP_USERNAME) }, '[texml] inbound served');
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
    const ownerUserId = await resolveUserId({ toNumber, fromNumber });
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
