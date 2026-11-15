import { Hono, type Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import * as v from 'valibot';
import type {
	AgendaResponse,
	CalendarResponse,
	ApiError,
	ApiErrorCode,
	CreateMemosDraftResponse,
	CreateMemosResponse,
	ListMemosResponse,
	Memo,
	MemoProgressEvent,
	MemoStreamError,
	SettingsResponse,
	UsageResponse,
} from '../shared/types.ts';
import { LIMITS } from '../shared/types.ts';
import type { CancelMemoAgent, RunMemoAgent } from './agent-runner.ts';
import { buildAgenda } from './agenda.ts';
import {
	deleteOverdueMemo,
	findSourceByRequestId,
	listMemos,
	getMemo,
	listCalendar,
	listIdeas,
	listRepeating,
	memoForRemoval,
	restoreMemo,
	softDeleteMemo,
	setOccurrenceDone,
	saveSourceWithMemos,
	setRecurrence,
	listOverdue,
	updateMemo,
	listUpcoming,
	saveManualOrder,
	setCompleted,
} from './db.ts';
import {
	addVoiceSeconds,
	clientKey,
	consumeAiQuota,
	consumeWindow,
	estimateMemoNeurons,
	readUsage,
	recordActualNeurons,
	voiceSecondsUsed,
} from './rate-limit.ts';
import { describeSensitive, detectSensitive } from '../shared/privacy.ts';
import type { AuthEnv } from './auth/providers.ts';
import { linkedProviders } from './auth/store.ts';
import {
	autoScheduleRecommended,
	followDeadline,
	syncReminderAfterEdit,
	cancelReminder,
	getReminderDefaults,
	setReminder,
	setReminderDefaults,
} from './notify/reminders.ts';
import { type Channel, CHANNELS, channelStatuses, getReminderTone, sendTonePreview, setChannel, setDisplayName, setReminderTone, type SettingsEnv } from './settings.ts';
import { type AuthVariables, registerAuthRoutes, resolveAuth } from './auth/routes.ts';
import { sha256Hex } from './auth/crypto.ts';
import { kstDate, kstDayRangeUtc } from './time.ts';
import { expand, isOccurrence, loadDone, occurrenceAt, withUpcoming } from './occurrences.ts';
import { cancelDraft, claimDraft, draftPayload, getDraft, openDraftForRequest, setDraftStatus } from './drafts.ts';
import { applyAnswers } from '../shared/clarify.ts';
import { nextOccurrence, type Recurrence, type Weekday } from '../shared/recurrence.ts';
import {
	AUDIO_MAX_BYTES,
	AUDIO_MAX_SECONDS,
	AUDIO_MIN_BYTES,
	billableSeconds,
	isLikelySilence,
	type Transcriber,
	whisperTranscriber,
} from './transcribe.ts';
import {
	CompleteRequestSchema,
	EditMemoSchema,
	OccurrenceDateSchema,
	OccurrenceDoneSchema,
	RecurrenceChoiceSchema,
	CancelMemosRequestSchema,
	DraftCommitSchema,
	CreateMemosRequestSchema,
	issuesToMessage,
	ListMemosQuerySchema,
	MemoIdSchema,
	ReorderRequestSchema,
	ChannelToggleSchema,
	DisplayNameSchema,
	ReminderDefaultsSchema,
	ReminderToneSchema,
	ReminderRequestSchema,
} from './validation.ts';

export interface ApiBindings extends AuthEnv, SettingsEnv {
	DB: D1Database;
	AI?: Ai;
	RATE_LIMIT_PER_MINUTE?: string;
	DAILY_AI_LIMIT?: string;
	DAILY_AI_NEURONS?: string;
}

export interface ApiDeps {
	runAgent: RunMemoAgent;
	/** Stops a running agent for "취소" (production: cancelMemoAgent). */
	cancelAgent?: CancelMemoAgent;
	transcribe?: Transcriber;
	now?: () => Date;
	newId?: () => string;
	agentTimeoutMs?: number;
	/** Used for OAuth token/profile requests; injectable for tests. */
	fetchFn?: typeof fetch;
}

type ApiEnv = { Bindings: ApiBindings; Variables: AuthVariables };
type ApiContext = Context<ApiEnv>;

function fail(
	c: ApiContext,
	status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 502 | 503 | 504,
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
/** Whole-app voice budget per UTC day: 30 audio minutes ≈ 1,400 Neurons. */
export const VOICE_SECONDS_PER_DAY = 30 * 60;
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

/** Estimated Neurons per UTC day for memo organizing (voice has its own 30-minute budget). */
function neuronBudget(env: ApiBindings): number {
	return toPositiveInt(env.DAILY_AI_NEURONS, 6000);
}

export function createApi(deps: ApiDeps) {
	const now = deps.now ?? (() => new Date());
	const newId = deps.newId ?? (() => crypto.randomUUID());
	// Long inputs (10+ memos) took ~100 s in measurements; give the agent room so a
	// run we already paid for is not thrown away at the deadline.
	const timeoutMs = deps.agentTimeoutMs ?? 150_000;
	const transcribe = deps.transcribe ?? whisperTranscriber;
	const api = new Hono<ApiEnv>();

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

	// Identity and workspace come only from the server-side session cookie.
	const fetchFn: typeof fetch = deps.fetchFn ?? ((input, init) => fetch(input, init));
	api.use(resolveAuth(now));
	registerAuthRoutes(api, { now, fetchFn });

	api.get('/health', (c) => c.json({ ok: true }));

	api.get('/usage', async (c) => {
		try {
			const usage = await readUsage(c.env.DB, dailyLimit(c.env), now(), VOICE_SECONDS_PER_DAY, neuronBudget(c.env));
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
			const [upcoming, overdue, ideas, repeating] = await Promise.all([
				listUpcoming(c.env.DB, c.get('auth').workspace.id, current, today),
				listOverdue(c.env.DB, c.get('auth').workspace.id, current, today),
				listIdeas(c.env.DB, c.get('auth').workspace.id, LIMITS.agendaMax),
				listRepeating(c.env.DB, c.get('auth').workspace.id),
			]);
			// Each repeating memo joins the upcoming lists once, as its next not-done occurrence.
			const next = (await withUpcoming(c.env.DB, repeating.filter((m) => !m.completed_at), current)).filter((m) => m.occurrence);
			return c.json<AgendaResponse>({ ...buildAgenda([...upcoming, ...next], LIMITS.agendaMax, overdue), ideas: await withUpcoming(c.env.DB, ideas, current) });
		} catch (error) {
			console.error('agenda failed', describeError(error));
			return fail(c, 500, 'db_error', '다가오는 일정을 불러오지 못했습니다.');
		}
	});

	// Calendar: the same memo rows, by their KST deadline/schedule day. No AI, no extra table.
	api.get('/calendar', async (c) => {
		const month = c.req.query('month') ?? kstDate(now()).slice(0, 7);
		const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
		if (!m || Number(m[1]) < 2000 || Number(m[1]) > 2100) return fail(c, 400, 'invalid_request', '월은 YYYY-MM 형식이어야 합니다.');
		const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate(); // calendar math, no time zone involved
		const from = `${month}-01`;
		const to = `${month}-${String(last).padStart(2, '0')}`;
		try {
			const workspaceId = c.get('auth').workspace.id;
			const [single, repeating] = await Promise.all([listCalendar(c.env.DB, workspaceId, from, to), listRepeating(c.env.DB, workspaceId)]);
			// Repeating memos: one entry per occurrence in this month (a stopped series ends on the day it was stopped).
			const done = await loadDone(c.env.DB, repeating.map((m) => m.id), from, to);
			const occurrences = repeating.flatMap((m) => {
				const end = m.completed_at && kstDate(new Date(m.completed_at)) < to ? kstDate(new Date(m.completed_at)) : to;
				return expand(m, from, end, done.get(m.id));
			});
			const dayOf = (m: Memo) => m.occurrence?.date ?? m.due_date ?? '';
			const timeOf = (m: Memo) => (m.occurrence ? m.occurrence.at : m.due_at);
			const memos = [...single, ...occurrences].sort(
				(a, b) => dayOf(a).localeCompare(dayOf(b)) || (timeOf(a) ? 1 : 0) - (timeOf(b) ? 1 : 0) || (timeOf(a) ?? '').localeCompare(timeOf(b) ?? ''),
			);
			return c.json<CalendarResponse>({ month, from, to, memos });
		} catch (error) {
			console.error('calendar failed', describeError(error));
			return fail(c, 500, 'db_error', '캘린더를 불러오지 못했습니다.');
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
			if (!perClient.allowed) {
				c.header('Retry-After', String(perClient.retryAfterSeconds));
				return fail(c, 429, 'rate_limited', '음성 변환 요청이 너무 잦습니다. 1분 후 다시 시도해 주세요.');
			}
			if ((await voiceSecondsUsed(c.env.DB, current)) >= VOICE_SECONDS_PER_DAY) {
				return fail(c, 429, 'daily_limit_reached', '오늘 음성 변환 한도(30분)를 다 썼어요. 텍스트로 입력해 주세요.');
			}
		} catch (error) {
			console.error('voice limit failed', describeError(error));
			return fail(c, 500, 'db_error', '저장소에 접근하지 못했습니다.');
		}
		if (!c.env.AI) return fail(c, 503, 'transcribe_failed', '음성 변환을 사용할 수 없습니다.');
		try {
			const startedAt = Date.now();
			const result = await transcribe(c.env.AI, audio, contentType);
			const seconds = billableSeconds(result, audio.byteLength);
			// Count what the model processed (and is billed) before deciding anything else.
			await addVoiceSeconds(c.env.DB, seconds, current).catch((error) => console.error('voice seconds failed', describeError(error)));
			const text = result.text.trim().slice(0, LIMITS.textMax);
			// Metadata only (no audio, no text) so failures can be diagnosed from `wrangler tail`.
			console.log('transcribe', JSON.stringify({ bytes: audio.byteLength, type: contentType, seconds, chars: text.length, ms: Date.now() - startedAt }));
			if (seconds > AUDIO_MAX_SECONDS) {
				return fail(c, 413, 'payload_too_large', '녹음이 너무 깁니다. 1분 이내로 녹음해 주세요.');
			}
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

	// ---- Personal settings (signed-in users only) -----------------------------------------
	api.get('/settings', async (c) => {
		const { user } = c.get('auth');
		if (!user) return fail(c, 401, 'login_required', '로그인이 필요합니다.');
		const linked = await linkedProviders(c.env.DB, user.userId);
		return c.json<SettingsResponse>({
			displayName: user.displayName,
			timezone: 'Asia/Seoul',
			linked,
			notifications: await channelStatuses(c.env.DB, c.env, user.userId, linked, fetchFn),
			reminderDefaults: await getReminderDefaults(c.env.DB, user.userId),
			reminderTone: await getReminderTone(c.env.DB, user.userId),
		});
	});

	// Discord reminder wording: one of four fixed templates (no AI).
	api.patch('/settings/tone', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const { user } = c.get('auth');
		if (!user) return fail(c, 401, 'login_required', '로그인이 필요합니다.');
		const parsed = v.safeParse(ReminderToneSchema, (await readJson(c)) ?? null);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const limited = await mutationLimit(c, now());
		if (limited) return limited;
		await setReminderTone(c.env.DB, user.userId, parsed.output.tone);
		return c.json({ reminderTone: parsed.output.tone });
	});

	// Send one example card in the saved tone (to see the real DM). Rate limited like other changes.
	api.post('/settings/notifications/discord/preview', async (c) => {
		const blocked = crossSiteBlock(c, false);
		if (blocked) return blocked;
		const { user } = c.get('auth');
		if (!user) return fail(c, 401, 'login_required', '로그인이 필요합니다.');
		const limited = await mutationLimit(c, now());
		if (limited) return limited;
		const result = await sendTonePreview(c.env.DB, c.env, user.userId, now(), fetchFn);
		if (!result.ok) return fail(c, 409, result.code === 'channel_off' ? 'channel_off' : 'test_failed', result.message);
		return c.json({ sent: true });
	});

	api.patch('/settings/reminders', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const { user } = c.get('auth');
		if (!user) return fail(c, 401, 'login_required', '로그인이 필요합니다.');
		const parsed = v.safeParse(ReminderDefaultsSchema, (await readJson(c)) ?? null);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const limited = await mutationLimit(c, now());
		if (limited) return limited;
		await setReminderDefaults(c.env.DB, user.userId, parsed.output);
		// New defaults apply to recommended memos that have no reminder yet.
		const scheduled = await autoScheduleRecommended(c.env.DB, { userId: user.userId, workspaceId: user.workspace.id }, now());
		return c.json({ reminderDefaults: parsed.output, scheduled });
	});

	api.patch('/settings/profile', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const { user } = c.get('auth');
		if (!user) return fail(c, 401, 'login_required', '로그인이 필요합니다.');
		const body = await readJson(c);
		if (body === undefined) return fail(c, 400, 'invalid_request', 'JSON 형식이 올바르지 않습니다.');
		const parsed = v.safeParse(DisplayNameSchema, body);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const limited = await mutationLimit(c, now());
		if (limited) return limited;
		await setDisplayName(c.env.DB, user.userId, user.workspace.id, parsed.output.displayName);
		return c.json({ displayName: parsed.output.displayName });
	});

	api.put('/settings/notifications/:channel', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const { user } = c.get('auth');
		if (!user) return fail(c, 401, 'login_required', '로그인이 필요합니다.');
		const channel = c.req.param('channel');
		if (!(CHANNELS as readonly string[]).includes(channel)) return fail(c, 404, 'not_found', '알 수 없는 알림 경로입니다.');
		const body = await readJson(c);
		const parsed = v.safeParse(ChannelToggleSchema, body ?? null);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const limited = await mutationLimit(c, now());
		if (limited) return limited;
		const result = await setChannel(c.env.DB, c.env, user.userId, channel as Channel, parsed.output.enabled, now(), fetchFn);
		const status = (await channelStatuses(c.env.DB, c.env, user.userId, undefined, fetchFn)).find((s) => s.channel === channel)!;
		if (!result.ok) return c.json({ error: result.code === 'unavailable' ? 'channel_unavailable' : 'test_failed', message: result.message, status }, 409);
		const scheduled =
			channel === 'discord' && parsed.output.enabled
				? await autoScheduleRecommended(c.env.DB, { userId: user.userId, workspaceId: user.workspace.id }, now())
				: 0;
		return c.json({ status, scheduled });
	});

	// ---- Reminders (personal memos, Discord DM) -------------------------------------------
	api.put('/memos/:id/reminder', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const { user } = c.get('auth');
		if (!user) return fail(c, 401, 'login_required', '로그인한 개인 공간에서만 알림을 받을 수 있어요.');
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		if (!id.success) return fail(c, 400, 'invalid_request', issuesToMessage(id.issues));
		const parsed = v.safeParse(ReminderRequestSchema, (await readJson(c)) ?? null);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const limited = await mutationLimit(c, now());
		if (limited) return limited;
		const result = await setReminder(
			c.env.DB,
			{ userId: user.userId, workspaceId: user.workspace.id, memoId: id.output, ...parsed.output },
			now(),
		);
		if (!result.ok) return c.json<ApiError>({ error: result.code as ApiErrorCode, message: result.message }, result.status);
		return c.json({ scheduledAt: result.scheduledAt });
	});

	api.delete('/memos/:id/reminder', async (c) => {
		const blocked = crossSiteBlock(c, false);
		if (blocked) return blocked;
		const { user } = c.get('auth');
		if (!user) return fail(c, 401, 'login_required', '로그인이 필요합니다.');
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		if (!id.success) return fail(c, 400, 'invalid_request', issuesToMessage(id.issues));
		const canceled = await cancelReminder(c.env.DB, user.userId, id.output, now());
		return canceled ? c.json({ canceled: true }) : fail(c, 404, 'not_found', '예약된 알림이 없어요.');
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
			const updated = await saveManualOrder(c.env.DB, c.get('auth').workspace.id, parsed.output.ids);
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
			const memo = await setCompleted(c.env.DB, c.get('auth').workspace.id, id.output, parsed.output.completed, current);
			if (!memo) return fail(c, 404, 'not_found', '메모를 찾지 못했습니다.');
			return c.json({ memo: (await withUpcoming(c.env.DB, [memo], current))[0] });
		} catch (error) {
			console.error('complete failed', describeError(error));
			return fail(c, 500, 'db_error', '완료 상태를 저장하지 못했습니다.');
		}
	});

	// A person correcting an organized memo (title, content, category, priority, deadline).
	// Shared board: like done/order/delete, the change is visible to every visitor.
	api.put('/memos/:id', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		if (!id.success) return fail(c, 400, 'invalid_request', issuesToMessage(id.issues));
		const body = await readJson(c);
		if (body === undefined) return fail(c, 400, 'invalid_request', 'JSON 형식이 올바르지 않습니다.');
		const parsed = v.safeParse(EditMemoSchema, body);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const input = parsed.output;
		const { workspace } = c.get('auth');
		// Same rule as new input: the public board refuses personal/secret data.
		const sensitive = workspace.kind === 'shared_guest' ? detectSensitive(`${input.title}\n${input.content}`) : [];
		if (sensitive.length > 0) {
			return fail(c, 400, 'sensitive_info', `모든 방문자에게 공개되는 메모라 ${describeSensitive(sensitive)}로 보이는 내용은 저장할 수 없어요.`);
		}
		try {
			const current = now();
			const limited = await mutationLimit(c, current);
			if (limited) return limited;
			const dueAt = input.dueDate && input.dueTime ? new Date(`${input.dueDate}T${input.dueTime}:00+09:00`).toISOString() : null;
			const result = await updateMemo(c.env.DB, workspace.id, id.output, {
				title: input.title,
				content: input.content,
				category: input.category,
				priority: input.priority,
				due_at: dueAt,
				due_date: input.dueDate,
			});
			if (!result) return fail(c, 404, 'not_found', '메모를 찾지 못했습니다.');
			let repeatChanged = false;
			if (input.repeat !== undefined) {
				// A repeat chosen in the form starts on the edited date; the first occurrence becomes due_at/due_date.
				const rule = input.repeat && input.dueDate ? ruleFromForm(input.repeat, input.dueDate) : null;
				const first = rule ? nextOccurrence(rule, input.dueDate!) : null;
				const startRule = rule && first && rule.kind !== 'dates' ? { ...rule, start: first } : rule;
				await setRecurrence(
					c.env.DB,
					workspace.id,
					id.output,
					startRule,
					first ? { due_date: first, due_at: input.dueTime ? new Date(`${first}T${input.dueTime}:00+09:00`).toISOString() : null } : null,
				);
				repeatChanged = JSON.stringify(startRule) !== JSON.stringify(result.memo.recurrence);
			}
			if (result.dueChanged || repeatChanged) await syncReminderAfterEdit(c.env.DB, id.output, workspace.id, current);
			// Re-read so the card shows the stored rule, the next occurrence and the rescheduled reminder.
			const fresh = (await getMemo(c.env.DB, workspace.id, id.output)) ?? result.memo;
			return c.json({ memo: (await withUpcoming(c.env.DB, [fresh], current))[0] });
		} catch (error) {
			console.error('edit failed', describeError(error));
			return fail(c, 500, 'db_error', '메모를 저장하지 못했습니다.');
		}
	});

	// Check or uncheck ONE occurrence of a repeating memo (the series and other days are untouched).
	api.patch('/memos/:id/occurrences/:date', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		const day = v.safeParse(OccurrenceDateSchema, c.req.param('date'));
		if (!id.success || !day.success) return fail(c, 400, 'invalid_request', '메모 또는 날짜 형식이 올바르지 않습니다.');
		const parsed = v.safeParse(OccurrenceDoneSchema, (await readJson(c)) ?? null);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const memo = await getMemo(c.env.DB, c.get('auth').workspace.id, id.output);
		if (!memo) return fail(c, 404, 'not_found', '메모를 찾지 못했습니다.');
		if (!memo.recurrence || !isOccurrence(memo.recurrence, day.output)) return fail(c, 404, 'not_found', '이 날짜는 반복 일정의 회차가 아니에요.');
		const current = now();
		const limited = await mutationLimit(c, current);
		if (limited) return limited;
		const completedAt = await setOccurrenceDone(c.env.DB, memo.id, day.output, parsed.output.completed, current);
		return c.json({ occurrence: { date: day.output, at: occurrenceAt(memo, day.output), completed_at: completedAt } });
	});

	// Answer the "매주 반복인가요?" question for unclear wording ("월수금", "평일", "주말").
	api.post('/memos/:id/recurrence', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		if (!id.success) return fail(c, 400, 'invalid_request', issuesToMessage(id.issues));
		const parsed = v.safeParse(RecurrenceChoiceSchema, (await readJson(c)) ?? null);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const { workspace } = c.get('auth');
		const memo = await getMemo(c.env.DB, workspace.id, id.output);
		if (!memo) return fail(c, 404, 'not_found', '메모를 찾지 못했습니다.');
		if (!memo.recurrence_question) return fail(c, 409, 'conflict', '이미 정해진 메모예요.');
		const current = now();
		const limited = await mutationLimit(c, current);
		if (limited) return limited;
		const rule = parsed.output.choice === 'repeat' ? memo.recurrence_question.repeat : memo.recurrence_question.once;
		const first = nextOccurrence(rule, kstDate(current)) ?? (rule.kind === 'dates' ? rule.dates[0] : rule.start);
		await setRecurrence(c.env.DB, workspace.id, memo.id, rule, { due_date: first, due_at: occurrenceAt(memo, first) });
		await syncReminderAfterEdit(c.env.DB, memo.id, workspace.id, current);
		const fresh = (await getMemo(c.env.DB, workspace.id, memo.id)) ?? memo;
		return c.json({ memo: (await withUpcoming(c.env.DB, [fresh], current))[0] });
	});

	// Remove an item from "지나버린 일". Soft delete, overdue + not-done only.
	// Shared board: the memo disappears for every visitor.
	// Delete (hide) a memo.
	// - Personal space: any of the owner's memos.
	// - Public board: memos written from this browser (author key hash matches); anyone else's
	//   memo only once it is overdue and not done (unchanged rule, so the board cannot be emptied).
	api.delete('/memos/:id', async (c) => {
		const blocked = crossSiteBlock(c, false);
		if (blocked) return blocked;
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		if (!id.success) return fail(c, 400, 'invalid_request', issuesToMessage(id.issues));
		try {
			const current = now();
			const limited = await mutationLimit(c, current);
			if (limited) return limited;
			const { workspace } = c.get('auth');
			const memo = await memoForRemoval(c.env.DB, workspace.id, id.output);
			if (!memo || memo.deleted_at) return fail(c, 404, 'not_found', '메모를 찾지 못했습니다.');
			const mine = !!memo.author_key_hash && memo.author_key_hash === (await authorKeyHash(c));
			if (workspace.kind === 'personal' || mine) {
				await softDeleteMemo(c.env.DB, workspace.id, id.output, current);
				return c.json({ deleted: id.output });
			}
			const result = await deleteOverdueMemo(c.env.DB, workspace.id, id.output, current, kstDate(current));
			if (result === 'not_found') return fail(c, 404, 'not_found', '메모를 찾지 못했습니다.');
			if (result === 'not_overdue') {
				return fail(c, 409, 'conflict', '공개 공간에서는 내가 쓴 메모, 또는 기한이 지났고 완료되지 않은 메모만 삭제할 수 있어요.');
			}
			await softDeleteMemo(c.env.DB, workspace.id, id.output, current); // already hidden; also stops its reminders
			return c.json({ deleted: id.output });
		} catch (error) {
			console.error('delete failed', describeError(error));
			return fail(c, 500, 'db_error', '삭제하지 못했습니다.');
		}
	});

	// Undo a delete ("되돌리기"): the owner of a personal space, the author on the public board,
	// or anyone within 10 minutes on the public board (undoing a hide only brings a memo back).
	api.post('/memos/:id/restore', async (c) => {
		const blocked = crossSiteBlock(c, false);
		if (blocked) return blocked;
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		if (!id.success) return fail(c, 400, 'invalid_request', issuesToMessage(id.issues));
		const current = now();
		const limited = await mutationLimit(c, current);
		if (limited) return limited;
		const { workspace } = c.get('auth');
		const memo = await memoForRemoval(c.env.DB, workspace.id, id.output);
		if (!memo?.deleted_at) return fail(c, 404, 'not_found', '되돌릴 메모가 없어요.');
		const mine = !!memo.author_key_hash && memo.author_key_hash === (await authorKeyHash(c));
		const recent = current.getTime() - Date.parse(memo.deleted_at) <= 10 * 60_000;
		if (!(workspace.kind === 'personal' || mine || recent)) return fail(c, 409, 'conflict', '되돌릴 수 있는 시간이 지났어요.');
		await restoreMemo(c.env.DB, workspace.id, id.output);
		const fresh = await getMemo(c.env.DB, workspace.id, id.output);
		return c.json({ memo: fresh ? (await withUpcoming(c.env.DB, [fresh], current))[0] : null });
	});

	api.get('/memos', async (c) => {
		const parsed = v.safeParse(ListMemosQuerySchema, c.req.query());
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const q = parsed.output;
		try {
			const result = await listMemos(c.env.DB, {
				workspaceId: c.get('auth').workspace.id,
				range: q.scope === 'today' ? kstDayRangeUtc(now()) : undefined,
				category: q.category,
				nickname: q.nickname || undefined,
				cursor: q.cursor,
				limit: q.limit,
			});
			// Repeating memos show their next occurrence (computed, no AI).
			return c.json<ListMemosResponse>({ ...result, memos: await withUpcoming(c.env.DB, result.memos, now()) });
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

		// Same work either way; the event stream only adds live progress (sent when each step happens).
		if (!/\btext\/event-stream\b/i.test(c.req.header('accept') ?? '')) {
			const outcome = await organizeMemos(c, body);
			if (outcome.ok) return c.json(outcome.body, outcome.status);
			if (outcome.retryAfterSeconds) c.header('Retry-After', String(outcome.retryAfterSeconds));
			return fail(c, outcome.status as Parameters<typeof fail>[1], outcome.error, outcome.message);
		}
		return streamSSE(c, async (stream) => {
			const cancel = new AbortController();
			// Closing the stream (the person left) stops the AI work, when the runtime reports it.
			// The cancel button does not rely on this: it calls POST /api/memos/cancel.
			stream.onAbort(() => cancel.abort());
			c.req.raw.signal?.addEventListener('abort', () => cancel.abort());
			// Keep events in order without making the work wait on the network.
			let queue = Promise.resolve();
			const send = (event: 'progress' | 'done' | 'draft' | 'error', data: unknown) => {
				queue = queue.then(() => (cancel.signal.aborted ? undefined : stream.writeSSE({ event, data: JSON.stringify(data) }))).catch(() => {});
				return queue;
			};
			void send('progress', { stage: 'checking' } satisfies MemoProgressEvent);
			const outcome = await organizeMemos(c, body, (event) => void send('progress', event), cancel.signal).catch((error): OrganizeOutcome => {
				console.error('memo stream failed', describeError(error));
				return { ok: false, status: 500, error: 'agent_failed', message: 'AI가 메모를 정리하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
			});
			if (outcome.ok) await send(outcome.status === 202 ? 'draft' : 'done', outcome.body);
			else await send('error', { error: outcome.error, message: outcome.message, status: outcome.status, retryAfterSeconds: outcome.retryAfterSeconds } satisfies MemoStreamError);
		});
	});

	// "취소" while the AI is working: stop that request's agent before it can save.
	api.post('/memos/cancel', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const parsed = v.safeParse(CancelMemosRequestSchema, (await readJson(c)) ?? null);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const limited = await mutationLimit(c, now());
		if (limited) return limited;
		const { workspace } = c.get('auth');
		const { requestId } = parsed.output;
		// Already saved (finished first): nothing to stop; the retry returns that result.
		if (await findSourceByRequestId(c.env.DB, workspace.id, requestId).catch(() => null)) {
			return c.json({ cancelled: false, saved: true });
		}
		// Only a run that is in progress right now, in this space. Never touches (or creates) any other agent instance.
		const running = await c.env.DB.prepare('SELECT 1 AS ok FROM memo_runs WHERE request_id = ? AND workspace_id = ? AND started_at >= ?')
			.bind(requestId, workspace.id, new Date(now().getTime() - timeoutMs - 60_000).toISOString())
			.first<{ ok: number }>()
			.catch(() => null);
		if (!running) return fail(c, 404, 'not_found', '진행 중인 정리 요청이 없어요.');
		const cancelled = await (deps.cancelAgent ?? (async () => false))(requestId);
		return c.json({ cancelled, saved: false });
	});

	// ---- Clarifying questions: confirm or discard a draft (answers are applied by rules, no AI) ----
	api.get('/memo-drafts/:id', async (c) => {
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		if (!id.success) return fail(c, 400, 'invalid_request', issuesToMessage(id.issues));
		const draft = await getDraft(c.env.DB, c.get('auth').workspace.id, id.output);
		if (!draft) return fail(c, 404, 'not_found', '확인할 메모가 없어요.');
		if (draft.status !== 'open' || Date.parse(draft.expiresAt) <= now().getTime()) {
			return fail(c, 410, 'draft_closed', draft.status === 'committed' ? '이미 저장된 메모예요.' : '확인 시간이 지났어요. 입력한 글로 다시 정리해 주세요.');
		}
		return c.json({ draft: draftPayload(draft) });
	});

	// Save once: answers so far (skipped or unasked questions stay undecided). Retries return the same result.
	api.post('/memo-drafts/:id/commit', async (c) => {
		const blocked = crossSiteBlock(c, true);
		if (blocked) return blocked;
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		if (!id.success) return fail(c, 400, 'invalid_request', issuesToMessage(id.issues));
		const parsed = v.safeParse(DraftCommitSchema, (await readJson(c)) ?? null);
		if (!parsed.success) return fail(c, 400, 'invalid_request', issuesToMessage(parsed.issues));
		const current = now();
		const limited = await mutationLimit(c, current);
		if (limited) return limited;
		const { workspace, user } = c.get('auth');
		const db = c.env.DB;
		const draft = await getDraft(db, workspace.id, id.output);
		if (!draft) return fail(c, 404, 'not_found', '확인할 메모가 없어요.');
		const savedBefore = await findSourceByRequestId(db, workspace.id, draft.requestId).catch(() => null);
		if (savedBefore) return c.json<CreateMemosResponse>({ duplicate: true, source: savedBefore.source, memos: await withUpcoming(db, savedBefore.memos, current) });
		if (!(await claimDraft(db, workspace.id, draft.id, current))) {
			return fail(c, 410, 'draft_closed', draft.status === 'cancelled' ? '취소한 메모예요.' : '확인 시간이 지났어요. 입력한 글로 다시 정리해 주세요.');
		}
		try {
			const memos = applyAnswers(draft.memos, draft.questions, parsed.output.answers, current);
			await saveSourceWithMemos(
				db,
				{
					id: draft.source.sourceId,
					workspace_id: workspace.id,
					nickname: draft.source.nickname,
					raw_text: draft.source.rawText,
					request_id: draft.requestId,
					created_at: draft.source.createdAt,
					author_key_hash: draft.source.authorKeyHash,
				},
				memos.map((m) => ({ ...m })),
			);
			await setDraftStatus(db, draft.id, 'committed');
		} catch (error) {
			await setDraftStatus(db, draft.id, 'open').catch(() => undefined);
			console.error('draft commit failed', describeError(error));
			return fail(c, 500, 'db_error', '저장하지 못했어요. 다시 시도해 주세요.');
		}
		const saved = await findSourceByRequestId(db, workspace.id, draft.requestId);
		if (!saved) return fail(c, 500, 'db_error', '저장하지 못했어요. 다시 시도해 주세요.');
		// Reminders and the calendar only ever see the confirmed memos.
		if (user) await autoScheduleRecommended(db, { userId: user.userId, workspaceId: workspace.id }, current).catch(() => 0);
		const fresh = (await findSourceByRequestId(db, workspace.id, draft.requestId)) ?? saved;
		return c.json<CreateMemosResponse>({ duplicate: false, source: fresh.source, memos: await withUpcoming(db, fresh.memos, current) }, 201);
	});

	api.delete('/memo-drafts/:id', async (c) => {
		const blocked = crossSiteBlock(c, false);
		if (blocked) return blocked;
		const id = v.safeParse(MemoIdSchema, c.req.param('id'));
		if (!id.success) return fail(c, 400, 'invalid_request', issuesToMessage(id.issues));
		const limited = await mutationLimit(c, now());
		if (limited) return limited;
		const cancelled = await cancelDraft(c.env.DB, c.get('auth').workspace.id, id.output);
		return cancelled ? c.json({ cancelled: true }) : fail(c, 404, 'not_found', '취소할 메모가 없어요.');
	});

	type OrganizeOutcome =
		| { ok: true; status: 200 | 201; body: CreateMemosResponse }
		/** Some details need the person's answer: a draft, nothing saved yet. */
		| { ok: true; status: 202; body: CreateMemosDraftResponse }
		| { ok: false; status: number; error: ApiErrorCode; message: string; retryAfterSeconds?: number };

	/** Validate → limits → Flue agent → save_memos → stored result. Shared by the JSON and the streaming response. */
	async function organizeMemos(
		c: ApiContext,
		body: unknown,
		onProgress?: (event: MemoProgressEvent) => void,
		signal?: AbortSignal,
	): Promise<OrganizeOutcome> {
		const failure = (status: number, error: ApiErrorCode, message: string, retryAfterSeconds?: number): OrganizeOutcome => ({
			ok: false,
			status,
			error,
			message,
			retryAfterSeconds,
		});
		const parsed = v.safeParse(CreateMemosRequestSchema, body);
		if (!parsed.success) return failure(400, 'invalid_request', issuesToMessage(parsed.issues));
		const input = parsed.output;
		const db = c.env.DB;
		const { user, workspace } = c.get('auth');
		// Signed-in: the author is the account, not whatever the client typed.
		const nickname = user ? user.displayName : input.nickname;
		/** Personal space: AI-recommended reminders are scheduled automatically (user can turn them off). */
		const afterSave = async (saved: NonNullable<Awaited<ReturnType<typeof findSourceByRequestId>>>) => {
			if (!user) return saved;
			const added = await autoScheduleRecommended(db, { userId: user.userId, workspaceId: workspace.id }, now()).catch((error) => {
				console.error('auto reminders failed', describeError(error));
				return 0;
			});
			return added > 0 ? ((await findSourceByRequestId(db, workspace.id, input.requestId).catch(() => null)) ?? saved) : saved;
		};

		// Shared guest board is public: refuse obvious personal/secret data before it is
		// stored or sent to the AI. A personal workspace is visible only to its owner.
		const sensitive = workspace.kind === 'shared_guest' ? detectSensitive(`${nickname}\n${input.text}`) : [];
		if (sensitive.length > 0) {
			return failure(
				400,
				'sensitive_info',
				`모든 방문자에게 공개되는 메모라 ${describeSensitive(sensitive)}로 보이는 내용은 저장할 수 없어요. 해당 부분을 지우고 다시 시도해 주세요.`,
			);
		}

		try {
			// Idempotency: a retried request returns the stored result without another AI call.
			const existing = await findSourceByRequestId(db, workspace.id, input.requestId);
			if (existing) return { ok: true, status: 200, body: { duplicate: true, source: existing.source, memos: existing.memos } };
			// Same request already waiting for answers (retry, reconnect, double click): no second AI call.
			const waiting = await openDraftForRequest(db, workspace.id, input.requestId, now());
			if (waiting) return { ok: true, status: 202, body: { draft: draftPayload(waiting) } };
			// Cancelled while checking: stop before spending any AI quota.
			if (signal?.aborted) return failure(499, 'cancelled', '메모 정리를 취소했어요.');

			const decision = await consumeAiQuota(
				db,
				await clientKey(c.req.header('cf-connecting-ip')),
				{
					perMinute: toPositiveInt(c.env.RATE_LIMIT_PER_MINUTE, 5),
					perDay: dailyLimit(c.env),
					neuronBudget: neuronBudget(c.env),
				},
				now(),
				estimateMemoNeurons(input.text.length),
			);
			if (!decision.allowed) {
				return decision.reason === 'rate_limited'
					? failure(429, 'rate_limited', '요청이 너무 잦습니다. 1분 후 다시 시도해 주세요.', decision.retryAfterSeconds)
					: failure(429, 'daily_limit_reached', '오늘 데모의 AI 사용 한도에 도달했습니다. 내일 다시 시도해 주세요.', decision.retryAfterSeconds);
			}
		} catch (error) {
			console.error('pre-agent db step failed', describeError(error));
			return failure(500, 'db_error', '저장소에 접근하지 못했습니다.');
		}

		// Mark the run as in progress (for "취소"); stale rows from crashed runs are cleared here too.
		const startedAt = now().toISOString();
		await db
			.batch([
				db.prepare('DELETE FROM memo_runs WHERE started_at < ?').bind(new Date(now().getTime() - 3600_000).toISOString()),
				db.prepare('INSERT OR REPLACE INTO memo_runs (request_id, workspace_id, started_at) VALUES (?, ?, ?)').bind(input.requestId, workspace.id, startedAt),
			])
			.catch((error) => console.error('memo_runs insert failed', describeError(error)));
		const settled = () =>
			db
				.prepare('DELETE FROM memo_runs WHERE request_id = ?')
				.bind(input.requestId)
				.run()
				.catch((error) => console.error('memo_runs delete failed', describeError(error)));

		const runStarted = Date.now();
		try {
			const run = await deps.runAgent(
				{
					sourceId: newId(),
					workspaceId: workspace.id,
					requestId: input.requestId,
					nickname,
					rawText: input.text,
					createdAt: now().toISOString(),
					noQuestions: input.noQuestions === true,
					authorKeyHash: await authorKeyHash(c),
				},
				{ timeoutMs, onProgress, signal },
			);
			// Real cost of this run (tokens from the model response → Neurons at the official rate).
			if (run && run.usage) {
				const neurons = await recordActualNeurons(db, run.usage, now()).catch(() => null);
				console.log(JSON.stringify({ event: 'ai_usage', kind: 'organize', input: run.usage.input, output: run.usage.output, neurons, ms: Date.now() - runStarted, chars: input.text.length }));
			}
		} catch (error) {
			await settled();
			const saved = await findSourceByRequestId(db, workspace.id, input.requestId).catch(() => null);
			if (!saved) {
				if (signal?.aborted) {
					// Cancelled: a draft made just before is discarded too (nothing saved, nothing scheduled).
					const late = await openDraftForRequest(db, workspace.id, input.requestId, now()).catch(() => null);
					if (late) await cancelDraft(db, workspace.id, late.id).catch(() => false);
					return failure(499, 'cancelled', '메모 정리를 취소했어요. 저장된 메모는 없어요.');
				}
				const draft = await openDraftForRequest(db, workspace.id, input.requestId, now()).catch(() => null);
				if (draft) return { ok: true, status: 202, body: { draft: draftPayload(draft) } };
				console.error('agent run failed', describeError(error));
				const classified = classifyAgentError(error);
				return failure(classified.status, classified.code, classified.message);
			}
			// The tool already saved everything; a late failure (or cancel) does not lose the result.
			const withReminders = await afterSave(saved);
			return { ok: true, status: 201, body: { duplicate: false, source: withReminders.source, memos: withReminders.memos } };
		}

		await settled();
		const saved = await findSourceByRequestId(db, workspace.id, input.requestId).catch(() => null);
		if (!saved) {
			const draft = await openDraftForRequest(db, workspace.id, input.requestId, now()).catch(() => null);
			if (draft) return { ok: true, status: 202, body: { draft: draftPayload(draft) } };
			return failure(
				502,
				'not_saved',
				'메모로 정리할 내용을 찾지 못했어요. 할 일·일정·떠오른 생각을 한두 문장으로 적어 다시 시도해 주세요. 입력한 글은 그대로 남아 있습니다.',
			);
		}
		const withReminders = await afterSave(saved);
		return { ok: true, status: 201, body: { duplicate: false, source: withReminders.source, memos: withReminders.memos } };
	}

	return api;
}

/** The repeat chosen in the edit form, starting on `start` (KST day). */
function ruleFromForm(repeat: NonNullable<v.InferOutput<typeof EditMemoSchema>['repeat']>, start: string): Recurrence {
	if (repeat.kind === 'daily') return { kind: 'daily', start };
	if (repeat.kind === 'monthly') return { kind: 'monthly', day: Number(start.slice(8)), start };
	return { kind: 'weekly', days: [...new Set(repeat.days)].sort((a, b) => a - b) as Weekday[], interval: repeat.interval, start };
}

/** SHA-256 of this browser's author key (header x-author-key, 64 hex), or null. */
async function authorKeyHash(c: ApiContext): Promise<string | null> {
	const key = c.req.header('x-author-key') ?? '';
	return /^[0-9a-f]{64}$/.test(key) ? sha256Hex(key) : null;
}
