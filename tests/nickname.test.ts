import { describe, expect, it } from 'vitest';
import { completeSuggestions, emojiFor, fallbackSuggestions, isGoodAiNickname, nicknameProblem, parseAiNicknames, randomNickname } from '../src/shared/nickname.ts';
import { NICKNAME_PROMPT, suggestNicknames, workersAiModel, workersAiNicknames } from '../src/server/nickname-ai.ts';

describe('nickname rules', () => {
	it('random (no-AI) names are valid Korean nicknames', () => {
		for (let i = 0; i < 200; i++) expect(isGoodAiNickname(randomNickname())).toBe(true);
		expect(fallbackSuggestions()).toHaveLength(3);
	});

	it('AI output: JSON array, fenced, object form or lines; bad names are dropped', () => {
		expect(parseAiNicknames('["달빛을 모으는 수달","메모하는 작은 여우","생각이 많은 문어"]')).toEqual(['달빛을 모으는 수달', '메모하는 작은 여우', '생각이 많은 문어']);
		expect(parseAiNicknames('```json\n{"nicknames":["산책하는 펭귄"]}\n```')).toEqual(['산책하는 펭귄']);
		expect(parseAiNicknames('1. 별을 세는 고래\n2. "꿈꾸는 토끼"')).toEqual(['별을 세는 고래', '꿈꾸는 토끼']);
		expect(parseAiNicknames('["Fox 123","<b>여우</b>","관리자 여우","병신 문어","가","아주아주아주아주아주아주긴닉네임입니다요"]')).toEqual([]);
		expect(parseAiNicknames('')).toEqual([]);
		expect(completeSuggestions(['별을 세는 고래'])).toHaveLength(3);
	});

	it('typed nicknames: 2–20 chars, no blocked words, no contact details', () => {
		expect(nicknameProblem('수달')).toBeNull();
		expect(nicknameProblem('Memo Fox 2')).toBeNull(); // typed names may use letters and digits
		expect(nicknameProblem('a')).toContain('2자');
		expect(nicknameProblem('운영자 수달')).toContain('사용할 수 없는');
		expect(nicknameProblem('me@example.com')).not.toBeNull();
	});

	it('emoji from the animal word (longest match), ✨ otherwise', () => {
		expect(emojiFor('바다의 돌고래')).toBe('🐬');
		expect(emojiFor('작은 고래')).toBe('🐳');
		expect(emojiFor('반짝이는 별')).toBe('✨');
	});
});

describe('Workers AI nickname call', () => {
	it('one call, same model as memo organizing, no thinking, no personal data; usage read back', async () => {
		const calls: { model: string; input: { messages: { content: string }[]; chat_template_kwargs: unknown } }[] = [];
		const ai = {
			run: async (model: string, input: never) => {
				calls.push({ model, input });
				return { choices: [{ message: { content: '["메모하는 작은 여우","생각이 많은 문어","달빛을 모으는 수달"]' } }], usage: { prompt_tokens: 150, completion_tokens: 30 } };
			},
		} as unknown as Ai;
		const gen = workersAiNicknames(ai, workersAiModel('cloudflare/@cf/zai-org/glm-4.7-flash'));
		const result = await suggestNicknames(gen);
		expect(calls).toHaveLength(1);
		expect(calls[0].model).toBe('@cf/zai-org/glm-4.7-flash');
		expect(calls[0].input.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(result).toMatchObject({ source: 'ai', usage: { input: 150, output: 30 } });
		expect(result.suggestions.map((s) => s.emoji)).toEqual(['🦊', '🐙', '🦦']);
	});

	it('the prompt carries only a random theme', () => {
		expect(NICKNAME_PROMPT('숲속')).toContain('분위기: 숲속');
		expect(NICKNAME_PROMPT('숲속')).not.toMatch(/@|이메일|사용자 이름|\{/);
	});

	it('a hanging model times out into fallback names', async () => {
		const result = await suggestNicknames(() => new Promise(() => {}), 20);
		expect(result.source).toBe('fallback');
		expect(result.suggestions).toHaveLength(3);
	});
});
