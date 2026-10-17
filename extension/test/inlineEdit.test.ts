import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderSmd, type RenderOptions } from '../src/core';
import { blocksHtml, renderBlocks } from '../src/core/blocks';
import { editInline, scanInline, SPAN, type InlineChange, type InlineItem } from '../src/core/inlineEdit';
import { NAMED_COLORS } from '../src/core/spec';
import { specVersion } from '../src/core/specVersion';
import { shownValues, substituteLine } from '../src/core/variables';
import { exampleDocuments, fuzzCase, prng, type Random } from './fuzz/generate';

/**
 * Inline directives and styled spans for the Block Editor's inline forms (src/core/inlineEdit.ts): the scan finds
 * what rendering numbers, in the same order, over every example, the compatibility corpus and generated documents;
 * code, math and escapes are skipped; an edit changes only the item's own text. Rendering without `inlineIndex`
 * is renderSmd's HTML, and with it only the marks are added.
 *
 *   SMD_FUZZ_RUNS=2000 SMD_FUZZ_SEED=7 npm test     more generated cases, another seed
 */
const RUNS = Number(process.env.SMD_FUZZ_RUNS ?? 300);
const SEED = Number(process.env.SMD_FUZZ_SEED ?? 20261015);

const corpusDir = path.join(__dirname, 'compat', 'corpus');
const examplesDir = path.join(__dirname, '..', '..', 'examples');
const readDir = (dir: string) =>
  fs.readdirSync(dir).filter((f) => f.endsWith('.smd')).sort().map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
const options = (dir?: string): RenderOptions => ({
  today: '2026-10-15',
  readFile: (p) => {
    const file = dir && path.join(dir, p);
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  },
});

const documents = [
  ...readDir(examplesDir).map((d) => ({ ...d, name: `examples/${d.name}`, options: options(examplesDir) })),
  ...readDir(corpusDir).map((d) => ({ ...d, name: `corpus/${d.name}`, options: options(corpusDir) })),
];
const random = prng(SEED);
const seeds = exampleDocuments();
const generated = Array.from({ length: RUNS }, (_, i) => ({ name: `fuzz case ${i} (seed ${SEED})`, text: fuzzCase(random, seeds), options: options() }));
const LINE_BREAK = /\r?\n/;
const MARK = /data-smd-inline="(\d+)"/g;

/** HTML with the inline marks taken out: the attribute on spans, the `<span>` around directives. */
function unmarked(html: string): string {
  let out = html.replaceAll(/(<span class="smd-span[^"]*"[^>]*?) data-smd-inline="\d+"/g, '$1');
  for (let at = out.indexOf('<span data-smd-inline="'); at >= 0; at = out.indexOf('<span data-smd-inline="')) {
    const open = out.indexOf('>', at) + 1;
    let depth = 1;
    let pos = open;
    while (depth > 0) {
      const next = out.indexOf('<span', pos);
      const close = out.indexOf('</span>', pos);
      if (next >= 0 && next < close) {
        depth++;
        pos = next + 5;
      } else {
        depth--;
        pos = close + 7;
      }
    }
    out = out.slice(0, at) + out.slice(open, pos - 7) + out.slice(pos);
  }
  return out;
}

/** Scanned and rendered items of one block agree: name, values, content (front matter variables replaced). */
function agree(items: readonly InlineItem[], rendered: NonNullable<ReturnType<typeof renderBlocks>['blocks'][number]['inline']>, vars: Record<string, unknown>): string | undefined {
  if (items.length !== rendered.length) return `${items.length} scanned, ${rendered.length} rendered`;
  for (const [i, item] of items.entries()) {
    const r = rendered[i];
    if (item.name !== r.name || item.kind !== r.kind) return `item ${i}: ${item.name} scanned, ${r.name} rendered`;
    if (JSON.stringify(item.values) !== JSON.stringify(r.values)) return `item ${i}: values ${JSON.stringify(item.values)} / ${JSON.stringify(r.values)}`;
    const raw = item.content ?? '';
    if (item.kind !== SPAN && raw !== r.content && substituteLine(raw, vars) !== r.content) return `item ${i}: content ${raw} / ${r.content}`;
  }
  return undefined;
}

test('the scan finds every inline directive and span rendering numbers, in order, in every example, corpus and generated document', () => {
  let total = 0;
  for (const doc of [...documents, ...generated]) {
    const r = renderBlocks(doc.text, { ...doc.options, inlineIndex: true });
    const lines = doc.text.split(LINE_BREAK);
    for (const block of r.blocks) {
      const rendered = block.inline ?? [];
      const marks = [...block.html.matchAll(MARK)].map((m) => Number(m[1]));
      assert.deepEqual(marks.slice().sort((a, b) => a - b), rendered.map((_, i) => i), `${doc.name}, line ${block.start + 1}: one mark per item`);
      // `{{name}}` shows the values as the document shows them: spelled as written in spec v2.
      const spec = specVersion(r.frontMatter);
      const problem = agree(scanInline(lines.slice(block.start, block.end), { spec }), rendered, shownValues(r.frontMatter, doc.text, spec));
      assert.equal(problem, undefined, `${doc.name}, lines ${block.start + 1}-${block.end}: ${problem}\n${lines.slice(block.start, block.end).join('\n')}`);
      total += rendered.length;
    }
  }
  assert.ok(total > 80, `the documents have inline items (${total})`);
});

test('every item of the examples and the corpus that is on one line is placed on it', () => {
  for (const doc of documents) {
    const lines = doc.text.split(LINE_BREAK);
    for (const block of renderBlocks(doc.text, { ...doc.options, inlineIndex: true }).blocks) {
      const blockLines = lines.slice(block.start, block.end);
      for (const item of scanInline(blockLines, { spec: specVersion(doc.text) })) {
        // An item whose text runs over a line break (corpus/inline-line-breaks.smd) has no one line to be placed on.
        if (item.content?.includes('\n')) { assert.equal(item.at, undefined); continue; }
        assert.ok(item.at, `${doc.name}, line ${block.start + 1}: ${item.name} is placed`);
        const text = blockLines[item.at.line].slice(item.at.start, item.at.end);
        assert.ok(item.kind === SPAN ? text.startsWith('[') : text.toLowerCase().startsWith(`:${item.name}`), `${doc.name}: ${text}`);
        if (item.at.content) assert.equal(blockLines[item.at.line].slice(item.at.content.start, item.at.content.end), item.content);
        if (item.at.attrs) assert.match(blockLines[item.at.line].slice(item.at.attrs.start, item.at.attrs.end), /^\{.*\}$/);
      }
    }
  }
});

test('rendering without inlineIndex is renderSmd\'s HTML; with it, only the marks are added', () => {
  for (const doc of [...documents, ...generated.slice(0, 100)]) {
    const plain = renderBlocks(doc.text, doc.options);
    assert.ok(plain.blocks.every((b) => b.inline === undefined && !b.html.includes('data-smd-inline')), doc.name);
    const whole = renderSmd(doc.text, doc.options).html;
    assert.equal(blocksHtml(plain), whole, doc.name);
    assert.equal(unmarked(blocksHtml(renderBlocks(doc.text, { ...doc.options, inlineIndex: true }))), whole, doc.name);
  }
});

const names = (lines: string[], allowHtml?: boolean) => scanInline(lines, { allowHtml }).map((i) => `${i.name}:${i.content ?? ''}`);

test('the scan skips code, math, escapes, HTML, link destinations, image text, include blocks and footnote definitions', () => {
  const B = '\\';
  assert.deepEqual(names(['`:badge[a]` ``x :badge[b] `` $x :badge[c]$ :badge[d]']), ['badge:d']);
  assert.deepEqual(names([`${B}:badge[a] ${B}[b]{color=red} :badge[c]`]), ['badge:c']);
  assert.deepEqual(names(['```', ':badge[a]', '```']), []);
  assert.deepEqual(names(['    :badge[a]']), [], 'indented code');
  assert.deepEqual(names(['$$', ':badge[a]', '$$']), []);
  assert.deepEqual(names(['<div>', ':badge[a]', '</div>']), [], 'an HTML block');
  assert.deepEqual(names(['<div>', ':badge[a]', '</div>'], false), ['badge:a'], 'raw HTML off: the lines are text');
  assert.deepEqual(names(['[x](:badge[a]) ![:badge[b]](i.png) [:badge[c]](u)']), ['badge:c'], 'link text, not its destination or image text');
  assert.deepEqual(names([':::include{file="x.smd"}', ':badge[a]', ':::']), []);
  assert.deepEqual(names(['- a :badge[x]', '', '  [^1]: :badge[n]']), ['badge:x']);
  assert.deepEqual(names(['a:badge[x] (:badge[y]) :ref[fig] :unknown[z]']), ['badge:y'], 'a directive after a word, :ref and unknown names are not numbered');
  assert.deepEqual(names([':::note :badge[title]', 'body :badge[b]', ':::']), ['badge:b'], 'a container title is rendered apart');
});

test('the scan places items in lists, quotes, tables, headings, and spans with directives inside', () => {
  const items = scanInline(['> - [**b** :kbd[A]]{color=red} and :due[2026-10-30]']);
  assert.deepEqual(items.map((i) => [i.name, i.at?.start, i.at?.end]), [[SPAN, 4, 30], ['kbd', 11, 18], ['due', 35, 51]]);
  const table = scanInline(['| a | :priority[P1] |', '|---|---|', '| [x]{bg=blue} | :due[2026-10-30] |']);
  assert.deepEqual(table.map((i) => [i.name, i.at?.line, i.at?.start]), [['priority', 0, 6], [SPAN, 2, 2], ['due', 2, 17]]);
  assert.deepEqual(scanInline(['## Done :badge[x] ##']).map((i) => i.at?.start), [8]);
  const multi = scanInline(['a :badge[one', 'two]{color=red}']);
  assert.equal(multi.length, 1);
  assert.equal(multi[0].at, undefined, 'an item over a line break has no place');
  assert.deepEqual(scanInline(['a\r:badge[x]']).map((i) => i.at?.start), [2], 'a lone \\r is a space, as when rendering');
});

test('editInline keeps quotes and order, adds keys where smd fmt puts them, and drops {} only when it may', () => {
  const edit = (line: string, change: InlineChange, n = 0) => editInline(line, scanInline([line])[n], change);
  assert.equal(edit('x :badge[A]{color=red} y', { attrs: { color: 'green' } }), 'x :badge[A]{color=green} y');
  assert.equal(edit(':badge[A]', { attrs: { color: 'blue' } }), ':badge[A]{color=blue}');
  assert.equal(edit(':badge[A]{color=red}', { attrs: { color: null } }), ':badge[A]');
  assert.equal(edit(':progress{value=40}', { attrs: { value: null } }), ':progress{}', 'no brackets: the braces stay');
  assert.equal(edit('[t]{color=red}', { attrs: { color: null } }), '[t]{}', 'a span keeps its braces');
  assert.equal(edit(':metric[42%]{trend=up label=\'Act\'}', { attrs: { label: 'New', delta: '+3%' } }), ':metric[42%]{trend=up label=\'New\' delta="+3%"}');
  assert.equal(edit(':metric[1]{.c trend=up}', { attrs: { label: 'Two words' } }), ':metric[1]{.c label="Two words" trend=up}');
  assert.equal(edit(':due[2026-10-30]', { content: '2026-11-02' }), ':due[2026-11-02]');
  assert.equal(edit(':priority[P1]{.x}', { content: 'P0' }), ':priority[P0]{.x}');
  assert.equal(edit('[a]{color=red} [b]{bg=blue}', { attrs: { bg: 'teal' } }, 1), '[a]{color=red} [b]{bg=teal}');
  assert.equal(edit(':badge[A]', { content: 'two\nlines' }), null);
  assert.equal(edit(':progress{value=4}', { content: 'x' }), null, 'no brackets to put content in');
  // Both kinds of quote are written with \" (1.10), and the edited item reads back with the value.
  assert.equal(edit(':metric[1]{label=x}', { attrs: { label: 'say "hi" it\'s' } }), String.raw`:metric[1]{label="say \"hi\" it's"}`);
  assert.deepEqual(scanInline([String.raw`:metric[1]{label="say \"hi\" it's"}`])[0].values, { label: 'say "hi" it\'s' });
  assert.equal(edit(':badge[A]', { attrs: { color: String.raw`a\"b'c` } }), null, 'a backslash before a quote would read as an escape');
});

/** A random change an item's form could ask for. */
function randomChange(r: Random, item: InlineItem): InlineChange {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)];
  const keys = [...Object.keys(item.values), 'color', 'bg', 'border', 'label'];
  const change: InlineChange = { attrs: { [pick(keys)]: r() < 0.3 ? null : pick([...NAMED_COLORS, 'Two words', '#ff0000', '42%']) } };
  if (item.at?.content && item.kind !== SPAN && r() < 0.5) change.content = pick(['Done', 'P0', '2026-12-01', 'a b', '']);
  return change;
}

test('property: an edit changes only the item\'s own text; the rest of the line and block stay byte-identical', () => {
  const r = prng(SEED + 1);
  let checked = 0;
  for (const doc of [...documents, ...generated]) {
    const lines = doc.text.split(LINE_BREAK);
    for (const block of renderBlocks(doc.text, doc.options).blocks) {
      const blockLines = lines.slice(block.start, block.end);
      const items = scanInline(blockLines);
      items.forEach((item, index) => {
        if (!item.at) return;
        const change = randomChange(r, item);
        const next = editInline(blockLines[item.at.line], item, change);
        if (next === null) return;
        const line = blockLines[item.at.line];
        // Only the item's own text: everything before it and after it on the line is as it was.
        assert.equal(next.slice(0, item.at.start), line.slice(0, item.at.start), doc.name);
        assert.equal(next.slice(next.length - (line.length - item.at.end)), line.slice(item.at.end), doc.name);
        const after = blockLines.slice();
        after[item.at.line] = next;
        const rescanned = scanInline(after);
        // Some values can't be what they ask for (an unbalanced bracket in content): the session refuses those. Here
        // it is enough that the other items are untouched whenever the count holds.
        if (rescanned.length !== items.length) return;
        rescanned.forEach((other, j) => {
          if (j === index) return;
          assert.deepEqual([other.name, other.content, other.values], [items[j].name, items[j].content, items[j].values], `${doc.name}: item ${j} untouched`);
        });
        checked++;
      });
    }
  }
  assert.ok(checked > 80, `edits checked (${checked})`);
});
