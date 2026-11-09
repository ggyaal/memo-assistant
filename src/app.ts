import { setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { runMemoAgent } from './server/agent-runner.ts';
import { createApi } from './server/routes.ts';

// Workers AI through the AI binding, without AI Gateway: no extra Cloudflare
// product (or its prompt logging) is involved for this public demo.
setProvider(cloudflareBindingProvider({ binding: env.AI, gateway: false }));

const app = new Hono<{ Bindings: Env }>();

// Only /api/* reaches the Worker (assets.run_worker_first). The MemoOrganizer
// agent is intentionally NOT mounted with createAgentRouter(): it is reached
// only through POST /api/memos, after validation and rate limiting.
app.route('/api', createApi({ runAgent: runMemoAgent }));

export default app;
