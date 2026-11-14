// Speech-to-text with Workers AI Whisper. The audio is sent to the model and
// discarded; nothing is stored. Free plan: ~47 Neurons per audio minute.

export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
// The page records at 32 kbps, so 60 s ≈ 240 KB. A tighter byte cap also bounds
// how much audio a hand-crafted low-bitrate upload can carry (≈ 10 min at 8 kbps).
export const AUDIO_MAX_BYTES = 600 * 1024;
/** Longest accepted recording, by the model-reported duration (UI stops at 60 s). */
export const AUDIO_MAX_SECONDS = 65;
export const AUDIO_MIN_BYTES = 1024; // shorter than this is an empty recording

/** Base64 in chunks (String.fromCharCode on a huge array overflows the stack). */
export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

export interface Transcript {
	text: string;
	/** Audio length reported by the model (what Workers AI bills for); null if absent. */
	seconds: number | null;
}

export type Transcriber = (ai: Ai, audio: Uint8Array, contentType: string) => Promise<Transcript>;

export const whisperTranscriber: Transcriber = async (ai, audio) => {
	const result = (await ai.run(WHISPER_MODEL, {
		audio: toBase64(audio),
		task: 'transcribe',
		language: 'ko',
		vad_filter: true, // skip silence; fewer hallucinated words on quiet audio
		condition_on_previous_text: false,
	})) as { text?: string; transcription_info?: { duration?: number } };
	const seconds = result.transcription_info?.duration;
	return { text: (result.text ?? '').trim(), seconds: typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null };
};

/** Billable seconds: the model's duration, else an estimate from size at 32 kbps (4 KB/s). */
export function billableSeconds(transcript: Transcript, bytes: number): number {
	return Math.max(1, Math.ceil(transcript.seconds ?? bytes / 4000));
}

// Whisper's well-known outputs for silence/noise (subtitle credits etc.).
// A transcript that is *only* one of these is treated as "nothing heard".
const SILENCE_HALLUCINATIONS = [
	'감사합니다',
	'고맙습니다',
	'시청해주셔서감사합니다',
	'시청해주셔서고맙습니다',
	'구독과좋아요부탁드립니다',
	'구독과좋아요알림설정부탁드립니다',
	'다음영상에서만나요',
	'mbc뉴스이덕영입니다',
	'thankyou',
	'thanksforwatching',
	'you',
];

export function isLikelySilence(text: string): boolean {
	const normalized = text.toLowerCase().replace(/[\s.,!?~…"'·-]/g, '');
	return normalized === '' || SILENCE_HALLUCINATIONS.includes(normalized);
}
