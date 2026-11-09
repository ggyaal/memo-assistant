import type { MemoCategory } from '../shared/types.ts';

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
