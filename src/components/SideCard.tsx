import { type ReactNode, useId, useState } from 'react';

const KEY = (id: string) => `memo-assistant:side:${id}:collapsed`;

/** The person's own choice wins; otherwise the card's default. */
function readCollapsed(id: string, fallback: boolean): boolean {
	try {
		const saved = localStorage.getItem(KEY(id));
		return saved === null ? fallback : saved === '1';
	} catch {
		return fallback; // storage blocked: use the default
	}
}

/**
 * One side-panel card with a fold/unfold toggle. The choice is remembered per
 * browser (a convenience only); folded cards keep their title and count visible.
 */
export function SideCard({
	id,
	title,
	extra,
	className = '',
	defaultCollapsed = false,
	children,
}: {
	id: string;
	title: ReactNode;
	/** Shown next to the title even when folded (e.g. a count badge). */
	extra?: ReactNode;
	className?: string;
	/** Folded until the person opens it (and then remembered). */
	defaultCollapsed?: boolean;
	children: ReactNode;
}) {
	const [collapsed, setCollapsed] = useState(() => readCollapsed(id, defaultCollapsed));
	const bodyId = useId();
	function toggle() {
		setCollapsed((c) => {
			try {
				localStorage.setItem(KEY(id), c ? '0' : '1');
			} catch {
				// convenience only
			}
			return !c;
		});
	}
	return (
		<section className={`card agenda__section side-card${collapsed ? ' is-collapsed' : ''} ${className}`}>
			<h2 className="agenda__title side-card__title">
				<button type="button" className="side-card__toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={toggle}>
					<span className="side-card__label">{title}</span>
					{extra}
					<span className="side-card__chevron" aria-hidden="true">
						{collapsed ? '▸' : '▾'}
					</span>
					<span className="sr-only">{collapsed ? '펼치기' : '접기'}</span>
				</button>
			</h2>
			<div id={bodyId} className="side-card__body" hidden={collapsed}>
				{children}
			</div>
		</section>
	);
}
