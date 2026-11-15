import type {
	AgendaResponse,
	ChannelStatus,
	NotificationChannel,
	SettingsResponse,
	ApiError,
	CompleteRequest,
	CreateMemosRequest,
	CreateMemosResponse,
	ListMemosResponse,
	Memo,
	MemoCategory,
	MemoProgressEvent,
	MemoStreamError,
	ReminderRequest,
	ReorderRequest,
	UsageResponse,
} from '../shared/types.ts';

export class ApiRequestError extends Error {
	constructor(
		readonly code: ApiError['error'] | 'network_error',
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, init);
	} catch {
		throw new ApiRequestError('network_error', '서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.', 0);
	}
	const body = (await response.json().catch(() => null)) as T | ApiError | null;
	if (!response.ok) {
		const error = body as ApiError | null;
		throw new ApiRequestError(
			error?.error ?? 'agent_failed',
			error?.message ?? `요청에 실패했습니다. (HTTP ${response.status})`,
			response.status,
		);
	}
	return body as T;
}

export function createMemos(input: CreateMemosRequest): Promise<CreateMemosResponse> {
	return request('/api/memos', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
}

/**
 * Same request as `createMemos`, asking for live progress (Server-Sent Events).
 * `onProgress` is called when the server reports a step it has really reached.
 * Aborting `signal` closes the stream, which stops the AI work on the server.
 * Falls back to the plain JSON answer if the server replies without a stream.
 */
export async function createMemosWithProgress(
	input: CreateMemosRequest,
	options: { onProgress: (event: MemoProgressEvent) => void; signal: AbortSignal },
): Promise<CreateMemosResponse> {
	const cancelled = () => new ApiRequestError('cancelled', '메모 정리를 취소했어요. 입력한 글은 그대로 남아 있어요.', 0);
	let response: Response;
	try {
		response = await fetch('/api/memos', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
			body: JSON.stringify(input),
			signal: options.signal,
		});
	} catch {
		if (options.signal.aborted) throw cancelled();
		throw new ApiRequestError('network_error', '서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.', 0);
	}
	if (!/^text\/event-stream/i.test(response.headers.get('content-type') ?? '') || !response.body) {
		// Refused before streaming (e.g. 403/413/415) or no stream support: same as the JSON call.
		const body = (await response.json().catch(() => null)) as CreateMemosResponse | ApiError | null;
		if (!response.ok) {
			const error = body as ApiError | null;
			throw new ApiRequestError(error?.error ?? 'agent_failed', error?.message ?? `요청에 실패했습니다. (HTTP ${response.status})`, response.status);
		}
		return body as CreateMemosResponse;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
			let end: number;
			while ((end = buffer.indexOf('\n\n')) >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const event = /^event: ?(.*)$/m.exec(frame)?.[1] ?? 'message';
				const data = frame
					.split('\n')
					.filter((line) => line.startsWith('data:'))
					.map((line) => line.replace(/^data: ?/, ''))
					.join('\n');
				if (!data) continue;
				const payload: unknown = JSON.parse(data);
				if (event === 'progress') options.onProgress(payload as MemoProgressEvent);
				else if (event === 'done') return payload as CreateMemosResponse;
				else if (event === 'error') {
					const error = payload as MemoStreamError;
					throw new ApiRequestError(error.error, error.message, error.status);
				}
			}
		}
	} catch (error) {
		if (error instanceof ApiRequestError) throw error;
		if (options.signal.aborted) throw cancelled();
		throw new ApiRequestError('network_error', '연결이 끊겨 결과를 받지 못했어요. 다시 시도하면 이어서 확인해요.', 0);
	} finally {
		reader.releaseLock();
	}
	if (options.signal.aborted) throw cancelled();
	// Stream ended without a result: retrying with the same request id returns it if it was saved.
	throw new ApiRequestError('network_error', '연결이 끊겨 결과를 받지 못했어요. 다시 시도하면 이어서 확인해요.', 0);
}

/** Stop the AI run for one submission (the "취소" button). */
export function cancelMemoRequest(requestId: string): Promise<{ cancelled: boolean; saved: boolean }> {
	return request('/api/memos/cancel', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ requestId }),
	});
}

export function fetchMemos(params: {
	scope: 'today' | 'all';
	cursor?: string | null;
	category?: MemoCategory | '';
}): Promise<ListMemosResponse> {
	const search = new URLSearchParams({ scope: params.scope });
	if (params.cursor) search.set('cursor', params.cursor);
	if (params.category) search.set('category', params.category);
	return request(`/api/memos?${search.toString()}`);
}

export function fetchUsage(): Promise<UsageResponse> {
	return request('/api/usage');
}

export function fetchAgenda(): Promise<AgendaResponse> {
	return request('/api/agenda');
}

export function reorderAgenda(ids: string[]): Promise<{ updated: number }> {
	return request('/api/agenda/order', {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ids } satisfies ReorderRequest),
	});
}

export function setMemoCompleted(id: string, completed: boolean): Promise<{ memo: Memo }> {
	return request(`/api/memos/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ completed } satisfies CompleteRequest),
	});
}

export function deleteMemo(id: string): Promise<{ deleted: string }> {
	return request(`/api/memos/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Speech → text. The audio is not stored; the text comes back for review. */
export function transcribeAudio(audio: Blob): Promise<{ text: string }> {
	return request('/api/transcribe', {
		method: 'POST',
		headers: { 'content-type': audio.type || 'audio/webm' },
		body: audio,
	});
}

export type ProviderId = 'google' | 'discord' | 'kakao';

export interface MeResponse {
	mode: 'guest' | 'user';
	workspace: { id: string; kind: 'shared_guest' | 'personal'; name: string };
	user?: { displayName: string; linked: ProviderId[] };
	providers: Record<ProviderId, { label: string; configured: boolean }>;
}

export function fetchMe(): Promise<MeResponse> {
	return request('/api/me');
}

export function logout(): Promise<{ ok: true }> {
	return request('/api/auth/logout', { method: 'POST' });
}

export function fetchSettings(): Promise<SettingsResponse> {
	return request('/api/settings');
}

export function updateDisplayName(displayName: string): Promise<{ displayName: string }> {
	return request('/api/settings/profile', {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName }),
	});
}

export function setNotificationChannel(channel: NotificationChannel, enabled: boolean): Promise<{ status: ChannelStatus }> {
	return request(`/api/settings/notifications/${channel}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ enabled }),
	});
}

export function scheduleReminder(memoId: string, body: ReminderRequest): Promise<{ scheduledAt: string }> {
	return request(`/api/memos/${encodeURIComponent(memoId)}/reminder`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

export function cancelReminder(memoId: string): Promise<{ canceled: true }> {
	return request(`/api/memos/${encodeURIComponent(memoId)}/reminder`, { method: 'DELETE' });
}

export function updateReminderDefaults(body: { leadMinutes: number; dateOnlyTime: string | null }): Promise<{ scheduled: number }> {
	return request('/api/settings/reminders', {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}
