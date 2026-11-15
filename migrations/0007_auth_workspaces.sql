-- Phase A: users, social login, sessions and workspaces.
-- Existing data is NOT modified: every current source/memo gets the fixed shared
-- guest workspace through the column default. Rollback: docs/rollback/0007_down.sql.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  created_at TEXT NOT NULL
);

-- One row per linked social account. Same e-mail never merges accounts automatically.
CREATE TABLE oauth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'discord', 'kakao')),
  provider_subject TEXT NOT NULL,
  display_name TEXT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject)
);
CREATE INDEX idx_oauth_accounts_user ON oauth_accounts (user_id);

-- Session id = SHA-256 of the cookie token (the raw token is never stored).
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Pending OAuth logins: id = SHA-256 of `state`; one-time use, 10-minute expiry.
CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  link_user_id TEXT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('shared_guest', 'personal')),
  owner_user_id TEXT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_workspaces_owner ON workspaces (owner_user_id) WHERE kind = 'personal';

-- The one shared guest space ("익명의 스케줄") every guest uses.
INSERT INTO workspaces (id, kind, owner_user_id, name, created_at)
VALUES ('ws_shared_guest', 'shared_guest', NULL, '익명의 스케줄', '2026-11-15T00:00:00.000Z');

-- SQLite cannot add a REFERENCES column with a non-NULL default; the server
-- only ever writes ids of existing workspaces.
ALTER TABLE sources ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws_shared_guest';
ALTER TABLE memos ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws_shared_guest';

CREATE INDEX idx_sources_workspace ON sources (workspace_id);
CREATE INDEX idx_memos_workspace_created ON memos (workspace_id, created_at DESC);
CREATE INDEX idx_memos_workspace_due ON memos (workspace_id, due_at);
