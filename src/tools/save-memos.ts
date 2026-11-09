import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { saveSourceWithMemos } from '../server/db.ts';
import { sanitizeMemo, SaveMemosInputSchema } from '../server/validation.ts';

/**
 * Trusted, server-assigned facts about one submission. They reach the tool
 * through the agent's initialData — never through model-chosen arguments.
 */
export const MemoJobSchema = v.object({
	sourceId: v.pipe(v.string(), v.uuid()),
	requestId: v.pipe(v.string(), v.uuid()),
	nickname: v.string(),
	rawText: v.string(),
	createdAt: v.pipe(v.string(), v.isoTimestamp()),
});

export type MemoJob = v.InferOutput<typeof MemoJobSchema>;

/**
 * `save_memos`: the boundary between the model and D1. The model supplies only
 * the organized memo fields; the server sanitizes them and stores the original
 * input plus every memo in one atomic batch.
 */
export function createSaveMemosTool(deps: { db: D1Database; job: MemoJob }) {
	const { db, job } = deps;
	return defineTool({
		name: 'save_memos',
		description:
			'Save every memo extracted from the user input in ONE call. Pass all memos together as an array. ' +
			'The original input, author and timestamps are attached by the server automatically. ' +
			'Returns the number of memos saved.',
		input: SaveMemosInputSchema,
		async run({ data }) {
			const now = new Date(job.createdAt);
			const memos = data.memos.map((memo) => sanitizeMemo(memo, job.rawText, now));
			const result = await saveSourceWithMemos(
				db,
				{
					id: job.sourceId,
					nickname: job.nickname,
					raw_text: job.rawText,
					request_id: job.requestId,
					created_at: job.createdAt,
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
