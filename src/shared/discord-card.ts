// Discord reminder cards: an Embed built only from stored memo fields and fixed
// tone templates. No AI call happens here (or anywhere on the sending path).
import type { MemoCategory } from './types.ts';
import { REMINDER_TONES, type ReminderTone } from './types.ts';

export { REMINDER_TONES, type ReminderTone };

/** What a card needs; everything comes from D1. */
export interface CardMemo {
	title: string;
	category: MemoCategory;
	/** Exact time (UTC ISO) or null. */
	due_at: string | null;
	/** KST day (YYYY-MM-DD) or null. */
	due_date: string | null;
	/** Repeat label ("매주 월·수·금") for a repeating memo's occurrence. */
	repeat?: string;
}

export interface CardTiming {
	/** When the reminder fires (UTC ISO). */
	scheduledAt: string;
	/** Minutes before the memo's time when relative ("30분 전"); null for a picked clock time. */
	leadMinutes: number | null;
}

export interface DiscordMessage {
	content?: string;
	embeds?: unknown[];
	components?: unknown[];
}

const CATEGORY: Record<MemoCategory, { label: string; icon: string; color: number }> = {
	todo: { label: '할 일', icon: '✅', color: 0x2e7d32 },
	schedule: { label: '일정', icon: '📅', color: 0x3858e9 },
	idea: { label: '아이디어', icon: '💡', color: 0x8e44ad },
	note: { label: '메모', icon: '📝', color: 0x607d8b },
};

/** One line, clipped (with …), never empty. For places Discord shows as plain text (embed title). */
export function flatText(text: string, max: number): string {
	const flat = text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim() || '제목 없음';
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** flatText + markdown escape, for text Discord renders as markdown (content, description, fields). */
export function safeText(text: string, max: number): string {
	return flatText(text, max).replace(/([\\`*_~|>#[\]()<])/g, '\\$1');
}

const kst = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', ...options });
const dayFmt = kst({ month: 'long', day: 'numeric', weekday: 'short' });
const timeFmt = kst({ hour: 'numeric', minute: '2-digit' });

/** "11월 16일 (월) 오후 3:00", or "11월 16일 (월) · 시간 미정" — never an invented time. */
export function whenLabel(memo: Pick<CardMemo, 'due_at' | 'due_date'>): string | null {
	if (memo.due_at) return `${dayFmt.format(new Date(memo.due_at))} ${timeFmt.format(new Date(memo.due_at))}`;
	if (memo.due_date) return `${dayFmt.format(new Date(`${memo.due_date}T00:00:00+09:00`))} · 시간 미정`;
	return null;
}

/** "30분", "1시간", "1시간 30분", "2일" */
export function durationLabel(minutes: number): string {
	if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}일`;
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h === 0) return `${m}분`;
	return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/** Minutes from the reminder to the memo's exact time, when the reminder is before it. */
export function effectiveLead(memo: Pick<CardMemo, 'due_at'>, timing: CardTiming): number | null {
	if (timing.leadMinutes !== null) return timing.leadMinutes;
	if (!memo.due_at) return null;
	const minutes = Math.round((Date.parse(memo.due_at) - Date.parse(timing.scheduledAt)) / 60_000);
	return minutes >= 0 ? minutes : null;
}

type Kind = 'schedule' | 'deadline' | 'other';
const kindOf = (category: MemoCategory): Kind => (category === 'schedule' ? 'schedule' : category === 'todo' ? 'deadline' : 'other');

/**
 * Fixed sentences per tone. `t` is the (escaped) title, `d` the remaining time.
 * before: some time left; now: the exact time; plain: no relative time (date-only or picked time).
 */
const TEMPLATES: Record<ReminderTone, Record<Kind, { before: (t: string, d: string) => string; now: (t: string) => string; plain: (t: string) => string }>> = {
	friendly: {
		schedule: {
			before: (t, d) => `‘${t}’ 시작까지 ${d} 남았어요! 잊지 마세요 😊`,
			now: (t) => `지금 ‘${t}’ 시간이에요! 늦지 않게 챙겨요 😊`,
			plain: (t) => `‘${t}’ 일정 잊지 마세요! 😊`,
		},
		deadline: {
			before: (t, d) => `‘${t}’ 마감까지 ${d} 남았어요! 미리 챙겨 두세요 😊`,
			now: (t) => `지금이 ‘${t}’ 마감 시각이에요! 😊`,
			plain: (t) => `‘${t}’ 잊지 말고 챙겨요! 😊`,
		},
		other: {
			before: (t, d) => `‘${t}’ 확인할 시간까지 ${d} 남았어요 😊`,
			now: (t) => `지금 ‘${t}’ 확인할 시간이에요 😊`,
			plain: (t) => `‘${t}’ 한번 다시 볼까요? 😊`,
		},
	},
	standard: {
		schedule: {
			before: (t, d) => `‘${t}’ 일정이 ${d} 후 시작됩니다.`,
			now: (t) => `‘${t}’ 일정 시간입니다.`,
			plain: (t) => `‘${t}’ 일정 알림입니다.`,
		},
		deadline: {
			before: (t, d) => `‘${t}’ 마감이 ${d} 남았습니다.`,
			now: (t) => `‘${t}’ 마감 시각입니다.`,
			plain: (t) => `‘${t}’ 할 일 알림입니다.`,
		},
		other: {
			before: (t, d) => `‘${t}’ 알림 시각까지 ${d} 남았습니다.`,
			now: (t) => `‘${t}’ 알림입니다.`,
			plain: (t) => `‘${t}’ 알림입니다.`,
		},
	},
	formal: {
		schedule: {
			before: (t, d) => `‘${t}’ 예정 시각까지 ${d} 남았습니다. 일정을 확인해 주세요.`,
			now: (t) => `‘${t}’ 예정 시각이 되었습니다. 일정을 확인해 주세요.`,
			plain: (t) => `‘${t}’ 일정이 예정되어 있습니다. 확인해 주세요.`,
		},
		deadline: {
			before: (t, d) => `‘${t}’ 마감까지 ${d} 남았습니다. 진행 상황을 확인해 주세요.`,
			now: (t) => `‘${t}’ 마감 시각이 되었습니다. 확인해 주세요.`,
			plain: (t) => `‘${t}’ 할 일이 있습니다. 확인해 주세요.`,
		},
		other: {
			before: (t, d) => `‘${t}’ 관련 알림 시각까지 ${d} 남았습니다. 확인해 주세요.`,
			now: (t) => `‘${t}’ 관련 알림 시각입니다. 확인해 주세요.`,
			plain: (t) => `‘${t}’ 관련 알림을 드립니다. 확인해 주세요.`,
		},
	},
	cute: {
		schedule: {
			before: (t, d) => `똑똑! ‘${t}’ 시간까지 ${d} 남았어요~ 🔔`,
			now: (t) => `똑똑! 지금 ‘${t}’ 시간이에요~ 🔔`,
			plain: (t) => `똑똑! ‘${t}’ 일정 있는 거 알죠~? 🔔`,
		},
		deadline: {
			before: (t, d) => `똑똑! ‘${t}’ 마감까지 ${d} 남았어요~ 화이팅 💪`,
			now: (t) => `똑똑! 지금이 ‘${t}’ 마감이에요~ 🔔`,
			plain: (t) => `똑똑! ‘${t}’ 잊지 않았죠~? 🔔`,
		},
		other: {
			before: (t, d) => `똑똑! ‘${t}’ 볼 시간까지 ${d} 남았어요~ 🔔`,
			now: (t) => `똑똑! 지금 ‘${t}’ 볼 시간이에요~ 🔔`,
			plain: (t) => `똑똑! ‘${t}’ 생각나요~? 🔔`,
		},
	},
};

/** The one-line tone message (also used as the plain-text fallback body). */
export function toneMessage(tone: ReminderTone, memo: CardMemo, timing: CardTiming): string {
	const t = TEMPLATES[tone] ?? TEMPLATES.friendly;
	const set = t[kindOf(memo.category)];
	const title = safeText(memo.title, 60);
	const lead = effectiveLead(memo, timing);
	if (lead === null) return set.plain(title);
	if (lead === 0) return set.now(title);
	return set.before(title, durationLabel(lead));
}

/** "30분 전", "정시", or the picked clock time. */
export function timingLabel(memo: CardMemo, timing: CardTiming): string {
	const lead = effectiveLead(memo, timing);
	if (lead === 0) return '정시';
	if (lead !== null) return `${durationLabel(lead)} 전`;
	return `${dayFmt.format(new Date(timing.scheduledAt))} ${timeFmt.format(new Date(timing.scheduledAt))} (직접 지정)`;
}

/**
 * The reminder card. `appUrl` (a real https page of this app) adds a link button;
 * nothing personal is put in the URL — the app checks the session when it opens.
 */
export function reminderCard(tone: ReminderTone, memo: CardMemo, timing: CardTiming, appUrl?: string): DiscordMessage {
	const cat = CATEGORY[memo.category] ?? CATEGORY.note;
	const when = whenLabel(memo);
	const message = toneMessage(tone, memo, timing);
	const whenName = memo.category === 'todo' ? '⏰ 마감' : memo.category === 'schedule' ? '⏰ 예정' : '📅 날짜';
	const fields = [
		{ name: '🗂 분류', value: `${cat.icon} ${cat.label}`, inline: true },
		{ name: '🔔 알림', value: timingLabel(memo, timing), inline: true },
		...(when ? [{ name: whenName, value: when, inline: false }] : []),
		...(memo.repeat ? [{ name: '🔁 반복', value: safeText(memo.repeat, 100), inline: false }] : []),
	];
	const embed = {
		title: `${cat.icon} ${flatText(memo.title, 200)}`,
		description: `💬 ${message}`,
		color: cat.color,
		fields,
		author: { name: `🔔 메모비서 · ${cat.label} 알림` },
		footer: { text: '메모비서 · 한국 시간 기준' },
		timestamp: timing.scheduledAt,
	};
	const button = appUrl && /^https:\/\/[^\s]{1,400}$/.test(appUrl)
		? [{ type: 1, components: [{ type: 2, style: 5, label: '메모비서에서 확인하기', url: appUrl }] }]
		: undefined;
	return {
		// Short line for push notifications; the card below has the details.
		content: `🔔 ${safeText(memo.title, 60)} · ${timingLabel(memo, timing)}`,
		embeds: [embed],
		...(button ? { components: button } : {}),
	};
}

/** Plain text used if Discord refuses the card (never sent in addition to it). */
export function reminderText(tone: ReminderTone, memo: CardMemo, timing: CardTiming): string {
	const when = whenLabel(memo);
	return `🔔 메모비서 · ${toneMessage(tone, memo, timing)}${when ? ` (${when})` : ''}`;
}

/** Sample for the settings preview / the tone picker (same templates as real reminders). */
export const SAMPLE_MEMO: CardMemo = { title: '병원 방문', category: 'schedule', due_at: null, due_date: null };
export function sampleTiming(now: Date): { memo: CardMemo; timing: CardTiming } {
	const due = new Date(Math.ceil(now.getTime() / 60_000) * 60_000 + 30 * 60_000);
	return {
		memo: { ...SAMPLE_MEMO, due_at: due.toISOString(), due_date: null },
		timing: { scheduledAt: new Date(due.getTime() - 30 * 60_000).toISOString(), leadMinutes: 30 },
	};
}
