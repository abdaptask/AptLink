// Deepgram transcription helper.
//
// Used by the calls.voicemail.completed webhook handler: after we save a
// Voicemail row with transcription=null, we fire-and-forget this helper.
// When the transcript comes back (~2-5 sec for short voicemails), we
// update the row. The webhook handler returns 200 to Telnyx within ms
// regardless, so there's no risk of Telnyx retrying because we're slow.
//
// Model choice: nova-2 — telephony-optimized, ~$0.0043/min, sub-second
// latency on short clips. Smart-format + punctuate are free add-ons
// that make the transcript readable instead of one long lowercase blob.
//
// Failures (network, API key missing, audio fetch error, etc.) return
// null. The row simply stays transcription=null and the UI handles that
// gracefully. We never throw — voicemail capture itself is more
// important than the transcript.
import { prisma } from '@ace/db';

const DEEPGRAM_API_URL = 'https://api.deepgram.com/v1/listen';

/** Fetch a transcript for a remote audio URL. Returns null on any failure. */
export async function transcribeRecording(recordingUrl: string): Promise<string | null> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.warn('[deepgram] DEEPGRAM_API_KEY not set — skipping transcription');
    return null;
  }
  try {
    // Deepgram's "URL" mode: POST a JSON body with the audio URL; Deepgram
    // fetches it server-side. Cheaper than downloading + uploading from us.
    const qs = new URLSearchParams({
      model: 'nova-2',
      smart_format: 'true',
      punctuate: 'true',
      // detect_language defaults true; sticking with English-only is faster
      language: 'en-US',
    });
    const res = await fetch(`${DEEPGRAM_API_URL}?${qs.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: recordingUrl }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[deepgram] transcription failed', res.status, text.slice(0, 200));
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
    if (!transcript || !transcript.trim()) return null;
    return transcript.trim();
  } catch (e) {
    console.warn('[deepgram] transcription error', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Background helper called from the voicemail webhook handler. Transcribes
 * the recording and updates the row. Doesn't return anything — the caller
 * doesn't await. Errors are logged, never thrown.
 */
export async function transcribeAndUpdateVoicemail(
  voicemailId: number,
  recordingUrl: string,
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
  } catch (e) {
    console.warn(`[deepgram] transcribeAndUpdateVoicemail(${voicemailId}) failed`, e);
  }
}
