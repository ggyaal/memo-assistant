import { useState } from 'react';
import { ApiRequestError, cancelReminder, scheduleReminder } from '../client/api.ts';
import { formatKst, fromKstInput, toKstInput } from '../client/format.ts';
import { useSpace } from '../client/space.ts';
import { earliestReminderTime, REMINDER_MIN_LEAD_MINUTES, type Memo } from '../shared/types.ts';

/** Quick picks that only fill in the date/time box (the box is what gets saved). */
const PRESETS = [
	{ minutes: 30, label: '30분 전' },
	{ minutes: 10, label: '10분 전' },
	{ minutes: 0, label: '정시' },
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

/** Why a picked time cannot be used (same rule as the server), or null. */
function timeProblem(value: string, now: Date): string | null {
	if (!value) return '알림 받을 날짜와 시각을 골라 주세요.';
	if (Date.parse(fromKstInput(value)) < earliestReminderTime(now).getTime()) {
		return `지났거나 ${REMINDER_MIN_LEAD_MINUTES - 1}분 이내인 시각이에요. 지금부터 ${REMINDER_MIN_LEAD_MINUTES}분 이후로 골라 주세요.`;
	}
	return null;
}

/**
 * Reminder for one personal memo: where to send it (Discord; KakaoTalk and Gmail
 * are not ready yet) and one date/time box. "30분 전 / 10분 전 / 정시" only fill
 * the box from the memo's time; any time 4+ minutes from now can be saved.
 */
export function ReminderControl({ memo, onChanged }: { memo: Memo; onChanged: () => void }) {
	const { shared, discordReady } = useSpace();
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState('');
	const [discord, setDiscord] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (shared || memo.completed_at || (!memo.due_at && !memo.due_date)) return null;

	const now = new Date();
	const minValue = toKstInput(earliestReminderTime(now));
	const presetValue = (minutes: number) => (memo.due_at ? toKstInput(new Date(Date.parse(memo.due_at) - minutes * 60_000)) : null);

	function openForm(initial?: string) {
		// Start from the existing reminder, else "30분 전" (or the memo time) when still possible; never an invented time.
		const candidates = [initial, presetValue(30), presetValue(0)].filter((v): v is string => !!v);
		setValue(candidates.find((v) => !timeProblem(v, new Date())) ?? '');
		setDiscord(discordReady);
		setError(null);
		setOpen(true);
	}

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
	const scheduled = r && (r.status === 'scheduled' || r.status === 'sending');

	if (!open) {
		if (scheduled) {
			return (
				<p className="reminder reminder--scheduled small">
					🔔 {memo.recurrence ? '매 회차 Discord DM · 다음 ' : ''}
					<strong>{formatKst(r.at)}</strong>
					{memo.recurrence ? '' : '에 Discord DM 예약됨'}
					<button type="button" className="link-button" disabled={busy || r.status === 'sending'} onClick={() => openForm(toKstInput(new Date(r.at)))}>
						변경
					</button>
					<button type="button" className="link-button" disabled={busy} onClick={() => void run(() => cancelReminder(memo.id))}>
						취소
					</button>
					{error && <span className="error"> {error}</span>}
				</p>
			);
		}
		return (
			<div className="reminder small">
				{r?.status === 'sent' && <p className="muted">✅ {formatKst(r.at)}에 Discord로 알림을 보냈어요.</p>}
				{r?.status === 'failed' && <p className="error">⚠️ 지난 알림 실패: {failureText(r.error)}</p>}
				<button type="button" className="link-button" onClick={() => openForm()}>
					🔔 {r?.status === 'sent' ? '알림 다시 받기' : '알림 받기'}
				</button>
			</div>
		);
	}

	if (memo.recurrence) {
		return (
			<RepeatingReminderForm
				memo={memo}
				busy={busy}
				error={error}
				scheduled={!!scheduled}
				onSave={(body) => void run(() => scheduleReminder(memo.id, body))}
				onClose={() => setOpen(false)}
			/>
		);
	}

	const problem = timeProblem(value, now);
	const noChannel = !discord;
	return (
		<div className="reminder reminder__form small">
			<fieldset className="reminder__channels">
				<legend>알림 받을 곳</legend>
				<label className="reminder__channel">
					<input type="checkbox" role="switch" className="switch switch--small" checked={discord && discordReady} disabled={!discordReady} onChange={(e) => setDiscord(e.target.checked)} />
					Discord
				</label>
				<label className="reminder__channel is-unavailable" title="아직 준비 중이에요">
					<input type="checkbox" role="switch" className="switch switch--small" checked={false} disabled />
					카카오톡 <span className="muted">(준비 중)</span>
				</label>
				<label className="reminder__channel is-unavailable" title="아직 준비 중이에요">
					<input type="checkbox" role="switch" className="switch switch--small" checked={false} disabled />
					Gmail <span className="muted">(준비 중)</span>
				</label>
				{!discordReady && <p className="muted">⚙️ 설정에서 Discord 알림을 먼저 켜 주세요.</p>}
			</fieldset>

			<label className="reminder__when">
				알림 날짜·시각
				<input type="datetime-local" step={60} min={minValue} value={value} onChange={(e) => setValue(e.target.value)} />
			</label>
			<div className="reminder__presets" role="group" aria-label="메모 시각 기준으로 채우기">
				{PRESETS.map((p) => {
					const v = presetValue(p.minutes);
					const unusable = !v || !!timeProblem(v, now);
					return (
						<button
							key={p.minutes}
							type="button"
							className={`chip${v && v === value ? ' is-selected' : ''}`}
							aria-pressed={!!v && v === value}
							disabled={unusable}
							title={!v ? '시각이 정해진 메모에서만 쓸 수 있어요' : unusable ? '이미 지났거나 너무 가까워요' : undefined}
							onClick={() => v && setValue(v)}
						>
							{p.label}
						</button>
					);
				})}
			</div>
			{!memo.due_at && <p className="muted">시간 미정 메모예요. 알림 받을 날짜·시각을 직접 골라 주세요.</p>}
			{value && problem && <p className="error">{problem}</p>}

			<div className="reminder__actions">
				<button
					type="button"
					className="primary small"
					disabled={busy || !!problem || noChannel || !discordReady}
					onClick={() => void run(() => scheduleReminder(memo.id, { at: fromKstInput(value), channels: ['discord'] }))}
				>
					{scheduled ? '변경' : '예약'}
				</button>
				<button type="button" className="link-button" onClick={() => setOpen(false)}>
					닫기
				</button>
			</div>
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * A repeating memo is reminded before every occurrence: "정시 / N분 전" when it has a time,
 * or one time of day when it has dates only. A single picked date/time does not fit a series.
 */
function RepeatingReminderForm({
	memo,
	busy,
	error,
	scheduled,
	onSave,
	onClose,
}: {
	memo: Memo;
	busy: boolean;
	error: string | null;
	scheduled: boolean;
	onSave: (body: { leadMinutes: number } | { time: string }) => void;
	onClose: () => void;
}) {
	const { discordReady } = useSpace();
	const [lead, setLead] = useState(30);
	const [time, setTime] = useState('09:00');
	return (
		<div className="reminder reminder__form small">
			<p className="muted">🔁 반복 일정이라 매 회차마다 Discord DM으로 알려 드려요.</p>
			{memo.due_at ? (
				<label className="reminder__when">
					알림 시점 (매 회차)
					<select value={lead} onChange={(e) => setLead(Number(e.target.value))}>
						<option value={0}>정시</option>
						<option value={10}>10분 전</option>
						<option value={30}>30분 전</option>
						<option value={60}>1시간 전</option>
					</select>
				</label>
			) : (
				<label className="reminder__when">
					알림 시각 (회차 날짜마다)
					<input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
				</label>
			)}
			{!discordReady && <p className="muted">⚙️ 설정에서 Discord 알림을 먼저 켜 주세요.</p>}
			<div className="reminder__actions">
				<button
					type="button"
					className="primary small"
					disabled={busy || !discordReady || (!memo.due_at && !time)}
					onClick={() => onSave(memo.due_at ? { leadMinutes: lead } : { time })}
				>
					{scheduled ? '변경' : '예약'}
				</button>
				<button type="button" className="link-button" onClick={onClose}>
					닫기
				</button>
			</div>
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
