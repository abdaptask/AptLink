# CLAUDE.md — context for AI sessions

> This file is auto-loaded by Claude at the start of every session in this repo.
> Update it whenever conventions change. Keep it scannable, not exhaustive.

## What this is

**ACE Dialer 2.0** — a Telnyx + JsSIP WebRTC softphone replacing ApTask's internal Pulse system. Pilot target: 150 total users, ~30–40 concurrent peak. Owner: abdulla@aptask.com.

For the current state of work in progress and the day-by-day plan, see [`ACE_DIALER_TODO.md`](./ACE_DIALER_TODO.md). That file is the single source of truth for "what's done / what's next" — always check it before starting work.

## Architecture (monorepo, npm workspaces)

```
acedialerv4/
├── apps/
│   ├── api/         Fastify REST API — auth, calls, messages, voicemails,
│   │                blocked, favorites, internal-chat, admin/users, audit-log
│   ├── desktop/     Electron wrapper — system tray, floating ringer,
│   │                ace-dialer:// protocol, electron-updater
│   ├── socket/      Socket.IO service (Phase 8, not yet wired up)
│   ├── web/         Vite + React 18 + TypeScript SPA — the actual dialer UI
│   └── webhooks/    Telnyx webhook receiver (separate Render service)
├── packages/
│   └── db/          Prisma client + schema, shared with apps/api + apps/webhooks
├── .github/workflows/build-desktop.yml   Mac (.dmg) + Win (.exe) installers
└── ACE_DIALER_TODO.md                    Living checklist + tomorrow plan
```

**The web app is bundled INTO the desktop installer** via `electron-builder`'s `extraResources` config. Electron loads `apps/web/dist/index.html` from `process.resourcesPath/web/` at runtime via `file://`. This means web bundle changes ship to desktop ONLY via a new installer build.

## Deploy targets

| Service           | Provider | Trigger                          | Notes |
|-------------------|----------|----------------------------------|-------|
| API               | Render   | push to `main`                   | Reads `version` from `apps/api/src/main.ts` — bump it on every release |
| Web app           | Vercel   | push to `main`                   | Reads version from `apps/web/package.json` via `__APP_VERSION__` Vite define |
| Webhooks          | Render   | push to `main`                   | Separate service from `api` (different DATABASE_URL setup historically) |
| Desktop installers| GH Actions | push to `apps/desktop/**`, `apps/web/**`, or workflow file | Uses `electron-builder --publish always` → uploads `.dmg`, `.exe`, `latest.yml`, `blockmap` to a tagged `vX.Y.Z` GH Release |

**electron-updater polls the GH Releases endpoint** every 60 min once installed, downloads the new installer silently, prompts "Restart to install" via in-app banner.

## Versioning convention — IMPORTANT

When making a release, **always bump version in ALL FOUR places, same value**:

1. `package.json` (root)
2. `apps/web/package.json`
3. `apps/desktop/package.json`
4. `apps/api/src/main.ts` (the `version: 'X.Y.Z'` string in the `/` endpoint)

A single-line bash that works on Linux/Mac:
```bash
NEW=0.7.3 && \
  sed -i "s/\"version\": \"[0-9.]*\"/\"version\": \"$NEW\"/" \
    package.json apps/web/package.json apps/desktop/package.json && \
  sed -i "s/version: '[0-9.]*'/version: '$NEW'/" apps/api/src/main.ts
```

- **PATCH** (0.7.0 → 0.7.1): bug fixes, small additive UI
- **MINOR** (0.7.x → 0.8.0): new user-facing features
- **MAJOR**: GA launch

## Critical workflow patterns

### Push flow (after editing)

```powershell
# Windows / PowerShell — Abdulla's dev machine
cd C:\Users\asheikh\Documents\Claude\Projects\Dialer\acedialerv4
Remove-Item .git\index.lock -ErrorAction SilentlyContinue
git add <changed paths>
git commit -m "vX.Y.Z: short summary"
git push origin main
```

Stale `index.lock` files are common after interrupted git commands — always preemptively delete it.

### Never commit these (already in `.gitignore`)

- `apps/desktop/release/` — local installer build output (172 MB+ binaries; GH rejects files >100 MB)
- `packages/db/.env` — has `DATABASE_URL` with prod creds
- `node_modules/`
- `*.tsbuildinfo`

### Editing files

The Cowork harness's `Edit` tool sometimes truncates files on FUSE-mounted folders (this repo lives there). Symptoms: `TS17008: JSX element has no corresponding closing tag` on a previously-fine file. **Fix:** restore from HEAD and re-apply via Python heredoc with atomic write:

```python
import os
def atomic_write(path, content):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(content)
    os.replace(tmp, path)
```

For multi-line patches on important files, prefer Python `str.replace()` + atomic write over the Edit tool.

## Database

- **Provider:** Supabase Postgres (pooled connection at `aws-1-us-east-1.pooler.supabase.com:5432`)
- **Schema:** `packages/db/prisma/schema.prisma`
- **Apply schema changes:** `npm run db:push -w packages/db` (uses `prisma db push --accept-data-loss` in CI)
- **Prisma Studio** for ad-hoc edits: `cd packages/db && npx prisma studio` (needs `DATABASE_URL` env var — put it in `packages/db/.env` once, never deal with it again)
- **DATABASE_URL** lives on:
  - Render → `ace-dialer-api` → Environment
  - Render → `ace-dialer-webhooks` → Environment (may need updating after provider switches — see #151)
  - Local: `packages/db/.env` (not committed)

### Admin bootstrap chicken-and-egg

The user table starts with `isAdmin = false` for SSO-created accounts. To promote the very first admin, flip the bit in Prisma Studio — see the "Open packages/db/.env" pattern above.

## Telnyx config

- **SIP Connection:** WebRTC, registered against `sip.telnyx.com:7443` (WSS)
- **Per-user SIP credentials:** stored in `User.sipUsername` + `User.sipPassword` (yes, password in plaintext — Telnyx requires the actual password to register from the client)
- **DIDs:** one per user in `User.didNumber` (E.164)
- **Webhook URL:** points at `apps/webhooks` Render service
- **Call Control:** SIP Connection is linked to a Call Control App; `Call.callControlId` populated by webhook on first event
- **Hosted Voicemail Profile:** drives voicemail capture; **transcription is a portal toggle** — when on, webhook payload includes `transcription_text` which the code already handles

## Microsoft SSO (Entra ID)

- **App registration:** `ACE Dialer` in https://portal.azure.com (Single tenant)
- **Redirect URIs:**
  - Web: `https://acedialerv4-web.vercel.app/auth/microsoft/callback`
  - Electron: `ace-dialer://auth/callback` (Public client / native)
- **Backend uses `@azure/msal-node`:**
  - `ConfidentialClientApplication` for the web redirect (with secret)
  - `PublicClientApplication` for the Electron redirect (PKCE flow, no secret — Azure rejects the secret on public-client redirects)
- **Env vars:** `MS_CLIENT_ID`, `MS_TENANT_ID`, `MS_CLIENT_SECRET` on Render
- **New users:** Azure provisions on first sign-in; we create a `User` row with `azureOid` populated and `isAdmin = false`

## Auto-update (electron-updater)

- Polls `https://github.com/abdaptask/acedialerv4/releases/latest.yml` every 60 min
- Downloads new installer in background
- Sends IPC events to renderer: `ace:update-available`, `ace:update-progress`, `ace:update-downloaded`
- `UpdateBanner.tsx` listens; when downloaded, shows "Restart to install" → user clicks → `autoUpdater.quitAndInstall()` → installer runs → app relaunches
- **Mac requires signed + notarized builds for auto-update to work** — already configured. Windows works regardless.

## Code-signing

- **Mac (DONE):** Apple Developer Program enrolled. Developer ID Application cert in GH secrets (`APPLE_CSC_LINK`, `APPLE_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). `entitlements.mac.plist` at `apps/desktop/` root (NOT in gitignored `build/`). Notarization on by default.
- **Windows (DEFERRED):** SmartScreen "Windows protected your PC" appears on first install of each version. Pilot users click "Run anyway". Revisit at GA: SSL.com EV @ ~$300/yr, cloud-based signing.

## Auth & sessions

- **JWT** in `sessionStorage` as `ace_token`
- **`sessionGuard`** intercepts 401 responses globally and redirects to `/login`
- **SIP creds** also in sessionStorage: `ace_sip_username`, `ace_sip_password`, `ace_did`
- **Favorites** are server-side now; in-memory cache hydrated on login (see `apps/web/src/lib/userPrefs.ts`)

## Key files to read first when starting a new task

| Task type | Read first |
|-----------|------------|
| Backend endpoint | `apps/api/src/main.ts` (routes registered here) + the matching `apps/api/src/<feature>/<feature>.routes.ts` |
| Frontend page | `apps/web/src/pages/Layout.tsx` (nav) + `apps/web/src/pages/<Page>.tsx` |
| Settings section | `apps/web/src/pages/Settings.tsx` — `SECTIONS` array drives the nav; add an entry + component at the end |
| DB schema | `packages/db/prisma/schema.prisma` |
| Telnyx integration | `apps/webhooks/src/main.ts` (event handler) + `apps/api/src/calls/calls.routes.ts` (CC API client) |
| Electron main | `apps/desktop/src/main.ts` + `apps/desktop/src/preload.ts` (bridge to renderer) |

## Conventions

- **No unsolicited README.md / docs files** unless asked
- **Server-side enforcement, UI-side hint** — never rely on hiding a button for security. Always gate at the API route too
- **AuditLog every admin action** — every mutation in `apps/api/src/admin/admin.routes.ts` writes a row
- **Optimistic UI for low-stakes mutations** (favorites, blocked-numbers) — update local cache immediately, fire-and-forget the API call
- **JSON in audit metadata:** Prisma's `Json?` column doesn't accept bare `null`; coerce to `undefined` or use `Prisma.JsonNull`
- **Per-session dismissal** for banners (update banner, post-decline reply): key the dismiss flag by version/event so a new instance re-shows

## Code Changes

Do not make any changes until you have 95% confidence in what you need to build. Ask me follow up questions until you reach that confidence
