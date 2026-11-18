// Personal settings: display name and notification channel choices.
// Channel availability is decided here (server side), never by the client.
import type { Provider } from './auth/providers.ts';
import { linkedProviders } from './auth/store.ts';
import { checkGuildMember, sendDiscordDm } from './notify/discord.ts';
import { discordReady, discordRecipient } from './notify/reminders.ts';
import { consumeEmailQuota, type EmailEnv, emailConfigured, emailRecipient, emailSenderFromEnv, recordAttempt } from './notify/email.ts';
import { testEmail } from '../shared/email-template.ts';
import { reminderCard, sampleTiming } from '../shared/discord-card.ts';
import { REMINDER_TONES, type ReminderTone } from '../shared/types.ts';

export interface SettingsEnv extends EmailEnv {
	DISCORD_BOT_TOKEN?: string;
	/** Optional public invite to the server where the reminder bot lives. */
	DISCORD_SERVER_INVITE?: string;
	/** Server (guild) id where the bot lives. When set, Discord stays locked until the user joins it. */
	DISCORD_GUILD_ID?: string;
	/** Public https address of this app (link button on cards). */
	PUBLIC_APP_URL?: string;
}

/** Discord server membership as shown in settings. `joined: null` = could not check right now. */
export interface DiscordServerStatus {
	joined: boolean | null;
	inviteUrl: string | null;
}

export const CHANNELS = ['discord', 'kakao', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ChannelStatus {
	channel: Channel;
	label: string;
	/** Can the user turn this on right now? */
	available: boolean;
	enabled: boolean;
	/** Whether messages are actually delivered yet (false until the sender exists). */
	delivering: boolean;
	note: string;
	/** Discord only, when DISCORD_GUILD_ID is set: must the user join the bot's server first? */
	server?: DiscordServerStatus;
	/** E-mail only: the verified Google address reminders go to (shown to the owner). */
	address?: string | null;
	/** E-mail only: the latest failed attempt in the last 7 days, if any. */
	lastFailure?: { at: string; code: string; message: string } | null;
}

/** Plain explanations for stored e-mail failure codes. */
export const EMAIL_FAILURES: Record<string, string> = {
	email_not_configured: '메일 발신 서비스가 아직 설정되지 않아 보내지 못했어요.',
	no_verified_email: '인증된 Google 이메일이 없어 보내지 못했어요.',
	email_daily_limit: '오늘 보낼 수 있는 메일 수를 넘어 보내지 못했어요.',
	email_unauthorized: '메일 발신 설정(API 키·발신 도메인)에 문제가 있어 보내지 못했어요.',
	email_rate_limited: '메일 전송 한도에 걸려 다시 보내는 중이에요.',
	email_network: '메일 서비스에 연결하지 못했어요.',
	invalid_recipient: '받는 주소가 올바르지 않아요.',
};
export const emailFailureText = (code: string) => EMAIL_FAILURES[code] ?? (code.startsWith('email_http_5') ? '메일 서비스 오류로 보내지 못했어요.' : '메일 서비스가 메일을 거부했어요.');

const LABELS: Record<Channel, string> = { discord: 'Discord DM', kakao: '카카오톡', email: '이메일 (Google 계정 주소)' };

/**
 * Honest availability per channel:
 * - discord: needs a linked Discord account and the reminder bot; turning it on
 *   sends a test DM first and only stays on when that DM was delivered.
 * - kakao: off — sending service reminders needs a policy review (알림톡 may be required).
 * - email: the provider-verified Google address of a linked Google account, sent by this service
 *   (never from the user's Gmail). Needs a configured sender; turning it on sends a test e-mail
 *   and only stays on when the provider accepted it. Off by default.
 */
export async function channelStatuses(
	db: D1Database,
	env: SettingsEnv,
	userId: string,
	linked?: Provider[],
	fetchFn?: typeof fetch,
	now: Date = new Date(),
): Promise<ChannelStatus[]> {
	const providers = linked ?? (await linkedProviders(db, userId));
	const { results } = await db
		.prepare('SELECT channel, enabled, verified_at FROM notification_preferences WHERE user_id = ?')
		.bind(userId)
		.all<{ channel: Channel; enabled: number; verified_at: string | null }>();
	const saved = new Map(results.map((r) => [r.channel, r]));
	const linkedDiscord = providers.includes('discord');
	const bot = !!env.DISCORD_BOT_TOKEN;
	// Bots can only DM users who share a server with them: check membership on the server side.
	let server: DiscordServerStatus | undefined;
	if (linkedDiscord && bot && env.DISCORD_GUILD_ID && fetchFn) {
		const recipient = await discordRecipient(db, userId);
		const membership = recipient ? await checkGuildMember(env.DISCORD_BOT_TOKEN!, env.DISCORD_GUILD_ID, recipient, fetchFn) : 'unknown';
		server = { joined: membership === 'unknown' ? null : membership === 'member', inviteUrl: env.DISCORD_SERVER_INVITE || null };
	}
	const linkedGoogle = providers.includes('google');
	const address = linkedGoogle ? await emailRecipient(db, userId) : null;
	const sender = emailConfigured(env);
	const failure = await db
		.prepare(
			`SELECT attempted_at, error_code FROM notification_attempts
			 WHERE user_id = ? AND channel = 'email' AND outcome = 'failed' AND attempted_at > ? ORDER BY attempted_at DESC LIMIT 1`,
		)
		.bind(userId, new Date(now.getTime() - 7 * 86_400_000).toISOString())
		.first<{ attempted_at: string; error_code: string | null }>();
	return CHANNELS.map((channel) => {
		if (channel === 'email') {
			const row = saved.get('email');
			const on = !!address && sender && row?.enabled === 1 && !!row.verified_at;
			return {
				channel,
				label: LABELS.email,
				available: !!address && sender,
				enabled: on,
				delivering: on,
				address,
				lastFailure: failure ? { at: failure.attempted_at, code: failure.error_code ?? '', message: emailFailureText(failure.error_code ?? '') } : null,
				note: !linkedGoogle
					? 'Google 계정을 연결하면 그 계정의 인증된 이메일로 받을 수 있어요(카카오·Discord만 써도 괜찮아요).'
					: !address
						? 'Google에서 인증된 이메일을 확인하지 못했어요. Google로 다시 로그인하면 다시 확인해요.'
						: !sender
							? '메일 발신 서비스가 아직 준비되지 않아 켤 수 없어요(운영자 설정 필요).'
							: on
								? `예약한 알림을 ${address}로 보내요. 메모 제목·시각이 메일에 담겨요.`
								: `켜면 ${address}로 테스트 메일을 먼저 보내요. 메모 제목·시각이 메일에 담기니 민감한 내용은 적지 마세요.`,
			};
		}
		if (channel === 'discord') {
			const row = saved.get('discord');
			const notJoined = server?.joined === false;
			const on = linkedDiscord && bot && !notJoined && row?.enabled === 1 && !!row.verified_at;
			const status: ChannelStatus = {
				channel,
				label: LABELS.discord,
				available: linkedDiscord && bot && !notJoined,
				enabled: on,
				delivering: on,
				note: !linkedDiscord
					? 'Discord 계정을 먼저 연결해야 켤 수 있어요.'
					: !bot
						? '알림 봇이 아직 설정되지 않아 켤 수 없어요.'
						: notJoined
							? '알림 봇이 있는 Discord 서버에 가입해야 켤 수 있어요.'
							: on
								? '메모에서 "알림 받기"로 예약하면 그 시각에 DM으로 보내 드려요.'
								: server
									? '켜면 확인용 테스트 DM을 먼저 보내요.'
									: `켜면 확인용 테스트 DM을 먼저 보내요. 알림 봇이 있는 서버에 참여해 있어야 받을 수 있어요.${env.DISCORD_SERVER_INVITE ? ` 참여: ${env.DISCORD_SERVER_INVITE}` : ''}`,
			};
			if (server) status.server = server;
			return status;
		}
		return {
			channel,
			label: LABELS[channel],
			available: false,
			enabled: false,
			delivering: false,
			note:
				'카카오톡 알림은 제공하지 않아요(카카오 로그인은 로그인 용도로만 써요).',
		};
	});
}

export type ToggleResult = { ok: true } | { ok: false; code: 'unavailable' | 'test_failed'; message: string };

export const TEST_MESSAGE = '메모비서 🔔 Discord 알림이 연결됐어요. 앞으로 예약한 메모 알림을 여기로 보내 드릴게요.';

export async function setChannel(
	db: D1Database,
	env: SettingsEnv,
	userId: string,
	channel: Channel,
	enabled: boolean,
	now: Date,
	fetchFn: typeof fetch,
): Promise<ToggleResult> {
	// Enabling re-checks availability (incl. server membership) on the server; disabling is always allowed.
	const status = (await channelStatuses(db, env, userId, undefined, enabled ? fetchFn : undefined)).find((s) => s.channel === channel)!;
	if (enabled && !status.available) return { ok: false, code: 'unavailable', message: status.note };
	let verifiedAt: string | null = null;
	if (enabled && channel === 'discord') {
		// Only switch on after a real DM got through.
		const recipient = await discordRecipient(db, userId);
		const result = recipient
			? await sendDiscordDm(env.DISCORD_BOT_TOKEN!, recipient, TEST_MESSAGE, fetchFn)
			: { ok: false as const, message: 'Discord 계정을 먼저 연결해야 켤 수 있어요.' };
		if (!result.ok) {
			const invite = env.DISCORD_SERVER_INVITE ? ` 서버 참여: ${env.DISCORD_SERVER_INVITE}` : '';
			return { ok: false, code: 'test_failed', message: `${result.message}${invite}` };
		}
		verifiedAt = now.toISOString();
	}
	if (enabled && channel === 'email') {
		// Only switch on after the provider accepted a real test e-mail (acceptance, not proof of arrival).
		const result = await sendTestEmail(db, env, userId, now, fetchFn);
		if (!result.ok) return { ok: false, code: 'test_failed', message: result.message };
		verifiedAt = now.toISOString();
	}
	await db
		.prepare(
			`INSERT INTO notification_preferences (user_id, channel, enabled, verified_at, updated_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, channel) DO UPDATE SET enabled = excluded.enabled,
			   verified_at = COALESCE(excluded.verified_at, CASE WHEN excluded.enabled = 0 THEN NULL ELSE notification_preferences.verified_at END),
			   updated_at = excluded.updated_at`,
		)
		.bind(userId, channel, enabled ? 1 : 0, verifiedAt, now.toISOString())
		.run();
	return { ok: true };
}

/** Rename the user; the personal space name and the author name of their own memos follow. */
export async function setDisplayName(db: D1Database, userId: string, workspaceId: string, displayName: string): Promise<void> {
	await db.batch([
		db.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(displayName, userId),
		db
			.prepare("UPDATE workspaces SET name = ? WHERE id = ? AND owner_user_id = ? AND kind = 'personal'")
			.bind(`${displayName}님의 메모`, workspaceId, userId),
		db.prepare('UPDATE sources SET nickname = ? WHERE workspace_id = ?').bind(displayName, workspaceId),
	]);
}

export async function getReminderTone(db: D1Database, userId: string): Promise<ReminderTone> {
	const row = await db.prepare('SELECT reminder_tone FROM users WHERE id = ?').bind(userId).first<{ reminder_tone: string | null }>();
	return (REMINDER_TONES as readonly string[]).includes(row?.reminder_tone ?? '') ? (row!.reminder_tone as ReminderTone) : 'friendly';
}

export async function setReminderTone(db: D1Database, userId: string, tone: ReminderTone): Promise<void> {
	await db.prepare('UPDATE users SET reminder_tone = ? WHERE id = ?').bind(tone, userId).run();
}

export type TestEmailResult = { ok: true; to: string } | { ok: false; code: 'channel_off' | 'test_failed' | 'limited'; message: string };

/** Send the test e-mail to the verified Google address. At most 5 a day per user. */
export async function sendTestEmail(db: D1Database, env: SettingsEnv, userId: string, now: Date, fetchFn: typeof fetch): Promise<TestEmailResult> {
	const to = await emailRecipient(db, userId);
	if (!to) return { ok: false, code: 'channel_off', message: '인증된 Google 이메일이 없어요. Google 계정을 연결하거나 다시 로그인해 주세요.' };
	const sender = emailSenderFromEnv(env, fetchFn);
	const day = now.toISOString().slice(0, 10);
	const used = await db
		.prepare(
			`INSERT INTO usage_counters (counter_key, count, expires_at) VALUES (?, 1, ?)
			 ON CONFLICT(counter_key) DO UPDATE SET count = count + 1 RETURNING count`,
		)
		.bind(`email-test:${userId}:${day}`, new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString())
		.first<{ count: number }>();
	if ((used?.count ?? 1) > 5) return { ok: false, code: 'limited', message: '테스트 메일은 하루 5번까지 보낼 수 있어요.' };
	const result = sender.configured
		? (await consumeEmailQuota(db, env, now))
			? await sender.send({ to, ...testEmail(env.PUBLIC_APP_URL) })
			: ({ ok: false, retryable: false, code: 'email_daily_limit', message: '오늘 보낼 수 있는 메일 수를 넘었어요.' } as const)
		: await sender.send({ to, subject: '', html: '', text: '' });
	await recordAttempt(
		db,
		{
			notificationId: null,
			userId,
			memoId: null,
			channel: 'email',
			occurrenceKey: null,
			outcome: result.ok ? 'accepted' : 'failed',
			errorCode: result.ok ? null : result.code,
			providerMessageId: result.ok ? result.providerMessageId : null,
		},
		now,
	);
	if (!result.ok) return { ok: false, code: 'test_failed', message: emailFailureText(result.code) };
	return { ok: true, to };
}

export type PreviewResult = { ok: true } | { ok: false; code: 'channel_off' | 'test_failed'; message: string };

/**
 * Send one example card in the user's saved tone, so they can see the real DM.
 * Only for users whose Discord channel is on (verified). Templates only, no AI.
 */
export async function sendTonePreview(db: D1Database, env: SettingsEnv, userId: string, now: Date, fetchFn: typeof fetch): Promise<PreviewResult> {
	if (!env.DISCORD_BOT_TOKEN || !(await discordReady(db, userId))) {
		return { ok: false, code: 'channel_off', message: '먼저 Discord 알림을 켜 주세요(테스트 DM 성공 필요).' };
	}
	const recipient = await discordRecipient(db, userId);
	if (!recipient) return { ok: false, code: 'channel_off', message: 'Discord 계정을 먼저 연결해 주세요.' };
	const tone = await getReminderTone(db, userId);
	const { memo, timing } = sampleTiming(now);
	const card = reminderCard(tone, memo, timing, env.PUBLIC_APP_URL);
	const result = await sendDiscordDm(env.DISCORD_BOT_TOKEN, recipient, { ...card, content: `🧪 미리보기 · ${card.content ?? ''}` }, fetchFn);
	return result.ok ? { ok: true } : { ok: false, code: 'test_failed', message: result.message };
}
