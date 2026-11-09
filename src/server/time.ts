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
	const hits = RELATIVE_DAY_WORDS.filter(({ word }) => dueText.includes(word));
	if (hits.length !== 1) return dueAtUtc;
	const expectedDate = addDays(kstDate(now), hits[0].offset);
	const kstTime = new Date(Date.parse(dueAtUtc) + KST_OFFSET_MS).toISOString().slice(11, 19);
	return new Date(Date.parse(`${expectedDate}T${kstTime}+09:00`)).toISOString();
}
