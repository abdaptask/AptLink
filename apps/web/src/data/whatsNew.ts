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
