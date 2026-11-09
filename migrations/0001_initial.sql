-- Memo Assistant Phase 1 schema. All timestamps are UTC ISO 8601 strings.

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE memos (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('todo', 'schedule', 'idea', 'note')),
  due_at TEXT NULL,
  due_text TEXT NULL,
  reminder_recommended INTEGER NOT NULL DEFAULT 0,
  reminder_reason TEXT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- List queries: newest first, optionally limited to one KST day (created_at range).
CREATE INDEX idx_memos_created_at ON memos (created_at DESC, id DESC);
CREATE INDEX idx_memos_source_id ON memos (source_id);
CREATE INDEX idx_memos_category_created_at ON memos (category, created_at DESC);
CREATE INDEX idx_sources_nickname ON sources (nickname);

-- Server-side abuse prevention: fixed-window counters (per hashed client / global per day).
CREATE TABLE usage_counters (
  counter_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);
