import { type FormEvent, useState } from 'react';
import { ApiRequestError, updateMemo } from '../client/api.ts';
import { CATEGORY_HINTS, CATEGORY_LABELS, PRIORITY_LABELS, toKstInput } from '../client/format.ts';
import { useSpace } from '../client/space.ts';
import { describeSensitive, detectSensitive } from '../shared/privacy.ts';
import { describeRecurrence } from '../shared/recurrence.ts';
import { LIMITS, MEMO_CATEGORIES, MEMO_PRIORITIES, type EditMemoRequest, type Memo, type MemoCategory, type MemoPriority } from '../shared/types.ts';

/**
 * Correct an organized memo: title, content, category, priority and the deadline
 * (KST date, optional time). On the public board the change is shared with every visitor.
 */
export function MemoEditForm({ memo, onSaved, onCancel }: { memo: Memo; onSaved: (memo: Memo) => void; onCancel: () => void }) {
	const { shared } = useSpace();
	const [title, setTitle] = useState(memo.title);
	const [content, setContent] = useState(memo.content);
	const [category, setCategory] = useState<MemoCategory>(memo.category);
	const [priority, setPriority] = useState<MemoPriority | ''>(memo.priority ?? '');
	const [dueDate, setDueDate] = useState(memo.due_date ?? '');
	const [dueTime, setDueTime] = useState(memo.due_at ? toKstInput(new Date(memo.due_at)).slice(11) : '');
	const initialRepeat = repeatModeOf(memo);
	const [repeatMode, setRepeatMode] = useState<RepeatMode>(initialRepeat.mode);
	const [repeatDays, setRepeatDays] = useState<number[]>(initialRepeat.days);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const sensitive = shared ? detectSensitive(`${title}\n${content}`) : [];
	const problem = !title.trim()
		? '제목을 입력해 주세요.'
		: !content.trim()
			? '내용을 입력해 주세요.'
			: dueTime && !dueDate
				? '시각을 정하려면 날짜도 골라 주세요.'
				: !['none', 'keep'].includes(repeatMode) && !dueDate
					? '반복하려면 시작 날짜를 골라 주세요.'
					: (repeatMode === 'weekly' || repeatMode === 'biweekly') && repeatDays.length === 0
						? '반복할 요일을 하나 이상 골라 주세요.'
						: null;

	async function save(event: FormEvent) {
		event.preventDefault();
		if (problem || sensitive.length > 0 || busy) return;
		setBusy(true);
		setError(null);
		try {
			const { memo: saved } = await updateMemo(memo.id, {
				title: title.trim(),
				content: content.trim(),
				category,
				priority: priority || null,
				dueDate: dueDate || null,
				dueTime: dueDate && dueTime ? dueTime : null,
				repeat: repeatPayload(repeatMode, repeatDays),
			});
			onSaved(saved);
		} catch (e) {
			setError(e instanceof ApiRequestError ? e.message : '저장하지 못했어요.');
		} finally {
			setBusy(false);
		}
	}

	const id = (name: string) => `edit-${memo.id}-${name}`;
	return (
		<form className="memo-edit" onSubmit={save} aria-label={`${memo.title} 수정`}>
			<label htmlFor={id('title')}>제목</label>
			<input id={id('title')} value={title} maxLength={LIMITS.titleMax} onChange={(e) => setTitle(e.target.value)} autoFocus />
			<label htmlFor={id('content')}>내용</label>
			<textarea id={id('content')} value={content} maxLength={LIMITS.contentMax} rows={3} onChange={(e) => setContent(e.target.value)} />
			<div className="memo-edit__row">
				<label>
					분류
					<select value={category} onChange={(e) => setCategory(e.target.value as MemoCategory)}>
						{MEMO_CATEGORIES.map((c) => (
							<option key={c} value={c}>
								{CATEGORY_LABELS[c]}
							</option>
						))}
					</select>
				</label>
				<label>
					중요도
					<select value={priority} onChange={(e) => setPriority(e.target.value as MemoPriority | '')}>
						<option value="">없음</option>
						{MEMO_PRIORITIES.map((p) => (
							<option key={p} value={p}>
								{PRIORITY_LABELS[p]}
							</option>
						))}
					</select>
				</label>
			</div>
			<p className="muted small memo-edit__hint">
				{CATEGORY_LABELS[category]}: {CATEGORY_HINTS[category]}. 분류를 바꿔도 AI를 다시 부르지 않아요.
			</p>
			<div className="memo-edit__row">
				<label>
					날짜
					<input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
				</label>
				<label>
					<span>
						시각 <span className="muted">(선택)</span>
					</span>
					<input type="time" value={dueTime} disabled={!dueDate} onChange={(e) => setDueTime(e.target.value)} />
				</label>
				{(dueDate || dueTime) && (
					<button
						type="button"
						className="link-button small"
						onClick={() => {
							setDueDate('');
							setDueTime('');
						}}
					>
						기한 지우기
					</button>
				)}
			</div>
			<RepeatEditor memo={memo} mode={repeatMode} days={repeatDays} dueDate={dueDate} onMode={setRepeatMode} onDays={setRepeatDays} />
			{memo.reminder && (memo.reminder.status === 'scheduled' || memo.reminder.status === 'failed') && (
				<p className="muted small">기한을 바꾸면 "N분 전" 알림은 새 기한을 따라가고, 직접 고른 시각의 알림은 그대로예요.</p>
			)}
			{shared && <p className="muted small">공개 공간이라 수정한 내용은 모든 방문자에게 보여요.</p>}
			{sensitive.length > 0 && (
				<p className="warning" role="alert">
					⚠️ {describeSensitive(sensitive)}로 보이는 내용이 있어요. 공개 공간에는 저장할 수 없어요.
				</p>
			)}
			{problem && (title || content) && <p className="error small">{problem}</p>}
			{error && (
				<p className="error small" role="alert">
					{error}
				</p>
			)}
			<div className="memo-edit__actions">
				<button type="submit" className="primary small" disabled={busy || !!problem || sensitive.length > 0}>
					{busy ? '저장하는 중…' : '저장'}
				</button>
				<button type="button" className="link-button" onClick={onCancel} disabled={busy}>
					취소
				</button>
			</div>
		</form>
	);
}

type RepeatMode = 'keep' | 'none' | 'daily' | 'weekdays' | 'weekend' | 'weekly' | 'biweekly' | 'monthly';
const DAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];

/** Form state for the memo's current rule ("keep" = leave it as it is, e.g. one-time days or an open question). */
function repeatModeOf(memo: Memo): { mode: RepeatMode; days: number[] } {
	const r = memo.recurrence;
	if (!r) return { mode: memo.recurrence_question ? 'keep' : 'none', days: [] };
	if (r.kind === 'daily') return { mode: 'daily', days: [] };
	if (r.kind === 'monthly') return { mode: 'monthly', days: [] };
	if (r.kind === 'dates') return { mode: 'keep', days: [] };
	const key = r.days.join(',');
	if (r.interval === 1 && key === '0,1,2,3,4') return { mode: 'weekdays', days: r.days };
	if (r.interval === 1 && key === '5,6') return { mode: 'weekend', days: r.days };
	return { mode: r.interval === 2 ? 'biweekly' : 'weekly', days: r.days };
}

function repeatPayload(mode: RepeatMode, days: number[]): EditMemoRequest['repeat'] {
	switch (mode) {
		case 'keep':
			return undefined;
		case 'none':
			return null;
		case 'daily':
			return { kind: 'daily' };
		case 'monthly':
			return { kind: 'monthly' };
		case 'weekdays':
			return { kind: 'weekly', days: [0, 1, 2, 3, 4], interval: 1 };
		case 'weekend':
			return { kind: 'weekly', days: [5, 6], interval: 1 };
		case 'weekly':
		case 'biweekly':
			return { kind: 'weekly', days: [...days].sort((a, b) => a - b), interval: mode === 'biweekly' ? 2 : 1 };
	}
}

/** Repeat picker: none / daily / weekdays / weekend / weekly / every other week / monthly (from the date above). */
function RepeatEditor({
	memo,
	mode,
	days,
	dueDate,
	onMode,
	onDays,
}: {
	memo: Memo;
	mode: RepeatMode;
	days: number[];
	dueDate: string;
	onMode: (mode: RepeatMode) => void;
	onDays: (days: number[]) => void;
}) {
	const keepLabel = memo.recurrence?.kind === 'dates' ? `그대로 (${describeRecurrence(memo.recurrence)})` : '아직 정하지 않음 (그대로)';
	const showKeep = memo.recurrence?.kind === 'dates' || (!memo.recurrence && !!memo.recurrence_question);
	return (
		<div className="memo-edit__repeat">
			<label>
				반복
				<select
					value={mode}
					onChange={(e) => {
						const next = e.target.value as RepeatMode;
						onMode(next);
						// Weekly needs days: start from the start date's weekday.
						if ((next === 'weekly' || next === 'biweekly') && days.length === 0 && dueDate) {
							onDays([(new Date(`${dueDate}T00:00:00Z`).getUTCDay() + 6) % 7]);
						}
					}}
				>
					{showKeep && <option value="keep">{keepLabel}</option>}
					<option value="none">반복 안 함</option>
					<option value="daily">매일</option>
					<option value="weekdays">평일 (월–금)</option>
					<option value="weekend">주말 (토·일)</option>
					<option value="weekly">매주 (요일 선택)</option>
					<option value="biweekly">격주 (요일 선택)</option>
					<option value="monthly">매월{dueDate ? ` ${Number(dueDate.slice(8))}일` : ''}</option>
				</select>
			</label>
			{(mode === 'weekly' || mode === 'biweekly') && (
				<div className="memo-edit__days" role="group" aria-label="반복 요일">
					{DAY_LABELS.map((label, i) => (
						<button
							key={label}
							type="button"
							className={`chip${days.includes(i) ? ' is-selected' : ''}`}
							aria-pressed={days.includes(i)}
							onClick={() => onDays(days.includes(i) ? days.filter((d) => d !== i) : [...days, i])}
						>
							{label}
						</button>
					))}
				</div>
			)}
			{!['none', 'keep'].includes(mode) && <p className="muted small">위 날짜부터 시작해요. 시각을 넣으면 매 회차 같은 시각이에요.</p>}
		</div>
	);
}
