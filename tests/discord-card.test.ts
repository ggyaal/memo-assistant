import { describe, expect, it } from 'vitest';
import {
	durationLabel,
	REMINDER_TONES,
	reminderCard,
	reminderText,
	safeText,
	toneMessage,
	whenLabel,
	type CardMemo,
} from '../src/shared/discord-card.ts';

// 2026-11-16 15:00 KST
const DUE = '2026-11-16T06:00:00.000Z';
const hospital: CardMemo = { title: '병원 방문', category: 'schedule', due_at: DUE, due_date: '2026-11-16' };
const at = (minutesBefore: number) => new Date(Date.parse(DUE) - minutesBefore * 60_000).toISOString();

type Embed = { title: string; description: string; author: { name: string }; footer: { text: string }; fields: { name: string; value: string }[]; color: number };
const embedOf = (m: ReturnType<typeof reminderCard>) => (m.embeds as Embed[])[0];
const total = (e: Embed) => e.title.length + e.description.length + e.author.name.length + e.footer.text.length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

describe('tone templates (fixed text, no AI)', () => {
	it('matches the four example sentences for "30분 전"', () => {
		const timing = { scheduledAt: at(30), leadMinutes: 30 };
		expect(toneMessage('friendly', hospital, timing)).toBe('‘병원 방문’ 시작까지 30분 남았어요! 잊지 마세요 😊');
		expect(toneMessage('standard', hospital, timing)).toBe('‘병원 방문’ 일정이 30분 후 시작됩니다.');
		expect(toneMessage('formal', hospital, timing)).toBe('‘병원 방문’ 예정 시각까지 30분 남았습니다. 일정을 확인해 주세요.');
		expect(toneMessage('cute', hospital, timing)).toBe('똑똑! ‘병원 방문’ 시간까지 30분 남았어요~ 🔔');
	});

	it('picks the sentence by timing and category: on time, before, deadline vs schedule, no time', () => {
		expect(toneMessage('friendly', hospital, { scheduledAt: DUE, leadMinutes: 0 })).toBe('지금 ‘병원 방문’ 시간이에요! 늦지 않게 챙겨요 😊');
		expect(toneMessage('standard', { ...hospital, category: 'todo', title: '보고서 제출' }, { scheduledAt: at(90), leadMinutes: 90 })).toBe('‘보고서 제출’ 마감이 1시간 30분 남았습니다.');
		// A picked clock time before the deadline still says how long is left.
		expect(toneMessage('friendly', hospital, { scheduledAt: at(10), leadMinutes: null })).toContain('10분 남았어요');
		// Date only: never invents a time.
		const dateOnly = { ...hospital, due_at: null };
		expect(toneMessage('formal', dateOnly, { scheduledAt: '2026-11-16T00:00:00.000Z', leadMinutes: null })).toBe('‘병원 방문’ 일정이 예정되어 있습니다. 확인해 주세요.');
		for (const tone of REMINDER_TONES) {
			for (const category of ['todo', 'schedule', 'idea', 'note'] as const) {
				expect(toneMessage(tone, { ...hospital, category }, { scheduledAt: at(5), leadMinutes: 5 })).toMatch(/병원 방문/);
			}
		}
	});

	it('durations read naturally', () => {
		expect([5, 30, 60, 90, 120, 1440, 2880].map(durationLabel)).toEqual(['5분', '30분', '1시간', '1시간 30분', '2시간', '1일', '2일']);
	});
});

describe('Discord Embed card', () => {
	it('shows title, category, KST time, timing, tone message and a link button', () => {
		const msg = reminderCard('friendly', hospital, { scheduledAt: at(30), leadMinutes: 30 }, 'https://memo-assistant.ggyaal.workers.dev/');
		const e = embedOf(msg);
		expect(msg.content).toBe('🔔 병원 방문 · 30분 전');
		expect(e.author.name).toBe('🔔 메모비서 · 일정 알림');
		expect(e.title).toBe('📅 병원 방문');
		expect(e.description).toBe('💬 ‘병원 방문’ 시작까지 30분 남았어요! 잊지 마세요 😊');
		expect(e.fields).toEqual([
			{ name: '🗂 분류', value: '📅 일정', inline: true },
			{ name: '🔔 알림', value: '30분 전', inline: true },
			{ name: '⏰ 예정', value: '11월 16일 (월) 오후 3:00', inline: false },
		]);
		expect(msg.components).toEqual([
			{ type: 1, components: [{ type: 2, style: 5, label: '메모비서에서 확인하기', url: 'https://memo-assistant.ggyaal.workers.dev/' }] },
		]);
	});

	it('date-only memo: "시간 미정", the picked time is shown as picked (no invented time)', () => {
		const e = embedOf(reminderCard('standard', { ...hospital, due_at: null }, { scheduledAt: '2026-11-16T00:00:00.000Z', leadMinutes: null }));
		expect(e.fields.find((f) => f.name === '⏰ 예정')?.value).toBe('11월 16일 (월) · 시간 미정');
		expect(e.fields.find((f) => f.name === '🔔 알림')?.value).toBe('11월 16일 (월) 오전 9:00 (직접 지정)');
		expect(whenLabel({ due_at: null, due_date: '2026-11-30' })).toBe('11월 30일 (월) · 시간 미정'); // no day shift across time zones
	});

	it('no deadline at all: no date field; ideas and notes get their own label', () => {
		const e = embedOf(reminderCard('cute', { title: '요약 기능', category: 'idea', due_at: null, due_date: null }, { scheduledAt: DUE, leadMinutes: null }));
		expect(e.fields.map((f) => f.name)).toEqual(['🗂 분류', '🔔 알림']);
		expect(e.author.name).toBe('🔔 메모비서 · 아이디어 알림');
	});

	it('user text cannot format, mention, link or overflow the card', () => {
		const nasty = { ...hospital, title: '**굵게** @everyone <@123> [링크](https://evil.example)\n둘째 줄 `코드` ' + '가'.repeat(500) };
		const msg = reminderCard('friendly', nasty, { scheduledAt: at(30), leadMinutes: 30 }, 'https://memo-assistant.ggyaal.workers.dev/');
		const e = embedOf(msg);
		expect(e.description).toContain('\\*\\*굵게\\*\\*');
		expect(e.description).toContain('\\<@123\\>');
		expect(e.description).toContain('\\[링크\\]\\(https://evil.example\\)');
		expect(e.description).not.toContain('\n');
		expect(e.title.length).toBeLessThanOrEqual(256);
		expect(e.title).not.toContain('\n');
		expect(e.description.length).toBeLessThanOrEqual(4096);
		expect(msg.content!.length).toBeLessThanOrEqual(2000);
		expect(total(e)).toBeLessThanOrEqual(6000);
		for (const f of e.fields) expect(f.value.length).toBeLessThanOrEqual(1024);
	});

	it('empty title and odd whitespace still give a readable card', () => {
		const e = embedOf(reminderCard('friendly', { ...hospital, title: ' \n\t ' }, { scheduledAt: at(30), leadMinutes: 30 }));
		expect(e.title).toBe('📅 제목 없음');
		expect(safeText('  a \n\n b  ', 10)).toBe('a b');
	});

	it('the link button only uses a real https address', () => {
		const timing = { scheduledAt: at(30), leadMinutes: 30 };
		expect(reminderCard('friendly', hospital, timing).components).toBeUndefined();
		expect(reminderCard('friendly', hospital, timing, 'javascript:alert(1)').components).toBeUndefined();
		expect(reminderCard('friendly', hospital, timing, 'http://localhost:5173').components).toBeUndefined();
	});

	it('plain-text fallback carries the same tone message and time', () => {
		expect(reminderText('formal', hospital, { scheduledAt: at(30), leadMinutes: 30 })).toBe(
			'🔔 메모비서 · ‘병원 방문’ 예정 시각까지 30분 남았습니다. 일정을 확인해 주세요. (11월 16일 (월) 오후 3:00)',
		);
	});
});
