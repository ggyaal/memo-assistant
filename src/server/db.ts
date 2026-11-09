import type { Memo, MemoCategory } from '../shared/types.ts';
import type { SanitizedMemo } from './validation.ts';

export interface SourceRecord {
	id: string;
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
	due_text: string | null;
	reminder_recommended: number;
	reminder_reason: string | null;
	position: number;
	created_at: string;
}

const MEMO_SELECT = `
	SELECT m.id, m.source_id, s.nickname, s.raw_text, m.title, m.content, m.category,
	       m.due_at, m.due_text, m.reminder_recommended, m.reminder_reason, m.position, m.created_at
	FROM memos m JOIN sources s ON s.id = m.source_id`;

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
		due_text: row.due_text,
		reminder_recommended: row.reminder_recommended === 1,
		reminder_reason: row.reminder_reason,
		created_at: row.created_at,
	};
}

export async function findSourceByRequestId(
	db: D1Database,
	requestId: string,
): Promise<{ source: SourceRecord; memos: Memo[] } | null> {
	const source = await db
		.prepare('SELECT id, nickname, raw_text, request_id, created_at FROM sources WHERE request_id = ?')
		.bind(requestId)
		.first<SourceRecord>();
	if (!source) return null;
	const { results } = await db
		.prepare(`${MEMO_SELECT} WHERE m.source_id = ? ORDER BY m.position ASC`)
		.bind(source.id)
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
			.prepare('INSERT INTO sources (id, nickname, raw_text, request_id, created_at) VALUES (?, ?, ?, ?, ?)')
			.bind(source.id, source.nickname, source.raw_text, source.request_id, source.created_at),
		...memos.map((memo, index) =>
			db
				.prepare(
					`INSERT INTO memos (id, source_id, title, content, category, due_at, due_text,
					   reminder_recommended, reminder_reason, position, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					memoIds[index],
					source.id,
					memo.title,
					memo.content,
					memo.category,
					memo.due_at,
					memo.due_text,
					memo.reminder_recommended ? 1 : 0,
					memo.reminder_reason,
					index,
					source.created_at,
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
	const where: string[] = [];
	const params: unknown[] = [];
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
		${where.length ? `WHERE ${where.join(' AND ')}` : ''}
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
