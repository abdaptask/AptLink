// The previous URI form `sip:<sip_username>@sip.telnyx.com` caused Telnyx
// to route back to the DID (because the username is associated with the
// DID-owning SIP Connection), creating an infinite TexML fetch loop.
//
// Use the SIP Connection ID instead: `sip:<connection_id>@sip.telnyx.com`.
// This routes directly to the connection's registered Contact without
// re-running DID routing logic.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '..', 'apps', 'webhooks', 'src', 'main.ts');
let text = readFileSync(file, 'utf8');
const nl = text.includes('\r\n') ? '\r\n' : '\n';

// Replace the URI back to use the connection ID instead of username.
const oldUri = '    <Sip>sip:${xmlEscape(sipUser)}@sip.telnyx.com</Sip>';
const newUri = '    <Sip>sip:${xmlEscape(sipConnectionId)}@sip.telnyx.com</Sip>';

function count(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

if (count(text, oldUri) !== 1) {
  console.log(`ABORT: expected 1 match of <Sip>...@sip.telnyx.com line, got ${count(text, oldUri)}.`);
  process.exit(1);
}
text = text.replace(oldUri, newUri);

// Also add a sipConnectionId const. Replace the connectionName line.
const oldConnLine = "  const sipConnectionName = process.env.PILOT_SIP_CONNECTION_NAME ?? 'ace-dialer';";
const newConnLine = "  const sipConnectionId = process.env.PILOT_SIP_CONNECTION_ID ?? '2960617014202206103';";
if (count(text, oldConnLine) !== 1) {
  console.log(`ABORT: expected 1 match of connectionName const, got ${count(text, oldConnLine)}.`);
  process.exit(1);
}
text = text.replace(oldConnLine, newConnLine);

writeFileSync(file, text, 'utf8');
console.log('Patched: TexML <Sip> URI now uses Connection ID instead of username.');
console.log('Default Connection ID baked in: 2960617014202206103');
console.log('Override at runtime via PILOT_SIP_CONNECTION_ID env var on Render.');
