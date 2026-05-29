# ACE Dialer Changelog

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
