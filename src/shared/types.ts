// Types and limits shared by the React client and the Worker.

export const MEMO_CATEGORIES = ['todo', 'schedule', 'idea', 'note'] as const;
export type MemoCategory = (typeof MEMO_CATEGORIES)[number];

export const MEMO_PRIORITIES = ['high', 'medium', 'low'] as const;
export type MemoPriority = (typeof MEMO_PRIORITIES)[number];

export const LIMITS = {
	nicknameMax: 20,
	textMax: 1000,
	memosMax: 10,
	titleMax: 60,
	contentMax: 300,
	dueTextMax: 40,
	reasonMax: 100,
	agendaMax: 20,
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
	/** KST calendar day (YYYY-MM-DD) when the input names a day, even without a time. */
	due_date: string | null;
	/** The deadline expression as written in the input. */
	due_text: string | null;
	reminder_recommended: boolean;
	reminder_reason: string | null;
	/** AI-assigned priority; null for memos saved before priorities existed. */
	priority: MemoPriority | null;
	priority_reason: string | null;
	/** Position set by drag & drop in the priority list (shared by all visitors); null = AI order. */
	manual_rank: number | null;
	/** When the memo was checked as done (UTC ISO 8601); null = not done. Shared by all visitors. */
	completed_at: string | null;
	/** Discord reminder the owner confirmed (personal spaces only); null if none. */
	reminder: { at: string; status: ReminderStatus; error: string | null } | null;
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

export interface AgendaResponse {
	/** Upcoming memos with a recommended reminder, soonest first. */
	reminders: Memo[];
	/** Not-done memos whose deadline has passed ("지나버린 일"), most recently due first. */
	overdue: Memo[];
	/** Upcoming dated memos: user-ordered ones first (manual_rank), then by AI priority and how soon they are due. */
	ranked: Memo[];
}

export type ReminderStatus = 'scheduled' | 'sending' | 'sent' | 'failed';

export interface ReminderRequest {
	/** For memos with an exact time: 0 (on time), 10, 30 or 60 minutes before. */
	leadMinutes?: number;
	/** For date-only memos: the time of day (HH:MM, KST) to be reminded. */
	time?: string;
	/** Any reminder time the person picked (ISO 8601 with offset, e.g. "2026-11-16T14:30:00+09:00"). */
	at?: string;
	/** Where to send it. Only channels that can deliver are accepted (today: discord). */
	channels?: NotificationChannel[];
}

/**
 * A reminder must be at least this many whole minutes after the current minute:
 * up to 3 minutes ahead (and anything past) is refused, 4 minutes or more is fine.
 */
export const REMINDER_MIN_LEAD_MINUTES = 4;

/** Earliest allowed reminder time for `now` (start of the current minute + 4 minutes). */
export function earliestReminderTime(now: Date): Date {
	const minute = Math.floor(now.getTime() / 60_000) * 60_000;
	return new Date(minute + REMINDER_MIN_LEAD_MINUTES * 60_000);
}

export interface CompleteRequest {
	completed: boolean;
}

export interface ReorderRequest {
	/** Memo ids in the new top-to-bottom order of the priority list. */
	ids: string[];
}

export type NotificationChannel = 'discord' | 'kakao' | 'email';

export interface ChannelStatus {
	channel: NotificationChannel;
	label: string;
	available: boolean;
	enabled: boolean;
	/** False until real delivery (bot DM + scheduler) exists. */
	delivering: boolean;
	note: string;
	/** Discord only: the user must join the bot's server first. joined null = could not check. */
	server?: { joined: boolean | null; inviteUrl: string | null };
}

export interface SettingsResponse {
	displayName: string;
	timezone: string;
	linked: ('google' | 'discord' | 'kakao')[];
	notifications: ChannelStatus[];
	reminderDefaults: { leadMinutes: number; dateOnlyTime: string | null };
}

export interface UsageResponse {
	/** UTC day (resets 09:00 KST). `used` counts AI requests the server let through. */
	/** `neurons`/`neuronBudget`: estimated cost of memo organizing today vs. its daily budget. */
	today: { used: number; limit: number; resetsAt: string; neurons: number; neuronBudget: number };
	/** All-time AI requests since launch. */
	total: number;
	/** Voice-to-text audio seconds today (same UTC day) and the daily budget. */
	voice: { usedSeconds: number; limitSeconds: number };
}

export type ApiErrorCode =
	| 'invalid_request'
	| 'sensitive_info'
	| 'forbidden_origin'
	| 'payload_too_large'
	| 'rate_limited'
	| 'daily_limit_reached'
	| 'ai_quota_exceeded'
	| 'agent_timeout'
	| 'agent_failed'
	| 'not_saved'
	| 'not_found'
	| 'login_required'
	| 'channel_unavailable'
	| 'channel_off'
	| 'no_deadline'
	| 'past_time'
	| 'test_failed'
	| 'empty_audio'
	| 'empty_transcript'
	| 'transcribe_failed'
	| 'conflict'
	| 'cancelled'
	| 'db_error';

export interface ApiError {
	error: ApiErrorCode;
	message: string;
}

/**
 * Live progress of one "AI로 정리하기" request (POST /api/memos with
 * `Accept: text/event-stream`). Every stage is sent when that step really
 * happens on the server — never on a timer.
 * - checking: the server is validating the input (schema, sensitive data, limits)
 * - analyzing: the agent accepted the request and the model is working
 * - found: save_memos was called with `count` memos (after server sanitizing)
 * - saving: those memos are being written to D1
 */
export type MemoProgressStage = 'checking' | 'analyzing' | 'found' | 'saving';
export interface MemoProgressEvent {
	stage: MemoProgressStage;
	count?: number;
}
/** SSE `error` event: same fields as the JSON error, plus the HTTP status it stands for. */
export interface MemoStreamError extends ApiError {
	status: number;
	retryAfterSeconds?: number;
}
