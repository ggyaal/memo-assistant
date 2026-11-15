-- Manual rollback for migrations/0007_auth_workspaces.sql (NOT applied automatically).
-- Run only after taking a backup: npx wrangler d1 export DB --remote --output backup.sql
--   npx wrangler d1 execute DB --remote --file docs/rollback/0007_down.sql
-- Then remove the 0007 row from d1_migrations if the migration should be re-applied later.
--
-- WARNING: memos created in personal workspaces are deleted by this rollback
-- (guest memos are kept). Export first if they must be preserved.

DELETE FROM memos WHERE workspace_id <> 'ws_shared_guest';
DELETE FROM sources WHERE workspace_id <> 'ws_shared_guest';

DROP INDEX IF EXISTS idx_memos_workspace_due;
DROP INDEX IF EXISTS idx_memos_workspace_created;
DROP INDEX IF EXISTS idx_sources_workspace;
ALTER TABLE memos DROP COLUMN workspace_id;
ALTER TABLE sources DROP COLUMN workspace_id;

DROP TABLE IF EXISTS workspaces;
DROP TABLE IF EXISTS oauth_states;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS oauth_accounts;
DROP TABLE IF EXISTS users;
