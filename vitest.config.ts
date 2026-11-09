import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			// Agent modules import `env` from the Workers runtime; tests supply a stub
			// whose DB is a real local D1 database run by Miniflare.
			'cloudflare:workers': fileURLToPath(new URL('./tests/helpers/cloudflare-workers-stub.ts', import.meta.url)),
		},
	},
	test: {
		include: ['tests/**/*.test.ts'],
		// The built-Worker smoke test needs `npm run build`; run it with `npm run test:worker`.
		exclude: process.env.WORKER_SMOKE ? [] : ['tests/worker/**'],
		environment: 'node',
		testTimeout: 30_000,
		hookTimeout: 60_000,
	},
});
