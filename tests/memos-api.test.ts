import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunMemoAgent } from '../src/server/agent-runner.ts';
import { createApi, type ApiBindings } from '../src/server/routes.ts';
import type { CreateMemosResponse, ListMemosResponse } from '../src/shared/types.ts';
import { createSaveMemosTool, type MemoJob } from '../src/tools/save-memos.ts';
import { createTestD1 } from './helpers/d1.ts';

const RAW = '오늘 장 보고, 내일 오후 3시에 병원 예약해야 해. AI 검색 기능 아이디어도 메모해 줘.';

/** The three memos SPEC §4 expects for the sample input. */
const SAMPLE_MEMOS = [
	{ title: '장보기', content: '오늘 장보기', category: 'todo', due_at: null, due_text: '오늘', reminder_recommended: true, reminder_reason: '오늘 해야 할 일로 언급됨', priority: 'medium', priority_reason: '오늘 안에 하면 됨' },
	{ title: '병원 예약', content: '내일 오후 3시에 병원 예약하기', category: 'todo', due_at: '2026-11-10T15:00:00+09:00', due_text: '내일 오후 3시', reminder_recommended: true, reminder_reason: '명확한 수행 시각이 언급됨', priority: 'high', priority_reason: '건강 관련 약속' },
	{ title: 'AI 검색 기능', content: 'AI 검색 기능 추가 아이디어', category: 'idea', due_at: null, due_text: null, reminder_recommended: false, reminder_reason: null, priority: 'low', priority_reason: '기한 없는 아이디어' },
] as const;

/** Runs the real save_memos tool, standing in for the model's tool call. */
function toolRunner(db: D1Database, memos: readonly object[] = SAMPLE_MEMOS): RunMemoAgent & { calls: MemoJob[] } {
	const calls: MemoJob[] = [];
	const runner = async (job: MemoJob) => {
		calls.push(job);
		const tool = createSaveMemosTool({ db, job });
		await tool.run({ data: { memos: memos as never }, toolCallId: 'test', log: console, signal: new AbortController().signal } as never);
	};
	return Object.assign(runner, { calls });
}

let db: D1Database;
let dispose: () => Promise<void>;
let clock: Date;
let ids = 0;

function makeApp(runAgent: RunMemoAgent, env: Partial<ApiBindings> = {}) {
	const app = new Hono<{ Bindings: ApiBindings }>();
	app.route('/api', createApi({ runAgent, now: () => clock, agentTimeoutMs: 1000 }));
	return {
		request: (path: string, init?: RequestInit & { ip?: string }) =>
			app.request(
				path,
				{ ...init, headers: { 'content-type': 'application/json', 'cf-connecting-ip': init?.ip ?? '203.0.113.1', ...init?.headers } },
				{ DB: db, ...env },
			),
	};
}

function body(text = RAW, requestId = newRequestId(), nickname = '테스터') {
	return JSON.stringify({ nickname, text, requestId });
}

function newRequestId() {
	ids += 1;
	return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`;
}

beforeEach(async () => {
	({ db, dispose } = await createTestD1());
	clock = new Date('2026-11-09T12:40:00Z'); // 21:40 KST
});

afterEach(async () => {
	await dispose();
});

describe('POST /api/memos', () => {
	it('splits one input into 3 memos, keeps the source and links source_id', async () => {
		const runner = toolRunner(db);
		const app = makeApp(runner);
		const res = await app.request('/api/memos', { method: 'POST', body: body() });
		expect(res.status).toBe(201);
		const json = (await res.json()) as CreateMemosResponse;
		expect(json.duplicate).toBe(false);
		expect(json.memos).toHaveLength(3);
		expect(json.source.raw_text).toBe(RAW);
		expect(json.memos.every((m) => m.source_id === json.source.id)).toBe(true);
		expect(json.memos.map((m) => m.category)).toEqual(['todo', 'todo', 'idea']);

		const [shopping, hospital, idea] = json.memos;
		expect(hospital.due_at).toBe('2026-11-10T06:00:00.000Z'); // tomorrow 15:00 KST
		expect(shopping.due_at).toBeNull(); // no time given → no invented time
		expect(idea.due_at).toBeNull();
		expect(idea.due_text).toBeNull();
		expect(hospital.created_at).toBe('2026-11-09T12:40:00.000Z'); // created_at ≠ due_at

		// Trusted fields come from the server, not from the model.
		expect(runner.calls[0]).toMatchObject({ nickname: '테스터', rawText: RAW, createdAt: clock.toISOString() });
		const rows = await db.prepare('SELECT COUNT(*) AS n FROM sources').first<{ n: number }>();
		expect(rows?.n).toBe(1);
	});

	it('does not save twice or call the AI again for the same requestId', async () => {
		const runner = toolRunner(db);
		const app = makeApp(runner);
		const requestId = newRequestId();
		const first = await app.request('/api/memos', { method: 'POST', body: body(RAW, requestId) });
		const second = await app.request('/api/memos', { method: 'POST', body: body(RAW, requestId) });
		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		expect(((await second.json()) as CreateMemosResponse).duplicate).toBe(true);
		expect(runner.calls).toHaveLength(1);
		const memos = await db.prepare('SELECT COUNT(*) AS n FROM memos').first<{ n: number }>();
		expect(memos?.n).toBe(3);
	});

	it('is idempotent even if the tool runs twice for one request', async () => {
		const job: MemoJob = {
			sourceId: crypto.randomUUID(),
			requestId: newRequestId(),
			nickname: 'n',
			rawText: RAW,
			createdAt: clock.toISOString(),
		};
		const tool = createSaveMemosTool({ db, job });
		const ctx = { data: { memos: SAMPLE_MEMOS as never }, toolCallId: 't', log: console, signal: new AbortController().signal } as never;
		const a = (await tool.run(ctx)) as { output: { saved: number } };
		const b = (await tool.run(ctx)) as { output: { saved: number } };
		expect(a.output.saved).toBe(3);
		expect(b.output.saved).toBe(0);
		const memos = await db.prepare('SELECT COUNT(*) AS n FROM memos').first<{ n: number }>();
		expect(memos?.n).toBe(3);
	});

	it.each([
		['invalid JSON', '{nope', 400, 'invalid_request'],
		['empty text', body('   '), 400, 'invalid_request'],
		['too long text', body('가'.repeat(1001)), 400, 'invalid_request'],
		['too long nickname', body(RAW, undefined, 'n'.repeat(21)), 400, 'invalid_request'],
		['oversized body', JSON.stringify({ pad: 'x'.repeat(9000) }), 413, 'payload_too_large'],
	])('rejects %s before reaching the agent', async (_label, payload, status, code) => {
		const runner = toolRunner(db);
		const res = await makeApp(runner).request('/api/memos', { method: 'POST', body: payload });
		expect(res.status).toBe(status);
		expect(((await res.json()) as { error: string }).error).toBe(code);
		expect(runner.calls).toHaveLength(0);
	});

	it('blocks cross-site browser requests before the agent', async () => {
		const runner = toolRunner(db);
		const app = makeApp(runner);
		// A "simple" cross-site form/fetch POST (no preflight) is refused.
		const plain = await app.request('/api/memos', { method: 'POST', body: body(), headers: { 'content-type': 'text/plain' } });
		expect(plain.status).toBe(415);
		const foreign = await app.request('/api/memos', { method: 'POST', body: body(), headers: { origin: 'https://evil.example' } });
		expect(foreign.status).toBe(403);
		expect(((await foreign.json()) as { error: string }).error).toBe('forbidden_origin');
		expect(runner.calls).toHaveLength(0);
		// The app's own origin still works.
		const same = await app.request('/api/memos', { method: 'POST', body: body(), headers: { origin: 'http://localhost' } });
		expect(same.status).toBe(201);
	});

	it('sends security headers on API responses', async () => {
		const res = await makeApp(toolRunner(db)).request('/api/memos?scope=all');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
		expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('access-control-allow-origin')).toBeNull();
	});

	it.each([
		['phone', '내일 010-1234-5678로 전화하기', '전화번호'],
		['secret', '와이파이 비밀번호: qwer1234 메모', '비밀번호'],
		['email in nickname', '회의 준비', '이메일'],
	])('refuses sensitive data (%s) before the AI and stores nothing', async (label, text, word) => {
		const runner = toolRunner(db);
		const nickname = label === 'email in nickname' ? 'me@example.com' : '테스터';
		const res = await makeApp(runner).request('/api/memos', { method: 'POST', body: body(text, undefined, nickname) });
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: string; message: string };
		expect(json.error).toBe('sensitive_info');
		expect(json.message).toContain(word);
		expect(json.message).not.toContain('5678'); // never echoes the value
		expect(runner.calls).toHaveLength(0);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM sources').first<{ n: number }>())?.n).toBe(0);
		expect((await (await makeApp(runner).request('/api/usage')).json() as { total: number }).total).toBe(0);
	});

	it('still accepts ordinary memos that mention passwords as a task', async () => {
		const res = await makeApp(toolRunner(db)).request('/api/memos', { method: 'POST', body: body('오늘 장 보고 비밀번호 바꾸기') });
		expect(res.status).toBe(201);
	});

	it('rate limits per client per minute (server side)', async () => {
		const runner = toolRunner(db);
		const app = makeApp(runner, { RATE_LIMIT_PER_MINUTE: '2', DAILY_AI_LIMIT: '100' });
		const statuses: number[] = [];
		for (let i = 0; i < 3; i++) statuses.push((await app.request('/api/memos', { method: 'POST', body: body() })).status);
		expect(statuses).toEqual([201, 201, 429]);
		// Another client is not affected; the next minute resets.
		expect((await app.request('/api/memos', { method: 'POST', body: body(), ip: '198.51.100.7' })).status).toBe(201);
		clock = new Date(clock.getTime() + 61_000);
		expect((await app.request('/api/memos', { method: 'POST', body: body() })).status).toBe(201);
		expect(runner.calls).toHaveLength(4);
	});

	it('enforces the global daily AI limit', async () => {
		const runner = toolRunner(db);
		const app = makeApp(runner, { RATE_LIMIT_PER_MINUTE: '100', DAILY_AI_LIMIT: '1' });
		expect((await app.request('/api/memos', { method: 'POST', body: body() })).status).toBe(201);
		const res = await app.request('/api/memos', { method: 'POST', body: body(), ip: '198.51.100.9' });
		expect(res.status).toBe(429);
		expect(((await res.json()) as { error: string }).error).toBe('daily_limit_reached');
		expect(res.headers.get('retry-after')).toBeTruthy();
	});

	it.each([
		['model error', new Error('model exploded'), 502, 'agent_failed'],
		['Workers AI quota', new Error('4006: you have used up your daily free allocation of 10,000 neurons'), 503, 'ai_quota_exceeded'],
		['timeout', new DOMException('The operation timed out.', 'TimeoutError'), 504, 'agent_timeout'],
	])('reports %s to the user', async (_label, error, status, code) => {
		const res = await makeApp(async () => {
			throw error;
		}).request('/api/memos', { method: 'POST', body: body() });
		expect(res.status).toBe(status);
		const json = (await res.json()) as { error: string; message: string };
		expect(json.error).toBe(code);
		expect(json.message.length).toBeGreaterThan(0);
	});

	it('reports when the agent finished without calling save_memos', async () => {
		const res = await makeApp(async () => {}).request('/api/memos', { method: 'POST', body: body() });
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error: string }).error).toBe('not_saved');
	});

	it('reports a DB failure', async () => {
		const broken = { prepare: () => { throw new Error('D1_ERROR: database unavailable'); } } as unknown as D1Database;
		const app = new Hono<{ Bindings: ApiBindings }>();
		app.route('/api', createApi({ runAgent: async () => {} }));
		const res = await app.request('/api/memos', { method: 'POST', body: body(), headers: { 'content-type': 'application/json' } }, { DB: broken });
		expect(res.status).toBe(500);
		expect(((await res.json()) as { error: string }).error).toBe('db_error');
	});
});

describe('GET /api/agenda', () => {
	type Agenda = { reminders: { title: string; due_at: string | null; due_date: string | null }[]; ranked: { title: string; priority: string | null }[] };
	const agenda = async (app: ReturnType<typeof makeApp>) => (await (await app.request('/api/agenda')).json()) as Agenda;

	it('lists upcoming reminders by time and ranks dated memos by priority', async () => {
		const app = makeApp(toolRunner(db));
		expect((await app.request('/api/memos', { method: 'POST', body: body() })).status).toBe(201);
		const a = await agenda(app);
		// 장보기: date-only "오늘" (2026-11-09 KST) → before tomorrow 15:00.
		expect(a.reminders.map((m) => m.title)).toEqual(['장보기', '병원 예약']);
		expect(a.reminders[0]).toMatchObject({ due_at: null, due_date: '2026-11-09' });
		// The idea has no date, so it is not on the agenda.
		expect(a.ranked.map((m) => [m.title, m.priority])).toEqual([
			['병원 예약', 'high'],
			['장보기', 'medium'],
		]);
	});

	it('drops items once their time or day has passed', async () => {
		const app = makeApp(toolRunner(db));
		await app.request('/api/memos', { method: 'POST', body: body() });
		clock = new Date('2026-11-10T05:00:00Z'); // 11-10 14:00 KST: 장보기(11-09) is past, 병원(15:00) is not
		expect((await agenda(app)).reminders.map((m) => m.title)).toEqual(['병원 예약']);
		clock = new Date('2026-11-10T07:00:00Z'); // 16:00 KST: both past
		const later = (await (await app.request('/api/agenda')).json()) as { reminders: unknown[]; ranked: unknown[]; overdue: { title: string }[] };
		expect(later.reminders).toEqual([]);
		expect(later.ranked).toEqual([]);
		expect(later.overdue.map((m) => m.title)).toEqual(['병원 예약', '장보기']); // they move to 지나버린 일
	});

	it('returns empty lists with no-store caching', async () => {
		const res = await makeApp(toolRunner(db)).request('/api/agenda');
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({ reminders: [], ranked: [], overdue: [] });
	});
});

describe('PUT /api/agenda/order (feature 1: drag & drop)', () => {
	type Ranked = { ranked: { id: string; title: string; manual_rank: number | null }[] };
	const ABC = [
		{ title: 'A', content: 'A 하기', category: 'todo', due_at: null, due_date: '2026-11-10', due_text: '내일', priority: 'high' },
		{ title: 'B', content: 'B 하기', category: 'todo', due_at: null, due_date: '2026-11-11', due_text: '모레', priority: 'medium' },
		{ title: 'C', content: 'C 하기', category: 'todo', due_at: null, due_date: '2026-11-12', due_text: '글피', priority: 'low' },
	];
	const RAW_ABC = '내일 A, 모레 B, 글피 C';
	const ranked = async (app: ReturnType<typeof makeApp>) => ((await (await app.request('/api/agenda')).json()) as Ranked).ranked;
	const put = (app: ReturnType<typeof makeApp>, payload: unknown, headers: Record<string, string> = {}) =>
		app.request('/api/agenda/order', { method: 'PUT', body: typeof payload === 'string' ? payload : JSON.stringify(payload), headers });

	async function seedABC() {
		const app = makeApp(toolRunner(db, ABC));
		expect((await app.request('/api/memos', { method: 'POST', body: body(RAW_ABC) })).status).toBe(201);
		return app;
	}

	it('A, B, C → C, A, B is saved and still C, A, B on the next load', async () => {
		const app = await seedABC();
		const before = await ranked(app);
		expect(before.map((m) => m.title)).toEqual(['A', 'B', 'C']);
		const byTitle = Object.fromEntries(before.map((m) => [m.title, m.id]));

		const res = await put(app, { ids: [byTitle.C, byTitle.A, byTitle.B] });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ updated: 3 });

		// "Refresh": a fresh read from D1.
		const after = await ranked(app);
		expect(after.map((m) => m.title)).toEqual(['C', 'A', 'B']);
		expect(after.map((m) => m.manual_rank)).toEqual([0, 1, 2]);
	});

	it('a later AI-organized memo does not overwrite the user order', async () => {
		const app = await seedABC();
		const ids = Object.fromEntries((await ranked(app)).map((m) => [m.title, m.id]));
		await put(app, { ids: [ids.C, ids.A, ids.B] });
		const runner = toolRunner(db, [{ title: 'NEW', content: '내일 급한 일', category: 'todo', due_at: null, due_text: '내일', priority: 'high' }]);
		const app2 = makeApp(runner);
		expect((await app2.request('/api/memos', { method: 'POST', body: body('내일 급한 일') })).status).toBe(201);
		expect((await ranked(app2)).map((m) => m.title)).toEqual(['C', 'A', 'B', 'NEW']);
	});

	it.each([
		['empty list', { ids: [] }],
		['duplicate ids', { ids: ['00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000aa'] }],
		['non-uuid id', { ids: ['abc'] }],
		['more than 20', { ids: Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }],
		['bad JSON', '{nope'],
	])('rejects %s with 400', async (_label, payload) => {
		const res = await put(makeApp(toolRunner(db)), payload);
		expect(res.status).toBe(400);
	});

	it('returns 404 when none of the ids exist', async () => {
		const res = await put(makeApp(toolRunner(db)), { ids: ['00000000-0000-4000-8000-0000000000ff'] });
		expect(res.status).toBe(404);
	});

	it('blocks cross-site and non-JSON requests', async () => {
		const app = await seedABC();
		const id = (await ranked(app))[0].id;
		expect((await put(app, { ids: [id] }, { origin: 'https://evil.example' })).status).toBe(403);
		expect((await put(app, { ids: [id] }, { 'content-type': 'text/plain' })).status).toBe(415);
	});

	it('rate limits board edits per client', async () => {
		const app = await seedABC();
		const id = (await ranked(app))[0].id;
		const statuses: number[] = [];
		for (let i = 0; i < 31; i++) statuses.push((await put(app, { ids: [id] })).status);
		expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
		expect(statuses[30]).toBe(429);
	});
});

describe('PATCH /api/memos/:id (feature 2: done check)', () => {
	type List = { memos: { id: string; title: string; completed_at: string | null }[] };
	const list = async (app: ReturnType<typeof makeApp>) => ((await (await app.request('/api/memos?scope=all')).json()) as List).memos;
	const patch = (app: ReturnType<typeof makeApp>, id: string, payload: unknown, headers: Record<string, string> = {}) =>
		app.request(`/api/memos/${id}`, { method: 'PATCH', body: typeof payload === 'string' ? payload : JSON.stringify(payload), headers });

	async function seed() {
		const app = makeApp(toolRunner(db));
		expect((await app.request('/api/memos', { method: 'POST', body: body() })).status).toBe(201);
		const memos = await list(app);
		return { app, hospital: memos.find((m) => m.title === '병원 예약')! };
	}

	it('check → saved (survives a reload) → uncheck → back to not done', async () => {
		const { app, hospital } = await seed();
		expect(hospital.completed_at).toBeNull();

		const checked = await patch(app, hospital.id, { completed: true });
		expect(checked.status).toBe(200);
		expect(((await checked.json()) as { memo: { completed_at: string } }).memo.completed_at).toBe(clock.toISOString());
		expect((await list(app)).find((m) => m.id === hospital.id)?.completed_at).toBe(clock.toISOString());

		const unchecked = await patch(app, hospital.id, { completed: false });
		expect(unchecked.status).toBe(200);
		expect((await list(app)).find((m) => m.id === hospital.id)?.completed_at).toBeNull();
	});

	it('done memos leave the reminder list but stay in the priority list', async () => {
		const { app, hospital } = await seed();
		await patch(app, hospital.id, { completed: true });
		const agenda = (await (await app.request('/api/agenda')).json()) as { reminders: { id: string }[]; ranked: { id: string; completed_at: string | null }[] };
		expect(agenda.reminders.map((m) => m.id)).not.toContain(hospital.id);
		expect(agenda.ranked.find((m) => m.id === hospital.id)?.completed_at).not.toBeNull();
	});

	it.each([
		['bad id', 'abc', { completed: true }, 400],
		['missing flag', '00000000-0000-4000-8000-0000000000aa', {}, 400],
		['non-boolean flag', '00000000-0000-4000-8000-0000000000aa', { completed: 'yes' }, 400],
		['unknown memo', '00000000-0000-4000-8000-0000000000aa', { completed: true }, 404],
	])('rejects %s', async (_label, id, payload, status) => {
		expect((await patch(makeApp(toolRunner(db)), id, payload)).status).toBe(status);
	});

	it('blocks cross-site and non-JSON requests', async () => {
		const { app, hospital } = await seed();
		expect((await patch(app, hospital.id, { completed: true }, { origin: 'https://evil.example' })).status).toBe(403);
		expect((await patch(app, hospital.id, { completed: true }, { 'content-type': 'text/plain' })).status).toBe(415);
		expect((await list(app)).find((m) => m.id === hospital.id)?.completed_at).toBeNull();
	});
});

describe('지나버린 일 (feature 3: overdue list + delete)', () => {
	type Item = { id: string; title: string; completed_at: string | null };
	type Agenda = { reminders: Item[]; ranked: Item[]; overdue: Item[] };
	const agenda = async (app: ReturnType<typeof makeApp>) => (await (await app.request('/api/agenda')).json()) as Agenda;
	const overdueTitles = async (app: ReturnType<typeof makeApp>) => (await agenda(app)).overdue.map((m) => m.title);
	const allTitles = async (app: ReturnType<typeof makeApp>) =>
		((await (await app.request('/api/memos?scope=all')).json()) as { memos: Item[] }).memos.map((m) => m.title);
	const del = (app: ReturnType<typeof makeApp>, id: string, headers: Record<string, string> = {}) =>
		app.request(`/api/memos/${id}`, { method: 'DELETE', headers });

	// Saved on 11-09 21:40 KST: 장보기 (date-only 11-09), 병원 예약 (11-10 15:00 KST), AI 검색 기능 (no deadline).
	async function seed() {
		const app = makeApp(toolRunner(db));
		expect((await app.request('/api/memos', { method: 'POST', body: body() })).status).toBe(201);
		const memos = ((await (await app.request('/api/memos?scope=all')).json()) as { memos: Item[] }).memos;
		const id = (title: string) => memos.find((m) => m.title === title)!.id;
		return { app, shopping: id('장보기'), hospital: id('병원 예약'), idea: id('AI 검색 기능') };
	}

	it('yesterday + not done → shown; no deadline → not shown; today/future → not shown', async () => {
		const { app } = await seed();
		expect(await overdueTitles(app)).toEqual([]); // nothing has passed yet on 11-09
		clock = new Date('2026-11-10T03:00:00Z'); // 11-10 12:00 KST
		// 장보기 was due yesterday (date only) → overdue. 병원 예약 is today 15:00 → not yet. The idea has no deadline.
		expect(await overdueTitles(app)).toEqual(['장보기']);
		clock = new Date('2026-11-11T03:00:00Z'); // 11-11 12:00 KST: 병원 예약 (yesterday 15:00) has passed too
		expect(await overdueTitles(app)).toEqual(['병원 예약', '장보기']);
	});

	it('a date-only deadline is not overdue until that KST day is over', async () => {
		const { app } = await seed();
		clock = new Date('2026-11-09T14:59:59Z'); // 11-09 23:59:59 KST
		expect(await overdueTitles(app)).toEqual([]);
		clock = new Date('2026-11-09T15:00:00Z'); // 11-10 00:00 KST
		expect(await overdueTitles(app)).toEqual(['장보기']);
	});

	it('yesterday + done → not shown; unchecking brings it back', async () => {
		const { app, shopping } = await seed();
		clock = new Date('2026-11-10T03:00:00Z');
		const patch = (completed: boolean) =>
			app.request(`/api/memos/${shopping}`, { method: 'PATCH', body: JSON.stringify({ completed }) });
		expect((await patch(true)).status).toBe(200);
		expect(await overdueTitles(app)).toEqual([]);
		expect((await patch(false)).status).toBe(200);
		expect(await overdueTitles(app)).toEqual(['장보기']);
	});

	it('delete → gone from 지나버린 일 and from every list, and stays gone after reload', async () => {
		const { app, shopping } = await seed();
		clock = new Date('2026-11-10T03:00:00Z');
		const res = await del(app, shopping);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ deleted: shopping });
		expect(await overdueTitles(app)).toEqual([]);
		expect(await allTitles(app)).toEqual(['병원 예약', 'AI 검색 기능']);
		// Reload later: still gone. Soft delete keeps the row in D1 (recoverable).
		clock = new Date('2026-11-12T03:00:00Z');
		expect(await overdueTitles(app)).toEqual(['병원 예약']);
		const row = await db.prepare('SELECT deleted_at FROM memos WHERE id = ?').bind(shopping).first<{ deleted_at: string }>();
		expect(row?.deleted_at).toBe('2026-11-10T03:00:00.000Z');
		// A deleted memo cannot be checked or deleted again.
		expect((await app.request(`/api/memos/${shopping}`, { method: 'PATCH', body: JSON.stringify({ completed: true }) })).status).toBe(404);
		expect((await del(app, shopping)).status).toBe(404);
	});

	it('only overdue, not-done memos can be deleted (409 otherwise)', async () => {
		const { app, shopping, hospital, idea } = await seed();
		clock = new Date('2026-11-10T03:00:00Z');
		expect((await del(app, hospital)).status).toBe(409); // not due yet
		expect((await del(app, idea)).status).toBe(409); // no deadline
		await app.request(`/api/memos/${shopping}`, { method: 'PATCH', body: JSON.stringify({ completed: true }) });
		expect((await del(app, shopping)).status).toBe(409); // done
		expect(await allTitles(app)).toHaveLength(3);
	});

	it('rejects bad ids, unknown memos and cross-site requests', async () => {
		const { app, shopping } = await seed();
		clock = new Date('2026-11-10T03:00:00Z');
		expect((await del(app, 'abc')).status).toBe(400);
		expect((await del(app, '00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
		expect((await del(app, shopping, { origin: 'https://evil.example' })).status).toBe(403);
		expect(await overdueTitles(app)).toEqual(['장보기']);
	});
});

describe('POST /api/transcribe (voice → text)', () => {
	const AUDIO = new Uint8Array(4096).fill(7);
	type T = (ai: Ai, audio: Uint8Array, type: string) => Promise<{ text: string; seconds: number | null }>;
	const said = (text: string, seconds: number | null = 5): T => async () => ({ text, seconds });
	function voiceApp(transcribe: T) {
		const app = new Hono<{ Bindings: ApiBindings }>();
		app.route('/api', createApi({ runAgent: async () => {}, transcribe, now: () => clock }));
		return (audio: Uint8Array | string, headers: Record<string, string> = {}, ip = '203.0.113.5') =>
			app.request(
				'/api/transcribe',
				{ method: 'POST', body: audio, headers: { 'content-type': 'audio/webm;codecs=opus', 'cf-connecting-ip': ip, ...headers } },
				{ DB: db, AI: {} as Ai },
			);
	}
	const voiceUsed = async () =>
		((await (await makeApp(toolRunner(db)).request('/api/usage')).json()) as { voice: { usedSeconds: number; limitSeconds: number } }).voice;

	it('returns the transcript, passes the audio through untouched, and counts its seconds', async () => {
		let seen: { bytes: number; type: string } | null = null;
		const send = voiceApp(async (_ai, audio, type) => {
			seen = { bytes: audio.byteLength, type };
			return { text: '  내일 오후 3시에 팀 회의 준비하기 ', seconds: 4.2 };
		});
		const res = await send(AUDIO);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ text: '내일 오후 3시에 팀 회의 준비하기' });
		expect(seen).toEqual({ bytes: 4096, type: 'audio/webm;codecs=opus' });
		expect(await voiceUsed()).toEqual({ usedSeconds: 5, limitSeconds: 1800 }); // 4.2 s rounded up
		// Nothing is stored.
		expect((await db.prepare('SELECT COUNT(*) AS n FROM sources').first<{ n: number }>())?.n).toBe(0);
	});

	it.each([
		['non-audio content type', AUDIO, { 'content-type': 'application/json' }, 415, 'invalid_request'],
		['foreign origin', AUDIO, { origin: 'https://evil.example' }, 403, 'forbidden_origin'],
		['empty recording', new Uint8Array(100), {}, 422, 'empty_audio'],
		['over 600 KB', new Uint8Array(600 * 1024 + 1), {}, 413, 'payload_too_large'],
	])('rejects %s before calling the model', async (_label, audio, headers, status, code) => {
		let called = false;
		const res = await voiceApp(async () => {
			called = true;
			return { text: 'x', seconds: 1 };
		})(audio, headers);
		expect(res.status).toBe(status);
		expect(((await res.json()) as { error: string }).error).toBe(code);
		expect(called).toBe(false);
	});

	it.each([
		['silence', said(''), 422, 'empty_transcript'],
		['silence hallucinated as credits', said('시청해 주셔서 감사합니다.'), 422, 'empty_transcript'],
		['silence hallucinated as thanks', said('감사합니다.'), 422, 'empty_transcript'],
		['model failure', async () => { throw new Error('boom'); }, 502, 'transcribe_failed'],
		['free quota used up', async () => { throw new Error('4006: daily free allocation of 10,000 neurons'); }, 503, 'ai_quota_exceeded'],
	] as const)('reports %s', async (_label, transcribe, status, code) => {
		const res = await voiceApp(transcribe as T)(AUDIO);
		expect(res.status).toBe(status);
		expect(((await res.json()) as { error: string }).error).toBe(code);
	});

	it('refuses audio longer than 65 s by its real duration, but still counts it', async () => {
		const res = await voiceApp(said('아주 긴 녹음', 600))(AUDIO); // e.g. a crafted low-bitrate upload
		expect(res.status).toBe(413);
		expect((await voiceUsed()).usedSeconds).toBe(600);
	});

	it('estimates seconds from size when the model reports none (32 kbps ≈ 4 KB/s)', async () => {
		await voiceApp(said('메모', null))(new Uint8Array(40_000));
		expect((await voiceUsed()).usedSeconds).toBe(10);
	});

	it('stops at the 30-minute daily voice budget (shared by everyone) until 09:00 KST', async () => {
		const send = voiceApp(said('긴 메모', 60));
		for (let i = 0; i < 30; i++) {
			// different clients so the per-minute limit does not interfere
			expect((await send(AUDIO, {}, `198.51.100.${i}`)).status).toBe(200);
		}
		const blocked = await send(AUDIO, {}, '198.51.100.200');
		expect(blocked.status).toBe(429);
		expect(((await blocked.json()) as { error: string }).error).toBe('daily_limit_reached');
		expect(await voiceUsed()).toEqual({ usedSeconds: 1800, limitSeconds: 1800 });
		clock = new Date('2026-11-10T00:00:01Z'); // next UTC day = 09:00 KST
		expect((await send(AUDIO, {}, '198.51.100.201')).status).toBe(200);
	});

	it('limits each client to 6 conversions per minute', async () => {
		const send = voiceApp(said('메모'));
		const statuses: number[] = [];
		for (let i = 0; i < 7; i++) statuses.push((await send(AUDIO)).status);
		expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
		expect((await send(AUDIO, {}, '198.51.100.20')).status).toBe(200); // another client
	});
});

describe('GET /api/usage', () => {
	type Usage = { today: { used: number; limit: number; resetsAt: string; neurons: number; neuronBudget: number }; total: number };
	const usage = async (app: ReturnType<typeof makeApp>) => (await (await app.request('/api/usage')).json()) as Usage;

	it('starts at zero with the configured limit and next 00:00 UTC reset', async () => {
		const app = makeApp(toolRunner(db), { DAILY_AI_LIMIT: '150' });
		const res = await app.request('/api/usage');
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({
			today: { used: 0, limit: 150, resetsAt: '2026-11-10T00:00:00.000Z', neurons: 0, neuronBudget: 6000 }, // = 09:00 KST
			total: 0,
			voice: { usedSeconds: 0, limitSeconds: 1800 },
		});
	});

	it('counts AI requests, but not duplicates or rejected input', async () => {
		const app = makeApp(toolRunner(db), { RATE_LIMIT_PER_MINUTE: '100' });
		const requestId = newRequestId();
		await app.request('/api/memos', { method: 'POST', body: body(RAW, requestId) });
		await app.request('/api/memos', { method: 'POST', body: body(RAW, requestId) }); // duplicate
		await app.request('/api/memos', { method: 'POST', body: body('   ') }); // 400
		await app.request('/api/memos', { method: 'POST', body: body() });
		const u = await usage(app);
		expect(u.today.used).toBe(2);
		expect(u.total).toBe(2);
	});

	it('caps today at the limit and keeps denied requests out of the total', async () => {
		const app = makeApp(toolRunner(db), { RATE_LIMIT_PER_MINUTE: '100', DAILY_AI_LIMIT: '2' });
		const statuses: number[] = [];
		for (let i = 0; i < 4; i++) statuses.push((await app.request('/api/memos', { method: 'POST', body: body() })).status);
		expect(statuses).toEqual([201, 201, 429, 429]);
		expect(await usage(app)).toMatchObject({ today: { used: 2, limit: 2 }, total: 2 });
	});

	it('charges the estimated cost of each input to the daily Neuron budget (30 + 0.4 × chars)', async () => {
		const app = makeApp(toolRunner(db), { RATE_LIMIT_PER_MINUTE: '100' });
		await app.request('/api/memos', { method: 'POST', body: body(RAW) }); // 52 chars → 51
		expect((await usage(app)).today).toMatchObject({ used: 1, neurons: 51, neuronBudget: 6000 });
	});

	it('stops long inputs by cost before the request count runs out', async () => {
		const app = makeApp(toolRunner(db), { RATE_LIMIT_PER_MINUTE: '100', DAILY_AI_LIMIT: '150', DAILY_AI_NEURONS: '1000' });
		const long = `${RAW}${'할일메모정리'.repeat(200)}`.slice(0, 1000); // exactly 1000 chars → 430
		expect(long.length).toBe(1000);
		const statuses: number[] = [];
		for (let i = 0; i < 3; i++) statuses.push((await app.request('/api/memos', { method: 'POST', body: body(long) })).status);
		expect(statuses).toEqual([201, 201, 429]); // 430 + 430 = 860; a third would exceed 1000
		const u = await usage(app);
		expect(u.today).toMatchObject({ used: 2, neurons: 860 }); // the denied request cost nothing
		// A short input still fits in the remaining budget.
		expect((await app.request('/api/memos', { method: 'POST', body: body('내일 우유') })).status).toBe(201);
	});

	it('also counts AI attempts that fail', async () => {
		const app = makeApp(async () => {
			throw new Error('model exploded');
		});
		expect((await app.request('/api/memos', { method: 'POST', body: body() })).status).toBe(502);
		expect(await usage(app)).toMatchObject({ today: { used: 1 }, total: 1 });
	});

	it('resets today on the next UTC day while the all-time total survives cleanup', async () => {
		const app = makeApp(toolRunner(db), { RATE_LIMIT_PER_MINUTE: '100' });
		await app.request('/api/memos', { method: 'POST', body: body() });
		clock = new Date('2026-11-10T00:30:00Z'); // 09:30 KST next day
		expect(await usage(app)).toMatchObject({ today: { used: 0 }, total: 1 });
		await app.request('/api/memos', { method: 'POST', body: body() }); // triggers expired-row cleanup
		expect(await usage(app)).toMatchObject({ today: { used: 1, resetsAt: '2026-11-11T00:00:00.000Z' }, total: 2 });
	});
});

describe('GET /api/memos', () => {
	async function seed(app: ReturnType<typeof makeApp>, at: string, text = RAW, nickname = '테스터') {
		clock = new Date(at);
		const res = await app.request('/api/memos', { method: 'POST', body: body(text, undefined, nickname), ip: crypto.randomUUID() });
		expect(res.status).toBe(201);
	}

	it('separates today (KST) from all public memos', async () => {
		const app = makeApp(toolRunner(db), { RATE_LIMIT_PER_MINUTE: '100' });
		await seed(app, '2026-11-09T14:59:00Z'); // 11-09 23:59 KST
		await seed(app, '2026-11-09T15:01:00Z'); // 11-10 00:01 KST

		clock = new Date('2026-11-10T03:00:00Z'); // 11-10 12:00 KST
		const today = (await (await app.request('/api/memos?scope=today')).json()) as ListMemosResponse;
		const all = (await (await app.request('/api/memos?scope=all')).json()) as ListMemosResponse;
		expect(today.memos).toHaveLength(3);
		expect(today.memos.every((m) => m.created_at === '2026-11-09T15:01:00.000Z')).toBe(true);
		expect(all.memos).toHaveLength(6);
		expect(all.memos[0].nickname).toBe('테스터');
	});

	it('returns the same public list to every client', async () => {
		const app = makeApp(toolRunner(db), { RATE_LIMIT_PER_MINUTE: '100' });
		await seed(app, '2026-11-09T12:00:00Z', RAW, '브라우저A');
		const fromA = await (await app.request('/api/memos?scope=all', { ip: '203.0.113.10' })).json();
		const fromB = await (await app.request('/api/memos?scope=all', { ip: '203.0.113.20' })).json();
		expect(fromB).toEqual(fromA);
	});

	it('paginates newest first while keeping memo order within one input', async () => {
		const app = makeApp(toolRunner(db), { RATE_LIMIT_PER_MINUTE: '100' });
		await seed(app, '2026-11-09T10:00:00Z');
		await seed(app, '2026-11-09T11:00:00Z');
		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const url: string = `/api/memos?scope=all&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
			const page = (await (await app.request(url)).json()) as ListMemosResponse;
			expect(page.memos.length).toBeLessThanOrEqual(2);
			seen.push(...page.memos.map((m) => `${m.created_at.slice(11, 13)}:${m.title}`));
			cursor = page.nextCursor;
		} while (cursor);
		expect(seen).toEqual([
			'11:장보기', '11:병원 예약', '11:AI 검색 기능',
			'10:장보기', '10:병원 예약', '10:AI 검색 기능',
		]);
	});

	it('filters by category and validates query params', async () => {
		const app = makeApp(toolRunner(db), { RATE_LIMIT_PER_MINUTE: '100' });
		await seed(app, '2026-11-09T10:00:00Z');
		const ideas = (await (await app.request('/api/memos?category=idea')).json()) as ListMemosResponse;
		expect(ideas.memos.map((m) => m.title)).toEqual(['AI 검색 기능']);
		expect((await app.request('/api/memos?limit=500')).status).toBe(400);
		expect((await app.request('/api/memos?scope=yesterday')).status).toBe(400);
	});
});
