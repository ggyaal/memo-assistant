-- Feature 3: removing items from the "지나버린 일" (overdue) list.
-- Soft delete: the row is kept (recoverable by an operator) but hidden from
-- every list and API response. Shared board: hidden for every visitor.
ALTER TABLE memos ADD COLUMN deleted_at TEXT NULL;
