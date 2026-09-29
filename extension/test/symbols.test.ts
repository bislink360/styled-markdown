import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { documentPreview, documentSymbols, embedPreview, fuzzyMatch, sectionExcerpt } from '../src/core/symbols';

const showcase = fs.readFileSync(path.join(__dirname, '..', '..', 'examples', 'showcase.smd'), 'utf8');

test('documentSymbols lists headings, decisions, risks and API endpoints', () => {
  const src = [
    '---', 'title: T', '---', '# Plan', '', '## Decisions',
    ':::decision{status=accepted date=2026-09-12 owner=@maya} Launch in the EU first', 'Why.', ':::', '',
    ':::risk{impact=high} Rate limits', 'x', ':::', '',
    ':::api{method=post path="/v1/orders" auth="bearer token"} Create an order', '| a |', ':::', '',
    '```md', ':::decision{status=accepted} Not a decision (in code)', '```',
  ].join('\n');
  assert.deepEqual(documentSymbols(src), [
    { kind: 'heading', name: 'Plan', detail: 'H1', line: 3 },
    { kind: 'heading', name: 'Decisions', detail: 'H2', line: 5 },
    { kind: 'decision', name: 'Launch in the EU first', detail: 'accepted · 2026-09-12', line: 6 },
    { kind: 'risk', name: 'Rate limits', detail: 'impact high', line: 10 },
    { kind: 'api', name: 'POST /v1/orders — Create an order', detail: 'auth bearer token', line: 14 },
  ]);
  const kinds = new Set(documentSymbols(showcase).map((s) => s.kind));
  assert.deepEqual([...kinds].sort(), ['api', 'decision', 'heading', 'risk']);
});

test('sectionExcerpt previews a section up to the next heading of the same level', () => {
  const src = '# Doc\n\n## Setup\n\nInstall it.\n\n### Details\n\nMore.\n\n## Usage\n\nRun it.\n\n:::card{#pricing} Pricing\nFree.\n:::\n';
  assert.deepEqual(sectionExcerpt(src, 'setup'), { title: 'Setup', level: 2, line: 2, lines: ['Install it.', '', '### Details', '', 'More.'], truncated: false });
  assert.deepEqual(sectionExcerpt(src, 'usage', 2)?.lines, ['Run it.']);
  assert.equal(sectionExcerpt(src, 'usage', 2)?.truncated, true);
  assert.deepEqual(sectionExcerpt(src, 'pricing', 3), { title: undefined, level: undefined, line: 14, lines: [':::card{#pricing} Pricing', 'Free.', ':::'], truncated: false });
  assert.equal(sectionExcerpt(src, 'nowhere'), undefined);
});

test('documentPreview gives the title, status, summary and top sections', () => {
  const preview = documentPreview(showcase);
  assert.equal(preview.title, 'Styled Markdown Showcase');
  assert.equal(preview.status, 'review');
  assert.match(preview.summary ?? '', /A tour of every/);
  assert.ok(preview.sections.includes('Callouts'), JSON.stringify(preview.sections));
  assert.deepEqual(documentPreview('# Only a title\n\nText'), { title: 'Only a title', summary: undefined, status: undefined, sections: [] });
});

test('embedPreview shows the embedded lines, or why it cannot', () => {
  const files: Record<string, string> = { 'src/a.ts': 'one\ntwo\nthree\nfour\n' };
  const read = (p: string) => files[p];
  assert.deepEqual(embedPreview('```ts file="src/a.ts" lines="2-3" {1}', read), {
    file: 'src/a.ts', lang: 'ts', lines: [2, 3], code: 'two\nthree', truncated: false,
  });
  assert.equal(embedPreview('```ts file="src/a.ts"', read, 2)?.code, 'one\ntwo');
  assert.equal(embedPreview('```ts file="src/a.ts"', read, 2)?.truncated, true);
  assert.match(embedPreview('```ts file="src/b.ts"', read)?.problem ?? '', /Cannot read src\/b\.ts/);
  assert.match(embedPreview('```ts file="src/a.ts" lines="3-9"', read)?.problem ?? '', /fewer lines than 3-9/);
  assert.equal(embedPreview('```ts title="x.ts"', read), undefined);
  assert.equal(embedPreview('plain text', read), undefined);
});

test('fuzzyMatch matches characters in order, ignoring case and spaces', () => {
  assert.ok(fuzzyMatch('post orders', 'POST /v1/orders — Create an order'));
  assert.ok(fuzzyMatch('eu', 'Launch in the EU first'));
  assert.ok(fuzzyMatch('', 'anything'));
  assert.ok(!fuzzyMatch('xyz', 'Launch in the EU first'));
});
