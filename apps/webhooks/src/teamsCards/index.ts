// v0.10.0 Pillar 2 Task 7 — barrel export for the Adaptive Card
// builders so the notifier (Task 8) can `import { buildMissedCallCard,
// buildInboundSmsCard, buildVoicemailCard } from './teamsCards'`.

export { buildMissedCallCard } from './missedCall.js';
export type { MissedCallCardInput } from './missedCall.js';

export { buildInboundSmsCard } from './inboundSms.js';
export type { InboundSmsCardInput } from './inboundSms.js';

export { buildVoicemailCard } from './voicemail.js';
export type { VoicemailCardInput } from './voicemail.js';

export type {
  AdaptiveElement,
  AdaptiveAction,
  AdaptiveCard,
  TeamsMessage,
} from './types.js';
