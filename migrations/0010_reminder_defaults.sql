-- Automatic reminders for AI-recommended memos use the user's own defaults.
-- default_lead_minutes: for memos with an exact time (0, 10, 30 or 60 minutes before).
-- date_only_time: time of day (HH:MM, KST) for date-only memos; NULL = never auto-schedule
--   them (no invented time — the user picks one in the upcoming-reminders panel).
ALTER TABLE users ADD COLUMN default_lead_minutes INTEGER NOT NULL DEFAULT 30;
ALTER TABLE users ADD COLUMN date_only_time TEXT NULL;
