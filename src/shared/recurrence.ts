// Repeating and multi-date schedules, parsed from the stored deadline wording and
// expanded with plain calendar math. No AI call is involved anywhere in this file.
//
// Days are KST calendar days ("YYYY-MM-DD"); weekdays are Monday-first (0 = 월 … 6 = 일).
// The time of day is not part of a rule: it comes from the memo's due_at.

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Recurrence =
	| { kind: 'daily'; start: string; until?: string | null }
	| { kind: 'weekly'; days: Weekday[]; interval: 1 | 2; start: string; until?: string | null }
	| { kind: 'monthly'; day: number; start: string; until?: string | null }
	/** One-time on several specific days (e.g. "이번 주 월, 목"). */
	| { kind: 'dates'; dates: string[] };

/** Several weekdays/평일/주말 without a clear "every" or "this week": ask the person. */
export interface RecurrenceQuestion {
	repeat: Recurrence;
	once: Extract<Recurrence, { kind: 'dates' }>;
}

export type Detection =
	| { status: 'none' }
	| { status: 'recurring'; rule: Recurrence }
	| { status: 'once'; rule: Extract<Recurrence, { kind: 'dates' }> }
	| { status: 'ambiguous'; question: RecurrenceQuestion };

const DAY_MS = 86_400_000;
const WEEKDAY_CHARS = '월화수목금토일';
const LABELS = ['월', '화', '수', '목', '금', '토', '일'];

export function addDays(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Monday-first weekday of a calendar day. */
export function weekdayOf(date: string): Weekday {
	return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) as Weekday;
}

function mondayOf(date: string): string {
	return addDays(date, -weekdayOf(date));
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const sortDays = (days: Iterable<number>) => [...new Set(days)].sort((a, b) => a - b) as Weekday[];

/**
 * Weekdays named in a deadline text: "월요일", "월요일과 목요일", "월 화 목", "월수금",
 * "월, 수, 금", "화/목". A lone weekday character without 요일 is ignored ("11월", "지금",
 * "매일" are not weekdays), and a run must stand on its own (not inside a word).
 */
export function weekdaysIn(text: string): Weekday[] {
	const found = new Set<number>();
	for (const m of text.matchAll(/([월화수목금토일])요일/g)) found.add(WEEKDAY_CHARS.indexOf(m[1]));
	// Runs of 2+ weekday characters, optionally separated by spaces, commas, ·, / or 와/과/랑/및.
	const sep = String.raw`(?:\s*[,·/、]\s*|\s+|\s*(?:와|과|랑|및|하고)\s*)?`;
	const run = new RegExp(
		String.raw`(?<![0-9가-힣])([월화수목금토일](?:${sep}[월화수목금토일]){1,6})(?=요일|마다|에|엔|은|는|만|$|[^가-힣])`,
		'g',
	);
	const spaced = text.replace(/(매주|격주|매\s*주|주마다)/g, '$1 ');
	for (const m of spaced.matchAll(run)) for (const ch of m[1]) if (WEEKDAY_CHARS.includes(ch)) found.add(WEEKDAY_CHARS.indexOf(ch));
	return sortDays(found);
}

const DAILY = /매일|날마다|매\s+일(?!요일)/;
const EVERY_WEEK = /매주|매\s*주(?!말)|주마다|매\s*주말|매\s*평일/;
const BIWEEKLY = /격주|2주\s*마다|두\s*주\s*마다|이주\s*마다|2주에\s*한\s*번/;
const MONTHLY = /매월|매달|매\s*월(?!요일)|매\s*달|달마다/;
const EVERY_SUFFIX = /마다/;
/** "From now on" wording: with weekdays it means a routine ("이제부터 월, 화, 금"). */
const FROM_NOW_ON = /이제부터|앞으로|매번|꾸준히/;
const THIS_WEEK = /이번\s*주|금주/;
const NEXT_NEXT_WEEK = /다다음\s*주/;
const NEXT_WEEK = /다음\s*주|담주/;
const WEEKDAYS_WORD = /평일|주중/;
const WEEKEND_WORD = /주말/;
const ALL_WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4];
const WEEKEND: Weekday[] = [5, 6];

/** First day ≥ `from` that falls on one of `days`. */
function nextOnOrAfter(from: string, days: Weekday[]): string {
	for (let i = 0; i < 7; i++) {
		const d = addDays(from, i);
		if (days.includes(weekdayOf(d))) return d;
	}
	return from;
}

/**
 * Read a deadline text ("매주 월수금 오후 7시", "이번 주 월, 목", "평일 아침") as of `today`
 * (KST day). Single-day texts ("금요일", "내일") return none — they are handled elsewhere.
 */
export function detectRecurrence(dueText: string | null | undefined, today: string): Detection {
	const text = (dueText ?? '').replace(/\s+/g, ' ').trim();
	if (!text) return { status: 'none' };
	const named = weekdaysIn(text);
	const days = sortDays([...named, ...(WEEKDAYS_WORD.test(text) ? ALL_WEEKDAYS : []), ...(WEEKEND_WORD.test(text) ? WEEKEND : [])]);

	if (DAILY.test(text)) return { status: 'recurring', rule: { kind: 'daily', start: today } };
	if (MONTHLY.test(text)) {
		const m = /(?<![\d월])(\d{1,2})\s*일(?!\s*(?:간|동안))/.exec(text);
		const day = m ? Number(m[1]) : NaN;
		if (!(day >= 1 && day <= 31)) return { status: 'none' }; // "매월" without a day: nothing to place
		return { status: 'recurring', rule: { kind: 'monthly', day, start: today } };
	}
	if (BIWEEKLY.test(text)) {
		if (!days.length) return { status: 'none' };
		return { status: 'recurring', rule: { kind: 'weekly', days, interval: 2, start: nextOnOrAfter(today, days) } };
	}
	// "~마다" / "이제부터·앞으로" with weekdays = a routine. Several weekdays alone ("월 화 목 운동")
	// are asked at input time (clarifying question, 2026-11-16 spec) instead of guessing "매주".
	const routine = (EVERY_SUFFIX.test(text) || FROM_NOW_ON.test(text)) && days.length > 0;
	const weekQualifier = NEXT_NEXT_WEEK.test(text) || NEXT_WEEK.test(text) || THIS_WEEK.test(text);
	if (EVERY_WEEK.test(text) || (routine && !weekQualifier)) {
		if (!days.length) return { status: 'none' }; // "매주" alone: which day is not stated
		return { status: 'recurring', rule: { kind: 'weekly', days, interval: 1, start: nextOnOrAfter(today, days) } };
	}

	// From here on there is no "every" word.
	const multi = days.length >= 2 || WEEKDAYS_WORD.test(text) || WEEKEND_WORD.test(text);
	if (!multi) return { status: 'none' };
	const weeksAhead = NEXT_NEXT_WEEK.test(text) ? 2 : NEXT_WEEK.test(text) ? 1 : THIS_WEEK.test(text) ? 0 : null;
	if (weeksAhead !== null) {
		const monday = addDays(mondayOf(today), weeksAhead * 7);
		const dates = days.map((d) => addDays(monday, d)).filter((d) => d >= today);
		return dates.length ? { status: 'once', rule: { kind: 'dates', dates } } : { status: 'none' };
	}
	// "평일 아침", "주말에 청소": every week, or just the coming ones? Ask.
	const upcoming = sortDays(days)
		.map((d) => nextOnOrAfter(today, [d]))
		.sort();
	return {
		status: 'ambiguous',
		question: {
			repeat: { kind: 'weekly', days, interval: 1, start: nextOnOrAfter(today, days) },
			once: { kind: 'dates', dates: upcoming },
		},
	};
}

/** Occurrence days of a rule within [from, to] (inclusive), at most `max`. */
export function occurrencesBetween(rule: Recurrence, from: string, to: string, max = 400): string[] {
	const out: string[] = [];
	if (rule.kind === 'dates') return rule.dates.filter((d) => d >= from && d <= to).sort().slice(0, max);
	const until = rule.until && rule.until < to ? rule.until : to;
	let day = rule.start > from ? rule.start : from;
	if (rule.kind === 'monthly') {
		let [y, m] = day.split('-').map(Number);
		while (out.length < max) {
			const d = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(rule.day, daysInMonth(y, m))).padStart(2, '0')}`;
			if (d > until) break;
			if (d >= day && d >= rule.start) out.push(d);
			m += 1;
			if (m > 12) {
				m = 1;
				y += 1;
			}
		}
		return out;
	}
	const startMonday = mondayOf(rule.start);
	while (day <= until && out.length < max) {
		if (rule.kind === 'daily') out.push(day);
		else if (rule.days.includes(weekdayOf(day))) {
			const weeks = Math.round((Date.parse(mondayOf(day)) - Date.parse(startMonday)) / (7 * DAY_MS));
			if (weeks % rule.interval === 0) out.push(day);
		}
		day = addDays(day, 1);
	}
	return out;
}

/** The first occurrence on or after `from`, or null when the rule has ended. */
export function nextOccurrence(rule: Recurrence, from: string): string | null {
	if (rule.kind === 'dates') return [...rule.dates].sort().find((d) => d >= from) ?? null;
	// Look ahead far enough for every kind (monthly needs up to ~a year for day 31 edge cases).
	return occurrencesBetween(rule, from, addDays(from, 400), 1)[0] ?? null;
}

/** "매일", "평일", "주말", "매주 월·수·금", "격주 화·목", "매월 15일", "11월 17일·20일 (한 번씩)". */
export function describeRecurrence(rule: Recurrence): string {
	if (rule.kind === 'daily') return '매일';
	if (rule.kind === 'monthly') return `매월 ${rule.day}일`;
	if (rule.kind === 'dates') {
		const parts = rule.dates.map((d, i) => {
			const [, m, day] = d.split('-').map(Number);
			const prev = i > 0 ? Number(rule.dates[i - 1].split('-')[1]) : null;
			return `${prev === m ? '' : `${m}월 `}${day}일(${LABELS[weekdayOf(d)]})`;
		});
		return `${parts.join('·')} 한 번씩`;
	}
	const key = rule.days.join(',');
	const base = key === '0,1,2,3,4' ? '평일' : key === '5,6' ? '주말' : rule.days.map((d) => LABELS[d]).join('·');
	return rule.interval === 2 ? `격주 ${base}` : `매주 ${base}`;
}

/** Validate a rule that came from storage or a request. Returns null if it is not usable. */
export function parseRecurrence(value: unknown): Recurrence | null {
	if (!value) return null;
	let r: unknown = value;
	if (typeof value === 'string') {
		try {
			r = JSON.parse(value);
		} catch {
			return null;
		}
	}
	const o = r as Record<string, unknown>;
	const isDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
	const until = o.until === undefined || o.until === null ? null : isDay(o.until) ? o.until : undefined;
	if (until === undefined) return null;
	if (o.kind === 'daily' && isDay(o.start)) return { kind: 'daily', start: o.start, until };
	if (o.kind === 'monthly' && isDay(o.start) && Number.isInteger(o.day) && (o.day as number) >= 1 && (o.day as number) <= 31) {
		return { kind: 'monthly', day: o.day as number, start: o.start, until };
	}
	if (o.kind === 'weekly' && isDay(o.start) && (o.interval === 1 || o.interval === 2) && Array.isArray(o.days)) {
		const days = o.days.filter((d): d is Weekday => Number.isInteger(d) && d >= 0 && d <= 6);
		if (!days.length || days.length !== o.days.length) return null;
		return { kind: 'weekly', days: sortDays(days), interval: o.interval, start: o.start, until };
	}
	if (o.kind === 'dates' && Array.isArray(o.dates) && o.dates.length >= 1 && o.dates.length <= 31 && o.dates.every(isDay)) {
		return { kind: 'dates', dates: [...new Set(o.dates as string[])].sort() };
	}
	return null;
}

/**
 * A clock time stated clearly in the wording, as HH:MM: "오후 7시", "저녁 7시 30분", "아침 7시 반",
 * "19:00", "오후 7:30", "정오", "자정", "21시". A bare "7시" (morning or evening?) gives null.
 */
export function clockTimeIn(text: string | null | undefined): string | null {
	if (!text) return null;
	if (/정오/.test(text)) return '12:00';
	if (/자정/.test(text)) return '00:00';
	const pad = (n: number) => String(n).padStart(2, '0');
	const fix = (meridiem: string | undefined, h: number, m: number): string | null => {
		if (h > 24 || m > 59) return null;
		if (meridiem && /오후|저녁|밤/.test(meridiem) && h < 12) h += 12;
		else if (meridiem && /낮/.test(meridiem) && h <= 6) h += 12;
		else if (meridiem && /오전|아침|새벽/.test(meridiem) && h === 12) h = 0;
		else if (!meridiem && h < 13) return null; // ambiguous without 오전/오후
		return h === 24 ? '00:00' : `${pad(h)}:${pad(m)}`;
	};
	const colon = /(오전|오후|아침|저녁|밤|새벽|낮)?\s*(\d{1,2}):(\d{2})/.exec(text);
	if (colon) return fix(colon[1], Number(colon[2]), Number(colon[3]));
	const hour = /(오전|오후|아침|저녁|밤|새벽|낮)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?/.exec(text);
	if (hour) return fix(hour[1], Number(hour[2]), hour[3] ? Number(hour[3]) : hour[4] ? 30 : 0);
	return null;
}

const REPEAT_WORD = /매일|날마다|매주|격주|매월|매달|평일|주중|주말|마다/;

/**
 * Repeat wording the model left out of due_text. Used only when the input really says it:
 * - a repeat word or 2+ weekdays in the memo's own text that also appear in the input;
 * - for an input that became a single memo, the input itself (nothing else it could belong to).
 */
export function repeatWordingFallback(memoText: string, rawText: string, singleMemo = false): string | null {
	const word = REPEAT_WORD.exec(memoText);
	if (word && rawText.includes(word[0])) return memoText;
	const memoDays = weekdaysIn(memoText);
	if (memoDays.length >= 2) {
		const rawDays = weekdaysIn(rawText);
		if (memoDays.every((d) => rawDays.includes(d))) return memoText;
	}
	if (singleMemo && (REPEAT_WORD.test(rawText) || weekdaysIn(rawText).length >= 2)) return rawText;
	return null;
}
