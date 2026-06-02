// v0.10.26 — User-facing release notes shown in Settings → What's new.
// Plain English, no jargon. Add new versions at the TOP so newest is first.
//
// Categories:
//   'new'      — brand-new capability / feature
//   'improved' — better, faster, prettier, easier version of an existing thing
//   'fixed'    — bug fix
//
// Keep entries short (~1 sentence). If you need detail, put it in a (parenthetical).

export type ChangeType = 'new' | 'improved' | 'fixed';

export interface ChangeEntry {
  type: ChangeType;
  text: string;
}

export interface ReleaseEntry {
  version: string;
  date: string;          // human-readable e.g. "June 1, 2026"
  highlight?: string;    // optional one-line summary shown bold under the date
  changes: ChangeEntry[];
}

export const WHATS_NEW: ReleaseEntry[] = [
  {
    version: '0.10.49',
    date: 'June 2, 2026',
    highlight: 'Critical SMS import fix — Pulse SMS imports now actually work',
    changes: [
      { type: 'fixed', text: 'Every SMS import from Pulse since v0.10.44 was failing silently. The fetch SQL referenced a chat_user.normalized_mobile column that exists in newer Pulse schema dumps but NOT in production. MySQL returned "Unknown column" error, the catch block swallowed it, and the diagnostic kept showing "Pulse has X SMS, ACE imported 0". Removed the bad column. Now run Refresh from Pulse on any user (Sagar, Sanjyot, anyone whose import showed 0) and SMS will actually come through.' },
    ],
  },
  {
    version: '0.10.48',
    date: 'June 2, 2026',
    highlight: 'Admins can set one hold music for everyone',
    changes: [
      { type: 'new', text: 'Settings → Hold music. Admins now see a "Set as tenant default" button below the regular upload controls. Once set, every new user (and every existing user without their own override) inherits the same hold music automatically on next sign-in. Users can still upload their own personal hold music to override the default if they want.' },
      { type: 'improved', text: 'Hold music is now stored centrally in ACE\'s database (one tenant-wide entry) instead of only in each user\'s browser. Admin manages it once; the rollout to every user is automatic.' },
    ],
  },
  {
    version: '0.10.47',
    date: 'June 2, 2026',
    highlight: 'Yesterday\'s activity at a glance',
    changes: [
      { type: 'new', text: 'On your first sign-in each day, a small banner at the top shows what happened while you were away: missed calls, new SMS, voicemails. Click X to dismiss; it won\'t reappear until tomorrow. Hides itself entirely if there\'s nothing to summarize.' },
      { type: 'improved', text: 'Bug-report / suggestion email in Settings → What\'s new now points to support@aptask.com (was it@aptask.com).' },
    ],
  },
  {
    version: '0.10.46',
    date: 'June 2, 2026',
    highlight: 'No migrated SMS gets dropped — period',
    changes: [
      { type: 'fixed', text: 'For users whose Pulse contacts had been entirely deleted from Pulse\'s chat_user table (Sagar Bangera being the latest example: 93 SMS in Pulse, 0 imported), the SMS import still dropped every message — even after v0.10.44\'s fix — because the chat_user row didn\'t exist to give us anything to anchor the thread on. The import now falls back to the raw Pulse user_id stored on the message itself, so the message imports under a synthetic thread regardless. No message ever gets silently dropped now.' },
    ],
  },
  {
    version: '0.10.45',
    date: 'June 2, 2026',
    highlight: 'Migrated messages and calls show their original send time',
    changes: [
      { type: 'fixed', text: 'SMS and calls migrated from Pulse were all showing the import time as the message time, instead of when they actually happened in Pulse. The Messages list looked like every conversation happened at the same instant. Fixed for all future imports — they now anchor to the original Pulse send time.' },
      { type: 'new', text: 'New admin maintenance endpoint POST /admin/maintenance/fix-pulse-timestamps that retroactively corrects timestamps on previously-imported Pulse messages and calls. Run it once after deploying v0.10.45 and Ravindra/Himank/Sanjyot\'s already-imported history will show in proper chronological order.' },
    ],
  },
  {
    version: '0.10.44',
    date: 'June 2, 2026',
    highlight: 'SMS import works even when Pulse contact phone is null',
    changes: [
      { type: 'fixed', text: 'For some migrated users (Sanjyot Waghmare being the example: 284 SMS in Pulse, 0 imported), every single SMS was being dropped because Pulse\'s chat_user.mobile_no column was null for their contacts. Pulse has a SECOND phone column (normalized_mobile) that\'s populated in newer records; we now check both. As a last resort, if both are null, the message imports under a synthetic thread key based on the chat_user id so it doesn\'t get silently dropped.' },
    ],
  },
  {
    version: '0.10.43',
    date: 'June 2, 2026',
    highlight: 'Messages list fix, take two',
    changes: [
      { type: 'fixed', text: 'Tighter CSS constraints on thread rows in the Messages tab. v0.10.42\'s fix worked for most resolutions but didn\'t fully constrain the layout on certain Electron desktop builds — preview text was extending to 2200+ pixels wide on a 1366-pixel screen, pushing the contact name off-screen to the left. Now uses width:0 + flex:1 1 0% to force aggressive shrink that works on all configurations.' },
    ],
  },
  {
    version: '0.10.42',
    date: 'June 2, 2026',
    highlight: 'Messages list looks right on smaller screens too',
    changes: [
      { type: 'fixed', text: 'On laptops at 1366×768 resolution (or any monitor with Windows display scaling at 125%+), thread rows in the Messages tab were rendering with the contact name area empty and the preview text starting mid-sentence — because of CSS layout overflow at narrow widths. Thread rows now truncate names and badges gracefully at any viewport size.' },
    ],
  },
  {
    version: '0.10.41',
    date: 'June 2, 2026',
    highlight: 'Refresh from Pulse shows diagnostic counts',
    changes: [
      { type: 'new', text: 'When you refresh a user from Pulse and 0 SMS come over, the result panel now shows what Pulse actually has for them: total messages, total SMS (any time), SMS in the last 30 days. Makes it clear whether Pulse genuinely has no SMS for that user or whether ACE is missing them — no more guessing.' },
    ],
  },
  {
    version: '0.10.40',
    date: 'June 2, 2026',
    highlight: 'Refresh from Pulse: works for pre-wizard users + handles multi-line users',
    changes: [
      { type: 'fixed', text: 'The "Refresh from Pulse" button used to fail with "No Pulse user_id on record" for users added to ACE before the migrate wizard existed. The modal now has an optional "Pulse user ID" field — enter their Pulse user_id (e.g. 55) the first time, and ACE remembers it for future refreshes.' },
      { type: 'new', text: 'If a user has multiple phone lines (e.g. an original Pulse number AND a new ACE-purchased number), the Refresh modal now shows a "Which line?" dropdown so you can pick which line the Pulse history should attach to. Single-line users don\'t see the dropdown — defaults to their one line automatically.' },
      { type: 'fixed', text: 'The DID column on Settings → Users now shows each user\'s current default line (instead of the legacy first-assigned number which got stale when admins added or changed lines later). Users with more than one line get a "+N" badge so you know they have multiple.' },
      { type: 'improved', text: 'Search now matches across all of a user\'s lines, not just their original one.' },
    ],
  },
  {
    version: '0.10.38',
    date: 'June 1, 2026',
    highlight: 'One-click refresh from Pulse for any migrated user',
    changes: [
      { type: 'new', text: 'On every user row in Settings - Users, the kebab menu now has "Refresh from Pulse". One click opens a modal that re-pulls their last 30 days of SMS history. If you also paste their Pulse password, calls get refreshed too. No command-line, no IDs to look up.' },
      { type: 'new', text: 'Settings - Users - "Bulk-refresh SMS" runs the same SMS refresh across every migrated user in one shot. Per-user results table shows the new-message count for each. SMS-only by design (calls would need per-user passwords we deliberately don\'t store).' },
    ],
  },
  {
    version: '0.10.37',
    date: 'June 1, 2026',
    highlight: 'One-click migrate user from Pulse',
    changes: [
      { type: 'new', text: 'Settings - Users - "Migrate from Pulse". Enter the user\'s Pulse email and password, and ACE does everything else in 30-60 seconds: creates their ACE account, moves their phone number from Pulse to ACE in Telnyx, configures the messaging profile, sends a welcome email, and imports their last 30 days of calls + SMS. Step-by-step results shown in the modal.' },
      { type: 'improved', text: 'Migration audit log records pulse user_id, ACE email, DID, both Telnyx connection IDs (before + after), counts of records imported, and total duration - but never the user\'s Pulse password.' },
    ],
  },
  {
    version: '0.10.36',
    date: 'June 1, 2026',
    highlight: 'Migration backfill now reaches into Pulse for call history',
    changes: [
      { type: 'new', text: 'When you migrate a user from Pulse to ACE, the dialer now logs into Pulse with the user\'s credentials and pulls their last ~200 call records (typically 20-30 days of history depending on call volume) directly into ACE\'s Recents. Combined with the existing 30-day SMS import, migrated users land with their full recent history visible immediately.' },
      { type: 'improved', text: 'Admins can re-run a user\'s backfill at any time by providing that user\'s Pulse email + password to the backfill endpoint. Password is used once and never stored.' },
      { type: 'fixed', text: 'Pulse marks call records as "incoming"/"outgoing" rather than "inbound"/"outbound". The import now recognizes both - earlier some incoming calls were incorrectly tagged as outbound.' },
    ],
  },
  {
    version: '0.10.34',
    date: 'June 1, 2026',
    highlight: 'Connection status stays steady during calls',
    changes: [
      { type: 'fixed', text: 'Connection status pill no longer flickers between Online and Disconnected while you\'re on a call. Routine SIP refresh blips (every few minutes for some network conditions) used to flash the indicator alarmingly even though the call itself was unaffected. The pill now stays stable for the duration of the call.' },
      { type: 'new', text: 'When you migrate a user from Pulse to ACE, their 30-day SMS history and call history can also import from Pulse\'s database — not just from Telnyx. This catches users whose data was on Pulse-only routes (Twilio shared sender, etc.) and wasn\'t visible to Telnyx alone. (Requires admin to configure Pulse DB connection in env vars; code ships dormant until activated.)' },
      { type: 'improved', text: 'Once history imports from Pulse, ACE owns it permanently. Migrated users\' data lives on ACE\'s database with no ongoing dependency on Pulse — Pulse can be decommissioned without affecting them.' },
    ],
  },
  {
    version: '0.10.33',
    date: 'June 1, 2026',
    highlight: 'Spelling suggestions on right-click',
    changes: [
      { type: 'improved', text: 'Right-click any squiggled (misspelled) word in the SMS compose box or any other text input — you now get spelling suggestions at the top of the menu. Click a suggestion to replace the word, or "Add to dictionary" to suppress the squiggle for that word going forward. Works across every text field in the dialer.' },
    ],
  },
  {
    version: '0.10.32',
    date: 'June 1, 2026',
    highlight: 'Critical call reliability fixes',
    changes: [
      { type: 'fixed', text: 'Some users couldn\'t hear incoming calls (caller could hear them fine, but the user heard silence). Root cause: a timing race where the audio track was already attached by the time the dialer wired up its listener — so the listener missed the track event. Now correctly attaches any pre-existing audio track when setting up listeners.' },
      { type: 'fixed', text: 'Accept button on incoming call screen could occasionally appear unresponsive when the caller hung up at exactly the same moment. The button now correctly dismisses the ringer instead of doing nothing silently.' },
      { type: 'fixed', text: 'Speaker selection now auto-falls-back to the system default if the saved device is disconnected (e.g. unpaired Bluetooth headset), instead of silently playing into the void.' },
      { type: 'improved', text: 'Audio playback retries once if the browser briefly blocks it (Chromium\'s autoplay policy on backgrounded windows).' },
      { type: 'improved', text: 'Thread header is reorganized — the contact\'s name and number group together at the top, with "Your line:" explicitly labeled below so it\'s clear which line is which.' },
      { type: 'fixed', text: 'SMS compose placeholder text no longer wraps and gets cut off in narrow windows.' },
    ],
  },
  {
    version: '0.10.30',
    date: 'June 1, 2026',
    highlight: 'SMS compose upgrades',
    changes: [
      { type: 'new', text: 'Emoji picker in the SMS compose box. Click the smile icon to open a popover with common emojis and reactions — insert at the cursor position with one click.' },
      { type: 'new', text: 'Multi-line text messages. Press Shift+Enter to add a new line; Enter still sends the message.' },
      { type: 'improved', text: 'Browser autocorrect, spellcheck, and sentence-start capitalization now active in the SMS compose box.' },
    ],
  },
  {
    version: '0.10.29',
    date: 'June 1, 2026',
    highlight: 'Migration history reliability fixes',
    changes: [
      { type: 'fixed', text: 'Automatic SMS history import now correctly recognizes Telnyx\'s actual column names — earlier the import would silently fail for messages even when data existed.' },
      { type: 'improved', text: 'Migration backfill now tries multiple Telnyx API endpoint paths before giving up, so it works on every account regardless of Telnyx\'s URL conventions.' },
    ],
  },
  {
    version: '0.10.28',
    date: 'June 1, 2026',
    highlight: 'Migrated users get their full 30-day history automatically',
    changes: [
      { type: 'new', text: 'When you migrate a user from the old dialer to ACE, their last 30 days of call logs AND SMS history automatically come over. They open Recents and Messages and see everything reconstructed within a minute — no manual export needed.' },
      { type: 'fixed', text: 'Previously some migrations finished with zero history populated because of a Telnyx API quirk. Now uses Telnyx\'s report-generation pipeline which reliably pulls phone-filtered history.' },
    ],
  },
  {
    version: '0.10.27',
    date: 'June 1, 2026',
    highlight: 'Manual CDR import as a fallback',
    changes: [
      { type: 'new', text: 'Admins can manually upload a CDR or messaging CSV exported from Telnyx Portal to backfill a migrated user\'s history. Useful as a fallback whenever the automatic backfill needs a hand.' },
    ],
  },
  {
    version: '0.10.26',
    date: 'June 1, 2026',
    highlight: 'Smarter notifications and read tracking',
    changes: [
      { type: 'new', text: 'Desktop notifications for new voicemails — just like missed calls and texts. Toggle in Settings → Notifications.' },
      { type: 'new', text: 'Open an SMS thread on one device and the unread dots clear on your other devices too. Read state now syncs everywhere.' },
      { type: 'new', text: 'Per-thread unread count badges in the Messages list.' },
      { type: 'improved', text: 'Tap a voicemail to play it and it auto-marks as read. Right-click any voicemail to mark it unread again.' },
    ],
  },
  {
    version: '0.10.25',
    date: 'June 1, 2026',
    highlight: 'Critical reliability fixes',
    changes: [
      { type: 'fixed', text: 'Incoming calls were going straight to voicemail when the dialer wasn\'t the front window — even though your computer was awake. Calls now ring reliably whether the app is in front, minimized, or in your system tray.' },
      { type: 'fixed', text: 'The incoming call screen sometimes showed the wrong line name (for example, "Main" when someone actually called your "Office Line"). Now correctly shows which of your lines was dialed.' },
      { type: 'fixed', text: 'Reply and Call buttons in Microsoft Teams notification cards now actually open the dialer.' },
    ],
  },
  {
    version: '0.10.24',
    date: 'May 31, 2026',
    highlight: 'Build pipeline reliability',
    changes: [
      { type: 'improved', text: 'When Apple\'s notarization service is slow, the dialer\'s desktop installer now retries automatically and falls back to a signed-only build if needed. No more stuck updates.' },
      { type: 'improved', text: 'Windows installer builds no longer wait on the Mac build — both ship independently.' },
    ],
  },
  {
    version: '0.10.22',
    date: 'May 30, 2026',
    highlight: 'Teams notifications + migrating history',
    changes: [
      { type: 'new', text: 'Microsoft Teams notifications are back. ACE Bot now DMs you for missed calls, new texts, new voicemails, and when an admin assigns you a new line.' },
      { type: 'new', text: 'When an admin migrates your number from the old dialer to ACE, your last 30 days of call history and text messages move with it. Open Recents or Messages right after the migration and everything\'s there.' },
      { type: 'improved', text: 'Migration is faster — no waiting. The history fills in over the next minute while you can use the dialer.' },
    ],
  },
  {
    version: '0.10.21',
    date: 'May 30, 2026',
    highlight: 'Audio quality + admin polish',
    changes: [
      { type: 'new', text: 'Settings → Microphone → "Noise suppression" toggle. Turn it on if you\'re in a noisy environment (café, open office, home with AC + traffic). Keeps your voice clear for the other party.' },
      { type: 'new', text: 'After an admin migrates a number to ACE, they get a prompt to deactivate or delete the old SIP connection — cleaner cleanup.' },
      { type: 'fixed', text: 'The line label on the incoming call screen was invisible for users in light mode. Now always shows clearly on the dark green ringer background.' },
      { type: 'fixed', text: '"Unknown connection" labels in the migrate picker — now shows the real connection name and SIP user for every type of Telnyx connection.' },
    ],
  },
  {
    version: '0.10.20',
    date: 'May 30, 2026',
    highlight: 'Migrate Existing User to New Dialer',
    changes: [
      { type: 'new', text: 'Admins can now migrate a user from the old dialer (Pulse) to ACE without losing their phone number. Find it in Settings → Users → Manage lines → "Migrate Existing User to New Dialer".' },
      { type: 'new', text: 'When a line is added or migrated to your account, you get an email letting you know.' },
      { type: 'new', text: 'Typeahead search in the migrate number picker — find any phone number by digits, connection name, or SIP user.' },
      { type: 'improved', text: 'Incoming call screen line badge is now larger, bolder, and easier to read.' },
      { type: 'improved', text: 'Clearer wording in the "Add a line" modal: "Purchase a new DID from Telnyx" and "Use a new number from Telnyx database that you already own".' },
    ],
  },
  {
    version: '0.10.17',
    date: 'May 29, 2026',
    changes: [
      { type: 'fixed', text: 'Connection status was rapidly switching between "Online" and "Disconnected" for some users in India. Now stays steady on a healthy connection.' },
    ],
  },
  {
    version: '0.10.14',
    date: 'May 29, 2026',
    changes: [
      { type: 'fixed', text: 'Incoming calls were hanging up after a fraction of a second for users on certain numbers. All users now receive calls properly on all their assigned lines.' },
    ],
  },
  {
    version: '0.10.13',
    date: 'May 28, 2026',
    highlight: 'Messages + Chat merged into one tab',
    changes: [
      { type: 'improved', text: 'SMS conversations and internal team chats now live in a single "Messages" tab with a segmented control. No more guessing where a thread is.' },
    ],
  },
  {
    version: '0.10.10',
    date: 'May 28, 2026',
    changes: [
      { type: 'fixed', text: 'Voicemail greetings (and other early audio from the other side) were sometimes drowned out by our ringback tone. The ringback now stops the moment the other party starts speaking.' },
      { type: 'improved', text: 'The line badge on the ringer screen is more readable, especially on bright displays.' },
    ],
  },
  {
    version: '0.10.9',
    date: 'May 28, 2026',
    highlight: 'See which line was called',
    changes: [
      { type: 'new', text: 'The incoming call screen now shows which of your lines the caller dialed (for example "on Sales · (732) 555-1234"). Critical for anyone with multiple numbers.' },
    ],
  },
];
