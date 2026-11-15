import { useEffect, useState } from 'react';
import { useSpace } from '../client/space.ts';
import { fetchAgenda } from '../client/api.ts';
import { formatDue, formatKst } from '../client/format.ts';
import type { AgendaResponse } from '../shared/types.ts';
import { OverdueList } from './OverdueList.tsx';
import { ReminderSwitch } from './ReminderSwitch.tsx';
import { RankedList } from './RankedList.tsx';
import { SideCard } from './SideCard.tsx';

/**
 * Side panel: upcoming reminders in time order, and the priority list
 * (drag & drop order, else AI priority). Display only — no notification is sent.
 */
export function AgendaPanel({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
	const { shared, discordReady } = useSpace();
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
			<SideCard
				id="reminders"
				title={
					<>
						⏰ 다가오는 알림 <span className="muted small">시간순</span>
					</>
				}
				extra={agenda && agenda.reminders.length > 0 ? <span className="badge">{agenda.reminders.length}</span> : null}
			>
				{failed && <p className="error small">불러오지 못했습니다.</p>}
				{agenda && agenda.reminders.length === 0 && <p className="muted small">알림 추천이 있는 다가오는 메모가 없습니다.</p>}
				{agenda && agenda.reminders.length > 0 && (
					<ol className="agenda__list">
						{agenda.reminders.map((memo) => (
							<li key={`${memo.id}:${memo.reminder?.status ?? 'off'}:${memo.reminder?.at ?? ''}`} className="agenda__item">
								<span className="agenda__time">{formatDue(memo)}</span>
								<span className="agenda__name">{memo.title}</span>
								{memo.reminder_reason && <span className="muted small">{memo.reminder_reason}</span>}
								{shared && <span className="muted small">by {memo.nickname}</span>}
								{!shared && discordReady && <ReminderSwitch memo={memo} onChanged={onChanged} />}
							</li>
						))}
					</ol>
				)}
				<p className="muted small agenda__note">
					{shared
						? 'AI가 알림을 추천한 일정이에요. 공개 공간에서는 표시만 하며 실제 알림은 보내지 않습니다.'
						: discordReady
							? '알림이 추천된 일정은 자동으로 Discord DM이 예약돼요. 원하지 않으면 스위치로 끄세요.'
							: '⚙️ 설정에서 Discord 알림을 켜면 추천된 일정을 자동으로 DM으로 알려 드려요.'}
				</p>
			</SideCard>

			<SideCard
				id="ranked"
				title={
					<>
						📋 일정 우선순위 <span className="muted small">끌어서 순서 변경</span>
					</>
				}
				extra={agenda && agenda.ranked.length > 0 ? <span className="badge">{agenda.ranked.length}</span> : null}
			>
				{failed && <p className="error small">불러오지 못했습니다.</p>}
				{agenda && agenda.ranked.length === 0 && <p className="muted small">기한이 있는 다가오는 메모가 없습니다.</p>}
				{agenda && agenda.ranked.length > 0 && <RankedList items={agenda.ranked} onChanged={onChanged} />}
				<p className="muted small agenda__note">
					처음 순서는 AI 우선순위 → 가까운 순입니다. 끌거나 ▲▼로 바꾼 순서는 저장되며{' '}
					{shared ? <strong>모든 방문자에게 적용</strong> : '나에게만 적용'}됩니다.
				</p>
			</SideCard>

			<SideCard
				id="ideas"
				title={
					<>
						💡 아이디어 목록 <span className="muted small">최신순</span>
					</>
				}
				extra={agenda && agenda.ideas.length > 0 ? <span className="badge badge--idea">{agenda.ideas.length}</span> : null}
			>
				{failed && <p className="error small">불러오지 못했습니다.</p>}
				{agenda && agenda.ideas.length === 0 && <p className="muted small">아직 아이디어가 없어요. 떠오른 생각을 적으면 AI가 아이디어로 분류해요.</p>}
				{agenda && agenda.ideas.length > 0 && (
					<ul className="agenda__list">
						{agenda.ideas.map((memo) => (
							<li key={memo.id} className="agenda__item">
								<span className="agenda__name">{memo.title}</span>
								{memo.content !== memo.title && <span className="muted small idea__content">{memo.content}</span>}
								<span className="muted small">
									{formatKst(memo.created_at)}
									{shared && ` · by ${memo.nickname}`}
								</span>
							</li>
						))}
					</ul>
				)}
				<p className="muted small agenda__note">완료로 체크하거나 분류를 바꾸면 목록에서 빠져요. 내용은 메모 카드의 ✏️ 수정으로 고칠 수 있어요.</p>
			</SideCard>

			<SideCard
				id="overdue"
				className="agenda__section--overdue"
				title={
					<>
						🕗 지나버린 일 <span className="muted small">기한 지남 · 미완료</span>
					</>
				}
				extra={agenda && agenda.overdue.length > 0 ? <span className="badge badge--overdue">{agenda.overdue.length}</span> : null}
			>
				{failed && <p className="error small">불러오지 못했습니다.</p>}
				{agenda && <OverdueList items={agenda.overdue} onChanged={onChanged} />}
				<p className="muted small agenda__note">
					완료로 체크하면 이 목록에서 빠집니다. 삭제하면 {shared ? <strong>모든 방문자의 목록에서 사라집니다</strong> : '내 목록에서 사라집니다'}.
				</p>
			</SideCard>
		</div>
	);
}
