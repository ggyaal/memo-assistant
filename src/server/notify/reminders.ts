// Reminders: confirmed by the user per memo, delivered by the cron dispatcher.
import { sendDiscordDm } from './discord.ts';

export const LEAD_OPTIONS = [0, 10, 30, 60] as const;
const MAX_ATTEMPTS = 3;
/** Don't deliver a reminder this late (e.g. after an outage): stale news is noise. */
const TOO_LATE_MS = 60 * 60 * 1000;
/** A row stuck in 'sending' this long had an unknown outcome; never resend it (no duplicates). */
const STUCK_SENDING_MS = 10 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface NotifyEnv {
	DB: D1Database;
	DISCORD_BOT_TOKEN?: string;
}

/** Discord user id of the user's linked Discord account, if any. */
export async function discordRecipient(db: D1Database, userId: string): Promise<string | null> {
	const row = await db
		.prepare("SELECT provider_subject FROM oauth_accounts WHERE user_id = ? AND provider = 'discord' ORDER BY created_at LIMIT 1")
		.bind(userId)
		.first<{ provider_subject: string }>();
	return row?.provider_subject ?? null;
}

/** On + verified by a delivered test DM. */
export async function discordReady(db: D1Database, userId: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT enabled, verified_at FROM notification_preferences WHERE user_id = ? AND channel = 'discord'")
		.bind(userId)
		.first<{ enabled: number; verified_at: string | null }>();
	return !!row && row.enabled === 1 && !!row.verified_at;
}

function kstLabel(iso: string, withTime: boolean): string {
	return new Intl.DateTimeFormat('ko-KR', {
		timeZone: 'Asia/Seoul',
		month: 'long',
		day: 'numeric',
		weekday: 'short',
		...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
	}).format(new Date(iso));
}

export function reminderMessage(memo: { title: string; due_at: string | null; due_date: string | null }, leadMinutes: number | null): string {
	const title = memo.title.replace(/[\r\n]+/g, ' ').slice(0, 60);
	if (memo.due_at && leadMinutes !== null) {
		const when = kstLabel(memo.due_at, true);
		const lead = leadMinutes === 0 ? '지금' : leadMinutes === 60 ? '1시간 뒤' : `${leadMinutes}분 뒤`;
		return `메모비서 🔔 ${lead} '${title}' 시간이에요. (${when})`;
	}
	const day = memo.due_date ? kstLabel(`${memo.due_date}T00:00:00+09:00`, false) : '';
	return `메모비서 🔔 '${title}' 잊지 마세요.${day ? ` (${day})` : ''}`;
}

export type SetReminderResult =
	| { ok: true; scheduledAt: string }
	| { ok: false; status: 404 | 409 | 422; code: string; message: string };

/**
 * Confirm a reminder for one personal memo. Exact-time memos take a lead time;
 * date-only memos need an explicit time of day (never an invented one).
 */
export async function setReminder(
	db: D1Database,
	params: { userId: string; workspaceId: string; memoId: string; leadMinutes?: number; time?: string },
	now: Date,
): Promise<SetReminderResult> {
	const memo = await db
		.prepare('SELECT id, due_at, due_date, completed_at FROM memos WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL')
		.bind(params.memoId, params.workspaceId)
		.first<{ id: string; due_at: string | null; due_date: string | null; completed_at: string | null }>();
	if (!memo) return { ok: false, status: 404, code: 'not_found', message: '메모를 찾지 못했어요.' };
	if (memo.completed_at) return { ok: false, status: 409, code: 'conflict', message: '완료한 메모에는 알림을 걸 수 없어요.' };
	if (!(await discordReady(db, params.userId))) {
		return { ok: false, status: 409, code: 'channel_off', message: '설정에서 Discord 알림을 먼저 켜 주세요(테스트 DM 성공 필요).' };
	}

	let scheduledAt: string;
	let lead: number | null;
	// Missing choices fall back to the user's own defaults (never an invented time).
	const defaults = await getReminderDefaults(db, params.userId);
	if (params.leadMinutes === undefined && memo.due_at) params = { ...params, leadMinutes: defaults.leadMinutes };
	if (params.time === undefined && !memo.due_at && defaults.dateOnlyTime) params = { ...params, time: defaults.dateOnlyTime };
	if (memo.due_at) {
		if (params.leadMinutes === undefined || !(LEAD_OPTIONS as readonly number[]).includes(params.leadMinutes)) {
			return { ok: false, status: 422, code: 'invalid_request', message: '알림 시점을 골라 주세요(정시·10분·30분·1시간 전).' };
		}
		lead = params.leadMinutes;
		scheduledAt = new Date(Date.parse(memo.due_at) - lead * 60_000).toISOString();
	} else if (memo.due_date) {
		if (!params.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(params.time)) {
			return { ok: false, status: 422, code: 'invalid_request', message: '날짜만 있는 메모라 알림 받을 시각(HH:MM)을 골라 주세요.' };
		}
		lead = null;
		scheduledAt = new Date(Date.parse(`${memo.due_date}T${params.time}:00+09:00`)).toISOString();
	} else {
		return { ok: false, status: 422, code: 'no_deadline', message: '기한이 없는 메모에는 알림을 걸 수 없어요.' };
	}
	if (Date.parse(scheduledAt) <= now.getTime() + 60_000) {
		return { ok: false, status: 422, code: 'past_time', message: '이미 지났거나 너무 가까운 시각이에요. 다른 시점을 골라 주세요.' };
	}

	const nowIso = now.toISOString();
	await db
		.prepare(
			`INSERT INTO notifications (id, user_id, workspace_id, memo_id, channel, scheduled_at, lead_minutes, status, attempts, next_attempt_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'discord', ?, ?, 'scheduled', 0, ?, ?, ?)
			 ON CONFLICT(memo_id, channel) DO UPDATE SET
			   scheduled_at = excluded.scheduled_at, lead_minutes = excluded.lead_minutes, status = 'scheduled',
			   attempts = 0, next_attempt_at = excluded.next_attempt_at, last_error = NULL, sent_at = NULL, updated_at = excluded.updated_at`,
		)
		.bind(crypto.randomUUID(), params.userId, params.workspaceId, memo.id, scheduledAt, lead, scheduledAt, nowIso, nowIso)
		.run();
	return { ok: true, scheduledAt };
}

export async function cancelReminder(db: D1Database, userId: string, memoId: string, now: Date): Promise<boolean> {
	const res = await db
		.prepare("UPDATE notifications SET status = 'canceled', updated_at = ? WHERE memo_id = ? AND user_id = ? AND status IN ('scheduled', 'failed')")
		.bind(now.toISOString(), memoId, userId)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

export interface DispatchSummary {
	sent: number;
	retried: number;
	failed: number;
	canceled: number;
}

async function finish(db: D1Database, id: string, status: 'sent' | 'failed' | 'canceled', error: string | null, now: Date) {
	await db
		.prepare('UPDATE notifications SET status = ?, last_error = ?, sent_at = ?, updated_at = ? WHERE id = ?')
		.bind(status, error, status === 'sent' ? now.toISOString() : null, now.toISOString(), id)
		.run();
}

/**
 * Cron entry: deliver reminders that are due. Each row is claimed with a
 * conditional UPDATE (scheduled → sending), so overlapping runs never send twice.
 * Everything is re-checked right before sending.
 */
export async function runDueReminders(env: NotifyEnv, now: Date, fetchFn: typeof fetch, max = 10): Promise<DispatchSummary> {
	const db = env.DB;
	const nowIso = now.toISOString();
	const summary: DispatchSummary = { sent: 0, retried: 0, failed: 0, canceled: 0 };

	// Unknown outcome (crash mid-send): give up rather than risk a duplicate DM.
	await db
		.prepare("UPDATE notifications SET status = 'failed', last_error = 'unknown_outcome', updated_at = ? WHERE status = 'sending' AND updated_at <= ?")
		.bind(nowIso, new Date(now.getTime() - STUCK_SENDING_MS).toISOString())
		.run();

	const { results: due } = await db
		.prepare("SELECT id FROM notifications WHERE status = 'scheduled' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?")
		.bind(nowIso, max)
		.all<{ id: string }>();

	for (const { id } of due) {
		const claim = await db
			.prepare("UPDATE notifications SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'scheduled'")
			.bind(nowIso, id)
			.run();
		if (!claim.meta.changes) continue; // another run took it

		const row = await db
			.prepare(
				`SELECT n.user_id, n.scheduled_at, n.lead_minutes, n.attempts, m.title, m.due_at, m.due_date, m.completed_at, m.deleted_at,
				        (m.workspace_id = n.workspace_id AND w.owner_user_id = n.user_id) AS owned
				 FROM notifications n
				 JOIN memos m ON m.id = n.memo_id
				 LEFT JOIN workspaces w ON w.id = n.workspace_id
				 WHERE n.id = ?`,
			)
			.bind(id)
			.first<{
				user_id: string; scheduled_at: string; lead_minutes: number | null; attempts: number;
				title: string; due_at: string | null; due_date: string | null; completed_at: string | null; deleted_at: string | null; owned: number;
			}>();
		if (!row || !row.owned || row.deleted_at || row.completed_at) {
			await finish(db, id, 'canceled', row?.completed_at ? 'memo_completed' : 'memo_unavailable', now);
			summary.canceled++;
			continue;
		}
		if (now.getTime() - Date.parse(row.scheduled_at) > TOO_LATE_MS) {
			await finish(db, id, 'failed', 'too_late', now);
			summary.failed++;
			continue;
		}
		const recipient = await discordRecipient(db, row.user_id);
		if (!recipient || !(await discordReady(db, row.user_id))) {
			await finish(db, id, 'canceled', 'channel_off', now);
			summary.canceled++;
			continue;
		}
		if (!env.DISCORD_BOT_TOKEN) {
			await finish(db, id, 'failed', 'bot_not_configured', now);
			summary.failed++;
			continue;
		}

		const result = await sendDiscordDm(env.DISCORD_BOT_TOKEN, recipient, reminderMessage(row, row.lead_minutes), fetchFn);
		if (result.ok) {
			await finish(db, id, 'sent', null, now);
			summary.sent++;
		} else if (result.retryable && row.attempts < MAX_ATTEMPTS) {
			const waitMs = Math.max((result.retryAfterSeconds ?? 0) * 1000, 2 ** row.attempts * 60_000);
			await db
				.prepare("UPDATE notifications SET status = 'scheduled', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
				.bind(new Date(now.getTime() + waitMs).toISOString(), result.code, nowIso, id)
				.run();
			summary.retried++;
		} else {
			await finish(db, id, 'failed', result.code, now);
			summary.failed++;
		}
	}
	return summary;
}

// ---- Automatic reminders for AI-recommended memos --------------------------------------

export interface ReminderDefaults {
	/** For memos with an exact time. */
	leadMinutes: number;
	/** HH:MM (KST) for date-only memos; null = do not auto-schedule them. */
	dateOnlyTime: string | null;
}

export async function getReminderDefaults(db: D1Database, userId: string): Promise<ReminderDefaults> {
	const row = await db
		.prepare('SELECT default_lead_minutes, date_only_time FROM users WHERE id = ?')
		.bind(userId)
		.first<{ default_lead_minutes: number; date_only_time: string | null }>();
	return { leadMinutes: row?.default_lead_minutes ?? 30, dateOnlyTime: row?.date_only_time ?? null };
}

export async function setReminderDefaults(db: D1Database, userId: string, defaults: ReminderDefaults): Promise<void> {
	await db
		.prepare('UPDATE users SET default_lead_minutes = ?, date_only_time = ? WHERE id = ?')
		.bind(defaults.leadMinutes, defaults.dateOnlyTime, userId)
		.run();
}

/**
 * Schedule a Discord reminder for every upcoming, not-done memo the AI marked
 * "reminder recommended" in the user's personal workspace — using the user's
 * own defaults. Memos that already have a reminder row (including one the user
 * turned off) are left alone, so "off" stays off. Returns how many were added.
 */
export async function autoScheduleRecommended(
	db: D1Database,
	params: { userId: string; workspaceId: string },
	now: Date,
): Promise<number> {
	if (!(await discordReady(db, params.userId))) return 0;
	const defaults = await getReminderDefaults(db, params.userId);
	const { results } = await db
		.prepare(
			`SELECT m.id, m.due_at, m.due_date FROM memos m
			 WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND m.completed_at IS NULL AND m.reminder_recommended = 1
			   AND (m.due_at IS NOT NULL OR m.due_date IS NOT NULL)
			   AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.memo_id = m.id AND n.channel = 'discord')`,
		)
		.bind(params.workspaceId)
		.all<{ id: string; due_at: string | null; due_date: string | null }>();

	const earliest = now.getTime() + 60_000;
	const nowIso = now.toISOString();
	const inserts: D1PreparedStatement[] = [];
	for (const memo of results) {
		let at: number;
		let lead: number | null;
		if (memo.due_at) {
			lead = defaults.leadMinutes;
			at = Date.parse(memo.due_at) - lead * 60_000;
		} else if (memo.due_date && defaults.dateOnlyTime) {
			lead = null;
			at = Date.parse(`${memo.due_date}T${defaults.dateOnlyTime}:00+09:00`);
		} else {
			continue; // date-only without a chosen time: never invent one
		}
		if (!(at > earliest)) continue;
		const iso = new Date(at).toISOString();
		inserts.push(
			db
				.prepare(
					`INSERT INTO notifications (id, user_id, workspace_id, memo_id, channel, scheduled_at, lead_minutes, status, attempts, next_attempt_at, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'discord', ?, ?, 'scheduled', 0, ?, ?, ?)
					 ON CONFLICT(memo_id, channel) DO NOTHING`,
				)
				.bind(crypto.randomUUID(), params.userId, params.workspaceId, memo.id, iso, lead, iso, nowIso, nowIso),
		);
	}
	if (inserts.length === 0) return 0;
	const out = await db.batch(inserts);
	return out.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}
