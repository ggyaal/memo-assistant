import { useEffect, useState } from 'react';
import { ApiRequestError, deleteMemo, restoreMemo } from '../client/api.ts';
import { myAuthorTag } from '../client/author.ts';
import { CATEGORY_HINTS, CATEGORY_LABELS, formatDue, formatKst, isOverdue, PRIORITY_LABELS } from '../client/format.ts';
import type { Memo } from '../shared/types.ts';
import { useSpace } from '../client/space.ts';
import { CompleteCheckbox } from './CompleteCheckbox.tsx';
import { describeRecurrence } from '../shared/recurrence.ts';
import { MemoEditForm } from './MemoEditForm.tsx';
import { RecurrenceQuestionBar } from './RecurrenceQuestionBar.tsx';
import { ReminderControl } from './ReminderControl.tsx';

// All model-produced strings are rendered as plain text nodes (never as HTML).
export function MemoCard({
	memo: initial,
	showSource = true,
	onChanged,
	onRemoved,
}: {
	memo: Memo;
	showSource?: boolean;
	/** Called after the memo was changed on the board (e.g. checked as done). */
	onChanged?: () => void;
	/** Called after a delete / undo; defaults to onChanged. A list can refresh other panels only, keeping the undo bar. */
	onRemoved?: () => void;
}) {
	const { shared } = useSpace();
	const [open, setOpen] = useState(false);
	const [memo, setMemo] = useState(initial);
	const [editing, setEditing] = useState(false);
	// A refreshed list (e.g. after an edit elsewhere) brings the stored version.
	useEffect(() => setMemo(initial), [initial]);
	// Delete: personal space = any memo; public board = memos written from this browser.
	const [myTag, setMyTag] = useState<string | null>(null);
	useEffect(() => {
		if (shared) void myAuthorTag().then(setMyTag);
	}, [shared]);
	const canDelete = !shared || (!!memo.author_tag && memo.author_tag === myTag);
	const [confirming, setConfirming] = useState(false);
	const [deleted, setDeleted] = useState(false);
	const [removeBusy, setRemoveBusy] = useState(false);
	const [removeError, setRemoveError] = useState<string | null>(null);
	const removed = () => (onRemoved ?? onChanged)?.();
	async function remove() {
		setRemoveBusy(true);
		setRemoveError(null);
		try {
			await deleteMemo(memo.id);
			setDeleted(true);
			setConfirming(false);
			removed();
		} catch (e) {
			setRemoveError(e instanceof ApiRequestError ? e.message : '삭제하지 못했어요.');
		} finally {
			setRemoveBusy(false);
		}
	}
	async function undo() {
		setRemoveBusy(true);
		setRemoveError(null);
		try {
			const { memo: back } = await restoreMemo(memo.id);
			if (back) setMemo(back);
			setDeleted(false);
			removed();
		} catch (e) {
			setRemoveError(e instanceof ApiRequestError ? e.message : '되돌리지 못했어요.');
		} finally {
			setRemoveBusy(false);
		}
	}

	const done = memo.completed_at !== null;
	if (deleted) {
		return (
			<article className="memo-card memo-card--deleted" aria-live="polite">
				<p className="small">
					🗑 「{memo.title}」을(를) 삭제했어요.
					<button type="button" className="link-button" disabled={removeBusy} onClick={() => void undo()}>
						되돌리기
					</button>
				</p>
				{removeError && (
					<p className="error small" role="alert">
						{removeError}
					</p>
				)}
			</article>
		);
	}
	if (editing) {
		return (
			<article className={`memo-card memo-card--${memo.category} is-editing`}>
				<MemoEditForm
					memo={memo}
					onCancel={() => setEditing(false)}
					onSaved={(saved) => {
						setMemo(saved);
						setEditing(false);
						onChanged?.();
					}}
				/>
			</article>
		);
	}
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
				<span className={`badge badge--${memo.category}`} title={CATEGORY_HINTS[memo.category]}>
					{CATEGORY_LABELS[memo.category]}
				</span>
				{memo.priority && (
					<span className={`badge badge--priority-${memo.priority}`} title={memo.priority_reason ?? undefined}>
						중요도 {PRIORITY_LABELS[memo.priority]}
					</span>
				)}
				{isOverdue(memo) && <span className="badge badge--overdue">기한 지남</span>}
				<h3 className="memo-card__title">{memo.title}</h3>
			</header>
			<p className="memo-card__content">{memo.content}</p>
			{memo.recurrence ? (
				<p className="memo-card__due memo-card__repeat">
					<span aria-hidden="true">🔁 </span>
					<strong>{describeRecurrence(memo.recurrence)}</strong>
					{memo.occurrence ? (
						<span>
							{' '}
							· 이번 회차 {formatDue(memo)}
							{memo.occurrence.completed_at ? ' ✓ 완료' : ''}
						</span>
					) : (
						<span className="muted"> · 남은 회차 없음</span>
					)}
					{memo.due_text && <span className="muted"> · 원문: “{memo.due_text}”</span>}
				</p>
			) : (
				(memo.due_at || memo.due_date || memo.due_text) && (
					<p className="memo-card__due">
						<span aria-hidden="true">📅 </span>
						{formatDue(memo) ?? '정확한 일시 없음'}
						{memo.due_text && <span className="muted"> · 원문: “{memo.due_text}”</span>}
					</p>
				)
			)}
			{memo.recurrence_question && (
				<RecurrenceQuestionBar
					memo={memo}
					onAnswered={(saved) => {
						setMemo(saved);
						onChanged?.();
					}}
				/>
			)}
			{memo.reminder_recommended && (
				<p className="memo-card__reminder">
					<span className="badge badge--reminder">알림 추천</span>
					{memo.reminder_reason && <span className="muted"> {memo.reminder_reason}</span>}
					{shared && <span className="muted small"> (실제 알림은 보내지 않습니다)</span>}
				</p>
			)}
			<ReminderControl memo={memo} onChanged={() => onChanged?.()} />
			<footer className="memo-card__footer muted small">
				<span>by {memo.nickname}</span>
				<span>등록 {formatKst(memo.created_at)}</span>
				{done && memo.completed_at && <span>완료 {formatKst(memo.completed_at)}</span>}
				<button type="button" className="link-button" onClick={() => setEditing(true)}>
					✏️ 수정
				</button>
				{showSource && (
					<button type="button" className="link-button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
						{open ? '원문 닫기' : '원문 보기'}
					</button>
				)}
				{canDelete && !confirming && (
					<button type="button" className="link-button memo-card__delete" onClick={() => setConfirming(true)}>
						🗑 삭제
					</button>
				)}
			</footer>
			{confirming && (
				<div className="memo-card__confirm" role="group" aria-label="삭제 확인">
					<span className="small">
						{memo.recurrence ? '반복 일정 전체(모든 회차)가 삭제돼요. ' : ''}
						{shared ? '공개 목록에서 사라져요. ' : ''}정말 삭제할까요? 알림 예약도 함께 꺼져요.
					</span>
					<span className="memo-card__confirm-actions">
						<button type="button" className="danger small" disabled={removeBusy} onClick={() => void remove()}>
							삭제
						</button>
						<button type="button" className="link-button small" onClick={() => setConfirming(false)}>
							취소
						</button>
					</span>
				</div>
			)}
			{removeError && (
				<p className="error small" role="alert">
					{removeError}
				</p>
			)}
			{showSource && open && <blockquote className="memo-card__source">{memo.raw_text}</blockquote>}
		</article>
	);
}
