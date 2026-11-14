import type {
	AgendaResponse,
	ApiError,
	CompleteRequest,
	CreateMemosRequest,
	CreateMemosResponse,
	ListMemosResponse,
	Memo,
	MemoCategory,
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
