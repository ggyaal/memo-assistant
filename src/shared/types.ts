// Types and limits shared by the React client and the Worker.

export const MEMO_CATEGORIES = ['todo', 'schedule', 'idea', 'note'] as const;
export type MemoCategory = (typeof MEMO_CATEGORIES)[number];

export const LIMITS = {
	nicknameMax: 20,
	textMax: 1000,
	memosMax: 10,
	titleMax: 60,
	contentMax: 300,
	dueTextMax: 40,
	reasonMax: 100,
	listDefault: 20,
	listMax: 50,
	bodyBytesMax: 8 * 1024,
} as const;

export interface Memo {
	id: string;
	source_id: string;
	nickname: string;
	raw_text: string;
	title: string;
	content: string;
	category: MemoCategory;
	/** Exact schedule time (UTC ISO 8601), only when the input stated one. */
	due_at: string | null;
	/** The deadline expression as written in the input. */
	due_text: string | null;
	reminder_recommended: boolean;
	reminder_reason: string | null;
	/** When the memo was saved (UTC ISO 8601). Not the schedule time. */
	created_at: string;
}

export interface CreateMemosRequest {
	nickname: string;
	text: string;
	requestId: string;
}

export interface CreateMemosResponse {
	duplicate: boolean;
	source: { id: string; nickname: string; raw_text: string; created_at: string };
	memos: Memo[];
}

export interface ListMemosResponse {
	memos: Memo[];
	nextCursor: string | null;
}

export type ApiErrorCode =
	| 'invalid_request'
	| 'forbidden_origin'
	| 'payload_too_large'
	| 'rate_limited'
	| 'daily_limit_reached'
	| 'ai_quota_exceeded'
	| 'agent_timeout'
	| 'agent_failed'
	| 'not_saved'
	| 'db_error';

export interface ApiError {
	error: ApiErrorCode;
	message: string;
}
