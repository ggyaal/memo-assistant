import type { Memo, MemoCategory, MemoPriority, ReminderStatus } from '../shared/types.ts';
import { parseRecurrence, type RecurrenceQuestion } from '../shared/recurrence.ts';
import type { SanitizedMemo } from './validation.ts';

function parseQuestion(value: string | null): RecurrenceQuestion | null {
	if (!value) return null;
	try {
		const q = JSON.parse(value) as { repeat?: unknown; once?: unknown };
		const repeat = parseRecurrence(q.repeat);
		const once = parseRecurrence(q.once);
		return repeat && once?.kind === 'dates' ? { repeat, once } : null;
	} catch {
		return null;
	}
}

export interface SourceRecord {
	id: string;
	/** Set by the server from the session; never taken from the request or the model. */
	workspace_id: string;
	nickname: string;
	raw_text: string;
	request_id: string;
	created_at: string;
}

interface MemoRow {
	id: string;
	source_id: string;
	nickname: string;
	raw_text: string;
	title: string;
	content: string;
	category: MemoCategory;
	due_at: string | null;
	due_date: string | null;
	due_text: string | null;
	reminder_recommended: number;
	reminder_reason: string | null;
	priority: MemoPriority | null;
	priority_reason: string | null;
	manual_rank: number | null;
	completed_at: string | null;
	reminder_at: string | null;
	reminder_status: ReminderStatus | null;
	reminder_error: string | null;
	recurrence: string | null;
	recurrence_question: string | null;
	position: number;
	created_at: string;
}

const MEMO_SELECT = `
	SELECT m.id, m.source_id, s.nickname, s.raw_text, m.title, m.content, m.category,
	       m.due_at, m.due_date, m.due_text, m.reminder_recommended, m.reminder_reason,
	       m.priority, m.priority_reason, m.manual_rank, m.completed_at, m.position, m.created_at,
	       m.recurrence, m.recurrence_question,
	       n.scheduled_at AS reminder_at, n.status AS reminder_status, n.last_error AS reminder_error
	FROM memos m JOIN sources s ON s.id = m.source_id
	LEFT JOIN notifications n ON n.memo_id = m.id AND n.channel = 'discord' AND n.status <> 'canceled'`;

function toMemo(row: MemoRow): Memo {
	return {
		id: row.id,
		source_id: row.source_id,
		nickname: row.nickname,
		raw_text: row.raw_text,
		title: row.title,
		content: row.content,
		category: row.category,
		due_at: row.due_at,
		due_date: row.due_date,
		due_text: row.due_text,
		reminder_recommended: row.reminder_recommended === 1,
		reminder_reason: row.reminder_reason,
		priority: row.priority,
		priority_reason: row.priority_reason,
		manual_rank: row.manual_rank,
		completed_at: row.completed_at,
		reminder: row.reminder_at && row.reminder_status ? { at: row.reminder_at, status: row.reminder_status, error: row.reminder_error } : null,
		recurrence: parseRecurrence(row.recurrence),
		recurrence_question: parseQuestion(row.recurrence_question),
		created_at: row.created_at,
	};
}

export async function findSourceByRequestId(
	db: D1Database,
	workspaceId: string,
	requestId: string,
): Promise<{ source: SourceRecord; memos: Memo[] } | null> {
	const source = await db
		.prepare('SELECT id, workspace_id, nickname, raw_text, request_id, created_at FROM sources WHERE request_id = ? AND workspace_id = ?')
		.bind(requestId, workspaceId)
		.first<SourceRecord>();
	if (!source) return null;
	const { results } = await db
		.prepare(`${MEMO_SELECT} WHERE m.source_id = ? AND m.workspace_id = ? AND m.deleted_at IS NULL ORDER BY m.position ASC`)
		.bind(source.id, workspaceId)
		.all<MemoRow>();
	return { source, memos: results.map(toMemo) };
}

export type SaveResult = { status: 'saved'; memoIds: string[] } | { status: 'duplicate' };

/**
 * Store one source and its memos atomically (D1 batch = one transaction).
 * A repeated request_id hits the UNIQUE constraint, the whole batch rolls back,
 * and the call reports a duplicate instead of creating rows twice.
 */
export async function saveSourceWithMemos(
	db: D1Database,
	source: SourceRecord,
	memos: SanitizedMemo[],
	newId: () => string = () => crypto.randomUUID(),
): Promise<SaveResult> {
	const memoIds = memos.map(() => newId());
	const statements = [
		db
			.prepare('INSERT INTO sources (id, workspace_id, nickname, raw_text, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
			.bind(source.id, source.workspace_id, source.nickname, source.raw_text, source.request_id, source.created_at),
		...memos.map((memo, index) =>
			db
				.prepare(
					`INSERT INTO memos (id, source_id, workspace_id, title, content, category, due_at, due_date, due_text,
					   reminder_recommended, reminder_reason, priority, priority_reason, position, created_at, recurrence, recurrence_question)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					memoIds[index],
					source.id,
					source.workspace_id,
					memo.title,
					memo.content,
					memo.category,
					memo.due_at,
					memo.due_date,
					memo.due_text,
					memo.reminder_recommended ? 1 : 0,
					memo.reminder_reason,
					memo.priority,
					memo.priority_reason,
					index,
					source.created_at,
					memo.recurrence ? JSON.stringify(memo.recurrence) : null,
					memo.recurrence_question ? JSON.stringify(memo.recurrence_question) : null,
				),
		),
	];
	try {
		await db.batch(statements);
		return { status: 'saved', memoIds };
	} catch (error) {
		if (String(error).includes('UNIQUE constraint failed')) return { status: 'duplicate' };
		throw error;
	}
}

export interface ListOptions {
	workspaceId: string;
	range?: { start: string; end: string };
	category?: MemoCategory;
	nickname?: string;
	cursor?: string;
	limit: number;
}

interface Cursor {
	c: string; // created_at
	s: string; // source_id
	p: number; // position
}

export function encodeCursor(row: { created_at: string; source_id: string; position: number }): string {
	return btoa(JSON.stringify({ c: row.created_at, s: row.source_id, p: row.position } satisfies Cursor));
}

export function decodeCursor(value: string): Cursor | null {
	try {
		const parsed = JSON.parse(atob(value)) as Cursor;
		if (typeof parsed.c === 'string' && typeof parsed.s === 'string' && Number.isInteger(parsed.p)) return parsed;
	} catch {
		// fall through
	}
	return null;
}

/** Newest first; memos from the same input stay in their original order. */
export async function listMemos(
	db: D1Database,
	options: ListOptions,
): Promise<{ memos: Memo[]; nextCursor: string | null }> {
	const where: string[] = ['m.workspace_id = ?', 'm.deleted_at IS NULL'];
	const params: unknown[] = [options.workspaceId];
	if (options.range) {
		where.push('m.created_at >= ? AND m.created_at < ?');
		params.push(options.range.start, options.range.end);
	}
	if (options.category) {
		where.push('m.category = ?');
		params.push(options.category);
	}
	if (options.nickname) {
		where.push('s.nickname = ?');
		params.push(options.nickname);
	}
	const cursor = options.cursor ? decodeCursor(options.cursor) : null;
	if (cursor) {
		where.push(
			'(m.created_at < ? OR (m.created_at = ? AND m.source_id < ?) OR (m.created_at = ? AND m.source_id = ? AND m.position > ?))',
		);
		params.push(cursor.c, cursor.c, cursor.s, cursor.c, cursor.s, cursor.p);
	}
	const sql = `${MEMO_SELECT}
		WHERE ${where.join(' AND ')}
		ORDER BY m.created_at DESC, m.source_id DESC, m.position ASC
		LIMIT ?`;
	const { results } = await db
		.prepare(sql)
		.bind(...params, options.limit + 1)
		.all<MemoRow>();
	const page = results.slice(0, options.limit);
	const last = page.at(-1);
	return {
		memos: page.map(toMemo),
		nextCursor: results.length > options.limit && last ? encodeCursor(last) : null,
	};
}

/**
 * Upcoming dated memos: an exact time still ahead, or a date-only deadline on
 * or after today's KST date. Bounded so the in-memory ranking stays cheap.
 */
export async function listUpcoming(db: D1Database, workspaceId: string, now: Date, todayKst: string, max = 200): Promise<Memo[]> {
	const { results } = await db
		.prepare(
			`${MEMO_SELECT}
			 WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND m.recurrence IS NULL
			   AND ((m.due_at IS NOT NULL AND m.due_at > ?)
			     OR (m.due_at IS NULL AND m.due_date IS NOT NULL AND m.due_date >= ?))
			 ORDER BY COALESCE(m.due_at, m.due_date) ASC
			 LIMIT ?`,
		)
		.bind(workspaceId, now.toISOString(), todayKst, max)
		.all<MemoRow>();
	return results.map(toMemo);
}

/**
 * Persist a drag & drop order: the i-th id gets manual_rank i (one atomic batch).
 * Returns how many of the ids exist; unknown ids are ignored.
 */
export async function saveManualOrder(db: D1Database, workspaceId: string, ids: string[]): Promise<number> {
	const results = await db.batch(
		ids.map((id, index) =>
			db.prepare('UPDATE memos SET manual_rank = ? WHERE id = ? AND workspace_id = ?').bind(index, id, workspaceId),
		),
	);
	return results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}

/** Check or uncheck a memo as done. Returns the updated memo, or null if it does not exist. */
export async function setCompleted(
	db: D1Database,
	workspaceId: string,
	id: string,
	completed: boolean,
	now: Date,
): Promise<Memo | null> {
	const result = await db
		.prepare('UPDATE memos SET completed_at = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL')
		.bind(completed ? now.toISOString() : null, id, workspaceId)
		.run();
	if (!result.meta.changes) return null;
	const row = await db.prepare(`${MEMO_SELECT} WHERE m.id = ? AND m.workspace_id = ?`).bind(id, workspaceId).first<MemoRow>();
	return row ? toMemo(row) : null;
}

/*
 * "Overdue" = has a deadline, the deadline has passed, and it is not done.
 * - exact time (due_at, UTC): passed once due_at <= now;
 * - date only (due_date, KST day): passed once that KST day is over (due_date < today).
 * This is the exact complement of listUpcoming for dated memos; no data is copied.
 */
// Repeating memos never become "overdue" as a whole; their missed occurrences show in the calendar.
const OVERDUE_WHERE = `m.workspace_id = ? AND m.deleted_at IS NULL AND m.completed_at IS NULL AND m.recurrence IS NULL
	AND ((m.due_at IS NOT NULL AND m.due_at <= ?)
	  OR (m.due_at IS NULL AND m.due_date IS NOT NULL AND m.due_date < ?))`;

/** Overdue, not-done memos; most recently due first. */
export async function listOverdue(db: D1Database, workspaceId: string, now: Date, todayKst: string, max = 50): Promise<Memo[]> {
	const { results } = await db
		.prepare(`${MEMO_SELECT} WHERE ${OVERDUE_WHERE} ORDER BY COALESCE(m.due_at, m.due_date) DESC LIMIT ?`)
		.bind(workspaceId, now.toISOString(), todayKst, max)
		.all<MemoRow>();
	return results.map(toMemo);
}

export type DeleteResult = 'deleted' | 'not_found' | 'not_overdue';

/**
 * Hide an overdue, not-done memo (soft delete). Anything else is refused,
 * so the shared board cannot be emptied through this endpoint.
 */
export async function deleteOverdueMemo(
	db: D1Database,
	workspaceId: string,
	id: string,
	now: Date,
	todayKst: string,
): Promise<DeleteResult> {
	const result = await db
		.prepare(`UPDATE memos AS m SET deleted_at = ? WHERE m.id = ? AND ${OVERDUE_WHERE}`)
		.bind(now.toISOString(), id, workspaceId, now.toISOString(), todayKst)
		.run();
	if (result.meta.changes) return 'deleted';
	const exists = await db
		.prepare('SELECT 1 FROM memos WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL')
		.bind(id, workspaceId)
		.first();
	return exists ? 'not_overdue' : 'not_found';
}

export interface MemoEdit {
	title: string;
	content: string;
	category: MemoCategory;
	priority: MemoPriority | null;
	/** UTC ISO when a time was given, else null. */
	due_at: string | null;
	/** KST day, else null. */
	due_date: string | null;
}

/**
 * Save a person's corrections to one memo in this workspace. When the deadline
 * changes, the AI's original wording (due_text) no longer describes it and is cleared.
 * Returns the previous deadline (for reminders) and the updated memo, or null if not found.
 */
export async function updateMemo(
	db: D1Database,
	workspaceId: string,
	id: string,
	edit: MemoEdit,
): Promise<{ memo: Memo; previousDueAt: string | null; dueChanged: boolean } | null> {
	const before = await db
		.prepare('SELECT due_at, due_date FROM memos WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL')
		.bind(id, workspaceId)
		.first<{ due_at: string | null; due_date: string | null }>();
	if (!before) return null;
	const dueChanged = before.due_at !== edit.due_at || before.due_date !== edit.due_date;
	await db
		.prepare(
			`UPDATE memos SET title = ?, content = ?, category = ?, priority = ?, due_at = ?, due_date = ?,
			   due_text = CASE WHEN ? THEN NULL ELSE due_text END
			 WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
		)
		.bind(edit.title, edit.content, edit.category, edit.priority, edit.due_at, edit.due_date, dueChanged ? 1 : 0, id, workspaceId)
		.run();
	const row = await db.prepare(`${MEMO_SELECT} WHERE m.id = ? AND m.workspace_id = ?`).bind(id, workspaceId).first<MemoRow>();
	return row ? { memo: toMemo(row), previousDueAt: before.due_at, dueChanged } : null;
}

/** Not-done ideas, newest first (side panel "아이디어 목록"). */
export async function listIdeas(db: D1Database, workspaceId: string, max = 20): Promise<Memo[]> {
	const { results } = await db
		.prepare(
			`${MEMO_SELECT}
			 WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND m.completed_at IS NULL AND m.category = 'idea'
			 ORDER BY m.created_at DESC, m.position ASC
			 LIMIT ?`,
		)
		.bind(workspaceId, max)
		.all<MemoRow>();
	return results.map(toMemo);
}

export async function getMemo(db: D1Database, workspaceId: string, id: string): Promise<Memo | null> {
	const row = await db.prepare(`${MEMO_SELECT} WHERE m.id = ? AND m.workspace_id = ? AND m.deleted_at IS NULL`).bind(id, workspaceId).first<MemoRow>();
	return row ? toMemo(row) : null;
}

/**
 * Memos with a deadline/schedule day in [from, to] (KST days, inclusive) for the
 * calendar. Uses the stored KST day (due_date), never created_at; hidden memos excluded.
 */
export async function listCalendar(db: D1Database, workspaceId: string, from: string, to: string, max = 500): Promise<Memo[]> {
	const { results } = await db
		.prepare(
			`${MEMO_SELECT}
			 WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND m.recurrence IS NULL AND m.due_date IS NOT NULL AND m.due_date BETWEEN ? AND ?
			 ORDER BY m.due_date ASC, (m.due_at IS NOT NULL) ASC, m.due_at ASC, m.created_at ASC, m.position ASC
			 LIMIT ?`,
		)
		.bind(workspaceId, from, to, max)
		.all<MemoRow>();
	return results.map(toMemo);
}

/** Repeating memos of a workspace (expanded into occurrences by the caller). */
export async function listRepeating(db: D1Database, workspaceId: string, max = 200): Promise<Memo[]> {
	const { results } = await db
		.prepare(`${MEMO_SELECT} WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND m.recurrence IS NOT NULL ORDER BY m.created_at ASC LIMIT ?`)
		.bind(workspaceId, max)
		.all<MemoRow>();
	return results.map(toMemo);
}

/** Check or uncheck one occurrence of a repeating memo (the memo must be in this workspace). */
export async function setOccurrenceDone(db: D1Database, memoId: string, day: string, completed: boolean, now: Date): Promise<string | null> {
	if (completed) {
		const at = now.toISOString();
		await db
			.prepare('INSERT INTO memo_occurrences (memo_id, occurrence_date, completed_at) VALUES (?, ?, ?) ON CONFLICT(memo_id, occurrence_date) DO NOTHING')
			.bind(memoId, day, at)
			.run();
		const row = await db.prepare('SELECT completed_at FROM memo_occurrences WHERE memo_id = ? AND occurrence_date = ?').bind(memoId, day).first<{ completed_at: string }>();
		return row?.completed_at ?? at;
	}
	await db.prepare('DELETE FROM memo_occurrences WHERE memo_id = ? AND occurrence_date = ?').bind(memoId, day).run();
	return null;
}

/** Store a repeat rule (or none) and drop the open question. */
export async function setRecurrence(db: D1Database, workspaceId: string, id: string, rule: unknown | null, first: { due_date: string; due_at: string | null } | null): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE memos SET recurrence = ?, recurrence_question = NULL,
			   due_date = COALESCE(?, due_date), due_at = CASE WHEN ? THEN ? ELSE due_at END
			 WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
		)
		.bind(rule ? JSON.stringify(rule) : null, first?.due_date ?? null, first ? 1 : 0, first?.due_at ?? null, id, workspaceId)
		.run();
	return (res.meta.changes ?? 0) > 0;
}
