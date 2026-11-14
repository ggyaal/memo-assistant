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
