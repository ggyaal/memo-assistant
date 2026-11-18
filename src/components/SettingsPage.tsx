import { type FormEvent, useEffect, useState } from 'react';
import {
	ApiRequestError,
	fetchSettings,
	type MeResponse,
	sendTestEmail,
	sendTonePreview,
	setNotificationChannel,
	unlinkAccount,
	updateDisplayName,
	updateReminderTone,
	updateReminderDefaults,
} from '../client/api.ts';
import { PROVIDER_ORDER, ProviderIcon } from './ProviderIcon.tsx';
import { reminderCard, sampleTiming, toneMessage } from '../shared/discord-card.ts';
import { LIMITS, REMINDER_TONE_LABELS, REMINDER_TONES, type ChannelStatus, type ReminderTone, type SettingsResponse } from '../shared/types.ts';

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

	// Discord reminder wording: saved at once (fixed templates; examples are the exact DM sentences).
	const [toneStatus, setToneStatus] = useState<{ text: string; error: boolean } | null>(null);
	const [previewBusy, setPreviewBusy] = useState(false);
	async function chooseTone(tone: ReminderTone) {
		const previous = settings?.reminderTone;
		setSettings((s) => (s ? { ...s, reminderTone: tone } : s));
		setToneStatus(null);
		try {
			await updateReminderTone(tone);
			setToneStatus({ text: `‘${REMINDER_TONE_LABELS[tone]}’ 말투로 저장했어요.`, error: false });
		} catch (e) {
			if (previous) setSettings((s) => (s ? { ...s, reminderTone: previous } : s));
			setToneStatus({ text: e instanceof ApiRequestError ? e.message : '저장하지 못했어요.', error: true });
		}
	}
	async function preview() {
		setPreviewBusy(true);
		setToneStatus(null);
		try {
			await sendTonePreview();
			setToneStatus({ text: 'Discord DM으로 미리보기 카드를 보냈어요.', error: false });
		} catch (e) {
			setToneStatus({ text: e instanceof ApiRequestError ? e.message : '보내지 못했어요.', error: true });
		} finally {
			setPreviewBusy(false);
		}
	}

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

					<AccountsSection
						me={me}
						settings={settings}
						onChanged={(accounts) =>
							setSettings((s) => (s ? { ...s, accounts, linked: accounts.map((a) => a.provider) } : s))
						}
						onChannelsStale={() => void recheckChannels()}
					/>

					<section className="card settings__section" aria-labelledby="settings-notify">
						<h3 id="settings-notify">알림 받을 경로</h3>
						<p className="muted small">
							켜 둔 경로로 예약한 알림을 받아요. 경로마다 따로 켜고 끄며, 한 경로가 실패해도 다른 경로는 그대로 보내요. 알림 시각은 메모마다 확인 후 정해요.
						</p>
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
											{status.channel === 'email' && (
												<EmailExtras status={status} busy={channelBusy === 'email'} />
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
						<ToneSection
							tone={settings.reminderTone}
							discord={settings.notifications.find((n) => n.channel === 'discord')}
							email={settings.notifications.find((n) => n.channel === 'email')}
							previewBusy={previewBusy}
							status={toneStatus}
							onChoose={(t) => void chooseTone(t)}
							onPreview={() => void preview()}
						/>
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
							{!dateOnlyOn && <p className="muted small">끄면 날짜만 있는 한 번짜리 메모에는 알림을 걸지 않아요.</p>}
							<p className="muted small">🔁 시각 없이 요일만 있는 반복 일정(예: 월·화·금 헬스장)은 회차 날 {dateOnlyOn ? '위 시각' : '오전 9시'}에 자동으로 알려 드려요. 다가오는 알림에서 하나씩 끌 수 있어요.</p>
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

const rememberSettings = () => {
	try {
		sessionStorage.setItem(RETURN_TO_SETTINGS_KEY, '1');
	} catch {
		// convenience only
	}
};

/**
 * Linked login methods. Linking/unlinking needs a sign-in within the last 10 minutes (the server
 * checks it too); the last method can never be removed. Same e-mail never merges accounts.
 */
function AccountsSection({
	me,
	settings,
	onChanged,
	onChannelsStale,
}: {
	me: MeResponse;
	settings: SettingsResponse;
	onChanged: (accounts: SettingsResponse['accounts']) => void;
	onChannelsStale: () => void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<string | null>(null);
	const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
	const allowed = settings.accountChanges.allowed;
	const only = settings.accounts.length <= 1;
	const relogin = settings.accounts.find((a) => me.providers[a.provider]?.configured)?.provider;

	async function unlink(provider: SettingsResponse['accounts'][number]['provider']) {
		setBusy(provider);
		setMessage(null);
		try {
			const { accounts } = await unlinkAccount(provider);
			onChanged(accounts);
			onChannelsStale();
			setMessage({ text: `${me.providers[provider].label} 연결을 해제했어요.`, error: false });
		} catch (e) {
			setMessage({ text: e instanceof ApiRequestError ? e.message : '해제하지 못했어요.', error: true });
		} finally {
			setBusy(null);
			setConfirm(null);
		}
	}

	return (
		<section className="card settings__section" aria-labelledby="settings-accounts">
			<h3 id="settings-accounts">연결된 계정</h3>
			<p className="muted small">연결한 계정 중 어느 것으로 로그인해도 같은 개인 공간이 열려요. 이메일이 같아도 자동으로 합치지 않아요.</p>
			{!allowed && (
				<p className="notice small" role="note">
					🔐 보안을 위해 계정 연결·해제는 로그인한 지 10분 안에만 할 수 있어요.{' '}
					{relogin && (
						<a className="link-button" href={`/api/auth/${relogin}/start`} onClick={rememberSettings}>
							{me.providers[relogin].label}로 다시 로그인
						</a>
					)}
				</p>
			)}
			<ul className="settings__list">
				{PROVIDER_ORDER.map((id) => {
					const provider = me.providers[id];
					const account = settings.accounts.find((a) => a.provider === id);
					return (
						<li key={id} className="settings__row">
							<span className="settings__provider">
								<span className={`provider-mark provider-mark--${id}`}>
									<ProviderIcon id={id} />
								</span>
								<span>
									{provider.label}
									{account && (
										<span className="muted small settings__account-detail">
											{' '}
											· {account.displayName ?? '이름 없음'}
											{account.email ? ` · ${account.email} (인증됨)` : ''}
										</span>
									)}
								</span>
							</span>
							{account ? (
								<span className="row">
									<span className="badge badge--linked">연결됨</span>
									{confirm === id ? (
										<>
											<button type="button" className="danger small" disabled={busy === id} onClick={() => void unlink(id)}>
												{busy === id ? '해제하는 중…' : '해제 확인'}
											</button>
											<button type="button" className="link-button small" onClick={() => setConfirm(null)}>
												취소
											</button>
										</>
									) : (
										<button
											type="button"
											className="link-button small"
											disabled={!allowed || only || !!busy}
											title={only ? '마지막 로그인 방법은 해제할 수 없어요' : !allowed ? '다시 로그인한 뒤 해제할 수 있어요' : undefined}
											onClick={() => setConfirm(id)}
										>
											연결 해제
										</button>
									)}
								</span>
							) : provider.configured ? (
								allowed ? (
									<a className="link-button" href={`/api/auth/${id}/start?link=1`} onClick={rememberSettings}>
										{provider.label} 연결하기
									</a>
								) : (
									<span className="muted small">다시 로그인 후 연결</span>
								)
							) : (
								<span className="muted small">준비 중</span>
							)}
						</li>
					);
				})}
			</ul>
			{only && <p className="muted small">마지막 로그인 방법은 해제할 수 없어요. 해제하려면 다른 계정을 먼저 연결해 주세요.</p>}
			{confirm && (
				<p className="muted small" role="status">
					해제하면 그 계정으로는 이 개인 공간에 로그인할 수 없어요.
					{confirm === 'discord' ? ' Discord 알림도 꺼져요.' : confirm === 'google' ? ' 이메일 알림도 꺼져요.' : ''}
				</p>
			)}
			{message && (
				<p className={message.error ? 'error small' : 'muted small'} role={message.error ? 'alert' : 'status'}>
					{message.text}
				</p>
			)}
		</section>
	);
}

/**
 * E-mail channel details: recipient (verified Google address), privacy warning, test button and the
 * latest failure. "Accepted" means the mail service took the message — not that it reached the inbox.
 */
function EmailExtras({ status, busy }: { status: ChannelStatus; busy: boolean }) {
	const [sending, setSending] = useState(false);
	const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
	async function test() {
		setSending(true);
		setResult(null);
		try {
			const { to } = await sendTestEmail();
			setResult({ text: `${to}로 테스트 메일 발송 요청이 접수됐어요. 메일함(스팸함 포함)을 확인해 주세요.`, error: false });
		} catch (e) {
			setResult({ text: e instanceof ApiRequestError ? e.message : '보내지 못했어요.', error: true });
		} finally {
			setSending(false);
		}
	}
	return (
		<>
			{status.address && (
				<span className="small">
					받는 주소: <strong>{status.address}</strong> <span className="muted">(Google 인증 주소)</span>
				</span>
			)}
			{status.available && (
				<span className="muted small">⚠️ 메모 제목·시각이 메일 본문과 제목에 담겨요. 메일함은 다른 사람이 볼 수도 있으니 민감한 내용은 적지 마세요.</span>
			)}
			{busy && (
				<span className="muted small" role="status">
					확인용 테스트 메일을 보내는 중…
				</span>
			)}
			{status.enabled && (
				<span className="row">
					<button type="button" className="secondary small" disabled={sending} onClick={() => void test()}>
						{sending ? '보내는 중…' : '📬 테스트 메일 보내기'}
					</button>
				</span>
			)}
			{result && (
				<span className={result.error ? 'error small' : 'muted small'} role={result.error ? 'alert' : 'status'}>
					{result.text}
				</span>
			)}
			{status.lastFailure && (
				<span className="error small" role="note">
					최근 발송 실패({new Date(status.lastFailure.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}): {status.lastFailure.message}
				</span>
			)}
		</>
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

/** Four fixed wordings for Discord reminders; each example is the exact sentence a DM would use. */
function ToneSection({
	tone,
	discord,
	email,
	previewBusy,
	status,
	onChoose,
	onPreview,
}: {
	tone: ReminderTone;
	discord: ChannelStatus | undefined;
	email: ChannelStatus | undefined;
	previewBusy: boolean;
	status: { text: string; error: boolean } | null;
	onChoose: (tone: ReminderTone) => void;
	onPreview: () => void;
}) {
	const usable = !!discord?.available || !!email?.available;
	const { memo, timing } = sampleTiming(new Date());
	const card = reminderCard(tone, memo, timing);
	return (
		<fieldset className="settings__tone" disabled={!usable} aria-describedby="tone-help">
			<legend>알림 말투</legend>
			<p id="tone-help" className="muted small">
				{usable
					? 'Discord DM과 이메일 알림 문장의 말투예요. AI 없이 정해진 문장에 메모 제목과 시간만 넣어요. 예: “병원 방문” 30분 전'
					: 'Discord나 이메일 알림을 쓸 수 있을 때 고를 수 있어요.'}
			</p>
			<div className="tone-options" role="radiogroup" aria-label="알림 말투">
				{REMINDER_TONES.map((t) => (
					<label key={t} className={`tone-option${t === tone ? ' is-selected' : ''}`}>
						<input type="radio" name="reminder-tone" value={t} checked={t === tone} onChange={() => onChoose(t)} />
						<span className="tone-option__text">
							<strong>{REMINDER_TONE_LABELS[t]}</strong>
							<span className="muted small">{toneMessage(t, memo, timing)}</span>
						</span>
					</label>
				))}
			</div>
			<div className="tone-card" aria-label="Discord 카드 미리보기">
				<span className="tone-card__author small">{(card.embeds?.[0] as { author: { name: string } }).author.name}</span>
				<strong>{(card.embeds?.[0] as { title: string }).title}</strong>
				<span className="small">{(card.embeds?.[0] as { description: string }).description}</span>
				<span className="muted small">
					🗂 일정 · 🔔 30분 전 · ⏰ 예정 시각 · [메모비서에서 확인하기]
				</span>
			</div>
			<div className="row">
				<button type="button" className="secondary small" disabled={!discord?.enabled || previewBusy} onClick={onPreview} hidden={!discord?.available}>
					{previewBusy ? '보내는 중…' : '🧪 이 말투로 미리보기 DM 보내기'}
				</button>
				{!discord?.enabled && discord?.available && <span className="muted small">Discord 알림을 켜면 보낼 수 있어요.</span>}
			</div>
			{status && (
				<p className={status.error ? 'error small' : 'muted small'} role={status.error ? 'alert' : 'status'}>
					{status.text}
				</p>
			)}
		</fieldset>
	);
}
