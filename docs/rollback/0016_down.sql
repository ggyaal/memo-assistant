-- Manual rollback for migrations/0016_google_kakao_email.sql (NOT applied automatically).
-- Usually NOT needed: older code ignores the new columns/table, so `npx wrangler rollback <version>` is enough.
-- Run only after a backup: npx wrangler d1 export memo-assistant --remote --output backups/before-0016-down.sql
--   npx wrangler d1 execute memo-assistant --remote --file docs/rollback/0016_down.sql
-- Then remove the 0016 row from d1_migrations if the migration should be re-applied later.
-- Loses: verified Google e-mail addresses, per-reminder channel choices, delivery attempt history.

DROP INDEX IF EXISTS idx_notification_attempts_user;
DROP TABLE IF EXISTS notification_attempts;
ALTER TABLE notifications DROP COLUMN channels;
ALTER TABLE oauth_accounts DROP COLUMN email_verified_at;
ALTER TABLE oauth_accounts DROP COLUMN email;
