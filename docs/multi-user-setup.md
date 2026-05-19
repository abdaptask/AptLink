# Multi-user setup (Phase 5.7)

ACE Dialer now supports multiple users. Each user has their own DID and their
own Telnyx SIP credential. The webhook service routes inbound calls and SMS
to the right user based on which DID was called.

## How it works

Two fields on every User row:

- **`didNumber`** — the E.164 phone number assigned to that user (e.g.
  `+15555550100`). Used for inbound routing: when an SMS or call arrives,
  the webhook matches `payload.to` against everyone's `didNumber`.
- **`sipUsername`** — the Telnyx SIP credential username they log into the
  WebRTC SDK with. Used for outbound routing: when an SDK call fires
  webhook events, the SIP user identifies the originator.

If neither field matches, the webhook falls back to user ID 1 (configurable
via `PILOT_USER_ID` env var on the webhooks service) so legacy data still
works.

## Adding a new user

### 1. Provision in Telnyx

- **Voice → SIP Trunking → My SIP Connections → \<ace-dialer connection\> →
  Credentials → +** — create a new SIP credential (username + password)
- **Numbers → Buy a number** — get a DID for the new user
- **Numbers → \<the new number\>** — assign it to your TexML application
  (voicemail) and the same Messaging Profile you use for SMS

### 2. Create the user in the DB

Direct SQL in Supabase:

```sql
INSERT INTO users (
  email, password_hash, first_name, last_name,
  sip_username, did_number, is_active
) VALUES (
  'new-user@aptask.com',
  '$2a$10$REPLACE_WITH_BCRYPT_HASH',  -- use: node -e "console.log(require('bcryptjs').hashSync('password', 10))"
  'New', 'User',
  'ace-dialer-newuser',   -- must match Telnyx SIP credential username
  '+15555550100',         -- the DID you bought
  true
);
```

### 3. User logs in & verifies

The new user logs into the web/desktop app with their email + password. They
should go to **Settings → Account** to verify their DID and SIP username are
correct (and update if anything's wrong).

Their Telnyx SIP password goes in **Settings → Telnyx** (stored in browser
localStorage, used by the WebRTC SDK on connect).

## Test the routing

Have someone call the new user's DID. In **Render → ace-dialer-webhooks →
Logs** you should see the `[telnyx] call event` followed by a Prisma write
that uses the new user's ID. The call should appear in the new user's
Recents (and ring their dialer if they're online).

## Env vars

| Service | Var | Notes |
|---|---|---|
| `ace-dialer-webhooks` | `PILOT_USER_ID` | Fallback userId when no DID/SIP match. Default `1`. |
| `ace-dialer-webhooks` | `TELNYX_API_KEY` | Same key as the API service. |

## Limits / open items

- No admin UI yet — adding a user requires direct DB access. Admin panel
  is a future task.
- Voicemail TexML still uses a single `PILOT_SIP_USERNAME` env var; for
  multi-user voicemail, this needs to be templated per user (TexML
  application per DID).
- Outbound 10DLC campaign registration is shared across users today.
