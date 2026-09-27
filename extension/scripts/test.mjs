// Runs the unit tests. Collects test/*.test.ts itself because npm on Windows uses cmd.exe,
// which does not expand globs, and Node < 21 does not expand them for --test either.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'test'))
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => join('test', f));

if (!files.length) {
  console.error('No test files found in test/.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
