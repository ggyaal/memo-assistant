// Social login providers (Authorization Code; PKCE S256 where the provider documents it).
// Only identity is requested; provider tokens are used once during the callback and never stored.
import { oidcNonce, verifyGoogleIdToken } from './oidc.ts';

export const PROVIDERS = ['google', 'discord', 'kakao'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface AuthEnv {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	DISCORD_CLIENT_ID?: string;
	DISCORD_CLIENT_SECRET?: string;
	KAKAO_REST_API_KEY?: string;
	KAKAO_CLIENT_SECRET?: string;
}

export interface Profile {
	subject: string;
	displayName: string;
	/** An address the provider itself verified (Google email_verified), else null. Never an account key. */
	email: string | null;
	/** Profile picture on an allow-listed https image host, else null (declined / none / default image). */
	avatarUrl: string | null;
}

/** Image hosts the providers serve profile pictures from (also allowed by the page's CSP img-src). */
export const AVATAR_HOSTS = ['googleusercontent.com', 'cdn.discordapp.com', 'kakaocdn.net'];

/** Only an https URL on a known image host; Kakao's older http:// links are upgraded. */
export function safeAvatarUrl(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 500) return null;
	try {
		const url = new URL(value.startsWith('http://') && /kakaocdn\.net/.test(value) ? `https://${value.slice(7)}` : value);
		const okHost = AVATAR_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
		return url.protocol === 'https:' && okHost && !url.username && !url.password ? url.toString() : null;
	} catch {
		return null;
	}
}

interface TokenResponse {
	access_token?: string;
	id_token?: string;
}

interface ProfileContext {
	env: AuthEnv;
	codeVerifier: string;
	now: Date;
	fetchFn: typeof fetch;
}

interface ProviderSpec {
	label: string;
	authorizeUrl: string;
	tokenUrl: string;
	scope: string;
	clientId: (env: AuthEnv) => string | undefined;
	/** Kakao's client secret is optional (only when enabled in the console). */
	clientSecret: (env: AuthEnv) => string | undefined;
	secretRequired: boolean;
	/** Kakao's REST docs list no code_challenge / code_verifier parameters: state (+ cookie binding) only. */
	pkce: boolean;
	readProfile: (token: TokenResponse, ctx: ProfileContext) => Promise<Profile>;
}

function accessToken(token: TokenResponse): string {
	if (!token.access_token) throw new Error('token response without access_token');
	return token.access_token;
}

async function getJson(fetchFn: typeof fetch, url: string, accessToken: string): Promise<Record<string, unknown>> {
	const res = await fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!res.ok) throw new Error(`profile request failed: ${res.status}`);
	return (await res.json()) as Record<string, unknown>;
}

function clipName(value: unknown, fallback: string): string {
	const name = typeof value === 'string' ? value.trim() : '';
	return (name || fallback).slice(0, 40);
}

const SPECS: Record<Provider, ProviderSpec> = {
	google: {
		label: 'Google',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		// OpenID Connect. No Gmail scope: reminder e-mails are sent by this service, not from the user's mailbox.
		scope: 'openid email profile',
		clientId: (env) => env.GOOGLE_CLIENT_ID,
		clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
		secretRequired: true,
		pkce: true,
		async readProfile(token, ctx) {
			if (!token.id_token) throw new Error('google token response without id_token');
			// Signature, issuer, audience, expiry and nonce are all checked; the identity is `sub`.
			const claims = await verifyGoogleIdToken(token.id_token, {
				clientId: ctx.env.GOOGLE_CLIENT_ID ?? '',
				nonce: await oidcNonce(ctx.codeVerifier),
				now: ctx.now,
				fetchFn: ctx.fetchFn,
			});
			const email = claims.email_verified && claims.email && claims.email.length <= 254 ? claims.email.toLowerCase() : null;
			return { subject: claims.sub, displayName: clipName(claims.name, 'Google 사용자'), email, avatarUrl: safeAvatarUrl(claims.picture) };
		},
	},
	discord: {
		label: 'Discord',
		authorizeUrl: 'https://discord.com/oauth2/authorize',
		tokenUrl: 'https://discord.com/api/oauth2/token',
		scope: 'identify',
		clientId: (env) => env.DISCORD_CLIENT_ID,
		clientSecret: (env) => env.DISCORD_CLIENT_SECRET,
		secretRequired: true,
		pkce: true,
		async readProfile(token, ctx) {
			const me = await getJson(ctx.fetchFn, 'https://discord.com/api/users/@me', accessToken(token));
			if (typeof me.id !== 'string') throw new Error('discord profile without id');
			const avatarUrl =
				typeof me.avatar === 'string' && /^(a_)?[0-9a-f]{32}$/.test(me.avatar) ? safeAvatarUrl(`https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`) : null;
			return { subject: me.id, displayName: clipName(me.global_name ?? me.username, 'Discord 사용자'), email: null, avatarUrl };
		},
	},
	kakao: {
		label: '카카오',
		authorizeUrl: 'https://kauth.kakao.com/oauth/authorize',
		tokenUrl: 'https://kauth.kakao.com/oauth/token',
		// Exactly the consent items set in the console (both optional). Comma-separated per Kakao docs.
		// No account_email (no permission), no talk_message, no openid: the id from /v2/user/me is enough.
		scope: 'profile_nickname,profile_image',
		clientId: (env) => env.KAKAO_REST_API_KEY,
		clientSecret: (env) => env.KAKAO_CLIENT_SECRET,
		secretRequired: false,
		pkce: false,
		async readProfile(token, ctx) {
			// `id` (회원번호) is the immutable identity. Nickname and picture are optional consents:
			// declining either still signs the person in (fallback name / default image).
			const me = await getJson(ctx.fetchFn, 'https://kapi.kakao.com/v2/user/me', accessToken(token));
			if (typeof me.id !== 'number' && typeof me.id !== 'string') throw new Error('kakao profile without id');
			const account = (me.kakao_account ?? {}) as Record<string, unknown>;
			const profile = (account.profile ?? {}) as Record<string, unknown>;
			const props = (me.properties ?? {}) as Record<string, unknown>;
			const avatarUrl = profile.is_default_image === true ? null : safeAvatarUrl(profile.profile_image_url ?? props.profile_image);
			return { subject: String(me.id), displayName: clipName(profile.nickname ?? props.nickname, '카카오 사용자'), email: null, avatarUrl };
		},
	},
};

export function providerLabel(provider: Provider): string {
	return SPECS[provider].label;
}

export function isProvider(value: string): value is Provider {
	return (PROVIDERS as readonly string[]).includes(value);
}

/** A provider is offered only when its keys are configured (never with fake values). */
export function isConfigured(provider: Provider, env: AuthEnv): boolean {
	const spec = SPECS[provider];
	return !!spec.clientId(env) && (!spec.secretRequired || !!spec.clientSecret(env));
}

export function authorizeUrl(
	provider: Provider,
	env: AuthEnv,
	params: { redirectUri: string; state: string; codeChallenge: string; nonce?: string },
): string {
	const spec = SPECS[provider];
	const url = new URL(spec.authorizeUrl);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', spec.clientId(env) ?? '');
	url.searchParams.set('redirect_uri', params.redirectUri);
	url.searchParams.set('scope', spec.scope);
	url.searchParams.set('state', params.state);
	if (spec.pkce) {
		url.searchParams.set('code_challenge', params.codeChallenge);
		url.searchParams.set('code_challenge_method', 'S256');
	}
	if (provider === 'google') {
		url.searchParams.set('prompt', 'select_account');
		if (params.nonce) url.searchParams.set('nonce', params.nonce);
	}
	return url.toString();
}

/** Exchange the authorization code (server side) and read the identity. Tokens are not kept. */
export async function completeLogin(
	provider: Provider,
	env: AuthEnv,
	params: { code: string; redirectUri: string; codeVerifier: string },
	fetchFn: typeof fetch,
	now: Date = new Date(),
): Promise<Profile> {
	const spec = SPECS[provider];
	const form = new URLSearchParams({
		grant_type: 'authorization_code',
		code: params.code,
		redirect_uri: params.redirectUri,
		client_id: spec.clientId(env) ?? '',
	});
	if (spec.pkce) form.set('code_verifier', params.codeVerifier);
	const secret = spec.clientSecret(env);
	if (secret) form.set('client_secret', secret);
	const res = await fetchFn(spec.tokenUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
		body: form,
	});
	if (!res.ok) throw new Error(`token request failed: ${res.status}`);
	const token = (await res.json()) as TokenResponse;
	return spec.readProfile(token, { env, codeVerifier: params.codeVerifier, now, fetchFn });
}
