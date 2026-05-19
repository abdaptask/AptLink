-- Phase 5.7 — Multi-user support.
-- Adds per-user routing fields so the webhook service can look up which user
-- a call/SMS belongs to instead of hardcoding userId=1.
--
-- Run this in Supabase SQL editor:
--   1. Paste this whole file
--   2. Click Run
--   3. Then update the pilot user's row with the values shown in the
--      "Backfill pilot user" block below.

-- 1. Add the new columns (nullable so existing rows are fine).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sip_username TEXT,
  ADD COLUMN IF NOT EXISTS did_number   TEXT;

-- 2. Add UNIQUE constraints (a SIP username + DID are per-user).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_sip_username_key'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_sip_username_key UNIQUE (sip_username);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_did_number_key'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_did_number_key UNIQUE (did_number);
  END IF;
END $$;

-- 3. Backfill pilot user. Adjust values to match YOUR Telnyx setup.
--    sip_username: the Telnyx SIP credential username your dialer uses
--    did_number:   the E.164 DID your dialer makes/receives calls on
--
--    Example for the current pilot:
UPDATE users
SET    sip_username = 'ace-dialer-abdulla',  -- ← REPLACE with your actual SIP username
       did_number   = '+17322001305'
WHERE  email = 'abdulla@aptask.com';
