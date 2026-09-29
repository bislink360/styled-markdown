import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffSmd } from '../src/core';

const base = [
  '---', 'title: Plan', 'status: draft', '---',
  'Intro.', '',
  '# Plan', '',
  '## Goals', 'Ship fast.', '',
  '### Metrics', '- p95 < 200ms', '',
  '## Objectives', 'Line one.', 'Line two.', 'Line three.', '',
  '## Old', 'Remove me.', '',
  '## Background {agent=skip}', 'History.', '',
].join('\n');

const edit = (from: string, to: string) => base.replace(from, to);
const summary = (a: string, b: string) => diffSmd(a, b).sections.map((s) => `${s.change} ${s.heading}`);

test('diffSmd reports nothing for the same text, or changes an agent cannot see', () => {
  const same = diffSmd(base, base);
  assert.deepEqual([same.frontMatter, same.sections, same.text, same.tokens], [[], [], '', 0]);
  assert.ok(same.fullTokens > 0);
  // Styling, comments and :::human content are not in the agent view.
  assert.deepEqual(summary(base, edit('Ship fast.', 'Ship [fast]{color=red}. <!-- note -->\n\n:::human\nFor people.\n:::')), []);
});

test('diffSmd reports an edit in the smallest section that contains it', () => {
  const r = diffSmd(base, edit('p95 < 200ms', 'p95 < 150ms'));
  assert.deepEqual(r.sections.map((s) => [s.change, s.heading, s.level, s.id, s.line, s.endLine, s.oldLine, s.oldEndLine]), [
    ['changed', 'Metrics', 3, 'metrics', 11, 13, 11, 13],
  ]);
  assert.equal(r.sections[0].text, '### Metrics  [L12]\n- p95 < 150ms');
  assert.equal(r.text, '[changed L12-14]\n### Metrics  [L12]\n- p95 < 150ms\n');
  assert.doesNotMatch(r.text, /Goals|Ship fast/); // the unchanged parent is left out
  assert.ok(r.tokens < r.fullTokens);
});

test('diffSmd reports added and removed sections', () => {
  const r = diffSmd(base, edit('## Old\nRemove me.\n', '## New\nBrand new.\n'));
  assert.deepEqual(r.sections.map((s) => s.change + ' ' + s.heading), ['added New', 'removed Old']);
  const [added, removed] = r.sections;
  assert.equal(added.text, '## New  [L20]\nBrand new.');
  assert.deepEqual([removed.line, removed.oldLine, removed.oldEndLine, removed.text], [undefined, 19, 21, undefined]);
  assert.equal(r.text, '[added L20-22]\n## New  [L20]\nBrand new.\n\n[removed: ## Old, was L20-22]\n');
});

test('diffSmd matches a renamed heading by its content', () => {
  const renamed = diffSmd(base, edit('## Objectives', '## Aims'));
  assert.deepEqual(renamed.sections.map((s) => [s.change, s.heading, s.oldHeading, s.text]), [['renamed', 'Aims', 'Objectives', '## Aims  [L15]']]);
  assert.match(renamed.text, /^\[renamed from "Objectives" L15-19\]\n## Aims {2}\[L15\]\n$/);
  const both = diffSmd(base, edit('## Objectives\nLine one.', '## Aims\nLine 1.'));
  assert.deepEqual(both.sections.map((s) => [s.change, s.heading, s.oldHeading]), [['changed', 'Aims', 'Objectives']]);
  assert.match(both.sections[0].text ?? '', /Line 1\.\nLine two\./);
  // A rewrite is not a rename.
  assert.deepEqual(summary(base, edit('## Objectives\nLine one.\nLine two.\nLine three.', '## Aims\nOther.')), ['added Aims', 'removed Objectives']);
});

test('diffSmd reports front-matter changes key by key', () => {
  const r = diffSmd(base, edit('status: draft', 'status: accepted\nowners: [maya, li]'));
  assert.deepEqual(r.frontMatter, [{ key: 'status', before: 'draft', after: 'accepted' }, { key: 'owners', after: ['maya', 'li'] }]);
  assert.deepEqual(r.sections, []);
  assert.equal(r.text, 'Front matter:\n  status: draft → accepted\n  owners: (none) → maya, li\n');
  assert.deepEqual(diffSmd(base, edit('status: draft\n', '')).frontMatter, [{ key: 'status', before: 'draft' }]);
});

test('diffSmd treats content before the first heading as a section', () => {
  const r = diffSmd(base, edit('Intro.', 'Intro, revised.'));
  assert.deepEqual(r.sections.map((s) => [s.change, s.heading, s.level, s.id, s.line]), [['changed', null, 0, null, 4]]);
  assert.equal(r.text, '[changed L5-6 (before the first heading)]\nIntro, revised.\n');
  const removed = diffSmd(base, edit('Intro.\n', ''));
  assert.equal(removed.text, '[removed: content before the first heading, was L5-6]\n');
});

test('diffSmd leaves out the content of sections skipped for agents, and line refs on request', () => {
  const skipped = diffSmd(base, edit('History.', 'Older history.'));
  assert.deepEqual(skipped.sections.map((s) => [s.change, s.skipped, s.text]), [['changed', true, undefined]]);
  assert.equal(skipped.text, '[changed L23-25 ## Background (skipped for agents)]\n');
  const plain = diffSmd(base, edit('p95 < 200ms', 'p95 < 150ms'), { lineRefs: false });
  assert.equal(plain.text, '[changed]\n### Metrics\n- p95 < 150ms\n');
});

test('diffSmd on empty versions: everything added or removed', () => {
  assert.deepEqual(summary('', '# A\n\nText.\n'), ['added A']);
  assert.deepEqual(summary('# A\n\nText.\n', ''), ['removed A']);
  assert.deepEqual(summary('', ''), []);
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd diff compares two files and a Git revision', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-diff-'));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'diff', ...args], { cwd: dir, encoding: 'utf8' });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    writeFileSync(join(dir, 'plan.smd'), base);
    writeFileSync(join(dir, 'gone.smd'), '# Gone\n\nBye.\n');
    writeFileSync(join(dir, 'same.smd'), '# Same\n');
    writeFileSync(join(dir, 'old.smd'), base);
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');

    writeFileSync(join(dir, 'plan.smd'), edit('p95 < 200ms', 'p95 < 150ms'));
    writeFileSync(join(dir, 'fresh.smd'), '# Fresh\n\nHello.\n');
    unlinkSync(join(dir, 'gone.smd'));

    const pair = run('old.smd', 'plan.smd');
    assert.equal(pair.status, 0);
    assert.match(pair.stdout, /^plan\.smd: changed compared with old\.smd\n\n\[changed L12-14\]\n### Metrics {2}\[L12\]\n- p95 < 150ms\n$/);
    assert.match(pair.stderr, /1 of 1 file\(s\) changed compared with old\.smd: ≈\d+ tokens \(full agent view ≈\d+, \d+% smaller\)/);

    const since = run('--since', 'HEAD');
    assert.equal(since.status, 0);
    assert.match(since.stdout, /plan\.smd: changed since HEAD\n\n\[changed L12-14\]/);
    assert.match(since.stdout, /fresh\.smd: added since HEAD\n\n# Fresh {2}\[L1\]\n\nHello\./);
    assert.match(since.stdout, /gone\.smd: deleted since HEAD\n\n\[removed: # Gone, was L1-4\]/);
    assert.doesNotMatch(since.stdout, /same\.smd/);
    assert.match(since.stderr, /3 of 5 file\(s\) changed since HEAD/);

    const json = JSON.parse(run('plan.smd', '--since', 'HEAD', '--json').stdout);
    assert.deepEqual(json.map((d: { file: string; status: string; since: string }) => [d.file, d.status, d.since]), [['plan.smd', 'changed', 'HEAD']]);
    assert.equal(json[0].sections[0].heading, 'Metrics');

    assert.equal(run('same.smd', '--since', 'HEAD', '--exit-code').status, 0);
    assert.equal(run('plan.smd', '--since', 'HEAD', '--exit-code').status, 1);
    assert.equal(run('--since', 'no-such-ref').status, 2);
    assert.equal(run('plan.smd').status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
