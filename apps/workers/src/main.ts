import { Worker } from 'bullmq';
import { prisma } from '@ace/db';
import { transcribeAndUpdateVoicemail } from './deepgram.js';
import {
  notifyInboundSms,
  scheduleMissedCallNotification,
  scheduleVoicemailTimeoutFallback,
} from './teamsNotifier.js';
import {
  notifyInboundSmsByEmail,
  scheduleMissedCallEmail,
  scheduleVoicemailEmailTimeoutFallback,
} from './emailNotifier.js';
import { handleVoicemailCallControlEvent } from './voicemailCallControl.js';

const TELNYX_API_KEY = process.env.TELNYX_API_KEY ?? '';
const FALLBACK_USER_ID = Number(process.env.PILOT_USER_ID ?? 1);
const PILOT_NUMBER = process.env.PILOT_TELNYX_NUMBER ?? '+17322001305';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

const redisUrlObj = new URL(REDIS_URL);
const redisConnectionOptions = {
  host: redisUrlObj.hostname,
  port: Number(redisUrlObj.port || 6379),
  username: redisUrlObj.username || undefined,
  password: redisUrlObj.password || undefined,
  tls: redisUrlObj.protocol === 'rediss:' ? {} : undefined,
  maxRetriesPerRequest: null,
};

function last10(p: string | undefined | null): string {
  return (p ?? '').replace(/[^\d]/g, '').slice(-10);
}

async function resolveUserAndDid(opts: {
  sipUsername?: string | null;
  fromNumber?: string | null;
  toNumber?: string | null;
  direction?: 'inbound' | 'outbound';
  connectionId?: string | null;
}): Promise<{ userId: number | null; userDidId: number | null }> {
  let userId: number | null = null;
  let userDidId: number | null = null;

  if (opts.connectionId) {
    const sharedIds = [
      (process.env.TELNYX_VOICEMAIL_CC_APP_ID ?? '').trim(),
      (process.env.PILOT_SIP_CONNECTION_ID ?? '').trim(),
    ].filter((s) => s.length > 0);
    const isSharedConnId = sharedIds.includes(opts.connectionId);
    if (!isSharedConnId) {
      const did = await prisma.userDid.findFirst({
        where: {
          OR: [
            { connectionId: opts.connectionId },
            { preMigrationConnectionId: opts.connectionId },
          ],
          userId: { not: null },
        },
        select: { id: true, userId: true },
      });
      if (did?.userId != null) {
        userId = did.userId;
        userDidId = did.id;
      }
    }
  }

  if (userId === null && opts.sipUsername) {
    const u = await prisma.user.findFirst({
      where: { sipUsername: opts.sipUsername },
      select: { id: true },
    });
    if (u) userId = u.id;
  }

  if (userId === null && opts.toNumber) {
    const candidate = opts.toNumber.toString().trim();
    if (
      candidate.length > 0 &&
      !candidate.startsWith('+') &&
      !candidate.startsWith('sip:') &&
      !/^\d/.test(candidate) &&
      !candidate.includes('@')
    ) {
      const u = await prisma.user.findFirst({
        where: { sipUsername: candidate },
        select: { id: true },
      });
      if (u) userId = u.id;
    }
  }

  const matchAgainst =
    opts.direction === 'outbound' ? opts.fromNumber : opts.toNumber;
  const matchLast10 = last10(matchAgainst ?? '');
  if (matchLast10.length === 10) {
    const allDids = await prisma.userDid.findMany({
      where: { userId: { not: null } },
      select: { id: true, userId: true, didNumber: true },
    });
    const match = allDids.find((d) => last10(d.didNumber) === matchLast10);
    if (match) {
      userDidId = match.id;
      if (opts.direction === 'inbound') {
        userId = match.userId ?? userId;
      } else if (userId === null) {
        userId = match.userId ?? null;
      }
    }
  }

  return { userId, userDidId };
}

async function isFromNumberBlockedForUser(
  userId: number,
  fromNumber: string | null | undefined,
): Promise<boolean> {
  if (!fromNumber || !userId) return false;
  const l10 = fromNumber.replace(/[^\d]/g, '').slice(-10);
  if (!l10) return false;
  try {
    const rows = await prisma.blockedNumber.findMany({
      where: { userId },
      select: { number: true },
    });
    return rows.some((r) => r.number.replace(/[^\d]/g, '').slice(-10) === l10);
  } catch (e) {
    console.warn('[blocked] lookup failed; treating as not blocked', e);
    return false;
  }
}

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

interface NormalizedVmPayload {
  fromNumber: string;
  toNumber?: string;
  recordingUrl: string;
  durationSeconds: number;
  telnyxCallId?: string;
  receivedAt: Date;
  transcription?: string;
  connectionId?: string;
}
async function processVoicemail(
  payload: NormalizedVmPayload,
  source: string,
): Promise<{ stored: boolean; reason?: string; voicemailId?: number }> {
  const { userId: ownerUserId, userDidId } = await resolveUserAndDid({
    toNumber: payload.toNumber,
    fromNumber: payload.fromNumber,
    direction: 'inbound',
    connectionId: payload.connectionId ?? null,
  });
  if (ownerUserId === null) {
    console.warn(
      `[vm] could not attribute voicemail from ${payload.fromNumber} - skipping`,
    );
    return { stored: false, reason: 'unattributable' };
  }
  if (await isFromNumberBlockedForUser(ownerUserId, payload.fromNumber)) {
    console.info(
      `[vm] voicemail from blocked number ${payload.fromNumber} - dropping`,
    );
    return { stored: false, reason: 'blocked' };
  }
  if (payload.telnyxCallId) {
    const dupCheck = await prisma.voicemail.findFirst({
      where: { telnyxCallId: payload.telnyxCallId },
      select: { id: true },
    });
    if (dupCheck) {
      console.info(
        `[vm] dedup: row with this telnyxCallId ${payload.telnyxCallId} already exists, skipping`,
      );
      return { stored: false, reason: 'duplicate', voicemailId: dupCheck.id };
    }
  }
  const created = await prisma.voicemail.create({
    data: {
      userId: ownerUserId,
      telnyxCallId: payload.telnyxCallId ?? null,
      fromNumber: payload.fromNumber,
      toNumber: payload.toNumber ?? PILOT_NUMBER,
      recordingUrl: payload.recordingUrl,
      durationSeconds: payload.durationSeconds,
      transcription: payload.transcription ?? null,
      receivedAt: payload.receivedAt,
      userDidId,
    },
  });
  console.info(
    `[vm] voicemail recorded: ${created.id}`,
  );
  // Fire-and-forget Deepgram transcription if we don't already have
  // a transcript from Telnyx.
  if (!payload.transcription) {
    void transcribeAndUpdateVoicemail(created.id, payload.recordingUrl, ownerUserId);
  }

  // v0.10.0 Task 8 — Teams voicemail card.
  scheduleVoicemailTimeoutFallback({
    userId: ownerUserId,
    voicemailId: created.id,
  });
  // v0.10.79 — parallel email voicemail notification.
  scheduleVoicemailEmailTimeoutFallback({
    userId: ownerUserId,
    voicemailId: created.id,
  });

  return { stored: true, voicemailId: created.id };
}

const worker = new Worker(
  'telnyx-webhooks',
  async (job) => {
    const { type, data } = job as any;
    console.log(`Processing job ${job.id} of type ${type}`);

    try {
      if (type === 'call') {
        const { eventType, payload } = data;
        const callControlId: string | undefined = payload.call_control_id;
        const sessionId: string | undefined = payload.call_session_id;
        const callId: string | undefined = callControlId ?? sessionId;
        if (!callId) return;

        const direction = payload.direction === 'outgoing' ? 'outbound' : 'inbound';
        const fromNumber: string = payload.from ?? '';
        const toNumber: string = payload.to ?? '';

        switch (eventType) {
          case 'call.initiated': {
            const { userId: ownerUserId, userDidId } = await resolveUserAndDid({
              sipUsername: payload.sip_username ?? payload.client_username ?? null,
              fromNumber,
              toNumber,
              direction,
              connectionId: payload.connection_id ?? null,
            });

            if (ownerUserId === null) {
              console.warn(`[telnyx] could not attribute call ${callId} to a user - skipping row creation`);
              break;
            }

            const blocked =
              direction === 'inbound' &&
              (await isFromNumberBlockedForUser(ownerUserId, fromNumber));
            if (blocked) {
              console.info(`[blocked] inbound call from blocked number ${fromNumber} - rejecting with USER_BUSY`);
              if (callControlId) {
                void rejectCallByControlId(callControlId).catch((e) =>
                  console.warn('[blocked] reject API failed', e),
                );
              }
            }

            await prisma.call.upsert({
              where: { telnyxCallId: callId },
              update: {
                ...(blocked ? { status: 'blocked' } : {}),
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

            if (eventType === 'call.answered' && callControlId) {
              const state = decodeClientState(payload.client_state);
              if (state?.joinConfId) {
                console.info(`[webhook] auto-joining conference: ${state.joinConfId}`);
                const result = await joinConference(state.joinConfId, callControlId, {
                  endConfOnExit: state.endConfOnExit ?? false,
                });
                if (!result.ok) {
                  console.error('[webhook] auto-join failed', result);
                }
              } else if (state?.bridgeTo && state.autoBridge !== false) {
                console.info(`[webhook] auto-bridging on answer (legacy): ${state.bridgeTo}`);
                const result = await bridgeLegs(state.bridgeTo, callControlId);
                if (!result.ok) {
                  console.error('[webhook] auto-bridge failed', result);
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
            const lc = hangupCause.toLowerCase();

            const priorCall = callId
              ? await prisma.call.findFirst({
                  where: { telnyxCallId: callId },
                  select: { answeredAt: true },
                })
              : null;
            const wasAnswered = priorCall?.answeredAt != null;
            const status: string = (() => {
              if (direction === 'inbound' && !wasAnswered) {
                if (lc === 'call_rejected' || lc === 'rejected') return 'rejected';
                if (lc === 'user_busy' || lc === 'busy') return 'busy';
                if (lc === 'originator_cancel') return 'caller_canceled';
                if (lc.includes('forward') || lc.includes('transfer') || lc.includes('redirect')) return 'forwarded';
                if (lc === 'no_answer' || lc === 'no_user_response') return 'no_answer';
                return 'missed';
              }
              if (lc === 'no_answer' || lc === 'no_user_response') return 'no_answer';
              if (lc === 'call_rejected' || lc === 'rejected') return 'rejected';
              if (lc === 'user_busy' || lc === 'busy') return 'busy';
              if (lc.includes('forward') || lc.includes('transfer') || lc.includes('redirect')) {
                return 'forwarded';
              }
              if (
                lc === 'normal_clearing' ||
                lc === 'normal_termination' ||
                lc === 'originator_cancel'
              ) {
                return 'completed';
              }
              return 'completed';
            })();

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
              const ownerUserId = await resolveUserAndDid({
                sipUsername: payload.sip_username ?? payload.client_username ?? null,
                fromNumber,
                toNumber,
                connectionId: payload.connection_id ?? null,
              }).then(res => res.userId);

              if (ownerUserId !== null) {
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
            }

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
              scheduleMissedCallEmail({
                userId: row.userId,
                callDbId: row.id,
                telnyxCallId: callId,
              });
            }
            break;
          }

          case 'call.recording.saved': {
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
            const vmFrom: string = payload.from ?? '';
            const vmTo: string = payload.to ?? '';
            const recordingUrl: string | null = payload.recording_url ?? null;
            const durRaw =
              payload.recording_duration ??
              payload.duration ??
              (payload.recording_duration_millis != null
                ? Number(payload.recording_duration_millis) / 1000
                : null) ??
              (payload.recording?.duration ?? null);
            const durSec = Number(durRaw ?? 0);

            if (!recordingUrl) {
              console.warn('[vm] calls.voicemail.completed missing recording_url');
              break;
            }

            await processVoicemail({
              fromNumber: vmFrom,
              toNumber: vmTo,
              recordingUrl,
              durationSeconds: Math.max(1, Math.round(durSec)),
              telnyxCallId: callId,
              receivedAt: payload.start_time ? new Date(payload.start_time) : new Date(),
              transcription: payload.transcription_text ?? undefined,
              connectionId: payload.connection_id ?? undefined,
            }, 'hosted-vm');
            break;
          }
        }
      } else if (type === 'sms') {
        const { eventType, payload } = data;
        const telnyxMessageId: string | undefined = payload.id;
        if (!telnyxMessageId) return;

        const text: string = payload.text ?? '';
        const mediaUrls: string[] = Array.isArray(payload.media)
          ? payload.media.map((m: any) => m?.url).filter((u: any) => typeof u === 'string')
          : [];
        const fromNumber: string = payload.from?.phone_number ?? '';
        const toNumber: string = Array.isArray(payload.to) && payload.to[0]?.phone_number
          ? payload.to[0].phone_number
          : payload.to?.phone_number ?? '';

        switch (eventType) {
          case 'message.received': {
            const threadKey = fromNumber;
            const { userId: ownerUserId, userDidId } = await resolveUserAndDid({
              toNumber,
              fromNumber,
              direction: 'inbound',
              connectionId: payload.connection_id ?? null,
            });

            if (ownerUserId === null) {
              console.warn(`[sms] could not attribute message ${telnyxMessageId} - skipping`);
              break;
            }

            if (await isFromNumberBlockedForUser(ownerUserId, fromNumber)) {
              console.info(`[blocked] inbound SMS from blocked number ${fromNumber} - dropping`);
              break;
            }

            const existingMessage = await prisma.message.findUnique({
              where: { telnyxMessageId },
              select: { id: true },
            });

            if (existingMessage) {
              await prisma.message.update({
                where: { telnyxMessageId },
                data: { status: 'received' },
              });
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
              if (created.direction === 'inbound') {
                void notifyInboundSms({
                  userId: ownerUserId,
                  messageDbId: created.id,
                }).catch((e) =>
                  console.warn('[teams] notifyInboundSms threw', e),
                );
                void notifyInboundSmsByEmail({
                  userId: ownerUserId,
                  messageDbId: created.id,
                }).catch((e) =>
                  console.warn('[email] notifyInboundSmsByEmail threw', e),
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
        }
      } else if (type === 'voicemail') {
        const {
          fromNumber,
          toNumber,
          recordingUrl,
          durationSeconds,
          telnyxCallId,
          receivedAt,
          transcription,
          connectionId,
          source,
        } = data;
        await processVoicemail({
          fromNumber,
          toNumber,
          recordingUrl,
          durationSeconds,
          telnyxCallId,
          receivedAt: new Date(receivedAt),
          transcription,
          connectionId,
        }, source);
      } else if (type === 'voicemail-cc') {
        const { event } = data;
        await handleVoicemailCallControlEvent(event, (obj, msg) => console.log(msg, obj));
      }
    } catch (err) {
      console.error(`Error processing job ${job.id} type ${type}:`, err);
      throw err;
    }
  },
  {
    connection: redisConnectionOptions,
  }
);

console.log('BullMQ Workers pool started and listening for telnyx-webhooks...');
