// Personal settings: display name and notification channel choices.
// Channel availability is decided here (server side), never by the client.
import type { Provider } from './auth/providers.ts';
import { linkedProviders } from './auth/store.ts';
import { sendDiscordDm } from './notify/discord.ts';
import { discordRecipient } from './notify/reminders.ts';

export interface SettingsEnv {
	DISCORD_BOT_TOKEN?: string;
	/** Optional public invite to the server where the reminder bot lives. */
	DISCORD_SERVER_INVITE?: string;
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
}

const LABELS: Record<Channel, string> = { discord: 'Discord DM', kakao: '카카오톡', email: 'Gmail(이메일)' };

/**
 * Honest availability per channel:
 * - discord: needs a linked Discord account and the reminder bot; turning it on
 *   sends a test DM first and only stays on when that DM was delivered.
 * - kakao: off — sending service reminders needs a policy review (알림톡 may be required).
 * - email: off — no e-mail sender/consent flow yet; Google login is not a notification channel.
 */
export async function channelStatuses(
	db: D1Database,
	env: SettingsEnv,
	userId: string,
	linked?: Provider[],
): Promise<ChannelStatus[]> {
	const providers = linked ?? (await linkedProviders(db, userId));
	const { results } = await db
		.prepare('SELECT channel, enabled, verified_at FROM notification_preferences WHERE user_id = ?')
		.bind(userId)
		.all<{ channel: Channel; enabled: number; verified_at: string | null }>();
	const saved = new Map(results.map((r) => [r.channel, r]));
	return CHANNELS.map((channel) => {
		if (channel === 'discord') {
			const linkedDiscord = providers.includes('discord');
			const bot = !!env.DISCORD_BOT_TOKEN;
			const row = saved.get('discord');
			const on = linkedDiscord && bot && row?.enabled === 1 && !!row.verified_at;
			return {
				channel,
				label: LABELS.discord,
				available: linkedDiscord && bot,
				enabled: on,
				delivering: on,
				note: !linkedDiscord
					? 'Discord 계정을 먼저 연결해야 켤 수 있어요.'
					: !bot
						? '알림 봇이 아직 설정되지 않아 켤 수 없어요.'
						: on
							? '메모에서 "알림 받기"로 예약하면 그 시각에 DM으로 보내 드려요.'
							: `켜면 확인용 테스트 DM을 먼저 보내요. 알림 봇이 있는 서버에 참여해 있어야 받을 수 있어요.${env.DISCORD_SERVER_INVITE ? ` 참여: ${env.DISCORD_SERVER_INVITE}` : ''}`,
			};
		}
		return {
			channel,
			label: LABELS[channel],
			available: false,
			enabled: false,
			delivering: false,
			note:
				channel === 'kakao'
					? '카카오톡 알림은 카카오 메시지 정책 검토가 끝나지 않아 아직 사용할 수 없어요.'
					: 'Gmail(이메일) 알림은 아직 준비 중이에요. Google 로그인은 알림 경로가 아니에요.',
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
	const status = (await channelStatuses(db, env, userId)).find((s) => s.channel === channel)!;
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
