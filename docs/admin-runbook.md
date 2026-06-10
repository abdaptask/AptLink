# ACE Dialer — Admin Runbook

Day-to-day operational tasks for the dialer admin (currently abdulla@aptask.com).

## Adding new users

There are two paths depending on whether the user already has a Pulse / Telnyx
setup or you're starting from scratch.

### Path A — fresh user (no existing SIP creds)

Use this for net-new users — the system creates a fresh Telnyx Credential
Connection, buys a DID, sets up routing, and emails the user a welcome message
with the desktop installer link.

1. **Settings → Admin → Users → Invite new user**
2. Fill in:
   - Email (must match the user's Entra ID / Microsoft work account)
   - First + last name
   - Choose **"Create new Telnyx connection"** (auto-provisions everything)
   - Optionally pick a DID area code (default `732`)
3. Click **Invite**. The provisioning flow runs server-side — you'll see a
   step-by-step result. Each step shows ✓ or ✗:
   - Clone Telnyx connection from template
   - Assign or purchase DID
   - Set Caller ID Override (ani_override) to the new DID
   - Create User row in DB
   - Link UserDid row + mark as default
   - Send welcome email via SendGrid
4. Confirm all steps ✓. If any failed, expand the row to see the error.

The user receives an email with a link to acedialerv4-web.vercel.app. On first
sign-in they hit MS SSO, get auto-provisioned in the DB (since their email is
in PendingUser), and land in the dialer.

### Path B — existing user (Pulse migration / CSV import)

For migrating Pulse users where the SIP credentials already exist in Telnyx:

1. Settings → Admin → **Pending Users → Import CSV**
2. Upload a CSV with columns: `email, firstName, lastName, pulseVoipExt,
   pulseExtPassword, pulseVoipNumber`
3. Each row creates a PendingUser entry. Users sign in via MS SSO; on first
   login the backend reuses their existing Telnyx SIP credentials and assigns
   the existing DID.

CSV file should NEVER be committed to git — it has plaintext SIP passwords. Add
to .gitignore and store outside the repo.

## Adding a second DID to an existing user

1. Settings → Admin → **Users**
2. Click the **⋯** menu on the user's row → **Manage lines**
3. The Manage Lines modal opens showing existing DIDs
4. Click **Add line**
5. Pick:
   - **Use an existing unassigned number** — dropdown shows DIDs in your
     Telnyx account that aren't tied to a user
   - **Buy a new number** — enter area code, Telnyx returns available
     numbers, pick one, it gets purchased + assigned
6. Optional: set label (e.g. "Sales"), color, mark as default
7. Click **Add line**

The new DID is bound to the user's existing Telnyx Credential Connection (same
SIP credentials handle both lines). Inbound calls/SMS to either DID ring the
same user. Outbound caller ID is set per-call by the user's DidSwitcher choice.

## Removing a DID from a user

1. Manage Lines modal → click the trash icon next to a non-default DID
2. Confirm in the dialog

The DID stays in Telnyx (it's not released — you can re-assign it to another
user later). The local UserDid row is deleted; if it was the active line the
user's active DID falls back to the default.

## Changing a user's default outbound line

1. Manage Lines modal → click **★ Default** next to a non-default DID
2. The new default takes effect immediately; old default no longer marked

This also runs `setConnectionCallerIdOverride` on Telnyx so outbound calls use
the new default's ani_override.

## Editing a line label or color

1. Manage Lines modal → click the pencil icon next to a line's label
2. Inline input appears — type the new label, hit Enter (or click outside)
3. Click the colored circle on the left of any line to open the color palette
4. Pick a new color

Changes propagate to all line badges (Recents, Messages, Voicemail) on next
list refresh.

## Disabling a user

1. Settings → Admin → Users → click the **⋯** menu on a user → **Deactivate**
2. The User row's `isActive` flag flips to false
3. The user's JWT is invalidated on next API call (401 → bounced to /login)
4. Future MS SSO attempts return "Your dialer account has been deactivated"
5. Inbound calls/SMS to their DID still arrive in Telnyx but are dropped at
   the API layer (no row created, no notification fired)

To **reactivate**, click ⋯ again → **Reactivate**. The user can sign in again
immediately.

## Watching logs

For ANY troubleshooting, the three Render service log tabs are your first stop:

| Service | When to watch |
| --- | --- |
| ace-dialer-api | Login issues, admin endpoint errors, /me endpoints, voicemail audio proxy 502s |
| ace-dialer-webhooks | Inbound call / SMS / voicemail event routing, Teams card delivery (`[teams] missed-call sent`, `[teams] sms sent`, `[teams] voicemail sent`) |
| ace-dialer-socket | Real-time chat issues, presence state |

Filter logs by user by searching for `userId: <N>` or the user's email.

For desktop crashes:
- Windows: `%APPDATA%\ACE Dialer\logs\main.log`
- macOS: `~/Library/Logs/ACE Dialer/main.log`

For SIP / call quality issues, ask the user to take a screenshot of the call
quality meter (RTT + jitter shown in the call header).

## Microsoft Teams notifications — operational notes

### Power Automate flow
- Owner: abdulla@aptask.com
- Flow name: "ACE Dialer Tenant Webhook"
- URL: stored in `TEAMS_TENANT_WEBHOOK_URL` env var on Render (api + webhooks services)
- View at: https://make.powerautomate.com → My flows → ACE Dialer Tenant Webhook
- Run history: 28-day rolling window. Click into any run to see the per-step
  inputs/outputs.

### Common Teams card issues

| Symptom | Cause | Fix |
| --- | --- | --- |
| No card arrives | TEAMS_TENANT_WEBHOOK_URL not set on webhooks service | Check Render Environment tab |
| No card arrives, but webhook logs say `[teams] missed-call sent` | Flow failed at the action step | Open Power Automate run history → red step → fix |
| `GraphUserDetailNotFound` in run history | Recipient email doesn't match a Teams user in your tenant | Verify user has a Teams account; check user.email in DB |
| `InvalidBotRequestMessageBody` | Adaptive Card payload malformed | Check that card has `type: "AdaptiveCard"`, valid `body`, version `1.4` |
| Card arrives twice | Telnyx webhook retry firing same event | Should be deduped by v0.10.4 fix — if it recurs, check `[teams] missed-call already sent` log |
| User opted out — wants to re-enable | User: Settings → Personal → Teams notifications → check the toggles |

### Power Automate quota
- Default Microsoft 365 license: 1,000 runs / 24h / user (flow owner)
- 100 users × ~10 events/day = 1,000 runs/day — within limit
- If you start hitting the wall, the flow shows "throttled" in run history
- Increase quota by upgrading the owner's license OR splitting the flow across
  multiple owners (round-robin)

## Microsoft SSO — operational notes

### Entra ID app registration
- Owner: ApTask Microsoft 365 admin
- App name: ACE Dialer
- Redirect URI: `https://acedialerv4-web.vercel.app/auth/microsoft/callback`
- Supported account types: Single tenant (ApTask only)
- API permissions: `User.Read` (delegated) — that's it
- Client secret: stored as `MICROSOFT_CLIENT_SECRET` on the api service

### Common SSO issues

| Symptom | Cause | Fix |
| --- | --- | --- |
| "SSO not configured on the server" on login screen | MICROSOFT_TENANT_ID or MICROSOFT_CLIENT_ID env vars missing on api service | Check Render Environment |
| Microsoft redirect goes to wrong URL → 404 | Redirect URI in Entra doesn't match Vercel URL | Update redirect URI in Entra app registration |
| "Your ApTask account hasn't been invited" | User's email is not in PendingUser table | Admin needs to add them via Invite new user OR CSV import |
| Microsoft hangs at "Stay signed in?" prompt | Conditional Access policy or MFA — normal | User completes the prompts |
| SSO callback page shows blank | Vercel SPA rewrite eating JS chunks OR vite base path wrong | Already fixed in v0.10.6 — if recurs, check vercel.json + vite.config.ts |

## Desktop releases

### Publishing a new desktop installer

The build workflow runs automatically on every push to main (when apps/web,
apps/desktop, or package.json paths change). It uses the version in
apps/desktop/package.json to tag the GitHub Release.

To force a fresh release with a higher version:

```powershell
# 1. Bump version in all 7 package.json files (root + workspaces)
# 2. Commit + push to main
# 3. The workflow publishes the release automatically
# 4. Optionally: git tag vX.Y.Z + git push origin vX.Y.Z to trigger
#    the workflow's tag-based path explicitly (redundant if step 2 already
#    triggered it)
```

### Auto-update flow on users' machines
- electron-updater checks GitHub Releases on app launch + every 60 min while
  running
- If a higher version exists, downloads the .exe / .dmg silently in background
- When download completes, sends `ace:update-downloaded` IPC to renderer
- UpdateBanner component shows "Restart to install" button
- User clicks → `app.quitAndInstall()` → installer runs → app relaunches

### Failed updates
- If electron-updater errors (download fail, signature mismatch, Windows
  installer rejected), UpdateBanner shows the error message
- User can manually download the installer from GitHub Releases and run it
- Update logs are in the user's app log folder (see "Watching logs" above)

## Cost / quota monitoring

Things worth eyeballing once a week:

- **Telnyx usage** — voice minutes + SMS volume + Hosted Voicemail seats + DIDs
  active. Telnyx portal → Reports → Usage.
- **Deepgram quota** — Nova-3 transcription is ~$0.0043/min. Voicemail volume is
  low so cost is minimal but worth knowing.
- **Render free tier** — webhooks service is currently on free tier (hibernates
  after 15 min idle). Voicemail transcription's retry logic + future ring-group
  ring-timeouts use setTimeout — these can be killed by hibernation. Consider
  upgrading to Starter ($7/mo) if you start seeing missed transcriptions or
  late notifications.
- **Vercel bandwidth** — free tier is generous; should be fine for the team size.
- **Power Automate run count** — see above.
- **Supabase row count** — Calls and Messages tables grow continuously. The
  free tier caps at 500MB which is plenty for now. Monitor in Supabase dashboard.

## Disaster recovery

### Render service down
- Check status.render.com
- The dialer's web app works (read-only) even when API is down — users see
  cached data but new calls/SMS don't go through
- API typically restarts on its own within a minute; if not, manually deploy
  the latest commit from Render dashboard

### Database down
- Check status.supabase.com
- All three Render services error out (database connection failure)
- Wait for Supabase to recover; nothing to do

### Telnyx connection broken (user can't place/receive calls)
- Verify the user's SIP credential is still active in Telnyx portal
- Verify the DID is still assigned to the right Credential Connection
- Verify outbound voice profile is set on the connection
- Check the user's Cloudflare TURN connection if they're in India

### Mass user inability to log in
- Most likely cause: MS SSO config issue (client secret expired, Entra app
  disabled, redirect URI changed)
- Check Render API logs for `[auth/microsoft/exchange]` errors
- Fallback: tell users to use the "Sign in with password (admin only)" link
  if they have a local password — but most don't, so this isn't a real
  recovery option for the whole team

### Lost main admin (abdulla@aptask.com locked out)
- A secondary admin user with isAdmin=true should exist as backup
- If no backup: direct SQL in Supabase to flip another user to isAdmin=true:

```sql
UPDATE users SET is_admin = true WHERE email = 'someone-else@aptask.com';
```

## Emergency contacts

(Fill in as needed)

- Telnyx support: (insert ticket portal URL)
- Microsoft 365 admin: (ApTask IT)
- Render: support@render.com
- Supabase: support@supabase.io


## Voicemail v2 migration (per user)

The new Call Control voicemail flow (custom greeting + dual busy/no-answer + persistent recording URLs) is opt-in **per user**. Until you migrate a user, their inbound calls still use the legacy SIP → Hosted Voicemail path.

### One-time prerequisite (already done if v0.10.100 is live)

1. Telnyx Mission Control → **Voice → Voice API Applications → + Create Application**
   - **App name:** `ACE Voicemail`
   - **Webhook URL:** `https://ace-dialer-webhooks.onrender.com/webhooks/telnyx/voicemail-cc`
   - **Method:** POST, API v2
   - Save. Copy the **Application ID** (looks like `2963522202491684629`).
2. Render → **ace-dialer-api** service → Environment tab → add `TELNYX_VOICEMAIL_CC_APP_ID = <the App ID>` → redeploy.

### Per-user migration

1. Settings → Admin → Users → find the user → kebab → **Voicemail migration**.
2. The modal shows their DIDs and current state (Legacy SIP vs Call Control).
3. Click **Migrate to Call Control**. For each DID, the server:
   - Reads current `connection_id` and Hosted VM enabled flag from Telnyx (these get snapshotted onto `UserDid.preMigrationConnectionId` + `preMigrationHostedVmEnabled` so rollback is exact).
   - PATCHes `connection_id` to `TELNYX_VOICEMAIL_CC_APP_ID`.
   - Disables Hosted VM on the DID.
   - Stamps `UserDid.callControlMigratedAt = now()`.
4. The modal shows per-DID outcome (✓ migrated / ⚠ already migrated / ✗ failed).
5. Verify by calling the user's DID from another phone. Their softphone should ring; let it ring out; their custom greeting plays.

### Rollback

In the same modal, click **Roll back**. For each migrated DID, the server PATCHes `connection_id` back to `preMigrationConnectionId`, re-enables Hosted VM if it was on before, and clears the three migration tracking columns.

## Force-updating a specific device

When you ship a critical fix and want a specific user updated immediately rather than waiting for the auto-update poll cycle (1-2 hours by default).

1. Settings → Admin → Users → find the user → kebab → **Devices**.
2. The modal shows every device that user has signed in from (electron-win, electron-mac, web, future iOS / Android). Each row has platform, app version, first-seen / last-seen times.
3. Click **Force update** on the specific device row. Server sets `UserDevice.forceUpdateRequestedAt = now()`.
4. Within ~60 seconds, that device's next heartbeat sees the flag, triggers `window.ace.checkForUpdates()` (Electron), and prompts the user to install the latest release. Web clients reload instead.
5. The row shows "Update pending" until the client acks via `POST /me/heartbeat/ack-update` (called automatically after the autoUpdater check runs).

## Telnyx outage notifications

No action required — the webhooks service polls `https://status.telnyx.com/api/v2/status.json` every 60 seconds. When the indicator flips from `none` to anything degraded:

- A colored banner appears at the top of every user's dialer.
- An adaptive card posts to `TEAMS_TENANT_WEBHOOK_URL` (your admin Teams channel) describing the incident.
- A recovery card posts when status returns to `none`.

If you're seeing the banner and want to drill in: click the **Details** link to open status.telnyx.com directly. The Teams card has the same link.

## Voicemail recordings are now permanent

Voicemails captured via the Call Control flow (v0.10.100+) are stored in our Supabase `ace-media` bucket at `voicemails/u{userId}/{voicemailId}.mp3`. The Telnyx-signed S3 URL expires after 10 minutes; our re-upload makes the recording available indefinitely.

**Implication for storage cost:** Supabase Pro tier handles current scale (~36 users × ~3 voicemails/day × 250 KB × 30-day rolling retention ≈ 810 MB rolling). Free tier is 1 GB — upgrade to Pro ($25/mo) when growth pushes past that.

**Existing pre-fix voicemails** (recorded before v0.10.101) still reference the original Telnyx S3 URL and won't play back because those signatures expired. Either delete them manually or wait for the 30-day auto-delete.
