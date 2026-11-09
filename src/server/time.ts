// Asia/Seoul has no DST, so a fixed +09:00 offset is exact.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** YYYY-MM-DD of the given instant in KST. */
export function kstDate(now: Date): string {
	return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD HH:mm (요일)" of the given instant in KST. */
export function kstDateTimeLabel(now: Date): string {
	const shifted = new Date(now.getTime() + KST_OFFSET_MS);
	const iso = shifted.toISOString();
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)} (${WEEKDAYS_KO[shifted.getUTCDay()]})`;
}

/** UTC [start, end) range covering the KST calendar day that contains `now`. */
export function kstDayRangeUtc(now: Date): { start: string; end: string } {
	const startMs = Date.parse(`${kstDate(now)}T00:00:00+09:00`);
	return { start: new Date(startMs).toISOString(), end: new Date(startMs + DAY_MS).toISOString() };
}

function addDays(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(date: string): string {
	return WEEKDAYS_KO[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/** Absolute dates for the relative day words the model may meet. */
export const RELATIVE_DAY_WORDS: ReadonlyArray<{ word: string; offset: number }> = [
	{ word: '오늘', offset: 0 },
	{ word: '내일', offset: 1 },
	{ word: '모레', offset: 2 },
	{ word: '글피', offset: 3 },
];

/**
 * A KST date table handed to the model so it never has to do calendar math:
 * today/tomorrow/... plus the next 14 days with weekdays.
 */
export function buildDateReference(now: Date): string {
	const today = kstDate(now);
	const lines = RELATIVE_DAY_WORDS.map(
		({ word, offset }) => `${word} = ${addDays(today, offset)} (${weekdayOf(addDays(today, offset))})`,
	);
	const days: string[] = [];
	for (let i = 0; i < 14; i++) {
		const d = addDays(today, i);
		days.push(`${d}(${weekdayOf(d)})`);
	}
	lines.push(`앞으로 14일: ${days.join(', ')}`);
	return lines.join('\n');
}

// An explicit clock time: "3시", "15:00", "세 시", "정오", "자정". Vague parts of
// the day ("아침", "저녁") or a bare "오후" do not count as an exact time.
const EXPLICIT_TIME_PATTERN =
	/\d{1,2}\s*시|\d{1,2}:\d{2}|(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|열한|열두)\s*시(?!간)|정오|자정/;

/** True when the deadline text states a time of day, not just a date. */
export function hasExplicitTime(dueText: string): boolean {
	return EXPLICIT_TIME_PATTERN.test(dueText);
}

const DUE_AT_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Parse a model-provided schedule time. A missing offset is read as KST
 * (the instructions ask for KST). Returns UTC ISO 8601, or null if invalid.
 */
export function normalizeDueAt(value: string | null | undefined): string | null {
	if (!value) return null;
	const match = DUE_AT_PATTERN.exec(value.trim());
	if (!match) return null;
	const [, date, hh, mm, ss = '00', offset = '+09:00'] = match;
	const ms = Date.parse(`${date}T${hh}:${mm}:${ss}${offset}`);
	if (Number.isNaN(ms)) return null;
	return new Date(ms).toISOString();
}

/**
 * If the deadline text uses one unambiguous relative day word (오늘/내일/모레/글피),
 * force the due date to that KST date while keeping the model's time of day.
 * Protects against the model mis-computing the calendar date.
 */
export function reconcileRelativeDate(dueAtUtc: string, dueText: string, now: Date): string {
	const expectedDate = pinnedDay(dueText, now);
	if (!expectedDate) return dueAtUtc;
	const kstTime = new Date(Date.parse(dueAtUtc) + KST_OFFSET_MS).toISOString().slice(11, 19);
	return new Date(Date.parse(`${expectedDate}T${kstTime}+09:00`)).toISOString();
}

const WEEKDAY_INDEX: Record<string, number> = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 }; // Monday-first
const WEEKDAY_PATTERN = /(다다음\s*주|다음\s*주|담주|이번\s*주|금주)?\s*([월화수목금토일])요일/g;

/**
 * The KST day a deadline text pins down by itself, without trusting the model:
 * - one relative day word: 오늘/내일/모레/글피;
 * - one weekday: "금요일" = the nearest one from today (today included),
 *   "이번 주/다음 주/다다음 주 금요일" = that weekday of the Monday-first week.
 * Returns null when the text has none of these or is ambiguous (several hits).
 */
export function pinnedDay(dueText: string, now: Date): string | null {
	const today = kstDate(now);
	const relative = RELATIVE_DAY_WORDS.filter(({ word }) => dueText.includes(word));
	const weekdays = [...dueText.matchAll(WEEKDAY_PATTERN)];
	if (relative.length + weekdays.length !== 1) return null;
	if (relative.length === 1) return addDays(today, relative[0].offset);

	const [, week, day] = weekdays[0];
	const target = WEEKDAY_INDEX[day];
	const todayIndex = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
	if (!week) return addDays(today, (target - todayIndex + 7) % 7);
	const monday = addDays(today, -todayIndex);
	const weeksAhead = /다다음/.test(week) ? 2 : /다음|담/.test(week) ? 1 : 0;
	return addDays(monday, weeksAhead * 7 + target);
}

// A named calendar day: "11월 20일", "20일", "11/20", "금요일". Vague ranges
// ("다음 주", "이번 달", "언젠가") are not a day.
const EXPLICIT_DATE_PATTERN = /\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*일(?!\s*(?:간|동안))|\d{1,2}\/\d{1,2}/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar date (YYYY-MM-DD) in KST of a UTC instant. */
export function kstDateOf(isoUtc: string): string {
	return kstDate(new Date(isoUtc));
}

/**
 * The KST calendar day a memo is due, or null when the input names no
 * specific day. Order of trust: an exact time (already pinned) → a day the
 * text pins by itself (pinnedDay) → the model's date, only for an explicit
 * calendar date within the next year.
 */
export function resolveDueDate(
	dueText: string | null,
	dueAtUtc: string | null,
	modelDate: string | null | undefined,
	now: Date,
): string | null {
	if (dueAtUtc) return kstDateOf(dueAtUtc);
	if (!dueText) return null;
	const pinned = pinnedDay(dueText, now);
	if (pinned) return pinned;
	// Weekdays/relative words are fully handled above; the model's date is only
	// trusted for an explicit calendar date ("11월 20일", "20일", "11/20").
	if (!EXPLICIT_DATE_PATTERN.test(dueText) || /요일/.test(dueText)) return null;
	const date = modelDate?.trim() ?? '';
	if (!ISO_DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
	const today = kstDate(now);
	return date >= today && date <= addDays(today, 366) ? date : null;
}
