# ACE Dialer — Features

What ACE Dialer can do as of v0.10.8 (May 28, 2026).

## Calling

### Outbound voice
- Place calls to any PSTN number via WebRTC → Telnyx
- Number formatting / country detection via libphonenumber-js
- Country flag picker for international dialing
- Recent numbers + Favorites + JobDiva contact lookup inline
- Click-to-dial from Recents, Voicemail, Messages, Teams cards
- Caller ID Override per user — outbound calls present the user's own DID,
  not a shared pilot number

### Inbound voice
- Telnyx TexML application rings the user's WebRTC SIP credential
- Custom ringer window (Electron) so calls aren't missed when the main window
  is minimized to tray
- Per-user DID routing — calls to `+15555550100` ring whoever owns that DID
- Multi-DID inbound — calls to any of the user's DIDs ring the user; the
  Recents row shows which line was touched via a colored badge
- Caller name lookup via JobDiva (cached per session) if the caller is a
  known JobDiva contact
- Local block list — per-user blocked numbers; blocked calls get USER_BUSY
  back at the Telnyx layer (no voicemail fallthrough)

### In-call controls
- Mute / unmute (mic)
- Hold / resume
- DTMF keypad during active call
- Record-while-talking (recording attaches to the Call row)
- Add call — bring a third party in via Telnyx Conference (independent
  hangup behavior per leg)
- Real-time call quality meter (RTT + jitter, India-calibrated thresholds)
- Active call survives window-minimize-to-tray (no audio drop)

### Call ending
- Telnyx hangup_cause classified into: completed / no_answer / rejected /
  forwarded / blocked / failed
- Calls that ended without `answered_at` set are correctly classified as
  missed (handles caller-cancelled, no_answer, rejected, busy)

## SMS / MMS

- Outbound SMS from any of the user's DIDs (uses the active DID as From)
- Outbound MMS — upload an image, sent as MMS via Telnyx
- Inbound SMS routed by To number — lands in the right user's inbox
- Inbound MMS — media URLs stored on Message row
- Per-thread mark-as-read state — unread dot persists until thread opened
- Search across threads + within a thread
- Per-thread mute (block sender from future SMS card notifications without
  blocking calls)
- Compose new message — pick recipient via JobDiva search, contacts, or
  manual number entry
- SMS notifications via Microsoft Teams (see Teams Notifications below)

## Voicemail

- Telnyx Hosted Voicemail captures recordings on no-answer
- Per-user retention — 30 days, auto-purged on next list fetch
- Deepgram Nova-3 transcription with `language: multi` for accented English
  (Indian English transcribed accurately)
- Transcription retries once after 3 seconds on Deepgram failure
- Telnyx Bearer-authenticated audio proxy — browser can play voicemails
  served from `/voicemails/:id/audio` (audio bytes streamed with the right
  MIME type and caching headers)
- Voicemail playback page (`/voicemail/:id/play`) — full-page view with
  audio player, transcript, caller info, call back / send text buttons
- Voicemail dedup — Telnyx firing both `calls.voicemail.completed` AND
  `call.recording.saved` no longer produces two rows for the same message
- Voicemail notifications via Microsoft Teams (see below)

## Multi-DID (Multiple lines per user)

Schema: each User has one or more UserDid rows. One is flagged `isDefault`
and is the active outbound caller ID. Inbound calls/SMS/voicemails get tagged
with the matched UserDid so the UI can render a line badge per row.

### User-facing
- **Header DID switcher** — dropdown in the top bar with all of the user's
  DIDs. Switching DIDs changes the outbound caller ID (server applies
  ani_override on the Telnyx connection).
- **Line badges** — Recents, Messages, Voicemail rows show a small colored
  pill with the line's label so the user knows which number was used.
- **Single-DID users** see a static display with no dropdown affordance —
  zero new UI burden for the common case.

### Admin-facing
- **Admin → Users → Manage lines** opens a modal showing the user's current
  DIDs with their colors, labels, default status, and edit/remove buttons.
- **Add line** sub-modal — picker for "Use an existing unassigned number"
  vs "Buy a new number" from a specified area code.
- **Inline label editor** — pencil icon next to each line's label opens an
  input in place (Enter saves, Escape cancels).
- **Color picker** — six preset colors per line; renders in the line badge
  across the app.
- **Set as default** — toggles `isDefault` and updates the user's active
  outbound caller ID server-side.

## Microsoft Teams notifications

Cards delivered automatically to each user's Teams chat with Flow bot for
three event types: **missed call**, **inbound SMS**, **voicemail**.

### How it works
- One tenant-wide Power Automate flow (`TEAMS_TENANT_WEBHOOK_URL`) accepts
  a JSON payload of `{ recipientEmail, eventType, card }`. The flow's
  "Post adaptive card and wait for a response" action delivers the card to
  the user identified by recipientEmail.
- No per-user setup. New users are automatically opted into all three event
  types via the DB default on `users.teams_notify_on`.
- Settings → Personal → Teams notifications has three toggle checkboxes so
  users can mute any of the three event types.

### Card contents
- **Missed call card** — caller's number (formatted), line context if
  multi-DID, timestamp. Buttons: **Call back**, **Send text**.
- **Inbound SMS card** — sender's number, message text in an emphasis
  container, line context if multi-DID, timestamp. Buttons: **Reply**, **Call**.
- **Voicemail card** — caller's number, duration, transcript text, line
  context if multi-DID, timestamp. Buttons: **Listen** (web playback page),
  **Call back**, **Send text**.

### Notification reliability
- Single retry after 2s on 5xx / network errors (4xx bails immediately —
  permanent failure).
- In-memory dedup for missed-call + voicemail to handle Telnyx webhook
  retries (Telnyx fires call.hangup multiple times per call).
- SMS dedup via explicit findUnique→create-or-update pattern (previous
  upsert + notify pattern was re-firing on Telnyx retries).
- Missed-call card fires IMMEDIATELY on call.hangup (no setTimeout — Render
  hibernation killed in-process timers). Voicemail card, if also sent for
  the same call a few seconds later, is delivered as a separate card.

### Card buttons → desktop hand-off
- Card action URLs point at `https://<web>/auto/call?to=+1...` and
  `.../auto/sms?to=+1...` (not `ace-dialer://` deep links directly).
- These web pages fire `window.location.href = 'ace-dialer://...'` to
  invoke the desktop app's protocol handler. Browser shows native
  "Open ACE Dialer?" prompt; first time the user clicks Allow + checks
  "Always allow", subsequent clicks open silently.
- After ~3 sec, the page falls back to the in-browser dialer (`/keypad`
  or `/messages`) with the recipient prefilled. Works on mobile / no-app
  scenarios.
- Desktop main process recognizes `ace-dialer://call?to=...` and
  `ace-dialer://sms?to=...`, focuses the window, IPC-bridges the action
  to the renderer, which navigates to the right page with prefill.

## Chat (internal messaging)

- 1:1 chat between ACE Dialer users (not external PSTN — that's SMS)
- Real-time delivery via WebSocket (`apps/socket`)
- Presence: Online / Away / Idle / Offline indicators
- Sort by presence — reachable teammates float to the top
- Per-thread unread counts + last-message preview
- Per-thread mark-as-read on open
- Search across chats

## Authentication

### Microsoft SSO (primary)
- Entra ID app registration with PKCE flow (no client secret in the SPA)
- Confidential client exchange on the backend (`/auth/microsoft/exchange`)
- Returns the dialer's own JWT for subsequent API calls
- Auto-provisions a User row on first login if the email is on the
  pre-invited list (`PendingUser` table)
- Refuses to auto-create users not on the invited list — admin must add
  them via the Pending Users admin UI first

### Password (break-glass)
- Bcrypt-hashed password column, primarily for the admin account
- Tucked behind a "Sign in with password (admin only)" link on the login
  page so regular users don't see it

### Session
- JWT stored in `sessionStorage` (per-tab, cleared on browser close)
- Fetch interceptor catches 401 and bounces to /login
- SIP watchdog catches SipContext stuck in 'failed' state and treats as
  expired session

### Microsoft SSO deep-link return-to
- When a user clicks a Teams card link in a fresh browser tab (no session),
  they're redirected to /login. The originally requested URL is stashed in
  `sessionStorage.ace_return_to`. After successful MS SSO, the user is
  navigated back to the original URL — so a Teams card click eventually
  lands them in the right place even if SSO was required mid-flow.

## Admin features

### Users tab
- List all users (excludes tombstoned `@deleted.ace.local` users)
- Invite a new user (full provisioning flow — see admin runbook)
- Manage lines for a user (multi-DID admin UI)
- Reset SIP credentials
- Deactivate / reactivate a user
- View per-user audit log

### Pending users tab
- See pre-invited users who haven't yet completed first sign-in
- Bulk-import via CSV upload
- Manually add a single pending user
- Resend invite email

### Audit log
- Every admin action (user.invited, user.deactivated, user.teams_config_updated,
  did.assigned, did.removed, did.default_changed) recorded with actor,
  target, and JSON payload
- Filter by date, action type, target user

### CSV import
- Bulk-import users from a Pulse export CSV
- Per-row provisioning result (success / failure with reason)
- Idempotent — re-running the same CSV doesn't duplicate users

## Desktop app (Electron)

- Tray icon — left-click brings up the main window, right-click context
  menu (Open / Quit)
- Hide-to-tray on window close (active call audio keeps going)
- Floating ringer window — pops up on inbound call regardless of main
  window visibility; click Accept or Decline to forward to main window
- Custom URL scheme `ace-dialer://` registered as default handler
  - `ace-dialer://auth/callback?code=...` — MS SSO callback
  - `ace-dialer://call?to=+1...` — focus dialer + prefill caller pad
  - `ace-dialer://sms?to=+1...` — focus dialer + open composer with prefill
- Silent auto-update via electron-updater
  - Checks GitHub Releases on launch + every 60 min while running
  - Downloads new installer in background
  - UpdateBanner shows "Restart to install" when ready
  - Manual "Check for updates" available in the user menu
- backgroundThrottling disabled — the renderer stays responsive when
  hidden so SIP register-refresh timers don't get clamped

## UI / UX standards (locked rules)

Documented in `CLAUDE.md` at repo root. Summary:

- Modals are real overlays (position:fixed, full-viewport backdrop ≥70%
  opacity, centered)
- Modal content scrolls to top on open
- Page contents scroll to top on tab / settings-section change
- Stacked modals — parent backdrop dims further when child opens
- Both dark + light theme supported; light-mode contrast passes WCAG AA
- Verified at 1366×768 minimum resolution

## Reliability / operational features

- Fetch interceptor for session expiry (401 → bounce to /login)
- SIP watchdog (stuck-failed state → bounce to /login)
- SIP register-refresh retry with backoff (2s/4s/8s) — gated against
  active calls so retries don't kill in-progress calls
- Mid-call status flap suppression — JsSIP "connecting"/"disconnected"
  events don't flip UI state during active calls
- Cloudflare TURN for India users (Mumbai + Bangalore PoPs) — runtime
  TURN injection via `/turn-credentials` API endpoint
- Voicemail transcription Bearer auth + retry — fetches Telnyx recording
  with our API key, retries once after 3s if Deepgram fails

## Settings (user-facing)

### Personal
- Name (first/last)
- Display name format
- Default outbound number (DidSwitcher)
- Teams notifications opt-ins
- Audio devices (input mic, output speaker, ringer)
- Auto-update toggle (desktop)
- Theme (dark/light/system)

### Telnyx
- SIP credential username + password (used by JsSIP / @telnyx/webrtc)

### Audit
- Read-only view of your own actions for the last 90 days

## What's NOT yet implemented

- **Ring Groups (Pillar 3)** — multi-agent inbound routing (round-robin
  or simultaneous, with group voicemail)
- **IVR (Pillar 4)** — caller-selected DTMF routing
- **Call recording playback** — recordings are captured but no built-in
  player exists for record-while-talking calls (voicemail has playback;
  generic recordings do not)
- **Staging environment** — main is production for web/API/webhooks
- **Feature flags** — every change ships to all users
