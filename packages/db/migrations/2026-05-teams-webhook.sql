-- ============================================================================
-- v0.10.0 Pillar 2 — Microsoft Teams notification opt-in (Task 6)
--
-- Adds two columns to `users` so each user can paste their personal Teams
-- Incoming Webhook URL + choose which event types ping them (missed call,
-- inbound SMS, voicemail completed).
--
-- Both columns are NULL by default — only users that explicitly configure
-- Teams notifications will have these set. When teamsWebhookUrl is NULL the
-- teamsNotifier.ts service skips that user entirely; nothing happens for
-- existing pilot users until they opt in via Settings → Account.
--
-- Idempotent: re-running is safe. ADD COLUMN IF NOT EXISTS skips existing.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS teams_webhook_url TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS teams_notify_on TEXT;

-- Optional: post-migration NOTICE so we can see how many existing users
-- have opted in. On fresh deploy this is zero — opt-in only happens
-- via the UI we ship as part of this same task.
DO $$
DECLARE
  configured_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO configured_count
  FROM users
  WHERE teams_webhook_url IS NOT NULL AND teams_webhook_url != '';
  RAISE NOTICE '[migration] users with Teams webhook configured: %', configured_count;
END $$;
