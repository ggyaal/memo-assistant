-- Phase B: per-user notification channel choices (settings screen).
-- A row exists only after the user changed a toggle; no row = off.
-- verified_at is set later, when a real test message was delivered (Phase C).
CREATE TABLE notification_preferences (
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK (channel IN ('discord', 'kakao', 'email')),
  enabled INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, channel)
);
