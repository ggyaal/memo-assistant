// Social login providers (Authorization Code + PKCE S256). Only identity is
// requested; provider access tokens are used once and never stored.

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
	fetchProfile: (accessToken: string, fetchFn: typeof fetch) => Promise<Profile>;
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
		scope: 'openid profile',
		clientId: (env) => env.GOOGLE_CLIENT_ID,
		clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
		secretRequired: true,
		async fetchProfile(token, fetchFn) {
			const me = await getJson(fetchFn, 'https://openidconnect.googleapis.com/v1/userinfo', token);
			if (typeof me.sub !== 'string') throw new Error('google profile without sub');
			return { subject: me.sub, displayName: clipName(me.name, 'Google 사용자') };
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
		async fetchProfile(token, fetchFn) {
			const me = await getJson(fetchFn, 'https://discord.com/api/users/@me', token);
			if (typeof me.id !== 'string') throw new Error('discord profile without id');
			return { subject: me.id, displayName: clipName(me.global_name ?? me.username, 'Discord 사용자') };
		},
	},
	kakao: {
		label: '카카오',
		authorizeUrl: 'https://kauth.kakao.com/oauth/authorize',
		tokenUrl: 'https://kauth.kakao.com/oauth/token',
		scope: 'profile_nickname',
		clientId: (env) => env.KAKAO_REST_API_KEY,
		clientSecret: (env) => env.KAKAO_CLIENT_SECRET,
		secretRequired: false,
		async fetchProfile(token, fetchFn) {
			const me = await getJson(fetchFn, 'https://kapi.kakao.com/v2/user/me', token);
			if (typeof me.id !== 'number' && typeof me.id !== 'string') throw new Error('kakao profile without id');
			const props = (me.properties ?? {}) as Record<string, unknown>;
			return { subject: String(me.id), displayName: clipName(props.nickname, '카카오 사용자') };
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
	params: { redirectUri: string; state: string; codeChallenge: string },
): string {
	const spec = SPECS[provider];
	const url = new URL(spec.authorizeUrl);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', spec.clientId(env) ?? '');
	url.searchParams.set('redirect_uri', params.redirectUri);
	url.searchParams.set('scope', spec.scope);
	url.searchParams.set('state', params.state);
	url.searchParams.set('code_challenge', params.codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	if (provider === 'google') url.searchParams.set('prompt', 'select_account');
	return url.toString();
}

/** Exchange the authorization code (server side, with PKCE verifier) and read the identity. */
export async function completeLogin(
	provider: Provider,
	env: AuthEnv,
	params: { code: string; redirectUri: string; codeVerifier: string },
	fetchFn: typeof fetch,
): Promise<Profile> {
	const spec = SPECS[provider];
	const form = new URLSearchParams({
		grant_type: 'authorization_code',
		code: params.code,
		redirect_uri: params.redirectUri,
		client_id: spec.clientId(env) ?? '',
		code_verifier: params.codeVerifier,
	});
	const secret = spec.clientSecret(env);
	if (secret) form.set('client_secret', secret);
	const res = await fetchFn(spec.tokenUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
		body: form,
	});
	if (!res.ok) throw new Error(`token request failed: ${res.status}`);
	const token = (await res.json()) as { access_token?: string };
	if (!token.access_token) throw new Error('token response without access_token');
	return spec.fetchProfile(token.access_token, fetchFn);
}
