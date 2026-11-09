import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

/** Split a migration file into statements (no semicolons inside our SQL literals). */
function statements(sql: string): string[] {
	return sql
		.split('\n')
		.filter((line) => !line.trim().startsWith('--'))
		.join('\n')
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * A fresh, in-memory local D1 database (workerd via Miniflare) with every
 * migration in /migrations applied — the same SQL `wrangler d1 migrations apply` runs.
 */
export async function createTestD1(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
	// Miniflare 5 (bundled with wrangler 4.158) ships a converter for the classic options shape.
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			name: 'memo-test',
			compatibilityDate: '2026-06-01',
			modules: true,
			script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
			d1Databases: { DB: 'test-db' },
		}),
	);
	const db = (await mf.getD1Database('DB')) as unknown as D1Database;
	const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
	for (const file of files) {
		const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
		await db.batch(statements(sql).map((s) => db.prepare(s)));
	}
	return { db, dispose: () => mf.dispose() };
}
