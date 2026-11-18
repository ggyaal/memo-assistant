// AI nickname suggestions: one Workers AI call returns three names. Nothing about the person is
// sent (no social name, e-mail or id) — only a random theme so repeated requests differ.
import { completeSuggestions, fallbackSuggestions, type NicknameSuggestion, parseAiNicknames } from '../shared/nickname.ts';

export interface NicknameRun {
	names: string[];
	usage: { input: number; output: number } | null;
}

/** Injectable for tests; production calls the same model as memo organizing. */
export type NicknameGenerator = (theme: string) => Promise<NicknameRun>;

const THEMES = ['숲속', '바닷가', '밤하늘', '도서관', '카페', '비 오는 날', '봄날', '눈 오는 밤', '작은 마을', '우주', '정원', '아침 햇살'];

export function randomTheme(rand: () => number = Math.random): string {
	return THEMES[Math.floor(rand() * THEMES.length) % THEMES.length];
}

export const NICKNAME_PROMPT = (theme: string) =>
	[
		'메모 앱 사용자에게 줄 한국어 닉네임 3개를 지어 주세요.',
		`분위기: ${theme}`,
		'규칙: 친근하고 귀엽게, "꾸미는 말 + 동물" 형태(예: 달빛을 수집하는 수달, 메모하는 작은 여우, 생각이 많은 문어).',
		'각 닉네임은 띄어쓰기 포함 14자 이내의 짧은 이름, 한글만(숫자·영어·기호·이모지 금지). 욕설·비하·성적·폭력적 표현, 실존 인물·브랜드 이름 금지.',
		'설명 없이 JSON 문자열 배열 하나만 출력: ["...","...","..."]',
	].join('\n');

/** "cloudflare/@cf/..." (Flue model id) → "@cf/..." (Workers AI binding id). */
export function workersAiModel(memoModel: string | undefined): string {
	const id = memoModel || 'cloudflare/@cf/zai-org/glm-4.7-flash';
	return id.startsWith('cloudflare/') ? id.slice('cloudflare/'.length) : id;
}

interface ChatOutput {
	response?: unknown;
	choices?: { message?: { content?: unknown } }[];
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function workersAiNicknames(ai: Ai, model: string): NicknameGenerator {
	return async (theme) => {
		const out = (await (ai as unknown as { run: (m: string, input: unknown) => Promise<ChatOutput> }).run(model, {
			messages: [{ role: 'user', content: NICKNAME_PROMPT(theme) }],
			max_completion_tokens: 150, // answers measured 33–61 tokens; also bounds a runaway call
			temperature: 1,
			// Reasoning model: skip the hidden "thinking" so a 3-name answer stays a few dozen tokens.
			chat_template_kwargs: { enable_thinking: false },
		})) as ChatOutput;
		const content = out.choices?.[0]?.message?.content ?? out.response;
		const text = typeof content === 'string' ? content : '';
		const usage =
			typeof out.usage?.prompt_tokens === 'number' && typeof out.usage?.completion_tokens === 'number'
				? { input: out.usage.prompt_tokens, output: out.usage.completion_tokens }
				: null;
		return { names: parseAiNicknames(text), usage };
	};
}

export interface SuggestResult {
	suggestions: NicknameSuggestion[];
	/** 'ai': at least one AI name; 'fallback': no AI (quota, error, offline) — the person still gets three. */
	source: 'ai' | 'fallback';
	usage: { input: number; output: number } | null;
}

/** Never throws: any AI problem gives fallback names, so sign-up never fails because of it. */
export async function suggestNicknames(generate: NicknameGenerator | null, timeoutMs = 8_000): Promise<SuggestResult> {
	if (!generate) return { suggestions: fallbackSuggestions(), source: 'fallback', usage: null };
	try {
		const run = await Promise.race([
			generate(randomTheme()),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('nickname timeout')), timeoutMs)),
		]);
		if (run.names.length === 0) return { suggestions: fallbackSuggestions(), source: 'fallback', usage: run.usage };
		return { suggestions: completeSuggestions(run.names), source: 'ai', usage: run.usage };
	} catch (error) {
		console.error('nickname ai failed', String(error).slice(0, 120));
		return { suggestions: fallbackSuggestions(), source: 'fallback', usage: null };
	}
}
