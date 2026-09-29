import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRelated, outline, relatedDocs, relatedEntries } from '../src/core';

const adr = ['---', 'title: Use an event bus', 'status: accepted', 'summary: >-', '  Services talk through', '  one event bus.', '---', '', '## Context', '', 'Text.', ''].join('\n');
const files: Record<string, string> = { 'adr.smd': adr, 'plain.smd': '# Plain notes\n\nNo front matter.\n' };
const readFile = (p: string) => files[p];

test('relatedEntries reads one string or a list, without duplicates', () => {
  assert.deepEqual(relatedEntries('---\nrelated: adr.smd\n---\n'), ['adr.smd']);
  assert.deepEqual(relatedEntries('---\nrelated: [adr.smd, " x.smd ", adr.smd, 3]\n---\n'), ['adr.smd', 'x.smd']);
  assert.deepEqual(relatedEntries('---\ntitle: T\n---\n'), []);
  assert.deepEqual(relatedEntries('# No front matter\n'), []);
});

test('relatedDocs summarizes .smd files and leaves URLs, other files and missing files unread', () => {
  const doc = '---\nrelated:\n  - adr.smd#context\n  - plain.smd\n  - https://example.com/spec\n  - notes.txt\n  - gone.smd\n---\n# Doc\n';
  const docs = relatedDocs(doc, { readFile });
  assert.deepEqual(docs.map((d) => [d.target, d.path, d.state]), [
    ['adr.smd#context', 'adr.smd', 'read'],
    ['plain.smd', 'plain.smd', 'read'],
    ['https://example.com/spec', undefined, 'url'],
    ['notes.txt', 'notes.txt', 'not-smd'],
    ['gone.smd', 'gone.smd', 'missing'],
  ]);
  assert.deepEqual([docs[0].title, docs[0].status, docs[0].summary], ['Use an event bus', 'accepted', 'Services talk through one event bus.']);
  assert.ok(docs[0].tokens! > 0);
  assert.deepEqual([docs[1].title, docs[1].status, docs[1].summary], ['Plain notes', undefined, undefined]);

  const text = formatRelated(docs);
  assert.match(text, /^Related documents:\n {2}adr\.smd {2}Use an event bus · accepted · agent view ≈\d+ tokens\n {4}summary: Services talk through one event bus\.\n/);
  assert.match(text, /\n {2}plain\.smd {2}Plain notes · agent view ≈\d+ tokens\n/);
  assert.match(text, /\n {2}https:\/\/example\.com\/spec {2}\(URL, not read\)\n/);
  assert.match(text, /\n {2}notes\.txt {2}\(not an \.smd file, not read\)\n/);
  assert.match(text, /\n {2}gone\.smd {2}\(not found, or outside the project\)\n/);
});

test('no related documents: nothing to add, and outline itself is unchanged', () => {
  const doc = '---\ntitle: Doc\n---\n# Doc\n';
  assert.equal(formatRelated(relatedDocs(doc, { readFile })), '');
  // The outline only lists related documents when asked (smd outline --related).
  assert.doesNotMatch(outline('---\ntitle: Doc\nrelated: [adr.smd]\n---\n# Doc\n'), /adr\.smd|Related/);
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd outline --related lists related documents, reading only inside the project', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'smd-related-'));
  const project = join(root, 'project');
  mkdirSync(join(project, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(root, 'secret.smd'), '---\ntitle: Secret\nsummary: Do not read.\n---\n');
  writeFileSync(join(project, 'docs', 'adr', 'adr.smd'), adr);
  writeFileSync(join(project, 'docs', 'plan.smd'), [
    '---', 'title: Plan', 'related:', '  - adr/adr.smd', '  - ../../secret.smd', '  - https://example.com/spec', '  - notes.txt', '  - missing.smd', '---', '', '## Scope', '', 'Text.', '',
  ].join('\n'));
  writeFileSync(join(project, 'docs', 'solo.smd'), '---\ntitle: Solo\n---\n\n## Scope\n\nText.\n');
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, 'outline', ...args], { cwd: project, encoding: 'utf8', stdio: 'pipe' });

  const plain = run(join('docs', 'plan.smd'));
  assert.doesNotMatch(plain, /Related documents/);
  const out = run(join('docs', 'plan.smd'), '--related');
  assert.ok(out.startsWith(plain), 'the outline comes first, unchanged');
  assert.match(out, /\n {2}docs\/adr\/adr\.smd {2}Use an event bus · accepted · agent view ≈\d+ tokens\n {4}summary: Services talk through one event bus\.\n/);
  assert.match(out, /\n {2}\.\.\/secret\.smd {2}\(not found, or outside the project\)\n/);
  assert.doesNotMatch(out, /Do not read/);
  assert.match(out, /\n {2}https:\/\/example\.com\/spec {2}\(URL, not read\)\n/);
  assert.match(out, /\n {2}docs\/notes\.txt {2}\(not an \.smd file, not read\)\n/);
  assert.match(out, /\n {2}docs\/missing\.smd {2}\(not found, or outside the project\)\n/);

  const solo = join('docs', 'solo.smd');
  assert.equal(run(solo, '--related'), run(solo));
});
