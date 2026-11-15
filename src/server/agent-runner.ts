import { init } from '@flue/runtime';
import { MemoOrganizer, PROGRESS_PART } from '../agents/memo-organizer.ts';
import type { MemoProgressEvent } from '../shared/types.ts';
import type { MemoJob } from '../tools/save-memos.ts';
import { buildDateReference, kstDateTimeLabel } from './time.ts';

export interface RunMemoAgentOptions {
	timeoutMs: number;
	/** Real progress: "analyzing" once the agent accepted the job, then the tool's own steps. */
	onProgress?: (event: MemoProgressEvent) => void;
	/** The person cancelled (or the stream closed): stop the agent's work. */
	signal?: AbortSignal;
}

/** Tokens the model really used for one run (from Flue's response usage). */
export interface TokenUsage {
	input: number;
	output: number;
}

export type RunMemoAgent = (job: MemoJob, options: RunMemoAgentOptions) => Promise<{ usage?: TokenUsage } | void>;

function isSaveProgress(data: unknown): data is { stage: 'found' | 'saving' | 'questions'; count: number } {
	const d = data as { stage?: unknown; count?: unknown } | null;
	return !!d && (d.stage === 'found' || d.stage === 'saving' || d.stage === 'questions') && typeof d.count === 'number';
}

/**
 * Deliver one submission to a fresh MemoOrganizer instance and wait until it
 * settles. The agent is dispatch-only (never mounted over HTTP), so this is
 * the only way in, and it runs after validation and rate limiting.
 */
export const runMemoAgent: RunMemoAgent = async (job, { timeoutMs, onProgress, signal }) => {
	signal?.throwIfAborted();
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
	onProgress?.({ stage: 'analyzing' });
	const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
	try {
		const reply = await handle.read(receipt, {
			signal: AbortSignal.any(signals),
			onEvent: (chunk) => {
				if (chunk.type === 'data-part' && chunk.name === PROGRESS_PART && isSaveProgress(chunk.data)) {
					onProgress?.({ stage: chunk.data.stage, count: chunk.data.count });
				}
			},
		});
		const usage = (reply.metadata as { usage?: Partial<TokenUsage> } | undefined)?.usage;
		return usage && Number.isFinite(usage.input) && Number.isFinite(usage.output) ? { usage: { input: usage.input!, output: usage.output! } } : {};
	} catch (error) {
		if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
			await handle.abort().catch(() => {});
		}
		throw error;
	}
};

export type CancelMemoAgent = (requestId: string) => Promise<boolean>;

/**
 * Durably stop the agent working on one request (the person pressed "취소").
 * Closing the stream alone is not enough: a dropped connection is not always
 * passed through to the Worker, and the agent would then finish and save.
 */
export const cancelMemoAgent: CancelMemoAgent = async (requestId) => {
	try {
		await init(MemoOrganizer, { id: `req-${requestId}` }).abort();
		return true;
	} catch {
		return false; // no such run (never started or already gone)
	}
};
