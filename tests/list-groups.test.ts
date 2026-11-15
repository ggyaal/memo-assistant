import { describe, expect, it } from 'vitest';
import { dayGroupLabel, groupMemosByDay } from '../src/client/groups.ts';
import type { Memo } from '../src/shared/types.ts';

const memo = (id: string, over: Partial<Memo>): Memo => ({
	id, source_id: 's', nickname: 'n', raw_text: '', title: id, content: id, category: 'todo', due_at: null, due_date: null, due_text: null,
	reminder_recommended: false, reminder_reason: null, priority: null, priority_reason: null, manual_rank: null, completed_at: null,
	reminder: null, recurrence: null, recurrence_question: null, created_at: '2026-11-15T03:00:00.000Z', ...over,
});
const NOW = new Date('2026-11-16T03:00:00Z'); // Mon 12:00 KST

describe('전체 메모 grouped by day', () => {
	it('registration day uses the KST day (00:30 KST belongs to that day, not the UTC day) and keeps list order', () => {
		const list = [
			memo('a', { created_at: '2026-11-15T15:30:00.000Z' }), // 11-16 00:30 KST
			memo('b', { created_at: '2026-11-15T14:59:00.000Z' }), // 11-15 23:59 KST
			memo('c', { created_at: '2026-11-15T01:00:00.000Z' }),
		];
		expect(groupMemosByDay(list, 'created').map((g) => [g.day, g.memos.map((m) => m.id)])).toEqual([
			['2026-11-16', ['a']],
			['2026-11-15', ['b', 'c']],
		]);
	});

	it('schedule day: soonest day first, timed before untimed within a day, repeating by occurrence, undated last', () => {
		const list = [
			memo('none', {}),
			memo('late', { due_date: '2026-11-20' }),
			memo('untimed', { due_date: '2026-11-17' }),
			memo('timed', { due_date: '2026-11-17', due_at: '2026-11-17T01:00:00.000Z' }),
			memo('repeat', { due_date: '2026-11-09', recurrence: { kind: 'daily', start: '2026-11-09' }, occurrence: { date: '2026-11-16', at: null, completed_at: null } }),
		];
		expect(groupMemosByDay(list, 'due').map((g) => [g.day, g.memos.map((m) => m.id)])).toEqual([
			['2026-11-16', ['repeat']],
			['2026-11-17', ['timed', 'untimed']],
			['2026-11-20', ['late']],
			[null, ['none']],
		]);
	});

	it('labels: today / yesterday / tomorrow, another year with the year, no date', () => {
		expect(dayGroupLabel('2026-11-16', 'created', NOW)).toBe('오늘 · 11월 16일 (월)');
		expect(dayGroupLabel('2026-11-15', 'created', NOW)).toBe('어제 · 11월 15일 (일)');
		expect(dayGroupLabel('2026-11-17', 'due', NOW)).toBe('내일 · 11월 17일 (화)');
		expect(dayGroupLabel('2026-11-10', 'created', NOW)).toBe('11월 10일 (화)');
		expect(dayGroupLabel('2025-12-31', 'created', NOW)).toBe('2025년 12월 31일 (수)');
		expect(dayGroupLabel(null, 'due', NOW)).toBe('날짜 없음');
	});
});
