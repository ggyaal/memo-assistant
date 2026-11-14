import { type DragEvent, useEffect, useState } from 'react';
import { ApiRequestError, reorderAgenda } from '../client/api.ts';
import { CATEGORY_LABELS, formatDue, PRIORITY_LABELS } from '../client/format.ts';
import type { Memo } from '../shared/types.ts';
import { CompleteCheckbox } from './CompleteCheckbox.tsx';

function PriorityBadge({ memo }: { memo: Memo }) {
	if (!memo.priority) return <span className="badge badge--priority-unset">우선순위 미지정</span>;
	return <span className={`badge badge--priority-${memo.priority}`}>{PRIORITY_LABELS[memo.priority]}</span>;
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
	const next = [...list];
	const [item] = next.splice(from, 1);
	next.splice(to, 0, item);
	return next;
}

/**
 * Priority list with drag & drop reordering (mouse) and ▲▼ buttons
 * (touch/keyboard). The new order is saved to the shared board right away;
 * on failure the previous order is restored.
 */
export function RankedList({ items, onChanged }: { items: Memo[]; onChanged: () => void }) {
	const [order, setOrder] = useState(items);
	const [dragging, setDragging] = useState<string | null>(null);
	// Insertion point while dragging: the item is dropped before this index.
	const [dropAt, setDropAt] = useState<number | null>(null);
	const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

	useEffect(() => setOrder(items), [items]);

	async function commit(next: Memo[], movedTitle: string, position: number) {
		const previous = order;
		setOrder(next);
		setStatus({ text: `"${movedTitle}"을(를) ${position}위로 옮겼습니다.`, error: false });
		try {
			await reorderAgenda(next.map((m) => m.id));
			onChanged();
		} catch (err) {
			setOrder(previous);
			setStatus({ text: err instanceof ApiRequestError ? err.message : '순서를 저장하지 못했습니다.', error: true });
		}
	}

	function move(from: number, to: number) {
		if (to < 0 || to >= order.length || from === to) return;
		void commit(moveItem(order, from, to), order[from].title, to + 1);
	}

	function onDragOver(event: DragEvent<HTMLLIElement>, index: number) {
		if (!dragging) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = 'move';
		const box = event.currentTarget.getBoundingClientRect();
		setDropAt(event.clientY < box.top + box.height / 2 ? index : index + 1);
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		const from = order.findIndex((m) => m.id === dragging);
		if (from >= 0 && dropAt !== null) {
			const to = dropAt > from ? dropAt - 1 : dropAt;
			move(from, to);
		}
		setDragging(null);
		setDropAt(null);
	}

	return (
		<>
			<ol className="agenda__list agenda__list--ranked" onDragLeave={(e) => e.currentTarget === e.target && setDropAt(null)}>
				{order.map((memo, index) => {
					const classes = ['agenda__item', 'agenda__item--draggable'];
					if (memo.completed_at) classes.push('is-done');
					if (dragging === memo.id) classes.push('is-dragging');
					if (dragging && dropAt === index) classes.push('drop-before');
					if (dragging && dropAt === index + 1 && index === order.length - 1) classes.push('drop-after');
					return (
						<li
							key={memo.id}
							className={classes.join(' ')}
							draggable
							onDragStart={(event) => {
								event.dataTransfer.effectAllowed = 'move';
								event.dataTransfer.setData('text/plain', memo.id);
								setDragging(memo.id);
							}}
							onDragOver={(event) => onDragOver(event, index)}
							onDrop={onDrop}
							onDragEnd={() => {
								setDragging(null);
								setDropAt(null);
							}}
						>
							<span className="agenda__handle" aria-hidden="true" title="끌어서 순서 변경">
								⠿
							</span>
							<CompleteCheckbox
								memo={memo}
								onChange={(saved) => {
									setOrder((list) => list.map((m) => (m.id === saved.id ? saved : m)));
									onChanged();
								}}
							/>
							<span className="agenda__rank" aria-label={`${index + 1}위`}>
								{index + 1}
							</span>
							<div className="agenda__body">
								<span className="row">
									<PriorityBadge memo={memo} />
									<span className="agenda__name">{memo.title}</span>
								</span>
								<span className="agenda__time">
									{formatDue(memo)} · {CATEGORY_LABELS[memo.category]}
									{memo.manual_rank !== null && <span className="muted nowrap"> · 직접 정렬됨</span>}
								</span>
								{memo.priority_reason && <span className="muted small">{memo.priority_reason}</span>}
							</div>
							<span className="agenda__move">
								<button
									type="button"
									className="icon-button"
									onClick={() => move(index, index - 1)}
									disabled={index === 0}
									aria-label={`${memo.title} 위로 이동`}
								>
									▲
								</button>
								<button
									type="button"
									className="icon-button"
									onClick={() => move(index, index + 1)}
									disabled={index === order.length - 1}
									aria-label={`${memo.title} 아래로 이동`}
								>
									▼
								</button>
							</span>
						</li>
					);
				})}
			</ol>
			<p className={`agenda__status ${status?.error ? 'error small' : 'muted small'}`} role="status" aria-live="polite">
				{status?.text}
			</p>
		</>
	);
}
