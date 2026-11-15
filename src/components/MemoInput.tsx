import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useSpace } from '../client/space.ts';
import { ApiRequestError, cancelMemoRequest, createMemosWithProgress, fetchDraft } from '../client/api.ts';
import { ClarifyCard } from './ClarifyCard.tsx';
import { OrganizeProgress, type OrganizeStage } from './OrganizeProgress.tsx';
import { describeSensitive, detectSensitive } from '../shared/privacy.ts';
import { VoiceRecorder } from './VoiceRecorder.tsx';
import { LIMITS, type CreateMemosResponse, type MemoDraftPayload } from '../shared/types.ts';

const EXAMPLE = '오늘 장 보고, 내일 오후 3시에 병원 예약해야 해. AI 검색 기능 아이디어도 메모해 줘.';

const AUTO_SEND_KEY = 'memo-assistant:voice-auto-send';
const DRAFT_KEY = 'memo-assistant:open-draft';

/** One-line progress for the folded card (same server-reported steps as the full list). */
const QUIET_STATUS: Record<OrganizeStage, (count: number | null) => string> = {
	checking: () => '입력 내용을 확인하고 있어요…',
	analyzing: () => 'AI가 메모를 분석하고 있어요…',
	found: (n) => `메모 ${n ?? ''}개를 발견했어요…`,
	saving: () => '정리된 메모를 저장하고 있어요…',
	questions: () => '확인할 내용이 있어요.',
	done: (n) => `✓ 메모 ${n ?? 0}개를 정리했어요.`,
};

/** Playful labels for the voice button while the card is folded; one is picked per visit. */
export const VOICE_PROMPTS = [
	'주저리.. 주저리..',
	'그 뭐더라...',
	'아 맞다! 그거...',
	'음... 오늘 할 일이...',
	'까먹기 전에 한마디!',
	'중얼중얼...',
	'잠깐, 이것도 적어 줘',
	'생각나는 대로 말해 보세요',
] as const;

export function MemoInput({
	nickname,
	onCreated,
	onSettled,
}: {
	nickname: string;
	onCreated: (result: CreateMemosResponse) => void;
	/** Called after every attempt (success or error), e.g. to refresh usage numbers. */
	onSettled?: () => void;
}) {
	const [text, setText] = useState('');
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
	const { shared } = useSpace();
	// Only the public guest board blocks contact details; a personal space is private.
	const sensitive = shared ? detectSensitive(text) : [];
	const [voiceBusy, setVoiceBusy] = useState(false);
	const textarea = useRef<HTMLTextAreaElement>(null);
	// Reused only when retrying the same text, so the server can de-duplicate.
	const pendingRequest = useRef<{ text: string; requestId: string } | null>(null);
	// Live steps reported by the server (null = nothing to show).
	// "바로 보내기": recognized speech goes straight to "AI로 정리하기" (on by default — user decision; turning it off is remembered).
	const [autoSend, setAutoSend] = useState(() => {
		try {
			return localStorage.getItem(AUTO_SEND_KEY) !== '0';
		} catch {
			return true;
		}
	});
	function chooseAutoSend(on: boolean) {
		setAutoSend(on);
		try {
			localStorage.setItem(AUTO_SEND_KEY, on ? '1' : '0');
		} catch {
			// convenience only
		}
	}
	// Folded by default: only the voice button shows. Typed text, a run or an error keep it open.
	const [expanded, setExpanded] = useState(false);
	const [voicePrompt] = useState(() => VOICE_PROMPTS[Math.floor(Math.random() * VOICE_PROMPTS.length)]);
	// Focus the text box once it exists after the person opened the card (or voice text arrived).
	const focusWhenOpen = useRef(false);
	const [progress, setProgress] = useState<{ stage: OrganizeStage; count: number | null; failed: boolean } | null>(null);
	const inFlight = useRef<AbortController | null>(null);

	// Leaving the page/space closes the stream, which stops the AI work on the server.
	useEffect(() => () => inFlight.current?.abort(), []);

	const [cancelling, setCancelling] = useState(false);
	async function cancel() {
		const controller = inFlight.current;
		const requestId = pendingRequest.current?.requestId;
		if (!controller || cancelling) return;
		setCancelling(true);
		// Stop the agent on the server first (a closed connection alone may not reach it), then close the stream.
		if (requestId) await cancelMemoRequest(requestId).catch(() => null);
		controller.abort();
		setCancelling(false);
	}

	/** `spoken`: text just recognized from voice with "바로 보내기" on (sent without the review step). */
	async function submit(event?: FormEvent, spoken?: string) {
		event?.preventDefault();
		const trimmed = (spoken ?? text).trim();
		// Same public-board check as typing: never sent with personal data (the warning shows instead).
		const blocked = shared ? detectSensitive(trimmed) : [];
		// inFlight blocks a second click even before React re-renders the disabled button.
		if (!trimmed || pending || inFlight.current || (voiceBusy && spoken === undefined) || blocked.length > 0) return;
		if (pendingRequest.current?.text !== trimmed) {
			pendingRequest.current = { text: trimmed, requestId: crypto.randomUUID() };
		}
		const controller = new AbortController();
		inFlight.current = controller;
		setPending(true);
		setError(null);
		setNotice(null);
		setProgress(null);
		try {
			const result = await createMemosWithProgress(
				{ nickname, text: trimmed, requestId: pendingRequest.current.requestId },
				{
					signal: controller.signal,
					onProgress: (event) =>
						setProgress((p) => ({ stage: event.stage, count: event.count ?? p?.count ?? null, failed: false })),
				},
			);
			if ('draft' in result) {
				// Some details need an answer: nothing is saved yet. Keep the text; show the questions (card opens).
				setQuiet(false);
				setProgress(null);
				setDraft(result.draft);
				return;
			}
			pendingRequest.current = null;
			setText('');
			setProgress({ stage: 'done', count: result.memos.length, failed: false });
			onCreated(result);
		} catch (err) {
			const apiError = err instanceof ApiRequestError ? err : null;
			// Cancelled or cut off: the same request id lets a retry pick up a result that was saved meanwhile.
			const retryable = !apiError || ['network_error', 'agent_timeout', 'cancelled'].includes(apiError.code);
			if (!retryable) pendingRequest.current = null;
			setProgress((p) => (p ? { ...p, failed: true } : p));
			setError({ message: apiError?.message ?? '알 수 없는 오류가 발생했습니다.', retryable });
		} finally {
			inFlight.current = null;
			setPending(false);
			onSettled?.();
		}
	}

	// Clarifying questions: an organized input waiting for answers (not saved yet).
	const [draft, setDraft] = useState<MemoDraftPayload | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	// Remember the open draft for this tab, so a refresh can continue it.
	useEffect(() => {
		try {
			if (draft) sessionStorage.setItem(DRAFT_KEY, draft.id);
			else sessionStorage.removeItem(DRAFT_KEY);
		} catch {
			// convenience only
		}
	}, [draft]);
	useEffect(() => {
		let id: string | null = null;
		try {
			id = sessionStorage.getItem(DRAFT_KEY);
		} catch {
			return;
		}
		if (!id) return;
		fetchDraft(id)
			.then(({ draft: d }) => {
				setDraft(d);
				setText(d.rawText);
				setExpanded(true);
			})
			.catch(() => {
				try {
					sessionStorage.removeItem(DRAFT_KEY);
				} catch {
					// ignore
				}
			});
	}, []);

	// "바로 보내기" from the folded card: stay folded and show a one-line status instead (user request).
	// An error (or text blocked on the public board) still opens it so the text is not lost.
	const [quiet, setQuiet] = useState(false);
	const open = expanded || !!error || !!draft || (!quiet && (pending || !!text.trim() || !!progress));
	useEffect(() => {
		if (open && focusWhenOpen.current) {
			focusWhenOpen.current = false;
			textarea.current?.focus();
		}
	}, [open, text]);

	const voice = (
		<div className="voice-row">
			<VoiceRecorder
				disabled={pending}
				idleLabel={open ? '음성으로 입력' : voicePrompt}
				doneMessage={autoSend ? (open ? '음성을 글로 바꿨어요. 바로 AI로 정리할게요.' : null) : undefined}
				onBusyChange={setVoiceBusy}
				onTranscript={(spoken) => {
					// Append to whatever is already typed; open the card (to review, or to show the progress).
					const next = (text.trim() ? `${text.trim()} ${spoken}` : spoken).slice(0, LIMITS.textMax);
					setText(next);
					const blocked = shared && detectSensitive(next).length > 0;
					if (autoSend && !blocked) {
						// Sent right away: a folded card stays folded; an open one keeps showing the steps.
						setQuiet(!open);
						void submit(undefined, next);
					} else {
						setQuiet(false);
						setExpanded(true);
						focusWhenOpen.current = true;
					}
				}}
			/>
			<label className="voice-autosend small" title={shared ? '검토 없이 바로 공개 공간에 정리돼요' : '검토 없이 바로 정리해요'}>
				<input type="checkbox" checked={autoSend} disabled={pending} onChange={(e) => chooseAutoSend(e.target.checked)} />
				바로 보내기
			</label>
		</div>
	);

	if (!open) {
		return (
			<section className="card memo-input memo-input--folded" aria-label="메모 입력">
				<div className="memo-input__folded">
					{voice}
					<button
						type="button"
						className="link-button small memo-input__toggle"
						aria-expanded={false}
						onClick={() => {
							focusWhenOpen.current = true;
							setQuiet(false);
							setProgress(null);
							setExpanded(true);
						}}
					>
						⌨️ 글로 쓰기 ▾
					</button>
				</div>
				{quiet && progress && (
					<p className={`memo-input__status small${progress.stage === 'done' ? ' is-done' : ''}`} role="status" aria-live="polite">
						{progress.stage !== 'done' && <span className="memo-input__spinner" aria-hidden="true" />}
						{QUIET_STATUS[progress.stage](progress.count)}
						{pending && progress.stage === 'analyzing' && !cancelling && (
							<button type="button" className="link-button small" onClick={() => void cancel()}>
								취소
							</button>
						)}
					</p>
				)}
			</section>
		);
	}

	return (
		<form id="memo-input-form" className="card memo-input" onSubmit={submit}>
			<div className="row space-between">
				<label htmlFor="memo-text" className="label">
					여러 생각을 한 번에 적어 보세요
				</label>
				<button
					type="button"
					className="link-button small memo-input__toggle"
					aria-expanded={true}
					disabled={pending || !!text.trim()}
					title={text.trim() ? '입력한 글이 있으면 접을 수 없어요' : undefined}
					onClick={() => {
						setExpanded(false);
						setError(null);
						setProgress(null);
					}}
				>
					접기 ▴
				</button>
			</div>
			{voice}
			<textarea
				ref={textarea}
				id="memo-text"
				value={text}
				onChange={(e) => {
					setText(e.target.value);
					// A finished/failed run's steps stay until the person starts editing again.
					if (!pending) setProgress(null);
				}}
				maxLength={LIMITS.textMax}
				rows={5}
				placeholder={`예) ${EXAMPLE}`}
				disabled={pending}
			/>
			<div className="row space-between">
				<span className="muted small">
					{text.length}/{LIMITS.textMax}자 · {shared ? '개인정보 입력 금지(공개됨)' : '나만 보는 공간'}
				</span>
				<button type="button" className="link-button small" onClick={() => setText(EXAMPLE)} disabled={pending}>
					예시 넣기
				</button>
			</div>
			{sensitive.length > 0 && (
				<p className="warning" role="alert">
					⚠️ {describeSensitive(sensitive)}로 보이는 내용이 있어요. 모든 방문자에게 공개되므로 지우고 다시 적어 주세요.
				</p>
			)}
			<button type="submit" className="primary" disabled={pending || voiceBusy || !text.trim() || sensitive.length > 0 || !!draft} aria-busy={pending}>
				{pending ? 'AI가 정리하는 중… (긴 글은 최대 2분)' : 'AI로 정리하기'}
			</button>
			{draft && (
				<ClarifyCard
					key={draft.id}
					draft={draft}
					onSaved={(result) => {
						setDraft(null);
						pendingRequest.current = null;
						setText('');
						setProgress({ stage: 'done', count: result.memos.length, failed: false });
						onCreated(result);
						onSettled?.();
					}}
					onDiscarded={() => {
						// Nothing saved; the text stays so it can be edited and sent again (as a new request).
						setDraft(null);
						pendingRequest.current = null;
						setNotice('저장하지 않았어요. 입력한 글은 그대로 남아 있어요.');
					}}
					onExpired={(message) => {
						setDraft(null);
						pendingRequest.current = null;
						setNotice(message);
					}}
				/>
			)}
			{notice && !draft && (
				<p className="muted small" role="status">
					{notice}
				</p>
			)}
			{progress && (
				<OrganizeProgress
					stage={progress.stage}
					count={progress.count}
					failed={progress.failed}
					// Cancelling stops the AI only until saving starts; after that the result is kept.
					// Only while the AI is working (the run exists and has not started saving).
					onCancel={pending && !cancelling && progress.stage === 'analyzing' ? () => void cancel() : undefined}
				/>
			)}
			{error && (
				<p className="error" role="alert">
					{error.message}
					{error.retryable && (
						<button type="button" className="link-button" onClick={() => submit()}>
							다시 시도
						</button>
					)}
				</p>
			)}
		</form>
	);
}
