// Fixed-window counters stored in D1. Enforced on the server before any AI call.

export interface RateLimitConfig {
	perMinute: number;
	perDay: number;
	/** Daily budget of *estimated* Neurons for memo organizing (see estimateMemoNeurons). */
	neuronBudget: number;
}

/**
 * Conservative cost estimate of organizing one input, from its length.
 * Measured (2026-11-14, glm-4.7-flash): 18–26 chars → 21–65 Neurons,
 * 463 chars → 125–215 Neurons. Output grows with the number of memos.
 */
export function estimateMemoNeurons(chars: number): number {
	return Math.ceil(30 + 0.4 * chars);
}

const MEMO_NEURONS_PREFIX = 'ai-neurons:';

export type RateLimitDecision =
	| { allowed: true }
	| { allowed: false; reason: 'rate_limited' | 'daily_limit_reached'; retryAfterSeconds: number };

const TOTAL_KEY = 'total:ai';
const NEVER_EXPIRES = '9999-12-31T00:00:00.000Z';
const DAY_MS = 86_400_000;

function utcDay(now: Date): { key: string; end: Date } {
	const day = now.toISOString().slice(0, 10);
	return { key: `global:${day}`, end: new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS) };
}

const VOICE_SECONDS_PREFIX = 'voice-sec:';

/** Add `amount` to a counter (creating it), returning the new value. */
async function addTo(db: D1Database, key: string, amount: number, expiresAt: string): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO usage_counters (counter_key, count, expires_at) VALUES (?, ?, ?)
			 ON CONFLICT(counter_key) DO UPDATE SET count = count + excluded.count
			 RETURNING count`,
		)
		.bind(key, amount, expiresAt)
		.first<{ count: number }>();
	return row?.count ?? amount;
}

/**
 * Voice budget in audio seconds per UTC day (Workers AI bills Whisper per audio
 * minute). Checked before a request; the real duration is added afterwards, so
 * the day can overshoot by at most one request.
 */
export async function voiceSecondsUsed(db: D1Database, now: Date): Promise<number> {
	const { key } = utcDay(now);
	const row = await db
		.prepare('SELECT count FROM usage_counters WHERE counter_key = ? AND expires_at > ?')
		.bind(VOICE_SECONDS_PREFIX + key, now.toISOString())
		.first<{ count: number }>();
	return row?.count ?? 0;
}

export async function addVoiceSeconds(db: D1Database, seconds: number, now: Date): Promise<number> {
	const { key, end } = utcDay(now);
	return addTo(db, VOICE_SECONDS_PREFIX + key, seconds, end.toISOString());
}

async function bump(db: D1Database, key: string, expiresAt: string): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO usage_counters (counter_key, count, expires_at) VALUES (?, 1, ?)
			 ON CONFLICT(counter_key) DO UPDATE SET count = count + 1
			 RETURNING count`,
		)
		.bind(key, expiresAt)
		.first<{ count: number }>();
	return row?.count ?? 1;
}

/** Generic fixed-window counter: at most `limit` hits per `windowMs` for `key`. */
export async function consumeWindow(
	db: D1Database,
	key: string,
	limit: number,
	windowMs: number,
	now: Date,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
	const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
	const windowEnd = windowStart + windowMs;
	const count = await bump(db, `${key}:${windowStart}`, new Date(windowEnd).toISOString());
	if (count <= limit) return { allowed: true };
	return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now.getTime()) / 1000)) };
}

/** One-way, non-reversible key for a client address (we never store raw IPs). */
export async function clientKey(ip: string | null | undefined): Promise<string> {
	const data = new TextEncoder().encode(`memo-assistant:${ip ?? 'unknown'}`);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)]
		.slice(0, 12)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Count one AI request for this client and for the whole app.
 * Per-client: `perMinute` per UTC minute. Global: `perDay` per UTC day
 * (matches the Workers AI free allocation reset at 00:00 UTC).
 */
export async function consumeAiQuota(
	db: D1Database,
	client: string,
	config: RateLimitConfig,
	now: Date,
	estimatedNeurons = 0,
): Promise<RateLimitDecision> {
	const nowIso = now.toISOString();
	await db.prepare('DELETE FROM usage_counters WHERE expires_at <= ?').bind(nowIso).run();

	const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;
	const minuteEnd = new Date(minuteStart + 60_000);
	const perMinute = await bump(db, `client:${client}:${minuteStart}`, minuteEnd.toISOString());
	if (perMinute > config.perMinute) {
		return {
			allowed: false,
			reason: 'rate_limited',
			retryAfterSeconds: Math.max(1, Math.ceil((minuteEnd.getTime() - now.getTime()) / 1000)),
		};
	}

	const { key: dayKey, end: dayEnd } = utcDay(now);
	const dayDenied = {
		allowed: false as const,
		reason: 'daily_limit_reached' as const,
		retryAfterSeconds: Math.ceil((dayEnd.getTime() - now.getTime()) / 1000),
	};
	// Cost budget first (checked, not yet spent), so a denied request costs nothing.
	const neuronKey = MEMO_NEURONS_PREFIX + dayKey;
	const spent = await db
		.prepare('SELECT count FROM usage_counters WHERE counter_key = ? AND expires_at > ?')
		.bind(neuronKey, nowIso)
		.first<{ count: number }>();
	if ((spent?.count ?? 0) + estimatedNeurons > config.neuronBudget) return dayDenied;

	const perDay = await bump(db, dayKey, dayEnd.toISOString());
	if (perDay > config.perDay) return dayDenied;
	await addTo(db, neuronKey, estimatedNeurons, dayEnd.toISOString());
	// All-time counter: only requests that actually go on to the AI.
	await bump(db, TOTAL_KEY, NEVER_EXPIRES);
	return { allowed: true };
}

export interface UsageSnapshot {
	today: { used: number; limit: number; resetsAt: string; neurons: number; neuronBudget: number };
	total: number;
	voice: { usedSeconds: number; limitSeconds: number };
}

/**
 * Public usage numbers for the page. "Today" is the UTC day (resets at
 * 09:00 KST, like the Workers AI free allocation); the stored day counter can
 * exceed the limit by denied attempts, so it is capped for display.
 */
export async function readUsage(
	db: D1Database,
	perDay: number,
	now: Date,
	voiceLimitSeconds: number,
	neuronBudget: number,
): Promise<UsageSnapshot> {
	const { key: dayKey, end: dayEnd } = utcDay(now);
	const { results } = await db
		.prepare('SELECT counter_key, count, expires_at FROM usage_counters WHERE counter_key IN (?, ?, ?, ?)')
		.bind(dayKey, TOTAL_KEY, VOICE_SECONDS_PREFIX + dayKey, MEMO_NEURONS_PREFIX + dayKey)
		.all<{ counter_key: string; count: number; expires_at: string }>();
	const day = results.find((r) => r.counter_key === dayKey && r.expires_at > now.toISOString());
	const total = results.find((r) => r.counter_key === TOTAL_KEY);
	return {
		today: {
			used: Math.min(day?.count ?? 0, perDay),
			limit: perDay,
			resetsAt: dayEnd.toISOString(),
			neurons: Math.min(
				results.find((r) => r.counter_key === MEMO_NEURONS_PREFIX + dayKey && r.expires_at > now.toISOString())?.count ?? 0,
				neuronBudget,
			),
			neuronBudget,
		},
		total: total?.count ?? 0,
		voice: {
			usedSeconds: Math.min(
				results.find((r) => r.counter_key === VOICE_SECONDS_PREFIX + dayKey && r.expires_at > now.toISOString())?.count ?? 0,
				voiceLimitSeconds,
			),
			limitSeconds: voiceLimitSeconds,
		},
	};
}
