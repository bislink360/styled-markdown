// Launches VS Code with this extension loaded and runs suite.js inside it.
// Uses an installed VS Code when VSCODE_PATH is set (or found on PATH); otherwise downloads one.
import { runTests } from '@vscode/test-electron';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = resolve(here, '..', '..');
const extensionTestsPath = join(here, 'suite.js');

function findInstalledCode() {
  if (process.env.VSCODE_PATH) return process.env.VSCODE_PATH;
  try {
    const cmd = process.platform === 'win32' ? 'where code.cmd' : 'which code';
    const bin = execSync(cmd, { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    const exe = process.platform === 'win32' ? resolve(dirname(bin), '..', 'Code.exe') : undefined;
    return exe && existsSync(exe) ? exe : undefined;
  } catch {
    return undefined;
  }
}

const vscodeExecutablePath = findInstalledCode();
const userDataDir = mkdtempSync(join(tmpdir(), 'smd-test-'));

try {
  await runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [resolve(extensionDevelopmentPath, '..', 'examples'), '--disable-extensions', `--user-data-dir=${userDataDir}`, '--skip-welcome', '--skip-release-notes'],
  });
} catch (err) {
  console.error(err);
  process.exit(1);
}
