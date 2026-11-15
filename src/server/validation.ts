import * as v from 'valibot';
import { LIMITS, MEMO_CATEGORIES, MEMO_PRIORITIES, REMINDER_TONES, type MemoCategory, type MemoPriority } from '../shared/types.ts';
import { clockTimeIn, detectRecurrence, nextOccurrence, repeatWordingFallback, type Recurrence, type RecurrenceQuestion } from '../shared/recurrence.ts';
import { hasExplicitTime, kstDate, normalizeDueAt, reconcileRelativeDate, resolveDueDate } from './time.ts';

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

export const CompleteRequestSchema = v.object({
	completed: v.boolean('completed는 true 또는 false여야 합니다.'),
});

export const MemoIdSchema = v.pipe(v.string(), v.uuid('메모 id 형식이 올바르지 않습니다.'));

export const ReorderRequestSchema = v.object({
	ids: v.pipe(
		v.array(v.pipe(v.string(), v.uuid('메모 id 형식이 올바르지 않습니다.'))),
		v.minLength(1, '정렬할 메모가 없습니다.'),
		v.maxLength(LIMITS.agendaMax, `한 번에 ${LIMITS.agendaMax}개까지 정렬할 수 있습니다.`),
		v.check((ids) => new Set(ids).size === ids.length, '같은 메모가 중복되었습니다.'),
	),
});

export const DisplayNameSchema = v.object({
	displayName: v.pipe(
		v.string('닉네임은 문자열이어야 합니다.'),
		v.transform(cleanText),
		v.minLength(1, '닉네임을 입력해 주세요.'),
		v.maxLength(LIMITS.nicknameMax, `닉네임은 ${LIMITS.nicknameMax}자 이하로 입력해 주세요.`),
	),
});

export const ReminderRequestSchema = v.object({
	leadMinutes: v.optional(v.pipe(v.number(), v.integer())),
	time: v.optional(v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/, '시각은 HH:MM 형식이어야 해요.'))),
	at: v.optional(v.pipe(v.string(), v.isoTimestamp('알림 시각 형식이 올바르지 않아요.'))),
	channels: v.optional(v.pipe(v.array(v.picklist(['discord', 'kakao', 'email'], '알 수 없는 알림 경로예요.')), v.maxLength(3))),
});

export const ReminderDefaultsSchema = v.object({
	leadMinutes: v.picklist([0, 10, 30, 60], '기본 알림 시점은 정시·10분·30분·1시간 전 중 하나예요.'),
	dateOnlyTime: v.nullable(v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/, '시각은 HH:MM 형식이어야 해요.'))),
});

export const ChannelToggleSchema = v.object({
	enabled: v.boolean('enabled는 true 또는 false여야 합니다.'),
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
	/** Repeating / several-days rule read from due_text by the server (never by the model). */
	recurrence: Recurrence | null;
	/** Unclear wording ("월수금", "평일"): the person chooses between these. */
	recurrence_question: RecurrenceQuestion | null;
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
export function sanitizeMemo(memo: ModelMemo, rawText: string, now: Date, options: { singleMemo?: boolean } = {}): SanitizedMemo {
	let dueText = memo.due_text ? clip(memo.due_text, LIMITS.dueTextMax) : null;
	if (dueText && !squash(rawText).includes(squash(dueText))) dueText = null;
	if (dueText === '') dueText = null;

	// No stated clock time ("오늘", "이번 주") → no exact schedule time, even if the model made one up.
	let dueAt = dueText && hasExplicitTime(dueText) ? normalizeDueAt(memo.due_at) : null;
	if (dueAt && dueText) dueAt = reconcileRelativeDate(dueAt, dueText, now);

	let dueDate = resolveDueDate(dueText, dueAt, memo.due_date, now);

	// Several days or a repeat ("매주 월수금", "이번 주 월, 목", "평일"): computed here from the
	// wording, not by the model. due_at/due_date become the first occurrence.
	// The time: the model's (when it gave one), else a clearly stated time in the wording.
	const repeatText = dueText ?? repeatWordingFallback(`${memo.title} ${memo.content}`, rawText, options.singleMemo);
	const statedTime = dueAt ? kstTimeOf(dueAt) : repeatText && hasExplicitTime(repeatText) ? clockTimeIn(repeatText) : null;
	const schedule = scheduleFromText(repeatText, statedTime, now);
	if (schedule) {
		dueDate = schedule.first;
		dueAt = schedule.time ? new Date(`${schedule.first}T${schedule.time}:00+09:00`).toISOString() : null;
	}

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
		recurrence: schedule?.recurrence ?? null,
		recurrence_question: schedule?.question ?? null,
	};
}

const KST_MS = 9 * 3600_000;
const kstTimeOf = (isoUtc: string) => new Date(Date.parse(isoUtc) + KST_MS).toISOString().slice(11, 16);

/**
 * Turn repeat / several-days wording into a rule. With a clock time, an occurrence whose
 * time has already passed today is skipped (the first one is always still ahead).
 */
export function scheduleFromText(
	dueText: string | null,
	time: string | null,
	now: Date,
): { first: string; time: string | null; recurrence: Recurrence | null; question: RecurrenceQuestion | null } | null {
	const today = kstDate(now);
	const detection = detectRecurrence(dueText, today);
	if (detection.status === 'none') return null;
	const passed = (day: string) => !!time && Date.parse(`${day}T${time}:00+09:00`) <= now.getTime();
	const keepDates = (dates: string[]) => dates.filter((d) => !passed(d));
	const firstOf = (rule: Recurrence): string | null => {
		const first = nextOccurrence(rule, today);
		return first && passed(first) ? nextOccurrence(rule, addDay(first)) : first;
	};
	if (detection.status === 'once') {
		const dates = keepDates(detection.rule.dates);
		if (!dates.length) return null;
		return { first: dates[0], time, recurrence: { kind: 'dates', dates }, question: null };
	}
	if (detection.status === 'recurring') {
		const first = firstOf(detection.rule);
		if (!first) return null;
		const rule = detection.rule.kind === 'dates' ? detection.rule : { ...detection.rule, start: first };
		return { first, time, recurrence: rule, question: null };
	}
	const onceDates = keepDates(detection.question.once.dates);
	const repeatFirst = firstOf(detection.question.repeat);
	if (!repeatFirst) return null;
	const repeat = detection.question.repeat.kind === 'dates' ? detection.question.repeat : { ...detection.question.repeat, start: repeatFirst };
	const once = { kind: 'dates' as const, dates: onceDates.length ? onceDates : [repeatFirst] };
	return { first: once.dates[0], time, recurrence: null, question: { repeat, once } };
}

const addDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export function issuesToMessage(issues: v.BaseIssue<unknown>[]): string {
	return issues[0]?.message ?? '요청 형식이 올바르지 않습니다.';
}

/** POST /api/memos/cancel — the request id the client generated for that submission. */
export const CancelMemosRequestSchema = v.object({ requestId: v.pipe(v.string(), v.uuid()) });

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** PUT /api/memos/:id — a person correcting an organized memo. Date/time are KST. */
export const EditMemoSchema = v.pipe(
	v.object({
		title: v.pipe(v.string(), v.trim(), v.minLength(1, '제목을 입력해 주세요.'), v.maxLength(LIMITS.titleMax, `제목은 ${LIMITS.titleMax}자 이하로 입력해 주세요.`)),
		content: v.pipe(v.string(), v.trim(), v.minLength(1, '내용을 입력해 주세요.'), v.maxLength(LIMITS.contentMax, `내용은 ${LIMITS.contentMax}자 이하로 입력해 주세요.`)),
		category: v.picklist(MEMO_CATEGORIES, '분류를 골라 주세요.'),
		priority: v.nullable(v.picklist(MEMO_PRIORITIES, '중요도를 골라 주세요.')),
		dueDate: v.nullable(
			v.pipe(
				v.string(),
				v.regex(DATE_RE, '날짜는 YYYY-MM-DD 형식이어야 해요.'),
				v.check((d) => !Number.isNaN(Date.parse(`${d}T00:00:00+09:00`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), '없는 날짜예요.'),
			),
		),
		dueTime: v.nullable(v.pipe(v.string(), v.regex(TIME_RE, '시각은 HH:MM 형식이어야 해요.'))),
		/** Omitted = keep the current rule; null = one-time; else repeat from dueDate. */
		repeat: v.optional(
			v.nullable(
				v.variant('kind', [
					v.object({ kind: v.literal('daily') }),
					v.object({
						kind: v.literal('weekly'),
						days: v.pipe(v.array(v.picklist([0, 1, 2, 3, 4, 5, 6] as const)), v.minLength(1, '반복할 요일을 골라 주세요.'), v.maxLength(7)),
						interval: v.picklist([1, 2] as const),
					}),
					v.object({ kind: v.literal('monthly') }),
				]),
			),
		),
	}),
	v.check((m) => m.dueTime === null || m.dueDate !== null, '시각을 정하려면 날짜도 골라 주세요.'),
	v.check((m) => !m.repeat || m.dueDate !== null, '반복하려면 시작 날짜를 골라 주세요.'),
);

export const OccurrenceDoneSchema = v.object({ completed: v.boolean('completed는 true 또는 false여야 합니다.') });
export const OccurrenceDateSchema = v.pipe(v.string(), v.regex(DATE_RE, '날짜는 YYYY-MM-DD 형식이어야 해요.'));
export const RecurrenceChoiceSchema = v.object({ choice: v.picklist(['repeat', 'once'], '매주 반복인지 한 번인지 골라 주세요.') });
export type EditMemoInput = v.InferOutput<typeof EditMemoSchema>;

export const ReminderToneSchema = v.object({
	tone: v.picklist(REMINDER_TONES, '알림 말투를 골라 주세요.'),
});
