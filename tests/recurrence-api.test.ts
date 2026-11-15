import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunMemoAgent } from '../src/server/agent-runner.ts';
import { createApi, type ApiBindings } from '../src/server/routes.ts';
import type { AgendaResponse, CalendarResponse, CreateMemosResponse, ListMemosResponse, Memo } from '../src/shared/types.ts';
import { createSaveMemosTool, type MemoJob } from '../src/tools/save-memos.ts';
import { createTestD1 } from './helpers/d1.ts';

/*
 * Repeating / several-day schedules in the public space: the server reads the stored
 * wording (due_text) — the model only copies it — and everything after that is calendar math.
 */

let db: D1Database;
let dispose: () => Promise<void>;
let clock: Date;
let ids = 0;
const rid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

/** Stands in for the model: one memo with the given wording (as the model would copy it). */
function runner(memo: { due_text: string; due_at?: string | null; category?: string; title?: string }): RunMemoAgent & { calls: number } {
	const r = Object.assign(
		async (job: MemoJob) => {
			r.calls++;
			const tool = createSaveMemosTool({ db, job });
			await tool.run({
				data: { memos: [{ title: memo.title ?? '운동', content: job.rawText, category: memo.category ?? 'schedule', due_text: memo.due_text, due_at: memo.due_at ?? null, reminder_recommended: false }] },
				toolCallId: 't',
				log: console,
				signal: new AbortController().signal,
			} as never);
		},
		{ calls: 0 },
	);
	return r;
}

function makeApp(run: RunMemoAgent) {
	const app = new Hono<{ Bindings: ApiBindings }>();
	app.route('/api', createApi({ runAgent: run, now: () => clock, agentTimeoutMs: 1000 }));
	const send = (path: string, init: RequestInit = {}) =>
		app.request(path, { ...init, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.1', ...(init.headers as object) } }, { DB: db, RATE_LIMIT_PER_MINUTE: '100' });
	return {
		send,
		create: async (text: string) => ((await (await send('/api/memos', { method: 'POST', body: JSON.stringify({ nickname: '반복', text, requestId: rid() }) })).json()) as CreateMemosResponse).memos[0],
		list: async () => ((await (await send('/api/memos?scope=all')).json()) as ListMemosResponse).memos,
		calendar: async (month: string) => ((await (await send(`/api/calendar?month=${month}`)).json()) as CalendarResponse).memos,
		agenda: async () => (await (await send('/api/agenda')).json()) as AgendaResponse,
		done: (id: string, day: string, completed: boolean) => send(`/api/memos/${id}/occurrences/${day}`, { method: 'PATCH', body: JSON.stringify({ completed }) }),
		choose: (id: string, choice: string) => send(`/api/memos/${id}/recurrence`, { method: 'POST', body: JSON.stringify({ choice }) }),
	};
}

const days = (memos: Memo[], title = '운동') => memos.filter((m) => m.title === title).map((m) => `${m.occurrence?.date ?? m.due_date}${m.occurrence?.completed_at ? '✓' : ''}`);

beforeEach(async () => {
	({ db, dispose } = await createTestD1());
	clock = new Date('2026-11-18T03:00:00Z'); // Wed 2026-11-18 12:00 KST
});
afterEach(async () => {
	await dispose();
});

describe('saving: the server turns the wording into a rule (no AI math)', () => {
	it('"매주 월수금 오후 7시": weekly rule, first occurrence today 19:00 KST', async () => {
		const app = makeApp(runner({ due_text: '매주 월수금 오후 7시', due_at: '2026-11-25T19:00:00+09:00' })); // model got the date wrong
		const memo = await app.create('매주 월수금 오후 7시 운동');
		expect(memo.recurrence).toEqual({ kind: 'weekly', days: [0, 2, 4], interval: 1, start: '2026-11-18', until: null });
		expect(memo.recurrence_question).toBeNull();
		expect([memo.due_date, memo.due_at]).toEqual(['2026-11-18', '2026-11-18T10:00:00.000Z']);
	});

	it('a time already past today starts at the next occurrence', async () => {
		clock = new Date('2026-11-18T11:00:00Z'); // 20:00 KST
		const memo = await makeApp(runner({ due_text: '매주 월수금 오후 7시', due_at: '2026-11-18T19:00:00+09:00' })).create('매주 월수금 오후 7시 운동');
		expect([memo.due_date, memo.due_at]).toEqual(['2026-11-20', '2026-11-20T10:00:00.000Z']);
	});

	it('"다음 주 월, 목": two one-time days', async () => {
		const memo = await makeApp(runner({ due_text: '다음 주 월, 목' })).create('다음 주 월, 목 병원');
		expect(memo.recurrence).toEqual({ kind: 'dates', dates: ['2026-11-23', '2026-11-26'] });
		expect(memo.due_date).toBe('2026-11-23');
	});

	it('"월수금 운동" is unclear: stored as a question, first day kept', async () => {
		const memo = await makeApp(runner({ due_text: '월수금' })).create('월수금 운동');
		expect(memo.recurrence).toBeNull();
		expect(memo.recurrence_question?.repeat).toMatchObject({ kind: 'weekly', days: [0, 2, 4] });
		expect(memo.recurrence_question?.once).toEqual({ kind: 'dates', dates: ['2026-11-18', '2026-11-20', '2026-11-23'] });
		expect(memo.due_date).toBe('2026-11-18');
	});

	it('wording the model did not copy from the input is ignored (no invented repeat)', async () => {
		const memo = await makeApp(runner({ due_text: '매일' })).create('운동하기');
		expect(memo.recurrence).toBeNull();
		expect(memo.due_date).toBeNull();
	});
});

describe('list, calendar and agenda show occurrences from the same row', () => {
	it('calendar: every occurrence in the month, once; one-time memos as before', async () => {
		const app = makeApp(runner({ due_text: '매주 월수금 오후 7시', due_at: '2026-11-18T19:00:00+09:00' }));
		await app.create('매주 월수금 오후 7시 운동');
		expect(days(await app.calendar('2026-11'))).toEqual(['2026-11-18', '2026-11-20', '2026-11-23', '2026-11-25', '2026-11-27', '2026-11-30']);
		const dec = await app.calendar('2026-12');
		expect(days(dec).length).toBe(13); // Dec 2026: 4 Mondays + 5 Wednesdays + 4 Fridays
		expect(dec.find((m) => m.title === '운동')?.occurrence?.at).toBe('2026-12-02T10:00:00.000Z'); // 19:00 KST every time
		expect(days(await app.calendar('2026-10'))).toEqual([]); // nothing before the start
	});

	it('per-occurrence done: only that day changes; non-occurrence days are refused; undo works', async () => {
		const app = makeApp(runner({ due_text: '매주 월수금 오후 7시', due_at: '2026-11-18T19:00:00+09:00' }));
		const memo = await app.create('매주 월수금 오후 7시 운동');
		expect((await app.done(memo.id, '2026-11-20', true)).status).toBe(200);
		expect(days(await app.calendar('2026-11'))).toEqual(['2026-11-18', '2026-11-20✓', '2026-11-23', '2026-11-25', '2026-11-27', '2026-11-30']);
		expect((await app.done(memo.id, '2026-11-19', true)).status).toBe(404); // Thursday is not an occurrence
		expect((await app.done(memo.id, '2026-11-20', true)).status).toBe(200); // idempotent
		expect((await app.done(memo.id, '2026-11-20', false)).status).toBe(200);
		expect(days(await app.calendar('2026-11'))).not.toContain('2026-11-20✓');
		expect((await app.send(`/api/memos/${memo.id}/occurrences/2026-11-20`, { method: 'PATCH', body: JSON.stringify({ completed: true }), headers: { origin: 'https://evil.example' } })).status).toBe(403);
	});

	it('list and agenda show the next not-done occurrence; a repeating memo never becomes "overdue"', async () => {
		const app = makeApp(runner({ due_text: '매주 월수금 오후 7시', due_at: '2026-11-18T19:00:00+09:00' }));
		const memo = await app.create('매주 월수금 오후 7시 운동');
		expect((await app.list())[0].occurrence).toEqual({ date: '2026-11-18', at: '2026-11-18T10:00:00.000Z', completed_at: null });
		await app.done(memo.id, '2026-11-18', true);
		expect((await app.list())[0].occurrence?.date).toBe('2026-11-20');
		clock = new Date('2026-11-24T03:00:00Z'); // the next week; 11-20 and 11-23 were missed
		const agenda = await app.agenda();
		expect(agenda.ranked.map((m) => [m.title, m.occurrence?.date])).toEqual([['운동', '2026-11-25']]);
		expect(agenda.overdue).toEqual([]);
	});

	it('"once" days are one-time: they end, and nothing repeats after them', async () => {
		const app = makeApp(runner({ due_text: '다음 주 월, 목' }));
		await app.create('다음 주 월, 목 병원');
		expect(days(await app.calendar('2026-11'))).toEqual(['2026-11-23', '2026-11-26']);
		expect(days(await app.calendar('2026-12'))).toEqual([]);
	});
});

describe('asking when the wording is unclear', () => {
	it('"매주 반복" turns it into a weekly rule; "이번만" keeps just those days; asked once', async () => {
		const app = makeApp(runner({ due_text: '월수금' }));
		const a = await app.create('월수금 운동');
		const repeat = (await (await app.choose(a.id, 'repeat')).json()) as { memo: Memo };
		expect(repeat.memo.recurrence).toMatchObject({ kind: 'weekly', days: [0, 2, 4], interval: 1 });
		expect(repeat.memo.recurrence_question).toBeNull();
		expect((await app.choose(a.id, 'once')).status).toBe(409);

		const b = await app.create('월수금 운동');
		const once = (await (await app.choose(b.id, 'once')).json()) as { memo: Memo };
		expect(once.memo.recurrence).toEqual({ kind: 'dates', dates: ['2026-11-18', '2026-11-20', '2026-11-23'] });
		expect((await app.choose(b.id, 'maybe')).status).toBe(400);
	});
});

describe('editing the repeat in the form', () => {
	const put = (app: ReturnType<typeof makeApp>, m: Memo, change: object) =>
		app.send(`/api/memos/${m.id}`, {
			method: 'PUT',
			body: JSON.stringify({ title: m.title, content: m.content, category: m.category, priority: m.priority, dueDate: m.due_date, dueTime: '19:00', ...change }),
		});

	it('every other week Tue/Thu from a date, back to one-time, and "keep" leaves the rule alone', async () => {
		const run = runner({ due_text: '매주 월수금 오후 7시', due_at: '2026-11-18T19:00:00+09:00' });
		const app = makeApp(run);
		const memo = await app.create('매주 월수금 오후 7시 운동');
		const biweekly = (await (await put(app, memo, { dueDate: '2026-11-19', repeat: { kind: 'weekly', days: [1, 3], interval: 2 } })).json()) as { memo: Memo };
		expect(biweekly.memo.recurrence).toMatchObject({ kind: 'weekly', days: [1, 3], interval: 2, start: '2026-11-19' });
		expect(days(await app.calendar('2026-12'))).toEqual(['2026-12-01', '2026-12-03', '2026-12-15', '2026-12-17', '2026-12-29', '2026-12-31']);
		const kept = (await (await put(app, biweekly.memo, { title: '운동', dueDate: biweekly.memo.due_date })).json()) as { memo: Memo };
		expect(kept.memo.recurrence).toMatchObject({ kind: 'weekly', interval: 2 });
		const single = (await (await put(app, kept.memo, { repeat: null })).json()) as { memo: Memo };
		expect(single.memo.recurrence).toBeNull();
		expect(days(await app.calendar('2026-12'))).toEqual([]);
		// Repeat without a start date is refused.
		expect((await put(app, single.memo, { dueDate: null, dueTime: null, repeat: { kind: 'daily' } })).status).toBe(400);
		// All of this was stored as given: the AI ran only for the first save.
		expect(run.calls).toBe(1);
	});
});
