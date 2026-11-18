// A fake Google OpenID provider for tests: a real RSA key, a JWKS document and signed ID tokens,
// so the production verifier (signature, iss, aud, exp, nonce) runs unchanged.
import { GOOGLE_JWKS_URL, oidcNonce } from '../../src/server/auth/oidc.ts';

const enc = (value: unknown) =>
	btoa(typeof value === 'string' ? value : JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function bytesToB64url(bytes: ArrayBuffer): string {
	let bin = '';
	for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface FakeGoogle {
	jwksUrl: string;
	jwks: () => Response;
	/** Sign claims with the published key (or with an unpublished one: `foreignKey`). */
	sign: (claims: Record<string, unknown>, opts?: { kid?: string; foreignKey?: boolean }) => Promise<string>;
	/** A valid ID token for the token endpoint, from the request form (nonce derived from code_verifier). */
	idTokenFor: (form: URLSearchParams, claims: Record<string, unknown>, now: Date) => Promise<string>;
}

export async function createFakeGoogle(clientId: string): Promise<FakeGoogle> {
	const algo = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
	const pair = (await crypto.subtle.generateKey(algo, true, ['sign', 'verify'])) as CryptoKeyPair;
	const other = (await crypto.subtle.generateKey(algo, true, ['sign', 'verify'])) as CryptoKeyPair;
	const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
	const kid = 'test-key-1';
	const sign = async (claims: Record<string, unknown>, opts: { kid?: string; foreignKey?: boolean } = {}) => {
		const head = enc({ alg: 'RS256', kid: opts.kid ?? kid, typ: 'JWT' });
		const body = enc(claims);
		const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.foreignKey ? other.privateKey : pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
		return `${head}.${body}.${bytesToB64url(sig)}`;
	};
	return {
		jwksUrl: GOOGLE_JWKS_URL,
		jwks: () => Response.json({ keys: [{ kty: pub.kty, n: pub.n, e: pub.e, alg: 'RS256', use: 'sig', kid }] }),
		sign,
		async idTokenFor(form, claims, now) {
			const iat = Math.floor(now.getTime() / 1000);
			return sign({
				iss: 'https://accounts.google.com',
				aud: clientId,
				azp: clientId,
				iat,
				exp: iat + 3600,
				nonce: await oidcNonce(form.get('code_verifier') ?? ''),
				...claims,
			});
		},
	};
}
