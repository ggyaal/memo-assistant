import { useCallback, useEffect, useState } from 'react';
import { useSpace } from '../client/space.ts';
import { ApiRequestError, fetchMemos } from '../client/api.ts';
import { CATEGORY_LABELS } from '../client/format.ts';
import { dayGroupLabel, groupMemosByDay, type GroupBy } from '../client/groups.ts';
import { MEMO_CATEGORIES, type Memo, type MemoCategory } from '../shared/types.ts';
import { MemoCard } from './MemoCard.tsx';

type Scope = 'today' | 'all';
const GROUP_KEY = 'memo-assistant:list-group-by';

export function MemoList({ refreshKey, onChanged }: { refreshKey: number; onChanged?: () => void }) {
	const { shared } = useSpace();
	const [scope, setScope] = useState<Scope>('today');
	const [category, setCategory] = useState<MemoCategory | ''>('');
	const [memos, setMemos] = useState<Memo[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// "전체" tab: group by registration day (list order) or by schedule day (user request).
	const [groupBy, setGroupBy] = useState<GroupBy>(() => {
		try {
			return localStorage.getItem(GROUP_KEY) === 'due' ? 'due' : 'created';
		} catch {
			return 'created';
		}
	});
	function chooseGroupBy(next: GroupBy) {
		setGroupBy(next);
		try {
			localStorage.setItem(GROUP_KEY, next);
		} catch {
			// convenience only
		}
	}

	const load = useCallback(
		async (append: string | null) => {
			setLoading(true);
			setError(null);
			try {
				const result = await fetchMemos({ scope, category, cursor: append });
				setMemos((prev) => (append ? [...prev, ...result.memos] : result.memos));
				setCursor(result.nextCursor);
			} catch (err) {
				setError(err instanceof ApiRequestError ? err.message : '목록을 불러오지 못했습니다.');
			} finally {
				setLoading(false);
			}
		},
		[scope, category],
	);

	useEffect(() => {
		void load(null);
	}, [load, refreshKey]);

	return (
		<section className="list">
			<div className="tabs" role="tablist">
				{(['today', 'all'] as const).map((value) => (
					<button
						key={value}
						type="button"
						role="tab"
						aria-selected={scope === value}
						className={scope === value ? 'tab tab--active' : 'tab'}
						onClick={() => setScope(value)}
					>
						{value === 'today' ? '오늘 등록된 메모' : shared ? '전체 공개 메모' : '전체 메모'}
					</button>
				))}
			</div>
			<div className="row filters">
				<label className="small muted" htmlFor="category-filter">
					종류
				</label>
				<select id="category-filter" value={category} onChange={(e) => setCategory(e.target.value as MemoCategory | '')}>
					<option value="">전체</option>
					{MEMO_CATEGORIES.map((c) => (
						<option key={c} value={c}>
							{CATEGORY_LABELS[c]}
						</option>
					))}
				</select>
				{scope === 'all' && (
					<>
						<label className="small muted" htmlFor="group-by">
							날짜 묶기
						</label>
						<select id="group-by" value={groupBy} onChange={(e) => chooseGroupBy(e.target.value as GroupBy)}>
							<option value="created">등록일</option>
							<option value="due">일정 날짜</option>
						</select>
					</>
				)}
				<button type="button" className="link-button small" onClick={() => void load(null)} disabled={loading}>
					새로고침
				</button>
			</div>
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			{!error && !loading && memos.length === 0 && (
				<p className="empty muted">{scope === 'today' ? '오늘(한국 시간) 등록된 메모가 아직 없습니다.' : shared ? '아직 공개 메모가 없습니다.' : '아직 메모가 없습니다. 위에서 첫 메모를 적어 보세요.'}</p>
			)}
			{(scope === 'all' ? groupMemosByDay(memos, groupBy) : [{ day: null, memos }]).map((group) => (
				<section key={group.day ?? 'all'} className="day-group" aria-label={group.day === null ? undefined : dayGroupLabel(group.day, groupBy)}>
					{scope === 'all' && (
						<h3 className="day-group__title">
							{dayGroupLabel(group.day, groupBy)}
							<span className="muted small"> · {group.memos.length}개</span>
						</h3>
					)}
					<div className="cards">
						{group.memos.map((memo) => (
							<MemoCard
								key={`${memo.id}:${memo.completed_at ?? ''}:${memo.reminder?.status ?? ''}:${memo.reminder?.at ?? ''}`}
								memo={memo}
								onChanged={() => {
									void load(null);
									onChanged?.();
								}}
								// A delete keeps the card's undo bar here; only the other panels refresh.
								onRemoved={() => onChanged?.()}
							/>
						))}
					</div>
				</section>
			))}
			{scope === 'all' && groupBy === 'due' && cursor && (
				<p className="muted small">일정 날짜 묶기는 지금 불러온 메모만 정리해요. 「더 보기」로 더 불러오면 함께 묶여요.</p>
			)}
			{loading && <p className="muted center">불러오는 중…</p>}
			{cursor && !loading && (
				<button type="button" className="secondary" onClick={() => void load(cursor)}>
					더 보기
				</button>
			)}
		</section>
	);
}
