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
		expect(await agenda(app)).toEqual({ reminders: [], ranked: [] });
	});

	it('returns empty lists with no-store caching', async () => {
		const res = await makeApp(toolRunner(db)).request('/api/agenda');
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({ reminders: [], ranked: [] });
	});
});

describe('GET /api/usage', () => {
	type Usage = { today: { used: number; limit: number; resetsAt: string }; total: number };
	const usage = async (app: ReturnType<typeof makeApp>) => (await (await app.request('/api/usage')).json()) as Usage;

	it('starts at zero with the configured limit and next 00:00 UTC reset', async () => {
		const app = makeApp(toolRunner(db), { DAILY_AI_LIMIT: '150' });
		const res = await app.request('/api/usage');
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({
			today: { used: 0, limit: 150, resetsAt: '2026-11-10T00:00:00.000Z' }, // = 09:00 KST
			total: 0,
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
