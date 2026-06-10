// ===========================================================================
// apply-sql-migration.ts - apply one of our raw SQL migration files against
// the database referenced by DATABASE_URL. Reads .env at repo root (same as
// db:push), so the same connection string used by the apps gets used here.
//
// Usage (any one of these works):
//   npx tsx packages/db/scripts/apply-sql-migration.ts migrations/2026-06-texml-voicemail.sql
//   npx tsx packages/db/scripts/apply-sql-migration.ts packages/db/migrations/2026-06-texml-voicemail.sql
//   npx tsx packages/db/scripts/apply-sql-migration.ts /abs/path/to/file.sql
//
// We resolve the path by trying multiple candidates (cwd-relative, repo-
// root-relative, and absolute), since npm workspaces sets cwd to the
// workspace dir which makes "packages/db/migrations/..." double-path.
//
// IMPORTANT: Prisma\'s $executeRawUnsafe goes through a prepared statement
// which PostgreSQL does NOT allow multiple commands in. So we split the
// SQL file into individual statements (terminated by ";") and run each
// one separately. To keep this simple and predictable for our migration
// style, we:
//   1. Strip "--" line comments out of the file first
//   2. Then split on ";" (any whitespace after)
//   3. Trim + skip empties
//   4. Execute each non-empty statement
// This works for our hand-written idempotent migrations. It would break
// if a migration ever embedded a semicolon inside a string literal, but
// our files don\'t do that.
//
// We do NOT use Prisma migrate engine because this repo\'s history uses raw
// SQL files under packages/db/migrations/. Each migration should be
// idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS) so
// re-running is safe.
// ===========================================================================

import { existsSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { PrismaClient } from '@prisma/client';

function findSqlFile(arg: string): string | null {
  const candidates: string[] = [];
  if (isAbsolute(arg)) {
    candidates.push(arg);
  } else {
    candidates.push(resolve(process.cwd(), arg));
    if (arg.startsWith('packages/db/')) {
      candidates.push(resolve(process.cwd(), arg.slice('packages/db/'.length)));
    }
    candidates.push(resolve(process.cwd(), '..', '..', arg));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// Strip "-- comment" lines from a SQL file, then split on ";".
// Returns an array of non-empty trimmed statements (without trailing ";").
function splitStatements(sql: string): string[] {
  const noComments = sql
    .split('\n')
    .map((line) => {
      // Find the first "--" that isn\'t inside a string literal. For our
      // hand-written migrations we don\'t use "--" inside strings, so a
      // simple find-and-truncate is safe.
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
  return noComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: tsx apply-sql-migration.ts <path-to-sql-file>');
    process.exit(2);
  }
  const sqlPath = findSqlFile(arg);
  if (!sqlPath) {
    console.error(`Failed to locate "${arg}" - tried cwd-relative + repo-root-relative + absolute.`);
    console.error(`cwd: ${process.cwd()}`);
    process.exit(2);
  }
  const sql = readFileSync(sqlPath, 'utf-8');
  console.log(`[migration] ${sqlPath} (${sql.length} bytes)`);

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Did you forget --env-file=../../.env?');
    process.exit(2);
  }

  const statements = splitStatements(sql);
  console.log(`[migration] ${statements.length} statement(s) to execute`);

  const prisma = new PrismaClient();
  try {
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]!;
      const firstLine = stmt.split('\n')[0]!.slice(0, 80);
      console.log(`[migration] [${i + 1}/${statements.length}] ${firstLine}${firstLine.length >= 80 ? '...' : ''}`);
      await prisma.$executeRawUnsafe(stmt);
    }
    console.log('[migration] applied successfully');
  } catch (e) {
    console.error('[migration] failed:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
