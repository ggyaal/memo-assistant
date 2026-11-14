import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, transcribeAudio } from '../client/api.ts';

const MAX_SECONDS = 60;
const MIN_BYTES = 1024;
const INTRO_KEY = 'memo-assistant:voice-intro-ok';

type Phase = 'idle' | 'intro' | 'starting' | 'recording' | 'transcribing';

function supported(): boolean {
	return (
		typeof window !== 'undefined' &&
		window.isSecureContext &&
		typeof window.MediaRecorder !== 'undefined' &&
		!!navigator.mediaDevices?.getUserMedia
	);
}

function pickMimeType(): string | undefined {
	for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
		if (MediaRecorder.isTypeSupported(type)) return type;
	}
	return undefined; // browser default
}

function micErrorMessage(error: unknown): string {
	const name = error instanceof DOMException ? error.name : '';
	if (name === 'NotAllowedError' || name === 'SecurityError') {
		return '마이크 권한이 거부됐어요. 주소창의 사이트 권한에서 마이크를 허용하거나, 텍스트로 입력해 주세요.';
	}
	if (name === 'NotFoundError' || name === 'OverconstrainedError') return '사용할 수 있는 마이크를 찾지 못했어요.';
	if (name === 'NotReadableError') return '다른 앱이 마이크를 사용 중이에요. 그 앱을 닫고 다시 시도해 주세요.';
	return '녹음을 시작하지 못했어요. 텍스트로 입력해 주세요.';
}

function readIntroOk(): boolean {
	try {
		return localStorage.getItem(INTRO_KEY) === '1';
	} catch {
		return false;
	}
}

/**
 * One button: press to start recording, press again to stop (auto-stops at 60 s).
 * The recording is converted to text by Workers AI Whisper and handed to the
 * input box for review — nothing is published until the user submits.
 */
export function VoiceRecorder({
	onTranscript,
	onBusyChange,
	disabled,
}: {
	onTranscript: (text: string) => void;
	onBusyChange: (busy: boolean) => void;
	disabled?: boolean;
}) {
	const [phase, setPhase] = useState<Phase>('idle');
	const [seconds, setSeconds] = useState(0);
	const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
	const recorder = useRef<MediaRecorder | null>(null);
	const stream = useRef<MediaStream | null>(null);
	const chunks = useRef<Blob[]>([]);
	const timer = useRef<number | null>(null);
	const watchdog = useRef<number | null>(null);
	const finished = useRef(false);
	const canRecord = supported();

	useEffect(() => onBusyChange(phase !== 'idle' && phase !== 'intro'), [phase, onBusyChange]);
	useEffect(() => () => releaseMic(), []);

	function clearTimers() {
		if (timer.current !== null) window.clearInterval(timer.current);
		if (watchdog.current !== null) window.clearTimeout(watchdog.current);
		timer.current = null;
		watchdog.current = null;
	}

	/** Stop the microphone. Called only after the recorder has delivered its data. */
	function releaseMic() {
		clearTimers();
		stream.current?.getTracks().forEach((t) => t.stop());
		stream.current = null;
	}

	async function start() {
		setMessage(null);
		setPhase('starting');
		try {
			stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (error) {
			releaseMic();
			setPhase('idle');
			setMessage({ text: micErrorMessage(error), error: true });
			return;
		}
		try {
			chunks.current = [];
			finished.current = false;
			const mimeType = pickMimeType();
			const rec = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined);
			rec.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
			rec.onstop = () => void finish(rec.mimeType || mimeType || '');
			rec.onerror = () => void finish(rec.mimeType || mimeType || '');
			recorder.current = rec;
			// Deliver data every second, so a lost final chunk/stop event cannot lose the whole recording.
			rec.start(1000);
		} catch {
			releaseMic();
			setPhase('idle');
			setMessage({ text: '이 브라우저에서 녹음을 시작하지 못했어요. 텍스트로 입력해 주세요.', error: true });
			return;
		}
		setSeconds(0);
		setPhase('recording');
		const startedAt = Date.now();
		timer.current = window.setInterval(() => {
			const elapsed = Math.floor((Date.now() - startedAt) / 1000);
			setSeconds(elapsed);
			if (elapsed >= MAX_SECONDS) stop();
		}, 250);
	}

	function stop() {
		// Show progress immediately; the upload starts when the recorder reports "stop".
		setPhase('transcribing');
		if (timer.current !== null) window.clearInterval(timer.current);
		timer.current = null;
		const rec = recorder.current;
		const mimeType = rec?.mimeType ?? '';
		try {
			if (rec && rec.state !== 'inactive') {
				rec.requestData();
				rec.stop();
			} else {
				void finish(mimeType);
				return;
			}
		} catch {
			void finish(mimeType);
			return;
		}
		// Some browsers occasionally never fire "stop"; finish with what we have.
		watchdog.current = window.setTimeout(() => void finish(mimeType), 4000);
	}

	async function finish(mimeType: string) {
		if (finished.current) return;
		finished.current = true;
		releaseMic();
		const audio = new Blob(chunks.current, { type: mimeType || 'audio/webm' });
		chunks.current = [];
		recorder.current = null;
		if (audio.size < MIN_BYTES) {
			setPhase('idle');
			setMessage({ text: '녹음된 소리가 거의 없어요. 마이크가 켜져 있는지 확인하고, 버튼을 누른 뒤 말하고 다시 눌러 주세요.', error: true });
			return;
		}
		setPhase('transcribing');
		setMessage({ text: '음성을 글로 바꾸는 중이에요… (몇 초 걸려요)', error: false });
		try {
			const { text } = await transcribeAudio(audio);
			onTranscript(text);
			setMessage({ text: '음성을 글로 바꿨어요. 내용을 확인·수정한 뒤 "AI로 정리하기"를 눌러 주세요.', error: false });
		} catch (error) {
			setMessage({
				text: error instanceof ApiRequestError ? error.message : '음성을 글로 바꾸지 못했어요. 텍스트로 입력해 주세요.',
				error: true,
			});
		} finally {
			setPhase('idle');
		}
	}

	function onClick() {
		if (phase === 'recording') return stop();
		if (phase !== 'idle') return;
		if (!readIntroOk()) return setPhase('intro');
		void start();
	}

	if (!canRecord) {
		return <p className="muted small voice__note">🎙️ 이 브라우저에서는 음성 녹음을 쓸 수 없어요. 텍스트로 입력해 주세요.</p>;
	}

	const label =
		phase === 'recording'
			? `녹음 끝내기 (${seconds}초 / ${MAX_SECONDS}초)`
			: phase === 'starting'
				? '마이크 준비 중…'
				: phase === 'transcribing'
					? '글로 바꾸는 중…'
					: '🎙️ 음성으로 입력';

	return (
		<div className="voice">
			<button
				type="button"
				className={phase === 'recording' ? 'voice__button is-recording' : 'voice__button'}
				onClick={onClick}
				disabled={disabled || phase === 'starting' || phase === 'transcribing'}
				aria-pressed={phase === 'recording'}
			>
				{phase === 'recording' && <span className="voice__dot" aria-hidden="true" />}
				{label}
			</button>
			{phase === 'intro' && (
				<div className="voice__intro" role="dialog" aria-label="음성 입력 안내">
					<p>
						<strong>음성 입력 전에 확인해 주세요</strong>
					</p>
					<ul>
						<li>마이크 권한을 요청합니다. 녹음은 버튼을 다시 누르거나 60초가 지나면 끝납니다.</li>
						<li>녹음은 Cloudflare Workers AI로 글로 바꾸는 데만 쓰고, <strong>음성 파일은 저장하지 않아요</strong>.</li>
						<li>바뀐 글은 입력창에만 들어가요. 확인·수정 후 "AI로 정리하기"를 누를 때 <strong>모두에게 공개</strong>됩니다.</li>
						<li>주변 사람의 목소리나 개인정보가 녹음되지 않게 주의해 주세요.</li>
					</ul>
					<div className="row">
						<button
							type="button"
							className="primary small"
							onClick={() => {
								try {
									localStorage.setItem(INTRO_KEY, '1');
								} catch {
									// convenience only
								}
								void start();
							}}
						>
							확인하고 녹음 시작
						</button>
						<button type="button" className="link-button small" onClick={() => setPhase('idle')}>
							취소
						</button>
					</div>
				</div>
			)}
			{message && (
				<p className={message.error ? 'error small' : 'muted small'} role="status" aria-live="polite">
					{message.text}
				</p>
			)}
		</div>
	);
}
