import { type FormEvent, useState } from 'react';
import { ApiRequestError, updateMemo } from '../client/api.ts';
import { CATEGORY_LABELS, PRIORITY_LABELS, toKstInput } from '../client/format.ts';
import { useSpace } from '../client/space.ts';
import { describeSensitive, detectSensitive } from '../shared/privacy.ts';
import { LIMITS, MEMO_CATEGORIES, MEMO_PRIORITIES, type Memo, type MemoCategory, type MemoPriority } from '../shared/types.ts';

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
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const sensitive = shared ? detectSensitive(`${title}\n${content}`) : [];
	const problem = !title.trim()
		? '제목을 입력해 주세요.'
		: !content.trim()
			? '내용을 입력해 주세요.'
			: dueTime && !dueDate
				? '시각을 정하려면 날짜도 골라 주세요.'
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
			<div className="memo-edit__row">
				<label>
					날짜
					<input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
				</label>
				<label>
					시각 <span className="muted">(선택)</span>
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
