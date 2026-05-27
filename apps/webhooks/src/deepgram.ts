// Deepgram transcription helper.
//
// Used by the calls.voicemail.completed webhook handler: after we save a
// Voicemail row with transcription=null, we fire-and-forget this helper.
// When the transcript comes back (~2-5 sec for short voicemails), we
// update the row. The webhook handler returns 200 to Telnyx within ms
// regardless, so there's no risk of Telnyx retrying because we're slow.
//
// Model choice (v0.9.15): nova-3 — Deepgram's current flagship telephony
// model. Same price as nova-2 (~$0.0043/min), slightly faster, marginally
// better accuracy on phone audio. Smart-format + punctuate are free
// add-ons that make the transcript readable instead of one long lowercase
// blob. We use language: 'multi' so accented English (Indian, ApTask's
// majority user base) transcribes accurately — 'en-US' biases toward
// American phonemes and lost words on heavily-accented audio.
//
// v0.9.15 — IMPORTANT auth fix: previously we used Deepgram's "URL mode"
// where we passed the Telnyx recording URL and asked Deepgram to fetch
// it server-side. That silently failed for every voicemail because
// Telnyx recording URLs (api.telnyx.com/v2/recordings/...) require a
// Bearer token to access — Deepgram doesn't have our Telnyx API key,
// so the GET returned 401 and Deepgram returned an error response we
// logged but didn't surface. Result: every voicemail stuck at
// "Transcribing..." forever in the UI.
//
// Fix: we download the audio ourselves in this service (with our Telnyx
// Bearer token), then POST the raw bytes to Deepgram. Adds ~500ms vs
// URL mode but actually succeeds, and we now control the auth path
// end-to-end.
//
// Failures (network, API key missing, audio fetch error, Deepgram
// rejection) trigger ONE retry after 3 seconds, then null. The row
// stays transcription=null and the UI handles that gracefully. We
// never throw — voicemail capture itself is more important than the
// transcript.
import { prisma } from '@ace/db';
import { notifyVoicemail } from './teamsNotifier.js';

const DEEPGRAM_API_URL = 'https://api.deepgram.com/v1/listen';

/**
 * Download a Telnyx-hosted audio recording with the correct Bearer auth,
 * returning the bytes as a Buffer. Returns null on any failure.
 *
 * Telnyx recording URLs (typical shape: api.telnyx.com/v2/recordings/...)
 * require the same API key used elsewhere on the account. URLs from
 * other hosts (e.g. signed S3 URLs from a custom hosted setup) might not
 * need auth — we still send the header; harmless on hosts that ignore it.
 */
async function fetchRecordingBytes(recordingUrl: string): Promise<Uint8Array | null> {
  const telnyxKey = process.env.TELNYX_API_KEY;
  try {
    const headers: Record<string, string> = {};
    if (telnyxKey && /(^|\.)telnyx\.com\//.test(recordingUrl)) {
      headers.Authorization = `Bearer ${telnyxKey}`;
    }
    const res = await fetch(recordingUrl, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        '[deepgram] recording fetch failed',
        res.status,
        recordingUrl,
        text.slice(0, 200),
      );
      return null;
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } catch (e) {
    console.warn(
      '[deepgram] recording fetch threw',
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/**
 * Inner transcription attempt. POST raw audio bytes to Deepgram. Returns
 * null on any failure (caller handles retry).
 */
async function attemptTranscription(audioBytes: Uint8Array): Promise<string | null> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.warn('[deepgram] DEEPGRAM_API_KEY not set — skipping transcription');
    return null;
  }
  const qs = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    // v0.9.15 — 'multi' instead of 'en-US' so Indian-accented English
    // transcribes accurately. Deepgram auto-detects language within
    // the multi-language set, which costs the same as a single locale.
    language: 'multi',
  });
  const startedAt = Date.now();
  try {
    const res = await fetch(`${DEEPGRAM_API_URL}?${qs.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        // Deepgram autodetects WAV/MP3/Ogg/M4A from the bytes when we
        // don't pin a Content-Type, but pinning it helps when Deepgram's
        // detection is ambiguous on truncated audio. Telnyx voicemail
        // recordings are MP3 (recording_urls.mp3 in the webhook payload).
        'Content-Type': 'audio/mp3',
      },
      body: audioBytes,
    });
    const elapsed = Date.now() - startedAt;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        '[deepgram] transcription failed',
        res.status,
        `(${elapsed}ms)`,
        text.slice(0, 200),
      );
      return null;
    }
    const body = (await res.json()) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{ transcript?: string }>;
        }>;
      };
    };
    const transcript = body?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? null;
    console.info(
      '[deepgram] transcription completed',
      `(${elapsed}ms, ${audioBytes.length} bytes audio, ${transcript?.length ?? 0} chars transcript)`,
    );
    if (!transcript || !transcript.trim()) return null;
    return transcript.trim();
  } catch (e) {
    console.warn(
      '[deepgram] transcription threw',
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/**
 * Fetch a transcript for a Telnyx recording URL. Downloads the audio with
 * Telnyx Bearer auth, POSTs the bytes to Deepgram nova-3. ONE retry on
 * Deepgram failure (3 sec wait) — Telnyx recording CDN sometimes
 * 404s for ~10 sec after the voicemail webhook fires while it
 * finalizes the file. Returns null on all-retries-failed.
 */
export async function transcribeRecording(recordingUrl: string): Promise<string | null> {
  const bytes = await fetchRecordingBytes(recordingUrl);
  if (!bytes) return null;
  if (bytes.length === 0) {
    console.warn('[deepgram] recording fetched 0 bytes — skipping');
    return null;
  }
  const first = await attemptTranscription(bytes);
  if (first !== null) return first;
  console.info('[deepgram] first transcription attempt returned null — retrying in 3s');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const second = await attemptTranscription(bytes);
  return second;
}

/**
 * Background helper called from the voicemail webhook handler. Transcribes
 * the recording and updates the row. Doesn't return anything — the caller
 * doesn't await. Errors are logged, never thrown.
 */
export async function transcribeAndUpdateVoicemail(
  voicemailId: number,
  recordingUrl: string,
  // v0.10.0 Task 8 — userId is OPTIONAL for backwards compat (any
  // legacy caller without it just won't trigger a Teams card; the
  // 30s timeout fallback in main.ts will still cover that case).
  // When supplied, we fire the Teams notification with reason
  // 'transcribed' after the row is updated. The notifier's dedup
  // Set prevents the parallel 30s timeout from sending a 2nd card.
  userId?: number,
): Promise<void> {
  try {
    const text = await transcribeRecording(recordingUrl);
    if (!text) {
      console.warn(`[deepgram] no transcript for voicemail ${voicemailId}`);
      return;
    }
    await prisma.voicemail.update({
      where: { id: voicemailId },
      data: { transcription: text },
    });
    console.info(`[deepgram] voicemail ${voicemailId} transcribed (${text.length} chars)`);

    if (userId) {
      void notifyVoicemail({ userId, voicemailId, reason: 'transcribed' }).catch(
        (e) =>
          console.warn(
            `[deepgram] notifyVoicemail(${voicemailId}) threw`,
            e instanceof Error ? e.message : e,
          ),
      );
    }
  } catch (e) {
    console.warn(`[deepgram] transcribeAndUpdateVoicemail(${voicemailId}) failed`, e);
  }
}
