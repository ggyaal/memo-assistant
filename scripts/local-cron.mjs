// Local stand-in for Cloudflare Cron Triggers: `vite dev` does not run crons by
// itself, so this calls the dev server's scheduled handler once a minute
// (production runs "* * * * *" from wrangler.jsonc automatically).
// Usage: npm run dev (in one terminal), npm run dev:cron (in another).
const base = process.env.DEV_URL ?? 'http://localhost:5173';
const url = `${base}/cdn-cgi/local/explorer/api/local/scheduled?worker=memo-assistant`;

async function tick() {
	const at = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' });
	try {
		const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cron: '* * * * *' }) });
		console.log(`[local-cron ${at}] ${res.status}`);
	} catch (error) {
		console.log(`[local-cron ${at}] dev server not reachable: ${String(error).slice(0, 80)}`);
	}
}

console.log(`[local-cron] calling ${url} every minute (Ctrl+C to stop)`);
await tick();
// Align to the start of each minute (+2 s), like a real cron.
setTimeout(() => {
	void tick();
	setInterval(() => void tick(), 60_000);
}, 62_000 - (Date.now() % 60_000));
