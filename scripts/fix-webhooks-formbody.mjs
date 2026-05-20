// Telnyx sends TexML callbacks with Content-Type: application/x-www-form-urlencoded.
// Our Fastify webhooks service only has the default JSON body parser, so the
// server returns 415 Unsupported Media Type on Telnyx's POSTs. Telnyx
// translates that into the audible "we are sorry, an application error has
// occurred" message to the caller.
//
// Fix: add @fastify/formbody and register it before routes.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// --- 1. Update apps/webhooks/package.json -----------------------------------

const pkgFile = resolve(repoRoot, 'apps', 'webhooks', 'package.json');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
if (pkg.dependencies['@fastify/formbody']) {
  console.log('package.json: @fastify/formbody already present');
} else {
  pkg.dependencies['@fastify/formbody'] = '^7.4.0';
  // Re-sort dependencies alphabetically so the diff is clean
  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('package.json: added @fastify/formbody ^7.4.0');
}

// --- 2. Update apps/webhooks/src/main.ts ------------------------------------

const mainFile = resolve(repoRoot, 'apps', 'webhooks', 'src', 'main.ts');
let main = readFileSync(mainFile, 'utf8');
const nl = main.includes('\r\n') ? '\r\n' : '\n';

function count(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

if (main.includes('@fastify/formbody')) {
  console.log('main.ts: @fastify/formbody already imported');
} else {
  // Add import after the cors import
  const oldImport = "import cors from '@fastify/cors';";
  const newImport = [
    "import cors from '@fastify/cors';",
    "import formbody from '@fastify/formbody';",
  ].join(nl);
  if (count(main, oldImport) !== 1) {
    console.log('ABORT: cors import line not found exactly once');
    process.exit(1);
  }
  main = main.replace(oldImport, newImport);

  // Register formbody right after cors registration. Same line of code in
  // main.ts: `await app.register(cors, { origin: false });`.
  const oldReg = 'await app.register(cors, { origin: false });';
  const newReg = [
    'await app.register(cors, { origin: false });',
    '// Phase 6.6 - parse application/x-www-form-urlencoded bodies.',
    "// Required for Telnyx TexML callbacks (Telnyx sends form-encoded POSTs",
    "// to action URLs like /texml/dial-status). Without this, Fastify returns",
    '// 415 Unsupported Media Type and Telnyx plays the "application error" prompt.',
    'await app.register(formbody);',
  ].join(nl);
  if (count(main, oldReg) !== 1) {
    console.log('ABORT: cors register line not found exactly once');
    process.exit(1);
  }
  main = main.replace(oldReg, newReg);

  writeFileSync(mainFile, main, 'utf8');
  console.log('main.ts: imported + registered @fastify/formbody');
}

console.log('');
console.log('Done. Next steps:');
console.log('  cd apps/webhooks && npm install     # so the dep is in package-lock');
console.log('  cd ../..');
console.log('  git diff');
console.log('  git commit -am "Add @fastify/formbody so Telnyx TexML POSTs parse correctly"');
console.log('  git push');
