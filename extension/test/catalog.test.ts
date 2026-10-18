import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentView, indexEntry, outline, smdIndex, INDEX_FORMAT, LATEST_SPEC } from '../src/core';

const doc = [
  '---', 'title: Checkout plan', 'summary: One-page checkout.', 'status: review',
  'owners: ["@maya", "@payments"]', 'tags: checkout, q4', 'audience: both', 'updated: 2026-09-01', 'related: [adr-0007.smd]', '---',
  '# Checkout plan', '',
  ':::agent', 'Keep the API stable.', ':::', '',
  '## Decisions', '',
  ':::decision{status=accepted} Launch in the EU first', 'x', ':::', '',
  ':::decision Keep the monolith', 'y', ':::', '',
  '## Risks', '',
  ':::risk{impact=high status=open} Rate limits', 'z', ':::', '',
  ':::risk{status=mitigated} Price drift', 'w', ':::', '',
  ':::risk No status', 'v', ':::', '',
  '### Questions', '',
  ':::question Who owns billing?', ':::', '',
  '## API', '',
  ':::api{method=POST path=/v1/orders} Create', ':::', '',
  '```mermaid', 'flowchart LR', 'A --> B', '```', '',
  '## Background {agent=skip}', '', 'Old history.', '',
  '## Tasks', '',
  '- [ ] Ship it @maya :due[2026-09-10]',
  '- [ ] Later :due[2026-12-01]',
  '- [x] Draft',
  '',
].join('\n');

test('indexEntry lists metadata, token costs and routing counts', () => {
  const entry = indexEntry(doc, 'docs/plan.smd', { today: '2026-09-20' });
  const view = agentView(doc, { today: '2026-09-20' });
  assert.deepEqual({ ...entry, sections: undefined }, {
    path: 'docs/plan.smd', smd: 1, title: 'Checkout plan', summary: 'One-page checkout.', status: 'review',
    owners: ['@maya', '@payments'], tags: ['checkout', 'q4'], audience: 'both', updated: '2026-09-01', related: ['adr-0007.smd'],
    tokens: { file: view.originalTokens, agent: view.tokens },
    counts: {
      openTasks: 2, doneTasks: 1, overdueTasks: 1, decisions: { accepted: 1, proposed: 1 },
      risks: 3, openRisks: 2, questions: 1, apis: 1, diagrams: 1, agentInstructions: 1,
    },
    sections: undefined,
  });
});

test('indexEntry sections carry ids, line ranges and the same token costs as smd outline', () => {
  const entry = indexEntry(doc, 'plan.smd');
  assert.deepEqual(entry.sections.map((s) => [s.level, s.text, s.id, s.line, s.endLine]), [
    [1, 'Checkout plan', 'checkout-plan', 10, 64],
    [2, 'Decisions', 'decisions', 16, 25],
    [2, 'Risks', 'risks', 26, 44],
    [3, 'Questions', 'questions', 40, 44],
    [2, 'API', 'api', 45, 54],
    [2, 'Background', 'background', 55, 58],
    [2, 'Tasks', 'tasks', 59, 64],
  ]);
  assert.equal(entry.sections.find((s) => s.id === 'background')?.agent, 'skip');
  assert.equal(entry.sections.find((s) => s.id === 'risks')?.agent, undefined);
  // Each section costs what `smd outline` reports for it.
  const costs = outline(doc).split('\n').filter((l) => /^L\d/.test(l)).map((l) => Number(/≈(\d+)/.exec(l)?.[1]));
  assert.deepEqual(entry.sections.map((s) => s.tokens), costs);
});

test('indexEntry falls back to the file name and leaves missing metadata empty', () => {
  const entry = indexEntry('Just text.\n', 'notes/scratch.smd');
  assert.equal(entry.title, 'scratch');
  assert.deepEqual([entry.summary, entry.status, entry.audience, entry.updated], [null, null, null, null]);
  assert.deepEqual([entry.owners, entry.tags, entry.related, entry.sections], [[], [], [], []]);
  assert.equal(indexEntry('# Heading title\n', 'x.smd').title, 'Heading title');
});

test('smdIndex sorts documents by path, lists each once and is deterministic', () => {
  const docs = [
    { path: 'b/z.smd', text: '# Z\n' },
    { path: 'a.smd', text: '# A\n' },
    { path: 'B.smd', text: '# B\n' },
    { path: 'a.smd', text: '# A\n' },
  ];
  const catalog = smdIndex(docs, { generator: 'smd test' });
  assert.equal(catalog.format, INDEX_FORMAT);
  assert.deepEqual([catalog.version, catalog.smd, catalog.generator], [1, LATEST_SPEC, 'smd test']);
  assert.equal(LATEST_SPEC, 2, 'the catalog names the newest spec version the tool knows');
  assert.deepEqual(catalog.documents.map((d) => d.path), ['B.smd', 'a.smd', 'b/z.smd']);
  assert.equal(JSON.stringify(smdIndex(docs, { generator: 'smd test' })), JSON.stringify(catalog));
  assert.equal('generator' in smdIndex([]), false);
});

test('each catalog entry has its document\'s spec version, as every reader reads it', () => {
  const entry = (front: string) => indexEntry(`${front}# T\n`, 't.smd').smd;
  assert.equal(entry(''), 1, 'no front matter');
  assert.equal(entry('---\ntitle: T\n---\n'), 1, 'no smd key');
  assert.equal(entry('---\nsmd: 1\n---\n'), 1);
  assert.equal(entry('---\nsmd: 2\n---\n'), 2);
  assert.equal(entry('---\nsmd: "2"\n---\n'), 2);
  assert.equal(entry('---\nsmd: 3\n---\n'), 2, 'a newer version reads with the newest rules');
  assert.equal(entry('---\nsmd: true\n---\n'), 1, 'an invalid value is version 1');
  // Additive: the rest of the entry is what it is for the same document with smd: 1.
  const v1 = indexEntry(doc.replace('---\n', '---\nsmd: 1\n'), 'p.smd');
  const v2 = indexEntry(doc.replace('---\n', '---\nsmd: 2\n'), 'p.smd');
  assert.deepEqual({ ...v2, smd: 1 }, v1);
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd index writes a JSON catalog with paths relative to the working directory', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const root = join(__dirname, '..', '..');
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, 'index', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const catalog = JSON.parse(run('examples', '--today', '2026-09-29'));
  assert.equal(catalog.format, 'smd-index');
  assert.match(catalog.generator, /^smd \d+\.\d+\.\d+/);
  const paths = catalog.documents.map((d: { path: string }) => d.path);
  assert.ok(paths.includes('examples/checkout-redesign.smd'));
  assert.deepEqual(paths, [...paths].sort());
  const checkout = catalog.documents.find((d: { path: string }) => d.path === 'examples/checkout-redesign.smd');
  assert.equal(checkout.status, 'approved');
  assert.ok(checkout.tokens.agent < checkout.tokens.file && checkout.sections.length > 3);
  assert.ok(checkout.counts.apis >= 1 && checkout.counts.agentInstructions >= 1);

  const compact = run('examples', '--today', '2026-09-29', '--compact');
  assert.equal(compact.trimEnd().split('\n').length, 1);
  assert.deepEqual(JSON.parse(compact), catalog);

  const dir = mkdtempSync(join(tmpdir(), 'smd-index-'));
  try {
    const out = join(dir, 'catalog.json');
    run('examples/api-orders.smd', '-o', out);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).documents.map((d: { path: string }) => d.path), ['examples/api-orders.smd']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(spawnSync(process.execPath, [cli, 'index', 'no-such-dir'], { cwd: root }).status, 2);
});
