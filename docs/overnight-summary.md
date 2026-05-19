# Overnight build summary (May 18 → 19)

Everything below is on disk and ready to push.

## Top app bar — fully redesigned
Replaced the bland strip with a real product header:
- **Logo mark** (blue→green gradient phone icon)
- **Brand + version** stacked, with a Monitor icon when on Desktop
- **Live SIP status pill** in the center (green "Online", amber "Connecting…", red "Offline") with a pulsing dot
- **User avatar** (initials in a gradient circle, color derived from email hash so it's stable)
- **Dropdown menu** on click: shows full name, email, then Settings / Sign-out actions
- Light theme styling included
- Mobile-responsive (hides version + name on narrow screens)

## Multi-user support (#99)
- Added `User.sipUsername` + `User.didNumber` to schema (unique per user)
- Migration SQL: `packages/db/migrations/2026-05-multi-user.sql` — run in Supabase SQL editor + update pilot user's row
- Webhook handler uses a new `resolveUserId({ sipUsername, fromNumber, toNumber })` helper that looks up by SIP username first, then by DID match (last-10 digits). Falls back to `PILOT_USER_ID` env var (default 1) if nothing matches.
- New `PATCH /auth/me` endpoint so users self-serve their `didNumber` + `sipUsername`
- New Settings → Account section for editing name/DID/SIP
- Full doc: `docs/multi-user-setup.md`

## Desktop & SMS notifications (#97, #98)
- New `lib/notify.ts` — wraps `Notification` API, respects user prefs, gates on tab-hidden, focuses window on click
- `IncomingCall` now fires an OS notification when an inbound call rings while the tab is hidden
- New `SmsNotifier` component (mounted globally in Layout) polls `/messages/threads` every 15s, detects new inbound messages, and:
  - Shows an in-app toast top-right (auto-dismiss after 6s, clickable to open thread)
  - Fires a desktop notification if tab is hidden + `smsNotification` pref enabled
- Permission requested lazily on first load if either pref is on (not on app boot — Chrome treats that as spammy)

## macOS support (#96)
- The **web app already works on macOS** — open Safari/Chrome on the Mac and visit the Vercel URL
- For Electron installer: `electron-builder` config was already in place for `dmg`. Added GitHub Actions workflow `.github/workflows/build-desktop.yml` that:
  - Builds `.dmg` (Mac, both x64 + arm64) on macos-latest
  - Builds `.exe` (Windows) on windows-latest
  - Runs on push to main when `apps/desktop/**` or `apps/web/**` changes (or via manual trigger)
  - Uploads installers as workflow artifacts (downloadable from Actions tab)
- No code signing — the .dmg requires right-click → Open the first time. Add Apple Developer ID later if you want gatekeeper-clean distribution.

## Quick wins bundle

### #6 Call quality indicator
- `sipService` polls `getStats()` every 2s during a call, computes jitter / packet loss / RTT
- Buckets into good / fair / poor / unknown
- Pill rendered next to the duration in InCall header (green = good, amber = fair, red = poor)
- Hover shows exact numbers ("Good connection · jitter 12ms · loss 0.0% · rtt 87ms")
- `CallQuality` state exposed via SipContext (`useSip().callQuality`)

### #13 Backup / restore prefs
- New Settings → **Data** section
- **Export** button: downloads a JSON file with all `ace_*` localStorage keys (excludes SIP password)
- **Import** button: file picker, validates the JSON shape, overwrites with confirmation, then reloads
- Useful when switching devices

### #3 Favorites tab
- Brought back the Favorites tab in the bottom nav (moved Contacts to URL-only; placeholder anyway)
- New `getFavorites/addFavorite/removeFavorite/toggleFavorite/isFavorite` helpers in `userPrefs.ts`
- Full Favorites page with:
  - Avatar + JobDiva name + secondary line (company or formatted phone)
  - Star/empty-star toggle
  - SMS button (green)
  - Call button
  - Remove (X) button
  - Empty state with helpful hint
  - **+ Add favorite** modal in the header (phone + optional display name)
- **Star toggle** in Messages thread header — tap to favorite/unfavorite that contact
- LocalStorage-backed, no API changes needed

### #14 International number formatting
- Added `libphonenumber-js` dependency
- New `lib/phone.ts` with `formatPhone()`, `toE164()`, `last10Digits()` helpers
- US: still formats as "(973) 727-0611"
- UK: "020 1234 5678"
- India: "098765 43210"
- Any country with a `+` prefix is auto-formatted correctly
- Replaced inline `formatNumber` helpers in Recents, Messages, Voicemail, IncomingCall, InCall, Layout, SmsNotifier

## How to push

```bash
cd C:\Users\asheikh\Documents\Claude\Projects\Dialer\acedialerv4
git add .
git commit -m "feat: header redesign, multi-user, notifications, Mac CI, quick wins"
git push
```

Then in another window:

```bash
cd apps/web && npm install  # picks up libphonenumber-js
```

## What you need to do on your end

1. **Supabase SQL editor**: paste + run `packages/db/migrations/2026-05-multi-user.sql`. Edit the bottom `UPDATE` to set your actual SIP username and DID.
2. **Render**: no new env vars are required, but if you want the `PILOT_USER_ID` fallback to be a non-default user, set `PILOT_USER_ID` on `ace-dialer-webhooks`.
3. **GitHub Actions** will start running on the next push — go to Actions tab to download Mac/Windows installers.

## What's still pending (carry-over)

- JobDiva API credentials (blocked on JobDiva)
- Voicemail TexML setup in Telnyx portal + `PILOT_SIP_USERNAME` env var
- Conference + Transfer live testing (you couldn't test on VPN)
- 10DLC SMS registration
- Custom voicemail greeting upload
- Admin panel for managing multi-user accounts
- AI quick replies, spam blocking, GDPR export, onboarding tour, PWA, Electron auto-update, TCPA list, etc. (see prior estimates)
