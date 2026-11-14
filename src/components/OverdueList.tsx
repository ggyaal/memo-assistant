import { useEffect, useState } from 'react';
import { ApiRequestError, deleteMemo } from '../client/api.ts';
import { CATEGORY_LABELS, formatDue, overdueLabel } from '../client/format.ts';
import type { Memo } from '../shared/types.ts';
import { CompleteCheckbox } from './CompleteCheckbox.tsx';

/**
 * "지나버린 일": deadline passed and not done. Checking an item as done moves
 * it out; deleting hides it from the shared board for every visitor.
 */
export function OverdueList({ items, onChanged }: { items: Memo[]; onChanged: () => void }) {
	const [list, setList] = useState(items);
	const [busy, setBusy] = useState<string | null>(null);
	const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

	useEffect(() => setList(items), [items]);

	async function remove(memo: Memo) {
		if (!window.confirm(`"${memo.title}"을(를) 삭제할까요?\n모든 방문자의 목록에서 사라집니다.`)) return;
		setBusy(memo.id);
		setStatus(null);
		try {
			await deleteMemo(memo.id);
			setList((current) => current.filter((m) => m.id !== memo.id));
			setStatus({ text: `"${memo.title}"을(를) 삭제했습니다.`, error: false });
			onChanged();
		} catch (err) {
			setStatus({ text: err instanceof ApiRequestError ? err.message : '삭제하지 못했습니다.', error: true });
		} finally {
			setBusy(null);
		}
	}

	if (list.length === 0) {
		return <p className="muted small">기한이 지난 미완료 메모가 없습니다.</p>;
	}

	return (
		<>
			<ul className="agenda__list">
				{list.map((memo) => (
					<li key={memo.id} className="agenda__item agenda__item--overdue">
						<span className="row">
							<CompleteCheckbox
								memo={memo}
								onChange={(saved) => {
									if (saved.completed_at) setList((current) => current.filter((m) => m.id !== saved.id));
									onChanged();
								}}
							/>
							<span className="agenda__name">{memo.title}</span>
							<span className="badge badge--overdue">{overdueLabel(memo)}</span>
						</span>
						<span className="agenda__time agenda__time--overdue">
							기한 {formatDue(memo)} · {CATEGORY_LABELS[memo.category]}
						</span>
						<span className="row space-between">
							<span className="muted small">by {memo.nickname}</span>
							<button
								type="button"
								className="danger-button small"
								onClick={() => void remove(memo)}
								disabled={busy === memo.id}
								aria-label={`${memo.title} 삭제`}
							>
								{busy === memo.id ? '삭제 중…' : '삭제'}
							</button>
						</span>
					</li>
				))}
			</ul>
			<p className={`agenda__status ${status?.error ? 'error small' : 'muted small'}`} role="status" aria-live="polite">
				{status?.text}
			</p>
		</>
	);
}
