// Discord DM through the bot's REST API (no Gateway connection needed).
// Docs: POST /users/@me/channels (open DM), POST /channels/{id}/messages.

const API = 'https://discord.com/api/v10';

export type DmResult =
	| { ok: true }
	| { ok: false; retryable: boolean; code: string; message: string; retryAfterSeconds?: number };

/** User-facing explanations (Korean); `code` is stored for diagnosis. */
const CANNOT_DM =
	'Discord가 DM을 거부했어요. 알림 봇이 있는 서버에 참여해 있는지, Discord 개인정보 설정에서 서버 멤버의 DM을 허용했는지 확인해 주세요.';

async function call(fetchFn: typeof fetch, token: string, path: string, body: unknown): Promise<Response> {
	return fetchFn(`${API}${path}`, {
		method: 'POST',
		headers: { Authorization: `Bot ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function failure(res: Response): Promise<DmResult> {
	let code = '';
	let retryAfter: number | undefined;
	try {
		const body = (await res.json()) as { code?: number; retry_after?: number };
		code = body.code ? String(body.code) : '';
		retryAfter = typeof body.retry_after === 'number' ? Math.ceil(body.retry_after) : undefined;
	} catch {
		// non-JSON error body
	}
	if (res.status === 429) {
		return { ok: false, retryable: true, code: 'rate_limited', message: 'Discord 전송 한도에 걸려 잠시 뒤 다시 보낼게요.', retryAfterSeconds: retryAfter };
	}
	if (code === '50007' || res.status === 403) {
		return { ok: false, retryable: false, code: code || '403', message: CANNOT_DM };
	}
	if (res.status === 401) {
		return { ok: false, retryable: false, code: 'bot_unauthorized', message: '알림 봇 설정에 문제가 있어요(토큰 확인 필요).' };
	}
	if (res.status >= 500) {
		return { ok: false, retryable: true, code: `http_${res.status}`, message: 'Discord 서버 오류로 잠시 뒤 다시 보낼게요.' };
	}
	return { ok: false, retryable: false, code: code || `http_${res.status}`, message: 'Discord로 보내지 못했어요.' };
}

/** Send one DM to a Discord user id. Mentions are disabled (content may include memo text). */
export async function sendDiscordDm(token: string, recipientId: string, content: string, fetchFn: typeof fetch): Promise<DmResult> {
	try {
		const open = await call(fetchFn, token, '/users/@me/channels', { recipient_id: recipientId });
		if (!open.ok) return failure(open);
		const channel = (await open.json()) as { id?: string };
		if (!channel.id) return { ok: false, retryable: true, code: 'no_channel', message: 'Discord DM 채널을 열지 못했어요.' };
		const sent = await call(fetchFn, token, `/channels/${channel.id}/messages`, {
			content: content.slice(0, 2000),
			allowed_mentions: { parse: [] },
		});
		return sent.ok ? { ok: true } : failure(sent);
	} catch (error) {
		return { ok: false, retryable: true, code: 'network', message: `Discord에 연결하지 못했어요: ${String(error).slice(0, 80)}` };
	}
}
