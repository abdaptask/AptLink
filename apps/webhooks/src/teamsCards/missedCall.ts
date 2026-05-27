// v0.10.0 Pillar 2 Task 7 — Adaptive Card builder for missed inbound
// calls. Fires from the webhook handler when a Call ends with
// hangup_cause indicating the agent didn't pick up (or rejected via
// reject-on-busy) AND no voicemail was left (voicemail cards are
// built by voicemail.ts and include richer info).
//
// What the recipient sees in Teams:
//   ┌──────────────────────────────────────────┐
//   │ 📞 Missed call                            │
//   │ (732) 200-1305                            │
//   │ on your "Main" line • May 27, 3:42 PM ET  │
//   │                                          │
//   │   [Call back]   [Send text]               │
//   └──────────────────────────────────────────┘
//
// The two action buttons launch the desktop app via the
// `ace-dialer://` protocol. If the user is on mobile / doesn't have
// the desktop installed, the OS will show a "no app" prompt — that's
// acceptable for v0.10.0; we can add a graceful web fallback later.

import {
  buildCallDeepLink,
  buildSmsDeepLink,
  buildTeamsMessage,
  formatPhoneForDisplay,
  formatTimeForDisplay,
  type AdaptiveElement,
  type TeamsMessage,
} from './types.js';

export interface MissedCallCardInput {
  /** E.164 number that called the user. */
  fromNumber: string;
  /** Optional caller name (from JobDiva enrichment or contact list). */
  fromName?: string | null;
  /** The user's line that was rung — used for "on your X line"
   *  context when the user has multiple DIDs. Pass null for single-DID
   *  users; the line context line is omitted in that case. */
  toLineLabel?: string | null;
  /** When the call came in. */
  occurredAt: Date | string | number;
}

export function buildMissedCallCard(input: MissedCallCardInput): TeamsMessage {
  const displayNumber = formatPhoneForDisplay(input.fromNumber);
  const callerHeadline = input.fromName
    ? `${input.fromName} — ${displayNumber}`
    : displayNumber;

  const subtitleParts: string[] = [];
  if (input.toLineLabel) subtitleParts.push(`on your "${input.toLineLabel}" line`);
  subtitleParts.push(formatTimeForDisplay(input.occurredAt));
  const subtitle = subtitleParts.join(' • ');

  const body: AdaptiveElement[] = [
    {
      type: 'TextBlock',
      text: '📞 Missed call',
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
  ];

  return buildTeamsMessage(body, [
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
  ]);
}
