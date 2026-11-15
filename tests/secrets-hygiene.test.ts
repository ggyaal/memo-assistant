import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// `.dev.vars.example` is committed on purpose; real values belong in the
// git-ignored `.dev.vars`. Fail loudly if a secret was pasted into the example.
it('.dev.vars.example contains names only, no values', () => {
	const text = readFileSync(join(import.meta.dirname, '..', '.dev.vars.example'), 'utf8');
	const filled = text
		.split('\n')
		.filter((line) => !line.trim().startsWith('#'))
		.filter((line) => /^[A-Z0-9_]+=\s*\S/.test(line))
		.map((line) => line.split('=')[0]);
	expect(filled, `Move these to .dev.vars (git-ignored): ${filled.join(', ')}`).toEqual([]);
});
