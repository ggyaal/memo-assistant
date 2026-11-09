import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
	buildDateReference,
	hasExplicitTime,
	kstDate,
	kstDateTimeLabel,
	kstDayRangeUtc,
	normalizeDueAt,
	pinnedDay,
	reconcileRelativeDate,
	resolveDueDate,
} from '../src/server/time.ts';
import { CreateMemosRequestSchema, sanitizeMemo, SaveMemosInputSchema } from '../src/server/validation.ts';

// 2026-11-09 21:40 KST (Monday)
const NOW = new Date('2026-11-09T12:40:00Z');
const RAW = '오늘 장 보고, 내일 오후 3시에 병원 예약해야 해. AI 검색 기능 아이디어도 메모해 줘.';

describe('KST time helpers', () => {
	it('uses the Korean calendar date, not the UTC date', () => {
		// 2026-11-09T15:30Z is already 2026-11-10 00:30 in Seoul.
		expect(kstDate(new Date('2026-11-09T15:30:00Z'))).toBe('2026-11-10');
		expect(kstDate(NOW)).toBe('2026-11-09');
		expect(kstDateTimeLabel(NOW)).toBe('2026-11-09 21:40 (월)');
	});

	it('maps the KST day to a UTC range', () => {
		expect(kstDayRangeUtc(new Date('2026-11-09T15:30:00Z'))).toEqual({
			start: '2026-11-09T15:00:00.000Z',
			end: '2026-11-10T15:00:00.000Z',
		});
	});

	it('builds a date reference table for relative expressions', () => {
		const ref = buildDateReference(NOW);
		expect(ref).toContain('오늘 = 2026-11-09 (월)');
		expect(ref).toContain('내일 = 2026-11-10 (화)');
		expect(ref).toContain('모레 = 2026-11-11 (수)');
	});

	it('normalizes model times to UTC, reading a missing offset as KST', () => {
		expect(normalizeDueAt('2026-11-10T15:00:00+09:00')).toBe('2026-11-10T06:00:00.000Z');
		expect(normalizeDueAt('2026-11-10T15:00')).toBe('2026-11-10T06:00:00.000Z');
		expect(normalizeDueAt('2026-11-10T06:00:00Z')).toBe('2026-11-10T06:00:00.000Z');
		expect(normalizeDueAt('내일 3시')).toBeNull();
		expect(normalizeDueAt('2026-11-10')).toBeNull();
		expect(normalizeDueAt(null)).toBeNull();
	});

	it('pins 내일 to the request date even if the model miscounted', () => {
		expect(reconcileRelativeDate('2026-11-11T06:00:00.000Z', '내일 오후 3시', NOW)).toBe('2026-11-10T06:00:00.000Z');
		// Ambiguous text is left alone.
		expect(reconcileRelativeDate('2026-11-20T06:00:00.000Z', '다음 주 금요일', NOW)).toBe('2026-11-20T06:00:00.000Z');
	});
});

describe('request validation', () => {
	const valid = { nickname: ' 테스터 ', text: ' 안녕 ', requestId: '9b2f7c1e-3d4a-4b5c-8d6e-7f8a9b0c1d2e' };

	it('accepts and trims a valid request', () => {
		const result = v.safeParse(CreateMemosRequestSchema, valid);
		expect(result.success).toBe(true);
		if (result.success) expect(result.output).toMatchObject({ nickname: '테스터', text: '안녕' });
	});

	it.each([
		['empty text', { ...valid, text: '   ' }],
		['text over 1000 chars', { ...valid, text: 'a'.repeat(1001) }],
		['nickname over 20 chars', { ...valid, nickname: 'n'.repeat(21) }],
		['empty nickname', { ...valid, nickname: '' }],
		['bad request id', { ...valid, requestId: 'abc' }],
	])('rejects %s', (_label, body) => {
		expect(v.safeParse(CreateMemosRequestSchema, body).success).toBe(false);
	});

	it('limits the number of memos the model may save', () => {
		const memo = { title: 't', content: 'c', category: 'note' };
		expect(v.safeParse(SaveMemosInputSchema, { memos: [] }).success).toBe(false);
		expect(v.safeParse(SaveMemosInputSchema, { memos: Array(11).fill(memo) }).success).toBe(false);
		expect(v.safeParse(SaveMemosInputSchema, { memos: [{ ...memo, category: 'secret' }] }).success).toBe(false);
	});
});

describe('sanitizeMemo (anti-fabrication guard)', () => {
	it('keeps a stated schedule and converts it to UTC', () => {
		const memo = sanitizeMemo(
			{
				title: '병원 예약',
				content: '내일 오후 3시에 병원 예약하기',
				category: 'todo',
				due_at: '2026-11-10T15:00:00+09:00',
				due_text: '내일 오후 3시',
				reminder_recommended: true,
				reminder_reason: '명확한 수행 시각이 언급됨',
			},
			RAW,
			NOW,
		);
		expect(memo.due_at).toBe('2026-11-10T06:00:00.000Z');
		expect(memo.due_text).toBe('내일 오후 3시');
		expect(memo.reminder_recommended).toBe(true);
	});

	it('drops a date the input never mentioned', () => {
		const memo = sanitizeMemo(
			{
				title: 'AI 검색 기능',
				content: 'AI 검색 기능 아이디어',
				category: 'idea',
				due_at: '2026-11-15T09:00:00+09:00',
				due_text: '다음 주',
				reminder_recommended: false,
				reminder_reason: '없음',
			},
			RAW,
			NOW,
		);
		expect(memo.due_at).toBeNull();
		expect(memo.due_text).toBeNull();
		expect(memo.reminder_reason).toBeNull();
	});

	it('never invents a time when only a day is given', () => {
		const memo = sanitizeMemo(
			{ title: '장보기', content: '오늘 장보기', category: 'todo', due_at: null, due_text: '오늘', reminder_recommended: true },
			RAW,
			NOW,
		);
		expect(memo.due_at).toBeNull();
		expect(memo.due_text).toBe('오늘');
	});

	it('drops a midnight time the model invented for "오늘" (observed with glm-4.7-flash)', () => {
		const memo = sanitizeMemo(
			{
				title: '장 보기',
				content: '오늘 장을 보아야 함',
				category: 'todo',
				due_at: '2026-11-09T00:00:00+09:00',
				due_text: '오늘',
				reminder_recommended: true,
				reminder_reason: '오늘 해야 할 일',
			},
			RAW,
			NOW,
		);
		expect(memo.due_at).toBeNull();
		expect(memo.due_text).toBe('오늘');
		expect(memo.reminder_recommended).toBe(true);
	});

	it.each([
		['내일 오후 3시', true],
		['15:30', true],
		['세 시 반', true],
		['정오', true],
		['오늘', false],
		['내일 오후', false],
		['이번 주 저녁', false],
		['세 시간 뒤', false],
	])('hasExplicitTime(%s) = %s', (text, expected) => {
		expect(hasExplicitTime(text)).toBe(expected);
	});

	it('removes control characters and clips long fields', () => {
		const memo = sanitizeMemo(
			{ title: `a\u0000${'b'.repeat(100)}`, content: 'c', category: 'note', reminder_recommended: false },
			RAW,
			NOW,
		);
		expect(memo.title).not.toContain('\u0000');
		expect(memo.title.length).toBe(60);
	});
});

describe('resolveDueDate (date-only deadlines)', () => {
	it.each([
		['exact time wins', '내일 오후 3시', '2026-11-10T06:00:00.000Z', '2026-12-25', '2026-11-10'],
		['relative word pinned to request date', '오늘', null, '2026-11-20', '2026-11-09'],
		['model date for a named day', '11월 20일', null, '2026-11-20', '2026-11-20'],
		['weekday from the reference table', '금요일까지', null, '2026-11-13', '2026-11-13'],
		['weekday the model miscounted (observed with glm-4.7-flash)', '금요일', null, '2026-11-20', '2026-11-13'],
		['weekday with no model date', '다음 주 금요일', null, null, '2026-11-20'],
		['vague range → none', '다음 주', null, '2026-11-16', null],
		['no deadline text → none', null, null, '2026-11-20', null],
		['past date rejected', '11월 1일', null, '2026-11-01', null],
		['malformed date rejected', '11월 20일', null, '11/20', null],
		['duration is not a day', '3일 동안', null, '2026-11-12', null],
	])('%s', (_label, text, dueAt, modelDate, expected) => {
		expect(resolveDueDate(text, dueAt, modelDate, NOW)).toBe(expected);
	});
});

describe('sanitizeMemo priority', () => {
	const base = { title: 't', content: 'c', category: 'todo' as const, reminder_recommended: false };

	it('keeps a valid priority with its reason', () => {
		const memo = sanitizeMemo({ ...base, priority: 'HIGH', priority_reason: '내일 병원 예약' }, RAW, NOW);
		expect(memo).toMatchObject({ priority: 'high', priority_reason: '내일 병원 예약' });
	});

	it('drops an unknown priority (and its reason) instead of failing', () => {
		const memo = sanitizeMemo({ ...base, priority: 'urgent', priority_reason: 'x' }, RAW, NOW);
		expect(memo).toMatchObject({ priority: null, priority_reason: null });
	});

	it('stores the KST date for a date-only deadline', () => {
		const memo = sanitizeMemo({ ...base, due_text: '오늘', due_at: null, due_date: '2026-11-30' }, RAW, NOW);
		expect(memo).toMatchObject({ due_at: null, due_date: '2026-11-09' });
	});
});

describe('pinnedDay (server-computed day; request on Monday 2026-11-09 KST)', () => {
	it.each([
		['오늘', '2026-11-09'],
		['모레까지', '2026-11-11'],
		['금요일', '2026-11-13'],
		['월요일', '2026-11-09'], // today counts
		['일요일 저녁', '2026-11-15'],
		['이번 주 수요일', '2026-11-11'],
		['다음 주 금요일', '2026-11-20'],
		['담주 화요일', '2026-11-17'],
		['다다음 주 월요일', '2026-11-23'],
		['오늘이나 금요일', null], // ambiguous
		['다음 주', null],
		['11월 20일', null], // explicit dates are left to the model + range check
	])('%s → %s', (text, expected) => {
		expect(pinnedDay(text, NOW)).toBe(expected);
	});

	it('pins a timed weekday deadline too', () => {
		// Model said next-next Friday 14:00; the server keeps 14:00 on this Friday.
		expect(reconcileRelativeDate('2026-11-20T05:00:00.000Z', '금요일 오후 2시', NOW)).toBe('2026-11-13T05:00:00.000Z');
	});
});
