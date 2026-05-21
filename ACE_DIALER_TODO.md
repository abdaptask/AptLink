# ACE Dialer — Working Checklist

**Last updated:** 2026-05-21
**Owner:** Abdulla (abdulla@aptask.com)
**Pilot target:** 150 total users, ~30–40 concurrent peak

Check items off as we complete them. New items get appended at the bottom. Items in *italics* are blocked on a decision or external dependency.

---

## Decisions needed today (before code starts)

- [ ] **Postgres provider** — Neon ($19/mo Scale, autoscaling, branching) **or** Render Postgres ($19/mo, same datacenter)?
- [ ] **Auto-provision on first SSO** — when an `@aptask.com` employee signs in for the first time, auto-create their dialer account **or** require admin invite first?
  - *Recommended:* require invite (controls DID cost)
- [ ] **Break-glass local-password accounts** — keep yours + one backup admin with password login as a fallback when Entra ID is down? (yes/no)
  - *Recommended:* yes
- [ ] **Installer code-signing** — purchase Windows + Mac certs (~$200/yr each) **or** accept SmartScreen warning for pilot, revisit at GA?
  - *Recommended:* defer for pilot

---

## Phase 1 — Entra ID setup (you, ~30 min)

- [ ] Sign in to https://portal.azure.com as ApTask admin
- [ ] Navigate: Entra ID → App Registrations → New registration
- [ ] Name the app: `ACE Dialer`
- [ ] Supported account types: **Accounts in this organizational directory only (Single tenant)**
- [ ] Redirect URI #1 (Web): `https://ace-dialer.vercel.app/auth/microsoft/callback`
- [ ] Redirect URI #2 (Public client/native): `ace-dialer://auth/callback`
- [ ] Register the app
- [ ] Copy and save: **Application (client) ID**
- [ ] Copy and save: **Directory (tenant) ID**
- [ ] Certificates & secrets → New client secret → 24 months → copy and save the **Value** (not the ID)
- [ ] API permissions → ensure these are granted: `openid`, `profile`, `email`, `User.Read`
- [ ] Add these three values to Render's `ace-dialer-api` env vars: `MS_CLIENT_ID`, `MS_TENANT_ID`, `MS_CLIENT_SECRET`

---

## Phase 2 — Schema + SSO backend (Claude, ~3 hr)

- [ ] Prisma migration: `User.passwordHash` → nullable
- [ ] Prisma migration: add `User.azureOid` (unique, nullable string)
- [ ] Prisma migration: add `User.provider` enum (`'local' | 'microsoft'`, default `'microsoft'`)
- [ ] Prisma migration: create `AuditLog` table (id, actorUserId, action, targetUserId, metadata jsonb, createdAt)
- [ ] Run migration locally + on Render
- [ ] Install `@azure/msal-node` in `apps/api`
- [ ] Build `GET /auth/microsoft/start` — returns Microsoft auth URL with state token
- [ ] Build `GET /auth/microsoft/callback` — exchanges code → validates id_token JWT → looks up/creates User row → mints our JWT
- [ ] Verify state-token CSRF protection works
- [ ] Test against Entra ID from local dev

---

## Phase 3 — Login UI + Electron deep-link (Claude, ~2 hr)

- [ ] Rewrite `apps/web/src/pages/Login.tsx` — primary "Sign in with Microsoft" button
- [ ] Add small "Sign in with password" link below (visible only if break-glass enabled)
- [ ] Wire button → `GET /auth/microsoft/start` → redirect
- [ ] Handle callback redirect → store JWT → route to `/keypad`
- [ ] Electron: `app.setAsDefaultProtocolClient('ace-dialer')` in `apps/desktop/src/main.ts`
- [ ] Electron: handle `open-url` event (Mac) + second-instance argv parsing (Windows) to catch `ace-dialer://auth/callback?code=...`
- [ ] Electron: hand the code to the renderer via IPC, renderer posts to backend, gets JWT

---

## Phase 4 — Admin Users panel (Claude, ~3 hr)

- [ ] Backend: `GET /admin/users` (list all users, admin-only)
- [ ] Backend: `PATCH /admin/users/:id` accepts `{ isAdmin?, isActive? }`
- [ ] Backend: last-admin safeguard (cannot demote self if `isAdmin && count(admins) === 1`)
- [ ] Backend: every successful change writes an `AuditLog` row
- [ ] Frontend: new `Settings → Users` section gated on `user.isAdmin`
- [ ] Frontend: table of users with status (active, last seen, admin badge, DID)
- [ ] Frontend: 3-dot menu per row — Make admin / Remove admin / Deactivate / Reset password
- [ ] Frontend: confirmation modal for promote/demote actions
- [ ] Frontend: "Invite User" button (stub for today — full wiring lands tomorrow)

---

## Phase 5 — Smoke test today's work (you, ~30 min)

- [ ] Pull latest, run `npm install` in repo root, verify web build compiles
- [ ] Push to GitHub, wait for Vercel + Render redeploy
- [ ] Sign out of dialer
- [ ] On Login page, see "Sign in with Microsoft" button
- [ ] Click it → redirected to Microsoft login
- [ ] Sign in with your `@aptask.com` account → redirected back to dialer at `/keypad`
- [ ] Confirm avatar + name in top-right header shows your O365 profile
- [ ] Manually insert a 2nd test user row via Render's Postgres console (we'll automate this in Phase 7 tomorrow)
- [ ] Sign that user in via Microsoft from a private window
- [ ] Open Chat tab → start conversation with your primary account
- [ ] Confirm both sides see the message within ~6 sec
- [ ] As primary admin, go to Settings → Users → make the 2nd user an admin → confirm AuditLog entry written
- [ ] Try to demote yourself → confirm UI blocks it with "last admin" warning

---

## Tomorrow (May 22) — Full provisioning + installers

- [ ] **Task #166** Investigate Telnyx API: sub-credentials, DID purchase + assign, voicemail config endpoint
- [ ] **Task #167** `POST /admin/users` orchestration: create User row + Telnyx SIP creds + assign DID + enable voicemail + send invite email (or display credentials)
- [ ] **Task #168** Wire "Invite User" button to real provisioning endpoint
- [ ] **Task #169** CLI fallback: `node scripts/provision-user.mjs --email=... --first=... --last=...`
- [ ] **Task #170** Add Windows `.exe` build to GitHub Actions (electron-builder `--win`)
- [ ] **Task #171** Write new-user one-pager (PDF): Install → Open → Sign in with Microsoft → Done
- [ ] **Task #180** Audit Log viewer page in Settings (read-only)
- [ ] **Task #172** Full pilot smoke test with a real 2nd ApTask user end-to-end

---

## Pre-scale infrastructure (when we cross ~30 concurrent or get a compliance ask)

- [ ] **Task #181** Bump Render: Hobby → Pro workspace + Standard compute for socket service
- [ ] **Task #183** Provision Render Key Value (Redis) + wire Socket.IO Redis adapter
- [ ] **Task #184** Telnyx webhook hardening: HMAC verify + BullMQ queue + idempotency keys
- [ ] **Task #186** Upgrade Vercel Hobby → Pro
- [ ] **Task #187** Verify Telnyx WebRTC vs SIP pricing model (does it stack?)
- [ ] **Task #185** Replace 15s polling with real-time push (Postgres LISTEN/NOTIFY or Realtime equivalent on new Postgres provider)
- [ ] **Task #140** Wire socket.io for instant chat push (kill 6s polling)

---

## Open follow-ups (no specific timeline)

- [ ] **Task #158** Custom busy greeting (blocked on Telnyx engineering escalation)
- [ ] **Task #151** Update DATABASE_URL on Render webhooks service (after Postgres provider switch)
- [ ] "Block this number" buttons on Recents rows + Messages thread headers (from #159 follow-up)
- [ ] Migrate voicemail/MMS storage from Supabase Storage to Cloudflare R2 (after Postgres provider switch)
- [ ] Settings → Profile picture upload (currently just initials gradient)
- [ ] Per-user call recording opt-in (compliance / consent)

---

## How to use this file

1. As we finish each item, mark it `[x]`.
2. If a task gets descoped or replaced, strike it through `~~like this~~` and add the replacement below.
3. When all of today's phases are checked, ping me with "ready for tomorrow" and we'll pull the next phase forward.
4. New items I create during the day get appended at the bottom — review them and reorder if needed.
