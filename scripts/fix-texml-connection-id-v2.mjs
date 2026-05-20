// Convert TexML Sip URI from the connection-name subdomain form to the
// Connection ID form (works regardless of subdomain config on the
// Credentials Connection).
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

// Replace the URI: from `${sipUser}@${sipConnectionName}.sip.telnyx.com`
// to `${sipConnectionId}@sip.telnyx.com`.
const oldUri = '    <Sip>sip:${xmlEscape(sipUser)}@${xmlEscape(sipConnectionName)}.sip.telnyx.com</Sip>';
const newUri = '    <Sip>sip:${xmlEscape(sipConnectionId)}@sip.telnyx.com</Sip>';

if (count(text, oldUri) !== 1) {
  console.log(`ABORT: expected 1 match of subdomain URI line, got ${count(text, oldUri)}.`);
  console.log('Current Sip line(s) in file:');
  const matches = text.match(/<Sip>.*<\/Sip>/g);
  if (matches) matches.forEach(m => console.log('  ', m));
  process.exit(1);
}
text = text.replace(oldUri, newUri);

// Rename the const and update the env var name + default value.
const oldConnLine = "  const sipConnectionName = process.env.PILOT_SIP_CONNECTION_NAME ?? 'ace-dialer';";
const newConnLine = "  const sipConnectionId = process.env.PILOT_SIP_CONNECTION_ID ?? '2960617014202206103';";
if (count(text, oldConnLine) !== 1) {
  console.log(`ABORT: expected 1 match of connectionName const, got ${count(text, oldConnLine)}.`);
  process.exit(1);
}
text = text.replace(oldConnLine, newConnLine);

writeFileSync(file, text, 'utf8');
console.log('Patched: TexML <Sip> URI now uses Connection ID 2960617014202206103.');
console.log('');
console.log('Verify:  git diff apps/webhooks/src/main.ts');
