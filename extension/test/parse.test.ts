import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSmd, renderSmd } from '../src/core';
import { anchorIds } from '../src/core/links';

const repo = path.join(__dirname, '..', '..');

/** Every .smd file in the repository, outside node_modules. */
function allDocuments(dir = repo, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allDocuments(full, out);
    else if (entry.name.endsWith('.smd')) out.push(full);
  }
  return out;
}

/** The previous implementation: ids read from the rendered HTML. */
function anchorIdsFromHtml(text: string): Set<string> {
  const result = renderSmd(text);
  const ids = new Set(result.headings.map((h) => h.slug));
  const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const m of result.html.matchAll(/\s(?:id|name)="([^"]*)"/g)) ids.add(unescape(m[1]));
  return ids;
}

const EVERY_ID_SOURCE = [
  '---', 'smd: 1', 'title: Guide [x]{#title-span}', 'summary: Read [this]{#summary-span} first', '---', '',
  '# Guide', '## Setup', '## Setup', '### API {#custom-api .wide}', 'Setext heading', '--------------', '',
  ...['note', 'info', 'tip', 'success', 'warning', 'danger', 'question', 'details', 'card', 'box', 'steps', 'agent', 'human', 'timeline']
    .flatMap((name) => [`:::${name}{#c-${name}} Title [t]{#t-${name}} <a id="t-html-${name}"></a>`, 'Body', ':::', '']),
  '::::tabs{#c-tabs} [t]{#t-tabs}', ':::tab{#c-tab} One [t]{#t-tab}', 'x', ':::', '::::', '',
  '::::columns{#c-columns} [t]{#t-columns}', ':::column{#c-column} [t]{#t-column}', 'x', ':::', '::::', '',
  ':::decision{#c-decision status=accepted date=2026-01-01 owner=@a} D [t]{#t-decision}', 'x', ':::', '',
  ':::risk{#c-risk impact=high} R [t]{#t-risk}', 'x', ':::', '',
  ':::api{#c-api method=GET path=/x} A [t]{#t-api}', 'x', ':::', '',
  ':::note{title="Attr [t]{#t-attr}"}', 'x', ':::', '',
  ':::unknownthing{#c-unknown} U [t]{#t-unknown}', 'x', ':::', '',
  'A [span]{#inline-span color=red} and <a id="raw-inline"></a> and <span name="raw-name"></span>.', '',
  '<div id="raw-block" class="x">', 'block', '</div>', '',
  '- [list [item]{#in-list}]', '', '> quote with [q]{#in-quote}', '',
  '```html', '<a id="not-in-code"></a>', '```', '', '`[code]{#not-inline-code}`', '',
  '| a | b |', '| - | - |', '| [c]{#in-table} | d |',
].join('\n');

test('anchor ids from tokens match the ids in the rendered HTML', () => {
  const docs = allDocuments().map((f) => [path.relative(repo, f), fs.readFileSync(f, 'utf8')] as const);
  assert.ok(docs.length >= 10, `found ${docs.length} documents`);
  for (const [name, text] of [...docs, ['every id source', EVERY_ID_SOURCE] as const]) {
    assert.deepEqual([...anchorIds(text)].sort(), [...anchorIdsFromHtml(text)].sort(), name);
  }
  const ids = anchorIds(EVERY_ID_SOURCE);
  for (const id of ['title-span', 'summary-span', 'setup-1', 'custom-api', 'c-agent', 'c-column', 't-risk', 't-tab', 't-attr', 'inline-span', 'raw-block', 'in-table']) {
    assert.ok(ids.has(id), id);
  }
  assert.ok(!ids.has('not-in-code') && !ids.has('not-inline-code'));
  assert.ok(!ids.has('t-steps') && !ids.has('t-html-note'), 'titles that are not rendered, and raw HTML in titles, add no ids');
});

test('incremental parsing matches a full parse through random edits', () => {
  const snippets = [
    '', '', '## Setup', '# Setup', '### API {#api}', 'Setext', '---', ':::note', ':::', '::::tabs', ':::tab A',
    '```', '```js', '~~~', '$$', 'x^2', '$$', '<!-- note', '-->', '<pre>', '</pre>', '<div id="raw">', '</div>',
    '- item', '  continued', '    indented code', '> quote', '[ref]: other.smd', '## [Title][ref]', '## [Other][nope]',
    'A [span]{#s1} and <a name="n1"></a>', '| a | b |', '| - | - |', 'plain text', ':::card{#card} Card',
    'See[^n] and[^M].', '[^n]: Note [in]{#in-note} and[^m]', '    continued [more]{#in-more}', '[^m]: Other.', '## Heading[^n]',
  ];
  const base = allDocuments().map((f) => fs.readFileSync(f, 'utf8')).join('\n\n');
  // Seeded, so a failure is reproducible. 102 once caught a `$$` inserted far below the math it closed.
  for (const start of [20260928, 102]) {
    let seed = start;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
    let text = base;
    for (let step = 0; step < 250; step++) {
      // Each edit applies to the previous version, so parsing is incremental from the second step on.
      const lines = text.split('\n');
      const at = Math.floor(random() * lines.length);
      const op = random();
      if (op < 0.5) lines.splice(at, 0, pick(snippets));
      else if (op < 0.8) lines.splice(at, 1);
      else lines[at] = `${lines[at]} ${pick(['x', '[a]{#e' + step + '}', '`code`', '{#h' + step + '}'])}`;
      text = lines.join('\n');
      const label = `seed ${start}, step ${step}`;
      assert.deepEqual(parseSmd(text).headings, renderSmd(text).headings, label);
      assert.deepEqual([...anchorIds(text)].sort(), [...anchorIdsFromHtml(text)].sort(), label);
    }
  }
});

test('parseSmd returns the same headings as renderSmd and reuses results for the same text', () => {
  for (const f of allDocuments()) {
    const text = fs.readFileSync(f, 'utf8');
    assert.deepEqual(parseSmd(text).headings, renderSmd(text).headings, f);
  }
  const text = '# A\n\n## B\n';
  assert.equal(parseSmd(text), parseSmd(`${text}`), 'cached for equal text');
  assert.notEqual(parseSmd(text), parseSmd(`${text}\n`));
});
