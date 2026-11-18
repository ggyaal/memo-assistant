// Reminder e-mail: HTML card + text/plain body, built only from stored memo fields and the same
// fixed tone sentences as Discord. No AI call happens here (or anywhere on the sending path).
import { CATEGORY, type CardMemo, type CardTiming, flatText, timingLabel, toneMessage, whenLabel } from './discord-card.ts';
import type { ReminderTone } from './types.ts';

export interface EmailContent {
	subject: string;
	html: string;
	text: string;
}

/** Escape for HTML text and attribute values. */
export function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only a plain https URL is ever put into a link (no javascript:, data:, quotes or spaces). */
export function safeHttpsUrl(value: string | undefined): string | null {
	if (!value || !/^https:\/\/[^\s"'<>\\]{1,400}$/.test(value)) return null;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
	} catch {
		return null;
	}
}

const FOOTER_TEXT = '이 메일은 메모비서 설정에서 이메일 알림을 켠 분께만 보냅니다. 그만 받으려면 메모비서 → ⚙️ 설정 → 이메일 알림을 끄세요.';

function layout(opts: { color: string; heading: string; title: string; rows: [string, string][]; message: string; link: string | null; preheader: string }): string {
	const rows = opts.rows
		.map(
			([k, v]) =>
				`<tr><td style="padding:6px 0;color:#6b7280;font-size:14px;width:84px;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0;color:#111827;font-size:14px">${escapeHtml(v)}</td></tr>`,
		)
		.join('');
	const button = opts.link
		? `<tr><td style="padding:20px 24px 4px"><a href="${escapeHtml(opts.link)}" style="display:inline-block;background:${opts.color};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px">메모비서에서 확인하기</a></td></tr>`
		: '';
	return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(opts.heading)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;word-break:keep-all">
<span style="display:none;max-height:0;overflow:hidden">${escapeHtml(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:16px 8px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;border-top:6px solid ${opts.color}">
<tr><td style="padding:20px 24px 0;color:#6b7280;font-size:13px">${escapeHtml(opts.heading)}</td></tr>
<tr><td style="padding:8px 24px 0;color:#111827;font-size:20px;font-weight:700;line-height:1.4">${escapeHtml(opts.title)}</td></tr>
<tr><td style="padding:12px 24px 0;color:#111827;font-size:15px;line-height:1.6">${escapeHtml(opts.message)}</td></tr>
<tr><td style="padding:12px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
${button}
<tr><td style="padding:20px 24px 20px;color:#9ca3af;font-size:12px;line-height:1.6">${escapeHtml(FOOTER_TEXT)}<br>메모비서 · 한국 시간 기준</td></tr>
</table></td></tr></table></body></html>`;
}

/** The reminder e-mail for one memo (or one occurrence of a repeating memo). */
export function reminderEmail(tone: ReminderTone, memo: CardMemo, timing: CardTiming, appUrl?: string): EmailContent {
	const cat = CATEGORY[memo.category] ?? CATEGORY.note;
	const title = flatText(memo.title, 200);
	const message = toneMessage(tone, memo, timing, 'plain');
	const when = whenLabel(memo);
	const whenName = memo.category === 'todo' ? '마감' : memo.category === 'schedule' ? '예정' : '날짜';
	const rows: [string, string][] = [
		['분류', `${cat.icon} ${cat.label}`],
		['알림', timingLabel(memo, timing)],
		...(when ? [[whenName, when] as [string, string]] : []),
		...(memo.repeat ? [['반복', `🔁 ${flatText(memo.repeat, 100)}`] as [string, string]] : []),
	];
	const link = safeHttpsUrl(appUrl);
	const color = `#${cat.color.toString(16).padStart(6, '0')}`;
	const text = [
		`🔔 메모비서 · ${cat.label} 알림`,
		'',
		title,
		message,
		'',
		...rows.map(([k, v]) => `${k}: ${v}`),
		...(link ? ['', `메모비서에서 확인하기: ${link}`] : []),
		'',
		FOOTER_TEXT,
	].join('\n');
	return {
		subject: `[메모비서] ${flatText(memo.title, 60)} · ${timingLabel(memo, timing)}`,
		html: layout({ color, heading: `🔔 메모비서 · ${cat.label} 알림`, title: `${cat.icon} ${title}`, rows, message, link, preheader: message }),
		text,
	};
}

/** The test message sent when e-mail reminders are switched on (or from the test button). */
export function testEmail(appUrl?: string): EmailContent {
	const link = safeHttpsUrl(appUrl);
	const message = '이메일 알림이 연결됐어요. 앞으로 예약한 메모 알림을 이 주소로 보내 드릴게요.';
	return {
		subject: '[메모비서] 이메일 알림 테스트',
		html: layout({ color: '#3858e9', heading: '🔔 메모비서 · 테스트', title: '📬 이메일 알림 테스트', rows: [], message, link, preheader: message }),
		text: ['🔔 메모비서 · 테스트', '', message, ...(link ? ['', `메모비서: ${link}`] : []), '', FOOTER_TEXT].join('\n'),
	};
}
