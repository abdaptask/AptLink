// Two fixes:
//
//   A) call.hangup must NOT overwrite a row whose status is already 'blocked'.
//      Otherwise the blocked-call row gets relabeled to 'rejected' when our
//      reject API call generates a subsequent call.hangup webhook, and the
//      Recents UI shows "Declined" instead of "Blocked".
//
//   B) calls.voicemail.completed should DROP voicemail recordings whose
//      from-number is on the user's blocklist. Telnyx's Hosted Voicemail
//      still triggers on USER_BUSY (per Telnyx Support), so blocked callers
//      can leave voicemails. We silently discard those recordings server-side
//      so they never appear in the user's voicemail tab.

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

// --- A. preserve blocked status -----------------------------------------------

if (text.includes('// Phase 6.12 - preserve blocked status')) {
  console.log('A. preserve-blocked-status already present, skipping');
} else {
  const oldHangup = [
    '        // Try update first; if no record (we missed call.initiated), insert.',
    '        const updated = await prisma.call.updateMany({',
    '          where: { telnyxCallId: callId },',
    '          data: {',
    '            status,',
    '            endedAt,',
    '            durationSeconds: duration,',
    '            hangupCause,',
    '            hangupSource: payload.hangup_source ?? null,',
    '          },',
    '        });',
  ].join(nl);
  const newHangup = [
    '        // Phase 6.12 - preserve blocked status. If the row was already',
    "        // marked 'blocked' by call.initiated (because the caller is on",
    '        // the recipient\'s blocklist), do NOT let the subsequent hangup',
    '        // event downgrade it to "rejected" or "completed". Only update',
    '        // the bookkeeping fields (endedAt / duration / cause), leave the',
    '        // status field alone.',
    '        const existing = await prisma.call.findUnique({',
    '          where: { telnyxCallId: callId },',
    '          select: { status: true },',
    '        });',
    "        const preserveStatus = existing?.status === 'blocked';",
    '        const updated = await prisma.call.updateMany({',
    '          where: { telnyxCallId: callId },',
    '          data: {',
    '            ...(preserveStatus ? {} : { status }),',
    '            endedAt,',
    '            durationSeconds: duration,',
    '            hangupCause,',
    '            hangupSource: payload.hangup_source ?? null,',
    '          },',
    '        });',
  ].join(nl);

  if (count(text, oldHangup) !== 1) {
    console.log(`ABORT(A): call.hangup update block not found exactly once (got ${count(text, oldHangup)}).`);
    process.exit(1);
  }
  text = text.replace(oldHangup, newHangup);
  console.log('A. preserved blocked status on call.hangup');
}

// --- B. drop voicemails from blocked numbers ----------------------------------

if (text.includes('// Phase 6.12 - drop blocked voicemails')) {
  console.log('B. drop-blocked-voicemails already present, skipping');
} else {
  // Insert right before the prisma.voicemail.create call. Find the unique
  // line that prepares ownerUserId for the voicemail.
  const oldCreate = [
    '    // Phase 5.7 — route the voicemail to the user that owns the called DID.',
    '    const ownerUserId = await resolveUserId({ toNumber, fromNumber });',
    '    await prisma.voicemail.create({',
  ].join(nl);
  const newCreate = [
    '    // Phase 5.7 — route the voicemail to the user that owns the called DID.',
    '    const ownerUserId = await resolveUserId({ toNumber, fromNumber });',
    '',
    '    // Phase 6.12 - drop blocked voicemails. Telnyx Hosted Voicemail still',
    '    // triggers on USER_BUSY (Telnyx Support confirmed they can\'t disable',
    "    // that trigger), so a blocked caller's recording arrives here. Drop",
    '    // it silently — the user never sees it.',
    '    if (await isFromNumberBlockedForUser(ownerUserId, fromNumber)) {',
    '      app.log.info(',
    '        { ownerUserId, fromNumber, telnyxCallId },',
    "        '[blocked] voicemail from blocked number - dropping',",
    '      );',
    '      return { received: true };',
    '    }',
    '',
    '    await prisma.voicemail.create({',
  ].join(nl);
  if (count(text, oldCreate) !== 1) {
    console.log(`ABORT(B): voicemail create block not found exactly once (got ${count(text, oldCreate)}).`);
    process.exit(1);
  }
  text = text.replace(oldCreate, newCreate);
  console.log('B. drop voicemails from blocked numbers');
}

writeFileSync(file, text, 'utf8');
console.log('');
console.log('Patched apps/webhooks/src/main.ts.');
console.log('New line count:', text.split(nl).length);
