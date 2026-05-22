# ACE Dialer — Working Checklist

**Last updated:** 2026-05-22
**Current version (committed):** v0.8.6
**Owner:** Abdulla (abdulla@aptask.com)
**Pilot target:** 150 total users, ~30–40 concurrent peak

---

## Today's wins (May 22)

- [x] **v0.7.2** Decline-with-message rebuild — 3rd button + decoupled sheet. **Verified working in production.**
- [x] **v0.7.3** Bulk-import CSV endpoint + UI + "Set SIP password" kebab action
- [x] **v0.7.3** New-user onboarding one-pager (PDF + MD source + rebuild script)
- [x] **v0.7.4** Live Ops Dashboard (admin-only Settings → Live ops)
- [x] **v0.7.4 published to GitHub Releases** — silent auto-update validated end-to-end
- [x] **CLAUDE.md** added at repo root — auto-loaded context for future sessions
- [x] **v0.7.5–7.6** User DID shown next to Online status pill; fixed TS ||/?? error in admin reports
- [x] **v0.8.0** Presence + Usage + Quality reporting dashboards
- [x] **v0.8.2** Fixed SIP "Connection Failed" race on login; manual "Check for updates" in user dropdown; Cost + Recruiter + Alerts dashboards
- [x] **v0.8.3** Friendly update-check error; Settings nav categorized into 4 collapsible groups (Personal · Calling · Reports · Admin)
- [x] **v0.8.4** Robust Recents dedupe — fixed "declined call shown 3 times" via proximity fallback + ringing/incoming status ranks
- [x] **v0.8.5** Hide scrollbars app-wide
- [x] **v0.8.6** Releases now publish as **real** (not draft) + serialize mac→windows CI — unblocks auto-update for everyone stuck below 0.6.1

---

## ⏳ Waiting on you

- [ ] **Pulse SQL CSV** — your team produces a CSV of email + names + sipUsername + didNumber for all 150 users. We pull it through bulk-import as soon as ready.
- [ ] **Telnyx Portal** — flip **Transcription** on under Hosted Voicemail Profile (5 min, no code, ~$0.05/min). Backend code already handles `transcription_text`.
- [ ] **Staged-rollout passwords** — as each user opts in to ACE Dialer, copy their SIP password from Telnyx Portal into Settings → Users → kebab → "Set SIP password (Telnyx)".

---

## Decisions made

- [x] **Auto-provision on first SSO** — invite-only
- [x] **Break-glass local-password accounts** — yes
- [x] **Installer code-signing** — Mac done. Windows deferred to GA.
- [x] **Admin panel surface** — visible on web AND desktop
- [x] **Bulk-import policy** — manual promotion only; no email notifications on invite (v1)
- [x] **Password migration strategy** — staged rollout, manual copy from Telnyx Portal as each user migrates (no mass password reset)
- [ ] **Postgres provider** — Supabase Postgres in use today; user evaluating cheaper alternatives

---

## Phases 1–7 ✅ DONE

| Phase | Scope |
|---|---|
| 1 — Entra ID setup | App registered, redirect URIs, secrets on Render |
| 2 — SSO backend | `@azure/msal-node`, AuditLog table, nullable passwordHash |
| 3 — Web Login UI | "Sign in with Microsoft" + PKCE for Electron |
| 4 — Polish + Electron + Installers | Signed Mac .dmg + Windows .exe in CI |
| 4.5 — Daily polish | Universal favorites sync, block buttons, favorite-name everywhere |
| 5 — Bulk import (#189) | `POST /admin/users/bulk-import` + CSV upload UI, ready for the Pulse CSV |
| 6 — Admin panel | Users table + kebab actions + Invite + Audit log (admin-gated) |
| 7 — Update infrastructure | Update banner + electron-updater + GH Releases publishing |
| 7.5 — Decline-with-message | 3rd button + post-decline sheet ✅ verified live |

---

## Phase 8 — Admin reporting (mostly done)

- [x] **#204** Live Ops Dashboard P0 — at-a-glance cards, hourly chart, top callers, recent missed. Auto-refreshes 15s. *v0.7.4*
- [x] **#205** Usage & volume reports (P1) — leaderboards, line charts, per-user drill-down, response rates. *v0.8.0*
- [x] **#206** Quality & health reports (P1) — missed-rate, sub-10s calls, hangup-cause pie, peak-hours heatmap. *v0.8.0*
- [x] **#207** Telnyx cost reporting (P1) — per-DID minutes, per-user spend, SMS segments, monthly projection. *v0.8.2*
- [x] **#208** Recruiter metrics (P2) — candidate reach, conversation rate, JobDiva coverage. *v0.8.2*
- [x] **#210** Health alerts (P3) — idle users, offline-during-business-hours, missed-call spikes. *v0.8.2*
- [x] **#211** Presence/Agent dashboard (who's on call now). *v0.8.0*
- [ ] **#209** Export + scheduled digests (P2) — CSV/Excel export, weekly admin email, Slack webhook

---

## Phase 6b — Telnyx auto-provisioning (deferred)

- [ ] **#166** Telnyx API investigation (sub-credential create, DID purchase, voicemail config)
- [ ] **#167** Add Telnyx orchestration to `POST /admin/users` (with rollback)
- [ ] **#169** CLI fallback `scripts/provision-user.mjs`

---

## ✅ Smoke-test results (v0.7.4 → v0.8.6)

### Header + version
- [x] Header shows current version + Desktop/Web tag
- [x] v0.7.5+ also shows user's DID number next to Online status pill

### Auto-update (#199)
- [x] v0.7.4 published to GH Releases successfully (after one transient Mac CDN retry)
- [x] Installed v0.7.1+ apps detected v0.7.4 and prompted "Restart to install" via UpdateBanner
- [x] Restart-to-install flow worked — app relaunched as v0.7.4
- [x] **Manual "Check for updates" menu item** added to user dropdown (v0.8.2)
- [x] **Friendly error** on update-check 404 instead of raw stack trace (v0.8.3)
- [x] **v0.8.6 critical fix VERIFIED:** releases now publish as real (not draft). Old drafts (v0.7.5 – v0.8.5) cleaned up. v0.8.6 live on GitHub Releases as the Latest tag. Users on 0.6.1 → 0.8.5 will now auto-update on next poll.

### Favorites sync (#195)
- [x] Star on Mac → appears on Windows after sign-in (server-side, not localStorage)

### Block buttons (#159 follow-up)
- [x] Ban icon on Recents row → confirm → row's Block button hides for session
- [x] Ban icon on Messages thread header → red "Blocked" badge replaces button
- [x] Settings → Blocked numbers shows the entry

### Favorite name everywhere (#161)
- [x] Recents, IncomingCall, InCall, Messages list + detail, Voicemail row + filter banner, **Dialpad contacts quick-pick** — all surfaces show favorite name when set

### Admin Users panel (#168, #178, #179, #180, #200)
- [x] Settings → Users loads the table
- [x] Invite new user works
- [x] Promote/Demote/Activate/Deactivate via kebab menu work
- [x] Safeguards: can't change own admin, can't deactivate self, can't demote last admin
- [x] Settings → Audit log shows every action with before/after diff

### Decline-with-message (#201 rebuild)
- [x] Full-screen IncomingCall shows 3 buttons: red Decline · amber Reply · green Accept
- [x] Tap Reply → call hangs up immediately → bottom sheet slides up with quick replies + custom text
- [x] Pick a reply → caller gets SMS from your DID → success card → auto-closes
- [x] "Skip — don't send anything" works
- [x] Hidden during Hold & Accept (already 3 buttons)

### Bulk import (#189)
- [ ] Run dry-run preview with sample CSV (10-row test set first) — pending Pulse CSV
- [ ] Full 150-user import — pending Pulse CSV

### Live Ops Dashboard (#204) + 6 reporting dashboards
- [x] Live Ops, Presence, Usage, Quality, Cost, Recruiter, Alerts — all built and reachable from Settings (admin-only)
- [ ] Dashboards need real call volume to show meaningful numbers — comes with #189 bulk import

### Voicemail transcription (#203)
- [ ] Flip "Transcription" on in Telnyx Portal under Hosted Voicemail Profile
- [ ] Get a voicemail → expand row → transcript appears

### UX polish shipped
- [x] **v0.8.3** Settings nav categorized into 4 collapsible groups (Personal · Calling · Reports · Admin) — no more giant scrolling list
- [x] **v0.8.4** Recents dedupe no longer shows "declined" 3× for the same call (proximity fallback + ringing/incoming ranks)
- [x] **v0.8.5** Scrollbars hidden app-wide for chat-app feel
- [x] **v0.8.2** SIP "Connection Failed" race on login fixed — no more forced Ctrl+Shift+R workaround

---

## Pre-scale infrastructure (when we cross ~30 concurrent or hit a compliance ask)

- [ ] **#181** Render Hobby → Pro workspace + Standard compute
- [ ] **#183** Render Key Value (Redis) + Socket.IO Redis adapter
- [ ] **#184** Telnyx webhook hardening (HMAC verify + BullMQ + idempotency)
- [ ] **#185** Replace 15s polling with real-time push
- [ ] **#186** Vercel Hobby → Pro
- [ ] **#187** Verify Telnyx WebRTC vs SIP pricing model
- [ ] **#140** socket.io for instant chat push
- [ ] **#194** Windows code-signing (EV cert ~$300/yr) — deferred to GA

---

## Open follow-ups (no specific timeline)

- [ ] **#158** Custom busy greeting (blocked on Telnyx engineering)
- [ ] **#151** DATABASE_URL on Render webhooks service (after Postgres provider switch)
- [ ] **#202** Local presence — pick "calling from" DID per call (multi-DID picker)
- [ ] **#172** Full pilot smoke test with a real 2nd user (after Pulse CSV import)
- [ ] **#209** Reporting: Export + scheduled digests (CSV/Excel export, weekly admin email, Slack webhook)
- [ ] **Postgres migration** — evaluate moving off Supabase to dedicated Postgres (analysis done, awaiting decision on target provider)
- [ ] Migrate voicemail/MMS storage from Supabase Storage to Cloudflare R2
- [ ] Settings → Profile picture upload
- [ ] Per-user call recording opt-in (consent)
- [ ] Floating ringer window (Electron): add Reply button too — currently only Accept/Decline

---

## Versioning convention

- **PATCH** (0.7.0 → 0.7.1): bug fixes, small additive UI
- **MINOR** (0.7.x → 0.8.0): new user-facing features
- **MAJOR**: GA launch
- Bump in `apps/web/package.json`, `apps/desktop/package.json`, root `package.json`, AND `apps/api/src/main.ts` on every push.

## How to use this file

1. Mark `[x]` as items finish.
2. Strike through descoped items `~~like this~~`.
3. New items get appended at the bottom — review and reorder if needed.
4. **Always update this file when versions ship** so we know where we are.
