import { useEffect, useMemo, useState } from 'react';
import { ApiRequestError, fetchCalendar } from '../client/api.ts';
import { CATEGORY_LABELS, toKstInput } from '../client/format.ts';
import { useSpace } from '../client/space.ts';
import { MEMO_CATEGORIES, type Memo, type MemoCategory } from '../shared/types.ts';
import { MemoCard } from './MemoCard.tsx';

const ICON: Record<MemoCategory, string> = { todo: '✅', schedule: '📅', idea: '💡', note: '📝' };
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
const FILTER_KEY = 'memo-assistant:calendar:categories';
const DEFAULT_FILTER: MemoCategory[] = ['todo', 'schedule'];

const timeFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit' });
const dayTitleFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'short' });

const todayKst = () => toKstInput(new Date()).slice(0, 10);

function readFilter(): MemoCategory[] {
	try {
		const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null') as unknown;
		if (Array.isArray(saved)) return saved.filter((c): c is MemoCategory => (MEMO_CATEGORIES as readonly string[]).includes(c));
	} catch {
		// convenience only
	}
	return DEFAULT_FILTER;
}

/** Month arithmetic on "YYYY-MM" (calendar math only; no time zone involved). */
function shiftMonth(month: string, delta: number): string {
	const [y, m] = month.split('-').map(Number);
	const d = new Date(Date.UTC(y, m - 1 + delta, 1));
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Cells of a Monday-first month grid: null = padding before day 1 / after the last day. */
function monthCells(month: string): (string | null)[] {
	const [y, m] = month.split('-').map(Number);
	const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
	const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
	const cells: (string | null)[] = Array.from({ length: lead }, () => null);
	for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
	while (cells.length % 7) cells.push(null);
	return cells;
}

/** "11월 16일 (월)" for a KST day string (treated as a plain date). */
const dayTitle = (day: string) => dayTitleFmt.format(new Date(`${day}T00:00:00Z`));
const timeOf = (memo: Memo) => (memo.due_at ? timeFmt.format(new Date(memo.due_at)) : '시간 미정');

/**
 * Month calendar of the same memo rows as the list, placed by their KST
 * deadline/schedule day (due_date) — never by created_at. No AI calls.
 */
export function CalendarView({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
	const { shared } = useSpace();
	const today = todayKst();
	const [month, setMonth] = useState(today.slice(0, 7));
	const [memos, setMemos] = useState<Memo[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(today);
	const [filter, setFilter] = useState<MemoCategory[]>(readFilter);
	const [reload, setReload] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setError(null);
		fetchCalendar(month)
			.then((r) => !cancelled && setMemos(r.memos))
			.catch((e) => !cancelled && setError(e instanceof ApiRequestError ? e.message : '캘린더를 불러오지 못했습니다.'));
		return () => {
			cancelled = true;
		};
	}, [month, refreshKey, reload]);

	function toggleCategory(c: MemoCategory) {
		setFilter((f) => {
			const next = f.includes(c) ? f.filter((x) => x !== c) : [...f, c];
			try {
				localStorage.setItem(FILTER_KEY, JSON.stringify(next));
			} catch {
				// convenience only
			}
			return next;
		});
	}

	const visible = useMemo(() => (memos ?? []).filter((m) => filter.includes(m.category)), [memos, filter]);
	const byDay = useMemo(() => {
		const map = new Map<string, Memo[]>();
		for (const m of visible) if (m.due_date) map.set(m.due_date, [...(map.get(m.due_date) ?? []), m]);
		return map;
	}, [visible]);
	const hiddenCount = (memos?.length ?? 0) - visible.length;
	const cells = monthCells(month);
	const [y, mNum] = month.split('-').map(Number);
	const selectedItems = selected ? (byDay.get(selected) ?? []) : [];
	const todayItems = month === today.slice(0, 7) ? (byDay.get(today) ?? []) : null;
	const changed = () => {
		setReload((k) => k + 1);
		onChanged();
	};

	return (
		<section className="calendar" aria-label="캘린더">
			<div className="calendar__nav">
				<button type="button" className="secondary small" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="이전 달">
					◀
				</button>
				<h2 className="calendar__month" aria-live="polite">
					{y}년 {mNum}월
				</h2>
				<button type="button" className="secondary small" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="다음 달">
					▶
				</button>
				<button
					type="button"
					className="link-button small"
					onClick={() => {
						setMonth(today.slice(0, 7));
						setSelected(today);
					}}
				>
					오늘
				</button>
			</div>

			<div className="calendar__filters" role="group" aria-label="표시할 분류">
				{MEMO_CATEGORIES.map((c) => (
					<button key={c} type="button" className={`chip chip--${c}${filter.includes(c) ? ' is-selected' : ''}`} aria-pressed={filter.includes(c)} onClick={() => toggleCategory(c)}>
						{ICON[c]} {CATEGORY_LABELS[c]}
					</button>
				))}
				<span className="muted small">날짜가 있는 메모만 표시돼요{hiddenCount > 0 ? ` · 숨긴 분류 ${hiddenCount}개` : ''}</span>
			</div>

			{todayItems && (
				<div className="calendar__today" aria-label="오늘 일정 요약">
					<strong>오늘 · {dayTitle(today)}</strong>
					{todayItems.length === 0 ? (
						<span className="muted small">오늘 날짜의 할 일·일정이 없어요.</span>
					) : (
						<ul>
							{todayItems.map((m) => (
								<li key={m.id} className={m.completed_at ? 'is-done' : undefined}>
									<span className="calendar__time">{timeOf(m)}</span> {ICON[m.category]} {m.title}
								</li>
							))}
						</ul>
					)}
				</div>
			)}

			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}

			<div className="calendar__grid" role="grid" aria-label={`${y}년 ${mNum}월`}>
				{WEEKDAYS.map((w, i) => (
					<div key={w} role="columnheader" className={`calendar__weekday${i === 5 ? ' is-sat' : i === 6 ? ' is-sun' : ''}`}>
						{w}
					</div>
				))}
				{cells.map((day, i) => {
					if (!day) return <div key={`pad-${i}`} className="calendar__cell is-pad" aria-hidden="true" />;
					const items = byDay.get(day) ?? [];
					const weekday = i % 7;
					return (
						<button
							key={day}
							type="button"
							role="gridcell"
							className={`calendar__cell${day === today ? ' is-today' : ''}${day === selected ? ' is-selected' : ''}${weekday === 5 ? ' is-sat' : weekday === 6 ? ' is-sun' : ''}`}
							aria-selected={day === selected}
							aria-label={`${dayTitle(day)}${day === today ? ' 오늘' : ''}, ${items.length}개`}
							onClick={() => setSelected(day)}
						>
							<span className="calendar__day">{Number(day.slice(8))}</span>
							{items.length > 0 && <span className="calendar__count">{items.length}</span>}
							<span className="calendar__items" aria-hidden="true">
								{items.slice(0, 3).map((m) => (
									<span key={m.id} className={`calendar__item calendar__item--${m.category}${m.completed_at ? ' is-done' : ''}`}>
										{ICON[m.category]} {m.due_at ? `${timeFmt.format(new Date(m.due_at))} ` : ''}
										{m.title}
									</span>
								))}
								{items.length > 3 && <span className="calendar__more">+{items.length - 3}</span>}
							</span>
						</button>
					);
				})}
			</div>

			{memos && memos.length === 0 && !error && (
				<p className="muted small">이번 달에는 날짜가 있는 메모가 없어요. 날짜가 없는 메모는 캘린더에 나오지 않아요(📝 메모 목록에서 볼 수 있어요).</p>
			)}

			{selected && selected.startsWith(month) && (
				<div className="calendar__detail" aria-live="polite">
					<h3>
						{dayTitle(selected)} · {selectedItems.length}개
					</h3>
					{selectedItems.length === 0 ? (
						<p className="muted small">이 날짜에 표시할 메모가 없어요.</p>
					) : (
						<div className="cards">
							{selectedItems.map((m) => (
								<MemoCard key={`${m.id}:${m.due_date}:${m.due_at ?? ''}:${m.completed_at ?? ''}:${m.reminder?.at ?? ''}`} memo={m} onChanged={changed} />
							))}
						</div>
					)}
					<p className="muted small">✏️ 수정으로 날짜·시각·분류를 바꾸면 목록과 캘린더에 함께 반영돼요{shared ? ' (공개 공간: 모든 방문자에게 적용)' : ''}.</p>
				</div>
			)}
		</section>
	);
}
