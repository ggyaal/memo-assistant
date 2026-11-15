-- Clarifying questions: an organized input with unclear dates/times/repeats is kept as a draft
-- (not in sources/memos) until the person confirms, skips, or stops the questions.
-- Additive only; nothing existing changes. Drafts expire (expires_at) and are never shown as memos.
CREATE TABLE memo_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  source_json TEXT NOT NULL,      -- {sourceId, nickname, rawText, createdAt, authorKeyHash}
  memos_json TEXT NOT NULL,       -- sanitized memos (same shape the save tool stores)
  questions_json TEXT NOT NULL,   -- server-built questions (max 3)
  status TEXT NOT NULL CHECK (status IN ('open', 'committing', 'committed', 'cancelled')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (workspace_id, request_id)
);
CREATE INDEX idx_memo_drafts_expiry ON memo_drafts (status, expires_at);
