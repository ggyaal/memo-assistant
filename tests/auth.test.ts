import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pkceChallenge, sha256Hex } from '../src/server/auth/crypto.ts';
import type { RunMemoAgent } from '../src/server/agent-runner.ts';
import { createApi, type ApiBindings } from '../src/server/routes.ts';
import { createSaveMemosTool, type MemoJob } from '../src/tools/save-memos.ts';
import { CRON_LOOKAHEAD_MS, runDueReminders } from '../src/server/notify/reminders.ts';
import { createTestD1 } from './helpers/d1.ts';

/*
 * Phase A access-control tests. Providers are faked at the HTTP level:
 * authorization code "sub:<id>" → access token "tok:<id>" → profile <id>.
 */

let db: D1Database;
let dispose: () => Promise<void>;
let clock: Date;
let rid = 0;
const tokenRequests: URLSearchParams[] = [];
/** DMs the fake Discord bot API accepted: { to, content, body }. */
const sentDms: { to: string; content: string; body: Record<string, unknown>; auth: string }[] = [];

const ENV: Partial<ApiBindings> = {
	DISCORD_CLIENT_ID: 'discord-client',
	DISCORD_CLIENT_SECRET: 'discord-secret',
	GOOGLE_CLIENT_ID: 'google-client',
	GOOGLE_CLIENT_SECRET: 'google-secret',
	RATE_LIMIT_PER_MINUTE: '100',
	DISCORD_BOT_TOKEN: 'bot-token',
	DISCORD_GUILD_ID: 'guild-1',
	DISCORD_SERVER_INVITE: 'https://discord.gg/memo-test',
	// Kakao intentionally not configured.
};

/** Discord member lookups the fake bot API received: "guild/user (auth)". */
const memberChecks: string[] = [];

const fakeFetch: typeof fetch = async (input, init) => {
	const url = String(input instanceof Request ? input.url : input);
	// Fake guild member lookup: "outsider" has not joined; "unsure" makes Discord fail (cannot check).
	const member = /^https:\/\/discord\.com\/api\/v10\/guilds\/([^/]+)\/members\/(.+)$/.exec(url);
	if (member) {
		memberChecks.push(`${member[1]}/${member[2]} (${new Headers(init?.headers).get('authorization')})`);
		if (member[2] === 'outsider') return Response.json({ code: 10007, message: 'Unknown Member' }, { status: 404 });
		if (member[2] === 'unsure') return new Response('oops', { status: 500 });
		return Response.json({ user: { id: member[2] } });
	}
	// Fake Discord bot API. Recipients named "blocked" refuse DMs; "flaky" returns 500.
	if (url === 'https://discord.com/api/v10/users/@me/channels') {
		const { recipient_id } = JSON.parse(String(init?.body)) as { recipient_id: string };
		if (recipient_id === 'blocked') return Response.json({ code: 50007, message: 'Cannot send messages to this user' }, { status: 403 });
		return Response.json({ id: `dm-${recipient_id}` });
	}
	const dm = /^https:\/\/discord\.com\/api\/v10\/channels\/dm-(.+)\/messages$/.exec(url);
	if (dm) {
		if (dm[1] === 'flaky') return new Response('oops', { status: 500 });
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		// "cardless" refuses Embed cards as invalid (400 / 50035) but accepts plain text.
		if (dm[1] === 'cardless' && body.embeds) return Response.json({ code: 50035, message: 'Invalid Form Body' }, { status: 400 });
		sentDms.push({ to: dm[1], content: String(body.content), body, auth: new Headers(init?.headers).get('authorization') ?? '' });
		return Response.json({ id: 'msg' });
	}
	if (url.includes('/token')) {
		const form = new URLSearchParams(String(init?.body));
		tokenRequests.push(form);
		const code = form.get('code') ?? '';
		if (!code.startsWith('sub:')) return new Response('bad code', { status: 400 });
		return Response.json({ access_token: `tok:${code.slice(4)}`, token_type: 'Bearer' });
	}
	const auth = new Headers(init?.headers).get('authorization') ?? '';
	const id = auth.replace('Bearer tok:', '');
	if (url.startsWith('https://discord.com/api/users/@me')) return Response.json({ id, username: id, global_name: `D-${id}` });
	if (url.startsWith('https://openidconnect.googleapis.com')) return Response.json({ sub: id, name: `G-${id}` });
	return new Response('unexpected', { status: 500 });
};

/** Saves one dated memo per request through the real save_memos tool. */
const runAgent: RunMemoAgent = async (job: MemoJob) => {
	const tool = createSaveMemosTool({ db, job });
	await tool.run({
		data: {
			memos: [
				job.rawText.includes('매주 월수금 오후 7시')
					? { title: '운동', content: job.rawText, category: 'schedule', due_text: '매주 월수금 오후 7시', due_at: '2026-11-16T19:00:00+09:00', reminder_recommended: false }
					: job.rawText.includes('매일')
						? { title: '물 마시기', content: job.rawText, category: 'todo', due_text: '매일', due_at: null, reminder_recommended: false }
						: job.rawText.includes('오후 3시')
					? // exact time, reminder recommended
						{ title: job.rawText.slice(0, 20), content: job.rawText, category: 'schedule', due_text: '내일 오후 3시', due_at: '2026-11-16T15:00:00+09:00', reminder_recommended: true }
						: { title: job.rawText.slice(0, 20), content: job.rawText, category: 'todo', due_text: '내일', due_at: null, reminder_recommended: job.rawText.includes('[추천]') },
			],
		},
		toolCallId: 't',
		log: console,
		signal: new AbortController().signal,
	} as never);
};

type Jar = Map<string, string>;

function makeApp(envOverride: Partial<ApiBindings> = {}) {
	const app = new Hono<{ Bindings: ApiBindings }>();
	app.route('/api', createApi({ runAgent, now: () => clock, fetchFn: fakeFetch }));
	return async (path: string, init: RequestInit & { jar?: Jar } = {}) => {
		const headers = new Headers(init.headers);
		if (init.jar?.size) headers.set('cookie', [...init.jar].map(([k, v]) => `${k}=${v}`).join('; '));
		const res = await app.request(path, { ...init, headers }, { DB: db, ...ENV, ...envOverride });
		if (init.jar) {
			for (const line of res.headers.getSetCookie()) {
				const [pair] = line.split(';');
				const [name, ...rest] = pair.split('=');
				const value = rest.join('=');
				if (!value || /max-age=0/i.test(line)) init.jar.delete(name);
				else init.jar.set(name, value);
			}
		}
		return res;
	};
}

type Send = ReturnType<typeof makeApp>;

async function login(send: Send, provider: 'discord' | 'google', subject: string, jar: Jar = new Map(), link = false) {
	const start = await send(`/api/auth/${provider}/start${link ? '?link=1' : ''}`, { jar });
	expect(start.status).toBe(302);
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
	const cb = await send(`/api/auth/${provider}/callback?code=sub:${subject}&state=${state}`, { jar });
	return { jar, location: cb.headers.get('location') ?? '' };
}

const me = async (send: Send, jar?: Jar) => (await (await send('/api/me', { jar })).json()) as {
	mode: string;
	workspace: { id: string; kind: string; name: string };
	user?: { displayName: string; linked: string[] };
	providers: Record<string, { configured: boolean }>;
};

const postMemo = (send: Send, text: string, jar?: Jar, extra: object = {}) =>
	send('/api/memos', {
		method: 'POST',
		jar,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ nickname: '손님', text, requestId: `00000000-0000-4000-8000-${String(++rid).padStart(12, '0')}`, ...extra }),
	});

const titles = async (send: Send, jar?: Jar) =>
	((await (await send('/api/memos?scope=all', { jar })).json()) as { memos: { id: string; title: string; nickname: string }[] }).memos;

beforeEach(async () => {
	({ db, dispose } = await createTestD1());
	clock = new Date('2026-11-15T03:00:00Z');
	tokenRequests.length = 0;
	sentDms.length = 0;
});
afterEach(async () => dispose());

describe('guest space (익명의 스케줄)', () => {
	it('guests share exactly one fixed workspace and see existing shared memos', async () => {
		const send = makeApp();
		const info = await me(send);
		expect(info).toMatchObject({ mode: 'guest', workspace: { id: 'ws_shared_guest', kind: 'shared_guest', name: '익명의 스케줄' } });
		expect(info.providers).toEqual({ google: { label: 'Google', configured: true }, discord: { label: 'Discord', configured: true }, kakao: { label: '카카오', configured: false } });
		await postMemo(send, '내일 공용 회의');
		// A different guest (no cookie at all) sees the same shared memo.
		expect((await titles(makeApp())).map((m) => m.title)).toEqual(['내일 공용 회의']);
	});
});

describe('OAuth login (state + PKCE)', () => {
	it('start redirects to the provider with S256 PKCE, exact redirect URI and a browser-bound state', async () => {
		const send = makeApp();
		const jar: Jar = new Map();
		const res = await send('/api/auth/discord/start', { jar });
		const url = new URL(res.headers.get('location')!);
		expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
		expect(url.searchParams.get('client_id')).toBe('discord-client');
		expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/discord/callback');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('scope')).toBe('identify');
		const state = url.searchParams.get('state')!;
		expect(jar.get('__Host-memo_oauth')).toBe(state);
		// Only a hash of the state is stored.
		const row = await db.prepare('SELECT id FROM oauth_states').first<{ id: string }>();
		expect(row?.id).toBe(await sha256Hex(state));
		expect(row?.id).not.toBe(state);
		// The callback sends a verifier that matches the challenge.
		await send(`/api/auth/discord/callback?code=sub:alice&state=${state}`, { jar });
		const verifier = tokenRequests[0].get('code_verifier')!;
		expect(await pkceChallenge(verifier)).toBe(url.searchParams.get('code_challenge'));
		expect(tokenRequests[0].get('client_secret')).toBe('discord-secret');
	});

	it('creates a user, a personal workspace and a hardened session cookie', async () => {
		const send = makeApp();
		const jar: Jar = new Map();
		const start = await send('/api/auth/discord/start', { jar });
		const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
		const cb = await send(`/api/auth/discord/callback?code=sub:alice&state=${state}`, { jar });
		expect(cb.headers.get('location')).toBe('/');
		const cookie = cb.headers.getSetCookie().find((c) => c.startsWith('__Host-memo_session='))!;
		expect(cookie).toMatch(/HttpOnly/);
		expect(cookie).toMatch(/Secure/);
		expect(cookie).toMatch(/SameSite=Lax/);
		expect(cookie).toMatch(/Path=\//);
		expect(cookie).not.toMatch(/Domain=/);
		const info = await me(send, jar);
		expect(info).toMatchObject({ mode: 'user', user: { displayName: 'D-alice', linked: ['discord'] }, workspace: { kind: 'personal', name: 'D-alice님의 메모' } });
		// The raw session token is never stored.
		const stored = await db.prepare('SELECT id FROM sessions').first<{ id: string }>();
		expect(stored?.id).toBe(await sha256Hex(jar.get('__Host-memo_session')!));
	});

	it.each([
		['state does not match the browser cookie', async (send: Send, jar: Jar, state: string) => {
			jar.set('__Host-memo_oauth', 'someone-else');
			return send(`/api/auth/discord/callback?code=sub:alice&state=${state}`, { jar });
		}],
		['no state cookie (link opened in another browser)', async (send: Send, _jar: Jar, state: string) =>
			send(`/api/auth/discord/callback?code=sub:alice&state=${state}`, { jar: new Map() })],
		['state older than 10 minutes', async (send: Send, jar: Jar, state: string) => {
			clock = new Date(clock.getTime() + 11 * 60 * 1000);
			return send(`/api/auth/discord/callback?code=sub:alice&state=${state}`, { jar });
		}],
		['state for another provider', async (send: Send, jar: Jar, state: string) =>
			send(`/api/auth/google/callback?code=sub:alice&state=${state}`, { jar })],
	])('rejects a callback when %s', async (_label, attack) => {
		const send = makeApp();
		const jar: Jar = new Map();
		const start = await send('/api/auth/discord/start', { jar });
		const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
		const res = await attack(send, jar, state);
		expect(res.headers.get('location')).toBe('/?auth_error=invalid_state');
		expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-memo_session=') && !/Max-Age=0/i.test(c))).toBe(false);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(0);
	});

	it('a state can be used only once (replay)', async () => {
		const send = makeApp();
		const jar: Jar = new Map();
		const start = await send('/api/auth/discord/start', { jar });
		const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
		await send(`/api/auth/discord/callback?code=sub:alice&state=${state}`, { jar: new Map(jar) });
		const replay = await send(`/api/auth/discord/callback?code=sub:mallory&state=${state}`, { jar: new Map([['__Host-memo_oauth', state]]) });
		expect(replay.headers.get('location')).toBe('/?auth_error=invalid_state');
	});

	it('reports cancelled logins, provider failures and unconfigured providers without logging in', async () => {
		const send = makeApp();
		const jar: Jar = new Map();
		let start = await send('/api/auth/discord/start', { jar });
		let state = new URL(start.headers.get('location')!).searchParams.get('state')!;
		expect((await send(`/api/auth/discord/callback?error=access_denied&state=${state}`, { jar })).headers.get('location')).toBe('/?auth_error=cancelled');
		start = await send('/api/auth/discord/start', { jar });
		state = new URL(start.headers.get('location')!).searchParams.get('state')!;
		expect((await send(`/api/auth/discord/callback?code=bad&state=${state}`, { jar })).headers.get('location')).toBe('/?auth_error=provider_error');
		expect((await send('/api/auth/kakao/start', { jar })).headers.get('location')).toBe('/?auth_error=provider_unavailable');
		expect((await me(send, jar)).mode).toBe('guest');
	});

	it('logging in again with the same account returns the same user and memos', async () => {
		const send = makeApp();
		const first = await login(send, 'discord', 'alice');
		await postMemo(send, '내일 개인 할 일', first.jar);
		const second = await login(send, 'discord', 'alice');
		expect(second.jar.get('__Host-memo_session')).not.toBe(first.jar.get('__Host-memo_session'));
		expect((await titles(send, second.jar)).map((m) => m.title)).toEqual(['내일 개인 할 일']);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(1);
	});
});

describe('personal workspace isolation', () => {
	async function twoUsers() {
		const send = makeApp();
		const a = (await login(send, 'discord', 'alice')).jar;
		const b = (await login(send, 'discord', 'bob')).jar;
		await postMemo(send, '내일 A의 비밀 계획', a);
		await postMemo(send, '내일 B의 할 일', b);
		await postMemo(send, '내일 게스트 메모');
		const aMemo = (await titles(send, a))[0];
		return { send, a, b, aMemo };
	}

	it('A and B only ever see their own memos; guests see neither; A does not see guest memos', async () => {
		const { send, a, b } = await twoUsers();
		expect((await titles(send, a)).map((m) => m.title)).toEqual(['내일 A의 비밀 계획']);
		expect((await titles(send, b)).map((m) => m.title)).toEqual(['내일 B의 할 일']);
		expect((await titles(send)).map((m) => m.title)).toEqual(['내일 게스트 메모']);
		const agendaB = (await (await send('/api/agenda', { jar: b })).json()) as { ranked: { title: string }[] };
		expect(agendaB.ranked.map((m) => m.title)).toEqual(['내일 B의 할 일']);
	});

	it('B cannot complete, reorder or delete A\'s memo (looks like it does not exist)', async () => {
		const { send, a, b, aMemo } = await twoUsers();
		const json = { 'content-type': 'application/json' };
		expect((await send(`/api/memos/${aMemo.id}`, { method: 'PATCH', jar: b, headers: json, body: JSON.stringify({ completed: true }) })).status).toBe(404);
		expect((await send('/api/agenda/order', { method: 'PUT', jar: b, headers: json, body: JSON.stringify({ ids: [aMemo.id] }) })).status).toBe(404);
		clock = new Date('2026-11-20T00:00:00Z'); // A's memo is now overdue
		expect((await send(`/api/memos/${aMemo.id}`, { method: 'DELETE', jar: b })).status).toBe(404);
		// Guests cannot touch it either.
		expect((await send(`/api/memos/${aMemo.id}`, { method: 'DELETE' })).status).toBe(404);
		// A still can.
		expect((await send(`/api/memos/${aMemo.id}`, { method: 'PATCH', jar: a, headers: json, body: JSON.stringify({ completed: true }) })).status).toBe(200);
	});

	it('ignores a workspace id sent by the client', async () => {
		const send = makeApp();
		const a = (await login(send, 'discord', 'alice')).jar;
		await postMemo(send, '내일 공용으로 몰래 넣기', a, { workspaceId: 'ws_shared_guest', workspace_id: 'ws_shared_guest' });
		expect((await titles(send)).length).toBe(0); // nothing landed in the shared space
		expect((await titles(send, a)).map((m) => m.nickname)).toEqual(['D-alice']); // author = account, not "손님"
	});

	it('personal memos may contain contact details (only the owner sees them); the shared space still blocks them', async () => {
		const send = makeApp();
		const a = (await login(send, 'discord', 'alice')).jar;
		expect((await postMemo(send, '내일 010-1234-5678로 전화', a)).status).toBe(201);
		expect((await postMemo(send, '내일 010-1234-5678로 전화')).status).toBe(400);
	});
});

describe('logout and sessions', () => {
	it('after logout the old cookie is useless and personal memos never show up as guest', async () => {
		const send = makeApp();
		const a = (await login(send, 'discord', 'alice')).jar;
		await postMemo(send, '내일 개인 메모', a);
		const stolen = new Map(a);
		const res = await send('/api/auth/logout', { method: 'POST', jar: a });
		expect(res.status).toBe(200);
		expect(a.has('__Host-memo_session')).toBe(false);
		expect((await me(send, stolen)).mode).toBe('guest');
		expect((await titles(send, stolen)).map((m) => m.title)).toEqual([]);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())?.n).toBe(0);
	});

	it('refuses a cross-site logout', async () => {
		const send = makeApp();
		const a = (await login(send, 'discord', 'alice')).jar;
		expect((await send('/api/auth/logout', { method: 'POST', jar: a, headers: { origin: 'https://evil.example' } })).status).toBe(403);
		expect((await me(send, a)).mode).toBe('user');
	});

	it('expires after 30 days without use and slides while in use', async () => {
		const send = makeApp();
		const a = (await login(send, 'discord', 'alice')).jar;
		clock = new Date(clock.getTime() + 20 * 86_400_000);
		expect((await me(send, a)).mode).toBe('user'); // refreshes the expiry
		clock = new Date(clock.getTime() + 20 * 86_400_000); // 40 days after login, 20 after last use
		expect((await me(send, a)).mode).toBe('user');
		clock = new Date(clock.getTime() + 31 * 86_400_000);
		expect((await me(send, a)).mode).toBe('guest');
	});
});

describe('explicit account linking', () => {
	it('links Google to the signed-in Discord user; either login opens the same space', async () => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'alice')).jar;
		await postMemo(send, '내일 연결 테스트', jar);
		const linked = await login(send, 'google', 'alice-g', jar, true);
		expect(linked.location).toBe('/?linked=google');
		expect((await me(send, jar)).user?.linked).toEqual(['discord', 'google']);
		const viaGoogle = (await login(send, 'google', 'alice-g')).jar;
		expect((await titles(send, viaGoogle)).map((m) => m.title)).toEqual(['내일 연결 테스트']);
	});

	it('never merges two users: linking an account that belongs to someone else fails', async () => {
		const send = makeApp();
		await login(send, 'google', 'bob-g'); // Bob already uses this Google account
		const alice = (await login(send, 'discord', 'alice')).jar;
		const res = await login(send, 'google', 'bob-g', alice, true);
		expect(res.location).toBe('/?auth_error=already_linked_elsewhere');
		expect((await me(send, alice)).user?.linked).toEqual(['discord']);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(2);
	});

	it('linking requires being signed in', async () => {
		const send = makeApp();
		expect((await send('/api/auth/google/start?link=1')).headers.get('location')).toBe('/?auth_error=login_required');
	});
});

describe('settings (profile, linked accounts, notification channels)', () => {
	type Settings = {
		displayName: string;
		timezone: string;
		linked: string[];
		notifications: { channel: string; available: boolean; enabled: boolean; delivering: boolean; note: string }[];
	};
	const json = { 'content-type': 'application/json' };
	const settings = async (send: Send, jar?: Jar) => send('/api/settings', { jar });
	const toggle = (send: Send, jar: Jar, channel: string, enabled: boolean, headers: Record<string, string> = {}) =>
		send(`/api/settings/notifications/${channel}`, { method: 'PUT', jar, headers: { ...json, ...headers }, body: JSON.stringify({ enabled }) });

	it('is only for signed-in users', async () => {
		const send = makeApp();
		expect((await settings(send)).status).toBe(401);
		expect((await send('/api/settings/profile', { method: 'PATCH', headers: json, body: JSON.stringify({ displayName: 'x' }) })).status).toBe(401);
		expect((await send('/api/settings/notifications/discord', { method: 'PUT', headers: json, body: JSON.stringify({ enabled: true }) })).status).toBe(401);
	});

	it('shows profile, linked accounts and honest channel states', async () => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'alice')).jar;
		const s = (await (await settings(send, jar)).json()) as Settings;
		expect(s).toMatchObject({ displayName: 'D-alice', timezone: 'Asia/Seoul', linked: ['discord'] });
		expect(s.notifications.map((n) => [n.channel, n.available, n.enabled, n.delivering])).toEqual([
			['discord', true, false, false],
			['kakao', false, false, false],
			['email', false, false, false],
		]);
	});

	it('renames the user, their space and the author of their own memos', async () => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'alice')).jar;
		await postMemo(send, '내일 이름 바꾸기 전 메모', jar);
		const res = await send('/api/settings/profile', { method: 'PATCH', jar, headers: json, body: JSON.stringify({ displayName: '  새이름 ' }) });
		expect(res.status).toBe(200);
		expect((await me(send, jar)).workspace.name).toBe('새이름님의 메모');
		expect((await titles(send, jar)).map((m) => m.nickname)).toEqual(['새이름']);
		await postMemo(send, '내일 이름 바꾼 뒤 메모', jar);
		expect(new Set((await titles(send, jar)).map((m) => m.nickname))).toEqual(new Set(['새이름']));
		// Logging in again keeps the chosen name (the provider name does not overwrite it).
		const again = (await login(send, 'discord', 'alice')).jar;
		expect((await me(send, again)).user?.displayName).toBe('새이름');
	});

	it.each([
		['empty', ''],
		['too long', 'n'.repeat(21)],
		['not a string', 42],
	])('rejects a %s display name', async (_l, displayName) => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'alice')).jar;
		expect((await send('/api/settings/profile', { method: 'PATCH', jar, headers: json, body: JSON.stringify({ displayName }) })).status).toBe(400);
	});

	it('Discord turns on only after a real test DM, and stays on after logging in again', async () => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'alice')).jar;
		const on = await toggle(send, jar, 'discord', true);
		expect(on.status).toBe(200);
		expect(((await on.json()) as { status: { enabled: boolean; delivering: boolean } }).status).toMatchObject({ enabled: true, delivering: true });
		expect(sentDms).toHaveLength(1);
		expect(sentDms[0]).toMatchObject({ to: 'alice', auth: 'Bot bot-token' });
		expect(sentDms[0].content).toContain('Discord 알림이 연결됐어요');
		expect(sentDms[0].body.allowed_mentions).toEqual({ parse: [] });
		const again = (await login(send, 'discord', 'alice')).jar;
		const s = (await (await settings(send, again)).json()) as Settings;
		expect(s.notifications.find((n) => n.channel === 'discord')?.enabled).toBe(true);
		expect((await toggle(send, again, 'discord', false)).status).toBe(200);
	});

	it('Discord cannot be turned on without a linked Discord account', async () => {
		const send = makeApp();
		const jar = (await login(send, 'google', 'gina')).jar;
		const res = await toggle(send, jar, 'discord', true);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toBe('channel_unavailable');
	});

	it.each(['kakao', 'email'])('%s cannot be turned on (disabled channel); turning off is always allowed', async (channel) => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'alice')).jar;
		expect((await toggle(send, jar, channel, true)).status).toBe(409);
		expect((await toggle(send, jar, channel, false)).status).toBe(200);
		const s = (await (await settings(send, jar)).json()) as Settings;
		expect(s.notifications.find((n) => n.channel === channel)?.enabled).toBe(false);
	});

	it('preferences are per user and protected from other sites', async () => {
		const send = makeApp();
		const a = (await login(send, 'discord', 'alice')).jar;
		const b = (await login(send, 'discord', 'bob')).jar;
		await toggle(send, a, 'discord', true);
		const sb = (await (await settings(send, b)).json()) as Settings;
		expect(sb.notifications.find((n) => n.channel === 'discord')?.enabled).toBe(false);
		expect((await toggle(send, b, 'discord', true, { origin: 'https://evil.example' })).status).toBe(403);
		expect((await send('/api/settings/notifications/sms', { method: 'PUT', jar: a, headers: json, body: JSON.stringify({ enabled: true }) })).status).toBe(404);
	});
});

describe('Discord channel: test DM gate', () => {
	const json = { 'content-type': 'application/json' };
	const toggle = (send: Send, jar: Jar, enabled: boolean) =>
		send('/api/settings/notifications/discord', { method: 'PUT', jar, headers: json, body: JSON.stringify({ enabled }) });

	it('stays off with a clear reason when Discord refuses the DM (no shared server / DMs closed)', async () => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'blocked')).jar;
		const res = await toggle(send, jar, true);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string; message: string; status: { enabled: boolean } };
		expect(body.error).toBe('test_failed');
		expect(body.message).toContain('서버에 참여');
		expect(body.status.enabled).toBe(false);
	});

	it('turning off clears the verification; turning on again sends a new test DM', async () => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'alice')).jar;
		await toggle(send, jar, true);
		await toggle(send, jar, false);
		const row = await db.prepare("SELECT enabled, verified_at FROM notification_preferences WHERE channel = 'discord'").first<{ enabled: number; verified_at: string | null }>();
		expect(row).toEqual({ enabled: 0, verified_at: null });
		await toggle(send, jar, true);
		expect(sentDms).toHaveLength(2);
	});
});

describe('Discord channel: must join the bot\'s server first', () => {
	const json = { 'content-type': 'application/json' };
	type Discord = { available: boolean; enabled: boolean; note: string; server?: { joined: boolean | null; inviteUrl: string | null } };
	const discordStatus = async (send: Send, jar: Jar) =>
		((await (await send('/api/settings', { jar })).json()) as { notifications: (Discord & { channel: string })[] }).notifications.find(
			(n) => n.channel === 'discord',
		)!;
	const toggle = (send: Send, jar: Jar, enabled: boolean) =>
		send('/api/settings/notifications/discord', { method: 'PUT', jar, headers: json, body: JSON.stringify({ enabled }) });

	it('locks the switch and offers the invite until the user joins; the server re-checks on enable', async () => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'outsider')).jar;
		memberChecks.length = 0;
		const status = await discordStatus(send, jar);
		expect(status).toMatchObject({ available: false, enabled: false, server: { joined: false, inviteUrl: 'https://discord.gg/memo-test' } });
		expect(status.note).toContain('서버에 가입');
		expect(memberChecks).toEqual(['guild-1/outsider (Bot bot-token)']);
		// A crafted request cannot skip the step: no test DM, stays off.
		const res = await toggle(send, jar, true);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toBe('channel_unavailable');
		expect(sentDms).toHaveLength(0);
	});

	it('unlocks for members and shows that they joined', async () => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'alice')).jar;
		expect(await discordStatus(send, jar)).toMatchObject({ available: true, server: { joined: true } });
		expect((await toggle(send, jar, true)).status).toBe(200);
		expect(sentDms).toHaveLength(1);
	});

	it('when Discord cannot answer, it does not guess: the test DM decides', async () => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'unsure')).jar;
		expect(await discordStatus(send, jar)).toMatchObject({ available: true, server: { joined: null } });
		expect((await toggle(send, jar, true)).status).toBe(200);
	});

	it('someone who left the server shows as off (not "receiving") until they join again', async () => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'outsider')).jar;
		await db
			.prepare("INSERT INTO notification_preferences (user_id, channel, enabled, verified_at, updated_at) SELECT user_id, 'discord', 1, ?, ? FROM oauth_accounts WHERE provider_subject = 'outsider'")
			.bind(clock.toISOString(), clock.toISOString())
			.run();
		expect(await discordStatus(send, jar)).toMatchObject({ available: false, enabled: false });
		// Turning off is still allowed.
		expect((await toggle(send, jar, false)).status).toBe(200);
	});

	it('without a server id configured, nothing is checked and the test DM decides (previous behavior)', async () => {
		const send = makeApp({ DISCORD_GUILD_ID: undefined });
		const jar = (await login(send, 'discord', 'outsider')).jar;
		memberChecks.length = 0;
		const status = await discordStatus(send, jar);
		expect(status.available).toBe(true);
		expect(status.server).toBeUndefined();
		expect(memberChecks).toEqual([]);
	});
});

describe('repeating reminders (one DM per occurrence, never twice)', () => {
	const json = { 'content-type': 'application/json' };
	type Item = { id: string; title: string; reminder: { at: string; status: string } | null; occurrence?: { date: string } };
	const list = async (send: Send, jar: Jar) => ((await (await send('/api/memos?scope=all', { jar })).json()) as { memos: Item[] }).memos;
	const remind = (send: Send, jar: Jar, id: string, body: object) => send(`/api/memos/${id}/reminder`, { method: 'PUT', jar, headers: json, body: JSON.stringify(body) });
	const run = () => runDueReminders({ DB: db, DISCORD_BOT_TOKEN: 'bot-token' }, clock, fakeFetch);
	const deliveries = async () => ((await db.prepare('SELECT COUNT(*) AS n FROM reminder_deliveries').first<{ n: number }>())?.n ?? 0);
	type Embed = { fields: { name: string; value: string }[] };

	async function repeating(subject = 'alice', text = '매주 월수금 오후 7시 운동') {
		const send = makeApp();
		const jar = (await login(send, 'discord', subject)).jar;
		const on = await send('/api/settings/notifications/discord', { method: 'PUT', jar, headers: json, body: JSON.stringify({ enabled: true }) });
		if (on.status !== 200) {
			await db.prepare("INSERT INTO notification_preferences (user_id, channel, enabled, verified_at, updated_at) SELECT id, 'discord', 1, '2026-11-15T00:00:00.000Z', '2026-11-15T00:00:00.000Z' FROM users WHERE id NOT IN (SELECT user_id FROM notification_preferences)").run();
		}
		await postMemo(send, text, jar);
		const memo = (await list(send, jar))[0];
		sentDms.length = 0;
		return { send, jar, memo };
	}

	it('"30분 전" for every occurrence: sends the card for this one, then waits for the next', async () => {
		const { send, jar, memo } = await repeating(); // Mon/Wed/Fri 19:00 KST, first 2026-11-16
		expect(await (await remind(send, jar, memo.id, { leadMinutes: 30 })).json()).toEqual({ scheduledAt: '2026-11-16T09:30:00.000Z' });
		expect((await remind(send, jar, memo.id, { at: '2026-11-16T18:00:00+09:00' })).status).toBe(422); // one picked time does not fit a series
		clock = new Date('2026-11-16T09:30:05Z');
		expect((await run()).sent).toBe(1);
		const embed = (sentDms[0].body.embeds as Embed[])[0];
		expect(embed.fields).toContainEqual({ name: '🔁 반복', value: '매주 월·수·금', inline: false });
		expect(embed.fields).toContainEqual({ name: '⏰ 예정', value: '11월 16일 (월) 오후 7:00', inline: false });
		expect(embed.fields).toContainEqual({ name: '🔔 알림', value: '30분 전', inline: true });
		expect((await list(send, jar))[0].reminder).toMatchObject({ at: '2026-11-18T09:30:00.000Z', status: 'scheduled' }); // Wednesday
		expect(await run()).toMatchObject({ sent: 0 });
		clock = new Date('2026-11-18T09:30:05Z');
		expect((await run()).sent).toBe(1);
		expect(sentDms).toHaveLength(2);
	});

	it('the same occurrence is never sent twice, even if the row is pushed back to it', async () => {
		const { send, jar, memo } = await repeating();
		await remind(send, jar, memo.id, { leadMinutes: 30 });
		clock = new Date('2026-11-16T09:30:05Z');
		await run();
		// Simulate a stale state (e.g. an edit racing a send) pointing at the delivered occurrence again.
		await db.prepare("UPDATE notifications SET occurrence_date = '2026-11-16', scheduled_at = '2026-11-16T09:30:00.000Z', next_attempt_at = '2026-11-16T09:30:00.000Z', status = 'scheduled'").run();
		const again = await run();
		expect(again.sent).toBe(0);
		expect(sentDms).toHaveLength(1);
		expect(await deliveries()).toBe(1);
		expect((await list(send, jar))[0].reminder?.at).toBe('2026-11-18T09:30:00.000Z');
	});

	it('two overlapping cron runs send one DM for the occurrence', async () => {
		const { send, jar, memo } = await repeating();
		await remind(send, jar, memo.id, { leadMinutes: 0 });
		clock = new Date('2026-11-16T10:00:05Z');
		const [a, b] = await Promise.all([run(), run()]);
		expect(a.sent + b.sent).toBe(1);
		expect(sentDms).toHaveLength(1);
	});

	it('an occurrence checked off before its time is skipped (no DM) and the next one is waited for', async () => {
		const { send, jar, memo } = await repeating();
		await remind(send, jar, memo.id, { leadMinutes: 30 });
		await send(`/api/memos/${memo.id}/occurrences/2026-11-16`, { method: 'PATCH', jar, headers: json, body: JSON.stringify({ completed: true }) });
		clock = new Date('2026-11-16T09:30:05Z');
		expect(await run()).toMatchObject({ sent: 0 });
		expect(sentDms).toHaveLength(0);
		expect((await list(send, jar))[0].reminder?.at).toBe('2026-11-18T09:30:00.000Z');
	});

	it('date-only repeating memo needs a time of day (never invented)', async () => {
		const { send, jar, memo } = await repeating('alice', '매일 물 마시기');
		expect(memo.title).toBe('물 마시기');
		expect((await remind(send, jar, memo.id, {})).status).toBe(422);
		// 12:00 KST now → today 08:00 has passed → tomorrow 08:00 KST.
		expect(await (await remind(send, jar, memo.id, { time: '08:00' })).json()).toEqual({ scheduledAt: '2026-11-15T23:00:00.000Z' });
	});

	it('a failed send frees the occurrence for the retry; a permanent refusal stops the series', async () => {
		const { send, jar, memo } = await repeating('flaky');
		await remind(send, jar, memo.id, { leadMinutes: 30 });
		const b = await repeating('blocked');
		await remind(b.send, b.jar, b.memo.id, { leadMinutes: 30 });
		clock = new Date('2026-11-16T09:30:05Z');
		expect(await run()).toMatchObject({ retried: 1, failed: 1, sent: 0 });
		expect(await deliveries()).toBe(1); // only the refused one stays recorded; the flaky one is free to retry
		expect((await list(b.send, b.jar))[0].reminder?.status).toBe('failed');
		expect((await list(send, jar))[0].reminder?.status).toBe('scheduled');
	});

	it('making the memo one-time cancels the series reminder; others cannot touch the occurrences', async () => {
		const { send, jar, memo } = await repeating();
		await remind(send, jar, memo.id, { leadMinutes: 30 });
		const put = await send(`/api/memos/${memo.id}`, {
			method: 'PUT',
			jar,
			headers: json,
			body: JSON.stringify({ title: '운동', content: '운동', category: 'schedule', priority: null, dueDate: '2026-11-16', dueTime: '19:00', repeat: null }),
		});
		expect(put.status).toBe(200);
		expect((await list(send, jar))[0].reminder).toBeNull();
		const bob = (await login(send, 'discord', 'bob')).jar;
		expect((await send(`/api/memos/${memo.id}/occurrences/2026-11-16`, { method: 'PATCH', jar: bob, headers: json, body: JSON.stringify({ completed: true }) })).status).toBe(404);
		expect((await send(`/api/memos/${memo.id}/recurrence`, { method: 'POST', jar: bob, headers: json, body: JSON.stringify({ choice: 'repeat' }) })).status).toBe(404);
		// The guest space cannot see it either.
		expect((await send(`/api/memos/${memo.id}/occurrences/2026-11-16`, { method: 'PATCH', headers: json, body: JSON.stringify({ completed: true }) })).status).toBe(404);
	});
});

describe('calendar keeps personal and shared data apart', () => {
	it('each space sees only its own dated memos; the guest calendar never shows personal memos', async () => {
		const send = makeApp();
		const a = (await login(send, 'discord', 'alice')).jar;
		const b = (await login(send, 'discord', 'bob')).jar;
		await postMemo(send, '내일 앨리스 비밀 일정', a);
		await postMemo(send, '내일 밥 일정', b);
		await postMemo(send, '내일 공용 일정');
		const titles = async (jar?: Jar) =>
			((await (await send('/api/calendar?month=2026-11', { jar })).json()) as { memos: { title: string }[] }).memos.map((m) => m.title);
		expect(await titles(a)).toEqual(['내일 앨리스 비밀 일정']);
		expect(await titles(b)).toEqual(['내일 밥 일정']);
		expect(await titles()).toEqual(['내일 공용 일정']);
		// A workspace id sent by the client is ignored.
		const forged = await send('/api/calendar?month=2026-11&workspace=ws_shared_guest', { jar: a });
		expect(((await forged.json()) as { memos: { title: string }[] }).memos.map((m) => m.title)).toEqual(['내일 앨리스 비밀 일정']);
	});
});

describe('Discord reminder tone (fixed templates)', () => {
	const json = { 'content-type': 'application/json' };
	const tone = async (send: Send, jar?: Jar) => ((await (await send('/api/settings', { jar })).json()) as { reminderTone: string }).reminderTone;
	const setTone = (send: Send, jar: Jar | undefined, value: unknown, headers: Record<string, string> = {}) =>
		send('/api/settings/tone', { method: 'PATCH', jar, headers: { ...json, ...headers }, body: JSON.stringify({ tone: value }) });
	const preview = (send: Send, jar: Jar) => send('/api/settings/notifications/discord/preview', { method: 'POST', jar });

	it('defaults to friendly, is saved per user and survives a new login', async () => {
		const send = makeApp();
		const a = (await login(send, 'discord', 'alice')).jar;
		const b = (await login(send, 'discord', 'bob')).jar;
		expect(await tone(send, a)).toBe('friendly');
		expect((await setTone(send, a, 'formal')).status).toBe(200);
		expect(await tone(send, (await login(send, 'discord', 'alice')).jar)).toBe('formal');
		expect(await tone(send, b)).toBe('friendly');
	});

	it('rejects unknown tones, guests and other sites', async () => {
		const send = makeApp();
		const a = (await login(send, 'discord', 'alice')).jar;
		expect((await setTone(send, a, 'angry')).status).toBe(400);
		expect((await setTone(send, undefined, 'cute')).status).toBe(401);
		expect((await setTone(send, a, 'cute', { origin: 'https://evil.example' })).status).toBe(403);
		expect(await tone(send, a)).toBe('friendly');
	});

	it('preview sends one example card in the saved tone, only when Discord is on', async () => {
		const send = makeApp();
		const a = (await login(send, 'discord', 'alice')).jar;
		expect((await preview(send, a)).status).toBe(409); // channel off
		await send('/api/settings/notifications/discord', { method: 'PUT', jar: a, headers: json, body: JSON.stringify({ enabled: true }) });
		await setTone(send, a, 'formal');
		sentDms.length = 0;
		expect((await preview(send, a)).status).toBe(200);
		expect(sentDms).toHaveLength(1);
		const embed = (sentDms[0].body.embeds as { description: string; title: string }[])[0];
		expect(embed.title).toBe('📅 병원 방문');
		expect(embed.description).toBe('💬 ‘병원 방문’ 예정 시각까지 30분 남았습니다. 일정을 확인해 주세요.');
		expect(sentDms[0].content).toMatch(/^🧪 미리보기/);
		expect(sentDms[0].body.allowed_mentions).toEqual({ parse: [] });
	});
});

describe('reminders: confirm, cancel and deliver (Discord DM)', () => {
	const json = { 'content-type': 'application/json' };
	type Item = { id: string; title: string; due_at: string | null; due_date: string | null; reminder: { at: string; status: string; error: string | null } | null };
	const list = async (send: Send, jar?: Jar) => ((await (await send('/api/memos?scope=all', { jar })).json()) as { memos: Item[] }).memos;
	const remind = (send: Send, jar: Jar | undefined, id: string, body: object) =>
		send(`/api/memos/${id}/reminder`, { method: 'PUT', jar, headers: json, body: JSON.stringify(body) });
	const run = () => runDueReminders({ DB: db, DISCORD_BOT_TOKEN: 'bot-token' }, clock, fakeFetch);

	/** Alice with Discord verified and one memo; `exact` sets a due time (KST 2026-11-16 15:00). */
	async function aliceWithMemo(subject = 'alice', exact = true) {
		const send = makeApp();
		const jar = (await login(send, 'discord', subject)).jar;
		const on = await send('/api/settings/notifications/discord', { method: 'PUT', jar, headers: json, body: JSON.stringify({ enabled: true }) });
		// "blocked"/"flaky" fail the test DM by design; mark them verified directly to test delivery.
		if (subject !== 'blocked' && subject !== 'flaky') expect(on.status).toBe(200);
		else await db.prepare("INSERT INTO notification_preferences (user_id, channel, enabled, verified_at, updated_at) SELECT id, 'discord', 1, '2026-11-15T00:00:00.000Z', '2026-11-15T00:00:00.000Z' FROM users WHERE id NOT IN (SELECT user_id FROM notification_preferences)").run();
		await postMemo(send, '내일 보고서 제출', jar);
		const memo = (await list(send, jar))[0];
		if (exact) await db.prepare("UPDATE memos SET due_at = '2026-11-16T06:00:00.000Z' WHERE id = ?").bind(memo.id).run();
		sentDms.length = 0;
		return { send, jar, memo };
	}

	it('exact-time memo: "30분 전" schedules 14:30 KST and the card shows it', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		const res = await remind(send, jar, memo.id, { leadMinutes: 30 });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ scheduledAt: '2026-11-16T05:30:00.000Z' });
		expect((await list(send, jar))[0].reminder).toEqual({ at: '2026-11-16T05:30:00.000Z', status: 'scheduled', error: null });
	});

	it('date-only memo needs an explicit time (no invented time)', async () => {
		const { send, jar, memo } = await aliceWithMemo('alice', false);
		expect(memo.due_at).toBeNull();
		expect((await remind(send, jar, memo.id, { leadMinutes: 30 })).status).toBe(422);
		const res = await remind(send, jar, memo.id, { time: '09:15' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ scheduledAt: `${memo.due_date}T00:15:00.000Z` }); // 09:15 KST
	});

	it.each([
		['invalid lead', { leadMinutes: 15 }, 422],
		['bad time format (rejected even for exact-time memos)', { time: '25:00' }, 400],
	])('rejects %s', async (_l, body, status) => {
		const { send, jar, memo } = await aliceWithMemo();
		expect((await remind(send, jar, memo.id, body)).status).toBe(status);
	});

	it('refuses past times, memos without a deadline, other people\'s memos, guests, and a channel that is off', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		clock = new Date('2026-11-16T05:45:00Z'); // 30 min before 15:00 KST has passed
		expect(((await (await remind(send, jar, memo.id, { leadMinutes: 30 })).json()) as { error: string }).error).toBe('past_time');
		clock = new Date('2026-11-15T03:00:00Z');
		await db.prepare('UPDATE memos SET due_at = NULL, due_date = NULL WHERE id = ?').bind(memo.id).run();
		expect(((await (await remind(send, jar, memo.id, { leadMinutes: 0 })).json()) as { error: string }).error).toBe('no_deadline');
		const bob = (await login(send, 'discord', 'bob')).jar;
		expect((await remind(send, bob, memo.id, { leadMinutes: 0 })).status).toBe(404); // bob's channel is off too, but the memo is not his
		expect((await remind(send, undefined, memo.id, { leadMinutes: 0 })).status).toBe(401);
		const { send: s2, jar: j2, memo: m2 } = await aliceWithMemo('carol');
		await s2('/api/settings/notifications/discord', { method: 'PUT', jar: j2, headers: json, body: JSON.stringify({ enabled: false }) });
		expect(((await (await remind(s2, j2, m2.id, { leadMinutes: 0 })).json()) as { error: string }).error).toBe('channel_off');
	});

	it('a cron run that comes before the due time waits and sends exactly on the minute', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		await remind(send, jar, memo.id, { leadMinutes: 30 }); // due 05:30:00Z
		// Production cron fires about 50 s into each minute.
		clock = new Date('2026-11-16T05:29:50Z');
		const waits: number[] = [];
		const sentAt: string[] = [];
		const timing = {
			lookaheadMs: CRON_LOOKAHEAD_MS,
			clock: () => clock,
			sleep: async (ms: number) => {
				waits.push(ms);
				clock = new Date(clock.getTime() + ms);
			},
		};
		const recordingFetch: typeof fetch = async (input, init) => {
			if (String(input).endsWith('/messages')) sentAt.push(clock.toISOString());
			return fakeFetch(input, init);
		};
		expect(await runDueReminders({ DB: db, DISCORD_BOT_TOKEN: 'bot-token' }, clock, recordingFetch, 10, timing)).toEqual({ sent: 1, retried: 0, failed: 0, canceled: 0 });
		expect(waits).toEqual([10_000]);
		expect(sentAt).toEqual(['2026-11-16T05:30:00.000Z']);
		expect((await list(send, jar))[0].reminder?.status).toBe('sent');
	});

	it('looks ahead only one run: later reminders wait for their own run', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		await remind(send, jar, memo.id, { leadMinutes: 30 }); // due 05:30:00Z
		clock = new Date('2026-11-16T05:28:50Z'); // 70 s early: beyond the look-ahead
		const sleeps: number[] = [];
		const timing = { lookaheadMs: CRON_LOOKAHEAD_MS, clock: () => clock, sleep: async (ms: number) => void sleeps.push(ms) };
		expect((await runDueReminders({ DB: db, DISCORD_BOT_TOKEN: 'bot-token' }, clock, fakeFetch, 10, timing)).sent).toBe(0);
		expect(sleeps).toEqual([]);
	});

	it('turning a reminder off while the run waits for its minute means it is not sent', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		await remind(send, jar, memo.id, { leadMinutes: 30 });
		clock = new Date('2026-11-16T05:29:50Z');
		const timing = {
			lookaheadMs: CRON_LOOKAHEAD_MS,
			clock: () => clock,
			sleep: async (ms: number) => {
				expect((await send(`/api/memos/${memo.id}/reminder`, { method: 'DELETE', jar })).status).toBe(200);
				clock = new Date(clock.getTime() + ms);
			},
		};
		expect((await runDueReminders({ DB: db, DISCORD_BOT_TOKEN: 'bot-token' }, clock, fakeFetch, 10, timing)).sent).toBe(0);
		expect(sentDms).toHaveLength(0);
	});

	it('any picked time works (before or after the deadline) if it is 4+ minutes away; 3 minutes or past is refused', async () => {
		const { send, jar, memo } = await aliceWithMemo(); // due 2026-11-16 15:00 KST
		clock = new Date('2026-11-16T05:00:30Z'); // 14:00:30 KST → earliest allowed 14:04
		const at = (kst: string) => remind(send, jar, memo.id, { at: `${kst}:00+09:00`, channels: ['discord'] });
		const code = async (res: Response) => ((await res.json()) as { error?: string }).error;
		expect(await code(await at('2026-11-16T14:03'))).toBe('past_time'); // 3 min ahead
		expect(await code(await at('2026-11-16T13:59'))).toBe('past_time'); // past
		const ok = await at('2026-11-16T14:04'); // 4 min ahead
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ scheduledAt: '2026-11-16T05:04:00.000Z' });
		// After the deadline is fine too; it replaces the previous time.
		expect((await at('2026-11-17T09:00')).status).toBe(200);
		expect((await list(send, jar))[0].reminder).toMatchObject({ at: '2026-11-17T00:00:00.000Z', status: 'scheduled' });
	});

	it('only channels that can deliver are accepted (Kakao/Gmail are not yet), and at least one is needed', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		const body = (channels: string[]) => ({ at: '2026-11-16T14:30:00+09:00', channels });
		const err = async (channels: string[]) => {
			const res = await remind(send, jar, memo.id, body(channels));
			return [res.status, ((await res.json()) as { error?: string }).error];
		};
		expect(await err(['kakao'])).toEqual([422, 'channel_unavailable']);
		expect(await err(['discord', 'email'])).toEqual([422, 'channel_unavailable']);
		expect(await err([])).toEqual([422, 'invalid_request']);
		expect(await err(['sms'])).toEqual([400, 'invalid_request']);
		expect((await remind(send, jar, memo.id, body(['discord']))).status).toBe(200);
	});

	it('editing the deadline moves "N분 전" reminders with it; a clock-time reminder stays; another user cannot edit', async () => {
		const { send, jar, memo } = await aliceWithMemo(); // due 2026-11-16 15:00 KST
		await remind(send, jar, memo.id, { leadMinutes: 30 }); // 14:30 KST
		const put = (j: Jar, change: object) =>
			send(`/api/memos/${memo.id}`, {
				method: 'PUT',
				jar: j,
				headers: json,
				body: JSON.stringify({ title: memo.title, content: '보고서 내기', category: 'todo', priority: 'high', dueDate: '2026-11-16', dueTime: '15:00', ...change }),
			});
		expect((await put(jar, { dueTime: '17:00' })).status).toBe(200);
		expect((await list(send, jar))[0].reminder).toMatchObject({ at: '2026-11-16T07:30:00.000Z', status: 'scheduled' }); // 16:30 KST
		// The person picked an exact clock time → it is not moved.
		await remind(send, jar, memo.id, { at: '2026-11-16T09:00:00+09:00' });
		expect((await put(jar, { dueTime: '18:00' })).status).toBe(200);
		expect((await list(send, jar))[0].reminder).toMatchObject({ at: '2026-11-16T00:00:00.000Z', status: 'scheduled' });
		// Relative reminder + deadline loses its time → cancelled instead of firing at a stale time.
		await remind(send, jar, memo.id, { leadMinutes: 10 });
		expect((await put(jar, { dueTime: null })).status).toBe(200);
		expect((await list(send, jar))[0].reminder).toBeNull();
		// Isolation: bob cannot see or edit alice's memo.
		const bob = (await login(send, 'discord', 'bob')).jar;
		expect((await put(bob, { title: '바꿈' })).status).toBe(404);
		expect((await list(send, jar))[0].title).toBe(memo.title);
	});

	it('a picked time 30 minutes before the memo still says "30분 뒤" in the DM', async () => {
		const { send, jar, memo } = await aliceWithMemo(); // due 15:00 KST
		await remind(send, jar, memo.id, { at: '2026-11-16T14:30:00+09:00', channels: ['discord'] });
		clock = new Date('2026-11-16T05:30:05Z');
		expect((await run()).sent).toBe(1);
		const embed = (sentDms[0].body.embeds as { description: string; fields: { name: string; value: string }[] }[])[0];
		expect(embed.description).toContain('30분 남았어요');
		expect(embed.fields.find((f) => f.name === '🔔 알림')?.value).toBe('30분 전');
	});

	it('if Discord refuses the card, the same reminder goes out once as plain text (never both)', async () => {
		const { send, jar, memo } = await aliceWithMemo('cardless');
		await remind(send, jar, memo.id, { leadMinutes: 30 });
		clock = new Date('2026-11-16T05:30:10Z');
		expect(await run()).toEqual({ sent: 1, retried: 0, failed: 0, canceled: 0 });
		expect(sentDms).toHaveLength(1);
		expect(sentDms[0].body.embeds).toBeUndefined();
		expect(sentDms[0].content).toBe('🔔 메모비서 · ‘내일 보고서 제출’ 마감까지 30분 남았어요! 미리 챙겨 두세요 😊 (11월 16일 (월) 오후 3:00)');
		expect(await run()).toEqual({ sent: 0, retried: 0, failed: 0, canceled: 0 });
	});

	it('real reminders use the tone the user saved', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		await send('/api/settings/tone', { method: 'PATCH', jar, headers: json, body: JSON.stringify({ tone: 'cute' }) });
		await remind(send, jar, memo.id, { leadMinutes: 30 });
		clock = new Date('2026-11-16T05:30:10Z');
		expect((await run()).sent).toBe(1);
		expect((sentDms[0].body.embeds as { description: string }[])[0].description).toBe('💬 똑똑! ‘내일 보고서 제출’ 마감까지 30분 남았어요~ 화이팅 💪');
	});

	it('sending a reminder never touches Workers AI (templates only)', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		await remind(send, jar, memo.id, { leadMinutes: 30 });
		clock = new Date('2026-11-16T05:30:10Z');
		const touched: string[] = [];
		const AI = new Proxy({}, { get: (_t, key) => (touched.push(String(key)), () => { throw new Error('AI must not be called'); }) });
		const result = await runDueReminders({ DB: db, DISCORD_BOT_TOKEN: 'bot-token', AI } as never, clock, fakeFetch);
		expect(result.sent).toBe(1);
		expect(touched).toEqual([]);
	});

	it('delivers once at the right time, only to the owner, with the memo and time', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		await remind(send, jar, memo.id, { leadMinutes: 30 });
		clock = new Date('2026-11-16T05:29:00Z');
		expect((await run()).sent).toBe(0); // not yet
		clock = new Date('2026-11-16T05:30:10Z');
		expect(await run()).toEqual({ sent: 1, retried: 0, failed: 0, canceled: 0 });
		expect(await run()).toEqual({ sent: 0, retried: 0, failed: 0, canceled: 0 }); // never twice
		expect(sentDms).toHaveLength(1);
		expect(sentDms[0].to).toBe('alice');
		// Embed card from stored fields + the default friendly tone (no AI call).
		expect(sentDms[0].content).toBe('🔔 내일 보고서 제출 · 30분 전');
		expect(sentDms[0].body.embeds).toEqual([
			expect.objectContaining({
				title: '✅ 내일 보고서 제출',
				description: '💬 ‘내일 보고서 제출’ 마감까지 30분 남았어요! 미리 챙겨 두세요 😊',
				author: { name: '🔔 메모비서 · 할 일 알림' },
				fields: [
					{ name: '🗂 분류', value: '✅ 할 일', inline: true },
					{ name: '🔔 알림', value: '30분 전', inline: true },
					{ name: '⏰ 마감', value: '11월 16일 (월) 오후 3:00', inline: false },
				],
				timestamp: '2026-11-16T05:30:00.000Z',
			}),
		]);
		expect(sentDms[0].body.allowed_mentions).toEqual({ parse: [] });
		expect((await list(send, jar))[0].reminder?.status).toBe('sent');
	});

	it('two overlapping cron runs still send once (claimed per row)', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		await remind(send, jar, memo.id, { leadMinutes: 0 });
		clock = new Date('2026-11-16T06:00:05Z');
		const [a, b] = await Promise.all([run(), run()]);
		expect(a.sent + b.sent).toBe(1);
		expect(sentDms).toHaveLength(1);
	});

	it('does not send when the memo was completed or deleted, or the channel turned off', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		await remind(send, jar, memo.id, { leadMinutes: 0 });
		await send(`/api/memos/${memo.id}`, { method: 'PATCH', jar, headers: json, body: JSON.stringify({ completed: true }) });
		clock = new Date('2026-11-16T06:00:05Z');
		expect((await run()).canceled).toBe(1);
		expect(sentDms).toHaveLength(0);

		clock = new Date('2026-11-15T03:00:00Z');
		const other = await aliceWithMemo('dave');
		await remind(other.send, other.jar, other.memo.id, { leadMinutes: 0 });
		await other.send('/api/settings/notifications/discord', { method: 'PUT', jar: other.jar, headers: json, body: JSON.stringify({ enabled: false }) });
		clock = new Date('2026-11-16T06:00:05Z');
		expect((await run()).canceled).toBe(1);
		expect(sentDms).toHaveLength(0);
	});

	it('the user can cancel a reminder', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		await remind(send, jar, memo.id, { leadMinutes: 0 });
		expect((await send(`/api/memos/${memo.id}/reminder`, { method: 'DELETE', jar })).status).toBe(200);
		expect((await list(send, jar))[0].reminder).toBeNull();
		clock = new Date('2026-11-16T06:00:05Z');
		expect((await run()).sent).toBe(0);
	});

	it('retries temporary Discord errors with backoff, then gives up after 3 attempts', async () => {
		const { send, jar, memo } = await aliceWithMemo('flaky');
		await remind(send, jar, memo.id, { leadMinutes: 0 });
		clock = new Date('2026-11-16T06:00:05Z');
		expect((await run()).retried).toBe(1); // attempt 1 → wait 2 min
		expect((await run()).retried).toBe(0); // not due yet
		clock = new Date('2026-11-16T06:02:10Z');
		expect((await run()).retried).toBe(1); // attempt 2 → wait 4 min
		clock = new Date('2026-11-16T06:06:20Z');
		expect((await run()).failed).toBe(1); // attempt 3 → give up
		expect((await list(send, jar))[0].reminder).toMatchObject({ status: 'failed', error: 'http_500' });
	});

	it('a permanent refusal (DMs closed) fails without retrying', async () => {
		const { send, jar, memo } = await aliceWithMemo('blocked');
		await remind(send, jar, memo.id, { leadMinutes: 0 });
		clock = new Date('2026-11-16T06:00:05Z');
		expect((await run()).failed).toBe(1);
		expect((await list(send, jar))[0].reminder).toMatchObject({ status: 'failed', error: '50007' });
	});

	it('skips reminders that are over an hour late and never resends an unknown outcome', async () => {
		const { send, jar, memo } = await aliceWithMemo();
		await remind(send, jar, memo.id, { leadMinutes: 0 });
		clock = new Date('2026-11-16T07:30:00Z'); // 90 min late (e.g. after an outage)
		expect((await run()).failed).toBe(1);
		expect(sentDms).toHaveLength(0);

		const other = await aliceWithMemo('erin');
		clock = new Date('2026-11-15T03:00:00Z');
		await remind(other.send, other.jar, other.memo.id, { leadMinutes: 0 });
		// Simulate a crash right after claiming: stuck in "sending".
		await db.prepare("UPDATE notifications SET status = 'sending', updated_at = '2026-11-16T06:00:00.000Z' WHERE memo_id = ?").bind(other.memo.id).run();
		clock = new Date('2026-11-16T06:20:00Z');
		await run();
		expect(sentDms).toHaveLength(0);
		const row = await db.prepare('SELECT status, last_error FROM notifications WHERE memo_id = ?').bind(other.memo.id).first();
		expect(row).toEqual({ status: 'failed', last_error: 'unknown_outcome' });
	});
});

describe('automatic reminders for AI-recommended memos (turn off in the upcoming panel)', () => {
	const json = { 'content-type': 'application/json' };
	type Item = { id: string; title: string; due_at: string | null; due_date: string | null; reminder: { at: string; status: string } | null };
	const list = async (send: Send, jar?: Jar) => ((await (await send('/api/memos?scope=all', { jar })).json()) as { memos: Item[] }).memos;
	const byTitle = async (send: Send, jar: Jar, t: string) => (await list(send, jar)).find((m) => m.title.includes(t))!;
	const discordOn = (send: Send, jar: Jar) =>
		send('/api/settings/notifications/discord', { method: 'PUT', jar, headers: json, body: JSON.stringify({ enabled: true }) });

	async function ready() {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'alice')).jar;
		expect((await discordOn(send, jar)).status).toBe(200);
		return { send, jar };
	}

	it('a recommended exact-time memo gets a reminder at the default lead (30 min) right after saving', async () => {
		const { send, jar } = await ready();
		const res = await postMemo(send, '내일 오후 3시 팀 회의', jar);
		const created = (await res.json()) as { memos: Item[] };
		expect(created.memos[0].reminder).toEqual({ at: '2026-11-16T05:30:00.000Z', status: 'scheduled', error: null });
		await postMemo(send, '내일 그냥 메모', jar); // not recommended → nothing
		expect((await byTitle(send, jar, '그냥')).reminder).toBeNull();
	});

	it('never invents a time for date-only memos; uses the user\'s chosen time once set', async () => {
		const { send, jar } = await ready();
		await postMemo(send, '[추천] 내일 장보기', jar);
		expect((await byTitle(send, jar, '장보기')).reminder).toBeNull();
		const res = await send('/api/settings/reminders', { method: 'PATCH', jar, headers: json, body: JSON.stringify({ leadMinutes: 10, dateOnlyTime: '09:00' }) });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { scheduled: number }).scheduled).toBe(1);
		const memo = await byTitle(send, jar, '장보기');
		expect(memo.reminder?.at).toBe(`${memo.due_date}T00:00:00.000Z`); // 09:00 KST
		// New default lead applies to new exact-time memos.
		const created = (await (await postMemo(send, '내일 오후 3시 리뷰', jar)).json()) as { memos: Item[] };
		expect(created.memos[0].reminder?.at).toBe('2026-11-16T05:50:00.000Z');
	});

	it('nothing is scheduled while Discord is off; turning it on schedules existing recommended memos', async () => {
		const send = makeApp();
		const jar = (await login(send, 'discord', 'alice')).jar;
		await postMemo(send, '내일 오후 3시 팀 회의', jar);
		expect((await byTitle(send, jar, '팀 회의')).reminder).toBeNull();
		const on = await discordOn(send, jar);
		expect(((await on.json()) as { scheduled: number }).scheduled).toBe(1);
		expect((await byTitle(send, jar, '팀 회의')).reminder?.status).toBe('scheduled');
	});

	it('a reminder the user turned off stays off (new memos, re-enabling Discord, new defaults)', async () => {
		const { send, jar } = await ready();
		await postMemo(send, '내일 오후 3시 팀 회의', jar);
		const memo = await byTitle(send, jar, '팀 회의');
		expect((await send(`/api/memos/${memo.id}/reminder`, { method: 'DELETE', jar })).status).toBe(200);
		await postMemo(send, '내일 오후 3시 다른 회의', jar);
		await send('/api/settings/notifications/discord', { method: 'PUT', jar, headers: json, body: JSON.stringify({ enabled: false }) });
		await discordOn(send, jar);
		await send('/api/settings/reminders', { method: 'PATCH', jar, headers: json, body: JSON.stringify({ leadMinutes: 60, dateOnlyTime: null }) });
		expect((await byTitle(send, jar, '팀 회의')).reminder).toBeNull();
		expect((await byTitle(send, jar, '다른 회의')).reminder?.status).toBe('scheduled');
	});

	it('can be turned back on from the panel with the defaults (no body needed)', async () => {
		const { send, jar } = await ready();
		await postMemo(send, '내일 오후 3시 팀 회의', jar);
		const memo = await byTitle(send, jar, '팀 회의');
		await send(`/api/memos/${memo.id}/reminder`, { method: 'DELETE', jar });
		const res = await send(`/api/memos/${memo.id}/reminder`, { method: 'PUT', jar, headers: json, body: '{}' });
		expect(res.status).toBe(200);
		const agenda = (await (await send('/api/agenda', { jar })).json()) as { reminders: Item[] };
		expect(agenda.reminders[0].reminder?.status).toBe('scheduled');
	});

	it('guests never get automatic reminders', async () => {
		const send = makeApp();
		await postMemo(send, '내일 오후 3시 공용 회의');
		expect((await list(send))[0].reminder).toBeNull();
		expect((await db.prepare('SELECT COUNT(*) AS n FROM notifications').first<{ n: number }>())?.n).toBe(0);
	});

	it.each([
		['lead not in options', { leadMinutes: 15, dateOnlyTime: null }],
		['bad time', { leadMinutes: 30, dateOnlyTime: '9:00' }],
	])('rejects defaults: %s', async (_l, body) => {
		const { send, jar } = await ready();
		expect((await send('/api/settings/reminders', { method: 'PATCH', jar, headers: json, body: JSON.stringify(body) })).status).toBe(400);
	});
});
