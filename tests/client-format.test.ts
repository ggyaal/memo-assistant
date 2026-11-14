import { describe, expect, it } from 'vitest';
import { isOverdue, overdueLabel, todayKst } from '../src/client/format.ts';

// Must match the server rule in listOverdue (src/server/db.ts).
describe('client overdue rule (same as server)', () => {
	const at = (iso: string) => new Date(iso);

	it('uses the Korean date', () => {
		expect(todayKst(at('2026-11-09T15:00:00Z'))).toBe('2026-11-10');
	});

	it.each([
		['exact time passed', { due_at: '2026-11-10T06:00:00.000Z', due_date: '2026-11-10', completed_at: null }, '2026-11-10T06:00:00Z', true],
		['exact time ahead', { due_at: '2026-11-10T06:00:00.000Z', due_date: '2026-11-10', completed_at: null }, '2026-11-10T05:59:59Z', false],
		['date-only, same KST day', { due_at: null, due_date: '2026-11-09', completed_at: null }, '2026-11-09T14:59:59Z', false],
		['date-only, next KST day', { due_at: null, due_date: '2026-11-09', completed_at: null }, '2026-11-09T15:00:00Z', true],
		['done', { due_at: null, due_date: '2026-11-01', completed_at: '2026-11-02T00:00:00.000Z' }, '2026-11-09T00:00:00Z', false],
		['no deadline', { due_at: null, due_date: null, completed_at: null }, '2026-11-09T00:00:00Z', false],
	])('%s', (_label, memo, now, expected) => {
		expect(isOverdue(memo, at(now))).toBe(expected);
	});

	it('labels how long ago it was due', () => {
		expect(overdueLabel({ due_at: null, due_date: '2026-11-09' }, at('2026-11-10T03:00:00Z'))).toBe('1일 지남');
		expect(overdueLabel({ due_at: '2026-11-10T01:00:00.000Z', due_date: '2026-11-10' }, at('2026-11-10T03:00:00Z'))).toBe('오늘 지남');
	});
});
