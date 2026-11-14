import { useEffect, useState } from 'react';
import { fetchAgenda } from '../client/api.ts';
import { formatDue } from '../client/format.ts';
import type { AgendaResponse } from '../shared/types.ts';
import { OverdueList } from './OverdueList.tsx';
import { RankedList } from './RankedList.tsx';

/**
 * Side panel: upcoming reminders in time order, and the priority list
 * (drag & drop order, else AI priority). Display only — no notification is sent.
 */
export function AgendaPanel({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
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
					📋 일정 우선순위 <span className="muted small">끌어서 순서 변경</span>
				</h2>
				{failed && <p className="error small">불러오지 못했습니다.</p>}
				{agenda && agenda.ranked.length === 0 && <p className="muted small">기한이 있는 다가오는 메모가 없습니다.</p>}
				{agenda && agenda.ranked.length > 0 && <RankedList items={agenda.ranked} onChanged={onChanged} />}
				<p className="muted small agenda__note">
					처음 순서는 AI 우선순위 → 가까운 순입니다. 끌거나 ▲▼로 바꾼 순서는 저장되며 <strong>모든 방문자에게 적용</strong>됩니다.
				</p>
			</section>

			<section className="card agenda__section agenda__section--overdue" aria-labelledby="agenda-overdue">
				<h2 id="agenda-overdue" className="agenda__title">
					🕗 지나버린 일 <span className="muted small">기한 지남 · 미완료</span>
					{agenda && agenda.overdue.length > 0 && <span className="badge badge--overdue">{agenda.overdue.length}</span>}
				</h2>
				{failed && <p className="error small">불러오지 못했습니다.</p>}
				{agenda && <OverdueList items={agenda.overdue} onChanged={onChanged} />}
				<p className="muted small agenda__note">
					완료로 체크하면 이 목록에서 빠집니다. 삭제하면 <strong>모든 방문자의 목록에서 사라집니다</strong>.
				</p>
			</section>
		</div>
	);
}
