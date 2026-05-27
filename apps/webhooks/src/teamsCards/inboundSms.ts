// v0.10.0 Pillar 2 Task 7 — Adaptive Card builder for inbound SMS
// messages. Fires from `message.received` webhook handler.
//
// What the recipient sees:
//   ┌─────────────────────────────────────────────┐
//   │ 💬 New text message                          │
//   │ (732) 200-1305                               │
//   │ on your "Main" line • May 27, 3:42 PM ET     │
//   │                                              │
//   │ ┌──────────────────────────────────────────┐ │
//   │ │ "Hey, just landed at JFK. On my way."    │ │
//   │ └──────────────────────────────────────────┘ │
//   │                                              │
//   │   [Reply]   [Call]                           │
//   └─────────────────────────────────────────────┘
//
// Body preview is the full message text — Teams handles wrapping;
// no need to truncate. If the message has a leading/trailing
// whitespace it gets trimmed before display.

import {
  buildCallDeepLink,
  buildSmsDeepLink,
  buildTeamsMessage,
  formatPhoneForDisplay,
  formatTimeForDisplay,
  type AdaptiveElement,
  type TeamsMessage,
} from './types.js';

export interface InboundSmsCardInput {
  /** E.164 number that sent the SMS. */
  fromNumber: string;
  /** Optional sender name. */
  fromName?: string | null;
  /** Which of the user's DIDs received the SMS. Omitted when
   *  the user has a single line. */
  toLineLabel?: string | null;
  /** The message text. We render it as a TextBlock; Teams wraps
   *  long lines. Empty/whitespace bodies show "(empty message)" so
   *  the card still looks intentional. */
  body: string;
  /** When the message was received. */
  occurredAt: Date | string | number;
}

export function buildInboundSmsCard(input: InboundSmsCardInput): TeamsMessage {
  const displayNumber = formatPhoneForDisplay(input.fromNumber);
  const senderHeadline = input.fromName
    ? `${input.fromName} — ${displayNumber}`
    : displayNumber;

  const subtitleParts: string[] = [];
  if (input.toLineLabel) subtitleParts.push(`on your "${input.toLineLabel}" line`);
  subtitleParts.push(formatTimeForDisplay(input.occurredAt));
  const subtitle = subtitleParts.join(' • ');

  const trimmedBody = (input.body ?? '').trim();
  const messageText = trimmedBody.length > 0 ? trimmedBody : '(empty message)';

  const body: AdaptiveElement[] = [
    {
      type: 'TextBlock',
      text: '💬 New text message',
      size: 'Medium',
      weight: 'Bolder',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: senderHeadline,
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
    // The message body in its own Container so it visually reads as
    // a quoted message rather than continuing the metadata above.
    {
      type: 'Container',
      style: 'emphasis',
      spacing: 'Medium',
      items: [
        {
          type: 'TextBlock',
          text: messageText,
          wrap: true,
        },
      ],
    },
  ];

  return buildTeamsMessage(body, [
    {
      type: 'Action.OpenUrl',
      title: 'Reply',
      url: buildSmsDeepLink(input.fromNumber),
    },
    {
      type: 'Action.OpenUrl',
      title: 'Call',
      url: buildCallDeepLink(input.fromNumber),
    },
  ]);
}
