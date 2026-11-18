import { describe, expect, it } from 'vitest';
import { createTestD1 } from './helpers/d1.ts';

describe('migration 0016 (Google/Kakao login, e-mail reminders) keeps existing data', () => {
	it('Discord users, their accounts, preferences, reminders and guest memos are unchanged; new fields default to "none"', async () => {
		const { db, dispose, applyRest } = await createTestD1({ stopBefore: '0016' });
		try {
			await db.batch([
				db.prepare("INSERT INTO users (id, display_name, created_at) VALUES ('u1', '앨리스', '2026-11-01T00:00:00Z')"),
				db.prepare("INSERT INTO workspaces (id, kind, owner_user_id, name, created_at) VALUES ('ws1', 'personal', 'u1', '앨리스님의 메모', '2026-11-01T00:00:00Z')"),
				db.prepare("INSERT INTO oauth_accounts (id, user_id, provider, provider_subject, display_name, created_at, last_login_at) VALUES ('a1', 'u1', 'discord', 'd-1', 'A', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')"),
				db.prepare("INSERT INTO notification_preferences (user_id, channel, enabled, verified_at, updated_at) VALUES ('u1', 'discord', 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')"),
				db.prepare("INSERT INTO sources (id, workspace_id, nickname, raw_text, request_id, created_at) VALUES ('s1', 'ws_shared_guest', '닉', '공개 원문', 'r1', '2026-11-01T00:00:00Z')"),
				db.prepare("INSERT INTO sources (id, workspace_id, nickname, raw_text, request_id, created_at) VALUES ('s2', 'ws1', '앨리스', '개인 원문', 'r2', '2026-11-01T00:00:00Z')"),
				db.prepare(
					`INSERT INTO memos (id, source_id, workspace_id, title, content, category, due_at, due_date, due_text, reminder_recommended, position, created_at)
					 VALUES ('m1', 's2', 'ws1', '회의', '팀 회의', 'schedule', '2026-11-20T01:00:00.000Z', '2026-11-20', '금요일 10시', 1, 0, '2026-11-01T00:00:00Z')`,
				),
				db.prepare(
					`INSERT INTO notifications (id, user_id, workspace_id, memo_id, channel, scheduled_at, lead_minutes, status, attempts, next_attempt_at, created_at, updated_at)
					 VALUES ('n1', 'u1', 'ws1', 'm1', 'discord', '2026-11-20T00:30:00.000Z', 30, 'scheduled', 0, '2026-11-20T00:30:00.000Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
				),
			]);
			const dump = async () => ({
				users: (await db.prepare('SELECT id, display_name, timezone, created_at, default_lead_minutes, date_only_time, reminder_tone FROM users').all()).results,
				prefs: (await db.prepare('SELECT * FROM notification_preferences').all()).results,
				sources: (await db.prepare('SELECT * FROM sources ORDER BY id').all()).results,
				memos: (await db.prepare('SELECT * FROM memos').all()).results,
				workspaces: (await db.prepare('SELECT * FROM workspaces ORDER BY id').all()).results,
			});
			const before = await dump();
			const account = await db.prepare('SELECT * FROM oauth_accounts').first();
			const notification = await db.prepare('SELECT * FROM notifications').first();
			await applyRest();
			expect(await dump()).toEqual(before);
			expect(await db.prepare('SELECT * FROM oauth_accounts').first()).toEqual({ ...account, email: null, email_verified_at: null, avatar_url: null }); // avatar_url: 0017
			// 0017: existing users keep their nickname and are never asked to pick one.
			expect(await db.prepare('SELECT display_name, nickname_pending, avatar_provider FROM users').first()).toEqual({ display_name: '앨리스', nickname_pending: 0, avatar_provider: null });
			expect(await db.prepare('SELECT * FROM notifications').first()).toEqual({ ...notification, channels: null }); // null = every channel that is on (today: Discord)
			expect((await db.prepare('SELECT COUNT(*) AS n FROM notification_attempts').first<{ n: number }>())?.n).toBe(0);
		} finally {
			await dispose();
		}
	});
});
