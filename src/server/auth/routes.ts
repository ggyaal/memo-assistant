import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { pkceChallenge, randomToken, safeEqual } from './crypto.ts';
import { oidcNonce } from './oidc.ts';
import { type AuthEnv, authorizeUrl, completeLogin, isConfigured, isProvider, PROVIDERS, type Provider, providerLabel } from './providers.ts';
import {
	createSession,
	deleteSession,
	listAccounts,
	resolveAvatar,
	linkAccount,
	linkedProviders,
	loginWithProfile,
	readSession,
	saveOAuthState,
	SESSION_TTL_MS,
	SHARED_WORKSPACE,
	type SessionUser,
	takeOAuthState,
	type Workspace,
} from './store.ts';

const SESSION_COOKIE = 'memo_session'; // sent as __Host-memo_session
const STATE_COOKIE = 'memo_oauth'; // sent as __Host-memo_oauth
/** Linking or unlinking a login method needs a session created by a provider login this recently. */
export const RECENT_AUTH_MS = 10 * 60 * 1000;

export function recentlyAuthenticated(user: SessionUser, now: Date): boolean {
	return now.getTime() - Date.parse(user.authenticatedAt) <= RECENT_AUTH_MS;
}

/** Who is calling, decided only from the server-side session (never from request data). */
export interface AuthContext {
	user: SessionUser | null;
	workspace: Workspace;
}

export type AuthVariables = { auth: AuthContext };

type AuthBindings = AuthEnv & { DB: D1Database };

function sessionCookie(c: Context, token: string) {
	setCookie(c, SESSION_COOKIE, token, {
		prefix: 'host', // __Host-: Secure, Path=/, no Domain
		httpOnly: true,
		secure: true,
		sameSite: 'Lax', // sent on the top-level redirect back from the provider
		path: '/',
		maxAge: Math.floor(SESSION_TTL_MS / 1000),
	});
}

/** Middleware: attach the caller's identity and workspace (guest → the shared space). */
export function resolveAuth(now: () => Date): MiddlewareHandler<{ Bindings: AuthBindings; Variables: AuthVariables }> {
	return async (c, next) => {
		let user: SessionUser | null = null;
		const token = getCookie(c, SESSION_COOKIE, 'host');
		if (token) {
			try {
				user = await readSession(c.env.DB, token, now());
			} catch (error) {
				console.error('session lookup failed', String(error));
			}
			if (!user) deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, prefix: 'host' });
			else if (user.refreshed) sessionCookie(c, token);
		}
		c.set('auth', { user, workspace: user?.workspace ?? SHARED_WORKSPACE });
		await next();
	};
}

function sameOriginOrAbsent(c: Context): boolean {
	const origin = c.req.header('origin');
	if (!origin) return true;
	try {
		return new URL(origin).origin === new URL(c.req.url).origin;
	} catch {
		return false;
	}
}

function redirectHome(c: Context, error?: string) {
	return c.redirect(error ? `/?auth_error=${encodeURIComponent(error)}` : '/', 302);
}

export function registerAuthRoutes(
	api: Hono<{ Bindings: AuthBindings; Variables: AuthVariables }>,
	deps: { now: () => Date; fetchFn: typeof fetch },
) {
	const callbackUrl = (c: Context, provider: Provider) => `${new URL(c.req.url).origin}/api/auth/${provider}/callback`;

	// Who am I + which providers can be used. Safe to call as a guest.
	api.get('/me', async (c) => {
		const { user, workspace } = c.get('auth');
		const providers = Object.fromEntries(PROVIDERS.map((p) => [p, { label: providerLabel(p), configured: isConfigured(p, c.env) }]));
		if (!user) return c.json({ mode: 'guest', workspace, providers });
		const accounts = await listAccounts(c.env.DB, user.userId);
		const avatar = await resolveAvatar(c.env.DB, user.userId, accounts);
		return c.json({
			mode: 'user',
			workspace,
			user: {
				displayName: user.displayName,
				linked: accounts.map((a) => a.provider),
				avatarUrl: avatar.url,
				// A new account is offered nickname suggestions once (never again after a choice or skip).
				needsNickname: user.needsNickname,
			},
			providers,
		});
	});

	// Start a login (or, with ?link=1 while signed in, connect another account).
	api.get('/auth/:provider/start', async (c) => {
		const provider = c.req.param('provider');
		if (!isProvider(provider) || !isConfigured(provider, c.env)) return redirectHome(c, 'provider_unavailable');
		const { user } = c.get('auth');
		const linking = c.req.query('link') === '1';
		if (linking && !user) return redirectHome(c, 'login_required');
		// A stolen or long-lived session must not be able to attach an attacker's account.
		if (linking && !recentlyAuthenticated(user!, deps.now())) return redirectHome(c, 'reauth_required');
		const state = randomToken();
		const codeVerifier = randomToken() + randomToken(); // 86 chars (43–128 allowed)
		await saveOAuthState(c.env.DB, state, { provider, codeVerifier, linkUserId: linking ? user!.userId : null }, deps.now());
		// Bind the state to this browser: the callback must carry the same value in a cookie.
		setCookie(c, STATE_COOKIE, state, { prefix: 'host', httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600 });
		return c.redirect(
			authorizeUrl(provider, c.env, {
				redirectUri: callbackUrl(c, provider),
				state,
				codeChallenge: await pkceChallenge(codeVerifier),
				nonce: provider === 'google' ? await oidcNonce(codeVerifier) : undefined,
			}),
			302,
		);
	});

	api.get('/auth/:provider/callback', async (c) => {
		const provider = c.req.param('provider');
		const state = c.req.query('state') ?? '';
		const code = c.req.query('code') ?? '';
		const cookieState = getCookie(c, STATE_COOKIE, 'host') ?? '';
		deleteCookie(c, STATE_COOKIE, { path: '/', secure: true, prefix: 'host' });
		if (!isProvider(provider) || !isConfigured(provider, c.env)) return redirectHome(c, 'provider_unavailable');
		if (c.req.query('error')) return redirectHome(c, 'cancelled');
		if (!state || !code || !cookieState || !safeEqual(state, cookieState)) return redirectHome(c, 'invalid_state');
		const now = deps.now();
		const pending = await takeOAuthState(c.env.DB, state, now);
		if (!pending || pending.provider !== provider) return redirectHome(c, 'invalid_state');

		let profile;
		try {
			profile = await completeLogin(provider, c.env, { code, redirectUri: callbackUrl(c, provider), codeVerifier: pending.codeVerifier }, deps.fetchFn, now);
		} catch (error) {
			console.error('oauth exchange failed', provider, String(error));
			return redirectHome(c, 'provider_error');
		}

		if (pending.linkUserId) {
			const { user } = c.get('auth');
			if (!user || user.userId !== pending.linkUserId) return redirectHome(c, 'login_required');
			const result = await linkAccount(c.env.DB, user.userId, provider, profile, now);
			if (result === 'owned_by_other') return redirectHome(c, 'already_linked_elsewhere');
			if (result === 'provider_taken') return redirectHome(c, 'provider_already_linked');
			return c.redirect('/?linked=' + provider, 302);
		}

		const userId = await loginWithProfile(c.env.DB, provider, profile, now);
		const old = getCookie(c, SESSION_COOKIE, 'host');
		if (old) await deleteSession(c.env.DB, old);
		sessionCookie(c, await createSession(c.env.DB, userId, now));
		return redirectHome(c);
	});

	api.post('/auth/logout', async (c) => {
		if (!sameOriginOrAbsent(c)) return c.json({ error: 'forbidden_origin', message: '허용되지 않은 출처의 요청입니다.' }, 403);
		const token = getCookie(c, SESSION_COOKIE, 'host');
		if (token) await deleteSession(c.env.DB, token);
		deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, prefix: 'host' });
		return c.json({ ok: true });
	});
}
