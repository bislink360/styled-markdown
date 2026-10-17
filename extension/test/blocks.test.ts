import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderSmd, type RenderOptions } from '../src/core';
import { blocksHtml, renderBlocks, segmentSmd, type Segment } from '../src/core/blocks';
import { exampleDocuments, fuzzCase, prng } from './fuzz/generate';

/**
 * The block editor's segments and per-block rendering (src/core/blocks.ts). Two properties over every example,
 * the compatibility corpus and generated documents: the segments cover every line once, in order (inside each
 * container too), and the blocks rendered one by one make exactly renderSmd's HTML.
 *
 *   SMD_FUZZ_RUNS=2000 SMD_FUZZ_SEED=7 npm test     more generated cases, another seed
 */
const RUNS = Number(process.env.SMD_FUZZ_RUNS ?? 300);
const SEED = Number(process.env.SMD_FUZZ_SEED ?? 20261014);

const corpusDir = path.join(__dirname, 'compat', 'corpus');
const examplesDir = path.join(__dirname, '..', '..', 'examples');
const readDir = (dir: string) =>
  fs.readdirSync(dir).filter((f) => f.endsWith('.smd')).sort().map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));

const fuzzFiles: Record<string, string> = { 'src/pricing.ts': 'export const a = 1;\nexport const b = 2;\n' };
const options = (dir?: string): RenderOptions => ({
  today: '2026-10-14',
  readFile: (p) => {
    if (fuzzFiles[p] !== undefined) return fuzzFiles[p];
    if (!dir) return undefined;
    const file = path.join(dir, p);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  },
});

const documents = [
  ...readDir(examplesDir).map((d) => ({ ...d, name: `examples/${d.name}`, options: options(examplesDir) })),
  ...readDir(corpusDir).map((d) => ({ ...d, name: `corpus/${d.name}`, options: options(corpusDir) })),
];
const random = prng(SEED);
const seeds = exampleDocuments();
const generated = Array.from({ length: RUNS }, (_, i) => ({ name: `fuzz case ${i} (seed ${SEED})`, text: fuzzCase(random, seeds), options: options() }));

/** What is wrong with segments over [from, to) of `lines`, or undefined. */
function coverageProblem(segments: readonly Segment[], lines: readonly string[], from: number, to: number): string | undefined {
  let at = from;
  for (const s of segments) {
    if (s.start !== at) return `segment ${s.key} starts at ${s.start}, expected ${at}`;
    if (s.end <= s.start) return `segment ${s.key} is empty (${s.start}-${s.end})`;
    at = s.end;
    if (s.children) {
      if (s.bodyStart !== s.start + 1 || s.bodyEnd === undefined || s.bodyEnd > s.end) return `container ${s.key} has body ${s.bodyStart}-${s.bodyEnd}`;
      const problem = coverageProblem(s.children, lines, s.bodyStart, s.bodyEnd);
      if (problem) return `in container at line ${s.start}: ${problem}`;
    }
  }
  if (at !== to) return `segments end at ${at}, expected ${to}`;
  if (segments.flatMap((s) => lines.slice(s.start, s.end)).join('\n') !== lines.slice(from, to).join('\n')) return 'lines differ';
  return undefined;
}

const allKeys = (segments: readonly Segment[]): string[] => segments.flatMap((s) => [s.key, ...allKeys(s.children ?? [])]);

test('segments cover every line once, in order, in every example, corpus and generated document', () => {
  for (const doc of [...documents, ...generated]) {
    const lines = doc.text.split(/\r?\n/);
    const segments = segmentSmd(doc.text, doc.options);
    const problem = coverageProblem(segments, lines, 0, lines.length);
    assert.equal(problem, undefined, `${doc.name}: ${problem}\n${JSON.stringify(doc.text)}`);
    const keys = allKeys(segments);
    assert.equal(new Set(keys).size, keys.length, `${doc.name}: keys are unique`);
  }
});

test('the blocks rendered one by one make exactly renderSmd’s HTML', () => {
  for (const doc of [...documents, ...generated]) {
    const blocks = renderBlocks(doc.text, doc.options);
    assert.equal(blocksHtml(blocks), renderSmd(doc.text, doc.options).html, `${doc.name}\n${JSON.stringify(doc.text)}`);
  }
});

test('renderBlocks returns what renderSmd does besides the HTML, and blocks match the block segments', () => {
  const doc = documents.find((d) => d.name === 'examples/showcase.smd')!;
  const blocks = renderBlocks(doc.text, doc.options);
  const whole = renderSmd(doc.text, doc.options);
  assert.deepEqual(blocks.headings, whole.headings);
  assert.deepEqual(blocks.frontMatter, whole.frontMatter);
  assert.equal(blocks.lang, whole.lang);
  const blockSegments = blocks.segments.filter((s) => s.kind === 'block');
  assert.deepEqual(blocks.blocks.map((b) => [b.key, b.start, b.end]), blockSegments.map((s) => [s.key, s.start, s.end]));
  assert.ok(blocks.blocks.every((b) => b.html.length > 0));
  assert.match(blocks.header, /^<header class="smd-doc-header"/);
  assert.match(blocks.toc, /^<nav class="smd-toc"/);
  assert.match(blocks.open, /^<article class="smd-doc" style="--smd-accent:/);
});

/** [kind/type/container, start, end] of each segment, children nested. */
type Shape = [string, number, number, Shape[]?];
const shape = (segments: readonly Segment[]): Shape[] =>
  segments.map((s) => {
    let label: string = s.kind;
    if (s.kind === 'block') label = s.container ? `${s.type}:${s.container}` : s.type!;
    return s.children ? [label, s.start, s.end, shape(s.children)] : [label, s.start, s.end];
  });

test('segments: front matter, blocks and the gaps between them', () => {
  const text = ['---', 'title: T', '---', '', '# Heading', 'Paragraph', 'more', '', '```ts', 'code', '```', '', '---', ''].join('\n');
  assert.deepEqual(shape(segmentSmd(text)), [
    ['frontmatter', 0, 3], ['gap', 3, 4], ['heading', 4, 5], ['paragraph', 5, 7], ['gap', 7, 8], ['fence', 8, 11], ['gap', 11, 12],
    ['hr', 12, 13], ['gap', 13, 14],
  ]);
});

test('segments: lists and block quotes stop at their last non-blank line', () => {
  const text = ['- a', '', '- b', '', '', '> q', '>', '', 'text'].join('\n');
  assert.deepEqual(shape(segmentSmd(text)), [['list', 0, 3], ['gap', 3, 5], ['blockquote', 5, 7], ['gap', 7, 8], ['paragraph', 8, 9]]);
});

test('segments: a closed container takes its closing line; its children cover its body', () => {
  const text = [':::note Title', 'Text', '', '- item', ':::', 'After'].join('\n');
  assert.deepEqual(shape(segmentSmd(text)), [
    ['container:note', 0, 5, [['paragraph', 1, 2], ['gap', 2, 3], ['list', 3, 4]]],
    ['paragraph', 5, 6],
  ]);
  const [note] = segmentSmd(text);
  assert.equal(note.bodyStart, 1);
  assert.equal(note.bodyEnd, 4);
});

test('segments: nested containers, and an unclosed one running to the end of its parent', () => {
  const text = ['::::tabs', ':::tab One', 'A', ':::', ':::tab Two', 'B', ':::', '::::', '', 'After'].join('\n');
  assert.deepEqual(shape(segmentSmd(text)), [
    ['container:tabs', 0, 8, [['container:tab', 1, 4, [['paragraph', 2, 3]]], ['container:tab', 4, 7, [['paragraph', 5, 6]]]]],
    ['gap', 8, 9], ['paragraph', 9, 10],
  ]);
  // Colon counts are cosmetic: with the second tab's ::: missing, :::: closes the tab and the tabs run to the end.
  const missing = ['::::tabs', ':::tab One', 'A', ':::', ':::tab Two', 'B', '::::', '', 'After'].join('\n');
  assert.deepEqual(shape(segmentSmd(missing)), [
    ['container:tabs', 0, 9, [
      ['container:tab', 1, 4, [['paragraph', 2, 3]]], ['container:tab', 4, 7, [['paragraph', 5, 6]]], ['gap', 7, 8], ['paragraph', 8, 9],
    ]],
  ]);
  // A container inside one that is never closed is not closed either: both run to the end.
  const unclosed = [':::note', ':::tip', 'Text', '', ''].join('\n');
  // (The empty line after the last line break is not a line to markdown-it, so it stays outside.)
  assert.deepEqual(shape(segmentSmd(unclosed)), [
    ['container:note', 0, 4, [['container:tip', 1, 4, [['paragraph', 2, 3], ['gap', 3, 4]]]]], ['gap', 4, 5],
  ]);
  const [note] = segmentSmd(unclosed);
  assert.deepEqual([note.bodyEnd, note.children![0].bodyEnd], [4, 4]);
});

test('segments: an empty container has an empty body and no children', () => {
  const [box] = segmentSmd(':::box\n:::\n');
  assert.deepEqual([box.start, box.end, box.bodyStart, box.bodyEnd, box.children], [0, 2, 1, 1, []]);
});

test('segments: reference and footnote definitions are gaps; footnotes render in the tail', () => {
  const text = ['Text[^1] and [a link][r].', '', '[^1]: The note.', '', '[r]: https://example.com', ''].join('\n');
  assert.deepEqual(shape(segmentSmd(text)), [['paragraph', 0, 1], ['gap', 1, 6]]);
  const r = renderBlocks(text);
  assert.equal(r.blocks.length, 1);
  assert.match(r.tail, /<section[^>]*footnotes/);
  assert.doesNotMatch(r.blocks[0].html, /footnotes/);
});

test('segments: an :::include is one block on its own lines; what it includes adds no segments', () => {
  const text = [':::include{file="terms.smd"}', 'Fallback', ':::', 'After'].join('\n');
  const readFile = (p: string) => (p === 'terms.smd' ? '# Terms\n\nIncluded text.\n\n- one\n' : undefined);
  const included = segmentSmd(text, { readFile });
  assert.deepEqual(shape(included), [['container:include', 0, 3, [['gap', 1, 2]]], ['paragraph', 3, 4]]);
  // Without the file the body is the fallback, and a block.
  assert.deepEqual(shape(segmentSmd(text)), [['container:include', 0, 3, [['paragraph', 1, 2]]], ['paragraph', 3, 4]]);
  const r = renderBlocks(text, { readFile });
  assert.match(r.blocks[0].html, /Included text/);
  assert.equal(blocksHtml(r), renderSmd(text, { readFile }).html);
});

test('segments: a changelog’s entries are its children', () => {
  const text = [':::changelog Releases', '## 1.1.0 — 2026-03-01', '- Added', '', '## 1.0.0 — 2026-01-15', '- First', ':::'].join('\n');
  assert.deepEqual(shape(segmentSmd(text)), [
    ['container:changelog', 0, 7, [['heading', 1, 2], ['list', 2, 3], ['gap', 3, 4], ['heading', 4, 5], ['list', 5, 6]]],
  ]);
});

test('segments: CRLF and lone CR keep their line numbers', () => {
  const lf = ['# A', '', 'Para', 'x\ry', '', ':::note', 'N', ':::', ''];
  const expected = shape(segmentSmd(lf.join('\n')));
  assert.deepEqual(shape(segmentSmd(lf.join('\r\n'))), expected);
  assert.deepEqual(expected, [['heading', 0, 1], ['gap', 1, 2], ['paragraph', 2, 4], ['gap', 4, 5], ['container:note', 5, 8, [['paragraph', 6, 7]]], ['gap', 8, 9]]);
  // A lone CR is a space to the renderer, so a line of it is blank.
  assert.deepEqual(shape(segmentSmd('- a\n\r\nText')), [['list', 0, 1], ['gap', 1, 2], ['paragraph', 2, 3]]);
});

test('segments: front matter that is never closed is not front matter; invalid YAML still is, and shows in the header', () => {
  assert.deepEqual(shape(segmentSmd('---\ntitle: x\n')).map((s) => s[0]).includes('frontmatter'), false);
  assert.deepEqual(shape(segmentSmd('---\n: [bad\n---\nText\n')), [['frontmatter', 0, 3], ['paragraph', 3, 4], ['gap', 4, 5]]);
  // Since 2.0 its lines are not hidden: the header (where the Block Editor shows the front matter) has them as written.
  const r = renderBlocks('---\n: [bad\n---\nText\n');
  assert.match(r.header, /^<div class="smd-frontmatter-error" role="note"[^>]*>.*<code>: \[bad<\/code><\/pre><\/div>\n$/s);
  assert.equal(blocksHtml(r), renderSmd('---\n: [bad\n---\nText\n').html);
});

test('keys: unchanged blocks keep their keys when another block changes; duplicates are numbered', () => {
  const before = ['# A', '', 'Same', '', 'Edited', '', 'Same', ''].join('\n');
  const after = ['# A', '', 'Same', '', 'Edited!', '', 'Same', ''].join('\n');
  const a = segmentSmd(before).filter((s) => s.kind === 'block');
  const b = segmentSmd(after).filter((s) => s.kind === 'block');
  assert.equal(a[0].key, b[0].key);
  assert.equal(a[1].key, b[1].key);
  assert.notEqual(a[2].key, b[2].key);
  assert.equal(a[3].key, b[3].key);
  assert.equal(a[1].key.split('#')[0], a[3].key.split('#')[0]);
  assert.deepEqual([a[1].key.split('#')[1], a[3].key.split('#')[1]], ['0', '1']);
});
