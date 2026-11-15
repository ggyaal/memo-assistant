import { type FormEvent, useEffect, useState } from 'react';
import { fetchMe, fetchSettings, logout, type MeResponse } from './client/api.ts';
import { SpaceContext } from './client/space.ts';
import { AccountBar } from './components/AccountBar.tsx';
import { AgendaPanel } from './components/AgendaPanel.tsx';
import { Landing } from './components/Landing.tsx';
import { RETURN_TO_SETTINGS_KEY, SettingsPage } from './components/SettingsPage.tsx';
import { MemoCard } from './components/MemoCard.tsx';
import { MemoInput } from './components/MemoInput.tsx';
import { CalendarView } from './components/CalendarView.tsx';
import { MemoList } from './components/MemoList.tsx';
import { UsageMeter } from './components/UsageMeter.tsx';
import { describeSensitive, detectSensitive } from './shared/privacy.ts';
import { LIMITS, type CreateMemosResponse } from './shared/types.ts';

const NICKNAME_KEY = 'memo-assistant:nickname';
const GUEST_KEY = 'memo-assistant:guest';
const MAIN_VIEW_KEY = 'memo-assistant:main-view';

const AUTH_MESSAGES: Record<string, string> = {
	provider_unavailable: '이 로그인 방법은 아직 준비 중이에요.',
	cancelled: '로그인을 취소했어요.',
	invalid_state: '로그인 요청이 만료되었거나 올바르지 않아요. 다시 시도해 주세요.',
	provider_error: '로그인 서비스와 통신하지 못했어요. 잠시 후 다시 시도해 주세요.',
	login_required: '계정 연결은 로그인한 상태에서만 할 수 있어요.',
	already_linked_elsewhere: '그 계정은 이미 다른 사용자와 연결되어 있어요. 계정은 자동으로 합치지 않습니다.',
};

function readStorage(key: string): string {
	try {
		return localStorage.getItem(key) ?? '';
	} catch {
		return '';
	}
}

function writeStorage(key: string, value: string | null) {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// Storage is only a convenience.
	}
}

/** One-time banner from the OAuth redirect (?auth_error=… / ?linked=…), then clean the URL. */
function takeAuthBanner(): { text: string; error: boolean } | null {
	const params = new URLSearchParams(window.location.search);
	const error = params.get('auth_error');
	const linked = params.get('linked');
	if (!error && !linked) return null;
	window.history.replaceState(null, '', window.location.pathname);
	if (error) return { text: AUTH_MESSAGES[error] ?? '로그인하지 못했어요.', error: true };
	return { text: '계정을 연결했어요. 이제 어느 계정으로 로그인해도 같은 개인 공간이 열려요.', error: false };
}

export function App() {
	const [me, setMe] = useState<MeResponse | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [guestChosen, setGuestChosen] = useState(() => readStorage(GUEST_KEY) === '1');
	const [banner] = useState(takeAuthBanner);

	useEffect(() => {
		fetchMe()
			.then(setMe)
			.catch(() => setLoadError(true));
	}, []);

	const hero = (
		<header className="hero">
			<h1>Memo Assistant</h1>
			<p className="muted">여러 생각을 한 번에 적으면 AI가 할 일·일정·아이디어·메모로 나눠 정리합니다.</p>
		</header>
	);

	if (!me) {
		return (
			<main className="container">
				{hero}
				<p className={loadError ? 'error' : 'muted'}>{loadError ? '서버에 연결하지 못했습니다. 새로고침해 주세요.' : '불러오는 중…'}</p>
			</main>
		);
	}

	const bannerView = banner && (
		<p className={banner.error ? 'error banner' : 'banner'} role="status">
			{banner.text}
		</p>
	);

	if (me.mode === 'guest' && !guestChosen) {
		return (
			<main className="container">
				{hero}
				{bannerView}
				<Landing
					me={me}
					onGuest={() => {
						writeStorage(GUEST_KEY, '1');
						setGuestChosen(true);
					}}
				/>
			</main>
		);
	}

	return (
		<SpaceContext.Provider value={{ shared: me.workspace.kind === 'shared_guest', discordReady: false }}>
			{/* Re-mount per workspace: nothing from one space survives into another. */}
			<WorkspaceView
				key={me.workspace.id}
				me={me}
				hero={hero}
				banner={bannerView}
				onLogin={() => {
					writeStorage(GUEST_KEY, null);
					setGuestChosen(false);
				}}
				onLogout={async () => {
					await logout().catch(() => {});
					writeStorage(GUEST_KEY, null);
					setGuestChosen(false);
					setMe(await fetchMe());
				}}
				onMeChanged={async () => setMe(await fetchMe())}
			/>
		</SpaceContext.Provider>
	);
}

function WorkspaceView({
	me,
	hero,
	banner,
	onLogin,
	onLogout,
	onMeChanged,
}: {
	me: MeResponse;
	hero: React.ReactNode;
	banner: React.ReactNode;
	onLogin: () => void;
	onLogout: () => Promise<void>;
	onMeChanged: () => Promise<void>;
}) {
	const personal = me.mode === 'user' && !!me.user;
	const [view, setView] = useState<'memos' | 'settings'>(() => {
		// Coming back from "연결하기" in settings: reopen settings once.
		try {
			if (personal && sessionStorage.getItem(RETURN_TO_SETTINGS_KEY)) {
				sessionStorage.removeItem(RETURN_TO_SETTINGS_KEY);
				return 'settings';
			}
		} catch {
			// ignore
		}
		return 'memos';
	});
	const [guestNickname, setGuestNickname] = useState(() => readStorage(NICKNAME_KEY));
	// Personal space: can reminders be booked? (Discord on + verified by a test DM)
	const [discordReady, setDiscordReady] = useState(false);
	useEffect(() => {
		if (!personal || view !== 'memos') return;
		fetchSettings()
			.then((s) => setDiscordReady(s.notifications.some((n) => n.channel === 'discord' && n.delivering)))
			.catch(() => setDiscordReady(false));
	}, [personal, view]);
	// Signed-in: the account's display name (editable in settings) is the author name.
	const nickname = personal ? me.user!.displayName : guestNickname;
	const setNickname = setGuestNickname;
	const [draft, setDraft] = useState(nickname);
	const [lastResult, setLastResult] = useState<CreateMemosResponse | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);
	const [usageKey, setUsageKey] = useState(0);
	// Bumped after a board edit (done / reorder / delete) to reload the side panel only.
	const [agendaKey, setAgendaKey] = useState(0);
	// "📝 메모 목록" or "📅 캘린더": two views of the same memo rows (remembered per browser).
	const [mainView, setMainView] = useState<'list' | 'calendar'>(() => (readStorage(MAIN_VIEW_KEY) === 'list' ? 'list' : 'calendar')); // calendar first by default
	const chooseView = (next: 'list' | 'calendar') => {
		setMainView(next);
		writeStorage(MAIN_VIEW_KEY, next);
	};

	function saveNickname(event: FormEvent) {
		event.preventDefault();
		const value = draft.trim().slice(0, LIMITS.nicknameMax);
		if (!value || detectSensitive(value).length > 0) return;
		setNickname(value);
		writeStorage(NICKNAME_KEY, value);
	}

	if (personal && view === 'settings') {
		return (
			<main className="container">
				{hero}
				<AccountBar me={me} onLogin={onLogin} onLogout={onLogout} />
				{banner}
				<SettingsPage me={me} onBack={() => setView('memos')} onProfileChanged={() => void onMeChanged()} />
			</main>
		);
	}

	return (
		<SpaceContext.Provider value={{ shared: !personal, discordReady }}>
		<main className="container layout">
			<div className="layout__top">
				{hero}
				<AccountBar me={me} onLogin={onLogin} onLogout={onLogout} onSettings={personal ? () => setView('settings') : undefined} />
				{banner}

				{personal ? (
					<aside className="notice notice--private" role="note">
						<strong>🔒 {me.workspace.name}</strong> — 로그인한 본인만 볼 수 있는 공간이에요. 정리할 때 입력 내용은 AI(Cloudflare Workers AI)로
						처리됩니다. 공개 공간 「익명의 스케줄」의 메모는 여기 보이지 않아요. 알림이 추천된 일정은 ⚙️ 설정에서 Discord 알림을 켜 두면 자동으로 DM이 예약돼요(다가오는 알림에서 끌 수 있어요).
					</aside>
				) : (
					<aside className="notice" role="note">
						<strong>「{me.workspace.name}」은 공개 공간입니다.</strong> 입력한 내용과 닉네임은 <strong>모든 방문자에게 공개</strong>되고, 누구나
						완료 체크·순서 변경·지난 일 삭제를 할 수 있어요. 이름·연락처·주소·건강 정보 등 개인정보나 비밀 내용을 입력하지 마세요. 닉네임은
						표시용일 뿐 로그인/본인 확인이 아닙니다. 알림 추천은 표시만 하며 실제 알림은 보내지 않습니다.
					</aside>
				)}

				<UsageMeter refreshKey={usageKey} />

				{nickname ? (
					<>
						{!personal && (
							<p className="row space-between small">
								<span>
									닉네임: <strong>{nickname}</strong>
								</span>
								<button type="button" className="link-button" onClick={() => setNickname('')}>
									변경
								</button>
							</p>
						)}
						<MemoInput
							nickname={nickname}
							onCreated={(result) => {
								setLastResult(result);
								setRefreshKey((k) => k + 1);
							}}
							onSettled={() => setUsageKey((k) => k + 1)}
						/>
					</>
				) : (
					<form className="card" onSubmit={saveNickname}>
						<label htmlFor="nickname" className="label">
							공개될 닉네임을 정해 주세요
						</label>
						<input
							id="nickname"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							maxLength={LIMITS.nicknameMax}
							placeholder={`최대 ${LIMITS.nicknameMax}자, 실명 대신 별명 권장`}
							autoComplete="off"
						/>
						{detectSensitive(draft).length > 0 && (
							<p className="warning" role="alert">
								⚠️ 닉네임에 {describeSensitive(detectSensitive(draft))}를 쓰지 마세요. 닉네임도 모두에게 공개됩니다.
							</p>
						)}
						<button type="submit" className="primary" disabled={!draft.trim() || detectSensitive(draft).length > 0}>
							시작하기
						</button>
					</form>
				)}

				{lastResult && (
					<section className="result" aria-live="polite">
						<h2>
							방금 정리된 메모 {lastResult.memos.length}개{lastResult.duplicate && ' (이미 저장된 요청)'}
						</h2>
						<div className="cards">
							{lastResult.memos.map((memo) => (
								<MemoCard key={memo.id} memo={memo} showSource={false} onChanged={() => setRefreshKey((k) => k + 1)} />
							))}
						</div>
					</section>
				)}
			</div>

			{/* Side panel on wide screens; between the input and the list on mobile. */}
			<aside className="layout__side" aria-label="다가오는 알림과 일정 우선순위">
				<AgendaPanel refreshKey={refreshKey + agendaKey} onChanged={() => setRefreshKey((k) => k + 1)} />
			</aside>

			<div className="layout__bottom">
				<div className="view-tabs" role="tablist" aria-label="보기 전환">
					<button type="button" role="tab" aria-selected={mainView === 'calendar'} className={`view-tab${mainView === 'calendar' ? ' is-active' : ''}`} onClick={() => chooseView('calendar')}>
						📅 캘린더
					</button>
					<button type="button" role="tab" aria-selected={mainView === 'list'} className={`view-tab${mainView === 'list' ? ' is-active' : ''}`} onClick={() => chooseView('list')}>
						📝 메모 목록
					</button>
				</div>
				{mainView === 'calendar' ? (
					<CalendarView refreshKey={refreshKey} onChanged={() => setAgendaKey((k) => k + 1)} />
				) : (
					<MemoList refreshKey={refreshKey} onChanged={() => setAgendaKey((k) => k + 1)} />
				)}

				<footer className="muted small center footer">
					AX School Build Your Agent · Flue + Cloudflare Workers AI + D1 프로토타입
				</footer>
			</div>
		</main>
		</SpaceContext.Provider>
	);
}
