// Reminders: confirmed by the user per memo, delivered by the cron dispatcher.
import { earliestReminderTime, type MemoCategory, type NotificationChannel, REMINDER_MIN_LEAD_MINUTES } from '../../shared/types.ts';
import { reminderCard, reminderText, type ReminderTone } from '../../shared/discord-card.ts';
import { addDays, describeRecurrence, nextOccurrence, parseRecurrence, type Recurrence } from '../../shared/recurrence.ts';
import { occurrenceAt } from '../occurrences.ts';
import { kstDate } from '../time.ts';
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
	/** Public https address of this app, for the card's link button (optional). */
	PUBLIC_APP_URL?: string;
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

export type SetReminderResult =
	| { ok: true; scheduledAt: string }
	| { ok: false; status: 404 | 409 | 422; code: string; message: string };

/**
 * Confirm a reminder for one personal memo. Exact-time memos take a lead time;
 * date-only memos need an explicit time of day (never an invented one).
 */
export async function setReminder(
	db: D1Database,
	params: { userId: string; workspaceId: string; memoId: string; leadMinutes?: number; time?: string; at?: string; channels?: NotificationChannel[] },
	now: Date,
): Promise<SetReminderResult> {
	const memo = await db
		.prepare('SELECT id, due_at, due_date, completed_at, recurrence FROM memos WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL')
		.bind(params.memoId, params.workspaceId)
		.first<{ id: string; due_at: string | null; due_date: string | null; completed_at: string | null; recurrence: string | null }>();
	if (!memo) return { ok: false, status: 404, code: 'not_found', message: '메모를 찾지 못했어요.' };
	if (memo.completed_at) return { ok: false, status: 409, code: 'conflict', message: '완료한 메모에는 알림을 걸 수 없어요.' };
	if (params.channels) {
		// Kakao and Gmail are shown but cannot deliver yet: never accept them silently.
		if (params.channels.length === 0) return { ok: false, status: 422, code: 'invalid_request', message: '알림 받을 곳을 하나 이상 켜 주세요.' };
		if (params.channels.some((ch) => ch !== 'discord')) {
			return { ok: false, status: 422, code: 'channel_unavailable', message: '카카오톡·Gmail 알림은 아직 준비 중이에요. Discord만 켜 주세요.' };
		}
	}
	if (!(await discordReady(db, params.userId))) {
		return { ok: false, status: 409, code: 'channel_off', message: '설정에서 Discord 알림을 먼저 켜 주세요(테스트 DM 성공 필요).' };
	}

	// Missing choices fall back to the user's own defaults (never an invented time).
	const defaults = await getReminderDefaults(db, params.userId);
	const rule = parseRecurrence(memo.recurrence);
	if (rule) return setRepeatingReminder(db, params, { ...memo, rule }, defaults, now);

	let scheduledAt: string;
	let lead: number | null;
	if (params.leadMinutes === undefined && memo.due_at) params = { ...params, leadMinutes: defaults.leadMinutes };
	if (params.time === undefined && !memo.due_at && defaults.dateOnlyTime) params = { ...params, time: defaults.dateOnlyTime };
	if (params.at !== undefined) {
		// A time the person picked (presets only fill this in). Any time is fine — before or after the deadline.
		const at = Date.parse(params.at);
		if (Number.isNaN(at)) return { ok: false, status: 422, code: 'invalid_request', message: '알림 시각 형식이 올바르지 않아요.' };
		scheduledAt = new Date(Math.floor(at / 60_000) * 60_000).toISOString();
		// A clock time the person chose: it stays put if the deadline is edited later (lead = null).
		lead = null;
	} else if (memo.due_at) {
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
	if (Date.parse(scheduledAt) < earliestReminderTime(now).getTime()) {
		return {
			ok: false,
			status: 422,
			code: 'past_time',
			message: `지났거나 ${REMINDER_MIN_LEAD_MINUTES - 1}분 이내인 시각이에요. 지금부터 ${REMINDER_MIN_LEAD_MINUTES}분 이후로 골라 주세요.`,
		};
	}

	const nowIso = now.toISOString();
	await db
		.prepare(
			`INSERT INTO notifications (id, user_id, workspace_id, memo_id, channel, scheduled_at, lead_minutes, status, attempts, next_attempt_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'discord', ?, ?, 'scheduled', 0, ?, ?, ?)
			 ON CONFLICT(memo_id, channel) DO UPDATE SET
			   scheduled_at = excluded.scheduled_at, lead_minutes = excluded.lead_minutes, status = 'scheduled',
			   attempts = 0, next_attempt_at = excluded.next_attempt_at, last_error = NULL, sent_at = NULL, updated_at = excluded.updated_at,
			   occurrence_date = NULL, remind_time = NULL`,
		)
		.bind(crypto.randomUUID(), params.userId, params.workspaceId, memo.id, scheduledAt, lead, scheduledAt, nowIso, nowIso)
		.run();
	return { ok: true, scheduledAt };
}

/**
 * The next occurrence to remind about, from `fromDay` on: its reminder time must be at least
 * 4 minutes ahead and the occurrence not done. Timed memos use `lead` minutes before the
 * occurrence; date-only memos use the chosen `remindTime` (HH:MM, KST). Calendar math only.
 */
export async function nextReminderSlot(
	db: D1Database,
	memo: { id: string; due_at: string | null; rule: Recurrence },
	how: { lead: number | null; remindTime: string | null },
	fromDay: string,
	now: Date,
): Promise<{ date: string; scheduledAt: string } | null> {
	const earliest = earliestReminderTime(now).getTime();
	const { results } = await db
		.prepare('SELECT occurrence_date FROM memo_occurrences WHERE memo_id = ? AND occurrence_date >= ?')
		.bind(memo.id, fromDay)
		.all<{ occurrence_date: string }>();
	const done = new Set(results.map((r) => r.occurrence_date));
	let day: string | null = fromDay;
	for (let i = 0; i < 400 && day; i++) {
		day = nextOccurrence(memo.rule, day);
		if (!day) return null;
		const occurrence = occurrenceAt(memo, day);
		const at =
			occurrence && how.lead !== null
				? Date.parse(occurrence) - how.lead * 60_000
				: how.remindTime
					? Date.parse(`${day}T${how.remindTime}:00+09:00`)
					: NaN;
		if (Number.isNaN(at)) return null;
		if (at >= earliest && !done.has(day)) return { date: day, scheduledAt: new Date(at).toISOString() };
		day = addDays(day, 1);
	}
	return null;
}

/** Reminder for a repeating memo: "정시·N분 전" (timed) or a time of day (date-only), for every occurrence. */
async function setRepeatingReminder(
	db: D1Database,
	params: { userId: string; workspaceId: string; memoId: string; leadMinutes?: number; time?: string; at?: string },
	memo: { id: string; due_at: string | null; rule: Recurrence },
	defaults: ReminderDefaults,
	now: Date,
): Promise<SetReminderResult> {
	if (params.at !== undefined) {
		return {
			ok: false,
			status: 422,
			code: 'invalid_request',
			message: memo.due_at
				? '반복 일정은 매 회차 기준으로 알려 드려요. 정시·10분·30분·1시간 전 중에서 골라 주세요.'
				: '반복 일정은 매 회차 같은 시각에 알려 드려요. 알림 시각(HH:MM)을 골라 주세요.',
		};
	}
	let lead: number | null = null;
	let remindTime: string | null = null;
	if (memo.due_at) {
		lead = params.leadMinutes ?? defaults.leadMinutes;
		if (!(LEAD_OPTIONS as readonly number[]).includes(lead)) {
			return { ok: false, status: 422, code: 'invalid_request', message: '알림 시점을 골라 주세요(정시·10분·30분·1시간 전).' };
		}
	} else {
		remindTime = params.time ?? defaults.dateOnlyTime;
		if (!remindTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(remindTime)) {
			return { ok: false, status: 422, code: 'invalid_request', message: '날짜만 있는 반복 일정이라 알림 받을 시각(HH:MM)을 골라 주세요.' };
		}
	}
	const slot = await nextReminderSlot(db, memo, { lead, remindTime }, kstDate(now), now);
	if (!slot) return { ok: false, status: 422, code: 'past_time', message: '알림을 보낼 다음 회차가 없어요.' };
	const nowIso = now.toISOString();
	await db
		.prepare(
			`INSERT INTO notifications (id, user_id, workspace_id, memo_id, channel, scheduled_at, lead_minutes, status, attempts, next_attempt_at, created_at, updated_at, occurrence_date, remind_time)
			 VALUES (?, ?, ?, ?, 'discord', ?, ?, 'scheduled', 0, ?, ?, ?, ?, ?)
			 ON CONFLICT(memo_id, channel) DO UPDATE SET
			   scheduled_at = excluded.scheduled_at, lead_minutes = excluded.lead_minutes, status = 'scheduled',
			   attempts = 0, next_attempt_at = excluded.next_attempt_at, last_error = NULL, sent_at = NULL, updated_at = excluded.updated_at,
			   occurrence_date = excluded.occurrence_date, remind_time = excluded.remind_time`,
		)
		.bind(crypto.randomUUID(), params.userId, params.workspaceId, memo.id, slot.scheduledAt, lead, slot.scheduledAt, nowIso, nowIso, slot.date, remindTime)
		.run();
	return { ok: true, scheduledAt: slot.scheduledAt };
}

/**
 * After a repeating reminder was handled (sent, skipped or too late), wait for the next
 * occurrence. With none left the row ends as `final`.
 */
async function moveToNextOccurrence(
	db: D1Database,
	id: string,
	memo: { id: string; due_at: string | null; rule: Recurrence },
	how: { lead: number | null; remindTime: string | null },
	afterDay: string,
	at: Date,
	final: 'sent' | 'canceled' | 'failed',
	sent: boolean,
): Promise<void> {
	const slot = await nextReminderSlot(db, memo, how, addDays(afterDay, 1), at);
	const nowIso = at.toISOString();
	if (!slot) {
		await finish(db, id, final, null, at);
		return;
	}
	await db
		.prepare(
			`UPDATE notifications SET status = 'scheduled', occurrence_date = ?, scheduled_at = ?, next_attempt_at = ?, attempts = 0,
			   last_error = NULL, sent_at = CASE WHEN ? THEN ? ELSE sent_at END, updated_at = ? WHERE id = ?`,
		)
		.bind(slot.date, slot.scheduledAt, slot.scheduledAt, sent ? 1 : 0, nowIso, nowIso, id)
		.run();
}

/**
 * A memo's date, time or repeat rule was edited: point its reminder at the right occurrence.
 * Repeating → recompute the next slot (cancel if impossible); one-time again → the existing
 * one-time rules (followDeadline); a repeating-only setting that no longer applies is cancelled.
 */
export async function syncReminderAfterEdit(db: D1Database, memoId: string, workspaceId: string, now: Date): Promise<void> {
	const row = await db
		.prepare(
			`SELECT n.id, n.lead_minutes, n.remind_time, n.occurrence_date, m.due_at, m.recurrence
			 FROM notifications n JOIN memos m ON m.id = n.memo_id
			 WHERE n.memo_id = ? AND n.workspace_id = ? AND n.status IN ('scheduled', 'failed')`,
		)
		.bind(memoId, workspaceId)
		.first<{ id: string; lead_minutes: number | null; remind_time: string | null; occurrence_date: string | null; due_at: string | null; recurrence: string | null }>();
	if (!row) return;
	const nowIso = now.toISOString();
	const cancel = () =>
		db.prepare("UPDATE notifications SET status = 'canceled', last_error = 'deadline_changed', updated_at = ? WHERE id = ?").bind(nowIso, row.id).run();
	const rule = parseRecurrence(row.recurrence);
	if (!rule) {
		if (row.occurrence_date === null) return followDeadline(db, memoId, workspaceId, row.due_at, now);
		await cancel(); // was a repeating reminder; the memo is one-time now
		return;
	}
	const lead = row.due_at ? row.lead_minutes : null;
	const remindTime = row.due_at ? null : row.remind_time;
	if (lead === null && remindTime === null) {
		await cancel(); // e.g. a picked clock time on a memo that became repeating
		return;
	}
	const slot = await nextReminderSlot(db, { id: memoId, due_at: row.due_at, rule }, { lead, remindTime }, kstDate(now), now);
	if (!slot) {
		await cancel();
		return;
	}
	await db
		.prepare(
			`UPDATE notifications SET status = 'scheduled', occurrence_date = ?, scheduled_at = ?, next_attempt_at = ?, attempts = 0,
			   last_error = NULL, lead_minutes = ?, remind_time = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(slot.date, slot.scheduledAt, slot.scheduledAt, lead, remindTime, nowIso, row.id)
		.run();
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
/**
 * Send on the minute, not when the cron happens to run.
 * Cloudflare runs a "* * * * *" trigger at a fixed offset inside each minute (seen in
 * production: about :50), so a reminder due at 15:00:00 was found only at 15:00:50.
 * With `lookaheadMs`, a run also picks reminders due before the next run and waits
 * (no CPU used) until each one is due. Nothing is claimed while waiting, so a reminder
 * the user turns off in the meantime is not sent; the claim still prevents duplicates.
 */
export interface DispatchTiming {
	lookaheadMs: number;
	/** Current time after waiting. */
	clock: () => Date;
	sleep: (ms: number) => Promise<void>;
}

export const CRON_LOOKAHEAD_MS = 60_000;

export async function runDueReminders(
	env: NotifyEnv,
	now: Date,
	fetchFn: typeof fetch,
	max = 10,
	timing?: DispatchTiming,
): Promise<DispatchSummary> {
	const db = env.DB;
	const startIso = now.toISOString();
	const summary: DispatchSummary = { sent: 0, retried: 0, failed: 0, canceled: 0 };

	// Unknown outcome (crash mid-send): give up rather than risk a duplicate DM.
	await db
		.prepare("UPDATE notifications SET status = 'failed', last_error = 'unknown_outcome', updated_at = ? WHERE status = 'sending' AND updated_at <= ?")
		.bind(startIso, new Date(now.getTime() - STUCK_SENDING_MS).toISOString())
		.run();

	const horizon = new Date(now.getTime() + (timing?.lookaheadMs ?? 0)).toISOString();
	const { results: due } = await db
		.prepare("SELECT id, next_attempt_at FROM notifications WHERE status = 'scheduled' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?")
		.bind(horizon, max)
		.all<{ id: string; next_attempt_at: string }>();

	for (const { id, next_attempt_at } of due) {
		// Wait for the exact time (ordered, so each wait is short); then re-check everything as of then.
		if (timing) {
			const wait = Date.parse(next_attempt_at) - timing.clock().getTime();
			if (wait > 0) await timing.sleep(wait);
		}
		const at = timing ? timing.clock() : now;
		const nowIso = at.toISOString();
		const claim = await db
			.prepare("UPDATE notifications SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'scheduled'")
			.bind(nowIso, id)
			.run();
		if (!claim.meta.changes) continue; // another run took it

		const row = await db
			.prepare(
				`SELECT n.user_id, n.memo_id, n.scheduled_at, n.lead_minutes, n.remind_time, n.occurrence_date, n.attempts,
				        m.title, m.category, m.due_at, m.due_date, m.completed_at, m.deleted_at, m.recurrence,
				        (m.workspace_id = n.workspace_id AND w.owner_user_id = n.user_id) AS owned, u.reminder_tone
				 FROM notifications n
				 JOIN memos m ON m.id = n.memo_id
				 LEFT JOIN workspaces w ON w.id = n.workspace_id
				 LEFT JOIN users u ON u.id = n.user_id
				 WHERE n.id = ?`,
			)
			.bind(id)
			.first<{
				user_id: string; memo_id: string; scheduled_at: string; lead_minutes: number | null; remind_time: string | null; occurrence_date: string | null;
				attempts: number; reminder_tone: ReminderTone | null; recurrence: string | null;
				title: string; category: MemoCategory; due_at: string | null; due_date: string | null; completed_at: string | null; deleted_at: string | null; owned: number;
			}>();
		if (!row || !row.owned || row.deleted_at || row.completed_at) {
			await finish(db, id, 'canceled', row?.completed_at ? 'memo_completed' : 'memo_unavailable', at);
			summary.canceled++;
			continue;
		}
		// A repeating reminder waits for one occurrence at a time.
		const rule = parseRecurrence(row.recurrence);
		const series = rule && row.occurrence_date ? { id: row.memo_id, due_at: row.due_at, rule } : null;
		const how = { lead: row.due_at ? row.lead_minutes : null, remindTime: row.due_at ? null : row.remind_time };
		if (row.occurrence_date && !series) {
			await finish(db, id, 'canceled', 'recurrence_changed', at);
			summary.canceled++;
			continue;
		}
		if (series) {
			const done = await db
				.prepare('SELECT 1 AS ok FROM memo_occurrences WHERE memo_id = ? AND occurrence_date = ?')
				.bind(row.memo_id, row.occurrence_date)
				.first();
			if (done) {
				// This occurrence was checked off already: nothing to remind; wait for the next one.
				await moveToNextOccurrence(db, id, series, how, row.occurrence_date!, at, 'canceled', false);
				summary.canceled++;
				continue;
			}
		}
		if (at.getTime() - Date.parse(row.scheduled_at) > TOO_LATE_MS) {
			if (series) await moveToNextOccurrence(db, id, series, how, row.occurrence_date!, at, 'failed', false);
			else await finish(db, id, 'failed', 'too_late', at);
			summary.failed++;
			continue;
		}
		const recipient = await discordRecipient(db, row.user_id);
		if (!recipient || !(await discordReady(db, row.user_id))) {
			await finish(db, id, 'canceled', 'channel_off', at);
			summary.canceled++;
			continue;
		}
		if (!env.DISCORD_BOT_TOKEN) {
			await finish(db, id, 'failed', 'bot_not_configured', at);
			summary.failed++;
			continue;
		}

		if (series) {
			// One delivery per occurrence: the primary key refuses a second one, whatever happens elsewhere.
			const first = await db
				.prepare(
					`INSERT INTO reminder_deliveries (memo_id, channel, occurrence_date, notification_id, created_at) VALUES (?, 'discord', ?, ?, ?)
					 ON CONFLICT(memo_id, channel, occurrence_date) DO NOTHING`,
				)
				.bind(row.memo_id, row.occurrence_date, id, nowIso)
				.run();
			if (!first.meta.changes) {
				await moveToNextOccurrence(db, id, series, how, row.occurrence_date!, at, 'sent', false);
				summary.canceled++;
				continue;
			}
		}

		// The card is filled from stored fields and fixed templates only (no AI call).
		const tone = row.reminder_tone ?? 'friendly';
		const when = { scheduledAt: row.scheduled_at, leadMinutes: how.lead };
		const cardMemo = series
			? { ...row, due_at: occurrenceAt(series, row.occurrence_date!), due_date: row.occurrence_date, repeat: describeRecurrence(series.rule) }
			: row;
		let result = await sendDiscordDm(env.DISCORD_BOT_TOKEN, recipient, reminderCard(tone, cardMemo, when, env.PUBLIC_APP_URL), fetchFn);
		// Card refused as invalid (400 / 50035): it was not delivered, so plain text is sent once instead — never both.
		if (!result.ok && (result.code === '50035' || result.code === 'http_400')) {
			result = await sendDiscordDm(env.DISCORD_BOT_TOKEN, recipient, reminderText(tone, cardMemo, when), fetchFn);
		}
		if (result.ok) {
			if (series) await moveToNextOccurrence(db, id, series, how, row.occurrence_date!, at, 'sent', true);
			else await finish(db, id, 'sent', null, at);
			summary.sent++;
		} else if (result.retryable && row.attempts < MAX_ATTEMPTS) {
			// Not delivered: free this occurrence for the retry.
			if (series) {
				await db
					.prepare("DELETE FROM reminder_deliveries WHERE memo_id = ? AND channel = 'discord' AND occurrence_date = ?")
					.bind(row.memo_id, row.occurrence_date)
					.run();
			}
			const waitMs = Math.max((result.retryAfterSeconds ?? 0) * 1000, 2 ** row.attempts * 60_000);
			await db
				.prepare("UPDATE notifications SET status = 'scheduled', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
				.bind(new Date(at.getTime() + waitMs).toISOString(), result.code, nowIso, id)
				.run();
			summary.retried++;
		} else {
			await finish(db, id, 'failed', result.code, at);
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
			`SELECT m.id, m.due_at, m.due_date, m.recurrence FROM memos m
			 WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND m.completed_at IS NULL AND m.reminder_recommended = 1
			   AND (m.due_at IS NOT NULL OR m.due_date IS NOT NULL)
			   AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.memo_id = m.id AND n.channel = 'discord')`,
		)
		.bind(params.workspaceId)
		.all<{ id: string; due_at: string | null; due_date: string | null; recurrence: string | null }>();

	const earliest = earliestReminderTime(now).getTime(); // same rule as a manual reminder
	const nowIso = now.toISOString();
	const inserts: D1PreparedStatement[] = [];
	for (const memo of results) {
		const rule = parseRecurrence(memo.recurrence);
		if (rule) {
			// Repeating: remind before every occurrence with the user's defaults (date-only needs a chosen time).
			const lead = memo.due_at ? defaults.leadMinutes : null;
			const remindTime = memo.due_at ? null : defaults.dateOnlyTime;
			if (lead === null && remindTime === null) continue;
			const slot = await nextReminderSlot(db, { id: memo.id, due_at: memo.due_at, rule }, { lead, remindTime }, kstDate(now), now);
			if (!slot) continue;
			inserts.push(
				db
					.prepare(
						`INSERT INTO notifications (id, user_id, workspace_id, memo_id, channel, scheduled_at, lead_minutes, status, attempts, next_attempt_at, created_at, updated_at, occurrence_date, remind_time)
						 VALUES (?, ?, ?, ?, 'discord', ?, ?, 'scheduled', 0, ?, ?, ?, ?, ?)
						 ON CONFLICT(memo_id, channel) DO NOTHING`,
					)
					.bind(crypto.randomUUID(), params.userId, params.workspaceId, memo.id, slot.scheduledAt, lead, slot.scheduledAt, nowIso, nowIso, slot.date, remindTime),
			);
			continue;
		}
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

/**
 * The deadline of a memo was edited. Reminders set relative to it ("30분 전" etc.,
 * lead_minutes not null) move with it; if the new time is too close, past, or the
 * memo has no exact time any more, they are cancelled rather than sent at a stale time.
 * Reminders the person set to an explicit clock time (lead null) stay as they are.
 */
export async function followDeadline(db: D1Database, memoId: string, workspaceId: string, newDueAt: string | null, now: Date): Promise<void> {
	const { results } = await db
		.prepare("SELECT id, lead_minutes FROM notifications WHERE memo_id = ? AND workspace_id = ? AND status IN ('scheduled', 'failed') AND lead_minutes IS NOT NULL")
		.bind(memoId, workspaceId)
		.all<{ id: string; lead_minutes: number }>();
	const nowIso = now.toISOString();
	for (const row of results) {
		const at = newDueAt ? Date.parse(newDueAt) - row.lead_minutes * 60_000 : NaN;
		if (Number.isNaN(at) || at < earliestReminderTime(now).getTime()) {
			await db.prepare("UPDATE notifications SET status = 'canceled', last_error = 'deadline_changed', updated_at = ? WHERE id = ?").bind(nowIso, row.id).run();
		} else {
			const iso = new Date(at).toISOString();
			await db
				.prepare("UPDATE notifications SET scheduled_at = ?, next_attempt_at = ?, status = 'scheduled', attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?")
				.bind(iso, iso, nowIso, row.id)
				.run();
		}
	}
}
