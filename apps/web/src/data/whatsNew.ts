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
    version: '0.10.75',
    date: 'June 3, 2026',
    highlight: 'Pick your own ringtone',
    changes: [
      { type: 'new', text: 'Settings → Personal → Ringtone lets you pick which sound plays when someone calls. Four options: Classic (standard North American ring), Modern (brighter + faster), Chime (single soft swell — least intrusive), Pulse (low + fast — for noisy environments). Each option has a Play button so you can preview before saving — no commitments to a sound you\'ve never heard.' },
      { type: 'improved', text: 'Your ringtone choice follows your account across devices. Sign in on a different machine and you get the same ring. All ringtones are synthesized in-browser (no audio files to download) so the dialer bundle stays tiny.' },
    ],
  },
  {
    version: '0.10.74',
    date: 'June 3, 2026',
    highlight: 'Send Praise — celebrate new hires, offers, birthdays from inside ACE',
    changes: [
      { type: 'new', text: 'Admins can now send a Teams-Praise-style celebratory pop-up to one user or broadcast to everyone. Settings → Admin → Send praise. Pick a category (New hire / New offer / Birthday / Work anniversary / Custom), the recipient (one user or Everyone), the display name of who\'s being celebrated, and a short message. The recipient(s) see a big confetti modal next time they\'re idle in the dialer.' },
      { type: 'new', text: 'Smart suppression: the praise modal does NOT pop up while a user is on an active call — recruiters mid-conversation aren\'t yanked out of context. It waits until the call ends, then appears.' },
      { type: 'new', text: 'Per-user read tracking. A broadcast praise is marked read separately for each recipient, so when Abdulla dismisses it, it doesn\'t disappear for Ankit. Admin can see in their send history how many people have viewed each broadcast.' },
    ],
  },
  {
    version: '0.10.73',
    date: 'June 3, 2026',
    highlight: 'Dialer no longer clips at small window sizes / 125% DPI scaling',
    changes: [
      { type: 'fixed', text: 'On smaller Electron windows (especially at 125%+ Windows DPI scaling — common on 1920×1080 laptops), the dialpad\'s "1 2 3" row and number input were getting clipped off the top of the visible area. The layout used bottom-anchored flex with no overflow handling, so when content exceeded the viewport, the FIRST children overflowed UP and got hidden. Switched to top-anchored stacking with the dial button held to the bottom via margin-top:auto — visually identical on tall viewports, content stays visible on short ones.' },
      { type: 'fixed', text: 'Added internal scrolling on the dialpad container as a fallback for users with very small windows or extreme DPI scaling (150%+) where even the new layout overflows.' },
      { type: 'improved', text: 'Desktop app minimum window height bumped from 600 to 800 pixels. At 125% Windows DPI scaling this gives ~640 CSS pixels of usable space — enough for the full keypad to render comfortably. Users can no longer drag the window smaller than what works.' },
    ],
  },
  {
    version: '0.10.72',
    date: 'June 3, 2026',
    highlight: 'Friendly explanations when SMS send fails',
    changes: [
      { type: 'new', text: 'When a message fails to send (immediate failure) or fails to deliver (carrier rejected it later), you now see a plain-English explanation instead of a Telnyx error code. Examples: "Carrier filtered as spam" with detail about 10DLC registration, "Number doesn\'t exist" for invalid recipients, "Recipient blocked you" when they sent STOP. Failed bubbles also turn red so you can spot them at a glance.' },
      { type: 'new', text: 'The error blurb shows both a short label (good for quick scanning) and a longer detail line that explains what likely happened and what to do about it — retry, contact admin, double-check the number, etc. Hover the bubble for the full detail in a native tooltip.' },
    ],
  },
  {
    version: '0.10.71',
    date: 'June 3, 2026',
    highlight: 'Teams Reply/Call leftover browser tab auto-closes',
    changes: [
      { type: 'improved', text: 'After clicking Reply or Call on a Teams notification and letting it open the desktop ACE Dialer, the browser tab that brokered the launch now tries to close itself automatically 1.5 seconds later. Browsers vary on whether they honor close() for tabs they didn\'t script-open — when they do, the tab vanishes silently. When they don\'t, the leftover tab now shows a friendly "ACE Dialer should be opening on your desktop — you can close this tab" message with an explicit Close this tab button, instead of looking like a stuck loading screen.' },
      { type: 'fixed', text: 'Removed the 8-second auto-navigate to /messages or /keypad. Previously the browser tab would silently bounce to /login if the user wasn\'t signed in on the browser — a surprise redirect that scared people. Now the tab stays on the launch page with an explicit "Open in browser composer" / "Open in browser dialer" button if the user wants to fall back to the web app deliberately. No more sneaky redirects.' },
    ],
  },
  {
    version: '0.10.70',
    date: 'June 3, 2026',
    highlight: 'Teams Reply/Call → Electron — actually works now',
    changes: [
      { type: 'fixed', text: 'Teams notification Reply / Call buttons now actually open the Electron desktop app. The v0.10.67 attempt only handled the case where the user was ALREADY inside Electron — for the typical case (Teams card click opens the URL in the default browser, where the user has no ACE session), the auth guard redirected to /login BEFORE the protocol-launch page ever rendered. Moved the /auto/call and /auto/sms routes outside the auth gate so the ace-dialer:// redirect fires immediately, even for unauthenticated browser sessions. The "Open ACE Dialer?" browser prompt now appears reliably; click Allow once (with "Always allow") and future Teams card clicks open Electron silently. The web fallback (when the protocol handler is absent) still works as before for users without the desktop app.' },
    ],
  },
  {
    version: '0.10.69',
    date: 'June 3, 2026',
    highlight: 'Telnyx auto-config — country picker on Invite + Edit country on Users tab',
    changes: [
      { type: 'new', text: 'The "Invite New User" modal now has a Country dropdown (default India). The country drives Telnyx anchorsite selection on the new user\'s Credential Connection — India users get Chennai anchor (lowest latency); US/Other users get Telnyx\'s "Latency" routing (closest site per-call).' },
      { type: 'new', text: 'Settings → Users → kebab menu now has a "Set country (XX)" option. Click to change an existing user\'s country (drives future Telnyx config syncs). The current value is shown right in the menu label. This finishes the v0.10.64 Telnyx auto-config feature — every flow that creates or assigns a Telnyx DID now honors the user\'s country.' },
    ],
  },
  {
    version: '0.10.68',
    date: 'June 3, 2026',
    highlight: 'CRITICAL hotfix — restore aggressive SIP re-register on focus',
    changes: [
      { type: 'fixed', text: 'Inbound calls routing to voicemail for many users (including admin). The v0.10.62 throttle on the visibility-driven REGISTER was too aggressive — it required 30 seconds of "hidden" time AND a 30-second cooldown before re-registering on tab focus. That left users vulnerable to Telnyx silent eviction (their dialer thought it was registered, Telnyx had dropped them) with no proactive recovery for up to 30 seconds. Reverted to always force a defensive REGISTER on visibility=visible, with only a tight 5-second cooldown to prevent the DevTools-pane-switch storm Nilesh originally saw. Visual flicker may return slightly but inbound call reliability comes back to baseline. The proper fix (Telnyx webhook-driven instant eviction detection) is still the next planned release.' },
    ],
  },
  {
    version: '0.10.67',
    date: 'June 3, 2026',
    highlight: 'Telnyx auto-config for new users + Teams deep-link to desktop + faster unread badge refresh',
    changes: [
      { type: 'new', text: 'Every new or migrated user now automatically gets the standard ACE Telnyx configuration applied to their Credential Connection and DID — no more manual setup in the Telnyx Portal. Anchor site picked by country (India → Chennai, US/Other → latency-optimized). DID defaults: HD voice enabled, CNAM listing enabled with caller ID name "ApTask", voicemail enabled with PIN 12345. The Migrate from Pulse modal has a new "Country" dropdown so the right anchor site is applied per user. All settings beyond anchor come from your master template Connection in Telnyx — set its ID via the existing TELNYX_TEMPLATE_CONNECTION_ID env var.' },
      { type: 'fixed', text: 'Teams notification Reply / Call buttons now correctly deep-link into the desktop ACE Dialer instead of dumping you to the web. If you\'re already running ACE inside Electron, the redirect skips the protocol-launch step entirely and just navigates inside the same window. The browser-side fallback timeout extended from 3s to 8s so the "Open ACE Dialer?" prompt has time to be clicked.' },
      { type: 'fixed', text: 'Unread badges (Messages, Voicemail) now clear immediately when you read an SMS thread or listen to a voicemail. Previously the bottom-nav badge stayed at the pre-action count for up to 15 seconds (the next poll interval). Now a custom event fires the moment the read/listen action persists, and the badge refreshes instantly.' },
    ],
  },
  {
    version: '0.10.66',
    date: 'June 3, 2026',
    highlight: 'Multi-number favorites — Cell / Home / Work / Other per contact',
    changes: [
      { type: 'new', text: 'A favorite can now carry multiple labeled phone numbers. Each favorite still shows as one row in the list (no clutter), but if it has more than one number, tap the chevron on the right to expand and see each number with its own label (Cell / Home / Work / Other) and its own call, SMS, and block buttons.' },
      { type: 'new', text: 'Add additional numbers to an existing favorite by expanding the row and clicking "Add number" at the bottom. Each number gets its own label from a quick-pick dropdown. Existing favorites with a single number stay exactly as they were — they\'re automatically backfilled with label "Mobile" so nothing visible changes for them.' },
      { type: 'improved', text: 'Per-number block: blocking from the favorite\'s expanded view only blocks the specific number tapped, not all of the contact\'s lines. So you can block someone\'s work number without losing their cell.' },
    ],
  },
  {
    version: '0.10.63',
    date: 'June 3, 2026',
    highlight: 'Remove Pending Users section from Settings',
    changes: [
      { type: 'improved', text: 'Settings → Admin no longer shows the "Pending Users" section. The bulk-stage-then-invite workflow it served is no longer needed — "Migrate from Pulse" handles the standard one-user-at-a-time onboarding now. The backend endpoints and pending_users table are kept intact in case the workflow needs to be re-exposed later.' },
    ],
  },
  {
    version: '0.10.62',
    date: 'June 3, 2026',
    highlight: 'Fix the v0.10.50 over-aggressive visibility-register cascade',
    changes: [
      { type: 'fixed', text: 'The dialer no longer hammers Telnyx with a fresh SIP REGISTER every time you click between the dialer window and another app. The v0.10.50 "always force a fresh register on focus" defense was meant to recover from silent Telnyx evictions after long absences (laptop sleep, etc.), but it was firing on every tab/window focus — which for users who keep DevTools docked next to ACE meant dozens of REGISTERs in seconds, eventually colliding with Telnyx\'s concurrent-REGISTER guard and triggering a registrationFailed cascade → manual reconnect → visible Disconnected flicker. The forced register now only fires when (a) the document was actually hidden for more than 30 seconds, AND (b) we haven\'t already force-registered in the last 30 seconds. The 10-second heartbeat still handles routine refreshes; this just stops the focus-event spam.' },
      { type: 'improved', text: 'Diagnostic logs now show how long the dialer was hidden and how long since the last forced register, so when SIP issues show up in the console you can tell at a glance whether the visibility recovery was the cause or something else.' },
    ],
  },
  {
    version: '0.10.61',
    date: 'June 3, 2026',
    highlight: 'Fixes for Invalid-Date bubbles + misleading Pulse import warning',
    changes: [
      { type: 'fixed', text: 'Sending an SMS no longer shows "Invalid Date, Invalid Date" on the new bubble. The regression came from v0.10.59 when the send helper was extracted into a shared module — it accidentally narrowed the response shape, dropping createdAt and a few other fields that the bubble renderer needs. The bubble now shows the proper timestamp from the moment the message is sent (no refresh needed).' },
      { type: 'fixed', text: 'All four timestamp formatters (Messages, Recents, Voicemail, Chat) now guard against invalid date inputs and render an empty string instead of "Invalid Date, Invalid Date" if a malformed timestamp ever slips through. Defensive layer in case future code paths produce bad dates.' },
      { type: 'fixed', text: 'Refresh-from-Pulse no longer scares admin with a false-positive bug warning when the user has already been migrated. The previous warning checked only "newly inserted" rows and ignored "already in ACE / skipped as duplicate" — so re-running Refresh on a fully-imported user (every duplicate skipped, 0 new) would alarmingly say "Pulse has X SMS but ACE didn\'t import any — let the devs know." It now correctly sums inserted + skipped and only warns when there\'s a real gap (5% drift tolerance). If everything\'s already imported, you see a calm "All N already in ACE — user is up to date" message instead.' },
    ],
  },
  {
    version: '0.10.60',
    date: 'June 3, 2026',
    highlight: 'Connection Health — pilot smoothing (admin-toggleable)',
    changes: [
      { type: 'new', text: 'Admin → Settings → Users → kebab menu now has a "Enable Connection Health (beta)" toggle per user. When enabled for a user, the dialer no longer flickers Disconnected → Online for brief network blips. Brief blips under 5 seconds stay invisible. Sustained 5-30 second gaps show as amber "Reconnecting…" instead of red "Disconnected". Only after 30 seconds of sustained failure does the status flip to red. The aim: stop the noisy red/green flicker that causes user stress without changing actual call behavior. Default off; enable for pilot users first.' },
      { type: 'fixed', text: 'Telnyx silent-eviction recovery layer is coming in v0.10.60-rc2. The current release smooths only the visible flicker — calls can still go to voicemail if the heartbeat takes a moment to notice an eviction. RC2 will add server-driven instant reconnect (latency <1 second) once the webhook subscription is configured on Telnyx. Pilot users on this RC1 should validate that the flicker reduction feels right before we layer on the deeper fix.' },
    ],
  },
  {
    version: '0.10.59',
    date: 'June 3, 2026',
    highlight: 'Schedule an SMS or MMS to send later',
    changes: [
      { type: 'new', text: 'New clock icon next to the Send button in any SMS thread. Click it, pick a date and time, and the message goes into a queue that fires automatically at that moment — even if you\'ve closed the dialer. Works for plain SMS and for MMS with attachments. Quick-pick buttons for "+1 hour", "Tomorrow 9am", and "Monday 9am" cover the common cases; pick a custom datetime for anything else.' },
      { type: 'new', text: 'Pending scheduled messages now show as an amber strip at the top of the thread so you always see what\'s queued for that contact. Edit or cancel before it fires — once it sends, the strip disappears and the message appears in the conversation like any other outbound SMS.' },
      { type: 'new', text: 'Scheduled messages send from the DID you had selected when you scheduled them, even if you later switch your active line. So a recruiter who scheduled "send Monday 9am from Sales line" doesn\'t accidentally fire it from their personal DID on Monday.' },
    ],
  },
  {
    version: '0.10.58',
    date: 'June 3, 2026',
    highlight: 'Manual DID override on Pulse migration',
    changes: [
      { type: 'new', text: 'Admin → Migrate user from Pulse modal now has an optional "DID override" field. When Pulse has stale or wrong data on a user (e.g. voip_number points at a number Telnyx no longer recognizes), admin can paste the correct DID and migration uses it instead of trusting Pulse. Verified case: Roshni Sahani — Pulse stored 4706008030 but her real Telnyx DID is 4706168494. The override usage is recorded in the audit log alongside whatever Pulse said, so we have a trail.' },
    ],
  },
  {
    version: '0.10.57',
    date: 'June 3, 2026',
    highlight: 'Messages page width matches Recents',
    changes: [
      { type: 'fixed', text: 'The Messages page now renders the same width as Recents. Previously the conversation list collapsed to the natural width of its header, which made names truncate too aggressively. Messages and Recents now share a single 480px centered column for visual consistency.' },
    ],
  },
  {
    version: '0.10.56',
    date: 'June 3, 2026',
    highlight: 'Timestamps everywhere + safer Recents row tap',
    changes: [
      { type: 'improved', text: 'Recents, Messages, Voicemail, and Chat rows now show the time-of-day on every row, not just on rows from today. "Yesterday" becomes "Yesterday, 9:37 AM"; "Jun 1" becomes "Jun 1, 9:37 AM". You can scan when each call/SMS/voicemail actually landed.' },
      { type: 'improved', text: 'Tapping a Recents row no longer auto-dials. It now copies the number to your clipboard and shows a brief "Copied" pill. To actually place the call, tap the new Phone icon on the right of the row. The SMS, favorite, and block buttons keep working as before. This stops accidental redials from a stray click and lets you paste the number into another app (a text, an email, a CRM record).' },
    ],
  },
  {
    version: '0.10.55',
    date: 'June 3, 2026',
    highlight: 'Cleaner call history + paste-to-send images',
    changes: [
      { type: 'fixed', text: 'Interaction history modal no longer shows duplicate rows for the same call. A single call could appear as two entries (one labeled "originator_cancel" and one "Canceled", or two rows with slightly different durations) because Telnyx fires events for both legs of a call. Recents already collapsed these — the per-contact history modal was missing the same step.' },
      { type: 'new', text: 'Paste an image directly into the message box to send as MMS. Copy a screenshot (Snipping Tool, Print Screen, Cmd+Shift+4, drag from another window), click into a thread, press Ctrl+V (or ⌘+V), and the image uploads as an attachment without you needing to save it to disk first. Plain text paste still works as before.' },
    ],
  },
  {
    version: '0.10.54',
    date: 'June 3, 2026',
    highlight: 'SMS templates feel right',
    changes: [
      { type: 'fixed', text: 'Picking a template now auto-fills the recruiter\'s own name into {recruiter} (was being left as the literal placeholder). Combined with {firstName} auto-fill from the contact, a cold-outreach template now reads "Hi Jean, this is Abdulla from ApTask..." the instant you pick it.' },
      { type: 'fixed', text: 'SMS compose box now auto-grows to show the full message after picking a template. Previously the box stayed one line tall, hiding most of the content and forcing you to scroll inside a tiny strip. The box now expands to fit content up to about 9 lines, then scrolls.' },
    ],
  },
  {
    version: '0.10.53',
    date: 'June 3, 2026',
    highlight: 'Admin visibility into blocked numbers + override',
    changes: [
      { type: 'new', text: 'Settings → Blocked numbers (all users) (admin only). One screen showing every block created by every user on the team, the reason they gave, when, and which user. Searchable by user / number / reason. Click "Override" on any row to remove a block on a user\'s behalf — the action is recorded in the audit log.' },
      { type: 'improved', text: 'The Blocked numbers page (for regular users) now reminds users to add a reason: "Your admin can see every block on the team and may need context." Helps admins audit blocks intelligently.' },
    ],
  },
  {
    version: '0.10.52',
    date: 'June 3, 2026',
    highlight: 'Recruiter SMS templates — pick from a playbook',
    changes: [
      { type: 'new', text: 'A "Templates" button appears next to the emoji picker in every SMS compose box. Click to open a popover grouped by category (initial outreach, documents, submission, interview, follow-up, outcomes, BGV, relationship). Pick a template and the message loads into the compose box with the contact\'s first name auto-filled. Other placeholders ({role}, {client}, {time}, etc.) stay as {variable} so the recruiter can fill them inline before sending.' },
      { type: 'new', text: 'Settings → SMS templates (admin only). Admin can create, edit, archive, and re-order templates. One-click "Seed default playbook" loads the built-in 20-template recruiter playbook (idempotent — safe to run multiple times). Templates are tenant-wide; every user sees the same picker.' },
    ],
  },
  {
    version: '0.10.50',
    date: 'June 3, 2026',
    highlight: 'Fewer missed calls on return to desktop + hold music lockdown',
    changes: [
      { type: 'fixed', text: 'When you walked away from your desktop and came back to find a missed call that should have rung, the dialer was assuming its SIP registration was still valid even though Telnyx had silently evicted it. The dialer now force-refreshes its registration with Telnyx the moment your window regains focus — no waiting for the next 10-second heartbeat to maybe-catch-it. Cuts missed-call rate after long idle periods significantly.' },
      { type: 'improved', text: 'Hold music: users now see the toggle to enable/disable, but only admins can upload, replace, or remove the audio file. The admin\'s tenant default is the source of truth. Reduces accidental "I uploaded my favourite song" moments.' },
      { type: 'improved', text: 'Removed the "Yesterday\'s activity" banner that appeared on first sign-in each day. We\'ll come back to this in a different form (maybe an AI summary) once we land a few other priorities.' },
    ],
  },
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
