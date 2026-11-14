import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Smoke test for the BUILT Worker (`npm run build` first): runs dist/memo_assistant
 * in workerd with a local D1 and the Flue-generated Durable Object. The AI binding
 * is a stub with no `run()`, so no Workers AI request (and no Neuron) is spent:
 * an AI call fails and must surface as an error response.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'dist', 'memo_assistant');
const WORKER = join(OUT, 'index.js');

let mf: Miniflare;

beforeAll(async () => {
	if (!existsSync(WORKER)) throw new Error('Run `npm run build` before `npm run test:worker`.');
	mf = new Miniflare(
		convertV4MiniflareOptions({
			name: 'memo-assistant',
			compatibilityDate: '2026-06-01',
			compatibilityFlags: ['nodejs_compat'],
			// Entry first, then every lazily imported chunk of the bundle.
			modules: [
				{ type: 'ESModule', path: WORKER },
				...readdirSync(join(OUT, 'assets'))
					.filter((f) => f.endsWith('.js'))
					.map((f) => ({ type: 'ESModule' as const, path: join(OUT, 'assets', f) })),
			],
			modulesRoot: OUT,
			d1Databases: { DB: 'smoke-db' },
			durableObjects: {
				FLUE_MEMO_ORGANIZER_AGENT: { className: 'FlueMemoOrganizerAgent', useSQLite: true },
			},
			bindings: {
				MEMO_MODEL: 'cloudflare/@cf/zai-org/glm-4.7-flash',
				RATE_LIMIT_PER_MINUTE: '5',
				DAILY_AI_LIMIT: '150',
			},
			serviceBindings: {
				AI: () => new Response('AI disabled in smoke test', { status: 503 }),
			},
		}),
	);
	const db = (await mf.getD1Database('DB')) as unknown as D1Database;
	const { readdir, readFile } = await import('node:fs/promises');
	for (const file of (await readdir(join(ROOT, 'migrations'))).sort()) {
		const sql = await readFile(join(ROOT, 'migrations', file), 'utf8');
		const statements = sql
			.split('\n')
			.filter((l) => !l.trim().startsWith('--'))
			.join('\n')
			.split(';')
			.map((s) => s.trim())
			.filter(Boolean);
		await db.batch(statements.map((s) => db.prepare(s)));
	}
}, 120_000);

afterAll(async () => {
	await mf?.dispose();
});

describe('built Worker (workerd + local D1 + Flue Durable Object)', () => {
	it('serves health and an empty public list', async () => {
		expect((await mf.dispatchFetch('http://localhost/api/health')).status).toBe(200);
		const res = await mf.dispatchFetch('http://localhost/api/memos?scope=today');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ memos: [], nextCursor: null });
		// Production build: no permissive CORS (the dev server adds its own), strict headers.
		expect(res.headers.get('access-control-allow-origin')).toBeNull();
		expect(res.headers.get('access-control-allow-credentials')).toBeNull();
		expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
	});

	it('refuses cross-site POSTs in the built Worker', async () => {
		const body = JSON.stringify({ nickname: 'n', text: 'x', requestId: crypto.randomUUID() });
		const foreign = await mf.dispatchFetch('http://localhost/api/memos', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
			body,
		});
		expect(foreign.status).toBe(403);
		const plain = await mf.dispatchFetch('http://localhost/api/memos', { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
		expect(plain.status).toBe(415);
	});

	it('voice endpoint validates input in the built Worker', async () => {
		const plain = await mf.dispatchFetch('http://localhost/api/transcribe', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
		expect(plain.status).toBe(415);
		const tiny = await mf.dispatchFetch('http://localhost/api/transcribe', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array(10) });
		expect(tiny.status).toBe(422);
	});

	it('serves the agenda', async () => {
		const res = await mf.dispatchFetch('http://localhost/api/agenda');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ reminders: [], ranked: [], overdue: [] });
	});

	it('serves usage numbers', async () => {
		const res = await mf.dispatchFetch('http://localhost/api/usage');
		expect(res.status).toBe(200);
		const json = (await res.json()) as { today: { used: number; limit: number }; total: number };
		expect(json.today).toMatchObject({ used: 0, limit: 150 });
		expect(json.total).toBe(0);
		expect((json as unknown as { voice: unknown }).voice).toEqual({ usedSeconds: 0, limitSeconds: 1800 });
	});

	it('rejects invalid input before the agent', async () => {
		const res = await mf.dispatchFetch('http://localhost/api/memos', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ nickname: '', text: 'x', requestId: crypto.randomUUID() }),
		});
		expect(res.status).toBe(400);
	});

	it('does not expose the agent over HTTP', async () => {
		const res = await mf.dispatchFetch('http://localhost/agents/memo-organizer/x', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'user', body: 'hi' }),
		});
		expect(res.status).toBe(404);
	});

	it('runs the agent in its Durable Object and reports an AI failure to the user', async () => {
		const res = await mf.dispatchFetch('http://localhost/api/memos', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ nickname: '스모크', text: '내일 오후 3시 회의', requestId: crypto.randomUUID() }),
		});
		const json = (await res.json()) as { error: string; message: string };
		expect(res.status).toBeGreaterThanOrEqual(500);
		expect(['agent_failed', 'ai_quota_exceeded', 'agent_timeout']).toContain(json.error);
		expect(json.message).toBeTruthy();
	}, 60_000);
});
