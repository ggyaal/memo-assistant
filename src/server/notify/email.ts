// Outgoing e-mail through a provider adapter. The service sends the mail (never the user's Gmail).
// Today's adapter: Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email).
// Without EMAIL_API_KEY + EMAIL_FROM nothing is sent and nothing is reported as sent.

export interface EmailEnv {
	/** Resend API key (Workers secret). */
	EMAIL_API_KEY?: string;
	/** Verified sender, e.g. "메모비서 <noreply@example.com>" (the domain must be verified at the provider). */
	EMAIL_FROM?: string;
	/** Daily cap on e-mails this app sends (Resend Free: 100/day). Default 90. */
	EMAIL_DAILY_LIMIT?: string;
}

export interface EmailMessage {
	to: string;
	subject: string;
	html: string;
	text: string;
	/** Same key → the provider sends at most once (Resend keeps keys 24 hours). */
	idempotencyKey?: string;
}

/** `accepted`: the provider took the message. That is not proof it reached the inbox. */
export type EmailResult =
	| { ok: true; providerMessageId: string | null }
	| { ok: false; retryable: boolean; code: string; message: string; retryAfterSeconds?: number };

export interface EmailSender {
	readonly configured: boolean;
	send(message: EmailMessage): Promise<EmailResult>;
}

const FROM_PATTERN = /^(?:[^<>\r\n"]{1,60} <[^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+>|[^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+)$/;
export const ADDRESS_PATTERN = /^[^\s<>@",;]{1,64}@[^\s<>@",;]+\.[^\s<>@",;]{2,}$/;

export function emailConfigured(env: EmailEnv): boolean {
	return !!env.EMAIL_API_KEY && !!env.EMAIL_FROM && FROM_PATTERN.test(env.EMAIL_FROM);
}

export function emailDailyLimit(env: EmailEnv): number {
	const n = Number(env.EMAIL_DAILY_LIMIT);
	return Number.isInteger(n) && n > 0 ? n : 90;
}

/** Used when no provider is set up: always a clear failure, never a fake success. */
export const notConfiguredSender: EmailSender = {
	configured: false,
	async send() {
		return { ok: false, retryable: false, code: 'email_not_configured', message: '메일 발신 서비스가 아직 설정되지 않아 보내지 않았어요.' };
	},
};

export function resendSender(apiKey: string, from: string, fetchFn: typeof fetch): EmailSender {
	return {
		configured: true,
		async send(message) {
			if (!ADDRESS_PATTERN.test(message.to)) return { ok: false, retryable: false, code: 'invalid_recipient', message: '받는 주소가 올바르지 않아요.' };
			let res: Response;
			try {
				res = await fetchFn('https://api.resend.com/emails', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${apiKey}`,
						'content-type': 'application/json',
						...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey.slice(0, 256) } : {}),
					},
					body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
					signal: AbortSignal.timeout(10_000),
				});
			} catch (error) {
				return { ok: false, retryable: true, code: 'email_network', message: `메일 서비스에 연결하지 못했어요: ${String(error).slice(0, 60)}` };
			}
			if (res.ok) {
				const body = (await res.json().catch(() => ({}))) as { id?: unknown };
				return { ok: true, providerMessageId: typeof body.id === 'string' ? body.id.slice(0, 100) : null };
			}
			if (res.status === 429) {
				const retryAfter = Number(res.headers.get('retry-after'));
				return { ok: false, retryable: true, code: 'email_rate_limited', message: '메일 전송 한도에 걸려 잠시 뒤 다시 보낼게요.', retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined };
			}
			if (res.status >= 500) return { ok: false, retryable: true, code: `email_http_${res.status}`, message: '메일 서비스 오류로 잠시 뒤 다시 보낼게요.' };
			if (res.status === 401 || res.status === 403) return { ok: false, retryable: false, code: 'email_unauthorized', message: '메일 발신 설정(API 키·발신 도메인)에 문제가 있어요.' };
			return { ok: false, retryable: false, code: `email_http_${res.status}`, message: '메일 서비스가 이 메일을 거부했어요.' };
		},
	};
}

export function emailSenderFromEnv(env: EmailEnv, fetchFn: typeof fetch): EmailSender {
	return emailConfigured(env) ? resendSender(env.EMAIL_API_KEY!, env.EMAIL_FROM!, fetchFn) : notConfiguredSender;
}

/** The verified Google address of this user (the only e-mail recipient this app uses). */
export async function emailRecipient(db: D1Database, userId: string): Promise<string | null> {
	const row = await db
		.prepare(
			"SELECT email FROM oauth_accounts WHERE user_id = ? AND provider = 'google' AND email IS NOT NULL AND email_verified_at IS NOT NULL ORDER BY created_at LIMIT 1",
		)
		.bind(userId)
		.first<{ email: string }>();
	return row?.email && ADDRESS_PATTERN.test(row.email) ? row.email : null;
}

/** Switched on by the user and confirmed by an accepted test e-mail. */
export async function emailReady(db: D1Database, userId: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT enabled, verified_at FROM notification_preferences WHERE user_id = ? AND channel = 'email'")
		.bind(userId)
		.first<{ enabled: number; verified_at: string | null }>();
	return !!row && row.enabled === 1 && !!row.verified_at && !!(await emailRecipient(db, userId));
}

/** One row per attempt (reminders and test messages). */
export async function recordAttempt(
	db: D1Database,
	a: {
		notificationId: string | null;
		userId: string;
		memoId: string | null;
		channel: 'discord' | 'email';
		occurrenceKey: string | null;
		outcome: 'accepted' | 'retry' | 'failed';
		errorCode: string | null;
		providerMessageId?: string | null;
	},
	now: Date,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO notification_attempts (id, notification_id, user_id, memo_id, channel, occurrence_key, outcome, error_code, provider_message_id, attempted_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(crypto.randomUUID(), a.notificationId, a.userId, a.memoId, a.channel, a.occurrenceKey, a.outcome, a.errorCode, a.providerMessageId ?? null, now.toISOString())
		.run();
}

const EMAIL_DAY_PREFIX = 'email-sent:';

/** Count one e-mail against the app's daily cap (UTC day, like the provider's quota). */
export async function consumeEmailQuota(db: D1Database, env: EmailEnv, now: Date): Promise<boolean> {
	const day = now.toISOString().slice(0, 10);
	const end = new Date(`${day}T00:00:00Z`).getTime() + 86_400_000;
	const row = await db
		.prepare(
			`INSERT INTO usage_counters (counter_key, count, expires_at) VALUES (?, 1, ?)
			 ON CONFLICT(counter_key) DO UPDATE SET count = count + 1 RETURNING count`,
		)
		.bind(EMAIL_DAY_PREFIX + day, new Date(end).toISOString())
		.first<{ count: number }>();
	return (row?.count ?? 1) <= emailDailyLimit(env);
}
