import { type FormEvent, useEffect, useState } from 'react';
import {
	ApiRequestError,
	fetchSettings,
	type MeResponse,
	setNotificationChannel,
	updateDisplayName,
	updateReminderDefaults,
} from '../client/api.ts';
import { PROVIDER_ORDER, ProviderIcon } from './ProviderIcon.tsx';
import { LIMITS, type ChannelStatus, type SettingsResponse } from '../shared/types.ts';

export const RETURN_TO_SETTINGS_KEY = 'memo-assistant:return-to-settings';

/** Personal settings: profile, linked accounts and notification channels (signed-in only). */
export function SettingsPage({ me, onBack, onProfileChanged }: { me: MeResponse; onBack: () => void; onProfileChanged: () => void }) {
	const [settings, setSettings] = useState<SettingsResponse | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [nameStatus, setNameStatus] = useState<{ text: string; error: boolean } | null>(null);
	const [savingName, setSavingName] = useState(false);
	const [channelBusy, setChannelBusy] = useState<string | null>(null);
	const [channelError, setChannelError] = useState<Record<string, string>>({});
	const [lead, setLead] = useState(30);
	const [dateOnlyOn, setDateOnlyOn] = useState(false);
	const [dateOnlyTime, setDateOnlyTime] = useState('09:00');
	const [defaultsStatus, setDefaultsStatus] = useState<{ text: string; error: boolean } | null>(null);

	useEffect(() => {
		fetchSettings()
			.then((s) => {
				setSettings(s);
				setName(s.displayName);
				setLead(s.reminderDefaults.leadMinutes);
				setDateOnlyOn(!!s.reminderDefaults.dateOnlyTime);
				if (s.reminderDefaults.dateOnlyTime) setDateOnlyTime(s.reminderDefaults.dateOnlyTime);
			})
			.catch((e) => setLoadError(e instanceof ApiRequestError ? e.message : '설정을 불러오지 못했어요.'));
	}, []);

	async function saveName(event: FormEvent) {
		event.preventDefault();
		setSavingName(true);
		setNameStatus(null);
		try {
			const { displayName } = await updateDisplayName(name);
			setName(displayName);
			setSettings((s) => (s ? { ...s, displayName } : s));
			setNameStatus({ text: '닉네임을 바꿨어요. 내 메모의 작성자 이름도 함께 바뀌었어요.', error: false });
			onProfileChanged();
		} catch (e) {
			setNameStatus({ text: e instanceof ApiRequestError ? e.message : '저장하지 못했어요.', error: true });
		} finally {
			setSavingName(false);
		}
	}

	async function saveDefaults(event: FormEvent) {
		event.preventDefault();
		setDefaultsStatus(null);
		try {
			const { scheduled } = await updateReminderDefaults({ leadMinutes: lead, dateOnlyTime: dateOnlyOn ? dateOnlyTime : null });
			setDefaultsStatus({
				text: scheduled > 0 ? `저장했어요. 추천된 메모 ${scheduled}개에 알림을 예약했어요.` : '저장했어요. 이후 추천되는 메모에 적용돼요.',
				error: false,
			});
		} catch (e) {
			setDefaultsStatus({ text: e instanceof ApiRequestError ? e.message : '저장하지 못했어요.', error: true });
		}
	}

	// Re-check channel states (e.g. after joining the Discord server). Keeps the rest of the form as typed.
	const [checking, setChecking] = useState(false);
	async function recheckChannels() {
		setChecking(true);
		try {
			const fresh = await fetchSettings();
			setSettings((s) => (s ? { ...s, notifications: fresh.notifications } : fresh));
		} catch {
			// keep what is shown; the next check will try again
		} finally {
			setChecking(false);
		}
	}

	// Coming back from the Discord invite tab: check again so the switch unlocks by itself.
	const waitingForJoin = settings?.notifications.some((n) => n.server?.joined === false) ?? false;
	useEffect(() => {
		if (!waitingForJoin) return;
		const onVisible = () => {
			if (document.visibilityState === 'visible') void recheckChannels();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	}, [waitingForJoin]);

	const replaceChannel = (next: ChannelStatus) =>
		setSettings((s) => (s ? { ...s, notifications: s.notifications.map((n) => (n.channel === next.channel ? next : n)) } : s));

	async function toggle(status: ChannelStatus, enabled: boolean) {
		setChannelBusy(status.channel);
		setChannelError((e) => ({ ...e, [status.channel]: '' }));
		// Flip at once; the server's answer is the final word.
		replaceChannel({ ...status, enabled });
		try {
			const { status: saved } = await setNotificationChannel(status.channel, enabled);
			replaceChannel(saved);
		} catch (e) {
			replaceChannel(status); // back to what the server has
			setChannelError((err) => ({ ...err, [status.channel]: e instanceof ApiRequestError ? e.message : '변경하지 못했어요.' }));
		} finally {
			setChannelBusy(null);
		}
	}

	return (
		<section className="settings" aria-labelledby="settings-title">
			<div className="row space-between">
				<h2 id="settings-title" className="settings__title">
					⚙️ 설정
				</h2>
				<button type="button" className="link-button" onClick={onBack}>
					← 메모로 돌아가기
				</button>
			</div>
			{loadError && (
				<p className="error" role="alert">
					{loadError}
				</p>
			)}
			{!settings && !loadError && <p className="muted">불러오는 중…</p>}
			{settings && (
				<>
					<form className="card settings__section" onSubmit={saveName} aria-labelledby="settings-profile">
						<h3 id="settings-profile">프로필</h3>
						<label htmlFor="display-name" className="label">
							닉네임
						</label>
						<div className="row">
							<input
								id="display-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								maxLength={LIMITS.nicknameMax}
								autoComplete="nickname"
							/>
							<button
								type="submit"
								className="primary small"
								disabled={savingName || !name.trim() || name.trim() === settings.displayName}
							>
								저장
							</button>
						</div>
						<p className="muted small">개인 공간 이름과 내 메모의 작성자 이름으로 쓰여요. 소셜 계정의 이름은 바뀌지 않아요.</p>
						{nameStatus && (
							<p className={nameStatus.error ? 'error small' : 'muted small'} role="status">
								{nameStatus.text}
							</p>
						)}
						<p className="muted small">시간대: {settings.timezone} (한국 시간)</p>
					</form>

					<section className="card settings__section" aria-labelledby="settings-accounts">
						<h3 id="settings-accounts">연결된 계정</h3>
						<p className="muted small">연결한 계정 중 어느 것으로 로그인해도 같은 개인 공간이 열려요. 이메일이 같아도 자동으로 합치지 않아요.</p>
						<ul className="settings__list">
							{PROVIDER_ORDER.map((id) => {
								const provider = me.providers[id];
								const linked = settings.linked.includes(id);
								return (
									<li key={id} className="settings__row">
										<span className="settings__provider">
											<span className={`provider-mark provider-mark--${id}`}>
												<ProviderIcon id={id} />
											</span>
											{provider.label}
										</span>
										{linked ? (
											<span className="badge badge--linked">연결됨</span>
										) : provider.configured ? (
											<a
												className="link-button"
												href={`/api/auth/${id}/start?link=1`}
												onClick={() => {
													try {
														sessionStorage.setItem(RETURN_TO_SETTINGS_KEY, '1');
													} catch {
														// convenience only
													}
												}}
											>
												{provider.label} 연결하기
											</a>
										) : (
											<span className="muted small">준비 중</span>
										)}
									</li>
								);
							})}
						</ul>
					</section>

					<section className="card settings__section" aria-labelledby="settings-notify">
						<h3 id="settings-notify">알림 받을 경로</h3>
						<p className="muted small">켜 둔 경로로, 메모에서 직접 예약한 알림을 받아요. 알림 시각은 메모마다 확인 후 정해요.</p>
						<ul className="settings__list">
							{settings.notifications.map((status) => {
								const id = `channel-${status.channel}`;
								return (
									<li key={status.channel} className={`settings__row settings__row--channel${status.available ? '' : ' is-unavailable'}`}>
										<div className="settings__channel">
											<label htmlFor={id} className="settings__channel-label">
												{status.label}
											</label>
											{status.server && (
												<DiscordServerJoin server={status.server} checking={checking} onRecheck={() => void recheckChannels()} />
											)}
											{status.server?.joined !== false && <span className="muted small">{status.note}</span>}
											{status.enabled && !status.delivering && <span className="badge badge--pending">발송 준비 중</span>}
											{status.delivering && <span className="badge badge--linked">알림 받는 중</span>}
											{channelBusy === status.channel && status.channel === 'discord' && (
												<span className="muted small" role="status">
													Discord로 확인용 테스트 DM을 보내는 중…
												</span>
											)}
											{channelError[status.channel] && (
												<span className="error small" role="alert">
													{channelError[status.channel]}
												</span>
											)}
										</div>
										<input
											id={id}
											type="checkbox"
											role="switch"
											className="switch"
											checked={status.enabled}
											aria-checked={status.enabled}
											disabled={!status.available || channelBusy === status.channel}
											onChange={(e) => void toggle(status, e.target.checked)}
										/>
									</li>
								);
							})}
						</ul>
						<form className="settings__defaults" onSubmit={saveDefaults} aria-labelledby="settings-defaults">
							<h4 id="settings-defaults">자동 알림 기본값</h4>
							<p className="muted small">AI가 알림을 추천한 메모는 아래 기준으로 자동 예약돼요. 다가오는 알림에서 하나씩 끌 수 있어요.</p>
							<label className="settings__field">
								시각이 있는 메모{' '}
								<select value={lead} onChange={(e) => setLead(Number(e.target.value))}>
									<option value={0}>정시에</option>
									<option value={10}>10분 전</option>
									<option value={30}>30분 전</option>
									<option value={60}>1시간 전</option>
								</select>
							</label>
							<label className="settings__field">
								<input type="checkbox" checked={dateOnlyOn} onChange={(e) => setDateOnlyOn(e.target.checked)} /> 날짜만 있는 메모도 알림 받기
								{dateOnlyOn && (
									<>
										{' '}
										<input type="time" value={dateOnlyTime} onChange={(e) => setDateOnlyTime(e.target.value)} required aria-label="날짜만 있는 메모의 알림 시각" />
										<span className="muted small"> (그날 이 시각에)</span>
									</>
								)}
							</label>
							{!dateOnlyOn && <p className="muted small">끄면 날짜만 있는 메모는 시각을 임의로 정하지 않고 알림을 걸지 않아요.</p>}
							<button type="submit" className="primary small">
								기본값 저장
							</button>
							{defaultsStatus && (
								<p className={defaultsStatus.error ? 'error small' : 'muted small'} role="status">
									{defaultsStatus.text}
								</p>
							)}
						</form>
					</section>
				</>
			)}
		</section>
	);
}

/** Step before the Discord switch: join the bot's server (bots can only DM members of a shared server). */
function DiscordServerJoin({
	server,
	checking,
	onRecheck,
}: {
	server: NonNullable<ChannelStatus['server']>;
	checking: boolean;
	onRecheck: () => void;
}) {
	if (server.joined === true) {
		return <span className="server-join server-join--ok small">✅ 알림 봇이 있는 Discord 서버에 가입되어 있어요.</span>;
	}
	return (
		<span className={`server-join small${server.joined === false ? ' server-join--needed' : ''}`} role="status">
			{server.joined === false
				? '알림 봇이 있는 Discord 서버에 먼저 가입해 주세요. 봇은 같은 서버 멤버에게만 DM을 보낼 수 있어요. 가입하면 스위치를 켤 수 있어요.'
				: '서버 가입 여부를 지금 확인하지 못했어요. 켜면 테스트 DM으로 다시 확인해요.'}
			<span className="server-join__actions">
				{server.joined === false && server.inviteUrl && (
					<a className="primary small server-join__link" href={server.inviteUrl} target="_blank" rel="noopener noreferrer">
						Discord 서버 가입하기 ↗
					</a>
				)}
				<button type="button" className="link-button" disabled={checking} onClick={onRecheck}>
					{checking ? '확인하는 중…' : '가입 다시 확인'}
				</button>
			</span>
		</span>
	);
}
