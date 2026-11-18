-- Profile image and the first-login nickname choice. Additive only: existing users keep their
-- nickname and are never asked again (nickname_pending defaults to 0 for every existing row).

-- Picture URL from the provider (Google `picture`, Discord avatar, Kakao profile image), only from
-- an allow-listed https image host. NULL when the person declined / has none.
ALTER TABLE oauth_accounts ADD COLUMN avatar_url TEXT NULL;

-- 1 = a new user who has not picked (or skipped) a nickname yet. Cleared once, never set again.
ALTER TABLE users ADD COLUMN nickname_pending INTEGER NOT NULL DEFAULT 0;

-- Which picture to show: NULL = the first linked account that has one, 'none' = the default image,
-- or a provider name ('google' | 'discord' | 'kakao').
ALTER TABLE users ADD COLUMN avatar_provider TEXT NULL;
