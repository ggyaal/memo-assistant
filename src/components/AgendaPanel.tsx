import { useEffect, useState } from 'react';
import { fetchAgenda } from '../client/api.ts';
import { CATEGORY_LABELS, formatDue, PRIORITY_LABELS } from '../client/format.ts';
import type { AgendaResponse, Memo } from '../shared/types.ts';

function PriorityBadge({ memo }: { memo: Memo }) {
	if (!memo.priority) return <span className="badge badge--priority-unset">우선순위 미지정</span>;
	return <span className={`badge badge--priority-${memo.priority}`}>{PRIORITY_LABELS[memo.priority]}</span>;
}

/**
 * Side panel: upcoming reminders in time order, and upcoming dated memos
 * ranked by AI priority. Display only — no notification is ever sent.
 */
export function AgendaPanel({ refreshKey }: { refreshKey: number }) {
	const [agenda, setAgenda] = useState<AgendaResponse | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		fetchAgenda()
			.then((result) => {
				if (!cancelled) {
					setAgenda(result);
					setFailed(false);
				}
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [refreshKey]);

	return (
		<div className="agenda">
			<section className="card agenda__section" aria-labelledby="agenda-reminders">
				<h2 id="agenda-reminders" className="agenda__title">
					⏰ 다가오는 알림 <span className="muted small">시간순</span>
				</h2>
				{failed && <p className="error small">불러오지 못했습니다.</p>}
				{agenda && agenda.reminders.length === 0 && <p className="muted small">알림 추천이 있는 다가오는 메모가 없습니다.</p>}
				{agenda && agenda.reminders.length > 0 && (
					<ol className="agenda__list">
						{agenda.reminders.map((memo) => (
							<li key={memo.id} className="agenda__item">
								<span className="agenda__time">{formatDue(memo)}</span>
								<span className="agenda__name">{memo.title}</span>
								{memo.reminder_reason && <span className="muted small">{memo.reminder_reason}</span>}
								<span className="muted small">by {memo.nickname}</span>
							</li>
						))}
					</ol>
				)}
				<p className="muted small agenda__note">표시만 하며 실제 알림은 보내지 않습니다.</p>
			</section>

			<section className="card agenda__section" aria-labelledby="agenda-ranked">
				<h2 id="agenda-ranked" className="agenda__title">
					📋 일정 우선순위 <span className="muted small">중요도 → 가까운 순</span>
				</h2>
				{failed && <p className="error small">불러오지 못했습니다.</p>}
				{agenda && agenda.ranked.length === 0 && <p className="muted small">기한이 있는 다가오는 메모가 없습니다.</p>}
				{agenda && agenda.ranked.length > 0 && (
					<ol className="agenda__list agenda__list--ranked">
						{agenda.ranked.map((memo, index) => (
							<li key={memo.id} className="agenda__item">
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
									</span>
									{memo.priority_reason && <span className="muted small">{memo.priority_reason}</span>}
								</div>
							</li>
						))}
					</ol>
				)}
				<p className="muted small agenda__note">우선순위는 AI 판단이며 참고용입니다.</p>
			</section>
		</div>
	);
}
