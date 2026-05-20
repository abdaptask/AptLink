// Revert the connection-name subdomain experiment. With "Receive SIP URI
// calls" enabled on the SIP Connection (Telnyx Portal), the simpler
// sip:user@sip.telnyx.com form works. The Telnyx Support example was
// using a generic placeholder, not a literal account-specific subdomain.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '..', 'apps', 'webhooks', 'src', 'main.ts');
let text = readFileSync(file, 'utf8');
const nl = text.includes('\r\n') ? '\r\n' : '\n';

const oldUri = '    <Sip>sip:${xmlEscape(sipUser)}@${xmlEscape(sipConnectionName)}.sip.telnyx.com</Sip>';
const newUri = '    <Sip>sip:${xmlEscape(sipUser)}@sip.telnyx.com</Sip>';

function count(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

if (count(text, oldUri) !== 1) {
  console.log(`ABORT: expected 1 match of the connection-name URI, found ${count(text, oldUri)}.`);
  process.exit(1);
}
text = text.replace(oldUri, newUri);
writeFileSync(file, text, 'utf8');
console.log('Reverted <Sip> URI back to sip:user@sip.telnyx.com');
console.log('(This works because "Receive SIP URI calls" is now enabled on the connection.)');
console.log('');
console.log('Note: the sipConnectionName variable is now unused but harmless. Leave it');
console.log('in place — we may need it back if Telnyx changes routing semantics.');
