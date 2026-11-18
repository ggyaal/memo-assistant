// Nickname rules shared by the server (AI output check, fallback) and the screen (emoji, input hints).
// A nickname is only a display name: never an identifier, never used to find or merge accounts.
import { detectSensitive } from './privacy.ts';

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 20;
export const SUGGESTION_COUNT = 3;

export interface NicknameSuggestion {
	name: string;
	emoji: string;
}

const ADJECTIVES = [
	'메모하는', '생각이 많은', '달빛을 모으는', '내일을 미루는', '부지런한', '느긋한', '꼼꼼한', '상상하는',
	'노래하는', '산책하는', '별을 세는', '계획 세우는', '호기심 많은', '차분한', '반짝이는', '일찍 일어난',
];
const MIDDLES = ['', '', '작은', '포근한', '용감한', '수줍은', '졸린', '씩씩한'];

/** Animal (or thing) → emoji. AI names are matched by these words too; unknown → ✨. */
const ANIMALS: [string, string][] = [
	['여우', '🦊'], ['수달', '🦦'], ['펭귄', '🐧'], ['문어', '🐙'], ['고양이', '🐱'], ['강아지', '🐶'], ['토끼', '🐰'], ['곰', '🐻'],
	['판다', '🐼'], ['다람쥐', '🐿️'], ['고슴도치', '🦔'], ['부엉이', '🦉'], ['올빼미', '🦉'], ['거북이', '🐢'], ['고래', '🐳'], ['돌고래', '🐬'],
	['햄스터', '🐹'], ['코알라', '🐨'], ['사자', '🦁'], ['호랑이', '🐯'], ['병아리', '🐥'], ['오리', '🦆'], ['나비', '🦋'], ['꿀벌', '🐝'],
	['해파리', '🪼'], ['물개', '🦭'], ['너구리', '🦝'], ['라마', '🦙'], ['기린', '🦒'], ['개구리', '🐸'], ['달팽이', '🐌'], ['참새', '🐦'],
];
const FALLBACK_ANIMALS = ['여우', '수달', '펭귄', '문어', '고양이', '토끼', '곰', '다람쥐', '고슴도치', '부엉이', '거북이', '고래', '햄스터', '판다', '물개', '너구리'];

/** Words that never belong in a public-facing nickname (kept short; the AI is also told). */
const BLOCKED = [
	'시발', '씨발', 'ㅅㅂ', '병신', '개새', '좆', '존나', '닥쳐', '죽어', '죽여', '자살', '살인', '섹스', '야동', '변태', '마약', '도박',
	'관리자', '운영자', '메모비서', '익명의 스케줄', '공식',
];

export function emojiFor(name: string): string {
	// Longest match first (e.g. 돌고래 before 고래).
	const hit = [...ANIMALS].sort((a, b) => b[0].length - a[0].length).find(([word]) => name.includes(word));
	return hit ? hit[1] : '✨';
}

/** Why a nickname cannot be used, or null. Same rule for AI output and (lightly) for typed input. */
export function nicknameProblem(raw: string): string | null {
	const name = raw.replace(/\s+/g, ' ').trim();
	if (name.length < NICKNAME_MIN) return `닉네임은 ${NICKNAME_MIN}자 이상이어야 해요.`;
	if (name.length > NICKNAME_MAX) return `닉네임은 ${NICKNAME_MAX}자 이하여야 해요.`;
	const compact = name.replace(/\s/g, '');
	if (BLOCKED.some((w) => compact.includes(w.replace(/\s/g, '')))) return '사용할 수 없는 표현이 들어 있어요.';
	if (detectSensitive(name).length > 0) return '연락처 같은 개인정보는 닉네임에 쓸 수 없어요.';
	return null;
}

/** AI names are kept short enough to read at a glance (the prompt asks for 6–16). */
export const AI_NICKNAME_MAX = 16;

/** Stricter check for AI output: Korean words (and spaces) only, no URLs, digits or symbols. */
export function isGoodAiNickname(name: string): boolean {
	return name.length <= AI_NICKNAME_MAX && /^[가-힣]+(?: [가-힣]+){0,4}$/.test(name) && nicknameProblem(name) === null;
}

const pick = <T,>(list: readonly T[], rand: () => number): T => list[Math.floor(rand() * list.length) % list.length];

/** "메모하는 작은 여우" — the no-AI nickname (new accounts start with one; also the AI fallback). */
export function randomNickname(rand: () => number = Math.random): string {
	const middle = pick(MIDDLES, rand);
	return [pick(ADJECTIVES, rand), middle, pick(FALLBACK_ANIMALS, rand)].filter(Boolean).join(' ');
}

export function fallbackSuggestions(rand: () => number = Math.random, avoid: string[] = []): NicknameSuggestion[] {
	const out: NicknameSuggestion[] = [];
	for (let i = 0; i < 50 && out.length < SUGGESTION_COUNT; i++) {
		const name = randomNickname(rand);
		if (!out.some((s) => s.name === name) && !avoid.includes(name)) out.push({ name, emoji: emojiFor(name) });
	}
	return out;
}

/**
 * Read the model's answer: a JSON array of strings (or {"nicknames": [...]}), possibly wrapped in
 * a code fence or followed by text. Keeps only good, distinct names; never throws.
 */
export function parseAiNicknames(text: string): string[] {
	const candidates: unknown[] = [];
	const match = text.match(/\[[\s\S]*?\]/);
	for (const chunk of [text.trim(), match?.[0] ?? '']) {
		if (!chunk) continue;
		try {
			const parsed = JSON.parse(chunk) as unknown;
			const list = Array.isArray(parsed) ? parsed : (parsed as { nicknames?: unknown })?.nicknames;
			if (Array.isArray(list)) {
				candidates.push(...list);
				break;
			}
		} catch {
			// not JSON; try the next form
		}
	}
	if (candidates.length === 0) {
		// One name per line ("1. 메모하는 작은 여우").
		for (const line of text.split('\n')) candidates.push(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/["'“”]/g, ''));
	}
	const names: string[] = [];
	for (const c of candidates) {
		if (typeof c !== 'string') continue;
		const name = c.replace(/\s+/g, ' ').trim();
		if (isGoodAiNickname(name) && !names.includes(name)) names.push(name);
	}
	return names.slice(0, SUGGESTION_COUNT);
}

/** Exactly three suggestions: the valid AI names first, topped up with fallback names. */
export function completeSuggestions(aiNames: string[], rand: () => number = Math.random): NicknameSuggestion[] {
	const out = aiNames.slice(0, SUGGESTION_COUNT).map((name) => ({ name, emoji: emojiFor(name) }));
	for (const s of fallbackSuggestions(rand, out.map((o) => o.name))) {
		if (out.length >= SUGGESTION_COUNT) break;
		out.push(s);
	}
	return out;
}
