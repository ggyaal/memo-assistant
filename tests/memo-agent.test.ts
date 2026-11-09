import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { start, type Flue } from '@flue/runtime/node';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoOrganizer } from '../src/agents/memo-organizer.ts';
import { runMemoAgent } from '../src/server/agent-runner.ts';
import { createApi, type ApiBindings } from '../src/server/routes.ts';
import type { CreateMemosResponse } from '../src/shared/types.ts';
import { env } from './helpers/cloudflare-workers-stub.ts';
import { createTestD1 } from './helpers/d1.ts';

/*
 * Runs the real Flue agent loop in-process: dispatch → MemoOrganizer render →
 * model turn → save_memos tool → D1. Only the model is scripted (Pi faux
 * provider registered under the `cloudflare` id), so no Workers AI call is made.
 */

const RAW = '오늘 장 보고, 내일 오후 3시에 병원 예약해야 해. AI 검색 기능 아이디어도 메모해 줘.';
const NOW = new Date('2026-11-09T12:40:00Z'); // 2026-11-09 21:40 KST

const faux = fauxProvider({ provider: 'cloudflare', models: [{ id: '@cf/zai-org/glm-4.7-flash' }] });

let flue: Flue;
let db: D1Database;
let dispose: () => Promise<void>;
let seenPrompts: string[] = [];
let requestCounter = 0;

function requestId() {
	requestCounter += 1;
	return `11111111-2222-4333-8444-${String(requestCounter).padStart(12, '0')}`;
}

function makeApp() {
	const app = new Hono<{ Bindings: ApiBindings }>();
	app.route('/api', createApi({ runAgent: runMemoAgent, now: () => NOW, agentTimeoutMs: 20_000 }));
	return (body: object) =>
		app.request(
			'/api/memos',
			{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
			{ DB: db, RATE_LIMIT_PER_MINUTE: '100', DAILY_AI_LIMIT: '100' },
		);
}

/** Record what the model was shown, then answer with a scripted message. */
function respond(message: ReturnType<typeof fauxAssistantMessage>) {
	return (context: unknown) => {
		seenPrompts.push(JSON.stringify(context));
		return message;
	};
}

beforeAll(async () => {
	({ db, dispose } = await createTestD1());
	env.DB = db;
	flue = await start({ agents: [MemoOrganizer], providers: [faux.provider] });
});

afterAll(async () => {
	await flue?.stop();
	await dispose?.();
});

beforeEach(() => {
	seenPrompts = [];
});

describe('MemoOrganizer agent (faux model, real Flue runtime + local D1)', () => {
	it('calls save_memos and stores 3 linked memos for the SPEC sample input', async () => {
		faux.setResponses([
			respond(
				fauxAssistantMessage(
					fauxToolCall('save_memos', {
						memos: [
							{ title: '장보기', content: '오늘 장보기', category: 'todo', due_at: null, due_text: '오늘', reminder_recommended: true, reminder_reason: '오늘 해야 할 일로 언급됨' },
							// Model deliberately gets the date wrong (+1 day); the server pins "내일".
							{ title: '병원 예약', content: '내일 오후 3시에 병원 예약하기', category: 'todo', due_at: '2026-11-11T15:00:00+09:00', due_text: '내일 오후 3시', reminder_recommended: true, reminder_reason: '명확한 수행 시각이 언급됨' },
							// Model invents a date for an idea; the server drops it.
							{ title: 'AI 검색 기능', content: 'AI 검색 기능 추가 아이디어', category: 'idea', due_at: '2026-12-01T09:00:00+09:00', due_text: '다음 달', reminder_recommended: false },
						],
					}),
					{ stopReason: 'toolUse' },
				),
			),
			// Only used if the runtime asks for another turn after the terminating tool.
			respond(fauxAssistantMessage(fauxText('저장했습니다.'))),
		]);

		const send = makeApp();
		const res = await send({ nickname: '에이전트테스트', text: RAW, requestId: requestId() });
		expect(res.status).toBe(201);
		const json = (await res.json()) as CreateMemosResponse;

		expect(json.memos).toHaveLength(3);
		expect(json.memos.map((m) => m.title)).toEqual(['장보기', '병원 예약', 'AI 검색 기능']);
		expect(json.memos.every((m) => m.source_id === json.source.id && m.nickname === '에이전트테스트')).toBe(true);
		expect(json.source.raw_text).toBe(RAW);
		expect(json.memos[1].due_at).toBe('2026-11-10T06:00:00.000Z'); // 내일 15:00 KST
		expect(json.memos[2].due_at).toBeNull();
		expect(json.memos[2].due_text).toBeNull();

		// The model saw the original text and the KST date reference, not trusted ids.
		const prompt = seenPrompts[0];
		expect(prompt).toContain('병원 예약');
		expect(prompt).toContain('내일 = 2026-11-10 (화)');
		expect(prompt).toContain('save_memos');
		expect(prompt).not.toContain(json.source.id);
	});

	it('returns not_saved when the model answers without calling the tool', async () => {
		faux.setResponses([respond(fauxAssistantMessage(fauxText('정리했어요!')))]);
		const send = makeApp();
		const res = await send({ nickname: '테스터', text: '그냥 잡담', requestId: requestId() });
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error: string }).error).toBe('not_saved');
	});

	it('maps a Workers AI quota error from the agent run to ai_quota_exceeded', async () => {
		faux.setResponses([
			fauxAssistantMessage([], { stopReason: 'error', errorMessage: '4006: you have used up your daily free allocation of 10,000 neurons' }),
		]);
		const send = makeApp();
		const res = await send({ nickname: '테스터', text: '내일 회의', requestId: requestId() });
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: string }).error).toBe('ai_quota_exceeded');
	});

	it('maps any other model failure to agent_failed', async () => {
		faux.setResponses([fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'upstream exploded' })]);
		const send = makeApp();
		const res = await send({ nickname: '테스터', text: '내일 회의', requestId: requestId() });
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error: string }).error).toBe('agent_failed');
	});
});
