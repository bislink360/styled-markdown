import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import MarkdownIt from 'markdown-it';
import smd from '../src/core/markdownIt';
import { agentView, applyFixes, formatSmd, parseSmd, renderSmd, smdToMarkdown, validateSmd } from '../src/core';
import { findFootnotes, footnoteLabelPrefix, maskCodeSpans } from '../src/core/footnotes';
import { completionsAt, hoverAt } from '../src/lspAssist';

const html = (src: string) => renderSmd(src, { today: '2026-01-01' }).html;
const codes = (src: string) => validateSmd(src).map((d) => `${d.line}:${d.code}:${d.severity}`);
const corpus = fs.readFileSync(path.join(__dirname, 'compat', 'corpus', 'footnotes.smd'), 'utf8');

const ref = (n: number, sub = 1) =>
  `<sup class="smd-footnote-ref"><a href="#fn-${n}" id="fnref-${n}${sub > 1 ? `-${sub}` : ''}" data-footnote-ref role="doc-noteref" aria-describedby="footnote-label">${n}</a></sup>`;
const back = (n: number, sub = 1) => {
  const id = sub > 1 ? `${n}-${sub}` : `${n}`;
  return ` <a href="#fnref-${id}" class="smd-footnote-backref" data-footnote-backref role="doc-backlink" aria-label="Back to reference ${id}">↩︎${sub > 1 ? `<sup>${sub}</sup>` : ''}</a>`;
};

test('footnotes: GitHub markup, numbered by first reference, with a back link per reference', () => {
  const src = 'A[^b] b[^a] c[^B].\n\n[^a]: First defined.\n[^b]: Second defined.\n';
  assert.equal(html(src), '<article class="smd-doc">'
    + `<p data-line="0">A${ref(1)} b${ref(2)} c${ref(1, 2)}.</p>\n`
    + '<section class="footnotes smd-footnotes" data-footnotes>\n<h2 id="footnote-label" class="smd-sr-only">Footnotes</h2>\n<ol>\n'
    + `<li id="fn-1">\n<p data-line="3">Second defined.${back(1)}${back(1, 2)}</p>\n</li>\n`
    + `<li id="fn-2">\n<p data-line="2">First defined.${back(2)}</p>\n</li>\n`
    + '</ol>\n</section>\n</article>');
});

test('footnotes: indented lines continue a definition, across paragraphs, lists and code', () => {
  const out = html('Text[^long].\n\n[^long]: First line\n    continued.\n\n    Second paragraph.\n\n    ```js\n    code();\n    ```\n\nAfter.\n');
  assert.match(out, /<li id="fn-1">\n<p data-line="2">First line\ncontinued.<\/p>\n<p data-line="5">Second paragraph.<\/p>\n<div class="smd-code" data-line="7">/);
  assert.match(out, /<\/code><\/pre>\n<\/div>\n <a href="#fnref-1"/,'back links follow a last block that is not a paragraph');
  assert.match(out, /<p data-line="11">After.<\/p>\n<section class="footnotes/, 'an unindented paragraph ends the definition');
});

test('footnotes: undefined, unreferenced, duplicate, code, links and spans behave as on GitHub', () => {
  const out = html('Use[^x] and `[^a]`, [^a](https://e.com), [see [^a]](https://f.com), [^a]{color=red} and [^a].\n\n[^a]: One.\n[^a]: Two.\n[^unused]: Never shown.\n');
  assert.match(out, /Use\[\^x\] and <code>\[\^a\]<\/code>, <a href="https:\/\/e.com">\^a<\/a>, <a href="https:\/\/f.com">see \[\^a\]<\/a>, <span class="smd-span" style="color:var\(--smd-red\)">\^a<\/span> and <sup/);
  assert.match(out, /<li id="fn-1">\n<p data-line="2">One\./);
  assert.doesNotMatch(out, /Two\.|Never shown|fn-2/);
  // Indented four spaces: code, not a definition.
  assert.match(html('A[^a].\n\n    [^a]: code\n'), /<pre data-line="2"><code>\[\^a\]: code/);
  // Labels can't hold spaces; a definition without any reference renders nothing.
  assert.equal(html('A [^a b].\n\n[^a b]: two words\n'), '<article class="smd-doc"><p data-line="0">A [^a b].</p>\n<p data-line="2">[^a b]: two words</p>\n</article>');
  assert.equal(html('[^a]: x\n'), '<article class="smd-doc"></article>');
});

test('footnotes: inside tables, callouts, tabs and headings; heading ids unchanged', () => {
  const out = html('## Plan[^h]\n\n| a |\n|---|\n| x[^t] |\n\n:::note\nIn a note[^c].\n\n[^c]: Defined in the note.\n:::\n\n::::tabs\n:::tab One\nTab[^h].\n:::\n::::\n\n[^h]: H.\n[^t]: T.\n');
  assert.match(out, /<h2 id="planh" data-line="0">Plan<sup class="smd-footnote-ref"><a href="#fn-1" id="fnref-1"/);
  assert.match(out, /<td>x<sup class="smd-footnote-ref"><a href="#fn-2"/);
  assert.match(out, /In a note<sup class="smd-footnote-ref"><a href="#fn-3"/);
  assert.match(out, /<div class="smd-callout-body">\n<p data-line="7">In a note.*<\/p>\n<\/div><\/div>/, 'the definition leaves the callout');
  assert.match(out, /Tab<sup class="smd-footnote-ref"><a href="#fn-1" id="fnref-1-2"/);
  assert.match(out, /<li id="fn-3">\n<p data-line="9">Defined in the note\./);
  // The same slug as before footnotes existed, with or without the definition.
  assert.deepEqual(parseSmd('## Plan[^h]\n\n[^h]: H.\n').headings.map((h) => [h.slug, h.text]), [['planh', 'Plan[^h]']]);
  assert.deepEqual(renderSmd('## Plan[^h]\n').headings.map((h) => [h.slug, h.text]), [['planh', 'Plan[^h]']]);
});

test('footnotes: every render numbers from 1, with a fresh or a reused env', () => {
  const md = new MarkdownIt().use(smd);
  const env = {};
  const first = md.render('A[^z].\n\n[^z]: Z.\n', env);
  assert.equal(md.render('A[^z].\n\n[^z]: Z.\n', env), first);
  assert.deepEqual(Object.keys(env), [], 'nothing is left on the host env');
  assert.match(first, /href="#fn-1"/);
});

test('footnotes: documents without definitions render byte for byte as with footnotes off', () => {
  const docs = ['examples', path.join('extension', 'test', 'compat', 'corpus')]
    .flatMap((dir) => fs.readdirSync(path.join(__dirname, '..', '..', dir)).filter((f) => f.endsWith('.smd')).map((f) => path.join(__dirname, '..', '..', dir, f)))
    .filter((f) => !f.endsWith('footnotes.smd'));
  assert.ok(docs.length >= 5);
  const options = { codeFrames: true, headingIds: true, sourceLines: true, frontMatter: true, today: '2026-01-01' };
  const on = new MarkdownIt({ html: true, linkify: true, typographer: true }).use(smd, options);
  const off = new MarkdownIt({ html: true, linkify: true, typographer: true }).use(smd, { ...options, footnotes: false });
  for (const file of docs) {
    const src = fs.readFileSync(file, 'utf8');
    assert.equal(on.render(src), off.render(src), file);
  }
  assert.equal(on.render('A [^x] b and [^1][^2].'), off.render('A [^x] b and [^1][^2].'));
});

test('markdown-it plugin: footnotes match renderSmd, turn off, and leave markdown-it-footnote alone', () => {
  const plugin = new MarkdownIt({ html: true, linkify: true, typographer: true })
    .use(smd, { codeFrames: true, headingIds: true, sourceLines: true, today: '2026-01-01' });
  const body = corpus.slice(corpus.indexOf('---\n', 4) + 4);
  const expected = html(body).replace('<div class="smd-table-wrap">', '').replace('</table>\n</div>', '</table>\n');
  assert.equal(`<article class="smd-doc">${plugin.render(body)}</article>`, expected, 'renderSmd only adds its table wrapper');
  assert.match(html(body), /<li id="fn-6">/);
  assert.equal(new MarkdownIt().use(smd, { footnotes: false }).render('A[^1].\n\n[^1]: B b.'), '<p>A[^1].</p>\n<p>[^1]: B b.</p>\n');
  assert.match(new MarkdownIt().use(smd).render('A[^1].\n\n[^1]: B.'), /^<p>A<sup class="smd-footnote-ref"><a href="#fn-1" id="fnref-1"/);
  // A host that already renders footnotes (markdown-it-footnote sets this renderer rule) keeps its own.
  const host = new MarkdownIt();
  host.renderer.rules.footnote_ref = () => '<sup>host</sup>';
  host.use(smd);
  assert.equal(host.render('A[^1].\n\n[^1]: B b.'), '<p>A[^1].</p>\n<p>[^1]: B b.</p>\n');
  // Renders without an env (md.renderer.render with undefined).
  const md = new MarkdownIt().use(smd);
  assert.match(md.renderer.render(md.parse('A[^1].\n\n[^1]: B.', {}), md.options, undefined), /<li id="fn-1">/);
});

test('footnotes: the source scanner finds definitions with their extent and skips code', () => {
  const { definitions, references } = findFootnotes(corpus);
  assert.deepEqual(definitions.map((d) => [d.raw, d.line, d.endLine]), [
    ['burst', 27, 27], ['policy', 41, 41], ['retries', 42, 42], ['sre', 43, 49], ['sms-limits', 50, 50], ['staging', 51, 51], ['draft', 54, 54],
  ]);
  assert.deepEqual([...new Set(references.map((r) => r.raw))], ['policy', 'retries', 'SRE', 'sre', 'missing', 'sms-limits', 'burst', 'staging']);
  assert.equal(maskCodeSpans('a `[^x]` ``b`c`` [^y]'), `a${' '.repeat(16)}[^y]`);
  assert.equal(maskCodeSpans('open ` only'), 'open ` only');
  const fenced = '```\n[^a]: x [^b]\n```\n[^d]: y\n\n    ~~~\n    [^e]\n    ~~~\n[^c]\n';
  assert.deepEqual(findFootnotes(fenced).references.map((r) => r.raw), ['c'], 'fences in definitions are code too');
  assert.deepEqual(findFootnotes('> A[^q].\n>\n> [^q]: Quoted.\n').definitions.map((d) => [d.raw, d.line, d.column]), [['q', 2, 4]]);
  assert.deepEqual(codes('> A[^q].\n>\n> [^q]: Quoted.\n'), []);
  assert.equal(footnoteLabelPrefix('see [^re'), 're');
  assert.equal(footnoteLabelPrefix('see [^'), '');
  assert.equal(footnoteLabelPrefix('see [^a] b'), undefined);
  assert.equal(footnoteLabelPrefix('`[^re'), undefined);
});

test('validation: footnote/undefined, footnote/unused and footnote/duplicate', () => {
  assert.deepEqual(codes('A[^retires] and [^a][^b].\n\n[^retries]: R.\n[^a]: A.\n[^A]: again.\n[^old]: O.\n'), [
    '0:footnote/undefined:warning', '0:footnote/undefined:warning', '2:footnote/unused:info', '4:footnote/duplicate:warning', '5:footnote/unused:info',
  ]);
  const fixed = applyFixes('See[^retires].\n\n[^retries]: R.\n', validateSmd('See[^retires].\n\n[^retries]: R.\n'));
  assert.equal(fixed.text, 'See[^retries].\n\n[^retries]: R.\n');
  // Without any definition `[^…]` may be meant literally (a regex class): info only, no fix.
  assert.deepEqual(validateSmd('Match [^a-z] here.').map((d) => [d.code, d.severity, d.fix]), [['footnote/undefined', 'info', undefined]]);
  // Code, links, spans, and fenced code never count; definitions aren't link reference definitions any more.
  assert.deepEqual(codes('`[^x]` [^x](https://e.com) [^x]{color=red}\n\n```\n[^y]\n```\n'), []);
  assert.deepEqual(codes('A[^1][^2].\n\n[^1]: The note.\n[^2]: Note\n'), [], 'no link/undefined-reference or link/missing-file');
  assert.deepEqual(codes(corpus), []);
  // Footnote ids are link targets, as rendered.
  assert.deepEqual(codes('A[^a] [back](#fnref-1) [note](#fn-1) [gone](#fn-2).\n\n[^a]: A.\n'), ['0:link/missing-anchor:warning']);
  assert.deepEqual(validateSmd(corpus, { rules: { 'footnote/*': 'off' } }), []);
});

test('agent view: footnotes as written; a section excerpt adds the definitions it needs', () => {
  const full = agentView(corpus).text;
  assert.match(full, /Retries are capped at five\[\^retries\], as the SRE review asked\[\^SRE\]\./);
  assert.match(full, /\[\^sre\]: SRE review, 2026-09-12\.\n {4}Lines indented by 4 spaces continue the footnote\.\n\n {4}A second paragraph/);
  assert.doesNotMatch(full, /Footnotes referenced above/);

  const excerpt = agentView(corpus, { sections: ['Retry policy'] }).text;
  const notes = excerpt.slice(excerpt.indexOf('Footnotes referenced above:\n'));
  assert.ok(notes.length > 30, 'listed after the section');
  assert.deepEqual([...notes.matchAll(/^\[\^([\w-]+)\]:/gm)].map((m) => m[1]), ['policy', 'retries', 'sre', 'sms-limits', 'staging']);
  assert.match(notes, /\n {4}- jitter is ±20%\n\[\^sms-limits\]/);
  assert.doesNotMatch(notes, /burst|draft/, 'defined inside the section, or never referenced');

  // Not repeated when the section holds them, and never taken from a skipped section.
  assert.doesNotMatch(agentView(corpus, { sections: ['Notes'] }).text, /Footnotes referenced above/);
  const skipped = '## Intro\n\nText[^s] and[^k].\n\n## Notes\n\n[^k]: Kept.\n\n## Private {agent=skip}\n\n[^s]: Secret.\n';
  const view = agentView(skipped, { sections: ['Intro'] }).text;
  assert.match(view, /Footnotes referenced above:\n\[\^k\]: Kept\.\n$/);
  assert.doesNotMatch(view, /Secret/);
});

test('to-md keeps footnotes; fmt leaves definitions as written', () => {
  const src = 'Text[^1] and more[^note].\n\n[^1]: One.\n[^note]: Two\n    continued.\n\n    Second paragraph.\n';
  assert.equal(smdToMarkdown(src), src);
  assert.equal(formatSmd(src), src);
  assert.equal(formatSmd(corpus), corpus);
  assert.equal(formatSmd(formatSmd(corpus)), corpus);
});

test('editor assistance: hover shows a footnote, completion offers labels after [^', () => {
  const src = 'See[^sre] and [^\n\n[^sre]: SRE review.\n    Continued.\n[^Retries]: R.\n';
  assert.deepEqual(hoverAt(src, 0, 5), { markdown: '**[^sre]**\n\nSRE review.\nContinued.', start: 3, end: 9 });
  assert.equal(hoverAt(src, 2, 2), undefined, 'not on the definition itself');
  assert.deepEqual(completionsAt(src, 0, 16), { from: 16, items: [{ label: 'sre', kind: 18 }, { label: 'Retries', kind: 18 }] });
  assert.equal(completionsAt('No footnotes [^', 0, 15), undefined);
});
