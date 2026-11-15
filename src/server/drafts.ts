// Drafts waiting for the person's answers to clarifying questions. Not memos: nothing here
// shows in lists, the calendar or reminders until it is committed (saved once).
import type { ClarifyQuestion, DraftMemo } from '../shared/clarify.ts';
import type { MemoDraftPayload } from '../shared/types.ts';
import type { MemoJob } from '../tools/save-memos.ts';

export const DRAFT_TTL_MS = 30 * 60_000;

interface DraftRow {
	id: string;
	workspace_id: string;
	request_id: string;
	source_json: string;
	memos_json: string;
	questions_json: string;
	status: 'open' | 'committing' | 'committed' | 'cancelled';
	created_at: string;
	expires_at: string;
}

export interface DraftSource {
	sourceId: string;
	nickname: string;
	rawText: string;
	createdAt: string;
	authorKeyHash: string | null;
}

export interface StoredDraft {
	id: string;
	workspaceId: string;
	requestId: string;
	source: DraftSource;
	memos: DraftMemo[];
	questions: ClarifyQuestion[];
	status: DraftRow['status'];
	expiresAt: string;
}

const toDraft = (r: DraftRow): StoredDraft => ({
	id: r.id,
	workspaceId: r.workspace_id,
	requestId: r.request_id,
	source: JSON.parse(r.source_json) as DraftSource,
	memos: JSON.parse(r.memos_json) as DraftMemo[],
	questions: JSON.parse(r.questions_json) as ClarifyQuestion[],
	status: r.status,
	expiresAt: r.expires_at,
});

/** What the screen gets: the organized memos (as drafted) and the questions. */
export const draftPayload = (d: StoredDraft): MemoDraftPayload => ({
	id: d.id,
	expiresAt: d.expiresAt,
	rawText: d.source.rawText,
	memos: d.memos,
	questions: d.questions,
});

/** Keep an organized input as a draft (one per request; a retried request reuses it). */
export async function saveDraft(db: D1Database, job: MemoJob, memos: DraftMemo[], questions: ClarifyQuestion[], now: Date): Promise<void> {
	const source: DraftSource = {
		sourceId: job.sourceId,
		nickname: job.nickname,
		rawText: job.rawText,
		createdAt: job.createdAt,
		authorKeyHash: job.authorKeyHash ?? null,
	};
	await db.batch([
		// Old, finished drafts are housekeeping only (they were never memos).
		db.prepare("DELETE FROM memo_drafts WHERE expires_at < ? AND status IN ('open', 'cancelled', 'committed')").bind(new Date(now.getTime() - 86_400_000).toISOString()),
		db
			.prepare(
				`INSERT INTO memo_drafts (id, workspace_id, request_id, source_json, memos_json, questions_json, status, created_at, expires_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
				 ON CONFLICT(workspace_id, request_id) DO NOTHING`,
			)
			.bind(
				crypto.randomUUID(),
				job.workspaceId,
				job.requestId,
				JSON.stringify(source),
				JSON.stringify(memos),
				JSON.stringify(questions),
				now.toISOString(),
				new Date(now.getTime() + DRAFT_TTL_MS).toISOString(),
			),
	]);
}

export async function getDraft(db: D1Database, workspaceId: string, id: string): Promise<StoredDraft | null> {
	const row = await db.prepare('SELECT * FROM memo_drafts WHERE id = ? AND workspace_id = ?').bind(id, workspaceId).first<DraftRow>();
	return row ? toDraft(row) : null;
}

/** The open (not expired) draft of a request, so a retried request does not call the AI again. */
export async function openDraftForRequest(db: D1Database, workspaceId: string, requestId: string, now: Date): Promise<StoredDraft | null> {
	const row = await db
		.prepare("SELECT * FROM memo_drafts WHERE workspace_id = ? AND request_id = ? AND status = 'open' AND expires_at > ?")
		.bind(workspaceId, requestId, now.toISOString())
		.first<DraftRow>();
	return row ? toDraft(row) : null;
}

/** Take the draft for committing (only one caller wins; double clicks and retries lose). */
export async function claimDraft(db: D1Database, workspaceId: string, id: string, now: Date): Promise<boolean> {
	const res = await db
		.prepare("UPDATE memo_drafts SET status = 'committing' WHERE id = ? AND workspace_id = ? AND status = 'open' AND expires_at > ?")
		.bind(id, workspaceId, now.toISOString())
		.run();
	return (res.meta.changes ?? 0) > 0;
}

export async function setDraftStatus(db: D1Database, id: string, status: 'open' | 'committed' | 'cancelled'): Promise<void> {
	await db.prepare('UPDATE memo_drafts SET status = ? WHERE id = ?').bind(status, id).run();
}

/** Discard an open draft: nothing is saved and no reminder is scheduled. */
export async function cancelDraft(db: D1Database, workspaceId: string, id: string): Promise<boolean> {
	const res = await db.prepare("UPDATE memo_drafts SET status = 'cancelled' WHERE id = ? AND workspace_id = ? AND status = 'open'").bind(id, workspaceId).run();
	return (res.meta.changes ?? 0) > 0;
}
