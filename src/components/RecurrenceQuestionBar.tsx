import { useState } from 'react';
import { ApiRequestError, chooseRecurrence } from '../client/api.ts';
import { useSpace } from '../client/space.ts';
import { describeRecurrence } from '../shared/recurrence.ts';
import type { Memo } from '../shared/types.ts';

/**
 * Unclear wording ("월수금 운동", "평일 아침", "주말에 청소"): ask once whether it repeats
 * every week or only on the coming days. The answer is stored; no AI call.
 */
export function RecurrenceQuestionBar({ memo, onAnswered }: { memo: Memo; onAnswered: (memo: Memo) => void }) {
	const { shared } = useSpace();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const q = memo.recurrence_question;
	if (!q) return null;
	async function answer(choice: 'repeat' | 'once') {
		setBusy(true);
		setError(null);
		try {
			onAnswered((await chooseRecurrence(memo.id, choice)).memo);
		} catch (e) {
			setError(e instanceof ApiRequestError ? e.message : '저장하지 못했어요.');
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="repeat-question" role="group" aria-label="반복 여부 확인">
			<p className="small">
				🔁 <strong>{memo.due_text ? `“${memo.due_text}”` : '이 일정'}</strong>은 매주 반복인가요?
				{shared && <span className="muted"> (공개 공간: 모든 방문자에게 적용)</span>}
			</p>
			<div className="repeat-question__actions">
				<button type="button" className="primary small" disabled={busy} onClick={() => void answer('repeat')}>
					{describeRecurrence(q.repeat)} 반복
				</button>
				<button type="button" className="secondary small" disabled={busy} onClick={() => void answer('once')}>
					이번만 ({describeRecurrence(q.once).replace(' 한 번씩', '')})
				</button>
			</div>
			{error && (
				<p className="error small" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
