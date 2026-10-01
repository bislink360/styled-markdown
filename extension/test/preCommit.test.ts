import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

const root = join(__dirname, '..', '..');

interface Hook { id: string; name: string; entry: string; language: string; files: string; description?: string }
interface RootPackage { private?: boolean; bin: Record<string, string>; files: string[] }

const hooks = yaml.load(readFileSync(join(root, '.pre-commit-hooks.yaml'), 'utf8')) as Hook[];
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as RootPackage;
const hook = (id: string) => hooks.find((h) => h.id === id)!;

test('.pre-commit-hooks.yaml: smd-validate, smd-fmt and smd-fmt-check run the CLI on .smd files', () => {
  assert.deepEqual(hooks.map((h) => h.id), ['smd-validate', 'smd-fmt', 'smd-fmt-check']);
  for (const h of hooks) {
    assert.ok(h.name && h.description, `${h.id} has a name and description`);
    assert.equal(h.language, 'node', `${h.id}: pre-commit installs the root package.json`);
    const files = new RegExp(h.files);
    assert.ok(files.test('docs/my plan.smd') && files.test('README.smd'), `${h.id} runs on .smd files`);
    assert.ok(!files.test('README.md') && !files.test('notes.smd.bak'), `${h.id} skips other files`);
    assert.ok(h.entry.split(' ')[0] in pkg.bin, `${h.id}: its entry is a bin of the root package.json`);
  }
  assert.equal(hook('smd-validate').entry, 'smd validate');
  assert.equal(hook('smd-fmt').entry, 'smd fmt');
  assert.equal(hook('smd-fmt-check').entry, 'smd fmt --check');
});

test('root package.json: private, and its smd bin is the bundled CLI it packs', () => {
  assert.equal(pkg.private, true, 'never published to npm');
  const bin = pkg.bin.smd;
  assert.equal(bin, 'skills/styled-markdown-reader/scripts/smd.cjs');
  assert.ok(pkg.files.includes(bin), 'npm pack (which pre-commit installs) includes the bin');
  assert.ok(existsSync(join(root, bin)));
  assert.match(readFileSync(join(root, bin), 'utf8'), /^#!\/usr\/bin\/env node\r?\n/, 'npm needs the shebang for its shims');
});

/** Runs a hook as pre-commit would: its entry, then `args`, then the staged file names. */
function runHook(id: string, cwd: string, ...rest: string[]) {
  const [, ...entryArgs] = hook(id).entry.split(' ');
  return spawnSync(process.execPath, [join(root, pkg.bin.smd), ...entryArgs, ...rest], { cwd, encoding: 'utf8' });
}

const docs: Record<string, string> = {
  'good doc.smd': '# Good\n\nText.\n',
  'needs fmt.smd': '# Fmt\n\n::: note   Title  \nx\n:::\n',
  'broken doc.smd': '# Broken\n\n:::note\nnever closed\n',
  'warn doc.smd': '---\nsmd: 1\nstatus: shipped\n---\n# Warn\n',
  '-dash.smd': '# Dash\n',
};

function withDocs(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'smd pre-commit '));
  try {
    for (const [name, text] of Object.entries(docs)) writeFileSync(join(dir, name), text);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('hooks: smd-fmt-check and smd-fmt take many files with spaces; fmt rewrites, check exits 1', () => {
  withDocs((dir) => {
    const files = ['good doc.smd', 'needs fmt.smd'];
    const check = runHook('smd-fmt-check', dir, ...files);
    assert.equal(check.status, 1, check.stdout);
    assert.match(check.stdout, /needs fmt\.smd: not formatted/);
    assert.match(check.stdout, /2 file\(s\) checked: 1 need formatting/);
    assert.equal(readFileSync(join(dir, 'needs fmt.smd'), 'utf8'), docs['needs fmt.smd'], '--check changes nothing');

    const format = runHook('smd-fmt', dir, ...files);
    assert.equal(format.status, 0, format.stdout);
    assert.match(format.stdout, /needs fmt\.smd: formatted/);
    assert.equal(readFileSync(join(dir, 'needs fmt.smd'), 'utf8'), '# Fmt\n\n:::note Title\nx\n:::\n');
    assert.equal(runHook('smd-fmt-check', dir, ...files).status, 0, 'formatted now');
  });
});

test('hooks: smd-validate exits 1 on errors in any file, and on warnings only with --strict', () => {
  withDocs((dir) => {
    const ok = runHook('smd-validate', dir, 'good doc.smd', 'needs fmt.smd', 'warn doc.smd');
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /3 file\(s\) checked: 0 error\(s\), 1 warning\(s\)/);

    const strict = runHook('smd-validate', dir, '--strict', 'good doc.smd', 'warn doc.smd');
    assert.equal(strict.status, 1, strict.stdout);

    const broken = runHook('smd-validate', dir, 'good doc.smd', 'broken doc.smd');
    assert.equal(broken.status, 1, broken.stdout);
    assert.match(broken.stdout, /broken doc\.smd:3:1 {2}error .*container\/unclosed/);
  });
});

test('CLI: after --, every argument is a file, even one starting with "-"', () => {
  withDocs((dir) => {
    const validate = runHook('smd-validate', dir, '--strict', '--', '-dash.smd', 'good doc.smd');
    assert.equal(validate.status, 0, validate.stdout);
    assert.match(validate.stdout, /2 file\(s\) checked/);
    const check = runHook('smd-fmt-check', dir, '--', '-dash.smd', 'needs fmt.smd');
    assert.equal(check.status, 1, check.stdout);
    assert.match(check.stdout, /2 file\(s\) checked: 1 need formatting/);
  });
});
