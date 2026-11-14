import { useState } from 'react';
import { CATEGORY_LABELS, formatDue, formatKst, isOverdue, PRIORITY_LABELS } from '../client/format.ts';
import type { Memo } from '../shared/types.ts';
import { CompleteCheckbox } from './CompleteCheckbox.tsx';

// All model-produced strings are rendered as plain text nodes (never as HTML).
export function MemoCard({
	memo: initial,
	showSource = true,
	onChanged,
}: {
	memo: Memo;
	showSource?: boolean;
	/** Called after the memo was changed on the board (e.g. checked as done). */
	onChanged?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [memo, setMemo] = useState(initial);
	const done = memo.completed_at !== null;
	return (
		<article className={`memo-card memo-card--${memo.category}${done ? ' is-done' : ''}`}>
			<header className="memo-card__header">
				<CompleteCheckbox
					memo={memo}
					onChange={(saved) => {
						setMemo(saved);
						onChanged?.();
					}}
				/>
				<span className={`badge badge--${memo.category}`}>{CATEGORY_LABELS[memo.category]}</span>
				{memo.priority && (
					<span className={`badge badge--priority-${memo.priority}`} title={memo.priority_reason ?? undefined}>
						중요도 {PRIORITY_LABELS[memo.priority]}
					</span>
				)}
				{isOverdue(memo) && <span className="badge badge--overdue">기한 지남</span>}
				<h3 className="memo-card__title">{memo.title}</h3>
			</header>
			<p className="memo-card__content">{memo.content}</p>
			{(memo.due_at || memo.due_date || memo.due_text) && (
				<p className="memo-card__due">
					<span aria-hidden="true">📅 </span>
					{formatDue(memo) ?? '정확한 일시 없음'}
					{memo.due_text && <span className="muted"> · 원문: “{memo.due_text}”</span>}
				</p>
			)}
			{memo.reminder_recommended && (
				<p className="memo-card__reminder">
					<span className="badge badge--reminder">알림 추천</span>
					{memo.reminder_reason && <span className="muted"> {memo.reminder_reason}</span>}
					<span className="muted small"> (실제 알림은 보내지 않습니다)</span>
				</p>
			)}
			<footer className="memo-card__footer muted small">
				<span>by {memo.nickname}</span>
				<span>등록 {formatKst(memo.created_at)}</span>
				{done && memo.completed_at && <span>완료 {formatKst(memo.completed_at)}</span>}
				{showSource && (
					<button type="button" className="link-button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
						{open ? '원문 닫기' : '원문 보기'}
					</button>
				)}
			</footer>
			{showSource && open && <blockquote className="memo-card__source">{memo.raw_text}</blockquote>}
		</article>
	);
}
