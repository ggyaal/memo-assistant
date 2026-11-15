import { describe, expect, it } from 'vitest';
import { clockTimeIn, describeRecurrence, detectRecurrence, nextOccurrence, occurrencesBetween, parseRecurrence, weekdaysIn, type Recurrence } from '../src/shared/recurrence.ts';
import { sanitizeMemo } from '../src/server/validation.ts';

const WED = '2026-11-18'; // a Wednesday (KST day)

describe('weekdaysIn: several weekdays in one phrase', () => {
	it.each([
		['월 화 목', [0, 1, 3]],
		['월수금', [0, 2, 4]],
		['월, 수, 금', [0, 2, 4]],
		['월요일과 목요일', [0, 3]],
		['화/목 저녁', [1, 3]],
		['화·목', [1, 3]],
		['토일', [5, 6]],
		['매주월수금', [0, 2, 4]],
		['일요일', [6]],
	])('%s → %j', (text, days) => {
		expect(weekdaysIn(text)).toEqual(days);
	});

	it.each(['11월 20일', '지금 바로', '매일', '수금하기', '목표 세우기', '금방', '12/25', '화장실 청소'])('no weekday in "%s"', (text) => {
		expect(weekdaysIn(text)).toEqual([]);
	});
});

describe('detectRecurrence', () => {
	const rec = (text: string) => detectRecurrence(text, WED);

	it.each<[string, Recurrence]>([
		['매일 아침 7시', { kind: 'daily', start: WED }],
		['날마다', { kind: 'daily', start: WED }],
		['매주 월수금 오후 7시', { kind: 'weekly', days: [0, 2, 4], interval: 1, start: WED }],
		['매주 월요일', { kind: 'weekly', days: [0], interval: 1, start: '2026-11-23' }],
		['월요일마다', { kind: 'weekly', days: [0], interval: 1, start: '2026-11-23' }],
		['화목마다 7시', { kind: 'weekly', days: [1, 3], interval: 1, start: '2026-11-19' }],
		['격주 화요일', { kind: 'weekly', days: [1], interval: 2, start: '2026-11-24' }],
		['평일마다 오전 9시', { kind: 'weekly', days: [0, 1, 2, 3, 4], interval: 1, start: WED }],
		['매주 평일', { kind: 'weekly', days: [0, 1, 2, 3, 4], interval: 1, start: WED }],
		['주말마다', { kind: 'weekly', days: [5, 6], interval: 1, start: '2026-11-21' }],
		['매 주말', { kind: 'weekly', days: [5, 6], interval: 1, start: '2026-11-21' }],
		['매월 15일', { kind: 'monthly', day: 15, start: WED }],
		// Several named weekdays = a weekly routine (user decision), with or without "이제부터".
		['월수금 운동', { kind: 'weekly', days: [0, 2, 4], interval: 1, start: WED }],
		['월요일과 목요일', { kind: 'weekly', days: [0, 3], interval: 1, start: '2026-11-19' }],
		['이제부터 월, 화, 금', { kind: 'weekly', days: [0, 1, 4], interval: 1, start: '2026-11-20' }],
		['앞으로 화요일', { kind: 'weekly', days: [1], interval: 1, start: '2026-11-24' }],
		['매달 1일 오전 10시', { kind: 'monthly', day: 1, start: WED }],
	])('repeating: %s', (text, rule) => {
		expect(rec(text)).toEqual({ status: 'recurring', rule });
	});

	it('one-time several days when the week is named (past days of this week are dropped)', () => {
		expect(rec('이번 주 월, 목')).toEqual({ status: 'once', rule: { kind: 'dates', dates: ['2026-11-19'] } });
		expect(rec('다음 주 월 수 금')).toEqual({ status: 'once', rule: { kind: 'dates', dates: ['2026-11-23', '2026-11-25', '2026-11-27'] } });
		expect(rec('다음 주 월요일과 목요일')).toEqual({ status: 'once', rule: { kind: 'dates', dates: ['2026-11-23', '2026-11-26'] } });
		expect(rec('이번 주말')).toEqual({ status: 'once', rule: { kind: 'dates', dates: ['2026-11-21', '2026-11-22'] } });
		expect(rec('이번 주 월 화')).toEqual({ status: 'none' }); // both already passed
	});

	it.each([
		['평일 아침 7시', [0, 1, 2, 3, 4], ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24']],
		['주말에 청소', [5, 6], ['2026-11-21', '2026-11-22']],
	])('unclear "%s" asks: every week or once', (text, days, dates) => {
		const r = rec(text);
		expect(r.status).toBe('ambiguous');
		if (r.status !== 'ambiguous') return;
		expect(r.question.repeat).toMatchObject({ kind: 'weekly', days, interval: 1 });
		expect(r.question.once).toEqual({ kind: 'dates', dates });
	});

	it.each(['금요일', '내일 오후 3시', '오늘', '11월 20일', '매주', '매월', '격주', '다음에', ''])('nothing to repeat in "%s"', (text) => {
		expect(rec(text)).toEqual({ status: 'none' });
	});
});

describe('occurrences (plain calendar math)', () => {
	it('weekly and every-other-week', () => {
		const weekly: Recurrence = { kind: 'weekly', days: [0, 2, 4], interval: 1, start: '2026-11-18' };
		expect(occurrencesBetween(weekly, '2026-11-01', '2026-11-30')).toEqual(['2026-11-18', '2026-11-20', '2026-11-23', '2026-11-25', '2026-11-27', '2026-11-30']);
		const biweekly: Recurrence = { kind: 'weekly', days: [1], interval: 2, start: '2026-11-24' };
		expect(occurrencesBetween(biweekly, '2026-11-01', '2027-01-10')).toEqual(['2026-11-24', '2026-12-08', '2026-12-22', '2027-01-05']);
	});

	it('monthly keeps the day, using the last day in short months (and Feb 29 in leap years)', () => {
		const m31: Recurrence = { kind: 'monthly', day: 31, start: '2026-11-18' };
		expect(occurrencesBetween(m31, '2026-11-01', '2027-03-31')).toEqual(['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31']);
		expect(occurrencesBetween({ kind: 'monthly', day: 30, start: '2028-01-01' }, '2028-02-01', '2028-02-29')).toEqual(['2028-02-29']);
		expect(occurrencesBetween({ kind: 'monthly', day: 15, start: '2026-11-18' }, '2026-11-01', '2026-12-31')).toEqual(['2026-12-15']); // 11-15 is before the start
	});

	it('daily across a month and year end; until stops it; nothing before start', () => {
		const daily: Recurrence = { kind: 'daily', start: '2026-12-30', until: '2027-01-02' };
		expect(occurrencesBetween(daily, '2026-12-01', '2027-01-31')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
	});

	it('next occurrence', () => {
		const weekly: Recurrence = { kind: 'weekly', days: [0, 3], interval: 1, start: '2026-11-19' };
		expect(nextOccurrence(weekly, '2026-11-20')).toBe('2026-11-23');
		expect(nextOccurrence({ kind: 'dates', dates: ['2026-11-19', '2026-11-26'] }, '2026-11-20')).toBe('2026-11-26');
		expect(nextOccurrence({ kind: 'dates', dates: ['2026-11-19'] }, '2026-11-20')).toBeNull();
	});
});

describe('labels and validation', () => {
	it('describes rules in Korean', () => {
		expect(describeRecurrence({ kind: 'daily', start: WED })).toBe('매일');
		expect(describeRecurrence({ kind: 'weekly', days: [0, 1, 2, 3, 4], interval: 1, start: WED })).toBe('매주 평일');
		expect(describeRecurrence({ kind: 'weekly', days: [5, 6], interval: 1, start: WED })).toBe('매주 주말');
		expect(describeRecurrence({ kind: 'weekly', days: [0, 2, 4], interval: 1, start: WED })).toBe('매주 월·수·금');
		expect(describeRecurrence({ kind: 'weekly', days: [1, 3], interval: 2, start: WED })).toBe('격주 화·목');
		expect(describeRecurrence({ kind: 'monthly', day: 15, start: WED })).toBe('매월 15일');
		expect(describeRecurrence({ kind: 'dates', dates: ['2026-11-23', '2026-11-26', '2026-12-01'] })).toBe('11월 23일(월)·26일(목)·12월 1일(화) 한 번씩');
	});

	it.each([
		'{"kind":"weekly","days":[],"interval":1,"start":"2026-11-18"}',
		'{"kind":"weekly","days":[7],"interval":1,"start":"2026-11-18"}',
		'{"kind":"weekly","days":[1],"interval":3,"start":"2026-11-18"}',
		'{"kind":"monthly","day":32,"start":"2026-11-18"}',
		'{"kind":"daily","start":"2026-13-01"}',
		'{"kind":"dates","dates":[]}',
		'{"kind":"hourly"}',
		'not json',
	])('rejects %s', (value) => {
		expect(parseRecurrence(value)).toBeNull();
	});
});

describe('clock time stated in the wording (when the model gave none)', () => {
	it.each([
		['매주 월수금 오후 7시', '19:00'],
		['저녁 7시 30분', '19:30'],
		['아침 7시 반', '07:30'],
		['오전 12시', '00:00'],
		['밤 11시', '23:00'],
		['낮 2시', '14:00'],
		['19:00', '19:00'],
		['오후 7:30', '19:30'],
		['21시', '21:00'],
		['정오', '12:00'],
		['자정', '00:00'],
	])('%s → %s', (text, time) => {
		expect(clockTimeIn(text)).toBe(time);
	});

	it.each(['7시', '매주 월수금', '10:75', '', '세 시'])('no clear time in "%s"', (text) => {
		expect(clockTimeIn(text)).toBeNull();
	});
});

describe('sanitizeMemo with repeat wording (server only)', () => {
	const now = new Date('2026-11-15T03:00:00Z'); // Sun 12:00 KST
	const base = { title: '헬스장', content: '헬스장 가기', category: 'schedule' as const, reminder_recommended: false };

	it('keeps the stated time even when the model left due_at empty (real model behaviour)', () => {
		const m = sanitizeMemo({ ...base, due_text: '매주 월수금 오후 7시', due_at: null }, '매주 월수금 오후 7시에 헬스장 가기', now);
		expect(m.recurrence).toEqual({ kind: 'weekly', days: [0, 2, 4], interval: 1, start: '2026-11-16' });
		expect([m.due_date, m.due_at]).toEqual(['2026-11-16', '2026-11-16T10:00:00.000Z']);
	});

	it('repeat wording missing from due_text but present in the input → asked', () => {
		const m = sanitizeMemo({ ...base, title: '평일 아침 영어 공부', content: '평일 아침 영어 공부', due_text: null }, '평일 아침에 영어 공부도 하고 싶어', now);
		expect(m.recurrence).toBeNull();
		expect(m.recurrence_question?.repeat).toMatchObject({ kind: 'weekly', days: [0, 1, 2, 3, 4] });
	});

	it('the real case: model left the wording out of a single-memo input → read from the input', () => {
		const raw = '이제부터 월, 화, 금, 헬스장 가야해 PT 받아야 돼';
		const memo = { ...base, title: '헬스장 방문 일정 설정', content: '헬스장에서 PT 받기', due_text: null };
		const single = sanitizeMemo(memo, raw, now, { singleMemo: true });
		expect(single.recurrence).toEqual({ kind: 'weekly', days: [0, 1, 4], interval: 1, start: '2026-11-16' });
		expect([single.due_date, single.due_at]).toEqual(['2026-11-16', null]);
		// With several memos from one input, the input's weekdays could belong to another memo: not used.
		expect(sanitizeMemo(memo, raw, now).recurrence).toBeNull();
		// But weekdays in the memo's own text that the input also has are used.
		expect(sanitizeMemo({ ...memo, content: '월, 화, 금 헬스장 PT' }, raw, now).recurrence).toMatchObject({ kind: 'weekly', days: [0, 1, 4] });
	});

	it('a repeat word the input never said is ignored', () => {
		const m = sanitizeMemo({ ...base, title: '매일 운동', content: '매일 운동', due_text: null }, '운동하기', now);
		expect([m.recurrence, m.recurrence_question, m.due_date]).toEqual([null, null, null]);
	});
});
