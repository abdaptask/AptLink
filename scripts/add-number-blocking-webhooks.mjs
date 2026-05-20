// Phase 6.8 — add number blocking to apps/webhooks/src/main.ts:
//   1. hangupCallByControlId helper (Telnyx Call Control API call)
//   2. isFromNumberBlockedForUser helper (DB lookup by last-10 digits)
//   3. block check in 'call.initiated' (hang up + store with status='blocked')
//   4. block check in 'message.received' (drop SMS silently)
//
// Safe to re-run: aborts cleanly if any old block isn't found exactly once.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '..', 'apps', 'webhooks', 'src', 'main.ts');
let text = readFileSync(file, 'utf8');
const nl = text.includes('\r\n') ? '\r\n' : '\n';

function count(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

if (text.includes('isFromNumberBlockedForUser')) {
  console.log('ABORT: number-blocking edits already present in main.ts.');
  process.exit(1);
}

// --- 1+2. Insert helpers before bridgeLegs --------------------------------

const oldHelperAnchor = 'async function bridgeLegs(legA: string, legB: string): Promise<{ ok: boolean; status?: number; error?: unknown }> {';
if (count(text, oldHelperAnchor) !== 1) {
  console.log('ABORT: bridgeLegs anchor not found exactly once.');
  process.exit(1);
}
const helpers = [
  '// Phase 6.8 - number blocking: hang up an inbound call that the recipient',
  '// has blacklisted. Uses Telnyx Call Control hangup API. Fail-open: if the',
  "// API key isn't set or the request fails, we just log and let the call",
  '// continue to the SIP endpoint - better to ring a legit call than to',
  '// silently drop one due to a server-side hiccup.',
  'async function hangupCallByControlId(',
  '  callControlId: string,',
  '): Promise<{ ok: boolean; status?: number; error?: unknown }> {',
  "  if (!TELNYX_API_KEY) return { ok: false, error: 'TELNYX_API_KEY not set on webhooks service' };",
  '  const res = await fetch(',
  '    `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`,',
  '    {',
  "      method: 'POST',",
  '      headers: {',
  "        'Content-Type': 'application/json',",
  '        Authorization: `Bearer ${TELNYX_API_KEY}`,',
  '      },',
  '      body: JSON.stringify({}),',
  '    },',
  '  );',
  '  const body = await res.json().catch(() => ({}));',
  '  return { ok: res.ok, status: res.status, ...(res.ok ? {} : { error: body }) };',
  '}',
  '',
  "// Phase 6.8 - number blocking: check whether `fromNumber` is on `userId`'s",
  '// blocklist. Compares last-10 digits to tolerate carrier formatting',
  '// differences. Fail-open: any DB error returns false (allow the call).',
  'async function isFromNumberBlockedForUser(',
  '  userId: number,',
  '  fromNumber: string | null | undefined,',
  '): Promise<boolean> {',
  '  if (!fromNumber || !userId) return false;',
  "  const last10 = fromNumber.replace(/[^\\d]/g, '').slice(-10);",
  '  if (!last10) return false;',
  '  try {',
  '    const rows = await prisma.blockedNumber.findMany({',
  '      where: { userId },',
  '      select: { number: true },',
  '    });',
  "    return rows.some((r) => r.number.replace(/[^\\d]/g, '').slice(-10) === last10);",
  '  } catch (e) {',
  "    console.warn('[blocked] lookup failed; treating as not blocked', e);",
  '    return false;',
  '  }',
  '}',
  '',
  oldHelperAnchor,
].join(nl);

text = text.replace(oldHelperAnchor, helpers);

// --- 3. Block check in 'call.initiated' -----------------------------------

const oldInitiated = [
  "      case 'call.initiated': {",
  '        const ownerUserId = await resolveUserId({',
  '          sipUsername: payload.sip_username ?? payload.client_username ?? null,',
  '          fromNumber,',
  '          toNumber,',
  '        });',
  '        await prisma.call.upsert({',
  '          where: { telnyxCallId: callId },',
  '          update: {',
  "            status: 'initiated',",
  '            ...(callControlId ? { callControlId } : {}),',
  '          },',
  '          create: {',
  '            userId: ownerUserId,',
  '            telnyxCallId: callId,',
  '            sessionId: payload.call_session_id ?? null,',
  '            callControlId: callControlId ?? null,',
  '            direction,',
  '            fromNumber,',
  '            toNumber,',
  "            status: 'initiated',",
  '            startedAt: payload.start_time ? new Date(payload.start_time) : new Date(),',
  '          },',
  '        });',
  '',
  '        break;',
  '      }',
].join(nl);

const newInitiated = [
  "      case 'call.initiated': {",
  '        const ownerUserId = await resolveUserId({',
  '          sipUsername: payload.sip_username ?? payload.client_username ?? null,',
  '          fromNumber,',
  '          toNumber,',
  '        });',
  '',
  '        // Phase 6.8 - number blocking: for INBOUND calls only, check if',
  '        // the recipient user has blocked the caller. If so, hang up at',
  '        // the Telnyx layer and store the row with status=blocked so the',
  '        // user sees it in Recents.',
  '        const blocked =',
  "          direction === 'inbound' &&",
  '          (await isFromNumberBlockedForUser(ownerUserId, fromNumber));',
  '        if (blocked) {',
  '          app.log.info(',
  '            { ownerUserId, fromNumber, callControlId },',
  "            '[blocked] inbound call from blocked number - hanging up',",
  '          );',
  '          if (callControlId) {',
  '            void hangupCallByControlId(callControlId).catch((e) =>',
  "              app.log.warn({ err: e }, '[blocked] hangup API failed'),",
  '            );',
  '          }',
  '        }',
  '',
  '        await prisma.call.upsert({',
  '          where: { telnyxCallId: callId },',
  '          update: {',
  "            status: blocked ? 'blocked' : 'initiated',",
  '            ...(callControlId ? { callControlId } : {}),',
  '          },',
  '          create: {',
  '            userId: ownerUserId,',
  '            telnyxCallId: callId,',
  '            sessionId: payload.call_session_id ?? null,',
  '            callControlId: callControlId ?? null,',
  '            direction,',
  '            fromNumber,',
  '            toNumber,',
  "            status: blocked ? 'blocked' : 'initiated',",
  '            startedAt: payload.start_time ? new Date(payload.start_time) : new Date(),',
  '          },',
  '        });',
  '',
  '        break;',
  '      }',
].join(nl);

if (count(text, oldInitiated) !== 1) {
  console.log(`ABORT: call.initiated block not found exactly once (got ${count(text, oldInitiated)}).`);
  process.exit(1);
}
text = text.replace(oldInitiated, newInitiated);

// --- 4. Block check in 'message.received' ---------------------------------

const oldReceived = [
  "      case 'message.received': {",
  '        // Inbound: from = the PSTN caller, to = our DID. Route to whichever',
  '        // user owns this DID (Phase 5.7 multi-user).',
  '        const threadKey = fromNumber; // the other party',
  '        const ownerUserId = await resolveUserId({ toNumber, fromNumber });',
  '        await prisma.message.upsert({',
].join(nl);

const newReceived = [
  "      case 'message.received': {",
  '        // Inbound: from = the PSTN caller, to = our DID. Route to whichever',
  '        // user owns this DID (Phase 5.7 multi-user).',
  '        const threadKey = fromNumber; // the other party',
  '        const ownerUserId = await resolveUserId({ toNumber, fromNumber });',
  '',
  '        // Phase 6.8 - number blocking: silently drop SMS from blocked',
  '        // senders. We ack the webhook (Telnyx requires 200) but skip',
  "        // storing the message, so it never appears in the user's inbox.",
  '        if (await isFromNumberBlockedForUser(ownerUserId, fromNumber)) {',
  '          app.log.info(',
  '            { ownerUserId, fromNumber, telnyxMessageId },',
  "            '[blocked] inbound SMS from blocked number - dropping',",
  '          );',
  '          break;',
  '        }',
  '',
  '        await prisma.message.upsert({',
].join(nl);

if (count(text, oldReceived) !== 1) {
  console.log(`ABORT: message.received block not found exactly once (got ${count(text, oldReceived)}).`);
  process.exit(1);
}
text = text.replace(oldReceived, newReceived);

// --- write ---------------------------------------------------------------

writeFileSync(file, text, 'utf8');
console.log('Patched apps/webhooks/src/main.ts with number-blocking checks.');
console.log('New line count:', text.split(nl).length);
