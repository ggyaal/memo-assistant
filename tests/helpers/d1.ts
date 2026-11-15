import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

/** Split a migration file into statements (no semicolons inside our SQL literals). */
function statements(sql: string): string[] {
	return sql
		.split('\n')
		.map((line) => line.replace(/--.*$/, '')) // our migrations never contain "--" inside strings
		.join('\n')
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * A fresh, in-memory local D1 database (workerd via Miniflare) with every
 * migration in /migrations applied — the same SQL `wrangler d1 migrations apply` runs.
 */
export async function createTestD1(options: { stopBefore?: string } = {}): Promise<{
	db: D1Database;
	dispose: () => Promise<void>;
	/** Apply the remaining migrations (those skipped by `stopBefore`). */
	applyRest: () => Promise<void>;
}> {
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
	const apply = async (list: string[]) => {
		for (const file of list) {
			const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
			await db.batch(statements(sql).map((s) => db.prepare(s)));
		}
	};
	const cut = options.stopBefore ? files.findIndex((f) => f >= options.stopBefore!) : -1;
	const first = cut >= 0 ? files.slice(0, cut) : files;
	const rest = cut >= 0 ? files.slice(cut) : [];
	await apply(first);
	return { db, dispose: () => mf.dispose(), applyRest: () => apply(rest) };
}
