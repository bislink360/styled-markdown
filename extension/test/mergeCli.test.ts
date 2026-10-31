import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driverCommand } from '../src/mergeCommand';

// Requires `npm run build` (Git runs the built CLI as the merge driver).
const cli = join(__dirname, '..', 'dist', 'cli.js');
const hasGit = spawnSync('git', ['--version']).status === 0;
const skip = (!hasGit && 'git is not installed') || (!existsSync(cli) && 'run npm run build first');

const doc = [
  '---', 'title: Plan', 'status: draft', 'updated: 2026-10-01', '---', '', '## Steps', '',
  '- Draft the plan', '- Review it', '- Ship it', '',
  '| Step  | Owner |', '| ----- | ----- |', '| Draft | @ann  |', '| Ship  | @bo   |', '',
].join('\r\n');

test('driverCommand runs this CLI file with node, in forward slashes', () => {
  assert.match(driverCommand(cli), /^node "[^"\\]+cli\.js"$/);
  assert.ok(!driverCommand(cli).includes('\\'));
});

test('CLI: smd merge --install, then git merge resolves edits to neighbouring items and rows', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-merge-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  const commit = (message: string) => git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', message);
  const smd = (...args: string[]) => spawnSync(process.execPath, [cli, 'merge', ...args], { cwd: dir, encoding: 'utf8' });
  const file = join(dir, 'plan.smd');
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, '.gitattributes'), '*.png binary\r\n');
    writeFileSync(file, doc);
    git('add', '.');
    commit('plan');

    const install = smd('--install');
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /driver = node ".*cli\.js" merge %O %A %B %L %P/);
    assert.equal(git('config', '--local', 'merge.smd.name').trim(), 'Styled Markdown block merge');
    assert.equal(readFileSync(join(dir, '.gitattributes'), 'utf8'), '*.png binary\r\n*.smd merge=smd\r\n');
    assert.equal(smd('--install').status, 0); // idempotent
    assert.equal(readFileSync(join(dir, '.gitattributes'), 'utf8'), '*.png binary\r\n*.smd merge=smd\r\n');
    commit('use the smd merge driver');

    git('checkout', '-q', '-b', 'topic');
    writeFileSync(file, doc.replace('- Review it', '- Review it twice').replace('| Ship  | @bo   |', '| Ship  | @cy |').replace('2026-10-01', '2026-10-09'));
    commit('topic');
    git('checkout', '-q', 'main');
    writeFileSync(file, doc.replace('- Draft the plan', '- Draft the plan today').replace('| Draft | @ann  |', '| Draft | @dee  |').replace('2026-10-01', '2026-10-05'));
    commit('main');

    const merge = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'merge', '--no-edit', 'topic'], { cwd: dir, encoding: 'utf8' });
    assert.equal(merge.status, 0, merge.stdout + merge.stderr);
    assert.equal(readFileSync(file, 'utf8'), doc
      .replace('- Draft the plan', '- Draft the plan today').replace('- Review it', '- Review it twice')
      .replace('| Draft | @ann  |', '| Draft | @dee  |').replace('| Ship  | @bo   |', '| Ship  | @cy |').replace('2026-10-01', '2026-10-09'));

    const uninstall = smd('--uninstall');
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(readFileSync(join(dir, '.gitattributes'), 'utf8'), '*.png binary\r\n');
    assert.equal(spawnSync('git', ['config', '--local', 'merge.smd.driver'], { cwd: dir }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: smd merge as a driver keeps a clean merge-file result and exits 1 on a conflict', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-merge-drv-'));
  const put = (name: string, text: string) => writeFileSync(join(dir, name), text);
  const run = () => spawnSync(process.execPath, [cli, 'merge', 'base.smd', 'ours.smd', 'theirs.smd', '7', 'doc.smd'], { cwd: dir, encoding: 'utf8' });
  try {
    put('base.smd', '# A\n\n- one\n- two\n\nEnd.\n');
    put('ours.smd', '# A changed\n\n- one\n- two\n\nEnd.\n');
    put('theirs.smd', '# A\n\n- one\n- two\n\nEnd, changed.\n');
    assert.equal(run().status, 0);
    assert.equal(readFileSync(join(dir, 'ours.smd'), 'utf8'), '# A changed\n\n- one\n- two\n\nEnd, changed.\n');

    put('ours.smd', '# A\n\n- ONE\n- two\n\nEnd.\n');
    put('theirs.smd', '# A\n\n- 1\n- TWO\n\nEnd.\n');
    const conflict = run();
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /doc\.smd: 1 conflict\(s\) left/);
    assert.equal(readFileSync(join(dir, 'ours.smd'), 'utf8'), '# A\n\n<<<<<<< ours\n- ONE\n=======\n- 1\n>>>>>>> theirs\n- TWO\n\nEnd.\n');

    assert.equal(spawnSync(process.execPath, [cli, 'merge', 'base.smd'], { cwd: dir }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
