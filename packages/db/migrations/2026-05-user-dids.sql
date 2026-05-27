-- ============================================================================
-- v0.10.0 — Multi-DID per user (Pillars 1 + Task 5 of feature/multi-num-teams-routing)
--
-- This migration covers BOTH:
--   1. The user_dids table itself + users.active_user_did_id pointer
--      (Task 1 — sprint plan).
--   2. The user_did_id FK columns on calls / messages / voicemails so
--      inbound interactions can be tagged with which DID they landed on
--      (Task 5 — inbound DID flagging).
--
-- One migration covers both because Task 5's FK references depend on the
-- user_dids table existing first; running them as two separate scripts
-- works but creates an ordering trap. Combining keeps it atomic.
--
-- Idempotent: re-running is safe. Backfill INSERTs use ON CONFLICT
-- DO NOTHING; column additions use IF NOT EXISTS.
-- ============================================================================

-- ── 1. user_dids table ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_dids (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE,
  did_number        TEXT NOT NULL UNIQUE,
  telnyx_number_id  TEXT,
  connection_id     TEXT,
  label             TEXT NOT NULL DEFAULT 'Line',
  color_hex         TEXT NOT NULL DEFAULT '#3b82f6',
  is_default        BOOLEAN NOT NULL DEFAULT FALSE,
  ring_group_id     INTEGER,        -- FK added in Pillar 3 migration
  ivr_menu_id       INTEGER,        -- FK added in Pillar 4 migration
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_dids_user_id_idx       ON user_dids(user_id);
CREATE INDEX IF NOT EXISTS user_dids_ring_group_id_idx ON user_dids(ring_group_id);
CREATE INDEX IF NOT EXISTS user_dids_ivr_menu_id_idx   ON user_dids(ivr_menu_id);

-- ── 2. users.active_user_did_id pointer ─────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS active_user_did_id BIGINT
    REFERENCES user_dids(id) ON DELETE SET NULL;

-- ── 3. Backfill user_dids: one row per existing user.did_number ─────────────

INSERT INTO user_dids (user_id, did_number, telnyx_number_id, label, color_hex, is_default, created_at, updated_at)
SELECT
  u.id,
  u.did_number,
  u.telnyx_number_id,
  'Main',
  '#3b82f6',
  TRUE,
  u.created_at,
  u.created_at
FROM users u
WHERE u.did_number IS NOT NULL
  AND u.is_active = TRUE
ON CONFLICT (did_number) DO NOTHING;

-- ── 4. Point users.active_user_did_id at the backfilled row ─────────────────

UPDATE users u
SET active_user_did_id = ud.id
FROM user_dids ud
WHERE ud.user_id = u.id
  AND ud.is_default = TRUE
  AND u.active_user_did_id IS NULL;

-- ── 5. Task 5: user_did_id FK on calls / messages / voicemails ──────────────
--
-- ON DELETE SET NULL because if a UserDid row is deleted we want to keep
-- the historical Call/Message/Voicemail rows but lose the line-tag (rather
-- than cascading-delete the user's whole call history).

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS user_did_id BIGINT
    REFERENCES user_dids(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS calls_user_did_id_idx ON calls(user_did_id);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS user_did_id BIGINT
    REFERENCES user_dids(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS messages_user_did_id_idx ON messages(user_did_id);

ALTER TABLE voicemails
  ADD COLUMN IF NOT EXISTS user_did_id BIGINT
    REFERENCES user_dids(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS voicemails_user_did_id_idx ON voicemails(user_did_id);

-- ── 6. Backfill user_did_id on existing rows ────────────────────────────────
--
-- Match logic:
--   - INBOUND row: to_number matches the user's UserDid.did_number
--     (the caller dialed THAT DID, so that's the line it landed on)
--   - OUTBOUND row: from_number matches the user's UserDid.did_number
--     (the user sent FROM that DID)
--
-- We rely on the user_dids.user_id matching the call/message/voicemail's
-- user_id as a sanity check — if a UserDid row somehow exists with a
-- did_number colliding with another user's call's to/from, the user_id
-- filter prevents cross-user contamination.

UPDATE calls c
SET user_did_id = ud.id
FROM user_dids ud
WHERE ud.user_id = c.user_id
  AND c.user_did_id IS NULL
  AND (
    (c.direction = 'inbound'  AND ud.did_number = c.to_number)
    OR
    (c.direction = 'outbound' AND ud.did_number = c.from_number)
  );

UPDATE messages m
SET user_did_id = ud.id
FROM user_dids ud
WHERE ud.user_id = m.user_id
  AND m.user_did_id IS NULL
  AND (
    (m.direction = 'inbound'  AND ud.did_number = m.to_number)
    OR
    (m.direction = 'outbound' AND ud.did_number = m.from_number)
  );

-- Voicemails are always inbound by definition.
UPDATE voicemails v
SET user_did_id = ud.id
FROM user_dids ud
WHERE ud.user_id = v.user_id
  AND v.user_did_id IS NULL
  AND ud.did_number = v.to_number;

-- ── 7. Sanity check (NOTICE log) ────────────────────────────────────────────
--
-- Simple count printouts. Postgres RAISE is strict about % placeholders;
-- previously had a percentage-formatting block that mismatched arg count.
-- Plain "tagged / total" is enough to spot a backfill miss.

DO $$
DECLARE
  user_count             INTEGER;
  user_with_did_count    INTEGER;
  user_did_count         INTEGER;
  active_pointer_count   INTEGER;
  calls_total            INTEGER;
  calls_tagged           INTEGER;
  messages_total         INTEGER;
  messages_tagged        INTEGER;
  voicemails_total       INTEGER;
  voicemails_tagged      INTEGER;
BEGIN
  SELECT COUNT(*) INTO user_count             FROM users WHERE is_active = TRUE;
  SELECT COUNT(*) INTO user_with_did_count    FROM users WHERE is_active = TRUE AND did_number IS NOT NULL;
  SELECT COUNT(*) INTO user_did_count         FROM user_dids;
  SELECT COUNT(*) INTO active_pointer_count   FROM users WHERE active_user_did_id IS NOT NULL;
  SELECT COUNT(*) INTO calls_total            FROM calls;
  SELECT COUNT(*) INTO calls_tagged           FROM calls WHERE user_did_id IS NOT NULL;
  SELECT COUNT(*) INTO messages_total         FROM messages;
  SELECT COUNT(*) INTO messages_tagged        FROM messages WHERE user_did_id IS NOT NULL;
  SELECT COUNT(*) INTO voicemails_total       FROM voicemails;
  SELECT COUNT(*) INTO voicemails_tagged      FROM voicemails WHERE user_did_id IS NOT NULL;

  RAISE NOTICE '[migration] users active: %, with DID: %, user_dids rows: %, active pointers: %',
    user_count, user_with_did_count, user_did_count, active_pointer_count;
  RAISE NOTICE '[migration] calls       tagged: % / %', calls_tagged, calls_total;
  RAISE NOTICE '[migration] messages    tagged: % / %', messages_tagged, messages_total;
  RAISE NOTICE '[migration] voicemails  tagged: % / %', voicemails_tagged, voicemails_total;
END $$;
