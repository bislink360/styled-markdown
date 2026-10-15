import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSmd, validateSmd } from '../src/core';
import { segmentSmd } from '../src/core/blocks';
import { blockTemplate, blockTemplates, type Snippet } from '../src/core/templates';
import snippets from '../snippets/smd.json';

/** The block editor's templates (src/core/templates.ts), made from the extension's snippets. */

const TODAY = '2026-10-14';
const templates = blockTemplates(snippets as Record<string, Snippet>, TODAY);
const byName = (name: string) => templates.find((t) => t.name === name)!;

test('every block snippet is a template; inline snippets and front matter are not', () => {
  const names = templates.map((t) => t.name);
  for (const name of ['Callout', 'Tabs', 'Columns', 'Mermaid flowchart', 'Math block', 'Task list', 'Table', 'Decision', 'API endpoint', 'Changelog', 'Section hidden from agents']) {
    assert.ok(names.includes(name), name);
  }
  for (const name of ['Front matter', 'Badge', 'Colored text', 'Figure reference', 'Metric', 'Priority', 'Due date']) assert.ok(!names.includes(name), name);
});

test('templates are canonical: formatSmd gives each one back unchanged', () => {
  for (const t of templates) {
    assert.equal(formatSmd(t.text), t.text, t.name);
    assert.ok(t.text.endsWith('\n') && !t.text.endsWith('\n\n'), t.name);
  }
});

test('each template is one block, and valid', () => {
  for (const t of templates) {
    const blocks = segmentSmd(t.text).filter((s) => s.kind === 'block');
    assert.equal(blocks.length, 1, `${t.name}: ${JSON.stringify(t.text)}`);
    // Embeds and includes name files this test doesn't have; everything else is clean.
    const file = 'line\n'.repeat(30);
    const errors = validateSmd(t.text, { today: TODAY, fileExists: () => true, readFile: () => file }).filter((d) => d.severity === 'error');
    assert.deepEqual(errors.map((d) => d.code), [], t.name);
  }
});

test('the selection is the first placeholder’s default', () => {
  const selected = (name: string) => {
    const t = byName(name);
    return t.text.slice(t.select.from, t.select.to);
  };
  assert.equal(selected('Callout'), 'note');
  assert.equal(selected('Details'), 'Summary');
  assert.equal(selected('Tabs'), 'First');
  assert.equal(selected('Mermaid sequence'), 'A');
  assert.equal(selected('Code with title'), 'ts');
  // Formatting moved these: the table's cells are padded, the changelog gains blank lines.
  assert.equal(selected('Table'), 'Column');
  assert.equal(selected('API endpoint'), 'GET');
  assert.equal(selected('Changelog'), 'Release history');
  // $0 only: an empty selection where it was.
  const math = byName('Math block');
  assert.deepEqual(math.select, { from: 3, to: 3 });
  assert.equal(math.text, '$$\n\n$$\n');
});

test('placeholders become their defaults: first choices, mirrors and today’s date', () => {
  assert.equal(byName('Callout').text, ':::note Title\nContent\n:::\n');
  assert.equal(byName('Decision').text, ':::decision{status=proposed date=2026-10-14 owner=@owner} What we decided\nWhy, and the alternatives considered.\n:::\n');
  assert.match(byName('Mermaid sequence').text, /\n {4}A->>B: Request\n {4}B-->>A: Response\n/);
  assert.match(byName('Changelog').text, /^## 1\.1\.0 — 2026-10-14$/m);
  assert.equal(byName('Table').text, '| Column | Column |\n| ------ | ------ |\n|        |        |\n');
});

test('blockTemplate: a string body, and inline snippets', () => {
  assert.deepEqual(blockTemplate('Heading', { body: '## ${1:Title}' }, TODAY), { name: 'Heading', text: '## Title\n', select: { from: 3, to: 8 } });
  assert.equal(blockTemplate('Badge', { body: ':badge[${1:x}]' }, TODAY), null);
  assert.equal(blockTemplate('Empty', { body: ['', '$0'] }, TODAY), null);
});
