import { describe, expect, it } from 'vitest';
import { describeSensitive, detectSensitive } from '../src/shared/privacy.ts';

// All values are fictional.
describe('detectSensitive', () => {
	it.each([
		['010-1234-5678로 연락하기', ['phone']],
		['01012345678 저장', ['phone']],
		['02-345-6789 사무실', ['phone']],
		['test.user@example.com 으로 메일', ['email']],
		['주민번호 900101-1234567', ['resident_id']],
		['카드 1234-5678-9012-3456 결제', ['card']],
		['카드 1234567890123456', ['card']],
		['와이파이 비밀번호: qwer1234', ['secret']],
		['비번은 abcd!234', ['secret']],
		['인증번호 482913 입력', []], // no ':' / particle → ambiguous, allowed
		['인증번호는 482913', ['secret']],
		['api key = sk-abc123xyz', ['secret']],
		['010-1234-5678, a@b.co', ['phone', 'email']],
	])('%s → %j', (text, expected) => {
		expect(detectSensitive(text)).toEqual(expected);
	});

	it.each([
		'비밀번호 바꾸기',
		'내일 오후 3시에 팀 회의 준비해야 해',
		'퇴근할 때 우유 사고, 주말에는 방 청소해야겠다',
		'2026-11-20까지 보고서 제출',
		'회의 15:30, 예산 12000000원',
		'11월 20일 금요일',
		'PIN 번호 재발급 신청하기',
	])('allows ordinary memo: %s', (text) => {
		expect(detectSensitive(text)).toEqual([]);
	});

	it('describes kinds in Korean without echoing values', () => {
		expect(describeSensitive(['phone', 'email'])).toBe('전화번호, 이메일 주소');
	});
});
