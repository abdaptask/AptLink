# AptLink Dialer — Living System Blueprint

> **Source of truth for every module in this monorepo.** Read the single section that maps to the area you're touching; the 4-tier structure is designed so one block alone is enough context to write production code without re-reading the rest.
>
> **Update rule:** When a feature ships, lands, or moves status, edit its block here *before* you merge. The block is the contract; the code is its implementation.

## How to read a module block

Every numbered section below follows the same 4-tier shape:

1. **Capabilities & Scope** — what this module is engineered to do *right now*.
2. **Current State & Truth** — `Shipped` / `In-Progress` / `Planned`, file paths, active hooks/state.
3. **Execution Context** — concrete SDK methods, schemas, network endpoints, the seam where client → server hands off.
4. **Architectural Guardrails** — the rules and invariants. Violating these is how zombie media tracks, dual-Contact INVITE forks, and gaudy UI happen.

A `[[link]]` points to another module in this document.

---

## Cross-cutting invariants (apply everywhere)

These are non-negotiable across modules. Repeat them in module-specific guardrails only when emphasis is warranted.

- **No zombie media tracks.** Every `getUserMedia` stream and every `MediaStreamTrack` MUST be terminated when its owning call/conference ends. Track leaks degrade subsequent calls (echo, "tunnel voice", mic acquire timeouts). Always pair `track.stop()` with cleanup, and pair `replaceTrack(X)` with a future `replaceTrack(mic)` on tear-down.
- **State separation between active and held calls.** The active call drives `callState`; events from held calls MUST NOT clobber active-call display. Filter incoming events by `e.callId === sipService.getActiveCallId()` before applying them to the active-call surface.
- **Server is the source of truth for cross-device state.** Favorites, blocked numbers, call history, voicemails, internal chat, call forwarding — all persist server-side. `localStorage` may *cache* them for sync UI reads, but mutations write through the API. Browser and Electron each have their own `localStorage`; only the database is shared.
- **Telnyx + Call Control IDs.** Server-side orchestration (transfer, add-leg, conference, recording) requires a leg's `call_control_id`, which is populated by Telnyx webhooks — *not* immediately by the WebRTC SDK. Anything that depends on it must wait/poll for it and fail gracefully when it never arrives (e.g., webhook misconfiguration).
- **Aesthetic ceiling.** Clean, minimalist, high-end. iOS-inspired. **No stock-photo callbacks, no gradient blasts, no emoji confetti, no "casual" UI elements.** Visual reference: Apple's Phone app + Tot/Things-tier polish. See [[27-visual-system]].
- **Fail open on inbound classification, fail closed on outbound action.** Webhook-side blocklist lookups fail open (allow the call) — better to ring a legit caller than silently drop them. Outbound actions (transfer, dial) fail closed with a clear UI message — better to refuse than to do the wrong thing.
- **Comments explain WHY, never WHAT.** Especially around SIP/SDP/RTC quirks: the next reader needs the failure mode, not a paraphrase of the line below.

---

## Module index

| # | Module | Status |
|---|--------|--------|
| 1 | Repository Topology | Shipped |
| 2 | Identity & Session | In-Progress (SSO) |
| 3 | Data Layer (Prisma + Supabase Postgres) | Shipped |
| 4 | Desktop Shell (Electron + Tray + Floating Ringer) | Shipped |
| 5 | App Shell (Routing, Layout, Tab Badges, Theme) | Shipped |
| 6 | SIP Engine (JsSIP UA, Registration, Resilience) | Shipped |
| 7 | Audio Devices & Media Constraints | Shipped |
| 8 | Call Lifecycle (Outbound, Inbound, Decline, DTMF) | Shipped |
| 9 | Mute, Hold & Hold Music | Shipped |
| 10 | Add Call (Multi-Session) | Shipped |
| 11 | Swap Calls | Shipped |
| 12 | Hold & Accept | Shipped |
| 13 | 3-Way Conference (Client-Side Web Audio Mix) | Shipped |
| 14 | Transfer (Blind via Telnyx Call Control) | Shipped |
| 15 | Telnyx Call Control Wrapper | Shipped |
| 16 | Telnyx Webhooks (Multi-User Routing, Voicemail, Bridging) | Shipped |
| 17 | Call History & Recents Dedupe | Shipped |
| 18 | Messaging (SMS / MMS) | Shipped |
| 19 | Voicemail (Inbox + Greeting + Retention) | Shipped |
| 20 | Internal Chat (User-to-User) | Shipped |
| 21 | Favorites (Server-Synced) | Shipped |
| 22 | Number Blocking | Shipped |
| 23 | Call Forwarding | Shipped |
| 24 | JobDiva Contact Lookup | Shipped |
| 25 | Notifications, Ringtones & Floating Ringer | Shipped |
| 26 | Auto-Update (Electron) | Shipped |
| 27 | Visual System & Aesthetic | Shipped |
| 28 | Audit Log | Planned |
| 29 | Realtime Socket Service | Planned (Stub) |

---

# Section A — Foundation

## 1. Repository Topology

### 1.1 Capabilities & Scope
- Monorepo orchestrated by npm workspaces. Four runtime apps + three shared packages.
- Each app deploys independently on Fly.io (with multi-region Anycast routing for `api`, `webhooks`, and `socket`; Electron installer for `desktop`; static host for `web`).

### 1.2 Current State & Truth
**Status:** In-Progress (Re-architecting to AptLink).

```
apps/
  api/        Fastify HTTP API     — auth, calls, messages, voicemail, favorites, blocking, forwarding, internal chat, JobDiva
  webhooks/   Fastify webhook sink — Telnyx event ingest (routes directly to BullMQ queue)
  socket/     Fastify + Socket.IO  — stateful Socket.IO connections
  web/        Vite + React + TS    — client softphone UI (refactored with XState)
  desktop/    Electron 31 shell    — tray, ringer popup, deep-link SSO, auto-update
  workers/    BullMQ Worker Pool   — [NEW] asynchronous processing of webhooks, emails, and notifications
packages/
  db/         Prisma client + schema, shared across api + webhooks + workers
  types/      [NEW] Shared domain types & payload interfaces
  telephony/  [NEW] Shared SIP & Web Audio mix graph service
scripts/      One-off ops helpers (dedupe call legs, fix favorite names, etc.)
```

### 1.3 Execution Context
- **Workspaces:** `npm run <script> -w <workspace>`. Root scripts (`build:api`, `build:web`, `dist:desktop:win`) chain the right order.
- **Deployment surface:**
  - `api` → Render (single web service, port 3000)
  - `webhooks` → Render (separate service so a webhook storm can't starve the user-facing API)
  - `socket` → Render (separate, port 3001)
  - `web` → static host with `VITE_API_URL` baked at build time
  - `desktop` → `electron-builder` produces NSIS (Win) + DMG (Mac), auto-updated from GitHub Releases
- **Database:** single Supabase Postgres pooled via Supavisor (`aws-1-us-east-1.pooler.supabase.com`). Both `api` and `webhooks` share the same `@ace/db` client.

### 1.4 Architectural Guardrails
- **Webhooks service is isolated from `api` on purpose.** Don't merge them — a webhook 500 storm must not 401 the active user's call.
- **No code in `packages/`** other than `db`. If something is shared, it goes through the API contract, not a shared TS module — otherwise we end up coupling deploys.
- **Scripts under `scripts/` are operator tools, not runtime code.** Never `import` from `scripts/` in any `apps/` package.

---

## 2. Identity & Session

### 2.1 Capabilities & Scope
- Authenticates a user, mints our own JWT, and hands their per-account SIP credentials to the SIP Engine so they register against Telnyx as themselves (not via shared build-time env vars).
- Two paths: **local password** (break-glass admin accounts) and **Microsoft Entra ID SSO** (the canonical ApTask employee path).
- Survives token expiry by routing every 401 through a session guard that bounces to `/login` with a reason hint.

### 2.2 Current State & Truth
**Status:** Local password = Shipped. Microsoft SSO = In-Progress (frontend callback and Electron deep-link wiring complete, backend `/auth/microsoft/exchange` not yet on `main`).

| Concern | Implementation |
|---|---|
| Login form | `apps/web/src/pages/Login.tsx` |
| Local-password endpoint | `apps/api/src/auth/auth.routes.ts` → `POST /auth/login` |
| `passwordHash` | `String?` in Prisma schema — SSO-only users have NULL; login refuses on null without throwing |
| SSO callback page | `apps/web/src/pages/MicrosoftCallback.tsx` |
| Electron deep-link receiver | `apps/desktop/src/main.ts` → `ace-dialer://` protocol handler, single-instance lock, `ace:sso-callback` IPC |
| JWT token storage | `sessionStorage['ace_token']` (cleared on logout / 401) |
| Per-user SIP creds | `sessionStorage['ace_sip_username' \| 'ace_sip_password' \| 'ace_did']`, written by `persistSipCreds()` in `App.tsx` after `getMe()` |
| Session expiry watchdog | `apps/web/src/lib/sessionGuard.ts` — fetch interceptor + SIP "stayed failed for 30s" detector |

### 2.3 Execution Context
- **JWT payload:** `{ sub: userId, email, isAdmin }`. Verified server-side by Fastify's `app.authenticate` decorator on every protected route.
- **Login response shape:** `{ token, user: { id, email, firstName, lastName, isAdmin, sipUsername, sipPassword, didNumber } }`. The `sipPassword` is sensitive; only travels over HTTPS and is never logged.
- **SSO flow:** Web sends user to Microsoft `/authorize` (PKCE), Microsoft redirects to `/auth/microsoft/callback?code=...&state=...`, the page validates state + PKCE verifier from `sessionStorage`, POSTs `{ code, redirectUri, codeVerifier }` to `/auth/microsoft/exchange`, backend exchanges with Microsoft, mints our JWT, returns it.
- **Electron SSO flow:** OS browser handles MS sign-in (never an embedded webview — MS blocks them + breaks Conditional Access), redirects to `ace-dialer://auth/callback?code=...`, OS invokes the registered protocol handler, Electron main process forwards via IPC `ace:sso-callback`, renderer routes to `/auth/microsoft/callback` with the same hash.
- **SipContext handshake:** App.tsx writes per-user creds to `sessionStorage` then dispatches `ace:sip-creds-updated`. `SipContext` listens for it on mount; if creds arrive late (race), it polls `sessionStorage` for up to 20s before flipping to `'failed'`.

### 2.4 Architectural Guardrails
- **Identical 401 message for missing/disabled/wrong-password/SSO-only users.** Never leak account state.
- **CSRF protection on SSO is non-optional.** Always verify the `state` parameter the OAuth callback returns matches the value stashed at `/authorize` time. PKCE verifier is paired with state.
- **`sessionStorage`, not `localStorage`, for the JWT.** Tab/window scope is intentional — auto-expires on browser/Electron quit.
- **Never embed the Microsoft sign-in page inside the Electron window.** Always open in the system browser via `shell.openExternal`.
- **Break-glass local accounts are admins only.** Regular users must come through SSO so we get the Entra audit trail.

---

## 3. Data Layer (Prisma + Supabase Postgres)

### 3.1 Capabilities & Scope
- Single source of truth for all persistent state: users, calls, SMS, voicemails, blocked numbers, favorites, internal chat, audit logs.
- Shared Prisma client (`@ace/db`) consumed by `api` and `webhooks`. The web client never touches Prisma directly — it goes through the API.

### 3.2 Current State & Truth
**Status:** Shipped. Schema migrations applied via `prisma db push` against the Supabase Postgres. Models:

| Model | Owner | Notes |
|---|---|---|
| `User` | id, email, passwordHash?, firstName, lastName, sipUsername?, sipPassword?, didNumber?, telnyxNumberId?, forwardingEnabled, forwardingNumber?, forwardingMode?, voicemailGreetingUrl?, voicemailGreetingFilename?, isAdmin, isActive, azureOid?, provider, lastLoginAt, createdAt, updatedAt | `passwordHash` nullable for SSO-only; `provider` defaults `"microsoft"` |
| `Favorite` | id, userId→User, phone (E.164), firstName?, lastName?, label?, addedAt | Unique on `(userId, phone)`. See [[21-favorites]]. |
| `BlockedNumber` | id, userId→User, number (E.164), reason?, createdAt | Unique on `(userId, number)`. See [[22-blocking]]. |
| `Call` | id, userId→User, telnyxCallId (unique), sessionId?, callControlId?, direction, fromNumber, toNumber, status, startedAt, answeredAt?, endedAt?, durationSeconds, hangupCause?, hangupSource?, recordingUrl? | `sessionId` (Telnyx `call_session_id`) is the dedupe key. See [[17-call-history]]. |
| `Message` | id, userId→User, telnyxMessageId (unique), threadKey, direction, fromNumber, toNumber, body, mediaUrls[], status, errors?, sentAt?, deliveredAt? | `threadKey` = other party's E.164. See [[18-messaging]]. |
| `Voicemail` | id, userId→User, telnyxCallId?, fromNumber, toNumber, recordingUrl, durationSeconds, transcription?, receivedAt, listenedAt? | Telnyx Hosted Voicemail. See [[19-voicemail]]. |
| `InternalMessage` | id, senderId→User, recipientId→User, threadKey ("min_max" ids), body, mediaUrl?, readAt?, createdAt | See [[20-internal-chat]]. |
| `AuditLog` | id, actorUserId?→User, action (dot-namespaced), targetUserId?→User, metadata Json?, createdAt | Schema is in. See [[28-audit-log]]. |

### 3.3 Execution Context
- **Schema:** `packages/db/prisma/schema.prisma`. Generate client with `npm run db:generate`, push schema with `npm run db:push` (calls `prisma db push --accept-data-loss`).
- **Connection:** `DATABASE_URL` is the pooled connection (Supavisor, port 6543 with `pgbouncer=true`); `DIRECT_DATABASE_URL` is the direct connection (port 5432) Prisma uses for migrations.
- **Indexes that matter for hot paths:**
  - `Call (userId, startedAt)` — Recents query
  - `Message (userId, threadKey, createdAt)` — Thread view
  - `Voicemail (userId, receivedAt)` — Voicemail inbox
  - `InternalMessage (threadKey, createdAt)` — Chat conversation
  - `AuditLog (createdAt)` + per-actor/target indexes — admin feed

### 3.4 Architectural Guardrails
- **Never use `prisma.X.findUnique` with just a guessable id where multi-tenancy matters.** Always scope by `userId` (e.g., `deleteMany({ where: { id, userId } })`) so a user can't act on another user's row by guessing.
- **Phone numbers stored E.164.** Matching tolerates carrier formatting by comparing the last 10 digits — but storage is always normalized.
- **Migrations are reviewed before push.** `prisma db push` against the shared Supabase is destructive when you remove columns; additive changes only, or coordinate downtime.
- **No raw SQL** without an explicit comment about why Prisma can't express it.

---

# Section B — Client Shell

## 4. Desktop Shell (Electron + Tray + Floating Ringer)

### 4.1 Capabilities & Scope
- Wraps the web app in a native window with first-class softphone behaviors: hide-to-tray on close (active call survives), floating call-banner popup separate from the main window, OS-protocol deep-link for SSO, and silent auto-update from GitHub Releases.
- Renders the same Vite-built web bundle (`apps/web/dist`) in production; loads `VITE_DEV_SERVER_URL` in dev.

### 4.2 Current State & Truth
**Status:** Shipped. Tray icon (Win + Mac), close-to-tray with first-time balloon, single-instance lock, `ace-dialer://` protocol registration, `electron-updater` polling GitHub Releases hourly.

| Concern | Implementation |
|---|---|
| Main process | `apps/desktop/src/main.ts` |
| Preload bridge | `apps/desktop/src/preload.ts` |
| Window config | `width: 1200, height: 800, minWidth: 900, minHeight: 600, backgroundColor: '#000', backgroundThrottling: false` |
| Tray | `Tray` + `tray-icon-16.png` from `assets/`, `setTemplateImage(true)` on macOS |
| Floating ringer | Frameless `BrowserWindow` (440×240) anchored bottom-right of work area, `alwaysOnTop('screen-saver')`, inline data-URL HTML — see [[25-notifications]] |
| Deep link | `app.setAsDefaultProtocolClient('ace-dialer')` + `open-url` (mac) + `second-instance` argv (win) → `handleSsoCallback` → IPC `ace:sso-callback` |
| Auto-update | `electron-updater` → `autoUpdater.checkForUpdates()` after 15s, then hourly; events mirror through `lastUpdateState` so a remounted banner can rehydrate via `ace:get-update-state` |

### 4.3 Execution Context
- **IPC events the renderer can rely on:**
  - `ace:incoming-call` → main surfaces the window + opens floating ringer
  - `ace:accept` / `ace:decline` (from ringer) → forwarded to renderer as `ace:accept-request` / `ace:decline-request`
  - `ace:call-ended` → closes ringer, stops Win flashFrame
  - `ace:sso-callback` → delivers MS auth URL
  - `ace:update-available` / `ace:update-progress` / `ace:update-downloaded`
- **`backgroundThrottling: false` is non-negotiable.** When the window is hidden, Chromium otherwise clamps timers to 1Hz; JsSIP's 20s registration heartbeat would miss its window, Telnyx would drop the registration, and inbound calls would silently fall to voicemail. See [[6-sip-engine]].
- **Single-instance lock + `second-instance` event** routes a re-launched protocol click to the running instance rather than opening a duplicate.

### 4.4 Architectural Guardrails
- **Never quit when the main window closes.** Closing the window MUST hide-to-tray so an active call's audio keeps flowing. The `isQuittingForReal` flag is the only escape hatch (Tray Quit, app menu Quit, OS shutdown via `before-quit`).
- **Never load Microsoft sign-in inside the main window.** Always `shell.openExternal` — embedded webviews are blocked by MS and break Conditional Access MFA.
- **Floating ringer is a separate window, not a modal.** A modal blocks the main UI's call-control buttons; a separate `BrowserWindow` lets the user keep operating the main window while the call rings.
- **Preload must remain context-isolated with `nodeIntegration: false`.** Expose only the typed `window.ace` surface defined in `preload.ts`.

---

## 5. App Shell (Routing, Layout, Tab Badges, Theme)

### 5.1 Capabilities & Scope
- React Router app skeleton inside the Electron/web window: nav rail, bottom tab badges (Messages, Recents, Voicemail, Chat unread counts), the persistent SIP status indicator, a user dropdown menu with logout / settings / manual update check.
- Owns the boot dance: `getMe()` after token rehydrate, `persistSipCreds`, session-expired watchdog, ring-permission prompt, favorites refresh on focus.

### 5.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Root `<App>` | `apps/web/src/App.tsx` |
| Authenticated shell | `apps/web/src/pages/Layout.tsx` |
| Routes (authenticated) | `/keypad`, `/in-call`, `/favorites`, `/messages`, `/chat`, `/recents`, `/contacts`, `/voicemail`, `/settings`, `/settings/:section` |
| Routes (unauthenticated) | `/login`, `/auth/microsoft/callback` |
| Badge polling | `Layout.tsx` 15s timer + `ace:tabVisited` event hook |
| Theme | `<html data-theme="dark"|"light">` driven by `userPrefs.applyTheme()` + system preference |

### 5.3 Execution Context
- **Per-tab unread counts** come from API endpoints that compare `since=<lastVisit ISO>` to row timestamps. The web client stamps `localStorage['ace_last_visit_<tab>']` on tab visit (`markTabVisited(...)`) so the server-side count drops to zero without per-row read flags.
- **Session guard** is `installSessionGuard()` at module top of `App.tsx` — patches `fetch` so any 401 fires `ace:session-expired` and routes back to `/login` with a reason hint stashed in `sessionStorage`.
- **Theme system:** `--bg`, `--bg-elevated`, `--text`, `--text-dim`, `--text-muted` CSS variables. Dark is canonical; light is opt-in. See [[27-visual-system]].

### 5.4 Architectural Guardrails
- **Always go through `SipContext`, never `sipService` directly, from a React component.** Direct access skips event subscriptions and you'll miss state.
- **Tab-badge polls MUST be cheap counters, not data fetches.** The endpoint returns `{ count }`, not the unread rows.
- **All navigation uses `useNavigate`, never `window.location`.** A full reload nukes `sessionStorage` (JWT) and forces a full SIP re-register.

---

# Section C — SIP Engine

## 6. SIP Engine (JsSIP UA, Registration, Resilience)

### 6.1 Capabilities & Scope
- Owns the SIP-over-WebSocket connection to Telnyx, the REGISTER lifecycle, and one `RTCSession` per concurrent call. Emits a strongly-typed event bus that `SipContext` subscribes to.
- Resilience built in: registration heartbeat, wildcard-unregister on window close, visibility-change recovery, manual reconnect, automatic reconnect-with-evict on credential change.

### 6.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Service singleton | `apps/web/src/services/sip.ts` — `class SipService`, exported as `sipService` |
| React bridge | `apps/web/src/contexts/SipContext.tsx` |
| Library | **JsSIP** (npm `jssip`) — full SIP UA in the browser |
| Endpoint | `wss://sip.telnyx.com:7443` (override via `VITE_SIP_WSS_URI`) |
| Realm | `sip.telnyx.com` |
| REGISTER expiry | `register_expires: 600` (10 min) |
| Heartbeat | `ua.register()` every 20s (resilient to background-tab timer throttling) |
| Visibility recovery | `visibilitychange` + `focus` → reconnect/re-register depending on socket state |

### 6.3 Execution Context
- **Why JsSIP and not `@telnyx/webrtc`:** the Telnyx WebRTC SDK exposes a single `call` object and hides each leg's `call_control_id` from the client, which blocks per-leg server-side orchestration (3-way conference, independent hangup per leg). JsSIP gives us a real `RTCSession` + `RTCPeerConnection` per call, mirroring a native softphone (PJSIP). Telnyx remains the carrier: SIP-WSS gateway + Call Control API + webhooks. **Do not migrate back without re-validating multi-call.**
- **JsSIP UA config that MUST stay:**
  - `session_timers: false` — Telnyx 481s re-INVITE/UPDATE keepalives mid-call and teardowns happen if this is on.
  - `register_expires: 600` paired with the 20s heartbeat — bigger expiry than the worst-case throttle interval, frequent enough refresh that we never approach it.
  - `pcConfig`: STUN at `stun:stun.telnyx.com:3478` + Google fallbacks, `iceTransportPolicy: 'all'`, `bundlePolicy: 'max-bundle'`, `rtcpMuxPolicy: 'require'`.
  - User-Agent header: `ACE-Dialer/1.0`.
- **REGISTER hygiene:**
  - On `connect()` over a pre-existing UA, send specific-Contact unregister first, wait ~350ms for it to flush, then start the new UA. Otherwise a dual-Contact INVITE fork is possible (Telnyx sends one INVITE to each Contact; the inbound Accept then races and fails with `INVALID_STATE_ERROR`).
  - On `beforeunload` and `pagehide`, call `sipService.disconnect()` which sends specific-Contact unregister before closing the WebSocket. Without this an orphan Contact lingers in the registrar for up to 600s.
- **ICE trickle escape hatch:** Chrome-Electron-Windows doesn't reliably fire `iceGatheringState='complete'` within Telnyx's 5s progress timeout. We listen for the first `srflx` candidate and call JsSIP's `ready()` callback immediately to ship the SIP message; a 1500ms hard backstop fires `ready()` if `srflx` never arrives.
- **SDP munging:**
  - Remote SDP gets `a=rtcp-mux`, `a=group:BUNDLE 0`, `a=rtcp-rsize` injected if missing (Telnyx FreeSWITCH backend doesn't emit them; Chrome's `setRemoteDescription` throws without them).
  - Both local and remote SDP get an Opus `fmtp` line set to `useinbandfec=1; usedtx=0; stereo=0; maxaveragebitrate=32000; maxplaybackrate=48000; minptime=10; ptime=20`. This is the voice-quality target.

### 6.4 Architectural Guardrails
- **The UA is a process-wide singleton.** Multiple `connect()` calls (e.g., logout/login) MUST evict the prior Contact before bringing up the new UA, with the 350ms wait.
- **Wildcard unregister (`Contact:*`) is forbidden.** It evicts every device for the user — kicking out other concurrent sessions. Use specific-Contact unregister only.
- **`session_timers: false` is non-negotiable.** If you turn it on to "be safe," Telnyx will teardown long calls.
- **Don't gate registration on `isRegistered()` alone.** The heartbeat re-registers unconditionally because we've observed JsSIP getting stuck in a `registered === false` state with a live socket.
- **Never call `sipService.X` from a render path** that hasn't already mounted `SipProvider`. Use the `useSip()` hook.

---

## 7. Audio Devices & Media Constraints

### 7.1 Capabilities & Scope
- Selects mic + speaker explicitly (Settings → Audio surfaces the picker). Persisted in `localStorage` and applied to every `getUserMedia` + `<audio>.setSinkId` we issue.
- Tunes `MediaTrackConstraints` for VoIP: echo cancellation on, AGC on, noise suppression OFF (intentional — see below), 48 kHz mono, ~20 ms latency target.

### 7.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Constraints helper | `buildAudioConstraints()` in `sip.ts` |
| Speaker apply helper | `applySpeakerSelection(audioEl)` in `sip.ts` |
| Storage keys | `localStorage['ace_mic']`, `localStorage['ace_speaker']` |
| Per-call `<audio>` elements | Created on each new session, removed in `cleanupCall` |

### 7.3 Execution Context
- **Constraints we ship to `getUserMedia`:**
  ```js
  {
    echoCancellation: true,
    noiseSuppression: false,   // see guardrails
    autoGainControl: true,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    deviceId: { ideal: ace_mic },
    latency: { ideal: 0.02 },
  }
  ```
- **Speaker routing:** `el.setSinkId(localStorage['ace_speaker'])` on every audio element we create (per-call + the primary). `default` means OS default.
- **Stale-device recovery:** If inbound `getUserMedia` times out (3s ceiling) with a stored `ace_mic`, that key is cleared so the next call falls back to default and the inbound call gets a `SIP 480 Mic Unavailable` instead of ringing into nothing.

### 7.4 Architectural Guardrails
- **`noiseSuppression: false` is intentional.** Chrome's RNNoise filter produces the "tunnel/pipe" sound recipients complain about, especially on wired headsets near the user's mouth. One suppression pass at most. If you flip this, A/B with real users on real hardware first.
- **All constraint values use `ideal`, never `exact`.** Hard constraints fail silently on Bluetooth headsets, USB phones, and older mics — `ideal` lets the browser fall back rather than refusing audio entirely.
- **Every `getUserMedia` MUST be matched with `getTracks().forEach(t => t.stop())` on its tear-down path.** Conference start/stop, hold music start/stop, and call cleanup are the three places this lives.

---

# Section D — Call Control Surface

## 8. Call Lifecycle (Outbound, Inbound, Decline, DTMF)

### 8.1 Capabilities & Scope
- Single-call happy path: dial → ringing → connected → ended; inbound accept/decline with proper Telnyx semantics (REJECT with `USER_BUSY` skips Hosted Voicemail; TERMINATE with `486 Busy Here` declines politely).
- DTMF: in-call digit send via SIP INFO; post-dial IVR via comma/semicolon syntax in the dial string (e.g., `5551234567,,802` → wait 2s, send "802").
- Local ringback while we wait for the remote to pick up (handles destinations that don't emit early media).

### 8.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Outbound dial | `sipService.call(rawNumber)` — `ua.call(target, { mediaConstraints, pcConfig, rtcOfferConstraints })` |
| Inbound answer | `sipService.acceptCall()` → `_answerIncoming(entry)` with preflighted gUM stream |
| Decline | `session.terminate({ status_code: 486, reason_phrase: 'Busy Here' })` |
| Server-side reject (blocked caller) | Webhook calls Telnyx `POST /v2/calls/:cc/actions/reject` with `cause: 'USER_BUSY'` |
| DTMF send | `session.sendDTMF(digit)` |
| Post-dial IVR | Split on `,` / `;` in `sipService.call`, schedule on `session.on('confirmed')` |
| Ringback | `services/ringtone.ts` — synth tones, started/stopped from `InCall.tsx` |
| Call persistence | `createCall` + `updateCall` from `SipContext.logCallEvent` |

### 8.3 Execution Context
- **State machine emitted via `CallEvent`:**
  - `idle` → `calling` → `ringing` → `connected` → `ended` (outbound)
  - `incoming` → `connected` → `ended` (inbound, accept path)
  - `incoming` → `ended` (decline path)
- **Each event carries `{ callId, fromNumber, toNumber, direction, hangupCause? }`.** Consumers filter on `callId === activeCallId` to ignore held-call noise.
- **Inbound answer specifically pre-acquires the mic with a 3-second timeout** before calling `session.answer({ mediaStream, pcConfig, rtcAnswerConstraints })`. JsSIP's internal `getUserMedia` can hang the answer pipeline indefinitely on Chromium-Electron-Windows — preflight avoids that and gives us a clean failure path (480 + clear `ace_mic`).
- **Telnyx-side rejection for blocked callers** uses `/actions/reject` (Q.850 21 / SIP 486) rather than `/actions/hangup`. Hangup gets treated as "no answer" and routes to Hosted Voicemail; reject returns a busy signal and skips voicemail entirely.

### 8.4 Architectural Guardrails
- **Always normalize the dial input through `toE164()`** before constructing the SIP URI. Telnyx Voice API returns error 10016 on non-E.164 destinations.
- **Local ringback runs only between `calling`/`ringing` and `connected`.** Don't let it leak into a connected state — it'll be heard over the real audio.
- **Decline must use `486 Busy Here`, not `486 Busy Everywhere`.** The latter triggers carrier-side forking and unwanted retry behavior.
- **Persisting call rows is fire-and-forget from `SipContext`.** A DB error must not block the in-progress call UI.

---

## 9. Mute, Hold & Hold Music

### 9.1 Capabilities & Scope
- Mute the active call (one-tap toggle); hold/unhold with two implementation paths depending on whether the user has configured hold music.
- Hold music: a user-uploaded MP3 (≤2 MB) stored as a data URL in `localStorage`, swapped onto the outgoing track via `replaceTrack` during hold.

### 9.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Mute | `SipService.toggleMute()` — `session.mute({audio:true})` / `unmute({audio:true})` |
| Hold (silent) | `session.hold()` — SIP RE-INVITE with `a=inactive`; remote hears nothing |
| Hold (music) | `startHoldMusic(entry)` — `Audio(dataUrl)` → `MediaElementSource` → `MediaStreamDestination`, `sender.replaceTrack(musicTrack)` |
| Unhold | `unholdCallWithMusicIfConfigured(entry)` — restores fresh mic via `replaceTrack` |
| Music store | `localStorage['ace_hold_music_data_url' \| 'ace_hold_music_filename' \| 'ace_hold_music_enabled']`. Cap: 2 MB. |

### 9.3 Execution Context
- **Why music-hold doesn't use `session.hold()`:** `session.hold()` sets `a=inactive` so RTP pauses both directions; a follow-up `replaceTrack(music)` then never reaches the remote. So when music is enabled we SKIP SIP hold entirely and just swap the outgoing track. We also mute the local `<audio>` element so the held caller's voice doesn't bleed into the user's headset.
- **Unhold reverses the chosen path:**
  - If we music-held, stop the music's `AudioContext`, fresh `getUserMedia`, `replaceTrack(mic)`.
  - If we SIP-held, call `session.unhold()`.
  - Either way, unmute the local audio element.
- **State surface:** `entry.heldLocal: boolean` is the single source of truth for hold state. `entry.__holdMusic = { audioEl, ctx }` is the music-path stash for cleanup.

### 9.4 Architectural Guardrails
- **Never `replaceTrack` without a matching reverse path.** Forgetting the unhold-side restore leaves the user's mic disconnected after they think they're off hold.
- **Always close the music-hold `AudioContext` on unhold.** Leaking AudioContexts is what causes Chrome's "max contexts reached" failure.
- **2 MB hold-music cap is real.** Above that we'd blow past the `localStorage` quota; IndexedDB is the future migration target but not today.
- **`session.hold()` is the wrong path the moment hold music is enabled.** Check `getHoldMusicEnabled() && getHoldMusicDataUrl()` first.

---

# Section E — Multi-Call Orchestration

## 10. Add Call (Multi-Session)

### 10.1 Capabilities & Scope
- Start a second concurrent SIP session while the first is held with music (or silent). Two independent `RTCSession`s alive simultaneously; the user can swap between them or merge into a conference.

### 10.2 Current State & Truth
**Status:** Shipped (client-side via JsSIP). Telnyx Conference API path also exists server-side ([[15-call-control]]) for true server-mixed audio in future.

| Concern | Implementation |
|---|---|
| Trigger | `SipContext.addCall(number)` → `sipService.addCall(rawNumber)` |
| Pre-hold of active | `holdCallWithMusicIfConfigured(active)` |
| New session | `this.call(rawNumber)` — `attachSessionListeners` promotes the new session to `activeCallId` BEFORE emitting `calling` |
| UI surface | "Held strip" in `InCall.tsx` showing the held call's number + per-call hangup |

### 10.3 Execution Context
- **Order of operations matters:** hold the active call FIRST (so the held leg is in music-hold or silent-hold before we start the new INVITE), clear the primary audio element's `srcObject` so the held leg's RTP doesn't bleed under the new call's ringback, then `ua.call()`.
- **CRITICAL for the new session to surface in the UI:** in `attachSessionListeners`, the outbound branch sets `this.activeCallId = callId` BEFORE emitting the `calling` event. `SipContext` filters non-active events out, so without this the second call's `calling`/`ringing` states never reach the UI.

### 10.4 Architectural Guardrails
- **No more than 2 concurrent calls.** The UI is designed for "active + held" + optional conference of those two. Three concurrent calls breaks Hold & Accept semantics and the held-strip layout.
- **Don't try to upgrade the existing active call's media stream in-place.** Always start a brand new session.
- **The held call's per-call `<audio>` element MUST be muted during the held window.** Otherwise the user hears the held party murmuring under the new call.

---

## 11. Swap Calls

### 11.1 Capabilities & Scope
- One-tap toggle between two concurrent calls. The newly-active call unholds (mic restored if music-held; SIP unhold otherwise); the previously-active call holds.

### 11.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Service | `sipService.swapCalls()` |
| Context wiring | `SipContext.swapCalls()` — captures prior active's display info, then `sipService.swapCalls()`, then re-stamps held-strip state |
| UI | `InCall.tsx` swap button — `<ArrowLeftRight />` icon |

### 11.3 Execution Context
- Pick the next call id by index modulo (`(currentIdx + 1) % ids.length`).
- Re-route the now-active call's `audioEl.srcObject` into the primary `<audio>` element so the user hears the right party on speakers.
- Emit a `'connected'` `CallEvent` for the now-active session so the UI's `callState` swaps to the right number/direction.

### 11.4 Architectural Guardrails
- **Swap must be symmetric.** If unholding the new active call leaves it on hold (music-hold path bug), the user has to tap Hold twice to clear it. Always use `unholdCallWithMusicIfConfigured` — `session.unhold()` alone won't restore the mic.
- **Don't re-emit the held call's events as if active.** Filter on the post-swap `activeCallId`.

---

## 12. Hold & Accept

### 12.1 Capabilities & Scope
- When a second call rings during an active call, the user can tap "Hold & Accept" to hold the current call (with music if configured) and answer the incoming one. After the swap, the prior active becomes the held leg — same shape as Add Call.

### 12.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Trigger | `SipContext.holdAndAcceptCall()` → `sipService.holdActiveAndAccept()` |
| UI button | `IncomingCall.tsx` — third button surfaces only when there's already an active call |
| Decline-reply post-decline | `PostDeclineReply.tsx` |

### 12.3 Execution Context
- Capture the prior active call's display info BEFORE the swap so the held strip can render it after the incoming becomes active.
- Hold the active (music-aware), clear primary `<audio>` `srcObject`, then `_answerIncoming(incoming)` (same centralised path as `acceptCall()`).
- Returns the now-held call's id so `SipContext` can populate `secondCallId`.

### 12.4 Architectural Guardrails
- **Fall back to plain accept when there's no active call.** No active = there's nothing to hold; just answer.
- **If the answer leg fails, unhold the original.** Don't leave the user with both calls in a broken state.
- **Don't bypass `_answerIncoming` for the incoming leg.** That function preflights gUM with a 3s ceiling — the inbound path needs the same protection as `acceptCall()`.

---

## 13. 3-Way Conference (Client-Side Web Audio Mix)

### 13.1 Capabilities & Scope
- Merge the active + held call into a 3-way conference. **Audio mixing happens client-side via Web Audio API** — each party hears the user + every other party; each leg can be hung up independently; per-participant mute supported.
- Server-side path via Telnyx Conferences exists in `callControl.ts` ([[15-call-control]]) as a parallel implementation for future migration; the shipped flow is the client-mixed one.

### 13.2 Current State & Truth
**Status:** Shipped (client-side mix). Server-side path = Planned.

| Concern | Implementation |
|---|---|
| Trigger | `SipContext.mergeCalls()` → `sipService.startConference()` |
| Audio graph | One `AudioContext` per conference, `MediaStreamAudioSourceNode` per remote, `MediaStreamAudioDestinationNode` per outgoing, `MediaStreamAudioSourceNode` for the mic |
| Per-participant mute | `muteConferenceParticipant(callId)` disconnects that participant's source from speaker + every other participant's outgoing destination |
| State surface | `conferenceActive`, `conferenceOtherNumber`, `conferenceOtherId` on `SipContext` |
| Stop trigger | Either leg ending fires `cleanupCall` → if `calls.size < 2`, `stopConference()` runs |

### 13.3 Execution Context
- **Graph topology:**
  - Mic → connects to every outgoing destination → all parties hear the user
  - Each remote audio receiver → connects to `ctx.destination` (user's speakers) AND to every OTHER call's outgoing destination → parties hear each other
  - We `sender.replaceTrack(mixedTrack)` per call so each SIP leg's outbound carries the mix, not just the raw mic
- **Unhold all legs first.** Conference requires both legs `sendrecv`; we `session.unhold()` on every leg in the conference set (or stop music-hold) before wiring the graph.
- **Mute path:** disconnect a participant's source node from `ctx.destination` (silences them in user's speakers) AND from every other call's outgoing destination (silences them for the other party). Inbound from that participant is untouched — they still hear everyone.
- **Stop path:** clear `conferenceParticipants` map, close the `AudioContext`, stop the mic `MediaStream`. CRITICALLY: any remaining call's outgoing sender is now pointed at a dead `MediaStreamDestination`. We fire a fresh `getUserMedia` and `replaceTrack(micTrack.clone())` on every surviving sender. Without this, the surviving call's far side can't hear the user.

### 13.4 Architectural Guardrails
- **Audio mixing graph MUST be torn down on any leg drop.** A residual node holding the mic on a closed `AudioContext` is the #1 source of "mic dead after conference ended" reports.
- **Mic restoration after `stopConference` is non-optional.** Every surviving sender needs a fresh, cloned mic track via `replaceTrack` — the conference replaced the original sender.track with the mixed destination, so the original mic is gone.
- **Don't conference held calls without unholding first.** A leg on `a=inactive` will negotiate to RTP-off and the mix will reach nobody on that leg.
- **Conference + music-hold are mutually exclusive states.** Entering conference clears `heldLocal` on every participant.

---

## 14. Transfer (Blind via Telnyx Call Control)

### 14.1 Capabilities & Scope
- Blind-transfer the active call to a new number. The user's WebRTC leg drops, Telnyx bridges the original caller to the transfer target.

### 14.2 Current State & Truth
**Status:** Shipped (server-side via Call Control). SIP REFER path exists in `sipService.transfer()` but is **not** the active route — Call Control is the canonical path.

| Concern | Implementation |
|---|---|
| Trigger | `SipContext.transferCall(destination)` |
| Wait for callControlId | Polls `activeCallControlIdRef` up to 10s before failing |
| API call | `POST /calls/:callControlId/transfer` → `apps/api/src/calls/calls.routes.ts` → `telnyx.transfer(legControlId, { to, from })` |
| UI | `InCall.tsx` transfer dialog — phone-number input + Cancel/Transfer |

### 14.3 Execution Context
- The leg's `call_control_id` is populated by the `call.initiated`/`call.answered` webhook — `SipContext` polls `/calls/by-telnyx/:id` every 1s for up to 15s post-connect to resolve it.
- `transferCallApi(token, callControlId, destination)` returns `{ ok, error?, hint? }`. On `no_call_control_id`, the UI hint reads: "Telnyx hasn't registered this call leg yet. Check Render webhook logs."

### 14.4 Architectural Guardrails
- **Never enable Transfer in the UI until `activeCallControlId` is non-null.** Otherwise the user taps and waits — bad UX.
- **Don't ship the SIP REFER path as the primary route.** Call Control transfer is reliable and Telnyx-supported; REFER is in the codebase as a fallback for environments where Call Control isn't configured.

---

# Section F — Server-Side Orchestration

## 15. Telnyx Call Control Wrapper

### 15.1 Capabilities & Scope
- Thin typed wrapper around `https://api.telnyx.com/v2` for the Voice API actions we use: `/calls` (dial), `/calls/:id/actions/{bridge, transfer, hangup, record_start, record_stop}`, `/conferences`, `/conferences/:id/actions/join`, `client_state` encode/decode, leg discovery via `call_session_id`.

### 15.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Wrapper | `apps/api/src/telnyx/callControl.ts` |
| Auth | `Authorization: Bearer ${TELNYX_API_KEY}` from env |
| Surface used | `dial`, `transfer`, `bridge`, `conferenceCreate`, `conferenceJoin`, `recordStart`, `recordStop`, `listLegsBySession`, `hangupCall`, `encodeClientState`, `decodeClientState`, `normalizeToE164` |

### 15.3 Execution Context
- **`client_state` is the durable hint Telnyx echoes back on every webhook for a call.** We base64-encode JSON like `{ bridgeTo, joinConfId, endConfOnExit, originatorUserId }` and read it inside the webhook handler to know what to do when a leg answers.
- **`listLegsBySession(sessionId)`** uses `filter[call_session_id]` to enumerate all legs of a session — used by add-leg to discover the WebRTC client leg's `call_control_id` without needing it pre-captured.
- **All POSTs return `{ ok, status, data?, error? }`.** Callers must inspect `ok` before assuming success.

### 15.4 Architectural Guardrails
- **Don't forget to set `TELNYX_API_KEY`.** The wrapper returns `{ ok: false, error: 'TELNYX_API_KEY not set' }` silently if missing — visible only in logs.
- **`normalizeToE164` is the only correct way to send numbers to Telnyx.** SIP URIs pass through untouched.
- **`bridge` is the legacy two-leg pattern.** Prefer `conferenceCreate` + `conferenceJoin` for anything that needs independent hangup — bridged legs hang each other up when either drops.

---

## 16. Telnyx Webhooks (Multi-User Routing, Voicemail, Bridging)

### 16.1 Capabilities & Scope
- Receives every Telnyx event (`call.initiated`, `call.answered`, `call.hangup`, `message.received`, `message.sent`, `calls.voicemail.completed`, etc.) and persists/routes per user.
- Multi-user routing matches events to the right `User` via `sip_username`, then `did_number` (last-10 digits), then a `PILOT_USER_ID` fallback.
- Inbound number blocking: rejects blocked callers with `USER_BUSY` (skips Hosted Voicemail fallthrough) and silently drops blocked-sender SMS.

### 16.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Service | `apps/webhooks/src/main.ts` (separate Render service from `api`) |
| DB client | Same shared `@ace/db` (Prisma) |
| Telnyx API key | `TELNYX_API_KEY` (separate env from the `api` service) |
| Routing helper | `resolveUserId({ sipUsername, fromNumber, toNumber })` |
| Block check | `isFromNumberBlockedForUser(userId, fromNumber)` — last-10 digit compare; fail-open on DB error |
| Block enforcement | `rejectCallByControlId(cc)` → Telnyx `/actions/reject` with `cause: 'USER_BUSY'` |
| `client_state` decode | Base64 JSON; carries `bridgeTo` (legacy), `joinConfId` (current), `endConfOnExit`, `originatorUserId` |

### 16.3 Execution Context
- **Voicemail capture** is Telnyx Hosted Voicemail (enabled per-DID via `POST /v2/phone_numbers/:id/voicemail`). Telnyx rings the SIP connection, falls to voicemail on no-answer, records, and fires `calls.voicemail.completed`. **We do NOT run Call Control voicemail flows ourselves** — we tried; it caused looped events and wrong caller ID.
- **Add-call answered path:** when the server-originated Leg B answers, the webhook reads `joinConfId` from `client_state` and POSTs to `/conferences/:id/actions/join` — Leg A and Leg B are now in the same Telnyx Conference room.
- **Form-encoded bodies** are accepted via `@fastify/formbody` so Telnyx TexML callbacks (form-encoded POSTs to action URLs) parse correctly — without it, Fastify returns 415 and Telnyx plays the "application error" prompt.

### 16.4 Architectural Guardrails
- **Webhook handlers must be idempotent.** Telnyx retries on non-2xx, so any side effect must tolerate replay (e.g., DB writes use upsert / `ON CONFLICT DO NOTHING`).
- **Fail open on classification, fail closed on action.** Block-lookup DB errors return `false` (allow the call); but `reject()` failures should log loudly and let the call ring (it's better than silent-dropping legitimate calls).
- **Don't trust the webhook for the WebRTC leg's identity.** Match webhook → user via DID (last-10) and SIP username; the renderer's `telnyxCallId` may not match because the SDK ID differs from `call_session_id`.

---

## 17. Call History & Recents Dedupe

### 17.1 Capabilities & Scope
- Renders the user's call history sorted newest-first, deduped across Telnyx's multiple webhook legs for the same physical call.
- Surfaces missed-call counts for the bottom-nav badge.

### 17.2 Current State & Truth
**Status:** Shipped. Two-pass dedupe in `apps/api/src/calls/calls.routes.ts`.

| Concern | Implementation |
|---|---|
| List endpoint | `GET /calls` |
| Missed count | `GET /calls/missed/count?since=<ISO>` |
| Dedupe | `dedupeCallLegs<T>(rows)` — pass 1 groups by `sessionId` (`call_session_id`), pass 2 proximity-merges within 60s on last-10 of the OTHER party |
| Status rank | `STATUS_RANK` priority: `blocked > answered > completed > forwarded > rejected > no_answer > missed > failed > initiated > ringing` |

### 17.3 Execution Context
- **Why dedupe is necessary:** Telnyx fires multiple webhooks for the same physical call — one for the PSTN leg and one for the SIP-delivery leg — each with a different `call_control_id`. A naive `findMany` returns two rows per call, which is how a single blocked call ended up rendering as both "Missed" and "Blocked" in Recents.
- **Two-pass strategy:** Pass 1 collapses rows with the same `sessionId`. Pass 2 catches the SDK-side renderer ghost row (no `sessionId`) by proximity-matching the other party's last-10 digits within a 60s window.
- **`pickBetter`:** higher status rank wins; tie-break on longer `durationSeconds`, then latest `startedAt`.

### 17.4 Architectural Guardrails
- **Don't trust `telnyxCallId` for dedupe.** The SDK and the webhook use different ids for the same call.
- **`sessionId` is the join key when present.** Always store Telnyx's `call_session_id` on the `Call` row.
- **The missed-count endpoint MUST return only the count.** Don't return rows — the badge poll runs every 15s and shouldn't be paying full-row egress.

---

# Section G — Communication Channels

## 18. Messaging (SMS / MMS)

### 18.1 Capabilities & Scope
- Send + receive SMS and MMS via Telnyx Messaging. Threaded by `threadKey` = the other party's E.164. MMS uploads land in Supabase Storage (`ace-media` bucket); URLs are persisted on the `Message` row.

### 18.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| API routes | `apps/api/src/messages/messages.routes.ts` |
| Endpoints | `GET /messages/threads`, `GET /messages/threads/:number`, `POST /messages`, `POST /messages/upload`, `GET /messages/unread/count` |
| Web UI | `apps/web/src/pages/Messages.tsx` |
| Compose | Quick replies pulled from `userPrefs.getQuickReplies()` |
| Inbound | Telnyx webhook → `message.received` → resolve user via `resolveUserId` → upsert by `telnyxMessageId` |

### 18.3 Execution Context
- **MMS upload:** `POST /messages/upload` accepts `{ filename, mimeType, dataBase64 }` (16 MB body limit, ≤10 MB payload). Uploaded to Supabase via service-role key; returns `{ url }` for the sender to attach to a subsequent `POST /messages`.
- **Send path:** `POST /messages` with `{ to, body, mediaUrls }`. Server normalizes `to` to E.164, calls Telnyx Messaging API, persists the outbound row in pending state; webhook updates to `sent`/`delivered`/`failed`.

### 18.4 Architectural Guardrails
- **`telnyxMessageId` is the dedupe key.** Always upsert on it — webhooks retry.
- **`threadKey` = the OTHER party's E.164 regardless of direction.** Don't store the user's own DID as `threadKey` or you'll fragment the thread.
- **MMS upload size cap is real.** Larger payloads break Telnyx + cost a lot of storage. Reject early at the API.
- **Quick replies live in `localStorage`.** They're a UI convenience, not synced; explicit user-content settings live in [[5-app-shell]] / Settings → Quick Replies.

---

## 19. Voicemail (Inbox + Greeting + Retention)

### 19.1 Capabilities & Scope
- Inbox of voicemails received on the user's DID. Each row carries the recording URL, duration, optional transcription, and a `listenedAt` timestamp for the unread badge.
- Custom voicemail greeting upload: per-user MP3 stored in Supabase Storage and registered with Telnyx via `PATCH /v2/phone_numbers/:id/voicemail`.
- Retention: server-controlled days (default 30), exposed via `GET /voicemails/retention`.

### 19.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| API routes | `apps/api/src/voicemails/voicemails.routes.ts`, `apps/api/src/voicemailGreeting/voicemailGreeting.routes.ts` |
| Endpoints | `GET /voicemails`, `PATCH /voicemails/:id`, `DELETE /voicemails/:id`, `PATCH /voicemails/bulk`, `GET /voicemails/unread/count`, `GET /voicemails/retention`, `GET/POST/DELETE /voicemail-greeting` |
| Web UI | `apps/web/src/pages/Voicemail.tsx` |
| Capture | Telnyx Hosted Voicemail → webhook `calls.voicemail.completed` → upsert `Voicemail` row by `telnyxCallId` |
| Greeting storage | Supabase Storage `ace-media` bucket |

### 19.3 Execution Context
- **Greeting upload contract:** `POST /voicemail-greeting` with `{ filename, mimeType, dataBase64 }`. Server uploads to Supabase, then PATCHes Telnyx phone_numbers endpoint with the public URL.
- **Bulk listened toggle:** `PATCH /voicemails/bulk` with `{ ids: number[], listened: boolean }` — used by the select-mode toolbar.

### 19.4 Architectural Guardrails
- **Telnyx Hosted Voicemail is the only path.** Don't reinvent voicemail via Call Control — we tried; it produces looped events and wrong caller ID.
- **Greeting upload size + format follow Telnyx's voicemail API limits.** Surface Telnyx's error message verbatim when the API rejects — it tells the user exactly what's wrong (codec, duration, etc.).
- **Block-rejected calls must NOT fall to voicemail.** That's enforced server-side via `/actions/reject` with `USER_BUSY` (see [[16-webhooks]] + [[22-blocking]]).

---

## 20. Internal Chat (User-to-User)

### 20.1 Capabilities & Scope
- Dialer-user ↔ dialer-user messaging, separate from external SMS. Threads grouped by canonical `threadKey = "<minId>_<maxId>"`. Polling-based (no WebSocket yet — see [[29-realtime-socket]]).

### 20.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| API routes | `apps/api/src/internalChat/internalChat.routes.ts` |
| Endpoints | `GET /internal-chat/users`, `GET /internal-chat/threads`, `GET /internal-chat/threads/:otherId`, `POST /internal-chat`, `POST /internal-chat/threads/:otherId/read`, `GET /internal-chat/unread/count` |
| Web UI | `apps/web/src/pages/Chat.tsx` |
| Polling | Web polls thread list + active conversation periodically while open |
| Media | Same Supabase `ace-media` bucket reused from MMS |

### 20.3 Execution Context
- **Canonical threadKey** lets us index a 1:1 thread cheaply regardless of who sent last. `Math.min(senderId, recipientId) + "_" + Math.max(...)`.
- **Unread state** lives in `Message.readAt` (null = unread). `POST /threads/:otherId/read` stamps `readAt` for every unread message addressed to the caller.

### 20.4 Architectural Guardrails
- **Internal chat MUST NOT touch the SMS path.** No Telnyx involvement — it's pure in-app messaging.
- **threadKey is canonical.** Don't store per-direction keys, or threads will fragment.
- **Reuse the SMS media bucket** — no second Supabase resource needed.

---

# Section H — Contacts & Routing

## 21. Favorites (Server-Synced)

### 21.1 Capabilities & Scope
- Starred contacts list, per-user. Surfaced in Favorites tab + as friendly-name lookup in Recents / IncomingCall / InCall.
- Server-synced: same list across browser, Electron, and multiple machines.

### 21.2 Current State & Truth
**Status:** Shipped (server-sync just landed). DB table created and routes deployed; client uses optimistic local writes with background API push.

| Concern | Implementation |
|---|---|
| DB | `Favorite` model in `packages/db/prisma/schema.prisma` |
| API routes | `apps/api/src/favorites/favorites.routes.ts` — `GET`, `POST` (upsert), `PATCH /:id`, `DELETE /:id` |
| API client | `apps/web/src/api.ts` — `getFavoritesApi`, `upsertFavoriteApi`, `renameFavoriteApi`, `removeFavoriteApi` |
| Local cache | `localStorage['ace_favorites']` (synchronous read path for `isFavorite` / `getFavoriteName` / `getFavorites`) |
| Mutation engine | `apps/web/src/lib/userPrefs.ts` — optimistic local write + background API push, `pendingDeletesByPhone` to handle the add→remove race |
| Bootstrap | `refreshFavoritesFromServer()` called on login, window focus, `visibilitychange`, and a 60s timer |
| UI | `apps/web/src/pages/Favorites.tsx`, also star-toggle in Messages + Recents |

### 21.3 Execution Context
- **Storage:** `(userId, phone)` unique; phone is E.164. `firstName`, `lastName`, `label` optional; `label` is the legacy field, new clients write firstName+lastName.
- **Sync model:** optimistic local write → background `upsertFavoriteApi` → on response, merge `id` into local row. If user removes the row before POST returns, we add `phone` to `pendingDeletesByPhone` and fire DELETE as soon as the POST resolves.
- **Periodic refresh:** every 60s + on `focus` + on `visibilitychange=visible` → `getFavoritesApi` → overwrite local cache.

### 21.4 Architectural Guardrails
- **Synchronous read API is non-negotiable.** Render paths (`isFavorite`, `getFavoriteName`) MUST stay sync. The localStorage cache is what makes that possible; server is the source of truth, cache is the fast read.
- **Mutations are optimistic.** UI feedback is instant; reconciliation happens in the background. Don't change this to await — it'll feel sluggish.
- **Phone matching uses `normalizeFavoritePhone` (digits + leading `+`).** Don't compare raw strings.
- **The `id` field on the local cache is the only authoritative DELETE handle.** Phone-keyed DELETE on the server would need a new endpoint; we don't have one.

---

## 22. Number Blocking

### 22.1 Capabilities & Scope
- Per-user blocklist of inbound phone numbers. Blocked callers hear a busy signal (Telnyx REJECT with `USER_BUSY`) and skip voicemail; blocked-sender SMS is silently dropped before reaching the inbox.

### 22.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| DB | `BlockedNumber` model — `(userId, number)` unique |
| API routes | `apps/api/src/blocked/blocked.routes.ts` — `GET /blocked-numbers`, `POST`, `DELETE /:id` |
| Webhook enforcement | `isFromNumberBlockedForUser` + `rejectCallByControlId` in `apps/webhooks/src/main.ts` |
| Web UI | Settings → Blocked Numbers (`Settings.tsx`) + inline block toggle in Recents/InCall |

### 22.3 Execution Context
- **Match strategy:** compare last-10 digits of `fromNumber` against the blocklist — tolerant of carrier formatting differences.
- **Inbound call:** webhook rejects via `/actions/reject` with `cause: 'USER_BUSY'` BEFORE the SIP connection rings; caller gets SIP 486. **Reject (not hangup)** is critical: Telnyx treats hangup as "no answer" and routes to Hosted Voicemail; reject skips voicemail entirely.
- **Inbound SMS:** webhook drops the message without storing — no `Message` row is created.

### 22.4 Architectural Guardrails
- **Always use `/actions/reject` with `USER_BUSY`, never `/actions/hangup`.** Hangup → voicemail leak.
- **Fail open on DB lookup error.** A momentary DB blip must not start dropping legit calls.
- **Don't preserve "blocked" status across an unblock.** When the user removes a block, future calls must ring normally.

---

## 23. Call Forwarding

### 23.1 Capabilities & Scope
- Per-user setting: when enabled, inbound calls to the user's DID forward to a chosen number — either always or only on no-answer (falls through to voicemail otherwise).
- Save provisions Telnyx automatically via the Voice API.

### 23.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| DB columns | `User.forwardingEnabled`, `User.forwardingNumber`, `User.forwardingMode` (`'always' \| 'on_failure'`) |
| API routes | `apps/api/src/callForwarding/callForwarding.routes.ts` — `GET /auth/call-forwarding`, `PUT /auth/call-forwarding` |
| Telnyx provisioning | Updates Telnyx phone_number forward settings on save |
| Web UI | Settings → Call Forwarding |

### 23.3 Execution Context
- **`mode: 'always'`** — every call forwards immediately, never rings the dialer.
- **`mode: 'on_failure'`** — Telnyx rings the dialer first; if no-answer, calls the forwarding number; if that also fails, falls to voicemail.

### 23.4 Architectural Guardrails
- **Both `enabled: false` and `forwardingNumber: null` mean OFF.** Validate both server-side.
- **Save must round-trip to Telnyx before returning success.** Otherwise the DB state can drift from the carrier configuration.

---

## 24. JobDiva Contact Lookup

### 24.1 Capabilities & Scope
- Look up an inbound or dialed number against the ApTask JobDiva CRM and surface the contact's name + company + job title inline in Recents / IncomingCall / InCall / Messages.

### 24.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| API route | `apps/api/src/jobdiva/jobdiva.routes.ts` — `GET /jobdiva/contact?phone=...` |
| Client | `apps/api/src/jobdiva/client.ts` — auth + search wrappers around `api.jobdiva.com` |
| React hook | `apps/web/src/hooks/useJobDivaContact.ts` — lookup + in-memory cache (`getCachedJobDivaName`) |
| Auth | `JOBDIVA_CLIENT_ID`, `JOBDIVA_USERNAME`, `JOBDIVA_PASSWORD` env vars |

### 24.3 Execution Context
- **API client caches the JobDiva auth token** between requests; on 401 it refreshes once.
- **In-memory cache on the web side** (`getCachedJobDivaName(phone)`) so consecutive renders don't re-fetch. Cache is per-tab, not persisted.

### 24.4 Architectural Guardrails
- **JobDiva is an enrichment, never the source of truth.** If lookup fails, fall back to the user's own Favorites name, then formatted phone.
- **Cache only successful lookups.** Don't pollute the cache with `null` for missing contacts — they may get added to JobDiva later.

---

# Section I — Notifications & Lifecycle

## 25. Notifications, Ringtones & Floating Ringer

### 25.1 Capabilities & Scope
- Three notification surfaces, per-user-toggleable: in-app toast for incoming calls, OS-level desktop notifications when the window is hidden, in-app SMS toast.
- Synth ringtone (Web Audio) for inbound calls; local ringback for outbound while waiting for early media.
- Electron's floating ringer popup (separate `BrowserWindow`) so an inbound call surfaces even when the main window is buried.

### 25.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Prefs | `apps/web/src/lib/userPrefs.ts` — `NotificationPrefs` (inAppToast, ringtone, ringtoneVolume, desktopNotification, smsNotification) |
| Ringtone synth | `apps/web/src/services/ringtone.ts` |
| In-app SMS toast | `apps/web/src/components/SmsNotifier.tsx` |
| OS notify util | `apps/web/src/lib/notify.ts` — `ensureNotificationPermission` |
| IncomingCall banner | `apps/web/src/components/IncomingCall.tsx` |
| Floating ringer | `createRingerWindow(callerNumber)` in `apps/desktop/src/main.ts` |

### 25.3 Execution Context
- **IncomingCall component** uses `getFavoriteName(callerNumber) ?? jd?.name ?? formatNumber(callerNumber)` for the display label — Favorites > JobDiva > formatted phone.
- **Floating ringer is opened on the IPC `ace:incoming-call` event** the renderer fires when SIP raises an `incoming` event AND `window.ace?.onIncomingCall` exists (Electron only).
- **Window surfacing:** main window is shown, restored, focused, `flashFrame(true)` on Windows, `setAlwaysOnTop(true)` for 2.5s.

### 25.4 Architectural Guardrails
- **Defer the OS notification permission prompt to post-login.** Chrome flags on-load `Notification.requestPermission()` as spammy.
- **Floating ringer HTML is inline (data: URL).** Don't load a separate file or remote URL — it must work offline and during cold start.
- **`alwaysOnTop` is non-permanent (2.5s).** Don't pin the main window — it interferes with the user's other apps.

---

## 26. Auto-Update (Electron)

### 26.1 Capabilities & Scope
- Silent auto-update from GitHub Releases via `electron-updater`. Hourly poll, background download, in-app "Restart to install" banner when download completes.
- Manual "Check for updates" menu item with friendly error mapping.

### 26.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Library | `electron-updater` |
| Poll interval | 15s after launch, then 60 min |
| State mirror | `lastUpdateState` in main process; renderer reads via IPC `ace:get-update-state` on banner mount |
| UI banner | `apps/web/src/components/UpdateBanner.tsx` |
| Manual check | IPC `ace:check-for-updates` from user-dropdown menu |
| Install | IPC `ace:install-update` → `autoUpdater.quitAndInstall(false, true)` |
| Release source | `package.json` → `build.publish` → GitHub repo |

### 26.3 Execution Context
- **Why we don't call `checkForUpdatesAndNotify()`:** that uses native OS notifications which users dismiss and forget. In-app banner is more reliable.
- **State-mirror pattern:** `electron-updater` fires `update-downloaded` exactly once. If the renderer's `UpdateBanner` had unmounted (route change, hot reload, React strict-mode double-mount), the event was lost forever. We mirror state in main and let the renderer rehydrate on mount.
- **Manual check error mapping:** `electron-updater` dumps raw HTTP on failure — ugly. We map common cases (`404`, `ENOTFOUND`, `403`) to friendly messages.

### 26.4 Architectural Guardrails
- **Code-signing required for macOS auto-update.** Without it, Mac auto-update silently fails. Windows works regardless.
- **`autoInstallOnAppQuit: true`** lets a quit-and-restart cycle pick up a pending update without an explicit user action.
- **Never call `quitAndInstall` while a call is active.** Currently we don't gate this — TODO: block install if `sipService.calls.size > 0`.

---

# Section J — Aesthetic & Governance

## 27. Visual System & Aesthetic

### 27.1 Capabilities & Scope
- iOS-inspired softphone UI: dark by default with optional light mode, blurred glass surfaces (`backdrop-filter: blur(20px)`), generous spacing, restrained color palette, monospaced numerics in call-time displays.
- The In-Call screen specifically mirrors Apple's Phone app's information hierarchy (caller identity at top, time + quality indicator, action grid below, hangup as the single red affordance).

### 27.2 Current State & Truth
**Status:** Shipped.

| Concern | Implementation |
|---|---|
| Stylesheet | `apps/web/src/styles.css` (~5,200 lines, single file) |
| Theme tokens | `:root` (dark) + `[data-theme="light"]` overrides for `--bg`, `--bg-elevated`, `--border`, `--text`, `--text-dim`, `--text-muted` |
| Font stack | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif` |
| Iconography | `lucide-react` exclusively — no emoji icons, no stock icon sets |
| Glass effect | `backdrop-filter: blur(20px)` on overlays + modals (with `-webkit-` prefix) |
| Theme switcher | `apps/web/src/lib/userPrefs.ts` → `getTheme`, `setTheme`, `applyTheme`, `watchSystemTheme` |

### 27.3 Execution Context
- **Dark canon:** `#000` background, `#1c1c1e` elevated surfaces, white text with `rgba(235, 235, 245, 0.7)` for dim. Direct lift from iOS dark mode tokens.
- **Light canon:** `#f2f2f7` background, `#fff` elevated, `#1c1c1e` text with `rgba(60, 60, 67, 0.7)` for dim. iOS light mode tokens.
- **In-call layout:** caller name (large), formatted number (smaller, beneath), call timer (monospaced), 6-button action grid (mute/keypad/audio/add/hold/transfer), red hangup button below. Held strip slides up from the bottom when a second call exists.

### 27.4 Architectural Guardrails
- **No stock-photo callbacks, no emoji confetti, no gradient blasts, no Material-Design-esque ripple buttons.** This is intentionally Apple-aesthetic.
- **Lucide is the only icon library.** Don't import Heroicons, Material Icons, or stylized emoji.
- **Color is restrained.** Action buttons use neutral white-on-dark or dark-on-light. Red is reserved for hangup / destructive. Green for accept. No purple, no rainbow.
- **Animations are short, easing is `cubic-bezier(0.2, 0, 0, 1)` (Apple's curve) or `ease-out`.** No spring-bouncy animations, no over-100ms color shifts.
- **Numerics in call timers + DTMF keys use SF Mono / system mono fallback.** Numbers must align across digit changes.
- **Touch targets ≥ 44px** on every action surface (iOS HIG).
- **Do not add a 'beta', 'new', 'try it!' label to anything.** This is a professional softphone, not a startup signup page.

---

## 28. Audit Log

### 28.1 Capabilities & Scope
- Enterprise hygiene: every admin action (`user.invited`, `user.promoted`, `user.demoted`, `user.deactivated`, `user.password_reset`, `user.sso_first_signin`) writes a row. Read-only for non-admins; admins see the full feed at Settings → Audit Log.

### 28.2 Current State & Truth
**Status:** Planned (schema landed, write paths + admin UI not yet wired).

| Concern | Implementation |
|---|---|
| DB model | `AuditLog` — id, actorUserId?→User, action (dot-namespaced), targetUserId?→User, metadata Json?, createdAt |
| Indexes | `createdAt`, `(actorUserId, createdAt)`, `(targetUserId, createdAt)`, `(action, createdAt)` |
| Write sites | Not yet wired — TODO list in `ACE_DIALER_TODO.md` Phase 2 |
| Admin UI | Planned: Settings → Audit Log |

### 28.3 Execution Context
- **Actions are dot-namespaced strings** so the prefix gives the entity (e.g., `user.*`, `dial.*`) and the suffix gives the verb.
- **`metadata` is free-form JSON** for old/new value diffs, IP, source (web/electron).

### 28.4 Architectural Guardrails
- **System-generated entries set `actorUserId = null`.** Don't fake a system user — null is the convention.
- **Audit writes MUST NOT block the user-facing action.** Fire-and-forget; failures log loudly but don't surface to the user.
- **Don't log the actual password / SIP password in `metadata`.** Hash references or boolean "changed" markers only.

---

## 29. Realtime Socket Service

### 29.1 Capabilities & Scope
- Push real-time events from server to clients (intended for: presence in internal chat, multi-device call event fan-out, replacing polling in Layout for badges).

### 29.2 Current State & Truth
**Status:** Planned (stub only — ping/pong + connection log).

| Concern | Implementation |
|---|---|
| Service | `apps/socket/src/main.ts` |
| Library | `socket.io` over Fastify HTTP server |
| Port | `PORT` env (default 3001) |
| Implemented events | `connected`, `ping`, `pong`, `disconnect` only |
| Planned events | "31 chatSocket events from Pulse" per the source comment — not yet imported |

### 29.3 Execution Context
- Separate Render service so socket load can scale independently of `api`.

### 29.4 Architectural Guardrails
- **Don't wire UI to socket events until the auth handshake is implemented.** Currently anyone can connect — `socket.handshake.auth.token` validation is not in place.
- **Polling stays the canonical path until socket is real.** Badge counts, chat threads, voicemail inbox all poll today; switch to socket invalidation in one feature at a time, not all at once.

---

# Glossary

- **Telnyx Call Control** — Telnyx's server-side voice API (`api.telnyx.com/v2/calls`, `/conferences`). We use it for transfer, add-leg, conference creation, recording, blocked-caller reject.
- **`call_control_id`** — Telnyx's per-leg handle. Required for every Call Control action. Populated by webhook, NOT immediately by the WebRTC SDK.
- **`call_session_id`** — Telnyx's per-call handle, shared across both legs of the same physical call. Used as the dedupe key for Recents.
- **`client_state`** — Base64-encoded JSON Telnyx echoes back on every webhook for a call. Carries instructions like `joinConfId`, `bridgeTo`, `originatorUserId`.
- **DID** — Direct Inward Dial: the user's E.164 phone number assigned by Telnyx.
- **JsSIP** — The browser-side SIP UA library we use. Replaces `@telnyx/webrtc` to unblock multi-call orchestration.
- **`RTCSession`** — JsSIP's per-call object. Each one owns an `RTCPeerConnection`.
- **REGISTER heartbeat** — The 20s active re-register we send to Telnyx so the registration never expires, even when the tab is throttled.
- **Held strip** — The UI surface in InCall showing the held second call with its own hangup button.

---

*End of blueprint. When a feature ships or changes state, edit the relevant module BEFORE merging. The block is the contract.*
