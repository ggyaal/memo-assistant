// Stand-in for the `cloudflare:workers` module under Vitest (Node).
// Tests assign `env.DB` to a Miniflare-backed D1 database before running agents.
export const env: { DB?: D1Database; MEMO_MODEL?: string; AI?: unknown } = {};
