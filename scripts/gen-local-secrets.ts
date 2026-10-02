/**
 * Generates a local runtime-secrets file with REAL random values (nothing is hardcoded).
 * Output: <repo>/.secrets.local.json, gitignored, mode 0600. Refuses to overwrite without --force.
 *
 * Usage: pnpm gen:local-secrets [--force]
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateRuntimeSecrets } from '@heed/config';

const target = resolve(import.meta.dirname, '..', '.secrets.local.json');
const force = process.argv.includes('--force');

if (existsSync(target) && !force) {
  process.stderr.write(`${target} already exists; pass --force to replace it\n`);
  process.exit(1);
}

await writeFile(target, `${JSON.stringify(generateRuntimeSecrets(), null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`wrote ${target} (mode 0600). Point HEED_RUNTIME_SECRETS_FILE at it.\n`);
