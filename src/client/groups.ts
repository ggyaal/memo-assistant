import type { Memo } from '../shared/types.ts';
import { toKstInput } from './format.ts';

export type GroupBy = 'created' | 'due';

const kstDay = (iso: string) => toKstInput(new Date(iso)).slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'short' });

/** The KST day a memo belongs to: when it was registered, or its schedule day (repeating: the shown occurrence). */
export function memoDay(memo: Memo, by: GroupBy): string | null {
	if (by === 'created') return kstDay(memo.created_at);
	return memo.occurrence?.date ?? memo.due_date ?? null;
}

/**
 * Groups for the list. Registration day keeps the list order (newest first).
 * Schedule day sorts the days ascending (soonest first) with "날짜 없음" last.
 */
export function groupMemosByDay(memos: Memo[], by: GroupBy): { day: string | null; memos: Memo[] }[] {
	const groups = new Map<string | null, Memo[]>();
	for (const m of memos) {
		const day = memoDay(m, by);
		if (!groups.has(day)) groups.set(day, []);
		groups.get(day)!.push(m);
	}
	const list = [...groups].map(([day, items]) => ({ day, memos: items }));
	if (by === 'due') {
		// Plain code-point order (ISO strings); locale collation would put the "no time" marker first.
		const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
		list.sort((a, b) => (a.day === null ? 1 : b.day === null ? -1 : cmp(a.day, b.day)));
		for (const g of list) {
			g.memos.sort((a, b) => cmp(a.occurrence?.at ?? a.due_at ?? '~', b.occurrence?.at ?? b.due_at ?? '~'));
		}
	}
	return list;
}

/** "오늘 · 11월 16일 (월)", "어제 · …", "내일 · …", another year with the year; null → "날짜 없음". */
export function dayGroupLabel(day: string | null, by: GroupBy, now = new Date()): string {
	if (day === null) return by === 'due' ? '날짜 없음' : '날짜 미상';
	const today = kstDay(now.toISOString());
	const date = new Date(`${day}T00:00:00Z`);
	const label = day.slice(0, 4) === today.slice(0, 4) ? dayFmt.format(date) : `${day.slice(0, 4)}년 ${dayFmt.format(date)}`;
	const near = day === today ? '오늘' : day === addDays(today, -1) ? '어제' : day === addDays(today, 1) ? '내일' : null;
	return near ? `${near} · ${label}` : label;
}
