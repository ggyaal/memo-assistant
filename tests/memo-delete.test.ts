import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunMemoAgent } from '../src/server/agent-runner.ts';
import { createApi, type ApiBindings } from '../src/server/routes.ts';
import type { CalendarResponse, CreateMemosResponse, ListMemosResponse } from '../src/shared/types.ts';
import { createSaveMemosTool, type MemoJob } from '../src/tools/save-memos.ts';
import { createTestD1 } from './helpers/d1.ts';

let db: D1Database;
let dispose: () => Promise<void>;
let clock: Date;
let ids = 0;
const rid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);
const sha = (k: string) => createHash('sha256').update(k).digest('hex');

const runAgent: RunMemoAgent = async (job: MemoJob) => {
	const tool = createSaveMemosTool({ db, job });
	await tool.run({
		data: { memos: [{ title: job.rawText, content: job.rawText, category: 'todo', due_text: '내일', due_at: null, reminder_recommended: false }] },
		toolCallId: 't',
		log: console,
		signal: new AbortController().signal,
	} as never);
};

function app() {
	const a = new Hono<{ Bindings: ApiBindings }>();
	a.route('/api', createApi({ runAgent, now: () => clock }));
	const send = (path: string, init: RequestInit & { key?: string } = {}) =>
		a.request(
			path,
			{ ...init, headers: { 'content-type': 'application/json', ...(init.key ? { 'x-author-key': init.key } : {}), ...(init.headers as object) } },
			{ DB: db, RATE_LIMIT_PER_MINUTE: '100' },
		);
	return {
		send,
		create: async (text: string, key?: string) =>
			((await (await send('/api/memos', { method: 'POST', key, body: JSON.stringify({ nickname: '삭제', text, requestId: rid() }) })).json()) as CreateMemosResponse).memos[0],
		del: (id: string, key?: string) => send(`/api/memos/${id}`, { method: 'DELETE', key }),
		restore: (id: string, key?: string) => send(`/api/memos/${id}/restore`, { method: 'POST', key }),
		titles: async () => ((await (await send('/api/memos?scope=all')).json()) as ListMemosResponse).memos.map((m) => m.title),
		calendar: async () => ((await (await send('/api/calendar?month=2026-11')).json()) as CalendarResponse).memos.map((m) => m.title),
	};
}

beforeEach(async () => {
	({ db, dispose } = await createTestD1());
	clock = new Date('2026-11-15T03:00:00Z');
});
afterEach(async () => {
	await dispose();
});

describe('public board: delete my own memo (browser author key)', () => {
	it('the author can delete and undo; the card gets only a short tag, never the full hash', async () => {
		const t = app();
		const mine = await t.create('내 메모', K1);
		expect(mine.author_tag).toBe(sha(K1).slice(0, 16));
		expect(JSON.stringify(mine)).not.toContain(sha(K1));
		expect((await t.del(mine.id, K1)).status).toBe(200);
		expect(await t.titles()).toEqual([]);
		expect(await t.calendar()).toEqual([]);
		expect((await t.del(mine.id, K1)).status).toBe(404); // already gone
		clock = new Date(clock.getTime() + 60 * 60_000); // the author can undo any time
		expect((await t.restore(mine.id, K1)).status).toBe(200);
		expect(await t.titles()).toEqual(['내 메모']);
	});

	it("someone else's (or an old, keyless) memo cannot be deleted unless it is overdue and not done", async () => {
		const t = app();
		const other = await t.create('내일 남의 메모', K1);
		const keyless = await t.create('예전 메모');
		expect(keyless.author_tag).toBeNull();
		for (const [id, key] of [[other.id, K2], [other.id, undefined], [keyless.id, K2]] as const) {
			const res = await t.del(id, key);
			expect(res.status).toBe(409);
			expect(((await res.json()) as { message: string }).message).toContain('내가 쓴 메모');
		}
		expect((await t.del(other.id, 'not-a-key')).status).toBe(409); // malformed key = no key
		// Once overdue and not done, the existing rule applies to everyone.
		clock = new Date('2026-11-17T03:00:00Z');
		expect((await t.del(other.id, K2)).status).toBe(200);
	});

	it('undo by someone else only shortly after the delete', async () => {
		const t = app();
		const m = await t.create('메모', K1);
		await t.del(m.id, K1);
		clock = new Date(clock.getTime() + 5 * 60_000);
		expect((await t.restore(m.id, K2)).status).toBe(200);
		await t.del(m.id, K1);
		clock = new Date(clock.getTime() + 11 * 60_000);
		expect((await t.restore(m.id, K2)).status).toBe(409);
		expect((await t.restore(m.id)).status).toBe(409);
	});

	it('protected like other changes: another site cannot delete or restore', async () => {
		const t = app();
		const m = await t.create('메모', K1);
		expect((await t.send(`/api/memos/${m.id}`, { method: 'DELETE', key: K1, headers: { origin: 'https://evil.example' } })).status).toBe(403);
		expect((await t.send(`/api/memos/${m.id}/restore`, { method: 'POST', key: K1, headers: { origin: 'https://evil.example' } })).status).toBe(403);
	});
});

describe('migration 0014 keeps existing data', () => {
	it('sources written before 0014 are unchanged; their author is unknown (NULL)', async () => {
		const { db: d, dispose: done, applyRest } = await createTestD1({ stopBefore: '0014' });
		try {
			await d.prepare("INSERT INTO sources (id, workspace_id, nickname, raw_text, request_id, created_at) VALUES ('s1', 'ws_shared_guest', '닉', '원문', 'r1', '2026-11-01T00:00:00Z')").run();
			const before = await d.prepare('SELECT * FROM sources').first();
			await applyRest();
			expect(await d.prepare('SELECT * FROM sources').first()).toEqual({ ...before, author_key_hash: null });
		} finally {
			await done();
		}
	});
});
