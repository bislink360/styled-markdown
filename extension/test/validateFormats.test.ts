import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Diagnostic } from '../src/core';
import {
  blobBase, escapeData, escapeProperty, githubAnnotation, githubAnnotations, validationSummary, type ValidationResult,
} from '../src/validateFormats';

const diag = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  line: 2, column: 4, endColumn: 9, severity: 'error', code: 'link/missing-file', message: 'Linked file not found: a.smd', ...over,
});

test('escapeData escapes %, CR and LF; escapeProperty also : and ,', () => {
  assert.equal(escapeData('100% done\r\nnext: a, b'), '100%25 done%0D%0Anext: a, b');
  assert.equal(escapeProperty('100% done\r\nnext: a, b'), '100%25 done%0D%0Anext%3A a%2C b');
  assert.equal(escapeData('%0A'), '%250A', 'escapes % first so existing escapes stay literal');
});

test('githubAnnotation: 1-based positions, inclusive end column, smd code in the title', () => {
  assert.equal(
    githubAnnotation('docs/plan.smd', diag()),
    '::error file=docs/plan.smd,line=3,col=5,endColumn=9,title=smd link/missing-file::Linked file not found: a.smd',
  );
  // A zero-width range still points at its column.
  assert.match(githubAnnotation('a.smd', diag({ line: 0, column: 0, endColumn: 0 }))!, /line=1,col=1,endColumn=1,/);
});

test('githubAnnotation maps severities: warning, info as notice, hints skipped', () => {
  assert.match(githubAnnotation('a.smd', diag({ severity: 'warning' }))!, /^::warning /);
  assert.match(githubAnnotation('a.smd', diag({ severity: 'info' }))!, /^::notice /);
  assert.equal(githubAnnotation('a.smd', diag({ severity: 'hint' })), undefined);
});

test('githubAnnotation escapes the path, the title and the message', () => {
  const line = githubAnnotation('my docs/a,b:c.smd', diag({ code: 'x/y', message: 'Bad: 50%\nsecond line' }))!;
  assert.equal(line, '::error file=my docs/a%2Cb%3Ac.smd,line=3,col=5,endColumn=9,title=smd x/y::Bad: 50%25%0Asecond line');
  assert.equal(line.split('\n').length, 1);
});

const result: ValidationResult = {
  files: [
    { file: 'docs/a.smd', diagnostics: [diag({ severity: 'warning', code: 'task/overdue', message: 'Overdue | late' }), diag({ severity: 'hint', code: 'deprecated/x' })] },
    { file: 'docs/my plan.smd', diagnostics: [diag({ line: 9, message: 'Missing <file>' }), diag({ severity: 'info', code: 'doc/stale', message: 'Stale' })] },
    { file: 'docs/ok.smd', diagnostics: [] },
  ],
  configProblems: [{ file: 'smd.config.json', message: 'Unknown rule "nope".' }],
};

test('githubAnnotations: config problems first, then each file in order, without hints', () => {
  const lines = githubAnnotations(result);
  assert.deepEqual(lines.map((l) => l.slice(0, l.indexOf(' '))), ['::warning', '::warning', '::error', '::notice']);
  assert.equal(lines[0], '::warning file=smd.config.json,title=smd config::Unknown rule "nope".');
  assert.match(lines[2], /file=docs\/my plan\.smd,line=10,/);
});

test('validationSummary counts severities and lists problems errors first, escaped and linked', () => {
  const md = validationSummary(result, { linkBase: 'https://github.com/o/r/blob/abc/' });
  assert.match(md, /^## smd validate\n\n3 file\(s\) checked: \*\*1 error\(s\)\*\*, \*\*2 warning\(s\)\*\*\.\n/);
  assert.match(md, /\| Errors \| 1 \|\n\| Warnings \| 2 \|\n\| Notices \| 1 \|\n\| Hints \| 1 \|/);
  const rows = md.split('\n').filter((l) => /^\| (error|warning|info|hint) \|/.test(l));
  assert.deepEqual(rows.map((r) => r.split(' | ')[0]), ['| error', '| warning', '| info']);
  assert.ok(rows[0].includes('[docs/my plan.smd:10](https://github.com/o/r/blob/abc/docs/my%20plan.smd#L10)'));
  assert.ok(rows[0].includes('Missing &lt;file&gt;'));
  assert.ok(rows[1].includes(String.raw`Overdue \| late`));
  assert.match(md, /- Config `smd\.config\.json`: Unknown rule "nope"\./);
});

test('validationSummary: plain locations without a link base, a limit, and a clean run', () => {
  const md = validationSummary(result, { limit: 1 });
  assert.match(md, /\| error \| docs\/my plan\.smd:10 \| `link\/missing-file` \|/);
  assert.match(md, /…and 2 more\./);
  const clean = validationSummary({ files: [{ file: 'a.smd', diagnostics: [] }], configProblems: [] });
  assert.equal(clean, '## smd validate\n\n1 file(s) checked: no errors or warnings.\n');
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd validate --format github prints workflow commands and --summary appends a job summary', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-gh-'));
  // Outside GitHub Actions (this test may run inside it): paths relative to the working directory, no links.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GITHUB_')));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'validate', ...args], { cwd: dir, encoding: 'utf8', env });
  try {
    mkdirSync(join(dir, 'my docs'));
    writeFileSync(join(dir, 'my docs', 'bad.smd'), '# Bad\n\n:::nope\nx\n:::\n\nSee [a](missing.smd).\n\n:::note\nopen\n');
    writeFileSync(join(dir, 'ok.smd'), '# Fine\n\nAll good.\n');

    const gh = run('.', '--format', 'github', '--no-mermaid', '--summary', 'summary.md');
    assert.equal(gh.status, 1, gh.stderr);
    const lines = gh.stdout.trimEnd().split('\n');
    assert.ok(lines.length >= 2, gh.stdout);
    for (const l of lines) assert.match(l, /^::(error|warning|notice) file=my docs\/bad\.smd,line=\d+,col=\d+,endColumn=\d+,title=smd [\w/-]+::/);
    assert.ok(lines.includes('::warning file=my docs/bad.smd,line=3,col=4,endColumn=7,title=smd container/unknown::Unknown container ":::nope" — did you mean ":::note"? It will render as a plain box.'), gh.stdout);
    assert.ok(lines.some((l) => l.startsWith('::error file=my docs/bad.smd,line=9,col=1,') && l.includes('title=smd container/unclosed::')), gh.stdout);
    assert.match(gh.stdout, /title=smd link\/missing-file::/);
    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.match(summary, /^## smd validate\n\n2 file\(s\) checked: \*\*\d+ error\(s\)\*\*/);
    assert.match(summary, /\| error \| my docs\/bad\.smd:\d+ \|/);

    // Paths are relative to GITHUB_WORKSPACE when set, so annotations land on the right file from a subfolder.
    const sub = spawnSync(process.execPath, [cli, 'validate', 'bad.smd', '--format', 'github', '--no-mermaid'],
      { cwd: join(dir, 'my docs'), encoding: 'utf8', env: { ...env, GITHUB_WORKSPACE: dir } });
    assert.match(sub.stdout, /^::warning file=my docs\/bad\.smd,line=3,/);

    // Files are appended to, and the text output and the exit code are unchanged.
    run('ok.smd', '--format', 'github', '--summary', 'summary.md', '--no-mermaid');
    const both = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.equal(both.split('## smd validate').length, 3);
    const text = run('ok.smd', '--no-mermaid');
    assert.equal(text.stdout, '\n1 file(s) checked: 0 error(s), 0 warning(s).\n');
    assert.equal(run('ok.smd', '--format', 'xml').status, 2);
    assert.equal(run('ok.smd', '--format', 'github', '--json').status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blobBase builds summary links from the GitHub Actions environment only when it is complete', () => {
  const env = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'abc' };
  assert.equal(blobBase(env), 'https://github.com/o/r/blob/abc/');
  assert.equal(blobBase({ ...env, GITHUB_SHA: undefined }), undefined);
  assert.equal(blobBase({}), undefined);
});
