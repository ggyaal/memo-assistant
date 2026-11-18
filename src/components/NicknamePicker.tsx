import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, chooseNickname, fetchNicknameSuggestions, type NicknameSuggestionsResponse, skipNickname } from '../client/api.ts';
import { NICKNAME_MAX, NICKNAME_MIN, nicknameProblem } from '../shared/nickname.ts';

/**
 * Nickname suggestions: three names from one AI call (fallback names when AI is unavailable).
 * Only "다시 추천" asks again. `firstLogin` shows the welcome card with "건너뛰기"
 * (keeps the random nickname the account already has).
 */
export function NicknamePicker({
	current,
	firstLogin,
	onDone,
	autoLoad = true,
}: {
	current: string;
	firstLogin: boolean;
	onDone: (displayName: string) => void;
	autoLoad?: boolean;
}) {
	const [data, setData] = useState<NicknameSuggestionsResponse | null>(null);
	const [picked, setPicked] = useState<string | null>(null);
	const [typing, setTyping] = useState(false);
	const [typed, setTyped] = useState('');
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const started = useRef(false);

	async function load() {
		setLoading(true);
		setError(null);
		try {
			const next = await fetchNicknameSuggestions();
			setData(next);
			setPicked(next.suggestions[0]?.name ?? null);
		} catch (e) {
			setError(e instanceof ApiRequestError ? e.message : '추천을 불러오지 못했어요.');
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		// Once per mount (StrictMode would otherwise ask the AI twice).
		if (!autoLoad || started.current) return;
		started.current = true;
		void load();
	}, [autoLoad]);

	async function save(name: string) {
		setSaving(true);
		setError(null);
		try {
			const { displayName } = await chooseNickname(name);
			onDone(displayName);
		} catch (e) {
			setError(e instanceof ApiRequestError ? e.message : '저장하지 못했어요.');
		} finally {
			setSaving(false);
		}
	}

	async function skip() {
		setSaving(true);
		try {
			await skipNickname();
		} catch {
			// The step ends on the next choice anyway; keep going.
		} finally {
			setSaving(false);
			onDone(current);
		}
	}

	const typedProblem = typed.trim() ? nicknameProblem(typed) : null;
	// Not a <form>: the picker can sit inside the settings profile form.
	function submitTyped() {
		if (!typedProblem && typed.trim()) void save(typed.trim());
	}

	return (
		<section className={firstLogin ? 'card nickname-picker nickname-picker--welcome' : 'nickname-picker'} aria-labelledby="nickname-title">
			<h3 id="nickname-title" className="nickname-picker__title">
				✨ 메모비서가 닉네임을 추천했어요!
			</h3>
			{firstLogin && (
				<p className="muted small">
					지금 닉네임은 <strong>{current}</strong>이에요. 소셜 계정 이름과는 따로, 이 앱에서만 쓰는 이름이에요. 언제든 설정에서 바꿀 수 있어요.
				</p>
			)}
			{loading && (
				<p className="muted small" role="status">
					추천을 만드는 중…
				</p>
			)}
			{data && !loading && (
				<div className="nickname-picker__options" role="radiogroup" aria-label="추천 닉네임">
					{data.suggestions.map((s) => (
						<label key={s.name} className={`nickname-option${picked === s.name && !typing ? ' is-selected' : ''}`}>
							<input
								type="radio"
								name="nickname-suggestion"
								value={s.name}
								checked={picked === s.name && !typing}
								onChange={() => {
									setPicked(s.name);
									setTyping(false);
								}}
							/>
							<span aria-hidden="true">{s.emoji}</span> {s.name}
						</label>
					))}
				</div>
			)}
			{data?.source === 'fallback' && !loading && <p className="muted small">AI 추천을 쓸 수 없어 기본 추천을 보여 드려요.</p>}
			{typing && (
				<div className="row nickname-picker__typed">
					<input
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								submitTyped();
							}
						}}
						maxLength={NICKNAME_MAX}
						placeholder={`${NICKNAME_MIN}~${NICKNAME_MAX}자`}
						aria-label="닉네임 직접 입력"
						autoFocus
					/>
					<button type="button" className="primary small" disabled={saving || !typed.trim() || !!typedProblem} onClick={submitTyped}>
						{firstLogin ? '이 이름으로 시작하기' : '이 이름으로 바꾸기'}
					</button>
				</div>
			)}
			{typing && typedProblem && <p className="error small">{typedProblem}</p>}
			<div className="nickname-picker__actions">
				{!typing && (
					<button type="button" className="primary small" disabled={saving || loading || !picked} onClick={() => picked && void save(picked)}>
						{firstLogin ? '이 이름으로 시작하기' : '이 이름으로 바꾸기'}
					</button>
				)}
				<button type="button" className="link-button" disabled={saving || loading} onClick={() => void load()}>
					🔄 다시 추천
				</button>
				<button type="button" className="link-button" disabled={saving} onClick={() => setTyping((t) => !t)}>
					{typing ? '추천에서 고르기' : '✏️ 직접 입력하기'}
				</button>
				{firstLogin && (
					<button type="button" className="link-button" disabled={saving} onClick={() => void skip()}>
						건너뛰기
					</button>
				)}
			</div>
			{error && (
				<p className="error small" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}
