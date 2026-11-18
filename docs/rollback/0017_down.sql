-- Manual rollback for migrations/0017_profile_nickname.sql (NOT applied automatically).
-- Usually NOT needed: older code ignores these columns (`npx wrangler rollback <version>` is enough).
-- Backup first: npx wrangler d1 export memo-assistant --remote --output .wrangler/backups/before-0017-down.sql
ALTER TABLE users DROP COLUMN avatar_provider;
ALTER TABLE users DROP COLUMN nickname_pending;
ALTER TABLE oauth_accounts DROP COLUMN avatar_url;
