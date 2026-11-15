import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunMemoAgent } from '../src/server/agent-runner.ts';
import { createApi, type ApiBindings } from '../src/server/routes.ts';
import type { CalendarResponse, CreateMemosResponse, ListMemosResponse, MemoDraftPayload } from '../src/shared/types.ts';
import { createSaveMemosTool, type MemoJob } from '../src/tools/save-memos.ts';
import { createTestD1 } from './helpers/d1.ts';

/*
 * Clarifying questions over the API. The model is a stand-in that calls the real save_memos tool;
 * answers, skips, "추가 질문 안 하기" and cancel are server rules only — the runner counts AI calls.
 */

let db: D1Database;
let dispose: () => Promise<void>;
let clock: Date;
let ids = 0;
const rid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

type ModelMemo = { title: string; category: string; due_text: string | null; due_at?: string | null; reminder_recommended?: boolean };
const SCRIPTS: Record<string, ModelMemo[]> = {
	'내일 오후 3시에 병원 예약이 있어': [{ title: '병원 예약', category: 'schedule', due_text: '내일 오후 3시', due_at: '2026-11-17T15:00:00+09:00' }],
	'내일 3시 회의하고 금요일까지 보고서 제출': [
		{ title: '회의', category: 'schedule', due_text: '내일 3시', due_at: '2026-11-17T03:00:00+09:00', reminder_recommended: true },
		{ title: '보고서 제출', category: 'todo', due_text: '금요일까지' },
	],
	'다음 주에 병원 가야 해': [{ title: '병원 방문', category: 'todo', due_text: '다음 주' }],
	'월 화 목 오후 7시에 운동하기': [{ title: '운동', category: 'schedule', due_text: '월 화 목 오후 7시', due_at: '2026-11-16T19:00:00+09:00' }],
};

function makeApp() {
	const calls = { n: 0 };
	const runAgent: RunMemoAgent = async (job: MemoJob, { onProgress }) => {
		calls.n++;
		onProgress?.({ stage: 'analyzing' });
		const tool = createSaveMemosTool({ db, job, onProgress });
		await tool.run({
			data: { memos: SCRIPTS[job.rawText].map((m) => ({ content: m.title, reminder_recommended: false, ...m })) },
			toolCallId: 't',
			log: console,
			signal: new AbortController().signal,
		} as never);
	};
	const app = new Hono<{ Bindings: ApiBindings }>();
	app.route('/api', createApi({ runAgent, now: () => clock }));
	const send = (path: string, init: RequestInit = {}) =>
		app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as object) } }, { DB: db, RATE_LIMIT_PER_MINUTE: '100' });
	const organize = async (text: string, requestId = rid()) => {
		const res = await send('/api/memos', { method: 'POST', body: JSON.stringify({ nickname: '확인', text, requestId }) });
		return { status: res.status, body: (await res.json()) as Partial<CreateMemosResponse> & { draft?: MemoDraftPayload } };
	};
	const commit = (id: string, answers: object[] = []) => send(`/api/memo-drafts/${id}/commit`, { method: 'POST', body: JSON.stringify({ answers }) });
	const titles = async () => ((await (await send('/api/memos?scope=all')).json()) as ListMemosResponse).memos.map((m) => m.title);
	const calendar = async () => ((await (await send('/api/calendar?month=2026-11')).json()) as CalendarResponse).memos.map((m) => `${m.title}@${m.due_date}`);
	return { calls, send, organize, commit, titles, calendar };
}

beforeEach(async () => {
	({ db, dispose } = await createTestD1());
	clock = new Date('2026-11-16T03:00:00Z'); // Mon 12:00 KST
});
afterEach(async () => {
	await dispose();
});

describe('clear input: saved right away, exactly as before', () => {
	it('201 with memos, no draft, one AI call', async () => {
		const t = makeApp();
		const r = await t.organize('내일 오후 3시에 병원 예약이 있어');
		expect(r.status).toBe(201);
		expect(r.body.draft).toBeUndefined();
		expect(r.body.memos?.map((m) => m.title)).toEqual(['병원 예약']);
		expect(t.calls.n).toBe(1);
	});
});

describe('"추가 질문 안 하기" checkbox (noQuestions): never ask, save at once', () => {
	it('unclear parts are saved undecided (no invented time or day); a repeat question stays on the card; one AI call', async () => {
		const t = makeApp();
		const ask = (text: string) =>
			t.send('/api/memos', { method: 'POST', body: JSON.stringify({ nickname: '확인', text, requestId: rid(), noQuestions: true }) });
		const meeting = await ask('내일 3시 회의하고 금요일까지 보고서 제출');
		expect(meeting.status).toBe(201);
		expect(((await meeting.json()) as CreateMemosResponse).memos.map((m) => [m.title, m.due_date, m.due_at])).toEqual([
			['회의', '2026-11-17', null], // the bare "3시" is not kept as 03:00
			['보고서 제출', '2026-11-20', null],
		]);
		const week = (await (await ask('다음 주에 병원 가야 해')).json()) as CreateMemosResponse;
		expect(week.memos[0]).toMatchObject({ due_date: null, due_at: null });
		const routine = (await (await ask('월 화 목 오후 7시에 운동하기')).json()) as CreateMemosResponse;
		expect(routine.memos[0].recurrence).toBeNull();
		expect(routine.memos[0].recurrence_question?.repeat).toMatchObject({ kind: 'weekly', days: [0, 1, 3] });
		expect((await db.prepare('SELECT COUNT(*) AS n FROM memo_drafts').first<{ n: number }>())?.n).toBe(0);
		expect(t.calls.n).toBe(3);
	});
});

describe('unclear input: a draft first, saved once after answers', () => {
	it('nothing is saved or shown until commit; answers apply by rules; commit happens once', async () => {
		const t = makeApp();
		const requestId = rid();
		const r = await t.organize('내일 3시 회의하고 금요일까지 보고서 제출', requestId);
		expect(r.status).toBe(202);
		const draft = r.body.draft!;
		expect(draft.memos.map((m) => m.title)).toEqual(['회의', '보고서 제출']);
		expect(draft.questions.map((q) => [q.kind, q.memoIndex])).toEqual([['meridiem', 0]]);
		expect(await t.titles()).toEqual([]);
		expect(await t.calendar()).toEqual([]);
		// Retry / reconnect of the same request: same draft, no second AI call.
		const again = await t.organize('내일 3시 회의하고 금요일까지 보고서 제출', requestId);
		expect([again.status, again.body.draft?.id, t.calls.n]).toEqual([202, draft.id, 1]);
		// Answer by button → saved; the answer touched only "회의".
		const saved = (await (await t.commit(draft.id, [{ questionId: 'q1', optionId: '15:00' }])).json()) as CreateMemosResponse;
		expect(saved.memos.map((m) => [m.title, m.due_at, m.due_date])).toEqual([
			['회의', '2026-11-17T06:00:00.000Z', '2026-11-17'],
			['보고서 제출', null, '2026-11-20'],
		]);
		expect(await t.titles()).toEqual(['회의', '보고서 제출']);
		// Double click / retry of the commit: the same result, no duplicates; no AI either.
		const twice = await t.commit(draft.id, [{ questionId: 'q1', optionId: '03:00' }]);
		expect(twice.status).toBe(200);
		expect(((await twice.json()) as CreateMemosResponse).duplicate).toBe(true);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM memos').first<{ n: number }>())?.n).toBe(2);
		expect(t.calls.n).toBe(1);
	});

	it('"추가 질문 안 하기" (commit with what was answered so far): undecided parts are left empty', async () => {
		const t = makeApp();
		const { body } = await t.organize('다음 주에 병원 가야 해');
		const res = await t.commit(body.draft!.id, []);
		expect(res.status).toBe(201);
		expect(((await res.json()) as CreateMemosResponse).memos[0]).toMatchObject({ title: '병원 방문', due_date: null, due_at: null });
	});

	it('cancel: nothing saved, the draft cannot be committed afterwards', async () => {
		const t = makeApp();
		const { body } = await t.organize('월 화 목 오후 7시에 운동하기');
		expect((await t.send(`/api/memo-drafts/${body.draft!.id}`, { method: 'DELETE' })).status).toBe(200);
		expect((await t.commit(body.draft!.id)).status).toBe(410);
		expect(await t.titles()).toEqual([]);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM sources').first<{ n: number }>())?.n).toBe(0);
	});

	it('a draft expires after 30 minutes (understandable 410); the input can be organized again', async () => {
		const t = makeApp();
		const { body } = await t.organize('다음 주에 병원 가야 해');
		clock = new Date(clock.getTime() + 31 * 60_000);
		const get = await t.send(`/api/memo-drafts/${body.draft!.id}`);
		expect(get.status).toBe(410);
		expect(((await get.json()) as { message: string }).message).toContain('다시 정리');
		expect((await t.commit(body.draft!.id)).status).toBe(410);
	});

	it('the streaming response ends with a "draft" event after the real steps', async () => {
		const t = makeApp();
		const res = await t.send('/api/memos', {
			method: 'POST',
			headers: { accept: 'text/event-stream' },
			body: JSON.stringify({ nickname: '확인', text: '다음 주에 병원 가야 해', requestId: rid() }),
		});
		const events = [...(await res.text()).matchAll(/event: (\w+)\ndata: (.*)/g)].map(([, e, d]) => (e === 'progress' ? (JSON.parse(d) as { stage: string }).stage : e));
		expect(events).toEqual(['checking', 'analyzing', 'found', 'questions', 'draft']);
	});

	it('another space cannot read, commit or cancel a draft; other sites are refused', async () => {
		const t = makeApp();
		const { body } = await t.organize('다음 주에 병원 가야 해');
		await db.prepare("UPDATE memo_drafts SET workspace_id = 'ws_other'").run();
		expect((await t.send(`/api/memo-drafts/${body.draft!.id}`)).status).toBe(404);
		expect((await t.commit(body.draft!.id)).status).toBe(404);
		await db.prepare("UPDATE memo_drafts SET workspace_id = 'ws_shared_guest'").run();
		expect((await t.send(`/api/memo-drafts/${body.draft!.id}/commit`, { method: 'POST', body: '{"answers":[]}', headers: { origin: 'https://evil.example' } })).status).toBe(403);
		expect((await t.send(`/api/memo-drafts/${body.draft!.id}`, { method: 'DELETE', headers: { origin: 'https://evil.example' } })).status).toBe(403);
	});
});
