# ACE Dialer — Working Checklist

**Last updated:** 2026-05-21 (late evening)
**Current version (working tree):** v0.7.0
**Owner:** Abdulla (abdulla@aptask.com)
**Pilot target:** 150 total users, ~30–40 concurrent peak

---

## Decisions made

- [ ] **Postgres provider** — Neon ($19/mo Scale) or Render Postgres ($19/mo)? *User sourcing cheaper elsewhere.*
- [x] **Auto-provision on first SSO** — **invite-only**
- [x] **Break-glass local-password accounts** — yes, abdulla@aptask.com keeps password fallback
- [x] **Installer code-signing** — Mac done. Windows deferred to GA.

---

## Phases 1–4 ✅ DONE
Entra ID setup · Schema + SSO backend · Login UI · Polished Login + Electron deep-link + Signed-and-notarized .dmg + Windows .exe in CI

## Phase 4.5 — Daily polish (#159, #161, #195, #196) ✅ DONE
Block buttons on Recents + Messages · Favorite name in Recents/IncomingCall/InCall/Messages/Voicemail/Dialpad-quickpick · **Favorites synced server-side via /favorites API** · Version bump 0.4.0 → 0.6.0 → 0.6.1

## Phase 5 (postponed per user — pull when ready)
- [ ] **#189** CSV bulk-import existing 150 Telnyx-assigned users
- [ ] Telnyx Portal: export Credentials tab + join with Entra emails

## Phase 6 — Admin Users panel ✅ DONE
- [x] **#168 + #178 + #179** GET/POST/PATCH /admin/users + frontend table + safeguards (last-admin guard, no self-toggle, no self-deactivate)
- [x] **#180** GET /admin/audit-logs + read-only viewer in Settings
- [x] **#200** Invite-user modal with optional Advanced (paste Telnyx creds + local password)
- [ ] **#166** Telnyx API investigation (sub-credential create, DID purchase, voicemail config)
- [ ] **#167** Add Telnyx orchestration to POST /admin/users with rollback (blocked on #166)
- [ ] **#169** CLI fallback `scripts/provision-user.mjs` (defer)
- [ ] **#171** New-user onboarding one-pager PDF (defer)

## Phase 7 — Update infrastructure (#197, #198, #199) ✅ DONE
- [x] **#197** In-app "Update available" banner (polls API every 15 min)
- [x] **#198** GitHub Actions publishes versioned releases (electron-builder + softprops)
- [x] **#199** `electron-updater` wired for silent download + restart-to-install
- [x] CI uses `electron-builder --publish always` → uploads latest.yml + blockmap + installers to GH Release
- [x] Bump 0.6.1 → 0.7.0

## Phase 7.5 — User-requested QoL ← TODAY
- [x] **#201** **Reject incoming call with quick-reply SMS** — popover on inbound shows saved quick replies + custom-text input; declines AND sends SMS in one action
- [ ] **#202** **Local presence (pick "calling from" DID)** — new UserDid table + caller-id dropdown on Dialpad. Defer until #166 lands.
- [ ] **#203** **Voicemail transcription** — code already in webhook; flip "Transcription" on in Telnyx Portal under the Hosted Voicemail Profile. ~$0.05/min cost.

---

## Smoke-test checklist for v0.7.0 (after CI builds + you reinstall)

### Header + version
- [ ] Header chip shows **v0.7.0 · Desktop** (Mac) and **v0.7.0 · Desktop** (Windows)
- [ ] Web version (hard-refresh Vercel URL): **v0.7.0 · Web**

### Auto-update
- [ ] Push a no-op v0.7.1 (just bump versions) → wait ~10 min for CI → installed app shows "Update available — downloading…" pill within ~15 min of GH Release being live
- [ ] When download finishes, banner switches to "Update ready — Restart to install"
- [ ] Click Restart → app quits, installer runs, relaunches with v0.7.1 in header

### Favorites sync (#195)
- [ ] Sign in on Mac. Star a contact (e.g. the test 2nd user's number) → enter first/last name.
- [ ] Sign out on Mac. Sign in on Windows. Open Favorites tab. **Star should be there with the same name.**
- [ ] On Windows: rename the favorite. Switch to Mac, refresh Favorites. Name updated.
- [ ] On Mac: tap the star to unfavorite. Switch to Windows, refresh. Star gone.
- [ ] **Verify in DB:** Prisma Studio → Favorite table → row was created/updated/deleted.

### Block button (#159 follow-up)
- [ ] Recents → tap the Ban icon on any row → confirm prompt → "blocked" toast → Block button disappears from that row + every other row for the same number this session.
- [ ] Messages → open a thread → tap the Ban icon in the header → confirm → header shows red "Blocked" badge + Block button is hidden.
- [ ] Settings → Blocked numbers section → the number appears in the list.
- [ ] Have a 2nd phone call that blocked number's DID → call should drop instantly + show "Blocked" in your Recents (status_rank wins).

### Favorite name everywhere (#161)
- [ ] Favorite a contact named "Adam Test".
- [ ] Make/receive a call with that number → IncomingCall + InCall both show **Adam Test**, not the digits.
- [ ] Send/receive an SMS → Messages thread list + thread detail header both show **Adam Test**.
- [ ] Get a voicemail → Voicemail row + filter banner show **Adam Test**.
- [ ] Open Dialpad → tap the Contacts/recents button → quick-pick shows **Adam Test** on the row, formatted phone underneath.

### Admin Users panel (#168, #178, #179, #180, #200)
- [ ] Settings → **Users** appears in the nav.
- [ ] Table loads with at least your account; shows Role=Admin, Status=Active, DID, Last sign-in.
- [ ] Click "Invite user" → email-only invite works → new row appears at top with Role=User, Status=Active, no DID.
- [ ] Kebab menu on the new row: Promote to admin → confirm → role pill flips to "Admin" → row stays.
- [ ] Try to demote yourself → tooltip on disabled button explains why ("can't change your own role").
- [ ] Try to demote the new admin (now there are 2 admins). It works.
- [ ] Try to demote BOTH admins → second demote should fail with the last-admin error.
- [ ] Try to deactivate yourself → disabled.
- [ ] Reset/set local password on the test user → prompt accepts a new password → user can now sign in via the break-glass form too.
- [ ] Settings → **Audit log** → see all the actions you just took, with actor + target + before/after diff in the expanded JSON.

### Decline-with-message (#201)
- [ ] Have a phone call your DID → full-screen IncomingCall appears.
- [ ] Tap **"Reply with message"** pill above the Accept/Decline row → popover appears with your saved quick replies.
- [ ] Tap a quick reply → call hangs up immediately → caller receives an SMS from your DID with that text.
- [ ] Repeat with custom text in the input box → same behavior.
- [ ] Try with an internal SIP-URI call → "Reply" pill should NOT appear (only real phone numbers).

### Voicemail transcription (#203) — after Telnyx Portal flip
- [ ] Telnyx Portal → Voice → Programmable Voice → Hosted Voicemail Profile → enable Transcription.
- [ ] Have someone leave you a voicemail.
- [ ] Voicemail tab → expand the row → transcript appears under the audio player.
- [ ] No transcript = either Telnyx didn't transcribe it (short/silent) or webhook didn't deliver — check webhook logs.

---

## Pre-scale infrastructure (when we cross ~30 concurrent or get a compliance ask)

- [ ] **#181** Bump Render: Hobby → Pro workspace + Standard compute for socket service
- [ ] **#183** Provision Render Key Value (Redis) + Socket.IO Redis adapter
- [ ] **#184** Telnyx webhook hardening: HMAC verify + BullMQ queue + idempotency
- [ ] **#186** Upgrade Vercel Hobby → Pro
- [ ] **#187** Verify Telnyx WebRTC vs SIP pricing
- [ ] **#185** Replace 15s polling with real-time push
- [ ] **#140** socket.io for instant chat push
- [ ] **#194** Windows code-signing (EV/OV cert, ~$200/yr)

---

## Open follow-ups (no specific timeline)

- [ ] **#158** Custom busy greeting (blocked on Telnyx engineering)
- [ ] **#151** DATABASE_URL on Render webhooks (after Postgres provider switch)
- [ ] Migrate voicemail/MMS storage from Supabase Storage to Cloudflare R2
- [ ] Settings → Profile picture upload
- [ ] Per-user call recording opt-in (consent)

---

## Versioning convention

- **PATCH** (0.6.0 → 0.6.1): bug fixes, small additive UI
- **MINOR** (0.6.x → 0.7.0): new user-facing features
- **MAJOR** (0.x → 1.0): GA launch
- Bump in `apps/web/package.json`, `apps/desktop/package.json`, root `package.json`, AND `apps/api/src/main.ts` on every push.

## How to use this file

1. Mark `[x]` as items finish.
2. Strike through descoped items `~~like this~~`.
3. "Ready for tomorrow" pings me to pull the next phase forward.
4. New items get appended at the bottom — review and reorder if needed.
