import * as v from 'valibot';
import { LIMITS, MEMO_CATEGORIES, MEMO_PRIORITIES, type MemoCategory, type MemoPriority } from '../shared/types.ts';
import { hasExplicitTime, normalizeDueAt, reconcileRelativeDate, resolveDueDate } from './time.ts';

// Strip ASCII control characters except tab/newline.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanText(value: string): string {
	return value.replace(CONTROL_CHARS, '').trim();
}

/** POST /api/memos body. Validated before anything reaches the agent. */
export const CreateMemosRequestSchema = v.object({
	nickname: v.pipe(
		v.string('닉네임은 문자열이어야 합니다.'),
		v.transform(cleanText),
		v.minLength(1, '닉네임을 입력해 주세요.'),
		v.maxLength(LIMITS.nicknameMax, `닉네임은 ${LIMITS.nicknameMax}자 이하로 입력해 주세요.`),
	),
	text: v.pipe(
		v.string('메모 내용은 문자열이어야 합니다.'),
		v.transform(cleanText),
		v.minLength(1, '메모 내용을 입력해 주세요.'),
		v.maxLength(LIMITS.textMax, `메모는 ${LIMITS.textMax}자 이하로 입력해 주세요.`),
	),
	requestId: v.pipe(v.string(), v.uuid('requestId 형식이 올바르지 않습니다.')),
});

export type CreateMemosInput = v.InferOutput<typeof CreateMemosRequestSchema>;

export const ListMemosQuerySchema = v.object({
	scope: v.optional(v.picklist(['today', 'all']), 'all'),
	limit: v.optional(
		v.pipe(
			v.string(),
			v.transform(Number),
			v.integer(),
			v.minValue(1),
			v.maxValue(LIMITS.listMax),
		),
		String(LIMITS.listDefault),
	),
	cursor: v.optional(v.pipe(v.string(), v.maxLength(200))),
	category: v.optional(v.picklist(MEMO_CATEGORIES)),
	nickname: v.optional(v.pipe(v.string(), v.transform(cleanText), v.maxLength(LIMITS.nicknameMax))),
});

/**
 * What the model may send to `save_memos`. Lenient on optional fields
 * (models often omit nulls); the server then sanitizes every value.
 * Trusted fields (nickname, source_id, request_id, created_at) are NOT here.
 */
export const ModelMemoSchema = v.object({
	title: v.pipe(v.string(), v.minLength(1)),
	content: v.pipe(v.string(), v.minLength(1)),
	category: v.picklist(MEMO_CATEGORIES),
	due_at: v.nullish(v.string()),
	due_date: v.nullish(v.string()),
	due_text: v.nullish(v.string()),
	reminder_recommended: v.optional(v.boolean(), false),
	reminder_reason: v.nullish(v.string()),
	// A string (not a picklist) so an unexpected value degrades to "no priority"
	// in sanitizeMemo instead of failing the whole save and forcing a model retry.
	priority: v.nullish(v.pipe(v.string(), v.description('One of: high, medium, low'))),
	priority_reason: v.nullish(v.string()),
});

export const SaveMemosInputSchema = v.object({
	memos: v.pipe(v.array(ModelMemoSchema), v.minLength(1), v.maxLength(LIMITS.memosMax)),
});

export type ModelMemo = v.InferOutput<typeof ModelMemoSchema>;

export interface SanitizedMemo {
	title: string;
	content: string;
	category: MemoCategory;
	due_at: string | null;
	due_date: string | null;
	due_text: string | null;
	reminder_recommended: boolean;
	reminder_reason: string | null;
	priority: MemoPriority | null;
	priority_reason: string | null;
}

function toPriority(value: string | null | undefined): MemoPriority | null {
	const normalized = value?.trim().toLowerCase();
	return (MEMO_PRIORITIES as readonly string[]).includes(normalized ?? '') ? (normalized as MemoPriority) : null;
}

function clip(value: string, max: number): string {
	const cleaned = cleanText(value);
	return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function squash(value: string): string {
	return value.replace(/\s+/g, '');
}

/**
 * Server-side guard against fabricated facts:
 * - a deadline expression must literally appear in the original input,
 * - no deadline expression means no schedule time,
 * - relative day words (오늘/내일/...) are pinned to the request's KST date,
 * - a due date is kept only when the text names a day (see resolveDueDate),
 * - no reminder means no reminder reason; no priority means no priority reason.
 */
export function sanitizeMemo(memo: ModelMemo, rawText: string, now: Date): SanitizedMemo {
	let dueText = memo.due_text ? clip(memo.due_text, LIMITS.dueTextMax) : null;
	if (dueText && !squash(rawText).includes(squash(dueText))) dueText = null;
	if (dueText === '') dueText = null;

	// No stated clock time ("오늘", "이번 주") → no exact schedule time, even if the model made one up.
	let dueAt = dueText && hasExplicitTime(dueText) ? normalizeDueAt(memo.due_at) : null;
	if (dueAt && dueText) dueAt = reconcileRelativeDate(dueAt, dueText, now);

	const dueDate = resolveDueDate(dueText, dueAt, memo.due_date, now);

	const reminder = memo.reminder_recommended === true;
	const priority = toPriority(memo.priority);
	const priorityReason =
		priority && memo.priority_reason ? clip(memo.priority_reason, LIMITS.reasonMax) || null : null;
	const reason = reminder && memo.reminder_reason ? clip(memo.reminder_reason, LIMITS.reasonMax) || null : null;

	return {
		title: clip(memo.title, LIMITS.titleMax) || '제목 없음',
		content: clip(memo.content, LIMITS.contentMax) || clip(memo.title, LIMITS.contentMax),
		category: memo.category,
		due_at: dueAt,
		due_date: dueDate,
		due_text: dueText,
		reminder_recommended: reminder,
		reminder_reason: reason,
		priority,
		priority_reason: priorityReason,
	};
}

export function issuesToMessage(issues: v.BaseIssue<unknown>[]): string {
	return issues[0]?.message ?? '요청 형식이 올바르지 않습니다.';
}
