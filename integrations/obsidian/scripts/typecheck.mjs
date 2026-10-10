// Type-checks the plugin (src/, and the engine it bundles from extension/src) with the extension's TypeScript.
// Needs `npm ci` in extension/ and in this folder (for the `obsidian` API typings).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let tsc;
try {
  tsc = createRequire(resolve(root, '../../extension/package.json')).resolve('typescript/bin/tsc');
} catch {
  console.error('TypeScript not found: run `npm ci` in extension/ first (the plugin is built with its toolchain).');
  process.exit(1);
}
const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
