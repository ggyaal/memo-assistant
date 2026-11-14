// Speech-to-text with Workers AI Whisper. The audio is sent to the model and
// discarded; nothing is stored. Free plan: ~47 Neurons per audio minute.

export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const AUDIO_MAX_BYTES = 2 * 1024 * 1024; // ≈ 60 s of Opus/AAC with headroom
export const AUDIO_MIN_BYTES = 1024; // shorter than this is an empty recording

/** Base64 in chunks (String.fromCharCode on a huge array overflows the stack). */
export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

export type Transcriber = (ai: Ai, audio: Uint8Array, contentType: string) => Promise<string>;

export const whisperTranscriber: Transcriber = async (ai, audio) => {
	const result = (await ai.run(WHISPER_MODEL, {
		audio: toBase64(audio),
		task: 'transcribe',
		language: 'ko',
		vad_filter: true, // skip silence; fewer hallucinated words on quiet audio
		condition_on_previous_text: false,
	})) as { text?: string };
	return (result.text ?? '').trim();
};

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
