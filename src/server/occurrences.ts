// Occurrences of repeating memos: expanded from the stored rule with calendar math,
// joined with per-occurrence done states. No AI is involved.
import { addDays, nextOccurrence, occurrencesBetween, type Recurrence } from '../shared/recurrence.ts';
import type { Memo, MemoOccurrence } from '../shared/types.ts';
import { kstDate } from './time.ts';

const KST_MS = 9 * 3600_000;

/** HH:MM (KST) of an instant. */
export const kstTime = (isoUtc: string) => new Date(Date.parse(isoUtc) + KST_MS).toISOString().slice(11, 16);

/** The exact time of one occurrence, when the memo has a time of day; else null. */
export function occurrenceAt(memo: Pick<Memo, 'due_at'>, day: string): string | null {
	return memo.due_at ? new Date(`${day}T${kstTime(memo.due_at)}:00+09:00`).toISOString() : null;
}

/** Done states of the given repeating memos between two days: memoId → (day → completed_at). */
export async function loadDone(db: D1Database, memoIds: string[], from: string, to: string): Promise<Map<string, Map<string, string>>> {
	const out = new Map<string, Map<string, string>>();
	if (!memoIds.length) return out;
	const { results } = await db
		.prepare(
			`SELECT memo_id, occurrence_date, completed_at FROM memo_occurrences
			 WHERE memo_id IN (${memoIds.map(() => '?').join(',')}) AND occurrence_date BETWEEN ? AND ?`,
		)
		.bind(...memoIds, from, to)
		.all<{ memo_id: string; occurrence_date: string; completed_at: string }>();
	for (const r of results) {
		if (!out.has(r.memo_id)) out.set(r.memo_id, new Map());
		out.get(r.memo_id)!.set(r.occurrence_date, r.completed_at);
	}
	return out;
}

/** One copy of a memo per occurrence between `from` and `to` (KST days, inclusive). */
export function expand(memo: Memo, from: string, to: string, done: Map<string, string> | undefined): Memo[] {
	if (!memo.recurrence) return [];
	return occurrencesBetween(memo.recurrence, from, to, 62).map((date) => ({
		...memo,
		occurrence: { date, at: occurrenceAt(memo, date), completed_at: done?.get(date) ?? null },
	}));
}

/**
 * The occurrence a list or agenda should show: the first one still ahead (time not passed,
 * or today for date-only) that is not done yet. Null when the rule has ended.
 */
export function upcomingOccurrence(memo: Memo, now: Date, done: Map<string, string> | undefined): MemoOccurrence | null {
	if (!memo.recurrence) return null;
	const today = kstDate(now);
	let day: string | null = today;
	for (let i = 0; i < 400 && day; i++) {
		day = nextOccurrence(memo.recurrence, day);
		if (!day) return null;
		const at = occurrenceAt(memo, day);
		const ahead = at ? Date.parse(at) > now.getTime() : day >= today;
		if (ahead && !done?.has(day)) return { date: day, at, completed_at: null };
		day = addDays(day, 1);
	}
	return null;
}

/** Attach the upcoming occurrence to every repeating memo in a list (others unchanged). */
export async function withUpcoming(db: D1Database, memos: Memo[], now: Date): Promise<Memo[]> {
	const repeating = memos.filter((m) => m.recurrence);
	if (!repeating.length) return memos;
	const today = kstDate(now);
	const done = await loadDone(db, repeating.map((m) => m.id), today, addDays(today, 400));
	return memos.map((m) => {
		if (!m.recurrence) return m;
		const occurrence = upcomingOccurrence(m, now, done.get(m.id));
		return occurrence ? { ...m, occurrence } : m;
	});
}

/** Is `day` really an occurrence of this rule? (Guards the per-occurrence done API.) */
export function isOccurrence(rule: Recurrence, day: string): boolean {
	return occurrencesBetween(rule, day, day, 1).length === 1;
}
