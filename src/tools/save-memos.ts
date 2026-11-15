import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { buildQuestions } from '../shared/clarify.ts';
import { saveSourceWithMemos } from '../server/db.ts';
import { saveDraft } from '../server/drafts.ts';
import { sanitizeMemo, SaveMemosInputSchema } from '../server/validation.ts';

/**
 * Trusted, server-assigned facts about one submission. They reach the tool
 * through the agent's initialData — never through model-chosen arguments.
 */
export const MemoJobSchema = v.object({
	sourceId: v.pipe(v.string(), v.uuid()),
	/** Decided from the caller's session (guest → shared space). */
	workspaceId: v.pipe(v.string(), v.minLength(1)),
	requestId: v.pipe(v.string(), v.uuid()),
	nickname: v.string(),
	rawText: v.string(),
	createdAt: v.pipe(v.string(), v.isoTimestamp()),
	/** SHA-256 of the browser's author key (public board "delete my memo"); set by the server. */
	authorKeyHash: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)))),
});

export type MemoJob = v.InferOutput<typeof MemoJobSchema>;

/**
 * `save_memos`: the boundary between the model and D1. The model supplies only
 * the organized memo fields; the server sanitizes them and stores the original
 * input plus every memo in one atomic batch.
 */
export interface SaveProgress {
	stage: 'found' | 'saving' | 'questions';
	count: number;
}

export function createSaveMemosTool(deps: {
	db: D1Database;
	job: MemoJob;
	/** Live progress for the person waiting (Flue data part); never seen by the model. */
	onProgress?: (progress: SaveProgress) => void;
}) {
	const { db, job, onProgress } = deps;
	return defineTool({
		name: 'save_memos',
		description:
			'Save every memo extracted from the user input in ONE call. Pass all memos together as an array. ' +
			'The original input, author and timestamps are attached by the server automatically. ' +
			'Returns the number of memos saved.',
		input: SaveMemosInputSchema,
		async run({ data }) {
			const now = new Date(job.createdAt);
			const singleMemo = data.memos.length === 1;
			const memos = data.memos.map((memo) => sanitizeMemo(memo, job.rawText, now, { singleMemo }));
			onProgress?.({ stage: 'found', count: memos.length });
			// Unclear date / time / repeat: keep a draft and ask the person first (rules, no AI).
			// Everything clear: saved right away, exactly as before.
			const questions = buildQuestions(memos, now);
			if (questions.length > 0) {
				await saveDraft(db, job, memos, questions, now); // request time (server clock), so expiry matches the server
				onProgress?.({ stage: 'questions', count: questions.length });
				return { output: { saved: 0, note: 'Kept as a draft; the user will confirm a few details. Do not call again.' }, terminate: true };
			}
			onProgress?.({ stage: 'saving', count: memos.length });
			const result = await saveSourceWithMemos(
				db,
				{
					id: job.sourceId,
					workspace_id: job.workspaceId,
					nickname: job.nickname,
					raw_text: job.rawText,
					request_id: job.requestId,
					created_at: job.createdAt,
					author_key_hash: job.authorKeyHash ?? null,
				},
				memos,
			);
			if (result.status === 'duplicate') {
				return { output: { saved: 0, note: 'Already saved for this request. Do not call again.' }, terminate: true };
			}
			return { output: { saved: memos.length }, terminate: true };
		},
	});
}
