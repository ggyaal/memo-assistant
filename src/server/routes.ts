import { Hono, type Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import * as v from 'valibot';
import type {
	AgendaResponse,
	ApiError,
	ApiErrorCode,
	CreateMemosResponse,
	ListMemosResponse,
	UsageResponse,
} from '../shared/types.ts';
import { LIMITS } from '../shared/types.ts';
import type { RunMemoAgent } from './agent-runner.ts';
import { buildAgenda } from './agenda.ts';
import {
	deleteOverdueMemo,
	findSourceByRequestId,
	listMemos,
	listOverdue,
	listUpcoming,
	saveManualOrder,
	setCompleted,
} from './db.ts';
import { clientKey, consumeAiQuota, consumeWindow, readUsage } from './rate-limit.ts';
import { describeSensitive, detectSensitive } from '../shared/privacy.ts';
import { kstDate, kstDayRangeUtc } from './time.ts';
import { AUDIO_MAX_BYTES, AUDIO_MIN_BYTES, isLikelySilence, type Transcriber, whisperTranscriber } from './transcribe.ts';
import {
	CompleteRequestSchema,
	CreateMemosRequestSchema,
	issuesToMessage,
	ListMemosQuerySchema,
	MemoIdSchema,
	ReorderRequestSchema,
} from './validation.ts';

export interface ApiBindings {
	DB: D1Database;
	AI?: Ai;
	RATE_LIMIT_PER_MINUTE?: string;
	DAILY_AI_LIMIT?: string;
}

export interface ApiDeps {
	runAgent: RunMemoAgent;
	transcribe?: Transcriber;
	now?: () => Date;
	newId?: () => string;
	agentTimeoutMs?: number;
}

type ApiContext = Context<{ Bindings: ApiBindings }>;

function fail(
	c: ApiContext,
	status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503 | 504,
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

/**
 * Cross-site protection for every state-changing route: requiring
 * application/json forces a CORS preflight (which this API never answers),
 * and a foreign Origin is rejected outright. Without this, another site could
 * make visitors' browsers spend the AI quota or change the shared board.
 */
function crossSiteBlock(c: ApiContext, expectsJsonBody: boolean) {
	if (expectsJsonBody && !/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
		return fail(c, 415, 'invalid_request', 'Content-Type은 application/json이어야 합니다.');
	}
	const origin = c.req.header('origin');
	if (origin && !isSameOrigin(origin, c.req.url)) {
		return fail(c, 403, 'forbidden_origin', '허용되지 않은 출처의 요청입니다.');
	}
	return null;
}

/** Voice: per client per minute, and for the whole app per UTC day (~47 Neurons/min each). */
const VOICE_PER_MINUTE = 6;
const VOICE_PER_DAY = 60;
const DAY_MS = 86_400_000;
const AUDIO_TYPE = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|wave|aac|x-m4a|m4a|flac)\b/i;

/** Board edits (reorder/complete/delete) per client per minute. */
const MUTATIONS_PER_MINUTE = 30;

async function mutationLimit(c: ApiContext, now: Date) {
	const client = await clientKey(c.req.header('cf-connecting-ip'));
	const decision = await consumeWindow(c.env.DB, `edit:${client}`, MUTATIONS_PER_MINUTE, 60_000, now);
	if (decision.allowed) return null;
	c.header('Retry-After', String(decision.retryAfterSeconds));
	return fail(c, 429, 'rate_limited', '변경 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.');
}

/** Parse a small JSON body; undefined when it is too large or not JSON. */
async function readJson(c: ApiContext): Promise<unknown> {
	const raw = await c.req.text();
	if (new TextEncoder().encode(raw).length > LIMITS.bodyBytesMax) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function dailyLimit(env: ApiBindings): number {
	return toPositiveInt(env.DAILY_AI_LIMIT, 150);
}

export function createApi(deps: ApiDeps) {
	const now = deps.now ?? (() => new Date());
	const newId = deps.newId ?? (() => crypto.randomUUID());
	const timeoutMs = deps.agentTimeoutMs ?? 90_000;
	const transcribe = deps.transcribe ?? whisperTranscriber;
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

	api.get('/agenda', async (c) => {
		try {
			const current = now();
			const today = kstDate(current);
			const [upcoming, overdue] = await Promise.all([
				listUpcoming(c.env.DB, current, today),
				listOverdue(c.env.DB, current, today),
			]);
			return c.json<AgendaResponse>(buildAgenda(upcoming, LIMITS.agendaMax, overdue));
		} catch (error) {
			console.error('agenda failed', describeError(error));
			return fail(c, 500, 'db_error', '다가오는 일정을 불러오지 못했습니다.');
		}
	});

	// Speech → text for the input box. The audio is not stored; the text is only
	// returned to the caller, who reviews it before anything is published.
	api.post('/transcribe', async (c) => {
		const contentType = c.req.header('content-type') ?? '';
		if (!AUDIO_TYPE.test(contentType)) {
			return fail(c, 415, 'invalid_request', '지원하지 않는 오디오 형식입니다.');
		}
		const blocked = crossSiteBlock(c, false);
		if (blocked) return blocked;
		if (Number(c.req.header('content-length') ?? '0') > AUDIO_MAX_BYTES) {
			return fail(c, 413, 'payload_too_large', '녹음이 너무 깁니다. 1분 이내로 녹음해 주세요.');
		}
		const audio = new Uint8Array(await c.req.arrayBuffer());
		if (audio.byteLength > AUDIO_MAX_BYTES) {
			return fail(c, 413, 'payload_too_large', '녹음이 너무 깁니다. 1분 이내로 녹음해 주세요.');
		}
		if (audio.byteLength < AUDIO_MIN_BYTES) {
			return fail(c, 422, 'empty_audio', '녹음된 소리가 거의 없어요. 조금 더 길게 말해 주세요.');
		}
		const current = now();
		try {
			const client = await clientKey(c.req.header('cf-connecting-ip'));
			const perClient = await consumeWindow(c.env.DB, `voice:${client}`, VOICE_PER_MINUTE, 60_000, current);
			const perDay = perClient.allowed
				? await consumeWindow(c.env.DB, 'voice:global', VOICE_PER_DAY, DAY_MS, current)
				: perClient;
			if (!perDay.allowed) {
				c.header('Retry-After', String(perDay.retryAfterSeconds));
				return perClient.allowed
					? fail(c, 429, 'daily_limit_reached', '오늘 음성 변환 한도에 도달했어요. 텍스트로 입력해 주세요.')
					: fail(c, 429, 'rate_limited', '음성 변환 요청이 너무 잦습니다. 1분 후 다시 시도해 주세요.');
			}
		} catch (error) {
			console.error('voice limit failed', describeError(error));
			return fail(c, 500, 'db_error', '저장소에 접근하지 못했습니다.');
		}
		if (!c.env.AI) return fail(c, 503, 'transcribe_failed', '음성 변환을 사용할 수 없습니다.');
		try {
			const startedAt = Date.now();
			const text = (await transcribe(c.env.AI, audio, contentType)).trim().slice(0, LIMITS.textMax);
			// Metadata only (no audio, no text) so failures can be diagnosed from `wrangler tail`.
			console.log('transcribe', JSON.stringify({ bytes: audio.byteLength, type: contentType, chars: text.length, ms: Date.now() - startedAt }));
			if (isLikelySilence(text)) {
				return fail(c, 422, 'empty_transcript', '음성을 알아듣지 못했어요. 마이크 가까이에서 다시 녹음하거나 텍스트로 입력해 주세요.');
			}
			return c.json({ text });
		} catch (error) {
			console.error('transcribe failed', JSON.stringify({ bytes: audio.byteLength, type: contentType }), describeError(error));
			const classified = classifyAgentError(error);
			if (classified.code === 'ai_quota_exceeded') return fail(c, 503, classified.code, classified.message);
			return fail(c, 502, 'transcribe_failed', '음성을 텍스트로 바꾸지 못했어요. 다시 녹음하거나 텍스트로 입력해 주세요.');
		}
	});

	// Drag & drop order of the priority list. Shared board: applies to every visitor.
	api.put('/agenda/order', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const body = await readJson(c);
		if (body === undefined) return fail(c, 400, 'invalid_request', 'JSON 형식이 올바르지 않습니다.');
		const parsed = v.safeParse(ReorderRequestSchema, body);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		try {
			const limited = await mutationLimit(c, now());
			if (limited) return limited;
			const updated = await saveManualOrder(c.env.DB, parsed.output.ids);
			if (updated === 0) return fail(c, 404, 'not_found', '정렬할 메모를 찾지 못했습니다.');
			return c.json({ updated });
		} catch (error) {
			console.error('reorder failed', describeError(error));
			return fail(c, 500, 'db_error', '순서를 저장하지 못했습니다.');
		}
	});

	// Done / not done. Shared board: applies to every visitor.
	api.patch('/memos/:id', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		if (!id.success) return fail(c, 400, 'invalid_request', issuesToMessage(id.issues));
		const body = await readJson(c);
		if (body === undefined) return fail(c, 400, 'invalid_request', 'JSON 형식이 올바르지 않습니다.');
		const parsed = v.safeParse(CompleteRequestSchema, body);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		try {
			const current = now();
			const limited = await mutationLimit(c, current);
			if (limited) return limited;
			const memo = await setCompleted(c.env.DB, id.output, parsed.output.completed, current);
			if (!memo) return fail(c, 404, 'not_found', '메모를 찾지 못했습니다.');
			return c.json({ memo });
		} catch (error) {
			console.error('complete failed', describeError(error));
			return fail(c, 500, 'db_error', '완료 상태를 저장하지 못했습니다.');
		}
	});

	// Remove an item from "지나버린 일". Soft delete, overdue + not-done only.
	// Shared board: the memo disappears for every visitor.
	api.delete('/memos/:id', async (c) => {
		const blocked = crossSiteBlock(c, false);
		if (blocked) return blocked;
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		if (!id.success) return fail(c, 400, 'invalid_request', issuesToMessage(id.issues));
		try {
			const current = now();
			const limited = await mutationLimit(c, current);
			if (limited) return limited;
			const result = await deleteOverdueMemo(c.env.DB, id.output, current, kstDate(current));
			if (result === 'not_found') return fail(c, 404, 'not_found', '메모를 찾지 못했습니다.');
			if (result === 'not_overdue') {
				return fail(c, 409, 'conflict', '기한이 지났고 완료되지 않은 메모만 삭제할 수 있습니다.');
			}
			return c.json({ deleted: id.output });
		} catch (error) {
			console.error('delete failed', describeError(error));
			return fail(c, 500, 'db_error', '삭제하지 못했습니다.');
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
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;

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

		// Public board: refuse obvious personal/secret data before it is stored or sent to the AI.
		const sensitive = detectSensitive(`${input.nickname}\n${input.text}`);
		if (sensitive.length > 0) {
			return fail(
				c,
				400,
				'sensitive_info',
				`모든 방문자에게 공개되는 메모라 ${describeSensitive(sensitive)}로 보이는 내용은 저장할 수 없어요. 해당 부분을 지우고 다시 시도해 주세요.`,
			);
		}

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
			return fail(
				c,
				502,
				'not_saved',
				'메모로 정리할 내용을 찾지 못했어요. 할 일·일정·떠오른 생각을 한두 문장으로 적어 다시 시도해 주세요. 입력한 글은 그대로 남아 있습니다.',
			);
		}
		return c.json<CreateMemosResponse>({ duplicate: false, source: saved.source, memos: saved.memos }, 201);
	});

	return api;
}
