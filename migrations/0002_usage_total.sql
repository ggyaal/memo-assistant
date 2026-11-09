-- All-time AI usage counter shown on the page. Never expires, so the
-- expired-counter cleanup in rate-limit.ts never deletes it.
-- Seeded with the number of saved inputs so far (an approximation: AI attempts
-- that failed before this migration are not included).
INSERT OR IGNORE INTO usage_counters (counter_key, count, expires_at)
VALUES ('total:ai', (SELECT COUNT(*) FROM sources), '9999-12-31T00:00:00.000Z');
