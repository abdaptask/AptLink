# Welcome to ACE Dialer

This is a quick reference for new ACE Dialer users. The dialer replaces Pulse
for calls, SMS, voicemail, and team chat.

## Getting in

1. Your admin invites you. You'll get a welcome email with a link.
2. Open the link in your browser → sign in with your ApTask Microsoft account.
3. The first sign-in auto-provisions you. You'll land on the keypad.
4. (Optional) Download the desktop app for the best experience:
   - Visit https://github.com/abdaptask/acedialerv4/releases → grab the latest
     `ACE-Dialer-Setup-X.Y.Z.exe` (Windows) or `ACE-Dialer-X.Y.Z.dmg` (Mac)
   - Install. Sign in with the same Microsoft account.
   - The desktop app auto-updates silently in the background going forward.

## What you can do

### Place a call
- Tap the dial pad, type a number, hit Call
- Or click any number in Recents / Voicemail / Messages → click-to-dial
- Tap **Contacts** in the keypad to search your JobDiva contacts

### Receive a call
- Your phone number rings; a ringer popup appears
- Answer / decline. The active call window shows the caller info, call timer,
  and controls (mute, hold, DTMF, add call, record).

### SMS / MMS
- Click the **Messages** tab
- Tap the **+** icon to start a new conversation, search for a contact or
  enter a number
- Send text or attach an image
- Inbound messages appear in your thread list with an unread indicator

### Voicemail
- Click the **Voicemail** tab
- Each voicemail shows the caller, timestamp, duration, and a transcript
  (auto-generated, accurate for Indian + American English)
- Click the play icon to listen
- Click Call back to return the call; click Send text to reply via SMS

### Team chat (internal)
- Click the **Chat** tab to message other ACE Dialer users (this is internal —
  not SMS to customers)
- The Online / Away / Idle indicators tell you who's reachable right now

### Microsoft Teams notifications

You'll automatically get a notification in your Teams chat with "Flow bot"
whenever:
- 📞 You miss a call
- 💬 Someone texts you
- 🎙️ Someone leaves you a voicemail

Each card has buttons:
- **Call back** / **Send text** / **Reply** — opens the dialer with the
  recipient pre-filled. If you're on desktop with the app installed, your
  browser will ask "Open ACE Dialer?" — click Allow and check "Always allow"
  so future clicks open silently.
- **Listen** (on voicemail cards) — opens a web playback page with the
  voicemail audio + transcript.

**To turn off a notification type**: Open ACE Dialer → Settings (gear icon)
→ Personal → Teams notifications. Uncheck the events you don't want, click
Save.

## Multi-line / multi-DID (if assigned)

If your admin has assigned you multiple phone numbers, you'll see a
**number dropdown** at the top of the dialer header. Click it to switch
which line you're calling FROM (your outbound caller ID). The current line
is shown with a colored dot.

Inbound calls / SMS / voicemails on any of your lines all come to you and
are tagged with a colored badge showing which line was rung.

## Settings worth knowing about

- **Settings → Personal**
  - Display name + initials
  - Default outbound number (same as the header DidSwitcher)
  - Teams notifications opt-ins (per-event toggles)
  - Theme (Dark / Light / System)
- **Settings → Audio**
  - Mic + speaker device selection
  - Ringer device (separate from speaker — handy if you wear headphones for
    calls but want the ringer to play through laptop speakers)
- **Settings → Telnyx**
  - Your SIP username + password. Don't change unless your admin tells you to.

## When things go wrong

- **Status pill says "Disconnected"** — your SIP connection dropped. Wait a
  few seconds; it should reconnect automatically. If it stays disconnected,
  refresh the page (web) or restart the app (desktop).
- **Call quality is bad (jitter / RTT in the meter)** — try moving closer to
  WiFi, plugging in via ethernet, or restarting the app to reconnect to a
  closer TURN server.
- **No audio on inbound call** — Windows / browser may be blocking microphone
  access. Check the browser permission prompt or Windows mic settings.
- **Voicemail stuck at "Transcribing…"** — usually transcribes within 5-10
  seconds. If it's been over a minute, the upstream service may be slow;
  the transcript will fill in when it arrives but the audio is already there
  to play.
- **Anything else** — message Abdulla in Teams.

## Privacy + data

- Calls + SMS go through Telnyx (your account's provider)
- Voicemails are stored on Telnyx for 30 days, then auto-deleted; transcripts
  are stored in the dialer's database
- Microsoft sign-in uses your ApTask Microsoft account; the dialer doesn't
  store your Microsoft password
- Internal chat messages (Chat tab) are stored in the dialer's database
- SIP credentials are stored encrypted at rest

## Quick tips

- **Pin the desktop app to your taskbar** — Windows: right-click ACE Dialer
  on the taskbar → Pin to taskbar. Mac: right-click in dock → Options → Keep
  in Dock.
- **Close-to-tray** — clicking the X on the desktop app HIDES the window to
  the system tray (Windows) / menu bar (Mac). The app keeps running so you
  don't miss calls. Right-click the tray icon → Quit if you actually want to
  close.
- **Hot-key for the keypad** — once focused in the dialer, you can type
  digits directly without clicking the keypad buttons.
- **Multi-monitor** — the dialer remembers where you put the window across
  sessions.
- **First-time Teams card click** — the browser will prompt "Open ACE Dialer?".
  Tick "Always allow" so future clicks open the desktop silently.
