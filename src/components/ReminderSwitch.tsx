import { useState } from 'react';
import { ApiRequestError, cancelReminder, scheduleReminder } from '../client/api.ts';
import { formatKst } from '../client/format.ts';
import type { Memo } from '../shared/types.ts';

/**
 * On/off for one memo's Discord reminder in the upcoming-reminders panel.
 * Recommended memos are switched on automatically; turning one off is remembered.
 * Turning on uses the user's defaults; a date-only memo without a default time asks for one.
 */
export function ReminderSwitch({ memo, onChanged }: { memo: Memo; onChanged: () => void }) {
	const r = memo.reminder;
	const serverOn = !!r && (r.status === 'scheduled' || r.status === 'sending' || r.status === 'sent');
	// Flip immediately; the refreshed server state replaces this after the request.
	const [optimistic, setOptimistic] = useState<boolean | null>(null);
	const on = optimistic ?? serverOn;
	const [busy, setBusy] = useState(false);
	const [askTime, setAskTime] = useState(false);
	const [time, setTime] = useState('');
	const [error, setError] = useState<string | null>(null);

	async function run(action: () => Promise<unknown>, next?: boolean) {
		setBusy(true);
		setError(null);
		if (next !== undefined) setOptimistic(next);
		try {
			await action();
			setAskTime(false);
			onChanged();
		} catch (e) {
			setOptimistic(null); // back to the server state
			const message = e instanceof ApiRequestError ? e.message : '변경하지 못했어요.';
			// Date-only memo and no default time chosen yet: ask for one instead of guessing.
			if (e instanceof ApiRequestError && !memo.due_at && /시각/.test(message)) setAskTime(true);
			else setError(message);
		} finally {
			setBusy(false);
		}
	}

	if (r?.status === 'sent') return <span className="reminder-switch__state small">✅ DM 보냄</span>;

	return (
		<span className="reminder-switch">
			<span className="reminder-switch__row">
				<input
					type="checkbox"
					role="switch"
					className="switch switch--small"
					checked={on}
					disabled={busy}
					aria-label={`${memo.title} Discord 알림 ${on ? '끄기' : '켜기'}`}
					onChange={(e) => {
						const next = e.target.checked;
						void run(() => (next ? scheduleReminder(memo.id, {}) : cancelReminder(memo.id)), next);
					}}
				/>
				<span className="small muted">{on ? (r && serverOn ? `DM ${formatKst(r.at)}` : '예약하는 중…') : '알림 꺼짐'}</span>
			</span>
			{r?.status === 'failed' && <span className="error small">지난 알림을 보내지 못했어요</span>}
			{askTime && (
				<span className="reminder-switch__row small">
					<label>
						알림 시각 <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
					</label>
					<button type="button" className="link-button" disabled={!time || busy} onClick={() => void run(() => scheduleReminder(memo.id, { time }))}>
						예약
					</button>
				</span>
			)}
			{error && (
				<span className="error small" role="alert">
					{error}
				</span>
			)}
		</span>
	);
}
