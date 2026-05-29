# ACE Dialer — Welcome Email Template

This is the email a newly-invited user receives via SendGrid when an admin
clicks **Invite** in the dialer's admin UI. Reviewing this doc lets you
suggest edits without touching code.

**Note**: this is a representation of the email's content. The actual sent
email is defined in `apps/api/src/email/sendgrid.ts` (function
`sendWelcomeEmail`). To change the wording, edit that file, commit, push to
main, and the API auto-redeploys on Render — new invites use the new copy.

---

## Subject line

```
Welcome to ACE Dialer — install + sign-in inside
```

---

## Plaintext version

(Sent as the `text/plain` part for email clients that strip HTML, screen
readers, and spam-score reduction.)

```
Hi {firstName},

Your ACE Dialer account is ready. Your business phone number is {didNumber}.

HOW TO INSTALL:

The fastest way: download + run the installer yourself (takes 2 minutes).

  Windows:  https://github.com/abdaptask/acedialerv4/releases/latest
  Mac:      https://github.com/abdaptask/acedialerv4/releases/latest

On that page, click the .exe (Windows) or .dmg (Mac) file. Run it.
You'll see "unidentified developer" — that's expected for now. On
Windows click "More info" then "Run anyway"; on Mac right-click the
.dmg and choose Open.

If you'd rather wait for IT: they'll reach out within 1 business day
to install it for you.

ONCE INSTALLED:

1. Open ACE Dialer from your desktop
2. Click "Sign in with Microsoft"
3. Sign in with your @aptask.com account (same as Outlook)
4. Done — you can make and receive calls + texts

*** IMPORTANT ***
If you're still on the old dialer (Pulse), UNINSTALL IT FIRST. Running
both at once causes every incoming call to ring twice and possibly drop.

Need help? Reply to this email or contact {supportEmail}.

— The ACE Dialer team
```

---

## HTML version (what most users see)

The HTML email renders as a 560px-wide centered card with the following sections:

### Header
- Title: **Welcome to ACE Dialer**
- Subtitle: `Hi {firstName}, your account is ready.`

### Phone number callout (skipped if no DID assigned)
A light-blue box with a left border accent:
- Label: **YOUR BUSINESS PHONE NUMBER**
- Value: `{didNumber}` in large bold text (e.g. `(732) 555-1234`)

### How to install
- Heading: **How to install**
- Body: "Fastest way: download + run the installer yourself (takes about 2 minutes)."
- Two side-by-side blue buttons:
  - `Download for Windows` (linking to GitHub Releases latest)
  - `Download for Mac` (linking to GitHub Releases latest)
- Caption underneath: "On that page, click the .exe (Windows) or .dmg (Mac) file. You may see an 'unidentified developer' warning — that's expected for now. On Windows click More info → Run anyway; on Mac right-click the .dmg and choose Open."
- Secondary caption: "Prefer to wait for IT? They'll reach out within 1 business day to install it for you."

### Once installed
- Heading: **Once installed**
- Numbered list:
  1. Open **ACE Dialer** from your desktop.
  2. Click **"Sign in with Microsoft"**.
  3. Sign in with your **@aptask.com** account (same one as Outlook).
  4. Done — you can make and receive calls and texts.

### Important warning box
Light-red box with a red left border:
- Title: **Important: uninstall the old dialer first**
- Body: "If you're still on the old dialer (Pulse), **uninstall it before signing in to ACE**. Running both at once causes every incoming call to **ring twice and possibly drop**."

### Footer
- "Need help? Reply to this email or contact `{supportEmail}`."
- "— The ACE Dialer team"
- Tiny grey text: "Sent by ACE Dialer · ApTask"

---

## Placeholders used

| Token | Source | Example |
| --- | --- | --- |
| `{firstName}` | `users.first_name` (first word; falls back to "there") | `Akshay` |
| `{didNumber}` | `users.did_number`, formatted for display | `(732) 555-1234` |
| `{supportEmail}` | `aceSupportEmail` config (env var) | `it@aptask.com` |
| Download URL | Hardcoded as `https://github.com/abdaptask/acedialerv4/releases/latest` | — |

Section visibility:
- The "Phone number callout" is only shown when `didNumber` is non-null
- All other sections render regardless of placeholder values

---

## Things you might want to change

A few low-risk, easy edits if you want to tweak the messaging:

1. **Subject line** — currently a bit functional ("install + sign-in inside"). Consider warmer alternatives:
   - "Welcome to ACE Dialer 🎉"
   - "Your ACE Dialer is ready"
   - "ACE Dialer access — set up in 2 minutes"

2. **"unidentified developer" copy** — once we add code-signing certs (which Apple does free for Developer Program members, ~$99/year), users won't see this warning and the paragraph can be removed entirely. Save for later.

3. **IT install fallback wording** — currently says "1 business day". Update to match your actual SLA.

4. **The "uninstall Pulse" warning** — this is essential while Pulse still exists; once you've finished migrating everyone off Pulse, remove the entire red warning box.

5. **Branding / colors** — the email uses Tailwind-ish slate + sky blue. If ApTask has brand colors, swap `#0a84ff` (button blue), `#0284c7` (accent), and `#dc2626` (warning red) for branded equivalents.

6. **Support contact** — currently `it@aptask.com` (configurable via `ACE_SUPPORT_EMAIL` env var on the api service). Change if you'd rather route help requests to a specific person or distribution list.

7. **Tone** — currently neutral / instructional. Adjust to match ApTask's house voice (friendlier? more formal? bullet-style?).

---

## How edits actually ship

When you decide what to change:

1. Tell me which sections + the exact new wording
2. I'll edit `apps/api/src/email/sendgrid.ts` (both `text` and `html` versions to keep them in sync) and update this doc to match
3. Commit + push to main → Render rebuilds API → new invites use the new copy
4. Old invites that already went out are not retroactively changed

The "uninstall the old dialer" warning is the only piece I'd recommend keeping
verbatim — it's there because we've actually seen the double-ring problem
happen during pilot users' first install. Worth being loud about it until
Pulse is fully retired.
