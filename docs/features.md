# ACE Dialer — Features

What ACE Dialer can do as of v0.10.105 (June 8, 2026).

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

### Audio quality (v0.10.21)
- **User-controlled noise suppression** — Settings → Microphone → "Noise
  suppression" toggle. Default OFF. When enabled, Chrome's built-in
  RNNoise filter scrubs keyboard taps, AC hum, fans, and other background
  noise from the user's outbound audio before it reaches Telnyx. Users
  in noisy environments (cafes, open offices) toggle ON; users with
  high-quality headsets generally leave it off to avoid the slight
  "tunnel/pipe" artifact RNNoise can produce. Read fresh on every call —
  no reload required after toggling.
- Echo cancellation + auto gain control always on (required for VoIP).
- Future: Telnyx Krisp Viva server-side suppression as a per-Credential-
  Connection option (pending Telnyx add-on activation).

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
- **Add line** sub-modal — picker with three options (renamed in v0.10.20
  for clarity):
  - **Add an available number from Telnyx** — pick from numbers already
    in your Telnyx inventory that aren't currently bound to any voice or
    messaging connection. $0.
  - **Purchase a new DID from Telnyx** — buy a fresh local US number
    (~$0.45 setup + $0.45/mo). User gets a new phone number.
  - **Migrate Existing User to New Dialer** (v0.10.20) — see below.
- **Inline label editor** — pencil icon next to each line's label opens an
  input in place (Enter saves, Escape cancels).
- **Color picker** — six preset colors per line; renders in the line badge
  across the app.
- **Set as default** — toggles `isDefault` and updates the user's active
  outbound caller ID server-side.

### Migrate Existing User to New Dialer (v0.10.20–v0.10.22)
The marquee feature for migrating from the legacy Pulse dialer. Takes a
Telnyx DID that's currently bound to another connection (typically Pulse)
and rebinds it to the target user's ACE Credential Connection — without
changing the phone number itself.

- **Picker with typeahead search** — Pulse customers can have hundreds of
  DIDs across many connections. The search input matches against phone
  digits, connection name, AND SIP username, so the admin can find any
  number quickly.
- **Connection name + SIP user shown in the picker** — each candidate
  reads like *"(732) 555-1234 — Pulse: jdoe@aptask (SIP user: aptask123)"*.
  Backend dedupes connection lookups so a connection with 50 DIDs only
  triggers one Telnyx API call. Works across all Telnyx connection types
  (Credential, FQDN, IP, SIP) via the generic `/connections/{id}` endpoint.
- **One-click rebind** — selecting + submitting calls
  `POST /admin/users/:id/dids/migrate` which:
  - Validates the DID isn't already in ACE
  - Reads the current `connection_id` (captures `previousConnectionId` for
    audit + cleanup)
  - PATCHes the DID's `connection_id` to the user's ACE connection
  - Binds the DID to ACE's messaging profile (inbound SMS routing)
  - Creates the `UserDid` row with the admin's chosen label/color/default
  - Audits as `user_did.migrated` with full before/after state
- **Post-migration cleanup prompt (v0.10.21)** — admin lands on a new
  modal step after successful migration showing the previous Pulse
  connection (name + SIP user) and three buttons:
  - **Deactivate** — sets `active=false` on the Telnyx Credential
    Connection. SIP REGISTER from Pulse stops working immediately,
    but the connection is recoverable.
  - **Delete** — calls `DELETE /credential_connections/{id}`. Irreversible.
  - **Keep** — does nothing, just closes the modal.
- **30-day history backfill (v0.10.22)** — after a successful migration,
  a background job (fire-and-forget, doesn't block the response) pulls
  the last 30 days of voice CDRs + ALL SMS history from Telnyx for the
  migrated number, in BOTH directions, and inserts deduped rows into
  ACE's `Call` + `Message` tables. The user opens Recents / Messages and
  sees their history reconstructed automatically. Each SMS thread
  rebuckets by the other party's number. Voicemails are NOT included
  because Pulse-side voicemails live in Pulse's database, not Telnyx.
- **Email + Teams notifications fire on migrate** (v0.10.20) — the
  target user receives an email and a Teams DM saying
  *"Your number has been migrated to ACE Dialer"*.

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


## Voicemail v2 (Call Control flow — v0.10.100+)

### Inbound call routing (per migrated DID)
- DID is bound to the Telnyx **ACE Voicemail Voice API App**, not directly to the SIP credential. The webhooks service is the first thing Telnyx talks to on every inbound call.
- On `call.initiated`, the handler looks up the owning user, issues `transfer` to `sip:<sipUsername>@sip.telnyx.com` with a 25-second timeout, and preserves the caller's E.164 as `from` so caller ID is intact.
- Softphone answers → `call.bridged` → audio flows. No voicemail row written.
- Softphone doesn't answer (timeout / 486 busy / 603 decline) → dial leg's `call.hangup` fires → handler answers the caller leg → plays greeting → records → saves Voicemail row.

### Greetings (per user, two variants)
- **No-answer greeting** — plays when the softphone rings out without being picked up.
- **Busy greeting** — plays when the softphone returns SIP 486 (already on another call) or 603 (Decline). Falls back to the no-answer greeting if not configured, so callers never hit silence.
- Each variant supports three modes:
  - **Default** — stock TTS: "You've reached <firstName>'s voicemail. Please leave a message after the tone."
  - **Text-to-speech** — user-typed up to 500 characters, read aloud by Telnyx TTS in a natural voice.
  - **Audio** — user-uploaded MP3 / WAV / M4A / AAC / OGG / WebM (≤ 2 MB) **or** recorded directly in-app via the `MicrophoneRecorder` component (30-second cap, MediaRecorder API).
- Mode + content per variant persists independently — switching tabs doesn't erase the other config.

### Recording capture
- `record_start` action with `format: 'mp3'`, `channels: 'single'`, `play_beep: true`, `max_length: 90` (seconds), `timeout_secs: 4` (silence-detection auto-stop).
- Telnyx returns a 10-minute-signed S3 URL on `call.recording.saved`. The webhook handler downloads the audio and re-uploads to the existing Supabase `ace-media` bucket at `voicemails/u{userId}/{voicemailId}.mp3`. The Voicemail row's `recordingUrl` is updated to the permanent Supabase public URL, so playback never expires.

### Voicemail downstream side-effects (fired after Voicemail row written)
- **Deepgram transcription** (existing `transcribeAndUpdateVoicemail`) — transcript populated within ~30 seconds, marked-as-listened state honored.
- **Teams notification** (via `scheduleVoicemailTimeoutFallback`) — adaptive card to the user's Teams channel with transcript + listen link.
- **Email notification** (via `scheduleVoicemailEmailTimeoutFallback`) — SendGrid email with audio link + transcript, dedup-protected so the user gets at most one email per voicemail.

### Missed-call classification (v0.10.104+)
- Any inbound call that **ended without being answered** is classified as `missed`, regardless of Telnyx's `hangup_cause` string. The legacy classifier mapped `originator_cancel` (caller gave up before pickup) to `completed`, which made Recents show the row as a plain incoming call with no red flag. Now we check `priorCall.answeredAt is null` first and force `missed` if so, only deferring to the cause-specific labels (`rejected` for busy/declined, `forwarded` for transfers, etc.) when the call WAS answered.

## Device tracking + force-update (v0.10.101+)

- **Per-device heartbeat.** The dialer client (Electron or web) generates a stable `deviceId` UUID (stored in `localStorage`) on first launch. Every login + window focus + 60-second interval, it POSTs to `/me/heartbeat` with `{ deviceId, platform, appVersion, osLabel }`. Server upserts the `UserDevice` row and returns `{ forceUpdate, forceUpdateRequestedAt }`.
- **Admin Devices modal.** Settings → Admin → Users → kebab → "Devices" shows every device per user with platform, app version, last-seen / first-seen, and a per-device "Force update" button.
- **Force-update mechanism.** Admin clicks Force update → server sets `forceUpdateRequestedAt = now()` → next client heartbeat sees the flag → triggers `window.ace.checkForUpdates()` (Electron) which kicks off `autoUpdater.checkForUpdatesAndNotify()` → user gets the standard update prompt within ~60 seconds. Web clients reload instead.
- **Future-proof for iOS / Android.** The `UserDevice.platform` column accepts any string; a future iOS / Android native client just needs to POST to `/me/heartbeat` with its own `deviceId` + `appVersion` to start appearing in the admin Devices list.

## Telnyx outage detection (v0.10.103+)

- **Server-side poller** on the webhooks service polls `https://status.telnyx.com/api/v2/status.json` and `/api/v2/incidents.json` every 60 seconds. Caches the latest indicator (`none` | `minor` | `major` | `critical` | `maintenance`), description, and unresolved incidents in memory.
- **`GET /telnyx-status`** public endpoint (no auth) returns the cached state. Read by the dialer's `TelnyxStatusBanner` component.
- **Dialer banner.** A colored strip at the top of the dialer renders whenever the indicator isn't `none`. Amber for `minor` / `maintenance`, red for `major` / `critical`. Click "Details" to open status.telnyx.com.
- **Teams notification on transitions.** When the indicator flips from `none` → degraded, an adaptive card posts to `TEAMS_TENANT_WEBHOOK_URL` listing the indicator + active incidents. Sends a recovery card when status returns to `none`.

## Admin operational features (v0.10.99 – v0.10.105)

### Per-user voicemail migration (v0.10.100)
- `GET /admin/users/:id/voicemail-migration` — current state per DID (which are migrated, which are still on legacy Hosted VM).
- `POST /admin/users/:id/voicemail-migrate` — flip every one of the user's DIDs at Telnyx from their legacy `connection_id` to the ACE Voicemail Voice API app, disable Hosted VM, snapshot the previous state into `UserDid.preMigrationConnectionId` + `preMigrationHostedVmEnabled`.
- `POST /admin/users/:id/voicemail-rollback` — restore previous routing exactly. Re-enables Hosted VM if it was on before.
- All operations audit-logged via `recordAudit`.

### Custom app icon (v0.10.102+)
- Replaces the default Electron logo on Windows taskbar / Mac dock / Linux app menu / installer artwork. Source SVG at `apps/desktop/assets/icon.svg`; multi-resolution `.ico`, `.icns`, `.png` regenerated as needed via ImageMagick + a small Python script that builds the proper ICNS container.
