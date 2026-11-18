import { describe, expect, it } from 'vitest';
import { escapeHtml, reminderEmail, safeHttpsUrl, testEmail } from '../src/shared/email-template.ts';
import { emailConfigured, notConfiguredSender, resendSender } from '../src/server/notify/email.ts';

const timing = { scheduledAt: '2026-11-16T05:30:00.000Z', leadMinutes: 30 };
const memo = { title: '<script>alert("x")</script> & 회의', category: 'schedule' as const, due_at: '2026-11-16T06:00:00.000Z', due_date: '2026-11-16' };

describe('reminder e-mail template (fixed text, no AI)', () => {
	it('escapes memo text everywhere in the HTML; the text/plain body carries the same facts in Korean', () => {
		const mail = reminderEmail('friendly', memo, timing, 'https://memo.example/');
		expect(mail.html).not.toContain('<script>');
		expect(mail.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; 회의');
		expect(mail.text).toContain('<script>alert("x")</script> & 회의'); // plain text is not HTML
		expect(mail.text).toContain('시작까지 30분 남았어요');
		expect(mail.text).toContain('분류: 📅 일정');
		expect(mail.text).toContain('예정: 11월 16일 (월) 오후 3:00');
		expect(mail.text).toContain('메모비서에서 확인하기: https://memo.example/');
		expect(mail.text).not.toContain('\\'); // no Discord markdown escaping in e-mail
		expect(mail.subject).toBe('[메모비서] <script>alert("x")</script> & 회의 · 30분 전');
	});

	it('a subject never contains line breaks (no header injection); repeat and date-only are shown without inventing a time', () => {
		const mail = reminderEmail('standard', { title: '줄\r\nBcc: x@y.z', category: 'todo', due_at: null, due_date: '2026-11-20', repeat: '매주 월·수·금' }, { scheduledAt: '2026-11-20T00:00:00.000Z', leadMinutes: null });
		expect(mail.subject).not.toMatch(/[\r\n]/);
		expect(mail.text).toContain('마감: 11월 20일 (금) · 시간 미정');
		expect(mail.text).toContain('반복: 🔁 매주 월·수·금');
	});

	it('mobile-friendly layout: viewport, one 480px column, lang=ko', () => {
		const { html } = reminderEmail('cute', memo, timing);
		expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
		expect(html).toContain('max-width:480px');
		expect(html).toContain('<html lang="ko">');
		expect(html).not.toContain('href='); // no link without a safe app URL
	});

	it('only plain https links are used', () => {
		expect(safeHttpsUrl('https://memo.example/')).toBe('https://memo.example/');
		for (const bad of ['javascript:alert(1)', 'http://memo.example', 'https://a.example/"><b>', 'https://user:pw@a.example/', 'data:text/html,x', undefined]) {
			expect(safeHttpsUrl(bad)).toBeNull();
		}
		expect(escapeHtml(`'"<>&`)).toBe('&#39;&quot;&lt;&gt;&amp;');
		expect(testEmail('javascript:alert(1)').html).not.toContain('javascript');
	});
});

describe('e-mail sender adapter', () => {
	it('not configured → a clear failure, never success', async () => {
		expect(emailConfigured({})).toBe(false);
		expect(emailConfigured({ EMAIL_API_KEY: 'k', EMAIL_FROM: 'not an address' })).toBe(false);
		expect(emailConfigured({ EMAIL_API_KEY: 'k', EMAIL_FROM: '메모비서 <noreply@memo.example>' })).toBe(true);
		expect(await notConfiguredSender.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't' })).toMatchObject({ ok: false, retryable: false, code: 'email_not_configured' });
	});

	it('Resend: accepted / retryable / permanent are told apart; the key never appears in results', async () => {
		const answer = (res: Response) => resendSender('re_secret', 'a@memo.example', async () => res);
		const msg = { to: 'u@gmail.com', subject: 's', html: 'h', text: 't', idempotencyKey: 'k1' };
		expect(await answer(Response.json({ id: 'abc' })).send(msg)).toEqual({ ok: true, providerMessageId: 'abc' });
		expect(await answer(new Response('', { status: 429, headers: { 'retry-after': '30' } })).send(msg)).toMatchObject({ ok: false, retryable: true, retryAfterSeconds: 30 });
		expect(await answer(new Response('', { status: 502 })).send(msg)).toMatchObject({ ok: false, retryable: true });
		const denied = await answer(new Response('', { status: 403 })).send(msg);
		expect(denied).toMatchObject({ ok: false, retryable: false, code: 'email_unauthorized' });
		expect(JSON.stringify(denied)).not.toContain('re_secret');
		expect(await answer(Response.json({})).send({ ...msg, to: 'not-an-address' })).toMatchObject({ ok: false, code: 'invalid_recipient' });
		const failing = resendSender('re_secret', 'a@memo.example', async () => {
			throw new Error('offline');
		});
		expect(await failing.send(msg)).toMatchObject({ ok: false, retryable: true, code: 'email_network' });
	});
});
