import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useSpace } from '../client/space.ts';
import { ApiRequestError, cancelMemoRequest, createMemosWithProgress } from '../client/api.ts';
import { OrganizeProgress, type OrganizeStage } from './OrganizeProgress.tsx';
import { describeSensitive, detectSensitive } from '../shared/privacy.ts';
import { VoiceRecorder } from './VoiceRecorder.tsx';
import { LIMITS, type CreateMemosResponse } from '../shared/types.ts';

const EXAMPLE = '오늘 장 보고, 내일 오후 3시에 병원 예약해야 해. AI 검색 기능 아이디어도 메모해 줘.';

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

	async function submit(event?: FormEvent) {
		event?.preventDefault();
		const trimmed = text.trim();
		// inFlight blocks a second click even before React re-renders the disabled button.
		if (!trimmed || pending || inFlight.current || voiceBusy || sensitive.length > 0) return;
		if (pendingRequest.current?.text !== trimmed) {
			pendingRequest.current = { text: trimmed, requestId: crypto.randomUUID() };
		}
		const controller = new AbortController();
		inFlight.current = controller;
		setPending(true);
		setError(null);
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

	return (
		<form className="card" onSubmit={submit}>
			<label htmlFor="memo-text" className="label">
				여러 생각을 한 번에 적어 보세요
			</label>
			<VoiceRecorder
				disabled={pending}
				onBusyChange={setVoiceBusy}
				onTranscript={(spoken) => {
					// Append to whatever is already typed; the user reviews before submitting.
					setText((current) => (current.trim() ? `${current.trim()} ${spoken}` : spoken).slice(0, LIMITS.textMax));
					textarea.current?.focus();
				}}
			/>
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
			<button type="submit" className="primary" disabled={pending || voiceBusy || !text.trim() || sensitive.length > 0} aria-busy={pending}>
				{pending ? 'AI가 정리하는 중… (긴 글은 최대 2분)' : 'AI로 정리하기'}
			</button>
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
