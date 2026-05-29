# ACE Dialer — What it does

A modern softphone built for ApTask. Replaces Pulse for calls, SMS, voicemail,
and team chat. Runs in any browser tab and as a packaged Windows / Mac desktop
app that auto-updates.

## Calling

**Make calls from your own number.** Outbound calls present each user's own
ApTask DID — no more shared pilot line. Built-in country flag picker for
international dialing.

**Smart contact lookup.** JobDiva contacts auto-load as you type. Recent
calls and favorites are one click away.

**Crystal-clear audio in India + US.** Cloudflare TURN servers in Mumbai and
Bangalore handle India's symmetric-NAT WiFi networks. Real-time quality
meter so users can see when their connection is shaky.

**Don't miss calls when minimized.** The desktop app keeps running in the
system tray. A separate ringer pops up over whatever you're doing.

**Full in-call controls.** Mute, hold, DTMF, record, even bring a third
party in via three-way conferencing.

## SMS and MMS

**Two-way texting from your business number.** Outbound SMS and MMS image
attachments via the user's assigned line.

**Threaded conversations.** Inbound messages route to whoever owns the
recipient line. Unread badges, search, mute per thread.

**Notifications in Microsoft Teams.** Every inbound text generates a Teams
card with the sender info and message preview, plus Reply and Call buttons.

## Voicemail

**Auto-transcribed in seconds.** Every voicemail is transcribed using
Deepgram's latest telephony model, tuned for accented English so Indian
voicemails come through accurately.

**Listen from anywhere.** Voicemail playback works in the desktop app, the
web browser, even on phone via the Teams card. No need to call in for
voicemail.

**30-day retention.** Voicemails auto-delete after 30 days. Important ones
can be transcribed and saved elsewhere.

## Microsoft Teams Notifications

Every user automatically gets notifications in their Microsoft Teams chat
when something hits their dialer:

- 📞 **Missed calls** — with caller number + call back button
- 💬 **Incoming texts** — with the message preview + reply button
- 🎙️ **New voicemails** — with the transcript + listen button + call back

Zero setup required for end users. The IT admin configures one tenant-wide
flow; everyone gets cards automatically the moment they're added to the
dialer.

Users can turn off any of the three notification types they don't want via
a simple Settings toggle.

## Multiple lines per person

For roles that need multiple business numbers (e.g., a recruiter who has
separate "Sales" and "Support" lines):

- One person, multiple DIDs
- Header dropdown picks which line you're calling FROM
- Inbound calls / texts / voicemails to ANY of your lines come to you
- Each line has a color and label so you know at a glance which one was used
- Admin manages all of this from a clean modal — add a line, buy a new
  number, set the default, change colors

## Internal team chat

Built-in 1:1 messaging between dialer users:

- Real-time delivery
- Online / Away / Idle / Offline presence
- Sort by availability — reachable people float to the top
- Unread badges and search

No more switching between SMS (external customers) and Teams (internal
coworkers). Internal chat stays in the dialer.

## Single sign-on

**Sign in with Microsoft.** ApTask Microsoft accounts log into the dialer
in one click. No separate passwords to remember or rotate. Conditional
Access + MFA from Entra ID apply automatically.

**Admin invitations.** The admin pre-invites users by email; they sign in
on their first visit and the dialer auto-provisions everything (DID,
SIP credentials, Teams notifications, JobDiva access).

## Admin tools

**Add new users in 60 seconds.** Invite flow auto-provisions a Telnyx
connection, buys or assigns a DID, sets caller ID, configures voicemail,
and emails the welcome message.

**Manage everyone's lines from one place.** Add or remove DIDs, change
labels and colors, set defaults, deactivate users — all from a clean
admin UI.

**Bulk import from Pulse.** CSV import for migrating existing Pulse
users in one shot, with per-row success/failure feedback.

**Audit log.** Every admin action recorded with who, what, when, and target.

## Desktop app perks

- Auto-updates silently in the background — no IT pushed installs
- Hide-to-tray on close so calls keep working
- Click any phone number anywhere on your computer to dial it (custom URL
  scheme registered with the OS)
- Survives sleep/wake — SIP reconnects automatically

## Designed for production reliability

- Active calls survive window minimize, tab switch, brief network blips
- Session expires gracefully — automatic redirect to sign-in, no stale data
- Webhook retries from the carrier are deduplicated so no double notifications
- WCAG AA-compliant text contrast in both dark and light themes
- Works at 1366×768 minimum (older laptop resolutions)

## What's NOT yet available (coming next)

- **Ring Groups** — multi-agent inbound routing (e.g., "ring all sales agents
  in parallel; first to pick up wins")
- **IVR** — caller-selected DTMF routing ("Press 1 for sales, 2 for support")

---

**Built by:** ApTask | **Current version:** v0.10.8 (May 2026) |
**Powered by:** Telnyx · Microsoft Entra ID · Power Automate · Supabase ·
Deepgram · Cloudflare · Render · Vercel
