// Fixed-window counters stored in D1. Enforced on the server before any AI call.

export interface RateLimitConfig {
	perMinute: number;
	perDay: number;
}

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
	const perDay = await bump(db, dayKey, dayEnd.toISOString());
	if (perDay > config.perDay) {
		return {
			allowed: false,
			reason: 'daily_limit_reached',
			retryAfterSeconds: Math.ceil((dayEnd.getTime() - now.getTime()) / 1000),
		};
	}
	// All-time counter: only requests that actually go on to the AI.
	await bump(db, TOTAL_KEY, NEVER_EXPIRES);
	return { allowed: true };
}

export interface UsageSnapshot {
	today: { used: number; limit: number; resetsAt: string };
	total: number;
}

/**
 * Public usage numbers for the page. "Today" is the UTC day (resets at
 * 09:00 KST, like the Workers AI free allocation); the stored day counter can
 * exceed the limit by denied attempts, so it is capped for display.
 */
export async function readUsage(db: D1Database, perDay: number, now: Date): Promise<UsageSnapshot> {
	const { key: dayKey, end: dayEnd } = utcDay(now);
	const { results } = await db
		.prepare('SELECT counter_key, count, expires_at FROM usage_counters WHERE counter_key IN (?, ?)')
		.bind(dayKey, TOTAL_KEY)
		.all<{ counter_key: string; count: number; expires_at: string }>();
	const day = results.find((r) => r.counter_key === dayKey && r.expires_at > now.toISOString());
	const total = results.find((r) => r.counter_key === TOTAL_KEY);
	return {
		today: { used: Math.min(day?.count ?? 0, perDay), limit: perDay, resetsAt: dayEnd.toISOString() },
		total: total?.count ?? 0,
	};
}
