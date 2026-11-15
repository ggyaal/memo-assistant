import type { MemoProgressStage } from '../shared/types.ts';

/** Where the request is: a stage the server reported, or the final result. */
export type OrganizeStage = MemoProgressStage | 'done';

const ORDER: OrganizeStage[] = ['checking', 'analyzing', 'found', 'saving', 'done'];

/** Text for a step that is happening now, already finished, or still ahead. */
function stepText(stage: OrganizeStage, state: 'current' | 'past' | 'future', count: number | null): string {
	switch (stage) {
		case 'checking':
			return state === 'current' ? '입력 내용을 확인하고 있어요.' : state === 'past' ? '입력 내용을 확인했어요.' : '입력 확인';
		case 'analyzing':
			return state === 'current' ? 'AI가 메모를 분석하고 있어요.' : state === 'past' ? 'AI가 분석을 마쳤어요.' : 'AI 분석';
		case 'found':
			return state === 'future' || count === null ? '메모 찾기' : `메모 ${count}개를 발견했어요.`;
		case 'saving':
			return state === 'current' ? '정리된 메모를 저장하고 있어요.' : state === 'past' ? '정리된 메모를 저장했어요.' : '저장';
		case 'questions':
			return state === 'future' ? '확인' : '확인할 내용이 있어요.';
		case 'done':
			return state === 'future' ? '완료' : '메모 정리가 완료됐어요.';
	}
}

/**
 * Live steps of one "AI로 정리하기" request. Only stages the server actually
 * reported are shown as reached — nothing advances on a timer.
 */
export function OrganizeProgress({
	stage,
	count,
	failed,
	onCancel,
}: {
	stage: OrganizeStage;
	count: number | null;
	/** The request stopped at `stage` (error or cancel). */
	failed: boolean;
	/** Shown while cancelling can still stop the AI (before saving starts). */
	onCancel?: () => void;
}) {
	const at = ORDER.indexOf(stage);
	const current = stepText(stage, stage === 'done' ? 'past' : 'current', count);
	return (
		<div className={`organize-progress${failed ? ' organize-progress--failed' : ''}`}>
			<ol className="organize-progress__steps">
				{ORDER.map((step, i) => {
					const state = i < at || stage === 'done' ? 'past' : i === at ? 'current' : 'future';
					const mark = state === 'past' ? '✓' : state === 'current' ? (failed ? '✕' : '') : '';
					return (
						<li key={step} className={`organize-progress__step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
							<span className={`organize-progress__mark${state === 'current' && !failed ? ' is-spinning' : ''}`} aria-hidden="true">
								{mark}
							</span>
							<span>{state === 'current' && failed ? `${stepText(step, 'future', count)} 중단` : stepText(step, state, count)}</span>
						</li>
					);
				})}
			</ol>
			{/* One live line for screen readers instead of re-reading the whole list. */}
			<p className="sr-only" role="status" aria-live="polite">
				{failed ? '' : current}
			</p>
			{onCancel && !failed && (
				<button type="button" className="link-button small organize-progress__cancel" onClick={onCancel}>
					취소
				</button>
			)}
		</div>
	);
}
