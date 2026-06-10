// v0.10.0 Pillar 2 Task 7 — Adaptive Card builder for voicemails.
// Fires from the webhook handler after Deepgram transcription
// completes (or after a short grace period if transcription fails —
// we still send the card with "Transcription unavailable" so the
// user knows there's a voicemail waiting).
//
// What the recipient sees:
//   ┌──────────────────────────────────────────────┐
//   │ 🎙️ New voicemail                              │
//   │ (732) 200-1305                                │
//   │ on your "Main" line • May 27, 3:42 PM ET • 47s│
//   │                                               │
//   │ ┌───────────────────────────────────────────┐ │
//   │ │ "Hi, this is Mark calling about the role  │ │
//   │ │ we discussed yesterday. Give me a ring    │ │
//   │ │ back when you get a chance, thanks."      │ │
//   │ └───────────────────────────────────────────┘ │
//   │                                               │
//   │   [Listen]   [Call back]   [Send text]        │
//   └──────────────────────────────────────────────┘
//
// Listen button links to the web playback page (not a deep link)
// because:
//   - Telnyx recording URLs need Bearer auth and aren't browser-
//     playable directly. We proxy them via the API.
//   - Users on Teams mobile won't have the desktop app installed.
//   - A web URL works everywhere; the playback page itself can
//     hand off to the desktop app via deep-link if installed.

import {
  buildCallDeepLink,
  buildSmsDeepLink,
  buildTeamsMessage,
  buildVoicemailPlaybackUrl,
  formatPhoneForDisplay,
  formatTimeForDisplay,
  type AdaptiveAction,
  type AdaptiveElement,
  type TeamsMessage,
} from './types.js';

export interface VoicemailCardInput {
  /** Internal DB id — used to build the playback URL. */
  voicemailId: number;
  /** E.164 number that left the voicemail. */
  fromNumber: string;
  /** Optional caller name. */
  fromName?: string | null;
  /** User's DID that the voicemail came in on. Omitted for
   *  single-line users. */
  toLineLabel?: string | null;
  /** When the voicemail was left. */
  occurredAt: Date | string | number;
  /** Recording duration in seconds. Optional — if absent we just
   *  omit the duration tag from the subtitle. */
  durationSec?: number | null;
  /** Deepgram transcript text, if available. */
  transcript?: string | null;
}

/** Format a duration in seconds as "47s" or "2m 13s". */
function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

export function buildVoicemailCard(input: VoicemailCardInput): TeamsMessage {
  const displayNumber = formatPhoneForDisplay(input.fromNumber);
  const callerHeadline = input.fromName
    ? `${input.fromName} — ${displayNumber}`
    : displayNumber;

  const subtitleParts: string[] = [];
  if (input.toLineLabel) subtitleParts.push(`on your "${input.toLineLabel}" line`);
  subtitleParts.push(formatTimeForDisplay(input.occurredAt));
  if (typeof input.durationSec === 'number' && input.durationSec > 0) {
    subtitleParts.push(formatDuration(input.durationSec));
  }
  const subtitle = subtitleParts.join(' • ');

  const transcriptTrimmed = (input.transcript ?? '').trim();
  const transcriptText = transcriptTrimmed.length > 0
    ? `"${transcriptTrimmed}"`
    : '(Transcription unavailable — open the dialer to listen.)';

  const body: AdaptiveElement[] = [
    {
      type: 'TextBlock',
      text: '🎙️ New voicemail',
      size: 'Medium',
      weight: 'Bolder',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: callerHeadline,
      size: 'Large',
      weight: 'Bolder',
      wrap: true,
      spacing: 'Small',
    },
    {
      type: 'TextBlock',
      text: subtitle,
      isSubtle: true,
      wrap: true,
      spacing: 'None',
    },
    {
      type: 'Container',
      style: 'emphasis',
      spacing: 'Medium',
      items: [
        {
          type: 'TextBlock',
          text: transcriptText,
          wrap: true,
          isSubtle: transcriptTrimmed.length === 0,
        },
      ],
    },
  ];

  const actions: AdaptiveAction[] = [
    {
      type: 'Action.OpenUrl',
      title: 'Listen',
      url: buildVoicemailPlaybackUrl(input.voicemailId),
    },
    {
      type: 'Action.OpenUrl',
      title: 'Call back',
      url: buildCallDeepLink(input.fromNumber),
    },
    {
      type: 'Action.OpenUrl',
      title: 'Send text',
      url: buildSmsDeepLink(input.fromNumber),
    },
  ];

  return buildTeamsMessage(body, actions);
}
