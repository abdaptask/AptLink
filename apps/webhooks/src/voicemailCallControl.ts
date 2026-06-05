// v0.10.99 — Custom voicemail via Telnyx Call Control.
//
// REPLACES Telnyx Hosted Voicemail (which only supports a default robotic
// greeting). This module handles the full call lifecycle when an inbound
// call falls to voicemail:
//
//   1. Caller dials user's DID → Telnyx routes to user's SIP credential.
//   2. User doesn't answer (no-answer timeout).
//   3. Telnyx routes the call to a Call Control Application (admin
//      configures this on each DID's voice settings in Mission Control).
//   4. That Call Control App's webhook URL points at our endpoint
//      /webhooks/telnyx/voicemail-cc.
//   5. We receive `call.initiated` → look up the user by called DID →
//      answer the call programmatically.
//   6. On `call.answered` → play the user's custom greeting:
//        • mode='audio' → playback_start with greeting URL (Supabase Storage)
//        • mode='tts'   → speak the user's saved text via Telnyx TTS
//        • mode='default' (or null) → speak a stock greeting that
//          interpolates the user's first name.
//   7. On `call.playback.ended` / `call.speak.ended` → record_start with
//      play_beep:true so the caller hears the beep before leaving a message.
//   8. On `call.recording.saved` → write a Voicemail row in our DB,
//      kick off Deepgram transcription (existing flow), hang up.
//
// ADMIN SETUP NEEDED (one-time, in Telnyx Mission Control):
//   1. Create a new Call Control Application named "ACE Voicemail."
//   2. Set its webhook URL to: <our-webhooks-host>/webhooks/telnyx/voicemail-cc
//   3. Note the application_id (e.g. 2974xxxx...).
//   4. Set the env var TELNYX_VOICEMAIL_CC_APP_ID on the API + webhooks
//      services (used by future migration script).
//   5. For each DID we want custom voicemail on, in Mission Control:
//      - Disable Hosted Voicemail
//      - Set the "voice settings → fallback connection / forward-on-no-answer"
//        to the new Call Control Application
//   (v0.10.100 will provide an admin endpoint to automate step 5.)

import { prisma } from '@ace/db';

type LogFn = (obj: Record<string, unknown>, msg: string) => void;

// Stock fallback greeting for users who haven't configured anything.
function defaultGreetingFor(firstName: string | null): string {
  const name = (firstName ?? '').trim() || 'this user';
  return `You've reached ${name}'s voicemail. Please leave a message after the tone, and they'll get back to you as soon as possible.`;
}

/**
 * Issue a Call Control command (answer, speak, playback, record, hangup).
 * Wraps the POST /v2/calls/{id}/actions/{action} pattern. Returns the raw
 * Telnyx response so callers can log / branch on it.
 */
async function callControlAction(
  callControlId: string,
  action: string,
  body: Record<string, unknown>,
  logger: LogFn,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const apiKey = (process.env.TELNYX_API_KEY ?? '').trim();
  if (!apiKey) {
    logger({ action, callControlId }, '[vm-cc] TELNYX_API_KEY missing — cannot issue command');
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
      logger({ action, status: res.status, respBody }, '[vm-cc] action failed');
    }
    return { ok: res.ok, status: res.status, body: respBody };
  } catch (e) {
    logger({ action, err: e instanceof Error ? e.message : String(e) }, '[vm-cc] action threw');
    return { ok: false, status: 0, body: String(e) };
  }
}

/**
 * Look up the user the call is destined for, based on the called DID.
 * Returns null if no user owns this number (Telnyx misrouted, or DID
 * was reassigned and we haven't caught up).
 */
async function findUserByDid(toNumber: string, logger: LogFn) {
  // Try exact match first; if no hit, try without country code prefix.
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
            voicemailGreetingUrl: true,
            voicemailGreetingText: true,
            voicemailGreetingMode: true,
          },
        },
      },
    });
    if (userDid?.user) return { userDid, user: userDid.user };
  }
  logger({ toNumber }, '[vm-cc] no user found for DID');
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Public entry point — called from main.ts for events arriving at
// /webhooks/telnyx/voicemail-cc.
// ─────────────────────────────────────────────────────────────────────

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
  };
}

export async function handleVoicemailCallControlEvent(
  event: TelnyxEventLike,
  loggerIn?: LogFn,
): Promise<void> {
  const logger: LogFn = loggerIn ?? ((o, m) => console.info(m, o));
  const payload = event.payload ?? {};
  const callControlId = payload.call_control_id ?? '';

  switch (event.event_type) {
    // ────────────── 1. Call arrives at our Call Control app ──────────
    case 'call.initiated': {
      const toNumber = (payload.to ?? '').toString();
      const fromNumber = (payload.from ?? '').toString();
      logger({ callControlId, toNumber, fromNumber }, '[vm-cc] call.initiated');
      if (!callControlId) return;
      // Answer the call so we can issue subsequent actions (speak, record).
      // Pass through the from/to in client_state so we can recover them
      // on the recording.saved event if we lose context.
      const stateBlob = Buffer.from(JSON.stringify({ to: toNumber, from: fromNumber })).toString('base64');
      await callControlAction(
        callControlId,
        'answer',
        { client_state: stateBlob },
        logger,
      );
      break;
    }

    // ────────────── 2. Call is answered — play greeting ──────────────
    case 'call.answered': {
      const toNumber = (payload.to ?? '').toString();
      logger({ callControlId, toNumber }, '[vm-cc] call.answered');
      if (!callControlId) return;
      const found = await findUserByDid(toNumber, logger);
      if (!found) {
        // No user found — caller dialed an orphaned DID. Just play a
        // generic greeting and record (so we at least capture the
        // recording for admin investigation).
        await callControlAction(
          callControlId,
          'speak',
          {
            payload: 'You have reached ACE Dialer. Please leave a message after the tone.',
            voice: 'female',
            language: 'en-US',
          },
          logger,
        );
        return;
      }
      const { user } = found;
      const mode = user.voicemailGreetingMode ?? 'default';

      // Branch by configured greeting mode.
      if (mode === 'audio' && user.voicemailGreetingUrl) {
        await callControlAction(
          callControlId,
          'playback_start',
          { audio_url: user.voicemailGreetingUrl },
          logger,
        );
      } else if (mode === 'tts' && user.voicemailGreetingText) {
        await callControlAction(
          callControlId,
          'speak',
          {
            payload: user.voicemailGreetingText,
            voice: 'female',
            language: 'en-US',
          },
          logger,
        );
      } else {
        // 'default' (or anything else) — stock greeting with first name.
        await callControlAction(
          callControlId,
          'speak',
          {
            payload: defaultGreetingFor(user.firstName),
            voice: 'female',
            language: 'en-US',
          },
          logger,
        );
      }
      break;
    }

    // ────────────── 3. Greeting finished — start recording ────────────
    // Both events possible depending on whether we used audio playback
    // or TTS speak. We handle both with the same followup action.
    case 'call.playback.ended':
    case 'call.speak.ended': {
      logger({ callControlId, ended: event.event_type }, '[vm-cc] greeting ended; start recording');
      if (!callControlId) return;
      await callControlAction(
        callControlId,
        'record_start',
        {
          format: 'mp3',
          channels: 'single',
          // Beep so the caller knows when to start talking — replaces
          // the "after the tone" promise of the greeting.
          play_beep: true,
          // 5-minute cap on a single voicemail message. Telnyx aborts
          // cleanly at this limit and fires recording.saved.
          max_length: 300,
          // 4-second silence detection so we hang up shortly after the
          // caller stops speaking. Saves cost vs full 5min hold.
          timeout_secs: 4,
        },
        logger,
      );
      break;
    }

    // ────────────── 4. Recording saved — write voicemail row, hang up ─
    case 'call.recording.saved': {
      logger({ callControlId, payload }, '[vm-cc] recording.saved');
      if (!callControlId) return;
      // Pull the recording URL — Telnyx may send mp3 array OR single URL.
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

      // Recover to/from from client_state (set on answer above) — Telnyx
      // doesn't always echo them on recording events.
      let toNumber = (payload.to ?? '').toString();
      let fromNumber = (payload.from ?? '').toString();
      if ((!toNumber || !fromNumber) && payload.client_state) {
        try {
          const decoded = JSON.parse(
            Buffer.from(String(payload.client_state), 'base64').toString('utf-8'),
          );
          if (!toNumber && decoded?.to) toNumber = String(decoded.to);
          if (!fromNumber && decoded?.from) fromNumber = String(decoded.from);
        } catch {
          /* harmless — best-effort recovery */
        }
      }

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
                durationSeconds: 0, // Telnyx may include later; Deepgram step backfills
                transcription: null,
                receivedAt: new Date(),
              },
            });
            logger({ userId: found.user.id, fromNumber, toNumber }, '[vm-cc] voicemail row created');
            // Note: existing /webhooks/telnyx/calls handler also has its own
            // voicemail logic for the OLD Hosted VM path (calls.voicemail.completed).
            // Once admin disables Hosted VM and routes to this Call Control app,
            // only this handler will fire — no double-write risk.
          } catch (e) {
            logger({ err: e instanceof Error ? e.message : String(e) }, '[vm-cc] voicemail row insert failed');
          }
        }
      }

      // Hang up the call once we've saved the recording. play_beep on
      // record_start already played the beep; nothing more to say.
      await callControlAction(callControlId, 'hangup', {}, logger);
      break;
    }

    // ────────────── 5. Call ended — nothing to do ─────────────────────
    case 'call.hangup': {
      logger({ callControlId }, '[vm-cc] call.hangup (cleanup)');
      break;
    }

    default:
      logger({ eventType: event.event_type }, '[vm-cc] unhandled event');
  }
}
