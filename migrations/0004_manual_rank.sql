-- Feature 1: user-defined order of the priority list (drag & drop).
-- NULL = never placed by a user (falls back to AI priority → soonest).
-- Shared board: the order is the same for every visitor.
ALTER TABLE memos ADD COLUMN manual_rank INTEGER NULL;
