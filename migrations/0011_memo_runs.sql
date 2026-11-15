-- AI organizing runs that are in progress, so "취소" can stop only a real, running request.
-- A row is added right before the agent starts and removed when it settles.
-- Rows left by a crashed run are ignored after the run timeout and cleaned up later.
CREATE TABLE memo_runs (
  request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  started_at TEXT NOT NULL
);
