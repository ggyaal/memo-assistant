import type { AgendaResponse, Memo, MemoPriority } from '../shared/types.ts';

const PRIORITY_RANK: Record<MemoPriority, number> = { high: 0, medium: 1, low: 2 };
// Memos saved before priorities existed rank like "medium".
const UNSET_RANK = 1;

/**
 * When a memo is due, as epoch ms. A date-only deadline counts from the start
 * of that KST day, so "오늘 장 보기" sorts before anything timed later today.
 */
export function dueInstant(memo: Pick<Memo, 'due_at' | 'due_date'>): number {
	if (memo.due_at) return Date.parse(memo.due_at);
	if (memo.due_date) return Date.parse(`${memo.due_date}T00:00:00+09:00`);
	return Number.POSITIVE_INFINITY;
}

function bySoonest(a: Memo, b: Memo): number {
	return dueInstant(a) - dueInstant(b) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

function priorityRank(memo: Memo): number {
	return memo.priority ? PRIORITY_RANK[memo.priority] : UNSET_RANK;
}

/**
 * Side-panel lists built from upcoming dated memos:
 * - reminders: memos the AI recommended a reminder for, soonest first;
 * - ranked: every upcoming dated memo, by AI priority, then soonest, then oldest.
 * Nothing is sent anywhere; this only orders what is already stored.
 */
export function buildAgenda(upcoming: Memo[], max: number): AgendaResponse {
	const reminders = upcoming.filter((m) => m.reminder_recommended).sort(bySoonest).slice(0, max);
	const ranked = [...upcoming].sort((a, b) => priorityRank(a) - priorityRank(b) || bySoonest(a, b)).slice(0, max);
	return { reminders, ranked };
}
