-- Feature 2: completion check. NULL = not done; otherwise when it was checked (UTC ISO 8601).
-- Shared board: the state is the same for every visitor.
ALTER TABLE memos ADD COLUMN completed_at TEXT NULL;
