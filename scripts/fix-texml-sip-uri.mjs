// Telnyx confirmed the correct TexML <Sip> URI for Credentials Connections is
//   sip:<sip_username>@<connection_name>.sip.telnyx.com
// Not just sip:user@sip.telnyx.com (which is why we got DialCallStatus=busy
// for every test call — Telnyx couldn't resolve which Connection to deliver
// the INVITE to, so it fast-failed).
//
// Fix: update texmlHandler to use the connection-name-as-subdomain pattern.
// Add a PILOT_SIP_CONNECTION_NAME env var (default 'ace-dialer') so this is
// easy to switch if the connection is renamed.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '..', 'apps', 'webhooks', 'src', 'main.ts');
let text = readFileSync(file, 'utf8');
const nl = text.includes('\r\n') ? '\r\n' : '\n';

const oldBlock = [
  "  const sipUser = process.env.PILOT_SIP_USERNAME ?? '';",
  '  if (!sipUser) {',
  "    app.log.warn('[texml] PILOT_SIP_USERNAME not set; returning hangup-only flow');",
  '  }',
].join(nl);

const newBlock = [
  "  const sipUser = process.env.PILOT_SIP_USERNAME ?? '';",
  "  // Phase 6.7 - per Telnyx Support: the TexML <Sip> URI must include the",
  "  // SIP Connection name as a subdomain so Telnyx can locate the registered",
  "  // Credentials Connection endpoint. Just `sip.telnyx.com` returns busy.",
  "  // Example: sip:userabdulla74993@ace-dialer.sip.telnyx.com",
  "  const sipConnectionName = process.env.PILOT_SIP_CONNECTION_NAME ?? 'ace-dialer';",
  '  if (!sipUser) {',
  "    app.log.warn('[texml] PILOT_SIP_USERNAME not set; returning hangup-only flow');",
  '  }',
].join(nl);

function count(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

if (count(text, oldBlock) !== 1) {
  console.log(`ABORT: old sipUser block not found exactly once (got ${count(text, oldBlock)}).`);
  process.exit(1);
}
text = text.replace(oldBlock, newBlock);

// Now swap the URI in the TexML response itself.
const oldUri = '    <Sip>sip:${xmlEscape(sipUser)}@sip.telnyx.com</Sip>';
const newUri = '    <Sip>sip:${xmlEscape(sipUser)}@${xmlEscape(sipConnectionName)}.sip.telnyx.com</Sip>';
if (count(text, oldUri) !== 1) {
  console.log(`ABORT: old <Sip> URI line not found exactly once (got ${count(text, oldUri)}).`);
  process.exit(1);
}
text = text.replace(oldUri, newUri);

writeFileSync(file, text, 'utf8');
console.log('Patched main.ts: TexML <Sip> URI now uses connection-name subdomain.');
console.log('');
console.log('Required: set PILOT_SIP_CONNECTION_NAME on Render webhooks env if your');
console.log('SIP Connection is NOT named "ace-dialer". Default works for the current setup.');
console.log('');
console.log('Verify with: curl -X POST https://ace-dialer-webhooks.onrender.com/texml/inbound');
console.log('Expected: <Sip>sip:userabdulla74993@ace-dialer.sip.telnyx.com</Sip>');
