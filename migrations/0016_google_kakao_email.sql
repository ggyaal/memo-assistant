-- Google / Kakao login and e-mail reminders. Additive only: no existing row or constraint changes.
-- Rollback: docs/rollback/0016_down.sql (code rollback alone is enough; the new columns are ignored by older code).

-- The address a provider itself verified (today: Google ID token with email_verified = true).
-- NULL when the provider gave none or an unverified one. Never used to find or merge accounts.
ALTER TABLE oauth_accounts ADD COLUMN email TEXT NULL;
ALTER TABLE oauth_accounts ADD COLUMN email_verified_at TEXT NULL;

-- Where one reminder goes. NULL (every existing row) = every channel the user has switched on
-- at send time; otherwise a JSON array such as ["discord","email"].
-- notifications.channel stays 'discord' for every row (it is the per-memo schedule key: UNIQUE(memo_id, channel)).
ALTER TABLE notifications ADD COLUMN channels TEXT NULL;

-- One row per delivery attempt and channel: what was tried, when, and the provider's answer.
-- outcome 'accepted' = the provider took the message (not proof that it reached the inbox).
CREATE TABLE notification_attempts (
  id TEXT PRIMARY KEY,
  notification_id TEXT NULL,           -- NULL for a settings test message
  user_id TEXT NOT NULL,
  memo_id TEXT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('discord', 'email')),
  occurrence_key TEXT NULL,            -- occurrence day, or once@<scheduled_at>
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'retry', 'failed')),
  error_code TEXT NULL,
  provider_message_id TEXT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX idx_notification_attempts_user ON notification_attempts (user_id, channel, attempted_at DESC);
