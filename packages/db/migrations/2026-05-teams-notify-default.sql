-- v0.10.1 Pillar 2 — Teams notifications: tenant-wide flow rollout.
--
-- Switched from per-user webhook URLs to a single tenant-wide Power
-- Automate flow (TEAMS_TENANT_WEBHOOK_URL env var on api + webhooks
-- services). Every user now gets Teams cards by default without any
-- per-user setup. They can mute event types in Settings → Personal →
-- Teams notifications.
--
-- This migration:
--   1. Sets DEFAULT 'missed_call,sms,voicemail' on users.teams_notify_on
--      so any NEW user inserted from now on automatically opts into
--      all three event types.
--   2. Backfills existing users whose teams_notify_on is currently NULL
--      with the same default, so the existing user base (Akshay,
--      Nilesh, Ravindra, Abdulla, etc.) ALL start receiving cards on
--      next event without any settings change.
--
-- We deliberately do NOT touch rows where teams_notify_on is set to
-- an empty string '' — that's the explicit-opt-out state and we
-- respect the user's choice.
--
-- The teams_webhook_url column is left untouched (nullable, no
-- default) — it's deprecated, the notifier doesn't read it anymore,
-- but dropping the column is a separate migration we can do once
-- we're confident no admin / UI surface still depends on it.

BEGIN;

ALTER TABLE users
  ALTER COLUMN teams_notify_on SET DEFAULT 'missed_call,sms,voicemail';

-- Backfill: only NULL rows. Don't clobber a user who has explicitly
-- saved their preferences (including the empty-string opt-out).
UPDATE users
  SET teams_notify_on = 'missed_call,sms,voicemail'
  WHERE teams_notify_on IS NULL;

COMMIT;

-- Verification:
--   SELECT teams_notify_on, COUNT(*) FROM users GROUP BY teams_notify_on;
-- After this migration, no user should have NULL — every user should
-- have either the default ('missed_call,sms,voicemail') or a custom
-- subset they explicitly chose.
