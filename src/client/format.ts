import type { Memo, MemoCategory, MemoPriority } from '../shared/types.ts';

/** What each category means (same wording as the AI instructions). */
export const CATEGORY_HINTS: Record<MemoCategory, string> = {
	todo: '실행하고 끝내야 하는 행동 · 마감이 있을 수 있어요 (예: 금요일까지 보고서 제출)',
	schedule: '정해진 시각에 있는 약속·행사 (예: 월요일 오전 10시 회의)',
	idea: '발전시킬 생각·기획 · 날짜는 필요할 때만',
	note: '나중에 참고할 기록·정보 · 날짜는 필요할 때만',
};

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

const kstParts = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'Asia/Seoul',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});

/** A moment as the value of an <input type="datetime-local"> in Korean time ("YYYY-MM-DDTHH:mm"). */
export function toKstInput(date: Date): string {
	const p = Object.fromEntries(kstParts.formatToParts(date).map((x) => [x.type, x.value]));
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** The value of a datetime-local input, read as Korean time, as ISO 8601 with offset. */
export function fromKstInput(value: string): string {
	return `${value}:00+09:00`;
}
