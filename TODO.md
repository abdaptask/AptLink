# ACE Dialer — TODO

Living list of what's still open. Updated after each session.
See git log + ACE_DIALER_PROJECT.md changelog for what's already shipped.

---

## 🛑 BLOCKERS for pilot with real users (do these BEFORE inviting anyone)

- [ ] **Fix electron auto-update silent-failure** — currently the download bar
      hits 100% and nothing happens. Root cause: the renderer's UpdateBanner
      ignores the `'error'` phase from electron-updater. Likely cause of the
      silent failure is unsigned Windows installer failing the signature check.
      **First step:** open dialer → Ctrl+Shift+I → Console → look for any
      `[auto-update]` log line — that's the real error. Then either:
      - Surface the error in the banner so user knows something failed
      - Fall back to "Download installer manually" link
      - OR get Windows code-signing done (see Long-term) so the silent
        path actually works

  Until this is fixed, give pilot users this workaround:
  *Right-click ACE Dialer in system tray → Quit → relaunch from desktop
  shortcut → new version installs during launch.*

- [ ] **Verify Render env vars on the API service**:
  - `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` (verified sender)
  - `TELNYX_MESSAGING_PROFILE_ID` (otherwise SMS won't route to ACE for invited users)

- [ ] **Clean up test data** from yesterday's v0.9.0 dev test:
  ```sql
  DELETE FROM users WHERE email = 'abdulla+test1@aptask.com';
  DELETE FROM pending_users WHERE email = 'abdulla+test1@aptask.com';
  ```
  Telnyx Portal → Numbers → unassign `+17327221058`.
  SIP Connections → delete `abdullatest1-ace-*`.

---

## 🔴 During pilot (watch for these as you invite real users)

- [ ] **Pilot smoke-test with 1 real user, then 2-3 more** — invite a real
      ApTask employee through the v0.9.0 Pending Users tooling. Verify they
      can sign in via Microsoft, place a call, receive a call, send a text,
      receive a text, leave + retrieve voicemail.

- [ ] **Watch for "duplicate ringing" bug** — the warning email tells users
      to uninstall the old dialer first. If they don't, both apps register
      with the same SIP credentials and both ring. Have a remediation
      script ready: tell them to uninstall the old dialer, then quit + relaunch ACE.

- [ ] **Update DATABASE_URL on Render webhooks service** — probably stale,
      double-check it points to the same Supabase pooler URL the API uses.

---

## 🟡 Short-term (next 1–2 weeks)

- [ ] **Multi-DID per user** — `UserDid` table foundation. One user can have
      multiple phone numbers, all routable for inbound calls AND SMS. Backfill
      existing User rows as their own primary on migration.
- [ ] **Local presence picker** — "calling from" DID selector per outbound
      call. Ties directly into multi-DID. Wires through the dialer UI.
- [ ] **Voicemail transcription** — enable in Telnyx Portal. Voicemails come
      with text transcripts via webhook.
- [ ] **Internal user-to-user chat** (socket.io) — frontend done, backend done,
      needs Redis adapter for multi-instance Render (see Infra).

---

## 🟢 Infrastructure / Scaling (when user count + traffic justify)

- [ ] **Upgrade Render to Pro workspace** — Starter → Standard tier. Removes
      spin-down on idle.
- [ ] **Provision Render Key Value (Redis) + Socket.IO Redis adapter** —
      required before scaling chat to multiple API instances.
- [ ] **Telnyx webhook hardening**:
  - HMAC signature verification on every event
  - BullMQ queue between webhook receipt and DB write
  - Idempotency keys to dedupe re-delivered events
- [ ] **Replace 15-second polling with real-time push** — Postgres `LISTEN/NOTIFY`
      for unread counts. Reduces DB load + snappier UI.
- [ ] **Upgrade Vercel to Pro** ($20/mo).
- [ ] **Verify Telnyx WebRTC pricing model** — does WebRTC stack on top of
      SIP trunking per-minute? Important to know before scaling user count.

---

## 🔵 Polish / nice-to-haves

- [ ] **Silent auto-update via electron-updater** — same as the blocker
      above. Once the silent path actually works on Windows (after code-signing),
      this just turns into "feature works as designed."
- [ ] **Custom busy greeting** — per-user "I'm busy, leave a message"
      voicemail greeting (recorded in-app).
- [ ] **Reporting: export + scheduled digests** — per-user weekly email
      summary of call activity.

---

## ⚪ Long-term / Compliance

- [ ] **Apple Developer Program enrollment + macOS code-signing & notarization** —
      $99/year. Removes "unidentified developer" warning on Mac install.
      Important before any wider rollout.
- [ ] **Windows code-signing (EV cert)** — $300-400/year. Removes SmartScreen
      warning AND fixes the electron-updater silent install on Windows (the
      blocker above). Worth prioritizing for the pilot if users keep
      hitting the auto-update issue.

---

## How to update this file

After each session: move done items to `ACE_DIALER_PROJECT.md` changelog
(Section 13). Add any new asks at the right priority tier. Keep ≤ 30 items
visible.
