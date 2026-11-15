import { useEffect, useState } from 'react';
import { fetchUsage } from '../client/api.ts';
import type { UsageResponse } from '../shared/types.ts';

const number = new Intl.NumberFormat('ko-KR');

/**
 * Today's AI requests / daily limit, plus the all-time total.
 * "Today" follows the Workers AI free-allocation day (00:00 UTC = 09:00 KST).
 */
export function UsageMeter({ refreshKey }: { refreshKey: number }) {
	const [usage, setUsage] = useState<UsageResponse | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchUsage()
			.then((result) => {
				if (!cancelled) setUsage(result);
			})
			.catch(() => {
				// Usage is informational only; keep the last value (or stay hidden).
			});
		return () => {
			cancelled = true;
		};
	}, [refreshKey]);

	if (!usage) return null;
	const { used, limit, neurons, neuronBudget } = usage.today;
	// Whichever runs out first: the request count or the estimated free-AI budget.
	const ratio = Math.min(1, Math.max(limit > 0 ? used / limit : 1, neuronBudget > 0 ? neurons / neuronBudget : 1));
	const full = ratio >= 1;
	const percent = Math.round(ratio * 100);

	return (
		<section className={full ? 'usage usage--full' : 'usage'} aria-label="AI 사용량">
			<div className="row space-between small">
				<span>
					오늘 AI 사용{' '}
					<strong>
						{number.format(used)} / {number.format(limit)}회
					</strong>
				</span>
				<span className="muted">
					무료 예산 {percent}% · 누적 {number.format(usage.total)}회
				</span>
			</div>
			{/* Native <progress>: no inline styles, so the strict CSP (style-src 'self') holds. */}
			<progress className="usage__bar" value={percent} max={100} aria-label="오늘 AI 사용량(무료 예산 기준)" />
			<span className="sr-only">{percent}%</span>
			<div className="row space-between small">
				<span>
					음성 변환{' '}
					<strong>
						{Math.floor(usage.voice.usedSeconds / 60)}분 {usage.voice.usedSeconds % 60}초 / {Math.round(usage.voice.limitSeconds / 60)}분
					</strong>
				</span>
				{usage.voice.usedSeconds >= usage.voice.limitSeconds && <span className="error small">오늘 음성 한도 도달</span>}
			</div>
			<p className="muted small usage__note" title="예산 %는 요청 전 예상치(글자 수 기반)로 계산하고, 실측은 모델이 실제로 쓴 토큰을 공식 단가로 환산한 값이에요(메모 정리만, 음성 제외).">
				메모 정리 실측 약 {number.format(usage.today.actualNeurons ?? 0)} Neurons · 예상 {number.format(usage.today.neurons)} / {number.format(usage.today.neuronBudget)}
			</p>
			<p className="muted small usage__note">
				{full ? '오늘 데모의 AI 사용 한도에 도달했습니다. ' : ''}매일 오전 9시(한국 시간)에 초기화됩니다.
			</p>
		</section>
	);
}
