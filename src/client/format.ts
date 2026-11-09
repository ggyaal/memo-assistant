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
