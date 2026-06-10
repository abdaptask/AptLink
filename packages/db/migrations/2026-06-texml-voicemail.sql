-- ============================================================================
-- v0.10.119 — TeXML voicemail migration tracking + SystemConfig
--
-- Adds one column to user_dids:
--   1. texml_migrated_at — timestamp when the DID was switched onto the new
--      TeXML voicemail flow (NULL = on legacy Hosted VM or Call Control).
--      Mutually exclusive with call_control_migrated_at in practice — the
--      admin migration endpoint refuses to migrate to TeXML if Call Control
--      migration is active, and vice versa.
--
-- Greetings are NOT stored per-DID. The v0.10.100 stack (already shipped)
-- stores greetings at the User level under voicemail_greeting_* and
-- voicemail_busy_greeting_* columns. The TeXML voicemail flow reuses those.
--
-- Adds new system_config key/value table for runtime-derived settings.
-- First consumer: the Telnyx TeXML Application ID, ensured / created at
-- webhooks-service boot.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS. Safe
-- to re-run.
-- ============================================================================

-- ── 1. user_dids new column ─────────────────────────────────────────────────
ALTER TABLE user_dids
  ADD COLUMN IF NOT EXISTS texml_migrated_at   TIMESTAMPTZ;

-- ── 2. system_config table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Updated_at trigger pattern — mirrors how other models use Prisma's
-- @updatedAt. Prisma sets this in app code; we don't need a DB trigger.
-- (Documented here so future devs don't add one and double-write.)
