import { Hono, type Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import * as v from 'valibot';
import type { ApiError, ApiErrorCode, CreateMemosResponse, ListMemosResponse, UsageResponse } from '../shared/types.ts';
import { LIMITS } from '../shared/types.ts';
import type { RunMemoAgent } from './agent-runner.ts';
import { findSourceByRequestId, listMemos } from './db.ts';
import { clientKey, consumeAiQuota, readUsage } from './rate-limit.ts';
import { kstDayRangeUtc } from './time.ts';
import { CreateMemosRequestSchema, issuesToMessage, ListMemosQuerySchema } from './validation.ts';

export interface ApiBindings {
	DB: D1Database;
	RATE_LIMIT_PER_MINUTE?: string;
	DAILY_AI_LIMIT?: string;
}

export interface ApiDeps {
	runAgent: RunMemoAgent;
	now?: () => Date;
	newId?: () => string;
	agentTimeoutMs?: number;
}

type ApiContext = Context<{ Bindings: ApiBindings }>;

function fail(
	c: ApiContext,
	status: 400 | 403 | 413 | 415 | 429 | 500 | 502 | 503 | 504,
	error: ApiErrorCode,
	message: string,
) {
	return c.json<ApiError>({ error, message }, status);
}

function isSameOrigin(origin: string, requestUrl: string): boolean {
	try {
		return new URL(origin).origin === new URL(requestUrl).origin;
	} catch {
		return false;
	}
}

/** Flatten an error and its `cause` chain into one searchable string. */
function describeError(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; current && depth < 5; depth++) {
		if (current instanceof Error) {
			parts.push(`${current.name}: ${current.message}`);
		} else if (typeof current === 'object') {
			// Flue's AgentRunError carries the recorded settlement error as a plain object.
			try {
				parts.push(JSON.stringify(current));
			} catch {
				parts.push(String(current));
			}
		} else {
			parts.push(String(current));
		}
		current = (current as { cause?: unknown }).cause;
	}
	return parts.join(' <- ');
}

export function classifyAgentError(error: unknown): { status: 502 | 503 | 504; code: ApiErrorCode; message: string } {
	const text = describeError(error);
	if (/TimeoutError|timed out/i.test(text)) {
		return { status: 504, code: 'agent_timeout', message: 'AI 응답이 너무 오래 걸립니다. 잠시 후 다시 시도해 주세요.' };
	}
	if (/4006|neuron|daily free allocation|quota|capacity|rate limit/i.test(text)) {
		return {
			status: 503,
			code: 'ai_quota_exceeded',
			message: '오늘 사용할 수 있는 무료 AI 사용량을 모두 썼습니다. 내일(한국 시간 오전 9시 이후) 다시 시도해 주세요.',
		};
	}
	return { status: 502, code: 'agent_failed', message: 'AI가 메모를 정리하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
}

function toPositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function dailyLimit(env: ApiBindings): number {
	return toPositiveInt(env.DAILY_AI_LIMIT, 150);
}

export function createApi(deps: ApiDeps) {
	const now = deps.now ?? (() => new Date());
	const newId = deps.newId ?? (() => crypto.randomUUID());
	const timeoutMs = deps.agentTimeoutMs ?? 90_000;
	const api = new Hono<{ Bindings: ApiBindings }>();

	// API responses are JSON only: forbid framing, sniffing and any active content.
	api.use(
		secureHeaders({
			contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
			crossOriginResourcePolicy: 'same-origin',
			referrerPolicy: 'no-referrer',
		}),
	);
	api.use(async (c, next) => {
		await next();
		c.header('Cache-Control', 'no-store');
	});

	api.get('/health', (c) => c.json({ ok: true }));

	api.get('/usage', async (c) => {
		try {
			const usage = await readUsage(c.env.DB, dailyLimit(c.env), now());
			return c.json<UsageResponse>(usage);
		} catch (error) {
			console.error('read usage failed', describeError(error));
			return fail(c, 500, 'db_error', '사용량을 불러오지 못했습니다.');
		}
	});

	api.get('/memos', async (c) => {
		const parsed = v.safeParse(ListMemosQuerySchema, c.req.query());
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const q = parsed.output;
		try {
			const result = await listMemos(c.env.DB, {
				range: q.scope === 'today' ? kstDayRangeUtc(now()) : undefined,
				category: q.category,
				nickname: q.nickname || undefined,
				cursor: q.cursor,
				limit: q.limit,
			});
			return c.json<ListMemosResponse>(result);
		} catch (error) {
			console.error('list memos failed', describeError(error));
			return fail(c, 500, 'db_error', '메모 목록을 불러오지 못했습니다.');
		}
	});

	api.post('/memos', async (c) => {
		// Cross-site protection: requiring application/json forces a CORS preflight
		// (which this API never answers), and a foreign Origin is rejected outright.
		// Without this, another site could make visitors' browsers spend the AI quota.
		const contentType = c.req.header('content-type') ?? '';
		if (!/^application\/json\b/i.test(contentType)) {
			return fail(c, 415, 'invalid_request', 'Content-Type은 application/json이어야 합니다.');
		}
		const origin = c.req.header('origin');
		if (origin && !isSameOrigin(origin, c.req.url)) {
			return fail(c, 403, 'forbidden_origin', '허용되지 않은 출처의 요청입니다.');
		}

		const declared = Number(c.req.header('content-length') ?? '0');
		if (declared > LIMITS.bodyBytesMax) return fail(c, 413, 'payload_too_large', '요청이 너무 큽니다.');
		const raw = await c.req.text();
		if (new TextEncoder().encode(raw).length > LIMITS.bodyBytesMax) {
			return fail(c, 413, 'payload_too_large', '요청이 너무 큽니다.');
		}
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			return fail(c, 400, 'invalid_request', 'JSON 형식이 올바르지 않습니다.');
		}
		const parsed = v.safeParse(CreateMemosRequestSchema, body);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const input = parsed.output;
		const db = c.env.DB;

		try {
			// Idempotency: a retried request returns the stored result without another AI call.
			const existing = await findSourceByRequestId(db, input.requestId);
			if (existing) {
				return c.json<CreateMemosResponse>({ duplicate: true, source: existing.source, memos: existing.memos });
			}

			const decision = await consumeAiQuota(
				db,
				await clientKey(c.req.header('cf-connecting-ip')),
				{
					perMinute: toPositiveInt(c.env.RATE_LIMIT_PER_MINUTE, 5),
					perDay: dailyLimit(c.env),
				},
				now(),
			);
			if (!decision.allowed) {
				c.header('Retry-After', String(decision.retryAfterSeconds));
				return decision.reason === 'rate_limited'
					? fail(c, 429, 'rate_limited', '요청이 너무 잦습니다. 1분 후 다시 시도해 주세요.')
					: fail(c, 429, 'daily_limit_reached', '오늘 데모의 AI 사용 한도에 도달했습니다. 내일 다시 시도해 주세요.');
			}
		} catch (error) {
			console.error('pre-agent db step failed', describeError(error));
			return fail(c, 500, 'db_error', '저장소에 접근하지 못했습니다.');
		}

		try {
			await deps.runAgent(
				{
					sourceId: newId(),
					requestId: input.requestId,
					nickname: input.nickname,
					rawText: input.text,
					createdAt: now().toISOString(),
				},
				{ timeoutMs },
			);
		} catch (error) {
			console.error('agent run failed', describeError(error));
			const saved = await findSourceByRequestId(db, input.requestId).catch(() => null);
			if (!saved) {
				const classified = classifyAgentError(error);
				return fail(c, classified.status, classified.code, classified.message);
			}
			// The tool already saved everything; a late failure does not lose the result.
			return c.json<CreateMemosResponse>({ duplicate: false, source: saved.source, memos: saved.memos }, 201);
		}

		const saved = await findSourceByRequestId(db, input.requestId).catch(() => null);
		if (!saved) {
			return fail(c, 502, 'not_saved', 'AI가 메모를 저장하지 못했습니다. 문장을 조금 바꿔 다시 시도해 주세요.');
		}
		return c.json<CreateMemosResponse>({ duplicate: false, source: saved.source, memos: saved.memos }, 201);
	});

	return api;
}
