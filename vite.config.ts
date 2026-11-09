import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev:offline` sets MEMO_OFFLINE=1: remote bindings (Workers AI) are
// disabled, so the UI, D1 and list API run fully locally and AI calls fail
// gracefully. Needs no workers.dev subdomain and spends no Neurons.
const offline = process.env.MEMO_OFFLINE === '1';

// Order matters: flue() must come before cloudflare().
export default defineConfig({
	plugins: [react(), flue(), cloudflare({ config: flueWorkerConfig(), remoteBindings: !offline })],
});
