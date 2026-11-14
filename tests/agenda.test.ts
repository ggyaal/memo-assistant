import { describe, expect, it } from 'vitest';
import { buildAgenda, dueInstant } from '../src/server/agenda.ts';
import type { Memo } from '../src/shared/types.ts';

let n = 0;
function memo(over: Partial<Memo>): Memo {
	n += 1;
	return {
		id: `m${n}`,
		source_id: 's',
		nickname: 'n',
		raw_text: 'r',
		title: over.title ?? `memo${n}`,
		content: 'c',
		category: 'todo',
		due_at: null,
		due_date: null,
		due_text: null,
		reminder_recommended: false,
		reminder_reason: null,
		priority: null,
		priority_reason: null,
		manual_rank: null,
		completed_at: null,
		created_at: '2026-11-09T12:00:00.000Z',
		...over,
	};
}

describe('buildAgenda', () => {
	const shopping = memo({ title: '장 보기', due_date: '2026-11-09', reminder_recommended: true, priority: 'medium' });
	const hospital = memo({ title: '병원 예약', due_at: '2026-11-10T06:00:00.000Z', due_date: '2026-11-10', reminder_recommended: true, priority: 'high' });
	const report = memo({ title: '보고서', due_at: '2026-11-09T13:00:00.000Z', due_date: '2026-11-09', reminder_recommended: true, priority: 'low' });
	const legacy = memo({ title: '예전 메모', due_at: '2026-11-11T01:00:00.000Z', due_date: '2026-11-11' });
	const quiet = memo({ title: '조용한 일', due_date: '2026-11-12', priority: 'high' });

	const agenda = buildAgenda([legacy, quiet, report, hospital, shopping], 20);

	it('lists only reminder-recommended memos, soonest first (date-only = start of that KST day)', () => {
		expect(agenda.reminders.map((m) => m.title)).toEqual(['장 보기', '보고서', '병원 예약']);
	});

	it('ranks by priority, then soonest; unset priority ranks like medium', () => {
		expect(agenda.ranked.map((m) => m.title)).toEqual(['병원 예약', '조용한 일', '장 보기', '예전 메모', '보고서']);
	});

	it('caps both lists', () => {
		const capped = buildAgenda([legacy, quiet, report, hospital, shopping], 2);
		expect(capped.reminders).toHaveLength(2);
		expect(capped.ranked).toHaveLength(2);
	});

	it('reads a date-only deadline as 00:00 KST of that day', () => {
		expect(new Date(dueInstant({ due_at: null, due_date: '2026-11-09' })).toISOString()).toBe('2026-11-08T15:00:00.000Z');
	});
});

describe('byListOrder (drag & drop wins over AI order)', () => {
	const a = memo({ title: 'A', due_date: '2026-11-10', priority: 'high' });
	const b = memo({ title: 'B', due_date: '2026-11-11', priority: 'medium' });
	const c = memo({ title: 'C', due_date: '2026-11-12', priority: 'low' });

	it('uses AI priority when nobody has reordered', () => {
		expect(buildAgenda([c, b, a], 20).ranked.map((m) => m.title)).toEqual(['A', 'B', 'C']);
	});

	it('keeps the user order C, A, B regardless of AI priority', () => {
		const ranked = buildAgenda([{ ...a, manual_rank: 1 }, { ...b, manual_rank: 2 }, { ...c, manual_rank: 0 }], 20).ranked;
		expect(ranked.map((m) => m.title)).toEqual(['C', 'A', 'B']);
	});

	it('puts memos nobody placed yet below the user order (even if AI says high)', () => {
		const urgent = memo({ title: 'NEW', due_date: '2026-11-10', priority: 'high' });
		const ranked = buildAgenda([urgent, { ...a, manual_rank: 1 }, { ...c, manual_rank: 0 }], 20).ranked;
		expect(ranked.map((m) => m.title)).toEqual(['C', 'A', 'NEW']);
	});
});

describe('completed memos in the agenda', () => {
	const doneReminder = memo({ title: 'DONE', due_date: '2026-11-10', reminder_recommended: true, completed_at: '2026-11-09T13:00:00.000Z' });
	const openReminder = memo({ title: 'OPEN', due_date: '2026-11-11', reminder_recommended: true });

	it('drops done memos from reminders but keeps them (struck through) in the priority list', () => {
		const agenda = buildAgenda([doneReminder, openReminder], 20);
		expect(agenda.reminders.map((m) => m.title)).toEqual(['OPEN']);
		expect(agenda.ranked.map((m) => m.title)).toEqual(['DONE', 'OPEN']);
	});
});
