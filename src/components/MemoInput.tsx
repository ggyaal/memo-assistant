import { type FormEvent, useRef, useState } from 'react';
import { ApiRequestError, createMemos } from '../client/api.ts';
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
	const sensitive = detectSensitive(text);
	const [voiceBusy, setVoiceBusy] = useState(false);
	const textarea = useRef<HTMLTextAreaElement>(null);
	// Reused only when retrying the same text, so the server can de-duplicate.
	const pendingRequest = useRef<{ text: string; requestId: string } | null>(null);

	async function submit(event?: FormEvent) {
		event?.preventDefault();
		const trimmed = text.trim();
		if (!trimmed || pending || voiceBusy || sensitive.length > 0) return;
		if (pendingRequest.current?.text !== trimmed) {
			pendingRequest.current = { text: trimmed, requestId: crypto.randomUUID() };
		}
		setPending(true);
		setError(null);
		try {
			const result = await createMemos({ nickname, text: trimmed, requestId: pendingRequest.current.requestId });
			pendingRequest.current = null;
			setText('');
			onCreated(result);
		} catch (err) {
			const apiError = err instanceof ApiRequestError ? err : null;
			const retryable = !apiError || ['network_error', 'agent_timeout'].includes(apiError.code);
			if (!retryable) pendingRequest.current = null;
			setError({ message: apiError?.message ?? '알 수 없는 오류가 발생했습니다.', retryable });
		} finally {
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
				onChange={(e) => setText(e.target.value)}
				maxLength={LIMITS.textMax}
				rows={5}
				placeholder={`예) ${EXAMPLE}`}
				disabled={pending}
			/>
			<div className="row space-between">
				<span className="muted small">
					{text.length}/{LIMITS.textMax}자 · 개인정보 입력 금지
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
			<button type="submit" className="primary" disabled={pending || voiceBusy || !text.trim() || sensitive.length > 0}>
				{pending ? 'AI가 정리하는 중… (최대 1분)' : 'AI로 정리하기'}
			</button>
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
