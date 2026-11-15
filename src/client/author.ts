// "My memos" on the public board without login: a random key kept in this browser.
// Only its SHA-256 is stored on the server; a 16-hex prefix lets the page recognise its own memos.
const KEY = 'memo-assistant:author-key';

function read(): string | null {
	try {
		const v = localStorage.getItem(KEY);
		return v && /^[0-9a-f]{64}$/.test(v) ? v : null;
	} catch {
		return null;
	}
}

/** The browser's author key; created on first use when `create` is set (when writing a memo). */
export function authorKey(create = false): string | null {
	const existing = read();
	if (existing || !create) return existing;
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const key = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
	try {
		localStorage.setItem(KEY, key);
	} catch {
		return null; // storage blocked: memos are just not deletable later from this browser
	}
	return key;
}

let tagPromise: Promise<string | null> | null = null;
/** First 16 hex of SHA-256(key), matching Memo.author_tag of memos written here. */
export function myAuthorTag(): Promise<string | null> {
	const key = read();
	if (!key) return Promise.resolve(null);
	tagPromise ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)).then((buf) =>
		[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16),
	);
	return tagPromise;
}

export function resetAuthorTagCache() {
	tagPromise = null;
}
