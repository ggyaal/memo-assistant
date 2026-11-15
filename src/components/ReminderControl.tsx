import { useState } from 'react';
import { ApiRequestError, cancelReminder, scheduleReminder } from '../client/api.ts';
import { formatKst } from '../client/format.ts';
import { useSpace } from '../client/space.ts';
import type { Memo } from '../shared/types.ts';

const LEADS = [
	{ value: 0, label: '정시' },
	{ value: 10, label: '10분 전' },
	{ value: 30, label: '30분 전' },
	{ value: 60, label: '1시간 전' },
];

const FAILURES: Record<string, string> = {
	'50007': 'Discord가 DM을 거부했어요(서버 참여·DM 허용 확인)',
	'403': 'Discord가 DM을 거부했어요(서버 참여·DM 허용 확인)',
	too_late: '예정 시각보다 너무 늦어 보내지 않았어요',
	unknown_outcome: '전송 결과를 확인하지 못했어요(중복 방지를 위해 다시 보내지 않음)',
	bot_unauthorized: '알림 봇 설정 문제',
	bot_not_configured: '알림 봇이 설정되지 않았어요',
	channel_off: 'Discord 알림이 꺼져 있었어요',
};

function failureText(error: string | null): string {
	if (!error) return '보내지 못했어요';
	return FAILURES[error] ?? `보내지 못했어요 (${error})`;
}

/**
 * Discord DM reminder for one personal memo. The user always confirms the time:
 * a lead time for exact-time memos, an explicit time of day for date-only memos.
 */
export function ReminderControl({ memo, onChanged }: { memo: Memo; onChanged: () => void }) {
	const { shared, discordReady } = useSpace();
	const [open, setOpen] = useState(false);
	const [lead, setLead] = useState(30);
	const [time, setTime] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (shared || memo.completed_at || (!memo.due_at && !memo.due_date)) return null;

	async function run(action: () => Promise<unknown>) {
		setBusy(true);
		setError(null);
		try {
			await action();
			setOpen(false);
			onChanged();
		} catch (e) {
			setError(e instanceof ApiRequestError ? e.message : '처리하지 못했어요.');
		} finally {
			setBusy(false);
		}
	}

	const r = memo.reminder;
	if (r && (r.status === 'scheduled' || r.status === 'sending')) {
		return (
			<p className="reminder reminder--scheduled small">
				🔔 <strong>{formatKst(r.at)}</strong>에 Discord DM 예약됨
				<button type="button" className="link-button" disabled={busy} onClick={() => void run(() => cancelReminder(memo.id))}>
					취소
				</button>
				{error && <span className="error"> {error}</span>}
			</p>
		);
	}
	if (r?.status === 'sent') {
		return <p className="reminder reminder--sent small">✅ {formatKst(r.at)}에 Discord로 알림을 보냈어요.</p>;
	}

	if (!discordReady) {
		return <p className="reminder muted small">🔔 알림을 받으려면 ⚙️ 설정에서 Discord 알림을 켜 주세요.</p>;
	}

	return (
		<div className="reminder small">
			{r?.status === 'failed' && <p className="error">⚠️ 지난 알림 실패: {failureText(r.error)}</p>}
			{!open ? (
				<button type="button" className="link-button" onClick={() => setOpen(true)}>
					🔔 Discord 알림 받기
				</button>
			) : (
				<div className="reminder__form">
					{memo.due_at ? (
						<label>
							알림 시점{' '}
							<select value={lead} onChange={(e) => setLead(Number(e.target.value))}>
								{LEADS.map((l) => (
									<option key={l.value} value={l.value}>
										{l.label}
									</option>
								))}
							</select>
						</label>
					) : (
						<label>
							시간 미정 메모예요. 알림 받을 시각{' '}
							<input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
						</label>
					)}
					<button
						type="button"
						className="primary small"
						disabled={busy || (!memo.due_at && !time)}
						onClick={() => void run(() => scheduleReminder(memo.id, memo.due_at ? { leadMinutes: lead } : { time }))}
					>
						예약
					</button>
					<button type="button" className="link-button" onClick={() => setOpen(false)}>
						닫기
					</button>
				</div>
			)}
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
