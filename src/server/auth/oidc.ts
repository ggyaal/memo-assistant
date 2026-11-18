// Google ID token verification (OpenID Connect): RS256 signature against Google's published keys,
// then iss / aud / exp / iat / nonce. https://developers.google.com/identity/openid-connect/openid-connect
import { sha256Hex } from './crypto.ts';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
/** Allowed clock difference between Google and this Worker. */
const SKEW_SECONDS = 120;
const JWKS_CACHE_MS = 60 * 60 * 1000;

export interface GoogleClaims {
	sub: string;
	name?: string;
	picture?: string;
	email?: string;
	email_verified?: boolean;
}

/** The nonce for a login, derived from the server-side PKCE verifier (never stored separately). */
export async function oidcNonce(codeVerifier: string): Promise<string> {
	return sha256Hex(`oidc-nonce:${codeVerifier}`);
}

function b64urlBytes(part: string): Uint8Array {
	const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlJson(part: string): Record<string, unknown> {
	return JSON.parse(new TextDecoder().decode(b64urlBytes(part))) as Record<string, unknown>;
}

type Jwk = JsonWebKey & { kid?: string };
let cache: { keys: Jwk[]; until: number } | null = null;

/** For tests: forget cached keys. */
export function resetJwksCache(): void {
	cache = null;
}

async function googleKeys(fetchFn: typeof fetch, now: number, refresh: boolean): Promise<Jwk[]> {
	if (cache && cache.until > now && !refresh) return cache.keys;
	const res = await fetchFn(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`jwks request failed: ${res.status}`);
	const body = (await res.json()) as { keys?: Jwk[] };
	if (!Array.isArray(body.keys)) throw new Error('jwks without keys');
	cache = { keys: body.keys, until: now + JWKS_CACHE_MS };
	return body.keys;
}

export class IdTokenError extends Error {}

/**
 * Verify a Google ID token and return its claims. Throws IdTokenError on anything unexpected:
 * bad shape, unknown key, bad signature, wrong issuer/audience/nonce, expired or not yet valid.
 */
export async function verifyGoogleIdToken(
	idToken: string,
	opts: { clientId: string; nonce: string; now: Date; fetchFn: typeof fetch },
): Promise<GoogleClaims> {
	const parts = idToken.split('.');
	if (parts.length !== 3) throw new IdTokenError('malformed id_token');
	let header: Record<string, unknown>;
	let claims: Record<string, unknown>;
	try {
		header = b64urlJson(parts[0]);
		claims = b64urlJson(parts[1]);
	} catch {
		throw new IdTokenError('malformed id_token');
	}
	if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new IdTokenError('unexpected id_token header');

	const nowMs = opts.now.getTime();
	let jwk = (await googleKeys(opts.fetchFn, nowMs, false)).find((k) => k.kid === header.kid);
	if (!jwk) jwk = (await googleKeys(opts.fetchFn, nowMs, true)).find((k) => k.kid === header.kid); // keys rotate
	if (!jwk) throw new IdTokenError('unknown signing key');
	const key = await crypto.subtle.importKey(
		'jwk',
		{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['verify'],
	);
	const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
	if (!ok) throw new IdTokenError('bad signature');

	const nowSec = Math.floor(nowMs / 1000);
	if (!GOOGLE_ISSUERS.includes(String(claims.iss))) throw new IdTokenError('wrong issuer');
	const aud = claims.aud;
	const audOk = aud === opts.clientId || (Array.isArray(aud) && aud.includes(opts.clientId) && claims.azp === opts.clientId);
	if (!audOk) throw new IdTokenError('wrong audience');
	if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < nowSec) throw new IdTokenError('expired');
	if (typeof claims.iat === 'number' && claims.iat - SKEW_SECONDS > nowSec) throw new IdTokenError('issued in the future');
	if (claims.nonce !== opts.nonce) throw new IdTokenError('wrong nonce');
	if (typeof claims.sub !== 'string' || !claims.sub) throw new IdTokenError('no subject');
	return {
		sub: claims.sub,
		name: typeof claims.name === 'string' ? claims.name : undefined,
		picture: typeof claims.picture === 'string' ? claims.picture : undefined,
		email: typeof claims.email === 'string' ? claims.email : undefined,
		email_verified: claims.email_verified === true || claims.email_verified === 'true',
	};
}
