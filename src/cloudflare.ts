// Worker-level Cloudflare code; HTTP routing stays in src/app.ts.
// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint
import { CRON_LOOKAHEAD_MS, runDueReminders } from './server/notify/reminders.ts';

export default {
	/**
	 * Cron (every minute, wrangler.jsonc → triggers.crons): deliver due reminders.
	 * Work is I/O (D1 + Discord API + e-mail API); at most 10 reminders per run keeps CPU tiny.
	 */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			runDueReminders(env as Env & { DISCORD_BOT_TOKEN?: string; EMAIL_API_KEY?: string; EMAIL_FROM?: string }, new Date(controller.scheduledTime), (input, init) => fetch(input, init), 10, {
				// Also take reminders due before the next run and send each exactly on time.
				lookaheadMs: CRON_LOOKAHEAD_MS,
				clock: () => new Date(),
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			}).then(
				(summary) => {
					if (summary.sent || summary.failed || summary.retried || summary.canceled) console.log('reminders', JSON.stringify(summary));
				},
			),
		);
	},
};
