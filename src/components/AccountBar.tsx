import { useState } from 'react';
import type { MeResponse } from '../client/api.ts';
import { Avatar } from './Avatar.tsx';

/** Current space + account actions (linking, logout) or a way back to login for guests. */
export function AccountBar({
	me,
	onLogout,
	onLogin,
	onSettings,
}: {
	me: MeResponse;
	onLogout: () => Promise<void>;
	onLogin: () => void;
	onSettings?: () => void;
}) {
	const [busy, setBusy] = useState(false);
	if (me.mode === 'guest' || !me.user) {
		return (
			<div className="account-bar">
				<span className="space-badge space-badge--shared">🌐 {me.workspace.name} · 공개 공간</span>
				<button type="button" className="link-button small" onClick={onLogin}>
					로그인하고 개인 공간 쓰기
				</button>
			</div>
		);
	}
	return (
		<div className="account-bar">
			<span className="space-badge space-badge--personal">🔒 {me.workspace.name} · 나만 보기</span>
			<span className="account-bar__links small">
				<span className="account-bar__who muted">
					<Avatar url={me.user.avatarUrl} size={22} />
					{me.user.displayName} · {me.user.linked.map((id) => me.providers[id].label).join(', ')}
				</span>
				{onSettings && (
					<button type="button" className="link-button" onClick={onSettings}>
						⚙️ 설정
					</button>
				)}
				<button
					type="button"
					className="link-button"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							await onLogout();
						} finally {
							setBusy(false);
						}
					}}
				>
					로그아웃
				</button>
			</span>
		</div>
	);
}
