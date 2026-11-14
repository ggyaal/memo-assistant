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
 * Priority-list order. A user's drag & drop order (manual_rank) always wins and
 * is never overwritten by the AI; memos nobody has placed yet follow below,
 * by AI priority, then soonest, then oldest.
 */
export function byListOrder(a: Memo, b: Memo): number {
	const aManual = a.manual_rank !== null;
	const bManual = b.manual_rank !== null;
	if (aManual !== bManual) return aManual ? -1 : 1;
	if (aManual && bManual && a.manual_rank !== b.manual_rank) return a.manual_rank! - b.manual_rank!;
	return priorityRank(a) - priorityRank(b) || bySoonest(a, b);
}

/**
 * Side-panel lists built from upcoming dated memos:
 * - reminders: not-yet-done memos the AI recommended a reminder for, soonest first;
 * - ranked: every upcoming dated memo in list order (see byListOrder).
 * Nothing is sent anywhere; this only orders what is already stored.
 */
export function buildAgenda(upcoming: Memo[], max: number, overdue: Memo[] = []): AgendaResponse {
	// A finished task needs no reminder; it stays in the priority list (struck through).
	const reminders = upcoming.filter((m) => m.reminder_recommended && !m.completed_at).sort(bySoonest).slice(0, max);
	const ranked = [...upcoming].sort(byListOrder).slice(0, max);
	return { reminders, ranked, overdue };
}
