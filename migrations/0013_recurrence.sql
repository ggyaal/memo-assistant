-- Repeating and multi-date schedules. Additive only: existing memos and reminders are untouched
-- (all new columns are NULL = "not repeating", which is exactly today's behaviour).
--
-- memos.recurrence: JSON rule (daily / weekly{days, interval} / monthly{day} / dates[...]).
--   due_at/due_date keep the FIRST occurrence, so code that ignores the rule still sees one date.
-- memos.recurrence_question: JSON {repeat, once} when the wording was unclear; the person answers.
ALTER TABLE memos ADD COLUMN recurrence TEXT NULL;
ALTER TABLE memos ADD COLUMN recurrence_question TEXT NULL;

-- Done state per occurrence of a repeating memo (memos.completed_at = the whole series stopped).
CREATE TABLE memo_occurrences (
  memo_id TEXT NOT NULL REFERENCES memos(id),
  occurrence_date TEXT NOT NULL,       -- KST day YYYY-MM-DD
  completed_at TEXT NOT NULL,
  PRIMARY KEY (memo_id, occurrence_date)
);

-- A repeating reminder is one row that moves on to the next occurrence after each send.
-- occurrence_date: the occurrence the row is currently waiting for (NULL for one-time reminders).
-- remind_time: HH:MM (KST) for date-only repeating memos (lead_minutes is used for timed ones).
ALTER TABLE notifications ADD COLUMN occurrence_date TEXT NULL;
ALTER TABLE notifications ADD COLUMN remind_time TEXT NULL;

-- One row per delivered (or attempted) occurrence: the primary key makes a second send of the
-- same occurrence impossible, even if two cron runs overlap or a row is rescheduled.
CREATE TABLE reminder_deliveries (
  memo_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memo_id, channel, occurrence_date)
);
