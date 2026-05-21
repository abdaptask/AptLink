# ACE Dialer — Working Checklist

**Last updated:** 2026-05-21 (late evening)
**Current version:** v0.6.1
**Owner:** Abdulla (abdulla@aptask.com)
**Pilot target:** 150 total users, ~30–40 concurrent peak

Check items off as we complete them. New items get appended at the bottom. Items in *italics* are blocked on a decision or external dependency.

---

## Decisions made

- [ ] **Postgres provider** — Neon ($19/mo Scale) **or** Render Postgres ($19/mo)? *Still pending — user is sourcing cheaper Postgres elsewhere.*
- [x] **Auto-provision on first SSO** — **invite-only** (admin invite required, controls DID cost)
- [x] **Break-glass local-password accounts** — **yes**, abdulla@aptask.com retains password fallback alongside SSO
- [x] **Installer code-signing** — **Mac done** (Developer ID + notarization in CI). **Windows deferred** to GA (pilot accepts SmartScreen warning)

---

## Phase 1 — Entra ID setup ✅ DONE

- [x] App registered in https://portal.azure.com as ApTask admin
- [x] Single-tenant; redirect URIs for web (`https://acedialerv4-web.vercel.app/auth/microsoft/callback`) and Electron (`ace-dialer://auth/callback`)
- [x] Client secret (24 months) + tenant ID copied
- [x] API permissions: `openid`, `profile`, `email`, `User.Read`
- [x] `MS_CLIENT_ID`, `MS_TENANT_ID`, `MS_CLIENT_SECRET` set on Render

## Phase 2 — Schema + SSO backend ✅ DONE

- [x] Prisma migration: nullable `passwordHash`, `azureOid` unique, `provider`, `AuditLog` table
- [x] `@azure/msal-node`: `ConfidentialClientApplication` for web, `PublicClientApplication` (PKCE) for Electron
- [x] `POST /auth/microsoft/exchange` + `GET /auth/microsoft/config`
- [x] Local-login guard against null `passwordHash` for SSO-only users

## Phase 3 — Login UI (web) ✅ DONE

- [x] PKCE helpers in `lib/oauth.ts`
- [x] Rewritten `Login.tsx` with "Sign in with Microsoft" + break-glass password disclosure
- [x] `MicrosoftCallback.tsx` callback page handling state + code exchange
- [x] Route registered in `App.tsx`

## Phase 4 — Polish Login + Electron deep-link + Installers ✅ DONE

- [x] **#188** Polished Login: gradient backdrop, glass card, dark Microsoft CTA, dark theme
- [x] **#177** Electron `setAsDefaultProtocolClient('ace-dialer')` + `open-url` (mac) + second-instance argv handler (win)
- [x] Single-instance lock + `ace:open-external` + `ace:sso-callback` IPC channels
- [x] Preload bridge: `openExternal`, `onSsoCallback`, `notifyReadyForSso`
- [x] Vite `base: './'` for file:// asset paths
- [x] `HashRouter` for file:// (Electron), `BrowserRouter` for http(s):// (web)
- [x] **#170** Windows `.exe` build via GitHub Actions (NSIS installer)
- [x] Mac `.dmg` build via GitHub Actions (both arm64 + x64)
- [x] **#193** Apple Developer Program enrolled, Developer ID cert generated, GitHub secrets configured (`APPLE_CSC_LINK`, `APPLE_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`)
- [x] `entitlements.mac.plist` at `apps/desktop/` root (not in gitignored `build/`)
- [x] Hardened Runtime entitlements + `NSMicrophoneUsageDescription` + `CFBundleURLTypes`
- [x] **Signed + notarized `.dmg` installs cleanly on Mac with zero Gatekeeper warnings**
- [x] **Windows `.exe` installs cleanly via NSIS one-click installer**
- [x] SSO end-to-end on Mac Electron app (browser → `ace-dialer://` → app) AND on Windows
- [x] Mic permission prompt fires on first call (Mac shows ACE Dialer in System Settings)
- [x] SIP password populated in DB → JsSIP connects → verified live call on Mac signed build

## Phase 4.5 — Today's user-requested polish ✅ DONE

- [x] **#159** Number blocking — backend CRUD, Settings UI, webhook hangup, red Ban icon in Recents, **per-row Block buttons** on Recents + Messages thread header, session-aware hiding
- [x] **#161** Favorite name now shows everywhere: Recents, IncomingCall, InCall, Messages (thread row + header + history modal), Voicemail (rows + filter banner). Favorite name beats JobDiva name beats raw number.
- [x] **#195** **Favorites sync server-side** — moved from per-device localStorage to Postgres-backed `Favorite` table. API routes (`GET/POST/PATCH/DELETE /favorites`) wired into `apps/api/src/main.ts`. Frontend rewrote `lib/userPrefs.ts` to use in-memory cache hydrated from server on login, optimistic mutations, fire-and-forget background sync. `loadFavoritesFromServer()` runs on every `getMe` and `handleLoginSuccess`; `clearFavoritesCache()` runs on `handleLogout`. One-shot migration uploads any pre-existing localStorage favorites on first hydrate.
- [x] **#196** **Version bump 0.4.0 → 0.6.0** across `package.json` root, `apps/web`, `apps/desktop`, and the API's `/` endpoint. (Header chip reads `__APP_VERSION__` injected by Vite.)
- [x] **#197** **"Update available" banner** — `UpdateBanner.tsx` polls API `/` every 15 min, compares server version to bundled `__APP_VERSION__`, shows a non-blocking pill at the top of every page when a newer version is published. In Electron the "Download installer" button opens GitHub Releases via `shell.openExternal`; in web it offers "Refresh now" + a desktop-installer link. Dismissible per-session, keyed by version so the banner reappears on the NEXT release.
- [x] **#198** **GitHub Actions publishes real releases** — workflow now uses `softprops/action-gh-release@v2` to create `vX.Y.Z` releases tagged from `apps/desktop/package.json` with `.dmg` + `.exe` attached. `permissions: contents: write` lets it use the built-in `GITHUB_TOKEN`. Banner's download link now points to permanent assets, not expiring CI artifacts.
- [x] **Version bump 0.6.0 → 0.6.1** for the banner + release-publishing changes.

---

## Phase 5 — Bulk import existing 150 users (Claude, ~2 hr) ← NEXT

- [ ] **#189** CSV ingest endpoint `POST /admin/users/bulk-import` (admin-only, idempotent on email)
- [ ] **#189** CLI fallback: `node scripts/bulk-import-users.mjs --file=users.csv`
- [ ] You: pull existing user list from Telnyx Portal (SIP Connection → Credentials → export) + add emails from Entra ID
- [ ] Run import → confirm all 150 User rows created → spot-check a few

## Phase 6 — Admin Users panel + per-user provisioning (Claude + you, ~4 hr)

- [ ] **#178** Backend: `PATCH /admin/users/:id` with last-admin safeguard + AuditLog
- [ ] **#167** Backend: `POST /admin/users` provisioning orchestration (Telnyx sub-credential + DID purchase + assign + voicemail enable + DB row + audit)
- [ ] **#168 + #179** Frontend: `Settings → Users` panel with table, Invite, promote/demote, deactivate
- [ ] **#180** Frontend: `Settings → Audit Log` viewer (read-only)
- [ ] **#169** CLI fallback: `scripts/provision-user.mjs`
- [ ] **#166** Investigate Telnyx API: sub-credentials, DID purchase + assign, voicemail config endpoints
- [ ] **#171** Write new-user onboarding one-pager (PDF): Install → Open → Sign in with Microsoft → Done

## Phase 7 — Pilot smoke test (you, ~30 min)

- [ ] Sign out → sign back in via Microsoft → confirm avatar + name in header
- [ ] Sign in as a bulk-imported 2nd user from a different machine/browser
- [ ] Exchange a chat message + a phone call between the two
- [ ] As admin: promote 2nd user to admin → confirm AuditLog entry
- [ ] Try to demote self → confirm last-admin safeguard
- [ ] **#172** Full pilot smoke test with a real 2nd ApTask user end-to-end

---

## Pre-scale infrastructure (when we cross ~30 concurrent or get a compliance ask)

- [ ] **Task #181** Bump Render: Hobby → Pro workspace + Standard compute for socket service
- [ ] **Task #183** Provision Render Key Value (Redis) + wire Socket.IO Redis adapter
- [ ] **Task #184** Telnyx webhook hardening: HMAC verify + BullMQ queue + idempotency keys
- [ ] **Task #186** Upgrade Vercel Hobby → Pro
- [ ] **Task #187** Verify Telnyx WebRTC vs SIP pricing model (does it stack?)
- [ ] **Task #185** Replace 15s polling with real-time push (Postgres LISTEN/NOTIFY or Realtime equivalent on new Postgres provider)
- [ ] **Task #140** Wire socket.io for instant chat push (kill 6s polling)
- [ ] **Task #194** Windows code-signing (EV or OV cert, ~$200/yr) — defer to GA
- [ ] **Future** Full silent auto-update via `electron-updater` (publish `latest.yml` to GitHub Releases, app downloads + installs in background, prompts restart). Current banner is the stop-gap.

---

## Open follow-ups (no specific timeline)

- [ ] **Task #158** Custom busy greeting (blocked on Telnyx engineering escalation)
- [ ] **Task #151** Update DATABASE_URL on Render webhooks service (after Postgres provider switch)
- [ ] Migrate voicemail/MMS storage from Supabase Storage to Cloudflare R2 (after Postgres provider switch)
- [ ] Settings → Profile picture upload (currently just initials gradient)
- [ ] Per-user call recording opt-in (compliance / consent)

---

## Bonus items completed today (not originally in plan)

- [x] **Recents dedupe** — `STATUS_RANK` + `dedupeCallLegs()` helper in `calls.routes.ts`; one row per session, status-ranked
- [x] **Internal chat frontend** — `Chat.tsx` (418 lines) + 6th bottom-nav tab + unread badge
- [x] **CSS rescue** — fixed truncated `.audio-picker-label` that was killing all styles past line 3603
- [x] **CORS reflect-origin** — supports `file://` Electron pages (Origin: null) without dropping browser security
- [x] **Cross-platform native binaries** — `optionalDependencies` for rollup (linux/darwin/win32) + dmg-license (macOS only)
- [x] **Vercel build fix** — added all 4 rollup platform binaries so Linux build server works

---

## Versioning convention going forward

- **PATCH** (0.6.0 → 0.6.1): bug fixes, small additive UI like the update banner
- **MINOR** (0.6.x → 0.7.0): new user-facing features (admin panel, bulk import, etc.)
- **MAJOR** (0.x → 1.0): GA launch
- Bump the version in `apps/web/package.json`, `apps/desktop/package.json`, root `package.json`, AND `apps/api/src/main.ts` on every push that changes behaviour. The Vite-injected `__APP_VERSION__` is what the header reads.

## How to use this file

1. As we finish each item, mark it `[x]`.
2. Strike through descoped items `~~like this~~` and add the replacement below.
3. When all of today's phases are checked, ping me with "ready for tomorrow" and we'll pull the next phase forward.
4. New items I create during the day get appended at the bottom — review them and reorder if needed.
