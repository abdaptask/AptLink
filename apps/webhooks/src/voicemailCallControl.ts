// v0.10.100 - Full inbound-call flow over Telnyx Call Control.
//
// REPLACES the legacy DID -> SIP-credential -> Hosted Voicemail routing.
// All inbound calls to a migrated DID now flow through this handler.
//
// LIFECYCLE for one inbound call:
//
//   1. Caller dials DID -> Telnyx routes to the ACE Voicemail Voice API
//      app -> we receive `call.initiated` for the inbound (caller) leg.
//   2. We look up the user by DID. If found and they have a sipUsername,
//      we issue `transfer` on the caller leg with target
//      `sip:<sipUsername>@sip.telnyx.com` and `timeout_secs=25`. This
//      makes Telnyx ring the user's softphone(s) (registered against
//      that SIP credential) while keeping the caller leg alive and
//      playing carrier ringback to them.
//   3a. SOFTPHONE ANSWERS within 25s:
//       - `call.bridged` fires for both legs -> audio flows.
//       - When either party hangs up, `call.hangup` fires; we clean up.
//       - NO voicemail row is written.
//   3b. SOFTPHONE DOES NOT ANSWER (25s timeout, or rejected, or busy):
//       - `call.hangup` fires for the TRANSFER (dial) leg with a cause
//         other than `normal_clearing`/`call_completed`. The caller leg
//         is still alive - Telnyx kept it because of the transfer.
//       - We `answer` the caller leg, then play their custom greeting
//         (audio / TTS / default) - picked based on the hangup cause
//         (user_busy -> busy greeting; everything else -> no-answer
//         greeting; falls back to the no-answer greeting if busy is not
//         configured). Then record, then save a Voicemail row.
//   4. CALLER hangs up at any point: `call.hangup` for the caller leg
//      fires; we clean up and write no voicemail row.
//
// STATE - we pass everything via `client_state` (base64 JSON) on every
// action so this handler stays stateless across crashes / instance
// restarts. There is no in-memory map of in-flight calls.

import { prisma } from '@ace/db';

type LogFn = (obj: Record<string, unknown>, msg: string) => void;

// How long to ring the softphone before falling to voicemail.
const RING_TIMEOUT_SECS = 25;

function defaultGreetingFor(firstName: string | null): string {
  const name = (firstName ?? '').trim() || 'this user';
  return `You've reached ${name}'s voicemail. Please leave a message after the tone, and they'll get back to you as soon as possible.`;
}

// v0.10.100 - Swallow Telnyx error 90018 ("Call has already ended").
async function callControlAction(
  callControlId: string,
  action: string,
  body: Record<string, unknown>,
  logger: LogFn,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const apiKey = (process.env.TELNYX_API_KEY ?? '').trim();
  if (!apiKey) {
    logger({ action, callControlId }, '[vm-cc] TELNYX_API_KEY missing - cannot issue command');
    return { ok: false, status: 0, body: 'TELNYX_API_KEY missing' };
  }
  const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/${action}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const respBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errors = (respBody as { errors?: Array<{ code?: string }> })?.errors ?? [];
      const isCallEnded = errors.some((e) => e?.code === '90018');
      if (!isCallEnded) {
        logger({ action, status: res.status, respBody }, '[vm-cc] action failed');
      } else {
        logger({ action, callControlId }, '[vm-cc] action skipped (call already ended)');
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

interface UserGreetingFields {
  firstName: string | null;
  voicemailGreetingUrl: string | null;
  voicemailGreetingText: string | null;
  voicemailGreetingMode: string | null;
  voicemailBusyGreetingUrl: string | null;
  voicemailBusyGreetingText: string | null;
  voicemailBusyGreetingMode: string | null;
}

function pickGreeting(
  user: UserGreetingFields,
  reason: 'busy' | 'no_answer' | undefined,
): { mode: string; url: string | null; text: string | null } {
  if (reason === 'busy') {
    const mode = user.voicemailBusyGreetingMode;
    if (mode === 'audio' && user.voicemailBusyGreetingUrl) {
      return { mode: 'audio', url: user.voicemailBusyGreetingUrl, text: null };
    }
    if (mode === 'tts' && user.voicemailBusyGreetingText) {
      return { mode: 'tts', url: null, text: user.voicemailBusyGreetingText };
    }
    // Busy not configured - fall back to no-answer.
  }
  const mode = user.voicemailGreetingMode ?? 'default';
  if (mode === 'audio' && user.voicemailGreetingUrl) {
    return { mode: 'audio', url: user.voicemailGreetingUrl, text: null };
  }
  if (mode === 'tts' && user.voicemailGreetingText) {
    return { mode: 'tts', url: null, text: user.voicemailGreetingText };
  }
  return { mode: 'default', url: null, text: null };
}

async function playGreeting(
  callerCallId: string,
  user: UserGreetingFields,
  state: ClientState,
  logger: LogFn,
) {
  const picked = pickGreeting(user, state.reason);
  const clientState = encodeState(state);
  logger(
    { callerCallId, reason: state.reason, mode: picked.mode },
    '[vm-cc] playing greeting',
  );
  if (picked.mode === 'audio' && picked.url) {
    await callControlAction(
      callerCallId,
      'playback_start',
      { audio_url: picked.url, client_state: clientState },
      logger,
    );
  } else if (picked.mode === 'tts' && picked.text) {
    await callControlAction(
      callerCallId,
      'speak',
      {
        payload: picked.text,
        voice: 'female',
        language: 'en-US',
        client_state: clientState,
      },
      logger,
    );
  } else {
    await callControlAction(
      callerCallId,
      'speak',
      {
        payload: defaultGreetingFor(user.firstName),
        voice: 'female',
        language: 'en-US',
        client_state: clientState,
      },
      logger,
    );
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

export async function handleVoicemailCallControlEvent(
  event: TelnyxEventLike,
  loggerIn?: LogFn,
): Promise<void> {
  const logger: LogFn = loggerIn ?? ((o, m) => console.info(m, o));
  const payload = event.payload ?? {};
  const callControlId = payload.call_control_id ?? '';
  const state = decodeState(payload.client_state);

  switch (event.event_type) {
    // 1. INITIAL inbound call from carrier - issue transfer to SIP creds.
    case 'call.initiated': {
      if (state) {
        logger(
          { callControlId, stage: state.stage },
          '[vm-cc] call.initiated for tagged leg - no-op',
        );
        return;
      }

      const toNumber = (payload.to ?? '').toString();
      const fromNumber = (payload.from ?? '').toString();
      logger({ callControlId, toNumber, fromNumber }, '[vm-cc] call.initiated (caller leg)');
      if (!callControlId) return;

      const found = await findUserByDid(toNumber, logger);
      if (!found || !found.user.sipUsername) {
        logger(
          { toNumber, hasUser: !!found, hasSip: !!found?.user.sipUsername },
          '[vm-cc] cannot bridge - answering for voicemail directly',
        );
        const voicemailState: ClientState = {
          stage: 'voicemail_active',
          callerCallId: callControlId,
          fromNumber,
          toNumber,
          reason: 'no_answer',
        };
        await callControlAction(
          callControlId,
          'answer',
          { client_state: encodeState(voicemailState) },
          logger,
        );
        return;
      }

      const sipUri = `sip:${found.user.sipUsername}@sip.telnyx.com`;
      const transferState: ClientState = {
        stage: 'transfer_pending',
        callerCallId: callControlId,
        fromNumber,
        toNumber,
      };
      logger(
        { callControlId, toNumber, fromNumber, sipUri, timeout: RING_TIMEOUT_SECS },
        '[vm-cc] issuing transfer to SIP credential',
      );
      await callControlAction(
        callControlId,
        'transfer',
        {
          to: sipUri,
          from: fromNumber,
          timeout_secs: RING_TIMEOUT_SECS,
          client_state: encodeState(transferState),
        },
        logger,
      );
      break;
    }

    // 2. Bridge succeeded - softphone picked up. Audio flowing.
    case 'call.bridged': {
      logger({ callControlId, stage: state?.stage }, '[vm-cc] call.bridged');
      break;
    }

    // 3. Softphone answered, or we just answered the caller leg post-fail.
    case 'call.answered': {
      logger({ callControlId, stage: state?.stage }, '[vm-cc] call.answered');
      if (!state) return;
      if (state.stage === 'voicemail_active') {
        const found = await findUserByDid(state.toNumber, logger);
        if (!found) {
          await callControlAction(
            callControlId,
            'speak',
            {
              payload: 'You have reached ACE Dialer. Please leave a message after the tone.',
              voice: 'female',
              language: 'en-US',
              client_state: encodeState(state),
            },
            logger,
          );
        } else {
          await playGreeting(callControlId, found.user, state, logger);
        }
      }
      break;
    }

    // 4. Greeting finished -> start recording (with beep).
    case 'call.playback.ended':
    case 'call.speak.ended': {
      logger(
        { callControlId, ended: event.event_type, stage: state?.stage },
        '[vm-cc] greeting ended; start recording',
      );
      if (!callControlId || state?.stage !== 'voicemail_active') return;
      await callControlAction(
        callControlId,
        'record_start',
        {
          format: 'mp3',
          channels: 'single',
          play_beep: true,
          max_length: 300,
          timeout_secs: 4,
          client_state: encodeState(state),
        },
        logger,
      );
      break;
    }

    // 5. Greeting just started - log cleanly (no longer "unhandled").
    case 'call.playback.started':
    case 'call.speak.started': {
      logger(
        { callControlId, started: event.event_type, stage: state?.stage },
        '[vm-cc] greeting playing',
      );
      break;
    }

    // 6. Recording captured - write Voicemail row, hang up.
    case 'call.recording.saved': {
      logger({ callControlId, stage: state?.stage }, '[vm-cc] recording.saved');
      if (!callControlId) return;

      const rec = payload.recording_urls;
      let recordingUrl: string | null = null;
      if (rec && typeof rec === 'object' && !Array.isArray(rec) && Array.isArray(rec.mp3) && rec.mp3.length > 0) {
        recordingUrl = rec.mp3[0];
      } else if (Array.isArray(rec) && rec.length > 0) {
        recordingUrl = String(rec[0]);
      } else if (typeof rec === 'string') {
        recordingUrl = rec;
      } else if (typeof payload.recording_url === 'string') {
        recordingUrl = payload.recording_url;
      }

      const toNumber = state?.toNumber ?? (payload.to ?? '').toString();
      const fromNumber = state?.fromNumber ?? (payload.from ?? '').toString();

      if (recordingUrl && toNumber) {
        const found = await findUserByDid(toNumber, logger);
        if (found) {
          try {
            await prisma.voicemail.create({
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
            });
            logger(
              { userId: found.user.id, fromNumber, toNumber },
              '[vm-cc] voicemail row created',
            );
          } catch (e) {
            logger(
              { err: e instanceof Error ? e.message : String(e) },
              '[vm-cc] voicemail row insert failed',
            );
          }
        }
      }

      await callControlAction(
        callControlId,
        'hangup',
        {
          client_state: encodeState(
            state ?? {
              stage: 'voicemail_active',
              callerCallId: callControlId,
              fromNumber,
              toNumber,
            },
          ),
        },
        logger,
      );
      break;
    }

    // 7. Hangup - branch on which leg and what stage.
    case 'call.hangup': {
      const cause = (payload.hangup_cause ?? '').toString();
      const source = (payload.hangup_source ?? '').toString();
      logger(
        { callControlId, stage: state?.stage, cause, source },
        '[vm-cc] call.hangup',
      );

      if (
        state?.stage === 'transfer_pending' &&
        callControlId === state.callerCallId
      ) {
        logger({ callControlId, cause }, '[vm-cc] caller hung up during ring');
        return;
      }

      const busyCauses = new Set(['user_busy', 'call_rejected']);
      const noAnswerCauses = new Set([
        'originator_cancel',
        'no_answer',
        'no_user_response',
        'no_answer_timeout',
        'normal_temporary_failure',
        'recovery_on_timer_expire',
      ]);
      const dialLegFailedCauses = new Set([...busyCauses, ...noAnswerCauses]);

      if (state?.stage === 'transfer_pending' && dialLegFailedCauses.has(cause)) {
        const reason: 'busy' | 'no_answer' = busyCauses.has(cause) ? 'busy' : 'no_answer';
        logger(
          { callerCallId: state.callerCallId, cause, reason },
          '[vm-cc] dial leg failed - falling to voicemail',
        );
        const vmState: ClientState = {
          stage: 'voicemail_active',
          callerCallId: state.callerCallId,
          fromNumber: state.fromNumber,
          toNumber: state.toNumber,
          reason,
        };
        await callControlAction(
          state.callerCallId,
          'answer',
          { client_state: encodeState(vmState) },
          logger,
        );
        return;
      }

      break;
    }

    default:
      logger(
        { eventType: event.event_type, stage: state?.stage },
        '[vm-cc] unhandled event',
      );
  }
}
