# JsSIP migration (Phase 6.0)

We're moving the SIP layer from `@telnyx/webrtc` (Telnyx's WebRTC SDK) to
`jssip` — a generic browser SIP UA.

## Why

The Telnyx WebRTC SDK was a great quick start but it has structural
limitations that blocked features we want:

1. **Single call abstraction** — the SDK only exposes one `currentCall` at
   a time. To do Add Call / 3-way, we'd need server-side bridging via
   Telnyx's Call Control REST API.
2. **Opaque WebRTC leg** — Telnyx doesn't fire webhook events (and doesn't
   expose via REST) the `call_control_id` of the user's WebRTC side. That
   means our server can never address it for `bridge` or `Conference`
   actions, so a true 3-way where the user stays in the call was impossible.
3. **No transfer method** — the SDK's call object doesn't expose
   `.transfer()`. Forced us to do server-side transfer, which has the same
   call_control_id problem for the WebRTC side.

JsSIP is a generic SIP-over-WebSocket UA. Every call is its own
`RTCSession` with its own `RTCPeerConnection`. Multiple simultaneous calls
work natively. Transfer is just a SIP REFER. Audio mixing for conferences
happens **client-side** via Web Audio API — exactly how a native softphone
(PJSIP, etc.) does it.

## What changed

| Before | After |
|---|---|
| `import { TelnyxRTC } from '@telnyx/webrtc'` | `import JsSIP from 'jssip'` |
| `new TelnyxRTC({ login, password })` | `new JsSIP.UA({ sockets, uri, password })` |
| Single `currentCall` | `Map<callId, CallEntry>` — multiple concurrent calls |
| `currentCall.transfer()` (not exposed) | `session.refer(target)` — clean SIP REFER |
| Server-side Conference via Call Control API | Phase 6.1: Web Audio API client-side mixing |
| `call.toggleHold()` flag unreliable | Real SIP RE-INVITE with `sendonly` direction |

The **public API of `SipService`** is unchanged so the rest of the app
(SipContext, InCall, IncomingCall, Recents call-back) doesn't need
modification.

## Telnyx config

JsSIP connects to Telnyx via SIP-over-WebSocket. Defaults in `sip.ts`:

```ts
wssUri: 'wss://sip.telnyx.com:443'
realm:  'sip.telnyx.com'
uri:    `sip:${VITE_SIP_USERNAME}@sip.telnyx.com`
password: VITE_SIP_PASSWORD
```

If your SIP Credential lives under a different region or hostname, override
via env var (we currently don't expose this; add `VITE_SIP_WSS_URI` if
needed).

**Telnyx Portal checklist** (you should already have these):
- SIP Connection type: Credential Connection
- Username / Password: same as your existing `VITE_SIP_USERNAME` / `VITE_SIP_PASSWORD`
- Codec preferences: at least PCMU (G.711μ) enabled — JsSIP negotiates this by default
- WebRTC enabled on the connection

No additional portal config is needed. JsSIP uses the same SIP Credential
that the Telnyx WebRTC SDK was using.

## Migration phases

### Phase 6.0 — Drop-in replacement ✅
- Replace SDK with JsSIP
- Keep single-call behavior (Add Call still server-side / disabled)
- Verify outbound + inbound + hold + transfer + DTMF + mute work
- Call quality polling works against `session.connection` (the underlying PC)

### Phase 6.1 — Multiple concurrent calls (the goal)
- `addCall()` calls JsSIP again for a 2nd outbound — auto-holds the first via SIP RE-INVITE
- Each call has its own `RTCSession` and its own `RTCPeerConnection`
- `swapCalls()` does hold/unhold dance between sessions
- UI's `hasSecondCall` / `secondCallNumber` come from the in-memory `calls` map

### Phase 6.2 — Client-side conference mixing
- Use `AudioContext` to mix
- For each call: send (mic + sum of OTHER calls' incoming) to that call's
  outgoing audio track
- For each call: route incoming to user's speaker
- This is what the PJSIP reference dialer does, just in JavaScript

## Verification steps after deploy

1. `npm install` picks up `jssip`.
2. Visit dialer URL — header should show **Online** (green) within a few
   seconds, same as before. If it shows "Connecting…" or "Offline", check
   the browser console for `[sip]` lines.
3. Make an outbound call — should work like the old SDK.
4. Receive an inbound call (have someone dial `+1 732 200 1305`) — should
   ring with the same full-screen UI.
5. During a call: try Mute, Hold/Resume, Keypad (DTMF), Transfer, Hangup.

## Rollback

If JsSIP doesn't authenticate against Telnyx, the fastest rollback is to
restore the previous `sip.ts` via `git`:

```bash
git log --oneline apps/web/src/services/sip.ts | head -5
git checkout <SHA-before-jssip> -- apps/web/src/services/sip.ts
```

The `@telnyx/webrtc` dependency is intentionally kept in `package.json` for
exactly this reason. Once Phase 6.0 is verified working, we can remove it.
