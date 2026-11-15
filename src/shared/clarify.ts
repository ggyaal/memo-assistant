// Clarifying questions for unclear dates, times and repeats. Built by fixed rules from the
// wording the model copied (due_text) — no AI call for the questions or for button answers.
// Shared: the server applies answers at commit; the screen uses the same code for its preview.
import { addDays, describeRecurrence, nextOccurrence, weekdayOf, weekdaysIn, type Recurrence, type RecurrenceQuestion } from './recurrence.ts';
import type { MemoCategory, MemoPriority } from './types.ts';

/** The memo fields a draft holds (same shape the save tool stores). */
export interface DraftMemo {
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
	recurrence: Recurrence | null;
	recurrence_question: RecurrenceQuestion | null;
}

export type ClarifyKind = 'meridiem' | 'week_day' | 'recurrence';

export interface ClarifyQuestion {
	id: string;
	/** Which memo of the draft this question is about (answers never touch other memos). */
	memoIndex: number;
	kind: ClarifyKind;
	prompt: string;
	options: { id: string; label: string }[];
	/** A picker for "직접 입력" (checked by rules, no AI). */
	picker?: 'date' | 'time';
}

export interface ClarifyAnswer {
	questionId: string;
	/** One of the question's options… */
	optionId?: string;
	/** …or a picker value: YYYY-MM-DD (date) or HH:MM (time). */
	value?: string;
}

export const MAX_QUESTIONS = 3;
const MERIDIEM = /오전|오후|아침|저녁|밤|새벽|낮|정오|자정/;
const WEEK_ONLY = /(다다음\s*주|다음\s*주|담주|이번\s*주|금주)(?!\s*말)/;
const EXPLICIT_DAY = /\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*일(?!\s*(?:간|동안))|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|오늘|내일|모레|글피/;
const DAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];
const KST_MS = 9 * 3600_000;

const kstDay = (now: Date) => new Date(now.getTime() + KST_MS).toISOString().slice(0, 10);
const kstTime = (iso: string) => new Date(Date.parse(iso) + KST_MS).toISOString().slice(11, 16);
const at = (day: string, time: string) => new Date(`${day}T${time}:00+09:00`).toISOString();
const pad = (n: number) => String(n).padStart(2, '0');

/** "3시", "3시 30분", "7시 반" without 오전/오후 — the hour (1–11) and minutes, else null. */
export function bareHour(text: string | null): { hour: number; minute: number } | null {
	if (!text || MERIDIEM.test(text) || /\d{1,2}:\d{2}/.test(text)) return null;
	const m = /(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?/.exec(text);
	if (!m) return null;
	const hour = Number(m[1]);
	const minute = m[2] ? Number(m[2]) : m[3] ? 30 : 0;
	return hour >= 1 && hour <= 11 && minute <= 59 ? { hour, minute } : null;
}

/** The Monday-first week a "이번 주 / 다음 주 / 다다음 주" text names, as days from today on. */
function namedWeek(text: string, today: string): string[] | null {
	const m = WEEK_ONLY.exec(text);
	if (!m) return null;
	const ahead = /다다음/.test(m[1]) ? 2 : /다음|담/.test(m[1]) ? 1 : 0;
	const monday = addDays(addDays(today, -weekdayOf(today)), ahead * 7);
	return [0, 1, 2, 3, 4, 5, 6].map((d) => addDays(monday, d)).filter((d) => d >= today);
}

const dayLabel = (day: string) => `${DAY_LABELS[weekdayOf(day)]} ${Number(day.slice(5, 7))}/${Number(day.slice(8))}`;

/**
 * Questions for the parts that really need an answer (max 3, in memo order):
 * - recurrence: several weekdays / 평일 / 주말 without "매주·~마다" ("월 화 목 운동");
 * - week_day: a week without a day ("다음 주에 병원");
 * - meridiem: an hour without 오전/오후 ("내일 3시 회의").
 * No question for a date without a time, or for ideas/notes without dates.
 */
export function buildQuestions(memos: DraftMemo[], now: Date): ClarifyQuestion[] {
	const today = kstDay(now);
	const out: ClarifyQuestion[] = [];
	memos.forEach((memo, memoIndex) => {
		const text = memo.due_text;
		const q = memo.recurrence_question;
		if (q) {
			out.push({
				id: `q${out.length + 1}`,
				memoIndex,
				kind: 'recurrence',
				prompt: `「${memo.title}」 ${text ? `“${text}”` : ''}을(를) 매주 반복하나요?`,
				options: [
					{ id: 'repeat', label: `${describeRecurrence(q.repeat)} 반복` },
					{ id: 'once', label: `이번만 (${describeRecurrence(q.once).replace(' 한 번씩', '')})` },
				],
			});
		}
		if (text && !memo.due_date && !memo.recurrence && !q && weekdaysIn(text).length === 0 && !EXPLICIT_DAY.test(text)) {
			const days = namedWeek(text, today);
			if (days?.length) {
				out.push({
					id: `q${out.length + 1}`,
					memoIndex,
					kind: 'week_day',
					prompt: `「${memo.title}」 “${text}” 중 언제인가요?`,
					options: days.map((d) => ({ id: d, label: dayLabel(d) })),
					picker: 'date',
				});
			}
		}
		const hour = bareHour(text);
		if (hour && (memo.due_date || memo.recurrence || q)) {
			const label = (h: number) => `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}시${hour.minute ? ` ${hour.minute}분` : ''}`;
			out.push({
				id: `q${out.length + 1}`,
				memoIndex,
				kind: 'meridiem',
				prompt: `「${memo.title}」 “${text}”는 오전인가요, 오후인가요?`,
				options: [
					{ id: `${pad(hour.hour)}:${pad(hour.minute)}`, label: label(hour.hour) },
					{ id: `${pad(hour.hour + 12)}:${pad(hour.minute)}`, label: label(hour.hour + 12) },
				],
				picker: 'time',
			});
		}
	});
	return out.slice(0, MAX_QUESTIONS);
}

/** Time of day a memo keeps when its day changes (null = no time). */
const timeOf = (memo: DraftMemo) => (memo.due_at ? kstTime(memo.due_at) : null);

function isDay(value: string | undefined, today: string): value is string {
	return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && value >= today && value <= addDays(today, 400);
}
const isTime = (value: string | undefined): value is string => !!value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/**
 * Apply answers (in question order) to a copy of the memos. Unanswered or skipped questions
 * leave the value undecided: no time for an unclear hour, no day for an unclear week, and an
 * unclear repeat stays a question on the card. Never invents a value. Pure — no AI.
 */
export function applyAnswers(memos: DraftMemo[], questions: ClarifyQuestion[], answers: ClarifyAnswer[], now: Date): DraftMemo[] {
	const today = kstDay(now);
	const out = memos.map((m) => ({ ...m }));
	for (const question of questions) {
		const memo = out[question.memoIndex];
		if (!memo) continue;
		const answer = answers.find((a) => a.questionId === question.id);
		const option = answer?.optionId && question.options.some((o) => o.id === answer.optionId) ? answer.optionId : undefined;
		if (question.kind === 'meridiem') {
			const time = option ?? (isTime(answer?.value) ? answer!.value : undefined);
			const day = memo.due_date;
			memo.due_at = time && day ? at(day, time) : null; // skipped → the time stays undecided
			continue;
		}
		if (question.kind === 'week_day') {
			const day = option ?? (isDay(answer?.value, today) ? answer!.value : undefined);
			if (!day) continue; // skipped → no day
			const time = timeOf(memo);
			memo.due_date = day;
			memo.due_at = time ? at(day, time) : null;
			continue;
		}
		if (question.kind === 'recurrence' && memo.recurrence_question && (option === 'repeat' || option === 'once')) {
			const rule: Recurrence = option === 'repeat' ? memo.recurrence_question.repeat : memo.recurrence_question.once;
			const first = nextOccurrence(rule, today) ?? (rule.kind === 'dates' ? rule.dates[0] : rule.start);
			const time = timeOf(memo);
			memo.recurrence = rule.kind === 'dates' ? rule : { ...rule, start: first };
			memo.recurrence_question = null;
			memo.due_date = first;
			memo.due_at = time ? at(first, time) : null;
		}
	}
	return out;
}
