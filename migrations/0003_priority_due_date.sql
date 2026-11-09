-- Agenda side panel: AI-assigned priority and a KST due date for date-only deadlines.
ALTER TABLE memos ADD COLUMN priority TEXT NULL CHECK (priority IN ('high', 'medium', 'low'));
ALTER TABLE memos ADD COLUMN priority_reason TEXT NULL;
-- Calendar date (YYYY-MM-DD, Asia/Seoul). Set when the input names a day even
-- without a clock time ("오늘", "11월 20일"); due_at stays null in that case.
ALTER TABLE memos ADD COLUMN due_date TEXT NULL;

-- Backfill: memos with an exact time get the KST date of that time.
UPDATE memos SET due_date = substr(datetime(due_at, '+9 hours'), 1, 10) WHERE due_at IS NOT NULL;

-- Upcoming-agenda lookups.
CREATE INDEX idx_memos_due_at ON memos (due_at) WHERE due_at IS NOT NULL;
CREATE INDEX idx_memos_due_date ON memos (due_date) WHERE due_date IS NOT NULL;
