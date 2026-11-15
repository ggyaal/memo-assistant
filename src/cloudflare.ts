// Worker-level Cloudflare code; HTTP routing stays in src/app.ts.
// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint
import { runDueReminders } from './server/notify/reminders.ts';

export default {
	/**
	 * Cron (every minute, wrangler.jsonc → triggers.crons): deliver due reminders.
	 * Work is I/O (D1 + Discord API); at most 10 reminders per run keeps CPU tiny.
	 */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			runDueReminders(env as Env & { DISCORD_BOT_TOKEN?: string }, new Date(controller.scheduledTime), (input, init) => fetch(input, init)).then(
				(summary) => {
					if (summary.sent || summary.failed || summary.retried || summary.canceled) console.log('reminders', JSON.stringify(summary));
				},
			),
		);
	},
};
