import { useEffect, useState } from 'react';
import { useSpace } from '../client/space.ts';
import { ApiRequestError, setMemoCompleted, setOccurrenceCompleted } from '../client/api.ts';
import type { Memo } from '../shared/types.ts';

/**
 * Done checkbox. Updates at once and saves to the shared board; on failure
 * it flips back and shows why. `onChange` receives the saved memo.
 */
export function CompleteCheckbox({
	memo,
	onChange,
}: {
	memo: Pick<Memo, 'id' | 'title' | 'completed_at'> & Partial<Pick<Memo, 'recurrence' | 'occurrence'>>;
	onChange: (updated: Memo) => void;
}) {
	const { shared } = useSpace();
	// A repeating memo shown as one occurrence: the box checks off just that occurrence.
	const occurrence = memo.recurrence && memo.occurrence ? memo.occurrence : null;
	const isDone = occurrence ? occurrence.completed_at !== null : memo.completed_at !== null;
	const [done, setDone] = useState(isDone);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => setDone(isDone), [isDone]);

	async function toggle(next: boolean) {
		setDone(next);
		setPending(true);
		setError(null);
		try {
			if (occurrence) {
				const { occurrence: saved } = await setOccurrenceCompleted(memo.id, occurrence.date, next);
				onChange({ ...(memo as Memo), occurrence: saved });
			} else {
				const { memo: saved } = await setMemoCompleted(memo.id, next);
				onChange(saved);
			}
		} catch (err) {
			setDone(!next);
			setError(err instanceof ApiRequestError ? err.message : '완료 상태를 저장하지 못했습니다.');
		} finally {
			setPending(false);
		}
	}

	return (
		<span className="complete">
			<input
				type="checkbox"
				className="complete__box"
				checked={done}
				disabled={pending}
				onChange={(e) => void toggle(e.target.checked)}
				onClick={(e) => e.stopPropagation()}
				onMouseDown={(e) => e.stopPropagation()}
				draggable={false}
				aria-label={`${memo.title}${occurrence ? ` ${occurrence.date} 회차` : ''} ${done ? '완료 취소' : '완료로 표시'}`}
				title={`${occurrence ? '이번 회차만 ' : ''}${done ? '완료 취소' : shared ? '완료로 표시 (모든 방문자에게 적용)' : '완료로 표시'}`}
			/>
			{error && (
				<span className="error small" role="alert">
					{error}
				</span>
			)}
		</span>
	);
}
