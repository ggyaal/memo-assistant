import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, fetchMemos } from '../client/api.ts';
import { CATEGORY_LABELS } from '../client/format.ts';
import { MEMO_CATEGORIES, type Memo, type MemoCategory } from '../shared/types.ts';
import { MemoCard } from './MemoCard.tsx';

type Scope = 'today' | 'all';

export function MemoList({ refreshKey }: { refreshKey: number }) {
	const [scope, setScope] = useState<Scope>('today');
	const [category, setCategory] = useState<MemoCategory | ''>('');
	const [memos, setMemos] = useState<Memo[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

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
						{value === 'today' ? '오늘 등록된 메모' : '전체 공개 메모'}
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
				<p className="empty muted">{scope === 'today' ? '오늘(한국 시간) 등록된 메모가 아직 없습니다.' : '아직 공개 메모가 없습니다.'}</p>
			)}
			<div className="cards">
				{memos.map((memo) => (
					<MemoCard key={memo.id} memo={memo} />
				))}
			</div>
			{loading && <p className="muted center">불러오는 중…</p>}
			{cursor && !loading && (
				<button type="button" className="secondary" onClick={() => void load(cursor)}>
					더 보기
				</button>
			)}
		</section>
	);
}
