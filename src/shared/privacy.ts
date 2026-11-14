// Detects obvious personal/secret data before a memo is published on the
// public board. Used by the server (enforced, before any AI call) and by the
// client (early warning). Only matched *types* are reported, never the values.
//
// Deliberately narrow so ordinary memos still pass: "비밀번호 바꾸기" is a task,
// "비밀번호는 abcd1234" is a secret. This is a safety net, not a guarantee —
// names, addresses and free-form secrets are not detected.

export type SensitiveKind = 'phone' | 'email' | 'resident_id' | 'card' | 'secret';

export const SENSITIVE_LABELS: Record<SensitiveKind, string> = {
	phone: '전화번호',
	email: '이메일 주소',
	resident_id: '주민등록번호',
	card: '카드번호',
	secret: '비밀번호·인증번호',
};

const RULES: ReadonlyArray<{ kind: SensitiveKind; pattern: RegExp }> = [
	// 주민등록번호 / 외국인등록번호: YYMMDD-[1-8]XXXXXX (checked before phone/card).
	{ kind: 'resident_id', pattern: /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\s?-?\s?[1-8]\d{6}(?!\d)/ },
	// Card numbers: 4-4-4-4 (spaces/hyphens optional), or 15-16 digits in a row.
	{ kind: 'card', pattern: /(?<!\d)(?:\d{4}[\s-]?){3}\d{4}(?!\d)|(?<!\d)\d{15,16}(?!\d)/ },
	// Korean mobile / landline / 070, with or without separators.
	{ kind: 'phone', pattern: /(?<!\d)(?:01[016789]|0(?:2|[3-6][1-5]|70))[\s.-]?\d{3,4}[\s.-]?\d{4}(?!\d)/ },
	{ kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
	// A secret keyword followed by a value: "비밀번호: abcd1234", "pw=1234", "인증번호는 482913".
	{
		kind: 'secret',
		pattern:
			/(?:비밀\s*번호|비번|패스워드|암호|password|passwd|pwd|\bpw\b|\bpin\b|핀\s*번호|인증\s*번호|otp|보안\s*코드|cvc|cvv|api\s*key|토큰|token)\s*(?:[:=]|은|는|이|가|=>)\s*["']?[A-Za-z0-9!@#$%^&*()_+\-=.?]{4,}/i,
	},
];

/**
 * Kinds of sensitive data found in the text (empty when none). Rules run in
 * order and each match is blanked out before the next rule, so the digits of
 * a resident id are not reported again as a card or phone number.
 */
export function detectSensitive(text: string): SensitiveKind[] {
	const found: SensitiveKind[] = [];
	let rest = text;
	for (const { kind, pattern } of RULES) {
		const all = new RegExp(pattern.source, `${pattern.flags}g`);
		if (all.test(rest)) {
			found.push(kind);
			rest = rest.replace(all, ' ');
		}
	}
	return found;
}

/** "전화번호, 이메일 주소" for a user-facing message. */
export function describeSensitive(kinds: SensitiveKind[]): string {
	return kinds.map((k) => SENSITIVE_LABELS[k]).join(', ');
}
