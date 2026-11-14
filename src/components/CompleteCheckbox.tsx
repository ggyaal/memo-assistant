import { useEffect, useState } from 'react';
import { ApiRequestError, setMemoCompleted } from '../client/api.ts';
import type { Memo } from '../shared/types.ts';

/**
 * Done checkbox. Updates at once and saves to the shared board; on failure
 * it flips back and shows why. `onChange` receives the saved memo.
 */
export function CompleteCheckbox({
	memo,
	onChange,
}: {
	memo: Pick<Memo, 'id' | 'title' | 'completed_at'>;
	onChange: (updated: Memo) => void;
}) {
	const [done, setDone] = useState(memo.completed_at !== null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => setDone(memo.completed_at !== null), [memo.completed_at]);

	async function toggle(next: boolean) {
		setDone(next);
		setPending(true);
		setError(null);
		try {
			const { memo: saved } = await setMemoCompleted(memo.id, next);
			onChange(saved);
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
				aria-label={`${memo.title} ${done ? '완료 취소' : '완료로 표시'}`}
				title={done ? '완료 취소' : '완료로 표시 (모든 방문자에게 적용)'}
			/>
			{error && (
				<span className="error small" role="alert">
					{error}
				</span>
			)}
		</span>
	);
}
