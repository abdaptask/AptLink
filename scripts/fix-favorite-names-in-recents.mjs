// Phase 6.10 — show favorite contact name everywhere we display a caller
// label (Recents, IncomingCall full-screen + banner, InCall).
//
// Lookup priority for the display name:
//   1. Favorite (firstName + lastName, or label)  ← new highest priority
//   2. JobDiva contact name (existing useJobDivaContact hook)
//   3. Formatted phone number (fallback)
//
// Adds a single helper getFavoriteName(phone) to userPrefs.ts and uses it
// directly. We don't need a separate hook — getFavorites() reads from
// localStorage synchronously, and pages already re-render on the
// 'ace:favoritesChanged' event (Recents does, IncomingCall mounts fresh
// per call so it picks up new favorites automatically).

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function readFile(rel) {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}
function writeFile(rel, content) {
  writeFileSync(resolve(repoRoot, rel), content, 'utf8');
}
function count(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// ---------- 1. Add getFavoriteName helper to userPrefs.ts -------------------

const prefsPath = 'apps/web/src/lib/userPrefs.ts';
let prefs = readFile(prefsPath);
const nl = prefs.includes('\r\n') ? '\r\n' : '\n';

if (prefs.includes('export function getFavoriteName')) {
  console.log('userPrefs.ts: getFavoriteName already present');
} else {
  // Insert right after isFavorite() so the favorite-related helpers stay grouped.
  const anchor = [
    'export function isFavorite(phone: string): boolean {',
    '  if (!phone) return false;',
    '  const target = normalizeFavoritePhone(phone);',
    '  if (!target) return false;',
    '  return getFavorites().some((f) => normalizeFavoritePhone(f.phone) === target);',
    '}',
  ].join(nl);
  const insertion = [
    'export function isFavorite(phone: string): boolean {',
    '  if (!phone) return false;',
    '  const target = normalizeFavoritePhone(phone);',
    '  if (!target) return false;',
    '  return getFavorites().some((f) => normalizeFavoritePhone(f.phone) === target);',
    '}',
    '',
    '/**',
    ' * Phase 6.10 — return the friendly name saved for a phone number in',
    ' * Favorites, or null if the number isn\'t favorited. Used in Recents,',
    ' * IncomingCall, and InCall to show "Adam Smith" instead of the raw',
    ' * number when the caller is in the user\'s favorites list.',
    ' *',
    ' * Lookup order inside a favorite:',
    ' *   1. firstName + lastName  (most common — what the Add Favorite modal saves)',
    ' *   2. label                 (legacy back-compat)',
    ' *   3. null                  (favorite exists but no name attached)',
    ' */',
    'export function getFavoriteName(phone: string | null | undefined): string | null {',
    '  if (!phone) return null;',
    '  const target = normalizeFavoritePhone(phone);',
    '  if (!target) return null;',
    '  const match = getFavorites().find((f) => normalizeFavoritePhone(f.phone) === target);',
    '  if (!match) return null;',
    "  const full = [match.firstName, match.lastName].filter(Boolean).join(' ').trim();",
    '  if (full) return full;',
    '  if (match.label) return match.label;',
    '  return null;',
    '}',
  ].join(nl);
  if (count(prefs, anchor) !== 1) {
    console.log('ABORT: isFavorite anchor not found exactly once in userPrefs.ts');
    process.exit(1);
  }
  prefs = prefs.replace(anchor, insertion);
  writeFile(prefsPath, prefs);
  console.log('userPrefs.ts: added getFavoriteName helper');
}

// ---------- 2. Wire into Recents.tsx ----------------------------------------

const recentsPath = 'apps/web/src/pages/Recents.tsx';
let recents = readFile(recentsPath);

if (!recents.includes('getFavoriteName')) {
  // Add to the import line that already pulls addFavorite/isFavorite/removeFavorite.
  const oldImp = "import { addFavorite, isFavorite, removeFavorite } from '../lib/userPrefs';";
  const newImp = "import { addFavorite, isFavorite, removeFavorite, getFavoriteName } from '../lib/userPrefs';";
  if (count(recents, oldImp) !== 1) {
    console.log('ABORT: Recents userPrefs import line not found exactly once');
    process.exit(1);
  }
  recents = recents.replace(oldImp, newImp);

  // Display name now prefers favorite over jobdiva.
  const oldDisplay = '  const displayName = jd?.name ?? formatNumber(number);';
  const newDisplay = '  const displayName = getFavoriteName(number) ?? jd?.name ?? formatNumber(number);';
  if (count(recents, oldDisplay) !== 1) {
    console.log('ABORT: Recents displayName line not found exactly once');
    process.exit(1);
  }
  recents = recents.replace(oldDisplay, newDisplay);

  writeFile(recentsPath, recents);
  console.log('Recents.tsx: now prefers favorite name');
} else {
  console.log('Recents.tsx: getFavoriteName already wired');
}

// ---------- 3. Wire into IncomingCall.tsx -----------------------------------

const incomingPath = 'apps/web/src/components/IncomingCall.tsx';
let incoming = readFile(incomingPath);

if (!incoming.includes('getFavoriteName')) {
  // Add a brand-new import (this file doesn't import from userPrefs yet).
  const oldImp = "import { formatPhone } from '../lib/phone';";
  const newImp = [
    "import { formatPhone } from '../lib/phone';",
    "import { getFavoriteName } from '../lib/userPrefs';",
  ].join(nl);
  if (count(incoming, oldImp) !== 1) {
    console.log('ABORT: IncomingCall phone import line not found exactly once');
    process.exit(1);
  }
  incoming = incoming.replace(oldImp, newImp);

  const oldLabel = '  const callerLabel = jd?.name ?? formatNumber(callerNumber);';
  const newLabel = '  const callerLabel = getFavoriteName(callerNumber) ?? jd?.name ?? formatNumber(callerNumber);';
  if (count(incoming, oldLabel) !== 1) {
    console.log('ABORT: IncomingCall callerLabel line not found exactly once');
    process.exit(1);
  }
  incoming = incoming.replace(oldLabel, newLabel);

  writeFile(incomingPath, incoming);
  console.log('IncomingCall.tsx: now prefers favorite name');
} else {
  console.log('IncomingCall.tsx: getFavoriteName already wired');
}

// ---------- 4. Wire into InCall.tsx -----------------------------------------

const incallPath = 'apps/web/src/pages/InCall.tsx';
let incall = readFile(incallPath);

if (!incall.includes('getFavoriteName')) {
  // Find the existing userPrefs import (it should have one for hold music or theme).
  // If we can't find one to extend, add a fresh import after the phone import.
  const userPrefsImportRe = /import\s+\{([^}]+)\}\s+from\s+['"]\.\.\/lib\/userPrefs['"];/;
  if (userPrefsImportRe.test(incall)) {
    // Append getFavoriteName to the existing import list.
    incall = incall.replace(userPrefsImportRe, (m, inside) => {
      if (inside.includes('getFavoriteName')) return m;
      const trimmed = inside.trim();
      return m.replace(inside, ` ${trimmed}, getFavoriteName `);
    });
  } else {
    // No existing import — add a new one after the first './' import.
    const firstImpRe = /(import .* from '\.\.\/[^']+';)/;
    if (!firstImpRe.test(incall)) {
      console.log('ABORT: InCall.tsx has no relative imports to anchor against');
      process.exit(1);
    }
    incall = incall.replace(firstImpRe, `$1${nl}import { getFavoriteName } from '../lib/userPrefs';`);
  }

  const oldLabel = "  const callerLabel = jd?.name ?? (formatNumber(otherNumber) || 'Calling…');";
  const newLabel = "  const callerLabel = getFavoriteName(otherNumber) ?? jd?.name ?? (formatNumber(otherNumber) || 'Calling…');";
  if (count(incall, oldLabel) !== 1) {
    console.log('ABORT: InCall callerLabel line not found exactly once');
    process.exit(1);
  }
  incall = incall.replace(oldLabel, newLabel);

  writeFile(incallPath, incall);
  console.log('InCall.tsx: now prefers favorite name');
} else {
  console.log('InCall.tsx: getFavoriteName already wired');
}

console.log('');
console.log('Done. Verify:');
console.log('  git diff apps/web/src/lib/userPrefs.ts apps/web/src/pages/Recents.tsx \\');
console.log('          apps/web/src/components/IncomingCall.tsx apps/web/src/pages/InCall.tsx');
