import { describe, expect, it } from 'vitest';
import { applyAnswers, buildQuestions, type DraftMemo } from '../src/shared/clarify.ts';
import { sanitizeMemo } from '../src/server/validation.ts';

// Mon 2026-11-16 12:00 KST
const NOW = new Date('2026-11-16T03:00:00Z');
/** What the server keeps after the model + server rules (same path as save_memos). */
const memo = (raw: string, m: { title: string; category?: string; due_text?: string | null; due_at?: string | null; due_date?: string | null }, single = true): DraftMemo =>
	sanitizeMemo({ content: m.title, category: 'todo', reminder_recommended: false, ...m } as never, raw, NOW, { singleMemo: single }) as DraftMemo;

describe('which inputs get a question (document test inputs)', () => {
	it('1. "내일 오후 3시에 병원 예약이 있어" — clear: no question', () => {
		const m = memo('내일 오후 3시에 병원 예약이 있어', { title: '병원 예약', category: 'schedule', due_text: '내일 오후 3시', due_at: '2026-11-17T15:00:00+09:00' });
		expect(buildQuestions([m], NOW)).toEqual([]);
	});

	it('2. "다음 주에 병원 가야 해" — which day of next week (or a date); skipping keeps no date', () => {
		const m = memo('다음 주에 병원 가야 해', { title: '병원 방문', due_text: '다음 주' });
		const [q] = buildQuestions([m], NOW);
		expect(q).toMatchObject({ kind: 'week_day', memoIndex: 0, picker: 'date' });
		expect(q.options.map((o) => o.id)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
		expect(q.options[0].label).toBe('월 11/23');
		expect(applyAnswers([m], [q], [{ questionId: q.id, optionId: '2026-11-25' }], NOW)[0]).toMatchObject({ due_date: '2026-11-25', due_at: null });
		expect(applyAnswers([m], [q], [], NOW)[0]).toMatchObject({ due_date: null, due_at: null });
	});

	it('3. "월 화 목 오후 7시에 운동하기" — every week or once (time is clear, so only one question)', () => {
		const m = memo('월 화 목 오후 7시에 운동하기', { title: '운동', category: 'schedule', due_text: '월 화 목 오후 7시', due_at: '2026-11-16T19:00:00+09:00' });
		expect(m.recurrence).toBeNull(); // not guessed as weekly
		const qs = buildQuestions([m], NOW);
		expect(qs.map((q) => q.kind)).toEqual(['recurrence']);
		const repeat = applyAnswers([m], qs, [{ questionId: qs[0].id, optionId: 'repeat' }], NOW)[0];
		expect(repeat.recurrence).toMatchObject({ kind: 'weekly', days: [0, 1, 3], interval: 1, start: '2026-11-16' });
		expect(repeat.due_at).toBe('2026-11-16T10:00:00.000Z'); // 19:00 KST kept
		const once = applyAnswers([m], qs, [{ questionId: qs[0].id, optionId: 'once' }], NOW)[0];
		expect(once.recurrence).toEqual({ kind: 'dates', dates: ['2026-11-16', '2026-11-17', '2026-11-19'] });
		// Skipped: no repeat is invented; the question stays on the card for later.
		const skipped = applyAnswers([m], qs, [], NOW)[0];
		expect([skipped.recurrence, skipped.recurrence_question?.repeat.kind]).toEqual([null, 'weekly']);
	});

	it('4. "내일 3시 회의하고 금요일까지 보고서 제출" — only the bare "3시" is asked; answers touch only that memo', () => {
		const raw = '내일 3시 회의하고 금요일까지 보고서 제출';
		const meeting = memo(raw, { title: '회의', category: 'schedule', due_text: '내일 3시', due_at: '2026-11-17T03:00:00+09:00' }, false); // the real model chose 03:00
		const report = memo(raw, { title: '보고서 제출', due_text: '금요일까지' }, false);
		const qs = buildQuestions([meeting, report], NOW);
		expect(qs).toEqual([
			{ id: 'q1', memoIndex: 0, kind: 'meridiem', prompt: '「회의」 “내일 3시”는 오전인가요, 오후인가요?', options: [{ id: '03:00', label: '오전 3시' }, { id: '15:00', label: '오후 3시' }], picker: 'time' },
		]);
		const [m1, m2] = applyAnswers([meeting, report], qs, [{ questionId: 'q1', optionId: '15:00' }], NOW);
		expect(m1.due_at).toBe('2026-11-17T06:00:00.000Z'); // 15:00 KST
		expect(m2).toEqual(report); // untouched
		// Skipped → the unclear time is not kept (date stays).
		expect(applyAnswers([meeting, report], qs, [], NOW)[0]).toMatchObject({ due_date: '2026-11-17', due_at: null });
		// Time picker works the same way, validated.
		expect(applyAnswers([meeting], qs, [{ questionId: 'q1', value: '09:30' }], NOW)[0].due_at).toBe('2026-11-17T00:30:00.000Z');
		expect(applyAnswers([meeting], qs, [{ questionId: 'q1', value: '25:00' }], NOW)[0].due_at).toBeNull();
	});

	it('5. "새 앱 아이디어: 버튼으로 메모하기" and 6. "2026-12-01 14:30 회의" — no question', () => {
		const idea = memo('새 앱 아이디어: 버튼으로 메모하기', { title: '버튼으로 메모하기', category: 'idea', due_text: null });
		const exact = memo('2026-12-01 14:30 회의', { title: '회의', category: 'schedule', due_text: '2026-12-01 14:30', due_at: '2026-12-01T14:30:00+09:00', due_date: '2026-12-01' });
		expect(buildQuestions([idea, exact], NOW)).toEqual([]);
	});

	it('a date without a time is not asked about ("내일 병원 가기")', () => {
		expect(buildQuestions([memo('내일 병원 가기', { title: '병원', due_text: '내일' })], NOW)).toEqual([]);
	});

	it('at most 3 questions; extra ones are simply not asked (values stay undecided)', () => {
		const ms = [1, 2, 3, 4].map((i) => memo(`다음 주에 일${i}`, { title: `일${i}`, due_text: '다음 주' }, false));
		expect(buildQuestions(ms, NOW)).toHaveLength(3);
	});

	it('answers for unknown questions, options or out-of-range dates are ignored', () => {
		const m = memo('다음 주에 병원 가야 해', { title: '병원 방문', due_text: '다음 주' });
		const qs = buildQuestions([m], NOW);
		expect(applyAnswers([m], qs, [{ questionId: qs[0].id, optionId: '2026-12-25' }], NOW)[0].due_date).toBeNull(); // not an option
		expect(applyAnswers([m], qs, [{ questionId: qs[0].id, value: '2026-11-01' }], NOW)[0].due_date).toBeNull(); // past
		expect(applyAnswers([m], qs, [{ questionId: qs[0].id, value: '2026-12-25' }], NOW)[0].due_date).toBe('2026-12-25'); // picker date
		expect(applyAnswers([m], qs, [{ questionId: 'q9', optionId: '2026-11-23' }], NOW)[0].due_date).toBeNull();
	});
});
