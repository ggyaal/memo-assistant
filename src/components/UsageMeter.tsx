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
	const { used, limit } = usage.today;
	const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
	const full = used >= limit;

	return (
		<section className={full ? 'usage usage--full' : 'usage'} aria-label="AI 사용량">
			<div className="row space-between small">
				<span>
					오늘 AI 사용{' '}
					<strong>
						{number.format(used)} / {number.format(limit)}회
					</strong>
				</span>
				<span className="muted">누적 {number.format(usage.total)}회</span>
			</div>
			{/* Native <progress>: no inline styles, so the strict CSP (style-src 'self') holds. */}
			<progress className="usage__bar" value={used} max={limit} aria-label="오늘 AI 사용량" />
			<span className="sr-only">{Math.round(ratio * 100)}%</span>
			<p className="muted small usage__note">
				{full ? '오늘 데모의 AI 사용 한도에 도달했습니다. ' : ''}매일 오전 9시(한국 시간)에 초기화됩니다.
			</p>
		</section>
	);
}
