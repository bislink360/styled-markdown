import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionLog, decisionLogMarkdown, formatSmd, isInactiveDecision, validateSmd } from '../src/core';

const adr = [
  '---', 'smd: 1', 'title: "ADR-0001: Use Postgres"', 'tags: [adr, data]', '---', '',
  ':::decision{status=accepted date=2026-09-01 owner=@data} Use Postgres for orders', 'Why.', ':::', '',
  '## Context', '', 'Text.', '',
  ':::decision{status=superseded date=2026-03-01 owner=@data} Use MySQL', 'Old.', ':::', '',
].join('\n');

const plan = [
  '# Checkout plan', '',
  '## Decisions', '',
  ':::decision Keep the monolith', 'x', ':::', '',
  ':::decision{#eu-first status=Accepted date=2026-09-10 owner="@maya, @li"} Launch in the EU first', 'y', ':::', '',
  '```md', ':::decision{status=accepted} Not a decision: inside code', ':::', '```', '',
  '### Later', '',
  ':::decision{status=rejected date=2026-09-10 owner=@li} Price | $5 and $10 *now*', 'z', ':::', '',
].join('\n');

const docs = [{ path: 'docs/plan.smd', text: plan }, { path: 'docs/adr/0001-postgres.smd', text: adr }];

test('decisionLog: every decision with defaults, newest first, undated last, then by path and line', () => {
  const log = decisionLog(docs);
  assert.deepEqual(log.map((d) => [d.title, d.status, d.date]), [
    ['Launch in the EU first', 'accepted', '2026-09-10'],
    ['Price | $5 and $10 *now*', 'rejected', '2026-09-10'],
    ['Use Postgres for orders', 'accepted', '2026-09-01'],
    ['Use MySQL', 'superseded', '2026-03-01'],
    ['Keep the monolith', 'proposed', null],
  ]);
  const [eu, , pg, mysql, monolith] = log;
  assert.deepEqual(eu, {
    title: 'Launch in the EU first', status: 'accepted', date: '2026-09-10', owner: '@maya, @li', path: 'docs/plan.smd',
    line: 8, endLine: 10, section: 'Decisions', anchor: 'eu-first', document: 'Checkout plan', adr: false,
  });
  assert.deepEqual([pg.document, pg.section, pg.anchor, pg.adr, pg.line], ['ADR-0001: Use Postgres', null, null, true, 6]);
  assert.deepEqual([mysql.section, mysql.anchor, mysql.adr], ['Context', 'context', false]);
  assert.deepEqual([monolith.anchor, monolith.owner, monolith.adr], ['decisions', null, false]);
});

test('decisionLog: status and owner filters', () => {
  const titles = (options: Parameters<typeof decisionLog>[1]) => decisionLog(docs, options).map((d) => d.title);
  assert.deepEqual(titles({ status: ['open'] }), ['Keep the monolith']);
  assert.deepEqual(titles({ status: ['ACCEPTED', ' rejected '] }), ['Launch in the EU first', 'Price | $5 and $10 *now*', 'Use Postgres for orders']);
  assert.deepEqual(titles({ status: [] }).length, 5);
  assert.deepEqual(titles({ owner: 'li' }), ['Launch in the EU first', 'Price | $5 and $10 *now*']);
  assert.deepEqual(titles({ owner: '@Data', status: ['superseded'] }), ['Use MySQL']);
  assert.deepEqual(titles({ owner: '@nobody' }), []);
});

test('decisionLog: a document without a title is named by its first heading or file name', () => {
  const log = decisionLog([{ path: 'a/b/notes.smd', text: ':::decision{date=someday} Undated\n:::\n' }]);
  assert.deepEqual([log[0].document, log[0].adr, log[0].date, log[0].anchor], ['notes', true, 'someday', null]);
  assert.equal(isInactiveDecision('Superseded'), true);
  assert.equal(isInactiveDecision('accepted'), false);
});

test('decisionLogMarkdown: a formatted, valid ADR index', () => {
  const log = decisionLog(docs);
  const md = decisionLogMarkdown(log, { title: 'Architecture: decisions', link: (p) => p.replace(/^docs\//, '') });
  assert.equal(formatSmd(md), md);
  assert.match(md, /^---\nsmd: 1\ntitle: "Architecture: decisions"\nsummary: "5 decisions from 2 documents, newest first."\n/);
  assert.match(md, /\| 2026-09-10 \| :badge\[accepted\]\{color=green\} +\| \[Launch in the EU first\]\(plan\.smd#eu-first\) +\| @maya, @li/);
  assert.match(md, /~~\[Price \\\| \\\$5 and \\\$10 \\\*now\\\*\]\(plan\.smd#later\)~~/);
  assert.match(md, /\[Use Postgres for orders\]\(adr\/0001-postgres\.smd\) +\| @data +\| \[ADR-0001: Use Postgres\]\(adr\/0001-postgres\.smd\)/);
  assert.match(md, /\| — +\| :badge\[proposed\]\{color=blue\}/);
  const files = new Map([['plan.smd', plan], ['adr/0001-postgres.smd', adr]]);
  const problems = validateSmd(md, { fileExists: (p) => files.has(p), readFile: (p) => files.get(p) });
  assert.deepEqual(problems, []);
  assert.match(decisionLogMarkdown([]), /\nNo decisions found\.\n$/);
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd decisions lists, filters and writes an ADR index', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const examples = join(__dirname, '..', '..', 'examples');
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, 'decisions', examples, ...args], { encoding: 'utf8', stdio: 'pipe' });
  const lines = run().trim().split('\n');
  assert.match(lines[0], /adr-0007-event-bus\.smd:11 {2}2026-09-18 {2}\[accepted\] {2}Publish order events to AWS EventBridge {2}@platform {2}— ADR-0007/);
  assert.ok(lines.some((l) => /\[superseded\] {2}Add a retry queue/.test(l)));
  const json = JSON.parse(run('--status', 'superseded,rejected', '--json'));
  assert.ok(json.length >= 3 && json.every((d: { status: string }) => d.status === 'superseded' || d.status === 'rejected'));
  const bad = spawnSync(process.execPath, [cli, 'decisions', examples, '--status', 'acepted'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Did you mean "accepted"/);

  const dir = mkdtempSync(join(tmpdir(), 'smd-decisions-'));
  try {
    const out = join(dir, 'decisions.smd');
    run('--md', '-o', out);
    assert.match(readFileSync(out, 'utf8'), /\]\([^)]*examples\/adr-0007-event-bus\.smd#consequences\)~~/);
    const check = spawnSync(process.execPath, [cli, 'validate', out, '--strict', '--no-mermaid'], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout);
    assert.equal(spawnSync(process.execPath, [cli, 'fmt', '--check', out]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
