# ACE Dialer 2.0

ApTask's in-house softphone replacing the dialer features of Pulse. WebRTC-based,
runs in a browser tab or a packaged Electron desktop app. Calls + SMS via Telnyx,
voicemail transcription via Deepgram, Microsoft Teams notifications via Power
Automate, Microsoft SSO via Entra ID.

**Current release:** v0.10.8 (May 28, 2026)

## Quick links

- **[Features](docs/features.md)** — full list of what users get
- **[User onboarding](docs/user-onboarding.md)** — share with new users on day one
- **[Admin runbook](docs/admin-runbook.md)** — add users, manage DIDs, watch logs, troubleshoot
- **[Changelog](docs/changelog.md)** — per-release notes from v0.10.0 onward
- **[Welcome email template](docs/email-template.md)** — what new users receive when invited
- **[Multi-user setup notes](docs/multi-user-setup.md)** — legacy doc from Phase 5.7, kept for historical context
- **[Telnyx setup notes](docs/telnyx-call-control-setup.md)** — initial Telnyx connection wiring

## Architecture

Monorepo with four Node.js (TypeScript) services + one Electron desktop app:

| Workspace | What it does | Hosted |
| --- | --- | --- |
| `apps/api` | HTTP API — auth (MS SSO + password), users, calls, messages, voicemails, admin, /me endpoints | Render |
| `apps/socket` | Real-time WebSocket — chat events, call-state fan-out | Render |
| `apps/webhooks` | Telnyx webhook receiver — call.*, message.*, voicemail.* events; fires Teams notifications | Render |
| `apps/web` | React + Vite SPA — the dialer UI | Vercel |
| `apps/desktop` | Electron wrapper around the web app — auto-update + tray + custom protocol handler | GitHub Releases |
| `packages/db` | Prisma schema + migrations + generated client | shared |

Database: Supabase Postgres. Voice/SMS: Telnyx (Credential Connections per user,
single Messaging Profile, TexML for inbound voicemail). Auth: Microsoft Entra ID
(via MSAL + PKCE) + break-glass local password for admin. TURN: Cloudflare for
India users; Telnyx default elsewhere.

## Local development

Requires Node.js 20+.

```bash
npm install

# regenerate Prisma client + DB types (run after schema changes)
npm run db:generate

# four services, four terminals
npm run dev -w apps/api        # HTTP API on http://localhost:3001
npm run dev -w apps/socket     # WebSocket on http://localhost:3002
npm run dev -w apps/webhooks   # Telnyx webhooks on http://localhost:3003
npm run dev -w apps/web        # Vite dev server on http://localhost:5173

# Electron desktop pointed at local Vite
cd apps/desktop
npm run dev   # opens with VITE_DEV_SERVER_URL=http://localhost:5173
```

`apps/web/.env` controls which API URL the web client talks to in dev. The
example points at the production API (`https://ace-dialer-api.onrender.com`);
change to `http://localhost:3001` if you're running the API locally.

## Deployment

| Push to | What deploys |
| --- | --- |
| `main` (any change) | Vercel rebuilds `acedialerv4-web.vercel.app` |
| `main` (apps/api or packages/db) | Render rebuilds `ace-dialer-api` |
| `main` (apps/webhooks or packages/db) | Render rebuilds `ace-dialer-webhooks` |
| `main` (apps/socket or packages/db) | Render rebuilds `ace-dialer-socket` |
| `v*` tag | GitHub Actions builds + publishes desktop installers to GitHub Releases |

There is **no staging environment** — main is production for web, API, webhooks.
Desktop releases are gated behind the `v*` tag push, so the desktop side can
lag behind web/API if you don't tag.

## Environment variables

Set per-service on Render's dashboard. The `.env.example` files in each app are
the canonical list of supported vars. Critical ones:

| Service | Var | Purpose |
| --- | --- | --- |
| api, webhooks | `DATABASE_URL` | Supabase Postgres connection string |
| api | `JWT_SECRET` | Signs the user JWT tokens |
| api | `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID` | MS SSO |
| api | `MICROSOFT_CLIENT_SECRET` | MS SSO confidential client secret |
| api | `JOBDIVA_*` | JobDiva contact lookup |
| api, webhooks | `TELNYX_API_KEY` | Voice/SMS calls + audio fetch |
| api, webhooks | `TEAMS_TENANT_WEBHOOK_URL` | Tenant-wide Power Automate flow URL |
| api, webhooks | `WEB_BASE_URL` | Vercel URL (used in Teams card deep-links) |
| webhooks | `DEEPGRAM_API_KEY` | Voicemail transcription |
| webhooks | `PILOT_TELNYX_NUMBER` | Fallback DID when webhook event can't be routed |
| webhooks | `PILOT_USER_ID` | Fallback userId for unroutable events |

## Project Status

**Phase 0–6:** Foundation, multi-user, MS SSO, JobDiva, voicemail, blocking,
Pulse migration tooling — all complete.

**Phase 7 — Pillar 1 + 2 (v0.10.0–v0.10.8):** Multi-DID support, Teams
notifications, voicemail playback page, Electron deep-link handlers. **Shipped.**

**Next phases:**

- **Pillar 3 — Ring Groups** (multi-agent inbound routing)
- **Pillar 4 — IVR** (caller-selected DTMF routing)

See `docs/features.md` for the full capability list.
