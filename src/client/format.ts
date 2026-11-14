import type { Memo, MemoCategory, MemoPriority } from '../shared/types.ts';

export const CATEGORY_LABELS: Record<MemoCategory, string> = {
	todo: '할 일',
	schedule: '일정',
	idea: '아이디어',
	note: '메모',
};

const dateTime = new Intl.DateTimeFormat('ko-KR', {
	timeZone: 'Asia/Seoul',
	month: 'long',
	day: 'numeric',
	weekday: 'short',
	hour: 'numeric',
	minute: '2-digit',
});

/** Format a UTC ISO timestamp in Korean time. */
export function formatKst(iso: string): string {
	return dateTime.format(new Date(iso));
}

export const PRIORITY_LABELS: Record<MemoPriority, string> = {
	high: '높음',
	medium: '보통',
	low: '낮음',
};

const dateOnly = new Intl.DateTimeFormat('ko-KR', {
	timeZone: 'Asia/Seoul',
	month: 'long',
	day: 'numeric',
	weekday: 'short',
});

/** "11월 10일 (화) 오후 3:00", or "11월 9일 (월) · 시간 미정" for a date-only deadline. */
export function formatDue(memo: Pick<Memo, 'due_at' | 'due_date'>): string | null {
	if (memo.due_at) return formatKst(memo.due_at);
	if (memo.due_date) return `${dateOnly.format(new Date(`${memo.due_date}T00:00:00+09:00`))} · 시간 미정`;
	return null;
}

const kstDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }); // → YYYY-MM-DD

/** Today's date in Korea (YYYY-MM-DD). */
export function todayKst(now = new Date()): string {
	return kstDay.format(now);
}

/**
 * Same rule as the server: a not-done memo is overdue once its exact time has
 * passed, or — for a date-only deadline — once that KST day is over.
 */
export function isOverdue(memo: Pick<Memo, 'due_at' | 'due_date' | 'completed_at'>, now = new Date()): boolean {
	if (memo.completed_at) return false;
	if (memo.due_at) return Date.parse(memo.due_at) <= now.getTime();
	if (memo.due_date) return memo.due_date < todayKst(now);
	return false;
}

/** "3일 지남", "오늘 지남" for an overdue memo. */
export function overdueLabel(memo: Pick<Memo, 'due_at' | 'due_date'>, now = new Date()): string {
	const dueDay = memo.due_at ? todayKst(new Date(memo.due_at)) : memo.due_date;
	if (!dueDay) return '';
	const days = Math.round((Date.parse(`${todayKst(now)}T00:00:00Z`) - Date.parse(`${dueDay}T00:00:00Z`)) / 86_400_000);
	return days <= 0 ? '오늘 지남' : `${days}일 지남`;
}
