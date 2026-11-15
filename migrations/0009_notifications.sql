-- Phase B/C: reminders the user explicitly confirmed, and their delivery state.
-- One reminder per memo and channel (re-confirming replaces the time).
-- status: scheduled → sending → sent | failed;  canceled when the user cancels or
-- the memo is done/deleted/out of scope at send time.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL,
  memo_id TEXT NOT NULL REFERENCES memos(id),
  channel TEXT NOT NULL CHECK (channel IN ('discord')),
  scheduled_at TEXT NOT NULL,          -- when to send (UTC ISO 8601)
  lead_minutes INTEGER NULL,           -- minutes before due_at; NULL for a chosen time on a date-only memo
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,       -- = scheduled_at, pushed back on a retryable failure
  last_error TEXT NULL,
  sent_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (memo_id, channel)
);
CREATE INDEX idx_notifications_due ON notifications (status, next_attempt_at);
CREATE INDEX idx_notifications_user ON notifications (user_id);
