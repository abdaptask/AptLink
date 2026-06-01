# ACE Dialer Changelog

## v0.10.23 — May 30, 2026

**Theme:** Desktop installer pipeline hardening after recurring Apple
notarization flakes.

### Fixed
- **Windows installer build decoupled from Mac.** Removed the `needs: mac`
  dependency on the Windows job. Apple's notarytool API had repeatedly
  timed out (errors -1001 and -1005 on consecutive runs), and the
  dependency meant Windows installers couldn't ship whenever Apple had a
  bad day.
- **Mac build resilience.** The packaging step now retries up to 3 times
  with a 60-second sleep between attempts. If all three notarization
  attempts fail (Apple-side outage), the workflow falls through to a
  signed-only build (still cryptographically signed via the developer
  certificate — just not notarized). End users in that worst case
  right-click the .dmg → Open the first time; macOS remembers thereafter.
  Combined with the Windows decoupling, the installer pipeline now has
  no single point of failure on Apple's side.

## v0.10.22 — May 30, 2026

**Theme:** 30-day data backfill after migration + Microsoft Graph Teams
notifications (Power Automate replacement).

### Added
- **30-day call + SMS history backfill after migration.** When an admin
  migrates a number from Pulse to ACE, a background job (fire-and-forget,
  non-blocking) pulls the last 30 days of voice CDRs and ALL SMS history
  from Telnyx for that number — in both directions, every contact the
  user texted with. Inserts bucket cleanly into the Recents tab and
  Messages tab (per-contact threads reconstruct automatically). Voicemails
  not included — Pulse-side voicemails live in Pulse's DB, not Telnyx.
- **Microsoft Graph Teams integration via service account.** Tenant-wide
  `acebot@aptask.com` service account holds an OAuth refresh token. The
  backend uses Graph API directly (`/users/{email}` → `/chats` create →
  `/chats/{id}/messages` send Adaptive Card) instead of the previous
  Power Automate flow. Settings → Admin → Teams connection shows the
  connection status and offers Connect/Disconnect.
- **`apps/api/src/auth/microsoft.ts`** — full OAuth2 helper: builds
  authorize URL, exchanges code for tokens, refreshes access tokens with
  60-second safety margin, persists in the new `MsServiceToken` Prisma
  model.
- **`apps/api/src/lib/migrationBackfill.ts`** — backfill orchestrator
  with Telnyx-CDR → `Call` row mapper and Telnyx-MDR → `Message` row
  mapper. Dedupes via Prisma's `createMany({ skipDuplicates: true })`.

### Changed
- **`apps/api/src/lib/teamsNotify.ts`** — completely rewritten. Previous
  version POSTed to the Power Automate flow webhook URL with eventType +
  card. New version uses Graph API directly with the stored refresh token.
  Adapter card payload format unchanged.
- **4 new admin OAuth routes**: `GET /admin/microsoft/oauth/initiate`,
  `GET /admin/microsoft/oauth/callback` (public — Microsoft hits this),
  `GET /admin/microsoft/oauth/status`, `POST /admin/microsoft/oauth/disconnect`.

### Notes
- Power Automate flow that previously handled all Teams cards was deleted
  from the tenant; Microsoft also moved HTTP triggers behind Power Automate
  Premium ($15/user/mo). The Graph approach costs only 1 Microsoft 365
  license for the service account (~$6/mo Business Basic) and removes any
  Power Automate dependency.
- Required env vars on the API service: `MS_GRAPH_CLIENT_ID`,
  `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_SECRET`, `MS_GRAPH_REDIRECT_URI`.
- After deploy, admin clicks Settings → Admin → Teams connection → Connect
  ONCE, signs in as acebot, and all Teams notifications resume.

## v0.10.21 — May 30, 2026

**Theme:** Post-migration cleanup, noise suppression, and several picker
fixes uncovered during testing.

### Added
- **Post-migration cleanup prompt.** After a successful "Migrate Existing
  User to New Dialer" operation, the admin lands on a new modal step
  showing the previous Pulse-side connection (name + SIP user) and three
  buttons: **Deactivate** (reversible — sets the Telnyx Credential
  Connection's `active=false`), **Delete** (permanent), or **Keep**.
  Both actions audited via `telnyx.connection.deactivated` /
  `telnyx.connection.deleted` audit entries.
- **Noise suppression toggle** — Settings → Microphone → "Noise
  suppression". Default OFF (preserves legacy behavior; Chrome's RNNoise
  can produce a "tunnel/pipe" artifact on some headsets). Users in noisy
  environments (cafes, open offices, India home setups with AC + traffic)
  toggle ON. Stored in `localStorage` and read fresh on every getUserMedia
  call so the change takes effect on the next call without reload.

### Fixed
- **"Unknown connection" in migrate picker** — picker was showing
  "Unknown connection" for DIDs bound to non-credential Telnyx connection
  types (FQDN, IP, SIP). Cause: `/credential_connections/{id}` returned
  404 for those types. Fixed with a new `fetchAnyConnection()` helper that
  uses the generic `/connections/{id}` endpoint which works for all types.
- **Incoming-call line badge invisible in light mode.** The
  `[data-theme="light"]` CSS override was forcing the badge text to use
  the dark-on-light theme color even though the incoming-call full-screen
  always has a dark green gradient background. Removed the light-theme
  overrides so the badge text + border always stay white.

### Backend
- **`POST /admin/telnyx/connections/:id/cleanup`** — admin route for the
  cleanup prompt. Accepts `{ action: 'deactivate' | 'delete', reason? }`.
  Refuses if any UserDid still references the connection (would orphan a
  user immediately).
- **`telnyx.deactivateCredentialConnection(connectionId)`** —
  PATCHes `/credential_connections/{id}` with `{active: false}`.
- **`telnyx.fetchAnyConnection(connectionId)`** — generic lookup.

## v0.10.20 — May 30, 2026

**Theme:** Migrate Existing User to New Dialer flow — end-to-end UI + email
notifications + invite-modal copy polish.

### Added
- **Migrate Existing User to New Dialer.** New third option in Add Line
  ("Add a line" → mode picker) alongside "Add an available number from
  Telnyx" and "Buy a new number". Re-binds a Telnyx DID currently routed
  to another connection (likely Pulse) to the target user's ACE
  Credential Connection. The phone number stays the same; the old dialer
  stops receiving calls for it immediately.
  - Backend: `POST /admin/users/:id/dids/migrate` — validates target user,
    looks up DID via `findNumberByE164`, refuses if already in ACE,
    re-binds voice + messaging profile, creates UserDid row, audits as
    `user_did.migrated` with `previousConnectionId` captured.
  - Backend: `GET /admin/telnyx/migration-candidates` — lists Telnyx
    DIDs bound to ANY connection but not yet in ACE's UserDid table.
    Enriches each candidate with connection name + SIP username (via
    server-side dedup'd lookups so a 50-DID Pulse connection only
    triggers one API call).
  - Frontend: full picker UI with typeahead search filter (matches
    phone digits, connection name, AND SIP user), label + color + default
    fields, submit handler.
- **`sendLineAssignedEmail`** in `apps/api/src/email/sendgrid.ts`. New
  email template fires when an admin adds OR migrates a line to an
  existing user. Templated copy adjusts based on whether it's an "added"
  or "migrated" line. Subject e.g. *"A new phone line has been assigned
  to you: (732) 555-1234"* or *"Your phone line (732) 555-1234 has been
  migrated to ACE Dialer"*.
- **Search filter in the migrate picker.** Typeahead input above the
  dropdown filters candidates by phone digits, connection name, OR SIP
  user. Shows "N of M matching" or just "M candidates" depending on
  filter state. Essential when Pulse customers have hundreds of DIDs.

### Changed
- **Invite-modal label renames** (per user feedback).
  - "Purchase a new DID" → "Purchase a new DID from Telnyx"
  - "Use an ACE number you already own" → "Use a new number from Telnyx
    database that you already own"
  - Applied in both the Pending Users invite modal and the Settings
    auto-provision section.
- **Incoming-call line badge contrast bumped** (v0.10.10's improvements
  were still hard to read on some displays). Background opacity went
  from 18% → 32% white. Border from 1.5px @ 30% → 2px @ 55%. Font from
  15px / 600 → 17px / 700. Removed text-shadow which was causing a
  subtle haze on some displays.

### Notes
- v0.10.20 was initially pushed with the migrate-UI placeholder still in
  place because the final picker + submit code got wiped by a
  `git merge --abort` mid-session. All four files (telnyx/numbers.ts,
  admin.routes.ts, api.ts, UserLinesManagerModal.tsx) were rebuilt from
  scratch and shipped in the same v0.10.20 tag (after deleting + re-
  creating the burned tag pointing to the broken commit).

## v0.10.19 — May 29, 2026

**Theme:** EMERGENCY REVERT — v0.10.18 broke SIP registration for every user.

### Fixed
- **Reverted v0.10.18's default SIP WSS endpoint change** back to
  `wss://sip.telnyx.com:7443`. The v0.10.18 attempt to make port-443 the
  default for all users sent JsSIP to `wss://rtc.telnyx.com:443`, which
  is Telnyx's WebRTC SDK endpoint (NOT for SIP-over-WebSocket). Result:
  every user — US and India — disconnected within minutes of installing
  v0.10.18. v0.10.19 restores the working endpoint.

### Lesson learned
- Lesson noted in this changelog so future "let's make this the default"
  changes get tested with Telnyx Support BEFORE rollout to all users.

## v0.10.18 — May 29, 2026 — DO NOT INSTALL

**REVERTED. Made `wss://rtc.telnyx.com:443` the default SIP WSS endpoint
for all users without verifying it actually accepts SIP-over-WebSocket
traffic (it doesn't — it's Telnyx's WebRTC SDK endpoint). Every installed
client failed to register. v0.10.19 restored the previous default.**

## v0.10.17 — May 29, 2026

**Theme:** SIP REGISTER race condition causing the flap fix.

### Fixed
- **SIP flap (connecting → online → disconnected) for India users.**
  Root cause: the 10-second heartbeat in `services/sip.ts` was calling
  `ua.register()` unconditionally on every tick. JsSIP also runs its own
  `register_expires`-driven refresh every ~600 seconds. When both
  registers happened concurrently, Telnyx returned **491 Request Pending**
  on the heartbeat's register, JsSIP cleared the UA state, the SipContext
  saw 'unregistered', triggered reconnect, and the user briefly went
  offline. **Fix:** heartbeat now calls `register()` ONLY when
  `isRegistered() === false`. If already registered, the heartbeat just
  bumps the watchdog without sending any REGISTER frames.

## v0.10.16 — May 29, 2026

**Theme:** Attempted India-routing fix (later superseded by v0.10.17).

### Changed
- Added timezone-based detection in `SipContext.tsx` to route India users
  (`Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Kolkata'`)
  to `wss://rtc.telnyx.com:443` (port 443, HTTPS-standard, intended to
  punch through restrictive ISPs). **Discovered** during testing that
  many India users have their Windows OS clock set to a US timezone for
  work-hours alignment, so timezone detection didn't actually catch them.
  Reverted in v0.10.19 (along with the bad default change in v0.10.18).

## v0.10.15 — May 29, 2026

**Theme:** SIP status flap UI debouncing.

### Changed
- **`services/sip.ts`**: Added state-emission debounce — 2.5 seconds for
  `'connecting'` and `'disconnected'` states, immediate for `'registered'`.
  Added `consecutiveDisconnectedReadings` counter requiring 2 sustained
  readings before triggering a UA reconnect. Stops the UI status pill
  from flicker-thrashing during transient network blips.

## v0.10.14 — May 29, 2026

**Theme:** Per-DID TexML routing — fix inbound calls for non-pilot users.

### Fixed
- **CRITICAL: every non-pilot user's inbound calls were failing in 366ms.**
  The TexML inbound handler had `PILOT_SIP_CONNECTION_ID` hardcoded, so
  Telnyx tried to dial every inbound call to the pilot's SIP credentials
  regardless of which DID was called. For non-pilot users this 404'd at
  the Telnyx side after one ring attempt.
- **Fix:** added `resolveCalledConnection()` to `apps/webhooks/src/main.ts`
  that reads the called DID from the TexML body's `To` field, looks up
  the matching UserDid row, and dials THAT user's Credential Connection
  via `<Dial><Sip>`. Includes self-heal: if `UserDid.connectionId` is
  NULL (pre-v0.10.0 backfill), the handler looks it up via Telnyx and
  persists back to the row.
- `apps/api/src/lib/userDid.ts` — `ensureUserDid()` now captures
  `connection_id` from the same Telnyx lookup it does for
  `telnyxNumberId`, so new UserDids always have it.

## v0.10.13 — May 28, 2026

**Theme:** Messages + Chat merged into single tab.

### Changed
- **Bottom-bar tab change** — what was "Messages" and "Chat" as two
  separate tabs is now a single **Messages** tab with a segmented
  control inside for "SMS" vs "Internal chats". Users repeatedly
  reported confusion about which tab to look in for a thread.

## v0.10.12 — Skipped

(Reserved for per-user self-view reports, deferred to a future release.)

## v0.10.11 — May 28, 2026

**Theme:** Hide admin-only Settings sections from non-admin users.

### Fixed
- Settings sidebar was rendering admin-only sections (Live Ops, Presence,
  Usage, Quality, Cost, Recruiter, Alerts, Users, Audit log, Data) for
  regular users too. The components themselves had admin gates, but the
  nav was visible and clicking it just showed "Admin access required" —
  noisy and confusing. Fix: filter the section list by `me.isAdmin` in
  `SettingsNav` so non-admins don't see the entries at all.

## v0.10.10 — May 28, 2026

**Theme:** Multiple SIP + audio + UI improvements after a full QA pass.

### Added
- **SIP retry budget + watchdog grace** — circuit-breaker pattern that
  stops the dialer from hammering Telnyx with REGISTER attempts during
  extended outages.

### Fixed
- **Ringer line-badge contrast** bumped (further bumped in v0.10.20).
- **DidSwitcher dropdown z-index trap** — dropdown was rendering BEHIND
  the new-call avatar in some layouts. Bumped its z-index above the
  ringer overlay.
- **Stop local ringback on SIP 183 (early media).** Calls that drop the
  ringback tone as soon as the far end starts sending audio (voicemail
  greetings, IVR systems). Without this, the user heard our ringback
  layered on top of the far-end audio.
- **Card URLs point directly at `ace-dialer://`** in environments that
  support it, falling back to the web `/auto/...` page otherwise.

## v0.10.9 — May 28, 2026

**Theme:** Ringer screen line attribution.

### Added
- **Incoming call screen shows which line was called.** A new badge under
  the caller name reads "on Main · (732) 200-1305" — built via a
  backend lookup against the most recent inbound call's `userDidId` so
  the dialer knows which of the user's DIDs the caller dialed. Critical
  context for multi-DID users (e.g. recruiter with 3 numbers can answer
  appropriately based on which line rang).

## v0.10.8 — May 28, 2026

**Theme:** Multi-DID admin polish + light-mode contrast + Electron compatibility

### Added
- **Inline label editor** in Manage Lines modal. Click the pencil icon next
  to any line's label → an input field appears in place. Enter saves, Escape
  cancels, blur saves. Replaces a `window.prompt()` call that Electron
  silently disables.

### Fixed
- **Manage Lines "Add line" no longer hard-errors** with "User has no
  existing Telnyx Credential Connection." Pre-v0.10.0 users whose
  `UserDid.connection_id` was backfilled as NULL now have it resolved via
  Telnyx and persisted back to the row before any provisioning happens.
- **Light-mode text contrast** — `--text-dim` and `--text-muted` switched
  from low-alpha rgba to solid darker grays (now passes WCAG AA at
  ~10:1 and ~6.5:1 respectively).
- **`.muted.small`** was hardcoded white-at-40% — invisible on light
  background. Now uses themed `--text-muted`.
- **Chat list rows** were `<button>` elements with no browser-default reset.
  Light mode showed thick black borders around every row. Added proper
  background/border/font resets.
- **`.settings-btn` / `.settings-btn-secondary`** promoted to global styles
  so modal footers (Manage Lines, etc.) render proper button chrome
  everywhere — previously only styled when nested in specific containers.
- **DID switcher dropdown** option labels + numbers were hardcoded white —
  invisible in light mode. Added light-mode overrides.

## v0.10.7 — May 28, 2026

**Theme:** Web protocol launch + version bump for first publishable release

### Fixed
- **AutoRoute protocol launch** switched from iframe (silently blocked by
  modern Chrome / Edge) to `window.location.href`. Standard pattern — the
  browser shows a native "Open ACE Dialer?" dialog; once the user picks
  "Always allow", subsequent launches open the desktop directly.
- Fallback timer to in-browser dialer bumped from 1.2s to 3s to give the
  user time to interact with the browser dialog before redirect.

### Changed
- Version bumped 0.9.15 → 0.10.7 across all packages. This was the first
  publishable release since v0.9.15; without the bump electron-builder was
  trying to publish the same version and skipping.

## v0.10.6 — May 28, 2026

**Theme:** Vercel sub-route 404 fix

### Fixed
- **Vercel sub-routes 404'd** for any deep URL (`/auth/microsoft/callback`,
  `/auto/sms`, `/voicemail/:id/play`). Root cause: `base: './'` in
  vite.config.ts made the built HTML use relative asset paths
  (`./assets/...`), which resolved against the deep URL path
  (`/auth/microsoft/assets/...` → 404).
- Fix: toggle vite base on `process.env.VERCEL`. Vercel auto-sets `VERCEL=1`
  during builds → absolute `/`. Local builds (Electron) keep relative `./`.

## v0.10.5 — May 28, 2026

**Theme:** Teams card buttons work universally + Electron deep-link handlers

### Added
- **AutoRoute pages** (`/auto/call`, `/auto/sms`). Card buttons in Teams
  Adaptive Cards link here instead of `ace-dialer://` directly. The page
  attempts the protocol launch then falls back to the in-browser dialer.
  Works on desktop with app, desktop browser, and mobile.
- **Electron deep-link handlers** for `ace-dialer://call?to=...` and
  `ace-dialer://sms?to=...`. Main process focuses the window and forwards
  the action to the renderer via IPC; renderer navigates to `/keypad?to=...`
  or `/messages?to=...` with the recipient prefilled.
- **Dialpad `?to=` prefill** — Dialpad reads the URL search param and
  pre-fills the number (user clicks Call themselves — no auto-dial).
- **App-level deep-link IPC subscription** in App.tsx.

### Changed
- Adaptive Card builder action URLs use the web `/auto/...` routes (which
  internally try desktop then fall back) instead of bare `ace-dialer://`
  deep links.

## v0.10.4 — May 27, 2026

**Theme:** Dedup duplicate Teams notifications

### Fixed
- **SMS Teams cards no longer duplicate** on Telnyx webhook retries.
  Replaced `prisma.message.upsert` with explicit `findUnique → create-or-update`
  pattern; notification only fires on first-time create.
- **Missed-call Teams cards no longer duplicate** when Telnyx fires
  `call.hangup` multiple times for the same call (multi-leg, retries).
  Added in-memory dedup `Set<callDbId>` keyed by call DB id.

## v0.10.3 — May 27, 2026

**Theme:** Render hibernation killed setTimeout — missed-call broken

### Fixed
- **Missed-call card now fires immediately** on `call.hangup` instead of
  via a 30-second setTimeout. The 30s grace was meant to suppress the
  missed-call card when a voicemail came in for the same call, but
  Render's hibernating service tier killed the in-process timer between
  events. Symptom: caller cancels → user got no notification ever.
- New behavior: if a voicemail arrives after the missed-call card, the
  voicemail card also fires — user gets two cards but neither is missed.
  Strict cross-restart dedup would need a persistent job queue (out of
  scope for v0.10.x).

## v0.10.2 — May 28, 2026

**Theme:** Missed-call fix for caller-cancelled + voicemail playback page

### Added
- **Voicemail playback page** (`/voicemail/:id/play`) — full-page view
  with caller info, audio player, transcript, and call back / send text
  buttons. Linked from the Listen button on voicemail Teams cards.
- **API audio proxy** (`GET /voicemails/:id/audio`) — JWT-authenticated;
  fetches Telnyx recording with Bearer auth and streams MP3 to browser.
  Browser receives the bytes as a Blob and plays via HTML5 `<audio>`.
- **API single voicemail metadata** (`GET /voicemails/:id`) — for the
  playback page to show caller info + transcript.
- **MS SSO returnTo flow** — when a user clicks a Teams card link in a
  fresh browser tab (no session), the requested URL is stashed and they
  bounce back to it after MS SSO instead of dumping on /keypad.

### Fixed
- **Missed-call detection now uses `answeredAt is null`** instead of the
  status-string classifier. Previously, when a caller cancelled before
  pickup, Telnyx reported `hangup_cause=originator_cancel` which the
  classifier collapsed to `'completed'` — and the missed-call notifier
  skipped because status wasn't `no_answer`/`rejected`. New semantics:
  any inbound call where `answeredAt` is null is a missed call.

## v0.10.1 — May 28, 2026

**Theme:** Tenant-wide Teams notifications

### Added
- **Tenant-wide Power Automate flow** for Teams notifications. One flow
  (URL stored in `TEAMS_TENANT_WEBHOOK_URL` env var) delivers Adaptive
  Cards to each user's Teams chat with Flow bot. Zero per-user setup;
  every existing + new user is auto-opted-in to all three event types.
- **Migration** that sets `teams_notify_on` DB default to
  `'missed_call,sms,voicemail'` and backfills NULL rows.
- **Settings → Personal → Teams notifications** redesign — three opt-in
  toggles only, no URL field. New empty state if `TEAMS_TENANT_WEBHOOK_URL`
  isn't set on the API service ("ask your admin").

### Changed
- **Notifier** drops per-user webhook URL lookup. POST body shape is
  now `{ recipientEmail, eventType, card }`. Backend extracts the
  AdaptiveCard from the Teams envelope before POSTing so Power Automate's
  "Post adaptive card" action gets the bare card body.
- **Test card endpoint** routes through the tenant flow with the calling
  user's email as recipient.

## v0.10.0 — May 27, 2026 (sprint baseline)

**Theme:** Multi-DID + UserDid schema + admin Manage Lines UI

### Added
- **UserDid schema** — one or many DIDs per User, with isDefault flag,
  label, color, connectionId, and reverse relations to Call / Message /
  Voicemail rows.
- **Database migration** + backfill from legacy `User.didNumber` column.
- **DidSwitcher dropdown** in the dialer header — picks active outbound DID.
- **Line badges** on Recents / Messages / Voicemail rows showing which line
  was touched.
- **Admin Manage Lines modal** — add / remove / re-label / re-color / set
  default. "Add line" sub-modal asks "Use existing" vs "Buy new" picker.
- **Per-DID inbound routing** — webhook handlers stamp `userDidId` on
  Call / Message / Voicemail rows so the UI can render the right badge.
- **/me/dids + /me/active-did endpoints** for the DidSwitcher to read/write.
- **/admin/users/:id/dids endpoints** for the Manage Lines admin UI.

### Fixed
- **Akshay-class invite bug** — all 4 user-creation paths in admin.routes.ts
  (regular invite, auto-provision, bulk-import, pending-user invite) now
  call a shared `ensureUserDid()` helper. Previously they only wrote to the
  legacy User.didNumber, leaving the new UserDid table empty → broken SMS,
  no line badges, status flicker.
- **Voicemail double-create dedup** — Telnyx firing both `voicemail.completed`
  AND `recording.saved` for the same call no longer creates two rows.
- **Voicemail transcription stuck** — Telnyx recording URLs require Bearer
  auth; previously we used Deepgram URL mode which silently 401'd. Now we
  download bytes ourselves with our Telnyx key and POST to Deepgram.
- **Deepgram model** upgraded to `nova-3` with `language: multi` for
  accented English (Indian-English voicemails now transcribe accurately).
- **Mid-call status flap** — JsSIP "connecting" / "disconnected" events
  during active calls no longer flip the UI status pill.
- **India call quality thresholds** recalibrated from 200/400ms to 300/500ms
  for RTT — meter now reads "Good" on normal India-US calls.
- **Cloudflare TURN for India users** — runtime injection via
  `/turn-credentials` endpoint; Mumbai + Bangalore PoPs prioritized.
- **MS SSO blank page on Vercel** — SPA rewrite regex no longer eats JS chunks.
- **Translucent dropdown / modal backgrounds** — proper opaque colors.
- **1366×768 header fit** — adapts to small screens.

## Older releases

See git log for v0.9.x and earlier. v0.9.15 was the last release published to
GitHub before v0.10.0 — see commit history between `v0.9.15` and `v0.10.0` for
the long tail of pre-sprint fixes (chat status sorting, voicemail polish,
Telnyx connection cloning, etc.).
