// D1 access for users, social accounts, sessions, OAuth states and workspaces.
import { randomToken, sha256Hex } from './crypto.ts';
import type { Profile, Provider } from './providers.ts';

export const SHARED_WORKSPACE_ID = 'ws_shared_guest';
export const SHARED_WORKSPACE_NAME = '익명의 스케줄';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000; // extend at most once a day
const STATE_TTL_MS = 10 * 60 * 1000;

export interface Workspace {
	id: string;
	kind: 'shared_guest' | 'personal';
	name: string;
}

export interface SessionUser {
	sessionId: string;
	userId: string;
	displayName: string;
	workspace: Workspace;
	/** True when the expiry was pushed forward and the cookie should be re-sent. */
	refreshed: boolean;
	/** When this session was created by a provider login (for "recent sign-in" checks). */
	authenticatedAt: string;
}

export const SHARED_WORKSPACE: Workspace = { id: SHARED_WORKSPACE_ID, kind: 'shared_guest', name: SHARED_WORKSPACE_NAME };

// ---- OAuth state (one-time, short-lived) --------------------------------------------------

export async function saveOAuthState(
	db: D1Database,
	state: string,
	data: { provider: Provider; codeVerifier: string; linkUserId: string | null },
	now: Date,
): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(now.toISOString()),
		db
			.prepare('INSERT INTO oauth_states (id, provider, code_verifier, link_user_id, expires_at) VALUES (?, ?, ?, ?, ?)')
			.bind(await sha256Hex(state), data.provider, data.codeVerifier, data.linkUserId, new Date(now.getTime() + STATE_TTL_MS).toISOString()),
	]);
}

/** Read and delete a state in one step, so a state can never be used twice. */
export async function takeOAuthState(
	db: D1Database,
	state: string,
	now: Date,
): Promise<{ provider: Provider; codeVerifier: string; linkUserId: string | null } | null> {
	const row = await db
		.prepare('DELETE FROM oauth_states WHERE id = ? RETURNING provider, code_verifier, link_user_id, expires_at')
		.bind(await sha256Hex(state))
		.first<{ provider: Provider; code_verifier: string; link_user_id: string | null; expires_at: string }>();
	if (!row || row.expires_at <= now.toISOString()) return null;
	return { provider: row.provider, codeVerifier: row.code_verifier, linkUserId: row.link_user_id };
}

// ---- Users and linked accounts ------------------------------------------------------------

/**
 * Find the user behind a social account, or create a new user with a personal
 * workspace. Accounts are matched only by (provider, subject) — never by e-mail.
 */
export async function loginWithProfile(db: D1Database, provider: Provider, profile: Profile, now: Date): Promise<string> {
	const nowIso = now.toISOString();
	const existing = await db
		.prepare('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_subject = ?')
		.bind(provider, profile.subject)
		.first<{ user_id: string }>();
	if (existing) {
		await refreshAccount(db, provider, profile, now);
		return existing.user_id;
	}
	const userId = `usr_${crypto.randomUUID()}`;
	const workspaceId = `ws_${crypto.randomUUID()}`;
	try {
		await db.batch([
			db.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(userId, profile.displayName, nowIso),
			db
				.prepare("INSERT INTO workspaces (id, kind, owner_user_id, name, created_at) VALUES (?, 'personal', ?, ?, ?)")
				.bind(workspaceId, userId, `${profile.displayName}님의 메모`, nowIso),
			insertAccount(db, userId, provider, profile, now),
		]);
		return userId;
	} catch (error) {
		// Two simultaneous first logins: the other one won; use its user.
		const winner = await db
			.prepare('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_subject = ?')
			.bind(provider, profile.subject)
			.first<{ user_id: string }>();
		if (winner) return winner.user_id;
		throw error;
	}
}

function insertAccount(db: D1Database, userId: string, provider: Provider, profile: Profile, now: Date): D1PreparedStatement {
	const nowIso = now.toISOString();
	return db
		.prepare(
			`INSERT INTO oauth_accounts (id, user_id, provider, provider_subject, display_name, created_at, last_login_at, email, email_verified_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(crypto.randomUUID(), userId, provider, profile.subject, profile.displayName, nowIso, nowIso, profile.email, profile.email ? nowIso : null);
}

/** Latest name and verified address from a fresh login (an address that is no longer verified is dropped). */
async function refreshAccount(db: D1Database, provider: Provider, profile: Profile, now: Date): Promise<void> {
	const nowIso = now.toISOString();
	await db
		.prepare(
			`UPDATE oauth_accounts SET last_login_at = ?, display_name = ?, email = ?,
			   email_verified_at = CASE WHEN ? IS NULL THEN NULL WHEN email = ? THEN COALESCE(email_verified_at, ?) ELSE ? END
			 WHERE provider = ? AND provider_subject = ?`,
		)
		.bind(nowIso, profile.displayName, profile.email, profile.email, profile.email, nowIso, nowIso, provider, profile.subject)
		.run();
}

export type LinkResult = 'linked' | 'already_yours' | 'owned_by_other' | 'provider_taken';

/**
 * Explicitly attach another social account to the signed-in user (never merges users).
 * An account that belongs to someone else is never taken over, and one user keeps at most one
 * account per provider (so "the Google address" for e-mail reminders is never ambiguous).
 */
export async function linkAccount(db: D1Database, userId: string, provider: Provider, profile: Profile, now: Date): Promise<LinkResult> {
	const existing = await db
		.prepare('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_subject = ?')
		.bind(provider, profile.subject)
		.first<{ user_id: string }>();
	if (existing) {
		if (existing.user_id !== userId) return 'owned_by_other';
		await refreshAccount(db, provider, profile, now);
		return 'already_yours';
	}
	const same = await db.prepare('SELECT 1 AS x FROM oauth_accounts WHERE user_id = ? AND provider = ?').bind(userId, provider).first();
	if (same) return 'provider_taken';
	try {
		await insertAccount(db, userId, provider, profile, now).run();
	} catch {
		return 'owned_by_other'; // someone linked/logged in with it a moment earlier (UNIQUE)
	}
	return 'linked';
}

export interface LinkedAccount {
	provider: Provider;
	displayName: string | null;
	/** Provider-verified address (Google only), shown to the owner in settings. */
	email: string | null;
	linkedAt: string;
}

export async function listAccounts(db: D1Database, userId: string): Promise<LinkedAccount[]> {
	const { results } = await db
		.prepare('SELECT provider, display_name, email, email_verified_at, created_at FROM oauth_accounts WHERE user_id = ? ORDER BY created_at')
		.bind(userId)
		.all<{ provider: Provider; display_name: string | null; email: string | null; email_verified_at: string | null; created_at: string }>();
	return results.map((r) => ({ provider: r.provider, displayName: r.display_name, email: r.email_verified_at ? r.email : null, linkedAt: r.created_at }));
}

export type UnlinkResult = 'unlinked' | 'not_linked' | 'last_method';

/**
 * Remove one login method. The last one can never be removed (the user would be locked out
 * of their personal space). Notification channels that depended on it are switched off.
 */
export async function unlinkAccount(db: D1Database, userId: string, provider: Provider, now: Date): Promise<UnlinkResult> {
	const accounts = await linkedProviders(db, userId);
	if (!accounts.includes(provider)) return 'not_linked';
	if (accounts.length <= 1) return 'last_method';
	const channel = provider === 'discord' ? 'discord' : provider === 'google' ? 'email' : null;
	const nowIso = now.toISOString();
	// Conditional delete: refuses if, meanwhile, this became the only method left.
	const res = await db
		.prepare('DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ? AND (SELECT COUNT(*) FROM oauth_accounts WHERE user_id = ?) > 1')
		.bind(userId, provider, userId)
		.run();
	if (!res.meta.changes) return 'last_method';
	if (channel) {
		await db
			.prepare('UPDATE notification_preferences SET enabled = 0, verified_at = NULL, updated_at = ? WHERE user_id = ? AND channel = ?')
			.bind(nowIso, userId, channel)
			.run();
	}
	return 'unlinked';
}

export async function linkedProviders(db: D1Database, userId: string): Promise<Provider[]> {
	const { results } = await db
		.prepare('SELECT provider FROM oauth_accounts WHERE user_id = ? ORDER BY created_at')
		.bind(userId)
		.all<{ provider: Provider }>();
	return results.map((r) => r.provider);
}

// ---- Sessions -----------------------------------------------------------------------------

/** Returns the raw token for the cookie; only its hash is stored. */
export async function createSession(db: D1Database, userId: string, now: Date): Promise<string> {
	const token = randomToken();
	const nowIso = now.toISOString();
	await db.batch([
		db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(nowIso),
		db
			.prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
			.bind(await sha256Hex(token), userId, nowIso, nowIso, new Date(now.getTime() + SESSION_TTL_MS).toISOString()),
	]);
	return token;
}

/** Validate a session token from the cookie and resolve the user's personal workspace. */
export async function readSession(db: D1Database, token: string, now: Date): Promise<SessionUser | null> {
	const id = await sha256Hex(token);
	const nowIso = now.toISOString();
	const row = await db
		.prepare(
			`SELECT s.id, s.user_id, s.last_seen_at, s.created_at, u.display_name, w.id AS workspace_id, w.name AS workspace_name
			 FROM sessions s
			 JOIN users u ON u.id = s.user_id
			 JOIN workspaces w ON w.owner_user_id = s.user_id AND w.kind = 'personal'
			 WHERE s.id = ? AND s.expires_at > ?`,
		)
		.bind(id, nowIso)
		.first<{ id: string; user_id: string; last_seen_at: string; created_at: string; display_name: string; workspace_id: string; workspace_name: string }>();
	if (!row) return null;
	let refreshed = false;
	if (now.getTime() - Date.parse(row.last_seen_at) > SESSION_REFRESH_MS) {
		await db
			.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
			.bind(nowIso, new Date(now.getTime() + SESSION_TTL_MS).toISOString(), id)
			.run();
		refreshed = true;
	}
	return {
		sessionId: id,
		userId: row.user_id,
		displayName: row.display_name,
		workspace: { id: row.workspace_id, kind: 'personal', name: row.workspace_name },
		refreshed,
		authenticatedAt: row.created_at,
	};
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
	await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
}
