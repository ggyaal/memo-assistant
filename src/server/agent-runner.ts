import { init } from '@flue/runtime';
import { MemoOrganizer } from '../agents/memo-organizer.ts';
import type { MemoJob } from '../tools/save-memos.ts';
import { buildDateReference, kstDateTimeLabel } from './time.ts';

export type RunMemoAgent = (job: MemoJob, options: { timeoutMs: number }) => Promise<void>;

/**
 * Deliver one submission to a fresh MemoOrganizer instance and wait until it
 * settles. The agent is dispatch-only (never mounted over HTTP), so this is
 * the only way in, and it runs after validation and rate limiting.
 */
export const runMemoAgent: RunMemoAgent = async (job, { timeoutMs }) => {
	const now = new Date(job.createdAt);
	const handle = init(MemoOrganizer, { id: `req-${job.requestId}` });
	const receipt = await handle.dispatch({
		initialData: job,
		message: {
			kind: 'signal',
			type: 'memo.submitted',
			body: job.rawText,
			attributes: {
				timezone: 'Asia/Seoul',
				now_kst: kstDateTimeLabel(now),
				date_reference: buildDateReference(now),
			},
		},
	});
	try {
		await handle.read(receipt, { signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
			await handle.abort().catch(() => {});
		}
		throw error;
	}
};
