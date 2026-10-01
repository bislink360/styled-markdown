import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import smd from '../src/core/markdownIt';
import {
  agentView, applyFixes, formatSmd, parseSmd, querySmd, renderSmd, smdToMarkdown, validateSmd, type Diagnostic,
} from '../src/core';
import { findRefs, FigureCounter, figureKind } from '../src/core/figures';
import { resetParseCache } from '../src/core/parse';

const corpus = readFileSync(join(__dirname, 'compat', 'corpus', 'figures.smd'), 'utf8');
const codes = (diagnostics: Diagnostic[]) => diagnostics.map((d) => `${d.line}:${d.code}:${d.severity}`);
const body = (html: string) => html.replace(/^<article class="smd-doc">/, '').replace(/<\/article>$/, '');

const doc = [
  'See :ref[fig-b] and :ref[tbl-a].',
  '',
  ':::figure{#fig-a} First *figure*',
  '![A](a.png)',
  ':::',
  '',
  ':::figure{#tbl-a kind=table} Limits',
  '| a |',
  '|---|',
  '| 1 |',
  ':::',
  '',
  ':::figure{#fig-b}',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  ':::',
  '',
].join('\n');

test('figures: a figure renders as <figure> with a numbered caption after its content', () => {
  const html = body(renderSmd(':::figure{#fig-checkout} Checkout **flow**\n![Checkout](checkout.png)\n:::\n').html);
  assert.equal(html, '<figure id="fig-checkout" class="smd-figure smd-figure-figure" data-line="0">\n'
    + '<p data-line="1"><img src="checkout.png" alt="Checkout"></p>\n'
    + '<figcaption class="smd-figure-caption"><span class="smd-figure-label">Figure 1:</span> Checkout <strong>flow</strong></figcaption></figure>\n');
});

test('figures: numbered in document order, one counter per kind; no caption leaves the label alone', () => {
  const html = renderSmd(doc).html;
  assert.match(html, /<figure id="fig-a" class="smd-figure smd-figure-figure"[^>]*>[\s\S]*?<span class="smd-figure-label">Figure 1:<\/span> First <em>figure<\/em>/);
  assert.match(html, /<figure id="tbl-a" class="smd-figure smd-figure-table"[^>]*>[\s\S]*?<span class="smd-figure-label">Table 1:<\/span> Limits/);
  assert.match(html, /<span class="smd-figure-label">Figure 2<\/span><\/figcaption><\/figure>/);
  assert.match(html, /<table data-line="7">[\s\S]*<\/table>\n<\/div><figcaption/);
});

test('figures: :ref[id] shows the number as a link, before or after the figure; unknown ids are marked', () => {
  const html = renderSmd(`${doc}\nAgain :ref[fig-a], and :ref[nope].\n`).html;
  assert.match(html, /See <a class="smd-ref" href="#fig-b">Figure 2<\/a> and <a class="smd-ref" href="#tbl-a">Table 1<\/a>\./);
  assert.match(html, /Again <a class="smd-ref" href="#fig-a">Figure 1<\/a>, and <span class="smd-ref smd-ref-missing" title="No figure with this id">nope<\/span>\./);
});

test('figures: references in captions and other container titles resolve too', () => {
  const html = renderSmd(':::figure{#a} Like :ref[b]\nx\n:::\n\n:::figure{#b}\ny\n:::\n\n:::note See :ref[a]\nz\n:::\n').html;
  assert.match(html, /Figure 1:<\/span> Like <a class="smd-ref" href="#b">Figure 2<\/a>/);
  assert.match(html, /<span>(?:<span class="smd-sr-only">Note: <\/span>)?See <a class="smd-ref" href="#a">Figure 1<\/a><\/span>/);
});

test('figures: the first figure with an id wins; style and class attributes apply', () => {
  const html = renderSmd(':::figure{#a .wide align=center}\nx\n:::\n\n:::figure{#a}\ny\n:::\n\n:ref[a]\n').html;
  assert.match(html, /<figure id="a" class="smd-figure smd-figure-figure smd-u-wide" style="text-align:center" data-line="0">/);
  assert.match(html, /<a class="smd-ref" href="#a">Figure 1<\/a>/);
});

test('figures: :ref stays text in code and after a word character; it needs [id]', () => {
  const html = renderSmd('`:ref[a]` x:ref[a]\n\n```\n:ref[a]\n```\n').html;
  assert.ok(!html.includes('smd-ref'));
  assert.match(html, /<code>:ref\[a\]<\/code> x:ref\[a\]/);
  assert.deepEqual(codes(validateSmd('See :ref{a}.\n')), ['0:directive/content:error', '0:attrs/unknown:warning']);
});

test('figures: kind values and labels', () => {
  assert.equal(figureKind(undefined), 'figure');
  assert.equal(figureKind('Table'), 'table');
  assert.equal(figureKind('chart'), 'figure');
  const counter = new FigureCounter();
  assert.deepEqual([counter.next('listing'), counter.next(undefined), counter.next('listing')].map((f) => f.label), ['Listing 1', 'Figure 1', 'Listing 2']);
});

test('figures: parseSmd lists figures with their numbers and lines, also after an incremental edit', () => {
  resetParseCache();
  const text = `---\ntitle: T\n---\n${doc}`;
  assert.deepEqual(parseSmd(text).figures.map((f) => `${f.line}:${f.label}:${f.id}`), ['5:Figure 1:fig-a', '9:Table 1:tbl-a', '15:Figure 2:fig-b']);
  const edited = text.replace('See', ':::figure{#new}\nnew\n:::\n\nSee');
  assert.deepEqual(parseSmd(edited).figures.map((f) => `${f.line}:${f.label}:${f.id}`),
    ['3:Figure 1:new', '9:Figure 2:fig-a', '13:Table 1:tbl-a', '19:Figure 3:fig-b']);
  resetParseCache();
  assert.deepEqual(parseSmd(edited).figures, parseSmd(edited).figures);
  assert.ok(parseSmd(edited).ids.has('new'));
});

test('figures: findRefs skips code and reports the columns of each directive', () => {
  const refs = findRefs(['a :ref[x] `:ref[y]`', '```', ':ref[z]', '```', '(:ref[ w ])']);
  assert.deepEqual(refs, [
    { id: 'x', line: 0, column: 2, endColumn: 9 },
    { id: 'w', line: 4, column: 1, endColumn: 10 },
  ]);
});

test('figures: markdown-it plugin renders figures and references like renderSmd', () => {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true }).use(smd, { codeFrames: true, headingIds: true, sourceLines: true });
  const env: { smdFigures?: Map<string, unknown> } = {};
  // renderSmd's own instance also wraps tables in a scrolling div and gives header cells scope="col".
  const expected = renderSmd(doc).html.replace('<div class="smd-table-wrap">', '').replace('</table>\n</div>', '</table>\n').replaceAll(' scope="col"', '');
  assert.equal(`<article class="smd-doc">${md.render(doc, env)}</article>`, expected);
  assert.deepEqual([...env.smdFigures!.keys()], ['fig-a', 'tbl-a', 'fig-b']);
  const plain = new MarkdownIt().use(smd).render(':::figure{#f} Cap\nx\n:::\n\n:ref[f]\n');
  assert.equal(plain, '<figure id="f" class="smd-figure smd-figure-figure" data-line="0">\n<p>x</p>\n'
    + '<figcaption class="smd-figure-caption"><span class="smd-figure-label">Figure 1:</span> Cap</figcaption></figure>\n'
    + '<p><a class="smd-ref" href="#f">Figure 1</a></p>\n');
});

test('figures: markdown-it plugin options: no containers leaves references unresolved, no directives leaves them as text', () => {
  const src = ':::figure{#f}\nx\n:::\n\n:ref[f]\n';
  assert.match(new MarkdownIt().use(smd, { containers: false }).render(src), /<span class="smd-ref smd-ref-missing" title="No figure with this id">f<\/span>/);
  assert.match(new MarkdownIt().use(smd, { directives: false }).render(src), /<p>:ref\[f\]<\/p>/);
});

test('figures: agent view tags figures with their number and resolves references', () => {
  const view = agentView(`${doc}\n:ref[nope]\n`, { lineRefs: false }).text;
  assert.match(view, /^See Figure 2 \(fig-b\) and Table 1 \(tbl-a\)\.$/m);
  assert.match(view, /^<figure id="fig-a"> Figure 1: First \*figure\*\n\[image: A\]\n<\/figure>$/m);
  assert.match(view, /^<figure id="tbl-a"> Table 1: Limits\n\|a\|\n\|-\|\n\|1\|\n<\/figure>$/m);
  assert.match(view, /^<figure id="fig-b"> Figure 2\n```mermaid/m);
  assert.match(view, /^:ref\[nope\]$/m);
  const brief = agentView(doc, { brief: true, lineRefs: false }).text;
  assert.match(brief, /<figure id="fig-b"> Figure 2\n\[diagram: graph, 1 lines — see L14-L16\]\n<\/figure>/);
});

test('figures: smd query finds figures by kind, with the references resolved in their view', () => {
  const tables = querySmd(doc, 'figure[kind=table]');
  assert.deepEqual(tables.map((m) => m.attrs.id), ['tbl-a']);
  assert.equal(querySmd(doc, 'figure[kind=figure]').length, 2);
  const [first] = querySmd(':::figure{#a} See :ref[b]\nx\n:::\n\n:::figure{#b}\ny\n:::\n', 'figure[id=a]');
  assert.equal(first.text, '<figure id="a"> Figure 1: See Figure 2 (b)\nx\n</figure>');
});

test('figures: to-md keeps an anchor, the content and a bold numbered caption; references become links', () => {
  assert.equal(smdToMarkdown(doc),
    'See [Figure 2](#fig-b) and [Table 1](#tbl-a).\n\n'
    + '<a id="fig-a"></a>\n\n![A](a.png)\n\n**Figure 1:** First *figure*\n\n'
    + '<a id="tbl-a"></a>\n\n| a |\n|---|\n| 1 |\n\n**Table 1:** Limits\n\n'
    + '<a id="fig-b"></a>\n\n```mermaid\ngraph TD; A-->B\n```\n\n**Figure 2**\n');
  assert.equal(smdToMarkdown(':::figure\nx\n:::\n:ref[nope]\n'), 'x\n\n**Figure 1**\n:ref[nope]\n');
});

test('figures: validation reports duplicate ids and unknown references, with a fix for a close id', () => {
  const src = ':::figure{#fig-checkout}\nx\n:::\n\n:::figure{.a #fig-checkout}\ny\n:::\n\nSee :ref[fig-chekout] and :ref[other] and `:ref[code]`.\n';
  const diagnostics = validateSmd(src);
  assert.deepEqual(codes(diagnostics), ['4:figure/duplicate-id:warning', '8:figure/unknown-ref:warning', '8:figure/unknown-ref:warning']);
  const [duplicate, typo, other] = diagnostics;
  assert.deepEqual([duplicate.column, duplicate.endColumn], [13, 26]);
  assert.match(duplicate.message, /line 1 already has the id "fig-checkout"/);
  assert.match(typo.message, /No figure with id "fig-chekout" in this document — did you mean "fig-checkout"\?/);
  assert.equal(other.fix, undefined);
  assert.match(applyFixes(src, diagnostics).text, /See :ref\[fig-checkout\] and :ref\[other\]/);
});

test('figures: an unknown kind is a figure/kind warning with a fix; other containers keep attrs/value errors', () => {
  const src = ':::figure{kind=tabel}\nx\n:::\n';
  const [kind] = validateSmd(src);
  assert.deepEqual(codes(validateSmd(src)), ['0:figure/kind:warning']);
  assert.match(kind.message, /Invalid kind "tabel" on ":::figure" — did you mean "table"\?/);
  assert.match(applyFixes(src, validateSmd(src)).text, /kind=table/);
  assert.deepEqual(codes(validateSmd(':::risk{impact=hgh}\nx\n:::\n')), ['0:attrs/value:error']);
  assert.deepEqual(codes(validateSmd(':::figure{caption=x}\nx\n:::\n')), ['0:attrs/unknown:warning']);
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('figures: smd validate still exits 0 on a 1.5-era document with an unknown figure kind', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-fig-'));
  try {
    writeFileSync(join(dir, 'old.smd'), '---\nsmd: 1\n---\n\n:::figure{kind=tabel} Limits\n| a |\n| - |\n| 1 |\n:::\n');
    const run = spawnSync(process.execPath, [cli, 'validate', 'old.smd', '--no-mermaid'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /warning .*figure\/kind/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('figures: the compatibility corpus document is valid and formatted', () => {
  assert.deepEqual(validateSmd(corpus), []);
  assert.equal(formatSmd(corpus), corpus);
  assert.equal(formatSmd(':::figure{kind=table #t title="Cap"}\n| a |\n|-|\n| 1 |\n:::\n'),
    ':::figure{#t title="Cap" kind=table}\n| a   |\n| --- |\n| 1   |\n:::\n');
});
