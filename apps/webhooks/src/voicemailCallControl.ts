// v0.10.100 + fix - Full inbound-call flow over Telnyx Call Control.
//
// FIXES vs the initial v0.10.100:
//   1. We now SKIP the dial leg's own call.initiated event (Telnyx fires
//      one for the transfer destination, with toNumber starting with
//      "sip:"). We were trying to answer it and getting 422s.
//   2. We maintain an in-memory call_session_id -> ClientState map so we
//      can correlate the dial leg's call.hangup back to the caller leg
//      that originated the transfer. Telnyx's transfer action only sets
//      client_state on the caller leg, NOT on the dial leg.

import { prisma } from '@ace/db';
import { transcribeAndUpdateVoicemail } from './deepgram.js';
import { scheduleVoicemailTimeoutFallback } from './teamsNotifier.js';
import { scheduleVoicemailEmailTimeoutFallback } from './emailNotifier.js';

type LogFn = (obj: Record<string, unknown>, msg: string) => void;

const RING_TIMEOUT_SECS = 25;

/**
 * v0.10.117 - Classify Telnyx hangup_cause into our Call.status enum.
 * Mirrors the logic in main.ts so Recents shows the right label for
 * voicemail-cc-routed calls too.
 */
function classifyHangup(
  direction: string,
  hangupCause: string,
  wasAnswered: boolean,
): string {
  const lc = (hangupCause || '').toLowerCase();
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
  if (lc.includes('forward') || lc.includes('transfer') || lc.includes('redirect')) return 'forwarded';
  if (lc === 'normal_clearing' || lc === 'normal_termination' || lc === 'originator_cancel') return 'completed';
  return 'completed';
}

function defaultGreetingFor(firstName: string | null): string {
  const name = (firstName ?? '').trim() || 'this user';
  return `You've reached ${name}'s voicemail. Please leave a message after the tone, and they'll get back to you as soon as possible.`;
}

async function callControlAction(
  callControlId: string,
  action: string,
  body: Record<string, unknown>,
  logger: LogFn,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const apiKey = (process.env.TELNYX_API_KEY ?? '').trim();
  if (!apiKey) {
    logger({ action, callControlId }, '[vm-cc] TELNYX_API_KEY missing');
    return { ok: false, status: 0, body: 'TELNYX_API_KEY missing' };
  }
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/${action}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const respBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errors = (respBody as { errors?: Array<{ code?: string }> })?.errors ?? [];
      const benign = errors.some((e) => e?.code === '90018' || e?.code === '90102');
      if (benign) {
        logger({ action, callControlId, code: errors[0]?.code }, '[vm-cc] action skipped (benign error)');
      } else {
        logger({ action, status: res.status, respBody }, '[vm-cc] action failed');
      }
    }
    return { ok: res.ok, status: res.status, body: respBody };
  } catch (e) {
    logger({ action, err: e instanceof Error ? e.message : String(e) }, '[vm-cc] action threw');
    return { ok: false, status: 0, body: String(e) };
  }
}

async function findUserByDid(toNumber: string, logger: LogFn) {
  const tries = [toNumber];
  if (toNumber.startsWith('+1')) tries.push(toNumber.slice(2));
  for (const candidate of tries) {
    const userDid = await prisma.userDid.findFirst({
      where: { didNumber: candidate },
      select: {
        id: true,
        didNumber: true,
        user: {
          select: {
            id: true,
            firstName: true,
            sipUsername: true,
            voicemailGreetingUrl: true,
            voicemailGreetingText: true,
            voicemailGreetingMode: true,
            voicemailBusyGreetingUrl: true,
            voicemailBusyGreetingText: true,
            voicemailBusyGreetingMode: true,
          },
        },
      },
    });
    if (userDid?.user) return { userDid, user: userDid.user };
  }
  logger({ toNumber }, '[vm-cc] no user found for DID');
  return null;
}

interface ClientState {
  stage: 'transfer_pending' | 'voicemail_active';
  callerCallId: string;
  fromNumber: string;
  toNumber: string;
  reason?: 'busy' | 'no_answer';
}

function encodeState(s: ClientState): string {
  return Buffer.from(JSON.stringify(s)).toString('base64');
}
function decodeState(raw: unknown): ClientState | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const json = Buffer.from(raw, 'base64').toString('utf-8');
    const obj = JSON.parse(json) as ClientState;
    if (!obj?.stage || !obj?.callerCallId) return null;
    return obj;
  } catch {
    return null;
  }
}

const sessionMap = new Map<string, ClientState>();
function rememberSession(sessionId: string, state: ClientState) {
  if (!sessionId) return;
  sessionMap.set(sessionId, state);
  setTimeout(() => sessionMap.delete(sessionId), 10 * 60 * 1000);
}

interface UserGreetingFields {
  firstName: string | null;
  voicemailGreetingUrl: string | null;
  voicemailGreetingText: string | null;
  voicemailGreetingMode: string | null;
  voicemailBusyGreetingUrl: string | null;
  voicemailBusyGreetingText: string | null;
  voicemailBusyGreetingMode: string | null;
}

function pickGreeting(user: UserGreetingFields, reason: 'busy' | 'no_answer' | undefined) {
  if (reason === 'busy') {
    const mode = user.voicemailBusyGreetingMode;
    if (mode === 'audio' && user.voicemailBusyGreetingUrl) {
      return { mode: 'audio', url: user.voicemailBusyGreetingUrl, text: null as string | null };
    }
    if (mode === 'tts' && user.voicemailBusyGreetingText) {
      return { mode: 'tts', url: null as string | null, text: user.voicemailBusyGreetingText };
    }
  }
  const mode = user.voicemailGreetingMode ?? 'default';
  if (mode === 'audio' && user.voicemailGreetingUrl) {
    return { mode: 'audio', url: user.voicemailGreetingUrl, text: null as string | null };
  }
  if (mode === 'tts' && user.voicemailGreetingText) {
    return { mode: 'tts', url: null as string | null, text: user.voicemailGreetingText };
  }
  return { mode: 'default', url: null as string | null, text: null as string | null };
}

async function playGreeting(callerCallId: string, user: UserGreetingFields, state: ClientState, logger: LogFn) {
  const picked = pickGreeting(user, state.reason);
  const clientState = encodeState(state);
  logger({ callerCallId, reason: state.reason, mode: picked.mode }, '[vm-cc] playing greeting');
  if (picked.mode === 'audio' && picked.url) {
    await callControlAction(callerCallId, 'playback_start', { audio_url: picked.url, client_state: clientState }, logger);
  } else if (picked.mode === 'tts' && picked.text) {
    await callControlAction(callerCallId, 'speak', { payload: picked.text, voice: 'female', language: 'en-US', client_state: clientState }, logger);
  } else {
    await callControlAction(callerCallId, 'speak', { payload: defaultGreetingFor(user.firstName), voice: 'female', language: 'en-US', client_state: clientState }, logger);
  }
}

const BUSY_CAUSES = new Set(['user_busy', 'call_rejected']);
const NO_ANSWER_CAUSES = new Set([
  'originator_cancel', 'no_answer', 'no_user_response', 'no_answer_timeout',
  'normal_temporary_failure', 'recovery_on_timer_expire', 'request_timeout', 'timeout',
]);
const DIAL_LEG_FAILED_CAUSES = new Set([...Array.from(BUSY_CAUSES), ...Array.from(NO_ANSWER_CAUSES)]);

async function fallToVoicemail(state: ClientState, cause: string, logger: LogFn) {
  const reason: 'busy' | 'no_answer' = BUSY_CAUSES.has(cause) ? 'busy' : 'no_answer';
  logger({ callerCallId: state.callerCallId, cause, reason }, '[vm-cc] dial leg failed - falling to voicemail');
  const vmState: ClientState = {
    stage: 'voicemail_active',
    callerCallId: state.callerCallId,
    fromNumber: state.fromNumber,
    toNumber: state.toNumber,
    reason,
  };
  await callControlAction(state.callerCallId, 'answer', { client_state: encodeState(vmState) }, logger);
}

// v0.10.101 - Persist the Telnyx recording to our Supabase Storage bucket
// so the playback URL doesn't expire after 10 minutes. Fire-and-forget;
// failures are logged but never block the voicemail row creation.
async function persistRecordingToSupabase(
  voicemailId: number,
  userId: number,
  telnyxUrl: string,
  logger: LogFn,
): Promise<void> {
  const supabaseUrl = (process.env.SUPABASE_URL ?? '').trim();
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  const bucket = (process.env.SUPABASE_MEDIA_BUCKET ?? 'ace-media').trim();
  if (!supabaseUrl || !supabaseKey) {
    logger({ voicemailId }, '[vm-cc] Supabase not configured - leaving Telnyx URL (will expire in 10 min)');
    return;
  }
  try {
    // 1. Download the recording from Telnyx (while the signed URL is valid).
    const downloadRes = await fetch(telnyxUrl);
    if (!downloadRes.ok) {
      logger({ voicemailId, status: downloadRes.status }, '[vm-cc] failed to download recording from Telnyx');
      return;
    }
    const bytes = Buffer.from(await downloadRes.arrayBuffer());
    if (bytes.length === 0) {
      logger({ voicemailId }, '[vm-cc] Telnyx recording was empty - skipping persistence');
      return;
    }

    // 2. Upload to Supabase Storage.
    const objectPath = `voicemails/u${userId}/${voicemailId}.mp3`;
    const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${objectPath}`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'audio/mpeg',
        'x-upsert': 'true',
      },
      body: bytes,
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => '');
      logger({ voicemailId, status: uploadRes.status, errText }, '[vm-cc] Supabase upload failed');
      return;
    }

    // 3. Update the Voicemail row to the permanent public URL.
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
    await prisma.voicemail.update({
      where: { id: voicemailId },
      data: { recordingUrl: publicUrl },
    });
    logger({ voicemailId, publicUrl, bytes: bytes.length }, '[vm-cc] recording persisted to Supabase');
  } catch (e) {
    logger({ voicemailId, err: e instanceof Error ? e.message : String(e) }, '[vm-cc] persistence threw');
  }
}

interface TelnyxEventLike {
  event_type: string;
  payload?: Record<string, unknown> & {
    call_control_id?: string;
    call_session_id?: string;
    to?: string;
    from?: string;
    recording_urls?: { mp3?: string[] } | string[] | string;
    recording_url?: string;
    client_state?: string;
    hangup_cause?: string;
    hangup_source?: string;
  };
}

export async function handleVoicemailCallControlEvent(event: TelnyxEventLike, loggerIn?: LogFn): Promise<void> {
  const logger: LogFn = loggerIn ?? ((o, m) => console.info(m, o));
  const payload = event.payload ?? {};
  const callControlId = payload.call_control_id ?? '';
  const sessionId = (payload.call_session_id ?? '').toString();
  const state = decodeState(payload.client_state);

  switch (event.event_type) {
    case 'call.initiated': {
      const toNumber = (payload.to ?? '').toString();
      const fromNumber = (payload.from ?? '').toString();
      if (toNumber.toLowerCase().startsWith('sip:')) {
        logger({ callControlId, toNumber }, '[vm-cc] dial leg call.initiated (skipped, owned by transfer)');
        return;
      }
      if (state) {
        logger({ callControlId, stage: state.stage }, '[vm-cc] call.initiated for tagged leg - no-op');
        return;
      }
      logger({ callControlId, toNumber, fromNumber, sessionId }, '[vm-cc] call.initiated (caller leg)');
      if (!callControlId) return;
      const found = await findUserByDid(toNumber, logger);

      // v0.10.117 - Create a Call row so this call appears in Recents
      // alongside the eventual Voicemail row. Without this, migrated users
      // see voicemails in the Voicemail tab but no missed-call entry in
      // Recents. Use upsert so duplicate webhook events don't error.
      if (found?.user?.id) {
        try {
          await prisma.call.upsert({
            where: { telnyxCallId: callControlId },
            update: {
              callControlId,
              ...(sessionId ? { sessionId } : {}),
              ...(found.userDid.id ? { userDidId: found.userDid.id } : {}),
            },
            create: {
              userId: found.user.id,
              telnyxCallId: callControlId,
              sessionId: sessionId || null,
              callControlId,
              direction: 'inbound',
              fromNumber,
              toNumber,
              status: 'initiated',
              startedAt: payload.start_time ? new Date(payload.start_time as string) : new Date(),
              userDidId: found.userDid.id ?? null,
            },
          });
          logger({ telnyxCallId: callControlId, userId: found.user.id }, '[vm-cc] Call row upserted (initiated)');
        } catch (e) {
          logger({ err: e instanceof Error ? e.message : String(e) }, '[vm-cc] Call row upsert failed - non-fatal');
        }
      }

      if (!found || !found.user.sipUsername) {
        logger({ toNumber, hasUser: !!found, hasSip: !!found?.user.sipUsername }, '[vm-cc] cannot bridge - answering for voicemail directly');
        const voicemailState: ClientState = {
          stage: 'voicemail_active',
          callerCallId: callControlId,
          fromNumber,
          toNumber,
          reason: 'no_answer',
        };
        rememberSession(sessionId, voicemailState);
        await callControlAction(callControlId, 'answer', { client_state: encodeState(voicemailState) }, logger);
        return;
      }
      const sipUri = `sip:${found.user.sipUsername}@sip.telnyx.com`;
      const transferState: ClientState = {
        stage: 'transfer_pending',
        callerCallId: callControlId,
        fromNumber,
        toNumber,
      };
      rememberSession(sessionId, transferState);
      logger({ callControlId, toNumber, fromNumber, sipUri, timeout: RING_TIMEOUT_SECS }, '[vm-cc] issuing transfer to SIP credential');
      await callControlAction(callControlId, 'transfer', {
        to: sipUri,
        from: fromNumber,
        timeout_secs: RING_TIMEOUT_SECS,
        client_state: encodeState(transferState),
      }, logger);
      break;
    }

    case 'call.bridged': {
      logger({ callControlId, stage: state?.stage, sessionId }, '[vm-cc] call.bridged');
      break;
    }

    case 'call.answered': {
      logger({ callControlId, stage: state?.stage }, '[vm-cc] call.answered');
      if (!state) return;
      if (state.stage === 'voicemail_active') {
        const found = await findUserByDid(state.toNumber, logger);
        if (!found) {
          await callControlAction(callControlId, 'speak', {
            payload: 'You have reached ACE Dialer. Please leave a message after the tone.',
            voice: 'female',
            language: 'en-US',
            client_state: encodeState(state),
          }, logger);
        } else {
          await playGreeting(callControlId, found.user, state, logger);
        }
      }
      break;
    }

    case 'call.playback.ended':
    case 'call.speak.ended': {
      logger({ callControlId, ended: event.event_type, stage: state?.stage }, '[vm-cc] greeting ended; start recording');
      if (!callControlId || state?.stage !== 'voicemail_active') return;
      await callControlAction(callControlId, 'record_start', {
        format: 'mp3',
        channels: 'single',
        play_beep: true,
        max_length: 90,
        timeout_secs: 4,
        client_state: encodeState(state),
      }, logger);
      break;
    }

    case 'call.playback.started':
    case 'call.speak.started': {
      logger({ callControlId, started: event.event_type, stage: state?.stage }, '[vm-cc] greeting playing');
      break;
    }

    case 'call.recording.saved': {
      logger({ callControlId, stage: state?.stage }, '[vm-cc] recording.saved');
      if (!callControlId) return;
      // Telnyx v2 sends recording_urls as { mp3: 'url-string', wav: 'url-string' }
      // (single strings, not arrays). Older docs / call flows sometimes send
      // recording_urls.mp3 as an array. Also try public_recording_urls (the
      // CDN-fronted version) as fallback. And payload.recording_url for the
      // legacy single-URL field.
      const rec = payload.recording_urls as unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pub = (payload as any).public_recording_urls as unknown;
      let recordingUrl: string | null = null;
      const tryExtract = (obj: unknown): string | null => {
        if (!obj || typeof obj !== 'object') return null;
        const o = obj as Record<string, unknown>;
        if (typeof o.mp3 === 'string') return o.mp3;
        if (Array.isArray(o.mp3) && o.mp3.length > 0 && typeof o.mp3[0] === 'string') return o.mp3[0];
        if (typeof o.wav === 'string') return o.wav;
        if (Array.isArray(o.wav) && o.wav.length > 0 && typeof o.wav[0] === 'string') return o.wav[0];
        return null;
      };
      recordingUrl = tryExtract(rec) ?? tryExtract(pub);
      if (!recordingUrl && typeof rec === 'string') recordingUrl = rec;
      if (!recordingUrl && typeof payload.recording_url === 'string') recordingUrl = payload.recording_url;
      logger({ callControlId, recordingUrl, hasRec: !!rec, hasPub: !!pub }, '[vm-cc] recording URL extraction');
      const toNumber = state?.toNumber ?? (payload.to ?? '').toString();
      const fromNumber = state?.fromNumber ?? (payload.from ?? '').toString();
      if (recordingUrl && toNumber) {
        const found = await findUserByDid(toNumber, logger);
        if (found) {
          try {
            const created = await prisma.voicemail.create({
              data: {
                userId: found.user.id,
                userDidId: found.userDid.id,
                telnyxCallId: payload.call_session_id ?? null,
                fromNumber,
                toNumber,
                recordingUrl,
                durationSeconds: 0,
                transcription: null,
                receivedAt: new Date(),
              },
              select: { id: true },
            });
            logger({ userId: found.user.id, voicemailId: created.id, fromNumber, toNumber }, '[vm-cc] voicemail row created');
            // v0.10.101 - Persist the recording to Supabase BEFORE the Telnyx
            // signed URL expires (10 min). Fire-and-forget; updates the
            // Voicemail row's recordingUrl when done so playback never breaks.
            void persistRecordingToSupabase(created.id, found.user.id, recordingUrl, logger);
            // v0.10.100 fix - Fire transcription + Teams + email notifications,
            // matching the legacy /webhooks/telnyx/calls voicemail flow.
            void transcribeAndUpdateVoicemail(created.id, recordingUrl, found.user.id);
            scheduleVoicemailTimeoutFallback({ userId: found.user.id, voicemailId: created.id });
            scheduleVoicemailEmailTimeoutFallback({ userId: found.user.id, voicemailId: created.id });
          } catch (e) {
            logger({ err: e instanceof Error ? e.message : String(e) }, '[vm-cc] voicemail row insert failed');
          }
        }
      }
      await callControlAction(callControlId, 'hangup', {
        client_state: encodeState(state ?? {
          stage: 'voicemail_active',
          callerCallId: callControlId,
          fromNumber,
          toNumber,
        }),
      }, logger);
      if (sessionId) sessionMap.delete(sessionId);
      break;
    }

    case 'call.hangup': {
      const cause = (payload.hangup_cause ?? '').toString();
      const source = (payload.hangup_source ?? '').toString();
      logger({ callControlId, stage: state?.stage, cause, source, sessionId }, '[vm-cc] call.hangup');

      // v0.10.117 - Update the Call row's final status. The matching row
      // was created on call.initiated above. Only update the caller-leg's
      // Call row (skip dial-leg hangups which have a different
      // call_control_id). We identify the caller leg by checking if the
      // sessionMap entry's callerCallId matches this callControlId.
      const isCallerLeg =
        (state && callControlId === state.callerCallId) ||
        (!state && callControlId);
      if (isCallerLeg && callControlId) {
        try {
          const endedAt = payload.end_time ? new Date(payload.end_time as string) : new Date();
          const startedAt = payload.start_time ? new Date(payload.start_time as string) : null;
          const duration = startedAt ? Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000)) : 0;
          const existing = await prisma.call.findUnique({
            where: { telnyxCallId: callControlId },
            select: { status: true, answeredAt: true },
          });
          const wasAnswered = existing?.answeredAt != null;
          const finalStatus = classifyHangup('inbound', cause, wasAnswered);
          await prisma.call.updateMany({
            where: { telnyxCallId: callControlId },
            data: {
              status: finalStatus,
              hangupCause: cause || null,
              hangupSource: source || null,
              endedAt,
              durationSeconds: duration,
            },
          });
          logger({ telnyxCallId: callControlId, finalStatus, cause }, '[vm-cc] Call row updated (hangup)');
        } catch (e) {
          logger({ err: e instanceof Error ? e.message : String(e) }, '[vm-cc] Call row hangup-update failed - non-fatal');
        }
      }

      // Case A - Dial leg hung up. Telnyx fires this on the dial-leg
      // call_control_id (different from the caller leg's). Doesn't matter
      // whether source is 'caller' or 'callee' - what matters is the
      // call_session_id matches a tracked caller leg AND this isn't the
      // caller leg itself AND the cause is a dial failure.
      const tracked = sessionId ? sessionMap.get(sessionId) : null;
      if (
        !state &&
        tracked &&
        tracked.stage === 'transfer_pending' &&
        callControlId !== tracked.callerCallId &&
        DIAL_LEG_FAILED_CAUSES.has(cause)
      ) {
        sessionMap.delete(sessionId);
        await fallToVoicemail(tracked, cause, logger);
        return;
      }

      if (state?.stage === 'transfer_pending' && callControlId === state.callerCallId && source === 'caller') {
        logger({ callControlId, cause }, '[vm-cc] caller hung up during ring');
        if (sessionId) sessionMap.delete(sessionId);
        return;
      }

      if (state?.stage === 'transfer_pending' && DIAL_LEG_FAILED_CAUSES.has(cause)) {
        if (sessionId) sessionMap.delete(sessionId);
        await fallToVoicemail(state, cause, logger);
        return;
      }

      if (sessionId) sessionMap.delete(sessionId);
      break;
    }

    default:
      logger({ eventType: event.event_type, stage: state?.stage }, '[vm-cc] unhandled event');
  }
}