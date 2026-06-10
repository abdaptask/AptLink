-- ============================================================================
-- v0.10.119 — TeXML voicemail migration tracking + per-DID greeting + SystemConfig
--
-- Adds three columns to user_dids:
--   1. texml_migrated_at — timestamp when the DID was switched onto the new
--      TeXML voicemail flow (NULL = on legacy Hosted VM or Call Control).
--      Mutually exclusive with call_control_migrated_at in practice — the
--      admin migration endpoint refuses to migrate to TeXML if Call Control
--      migration is active, and vice versa.
--   2. greeting_url — public URL (Supabase Storage) of the user-recorded
--      voicemail greeting MP3. NULL = TeXML uses a Polly TTS default.
--   3. greeting_updated_at — when the greeting was last replaced.
--
-- Adds new system_config key/value table for runtime-derived settings.
-- First consumer: the Telnyx TeXML Application ID, ensured / created at
-- webhooks-service boot.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- ============================================================================

-- ── 1. user_dids new columns ────────────────────────────────────────────────
ALTER TABLE user_dids
  ADD COLUMN IF NOT EXISTS texml_migrated_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS greeting_url        TEXT,
  ADD COLUMN IF NOT EXISTS greeting_updated_at TIMESTAMPTZ;

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
