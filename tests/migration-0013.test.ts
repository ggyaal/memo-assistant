import { describe, expect, it } from 'vitest';
import { createTestD1 } from './helpers/d1.ts';

describe('migration 0013 (recurrence) keeps existing data', () => {
	it('memos, reminders and done states written before 0013 are unchanged and read as one-time', async () => {
		const { db, dispose, applyRest } = await createTestD1({ stopBefore: '0013' });
		try {
			await db.batch([
				db.prepare("INSERT INTO users (id, display_name, created_at) VALUES ('u1', '앨리스', '2026-11-01T00:00:00Z')"),
				db.prepare("INSERT INTO sources (id, workspace_id, nickname, raw_text, request_id, created_at) VALUES ('s1', 'ws_shared_guest', '닉', '원문', 'r1', '2026-11-01T00:00:00Z')"),
				db.prepare(
					`INSERT INTO memos (id, source_id, workspace_id, title, content, category, due_at, due_date, due_text, reminder_recommended, position, created_at, completed_at)
					 VALUES ('m1', 's1', 'ws_shared_guest', '회의', '팀 회의', 'schedule', '2026-11-20T01:00:00.000Z', '2026-11-20', '금요일 10시', 1, 0, '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')`,
				),
				db.prepare(
					`INSERT INTO notifications (id, user_id, workspace_id, memo_id, channel, scheduled_at, lead_minutes, status, attempts, next_attempt_at, created_at, updated_at)
					 VALUES ('n1', 'u1', 'ws_shared_guest', 'm1', 'discord', '2026-11-20T00:30:00.000Z', 30, 'scheduled', 0, '2026-11-20T00:30:00.000Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
				),
			]);
			const before = {
				memo: await db.prepare('SELECT * FROM memos').first(),
				notification: await db.prepare('SELECT * FROM notifications').first(),
			};
			await applyRest();
			const memo = await db.prepare('SELECT * FROM memos').first<Record<string, unknown>>();
			const notification = await db.prepare('SELECT * FROM notifications').first<Record<string, unknown>>();
			expect(memo).toEqual({ ...before.memo, recurrence: null, recurrence_question: null });
			expect(notification).toEqual({ ...before.notification, occurrence_date: null, remind_time: null });
			expect((await db.prepare('SELECT COUNT(*) AS n FROM memo_occurrences').first<{ n: number }>())?.n).toBe(0);
			expect((await db.prepare('SELECT COUNT(*) AS n FROM reminder_deliveries').first<{ n: number }>())?.n).toBe(0);
		} finally {
			await dispose();
		}
	});
});
