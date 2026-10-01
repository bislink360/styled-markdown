import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import MarkdownIt from 'markdown-it';
import smd from '../src/core/markdownIt';
import { agentView, buildSite, formatSmd, renderSmd, smdToMarkdown, validateSmd, type Diagnostic } from '../src/core';
import { INCLUDE_LIMITS, includePath, rebaseUrl } from '../src/core/include';
import { findLinks, linkAt, linkCompletionContext, pathCompletionContext } from '../src/core/links';
import { readerFor } from '../src/workspace';

/** A reader over in-memory files, by a path relative to the root document (as the hosts' readers are). */
const reader = (files: Record<string, string>) => (p: string): string | undefined => files[p];

const TERMS = [
  '---', 'title: Terms', '---', '# Terms', '', '## Pricing', '', 'Plans are **monthly**. See [refunds](#refunds), [the FAQ](faq.smd) and ![logo](img/logo.png).', '',
  '- [ ] Publish discounts', '', '```ts file="code.ts"', '```', '', '### Discounts', '', 'Ten percent.', '', '## Refunds', '', 'Within 30 days.', '',
].join('\n');

const FILES = {
  'shared/terms.smd': TERMS,
  'shared/code.ts': 'export const price = 10;\n',
  'shared/nested.smd': ':::include{file="deeper/leaf.smd"}\n:::\n',
  'shared/deeper/leaf.smd': '## Leaf\n\nFrom the leaf.\n',
  'loop/a.smd': 'In A.\n\n:::include{file="b.smd"}\n:::\n',
  'loop/b.smd': 'In B.\n\n:::include{file="a.smd"}\n:::\n',
};
const readFile = reader(FILES);

const ids = (html: string) => [...html.matchAll(/<h\d id="([^"]+)"/g)].map((m) => m[1]);
const codes = (d: Diagnostic[]) => d.map((x) => `${x.line}:${x.code}:${x.severity}`);

test('include: a whole document is rendered in place of the block, without its front matter', () => {
  const html = renderSmd(':::include{file="shared/terms.smd"}\nFallback.\n:::\n', { readFile }).html;
  assert.match(html, /^<article class="smd-doc"><div class="smd-include" data-line="0" data-include="shared\/terms.smd">\n<h1 id="terms" data-line="0">Terms<\/h1>/);
  assert.match(html, /<strong>monthly<\/strong>/);
  assert.match(html, /<h2 id="refunds" data-line="0">Refunds<\/h2>/);
  assert.doesNotMatch(html, /Fallback|title: Terms/);
});

test('include: section="…" takes one section with its subsections; level=N moves its headings', () => {
  const html = renderSmd('## Prices\n\n:::include{file="shared/terms.smd" section="Pricing" level=3}\n:::\n', { readFile }).html;
  assert.deepEqual([...html.matchAll(/<(h\d) id="([^"]+)"/g)].map((m) => `${m[1]}#${m[2]}`), ['h2#prices', 'h3#pricing', 'h4#discounts']);
  assert.match(html, /data-include="shared\/terms.smd § Pricing"/);
  assert.doesNotMatch(html, /Refunds|Within 30 days/);
  // By id too, and an exact id wins over a heading that merely contains the text.
  assert.match(renderSmd(':::include{file="shared/terms.smd" section="#discounts"}\n:::\n', { readFile }).html, /<h3 id="discounts" data-line="0">Discounts<\/h3>\n<p data-line="0">Ten percent.<\/p>\n<\/div>/);
});

test('include: links, images and code embeds in included text still point where they did', () => {
  const html = renderSmd(':::include{file="shared/terms.smd"}\n:::\n', { readFile }).html;
  assert.match(html, /<a href="shared\/faq.smd">the FAQ<\/a>/);
  assert.match(html, /<img src="shared\/img\/logo.png" alt="logo">/);
  assert.match(html, /<div class="smd-code-title">shared\/code.ts<\/div>/);
  assert.match(html, /price/);
  // Tasks in included text can't be toggled from this document.
  assert.match(html, /<input type="checkbox" class="smd-task-box" disabled>Publish discounts/);
  assert.equal(rebaseUrl('../img/a.png?x#y', 'shared/deep'), 'shared/img/a.png?x#y');
  assert.equal(rebaseUrl('https://example.com/a', 'shared'), 'https://example.com/a');
  assert.equal(rebaseUrl('#top', 'shared'), '#top');
  assert.equal(includePath('shared', '../b/./c.smd'), 'b/c.smd');
  assert.equal(includePath('', '../x.smd'), '../x.smd');
});

test('include: the document keeps its own heading ids; included ones are numbered around them', () => {
  const doc = '# Doc\n\n## Pricing\n\n:::include{file="shared/terms.smd"}\n:::\n\n## Refunds\n\nSee [ours](#refunds).\n';
  const own = ids(renderSmd(doc).html);
  const html = renderSmd(doc, { readFile }).html;
  assert.deepEqual(own, ['doc', 'pricing', 'refunds']);
  assert.deepEqual(ids(html), ['doc', 'pricing', 'terms', 'pricing-1', 'discounts', 'refunds-1', 'refunds']);
  // The included link to its own Refunds section follows the renamed id; the document's own link doesn't change.
  assert.match(html, /<a href="#refunds-1">refunds<\/a>/);
  assert.match(html, /<a href="#refunds">ours<\/a>/);
  // The headings list (table of contents, outline) has them in document order, at the include's line.
  const headings = renderSmd(doc, { readFile }).headings.map((h) => `${h.level}:${h.slug}:${h.line}`);
  assert.deepEqual(headings, ['1:doc:0', '2:pricing:2', '1:terms:4', '2:pricing-1:4', '3:discounts:4', '2:refunds-1:4', '2:refunds:7']);
});

test('include: nested includes resolve relative to the file they are written in', () => {
  const html = renderSmd(':::include{file="shared/nested.smd"}\n:::\n', { readFile }).html;
  assert.match(html, /data-include="shared\/nested.smd">\n<div class="smd-include" data-line="0" data-include="shared\/deeper\/leaf.smd">\n<h2 id="leaf" data-line="0">Leaf<\/h2>/);
});

test('include: a cycle shows a note where it repeats, including a document that includes itself', () => {
  const html = renderSmd(':::include{file="loop/a.smd"}\n:::\n', { readFile }).html;
  assert.match(html, /In A[\s\S]*In B[\s\S]*Include cycle \(loop\/a.smd → loop\/b.smd → loop\/a.smd\): <a href="loop\/a.smd">loop\/a.smd<\/a>/);
  assert.equal((html.match(/In A/g) ?? []).length, 1);
  const self = 'Me.\n\n:::include{file="me.smd"}\nSee me.\n:::\n';
  const selfHtml = renderSmd(self, { readFile: reader({ 'me.smd': self }) }).html;
  assert.match(selfHtml, /Include cycle \(this document → me.smd\)/);
  assert.match(selfHtml, /<p data-line="3">See me.<\/p>/);
});

test('include: nesting deeper than the limit, or too much text, stops with a note', () => {
  const chain: Record<string, string> = {};
  for (let i = 0; i < 12; i++) chain[`d${i}.smd`] = `Level ${i}\n\n:::include{file="d${i + 1}.smd"}\n:::\n`;
  const deep = renderSmd(':::include{file="d0.smd"}\n:::\n', { readFile: reader(chain) }).html;
  assert.match(deep, new RegExp(`Level ${INCLUDE_LIMITS.depth - 1}\\b`));
  assert.doesNotMatch(deep, new RegExp(`Level ${INCLUDE_LIMITS.depth}\\b`));
  assert.match(deep, /Includes nested more than 8 deep: <a href="d8.smd">d8.smd<\/a>/);
  const big = renderSmd(':::include{file="big.smd"}\n:::\n', { readFile: reader({ 'big.smd': 'x'.repeat(INCLUDE_LIMITS.chars + 1) }) }).html;
  assert.match(big, /Too much included content/);
});

test('include: without a reader, or when the file is missing, the fallback body shows under a note with a link', () => {
  const doc = ':::include{file="shared/terms.smd" section="Pricing"}\nSee [the terms](shared/terms.smd).\n:::\n';
  assert.equal(renderSmd(doc).html, '<article class="smd-doc"><div class="smd-include smd-include-missing" data-line="0">' +
    '<div class="smd-include-note">Include not available here: <a href="shared/terms.smd#pricing">shared/terms.smd § Pricing</a></div>\n' +
    '<p data-line="1">See <a href="shared/terms.smd">the terms</a>.</p>\n</div>\n</article>');
  assert.match(renderSmd(':::include{file="nope.smd"}\n:::\n', { readFile }).html, /Cannot read the file: <a href="nope.smd">nope.smd<\/a>/);
  assert.match(renderSmd(':::include{file="shared/terms.smd" section="Nope"}\n:::\n', { readFile }).html, /No section &quot;Nope&quot; in the file/);
  assert.match(renderSmd(':::include\n:::\n', { readFile }).html, /:::include needs a file/);
  // A URL is never linked from the note.
  assert.match(renderSmd(':::include{file="javascript:alert(1)"}\n:::\n').html, /<code>javascript:alert\(1\)<\/code>/);
});

test('include: files outside the sandboxed reader are refused, and validation says why', () => {
  const corpus = path.join(__dirname, 'compat', 'corpus');
  const doc = path.join(corpus, 'doc.smd');
  const text = ':::include{file="../../../README.md"}\n:::\n';
  const sandboxed = readerFor(doc, [corpus]);
  assert.ok(fs.existsSync(path.join(corpus, '../../../README.md')));
  assert.match(renderSmd(text, { readFile: sandboxed }).html, /Cannot read the file/);
  const exists = (rel: string) => fs.existsSync(path.resolve(corpus, rel));
  assert.deepEqual(codes(validateSmd(text, { readFile: sandboxed, fileExists: exists })), ['0:include/outside-workspace:warning']);
  // Inside the sandbox the corpus document includes its neighbour.
  assert.match(renderSmd(fs.readFileSync(path.join(corpus, 'include.smd'), 'utf8'), { readFile: sandboxed }).html, /Refunds within 30 days/);
});

test('include: validation reports missing files and sections, cycles, depth and bad attributes as warnings', () => {
  const doc = [
    ':::include{file="nope.smd"}', ':::', '',
    ':::include{file="shared/terms.smd" section="Nope"}', ':::', '',
    ':::include{file="loop/a.smd"}', ':::', '',
    ':::include{file="shared/terms.smd" level=9}', ':::', '',
    ':::include', ':::', '',
    '[ok](#pricing) [bad](#nowhere)', '',
    ':::include{file="shared/terms.smd"}', ':::', '',
  ].join('\n');
  const exists = (p: string) => p in FILES;
  const found = validateSmd(doc, { readFile, fileExists: exists });
  assert.deepEqual(codes(found), [
    '0:include/missing-file:warning', '3:include/missing-section:warning', '6:include/cycle:warning', '9:attrs/value:warning',
    '12:attrs/required:warning', '15:link/missing-anchor:warning',
  ]);
  assert.equal(found[2].message, 'Include cycle: loop/a.smd → loop/b.smd → loop/a.smd. The repeated include shows its fallback instead.');
  assert.deepEqual([found[0].column, found[0].endColumn], [17, 25]);
  // Without a reader only the attributes and, with fileExists, missing files are checked.
  assert.deepEqual(codes(validateSmd(doc, { fileExists: exists })).filter((c) => c.includes('include/')), ['0:include/missing-file:warning']);
  // Depth: a chain longer than the limit.
  const chain: Record<string, string> = {};
  for (let i = 0; i < 12; i++) chain[`d${i}.smd`] = `:::include{file="d${i + 1}.smd"}\n:::\n`;
  assert.deepEqual(codes(validateSmd(':::include{file="d0.smd"}\n:::\n', { readFile: reader(chain) })), ['0:include/depth:warning']);
  // The include file is not also reported as a missing link target.
  assert.ok(!found.some((d) => d.code === 'link/missing-file'));
});

test('include: the agent view inlines included text in an <included> block, or points to the file', () => {
  const doc = '# Doc\n\n:::include{file="shared/terms.smd" section="Pricing" level=3}\nFallback.\n:::\n\nAfter.\n';
  const view = agentView(doc, { readFile }).text;
  assert.match(view, /<included file="shared\/terms.smd" section="Pricing">\n### Pricing {2}\[L6\]\n\nPlans are \*\*monthly\*\*. See \[refunds\]\(#refunds\), \[the FAQ\]\(shared\/faq.smd\) and \[image: logo\]./);
  assert.match(view, /\[code: shared\/code.ts — read that file for the content\]/);
  assert.match(view, /#### Discounts {2}\[L15\]\n\nTen percent.\n<\/included>\n\nAfter./);
  assert.doesNotMatch(view, /Fallback|Refunds/);
  assert.match(agentView(doc, { readFile, includes: false }).text, /\[include: shared\/terms.smd § Pricing — read that file for the content\]\n\nAfter./);
  assert.match(agentView(doc).text, /\[include: shared\/terms.smd § Pricing — read that file for the content\]/);
  assert.match(agentView(':::include{file="loop/a.smd"}\n:::\n', { readFile }).text, /\[include: loop\/a.smd — include cycle \(loop\/a.smd → loop\/b.smd → loop\/a.smd\)\]/);
  // Included text counts toward the section that includes it.
  assert.match(agentView(doc, { readFile, sections: ['Doc'] }).text, /Ten percent/);
});

test('include: plain Markdown export inlines the included text; without it, the fallback or a link', () => {
  const doc = '# Doc\n\n:::include{file="shared/terms.smd" section="Pricing" level=3}\nFallback.\n:::\n';
  const md = smdToMarkdown(doc, { readFile });
  assert.match(md, /<!-- included from shared\/terms.smd § Pricing -->\n### Pricing\n\nPlans are \*\*monthly\*\*. See \[refunds\]\(#refunds\), \[the FAQ\]\(shared\/faq.smd\)/);
  assert.match(md, /```ts\nexport const price = 10;\n```/);
  assert.match(md, /#### Discounts/);
  assert.doesNotMatch(md, /Fallback|:::/);
  assert.equal(smdToMarkdown(doc), '# Doc\n\nFallback.\n');
  assert.equal(smdToMarkdown(':::include{file="shared/terms.smd" section="Pricing"}\n:::\n'), '[shared/terms.smd § Pricing](shared/terms.smd#pricing)\n');
});

test('include: the markdown-it plugin includes through its readFile(path, env) option, and only with one', () => {
  const files: Record<string, string> = { 'docs/shared/terms.smd': TERMS };
  const md = new MarkdownIt().use(smd, { headingIds: true, readFile: (p, env) => files[`${(env as { dir: string }).dir}/${p}`] });
  const html = md.render('## Pricing\n\n:::include{file="shared/terms.smd" section="Pricing"}\n:::\n', { dir: 'docs' });
  assert.match(html, /^<h2 id="pricing">Pricing<\/h2>\n<div class="smd-include" data-line="2" data-include="shared\/terms.smd § Pricing">\n<h2 id="pricing-1">Pricing<\/h2>/);
  assert.match(new MarkdownIt().use(smd).render(':::include{file="shared/terms.smd"}\n:::\n'), /Include not available here/);
});

test('include: go to definition, path completion and the formatter treat the file attribute as a path', () => {
  const src = '# A\n\n:::include{file="shared/terms.smd" section="Pricing"}\n:::\n';
  const link = findLinks(src).links.find((l) => l.kind === 'include');
  assert.deepEqual(link, { target: 'shared/terms.smd', line: 2, column: 17, kind: 'include' });
  assert.equal(linkAt(src, 2, 20)?.link.target, 'shared/terms.smd'); // go to definition and hover
  assert.deepEqual(pathCompletionContext(':::include{file="sha', 0, 20), { kind: 'related', target: 'sha', column: 17 });
  assert.equal(linkCompletionContext(':::include{file="sha', 0, 20), undefined);
  assert.equal(pathCompletionContext('```\n:::include{file="sha', 1, 20), undefined);
  assert.equal(pathCompletionContext(':::note{file="sha', 0, 17), undefined);
  assert.equal(formatSmd(':::include{ file=terms.smd  section=Pricing level=2 }\n:::\n'), ':::include{file="terms.smd" section="Pricing" level=2}\n:::\n');
});

test('include: smd build expands includes in each page and copies nothing extra', () => {
  const sources = [
    { path: 'guide.smd', text: '# Guide\n\n:::include{file="shared/terms.smd" section="Pricing"}\n:::\n' },
    { path: 'shared/terms.smd', text: TERMS },
  ];
  const site = buildSite(sources, { today: '2026-01-01', readFile: (source) => (p) => (source === 'guide.smd' ? readFile(p) : undefined) });
  const page = site.files.find((f) => f.path === 'guide.html')!.content;
  assert.match(page, /Plans are <strong>monthly<\/strong>/);
  assert.match(page, /<img src="shared\/img\/logo.png" alt="logo">/);
  assert.doesNotMatch(page, /Refunds/);
  // Only what the pages link to is copied: the image, never the included document or its embedded code.
  assert.deepEqual(site.assets, ['shared/img/logo.png']);
});

// Requires `npm run build`.
const cli = path.join(__dirname, '..', 'dist', 'cli.js');
const corpusDoc = path.join(__dirname, 'compat', 'corpus', 'include.smd');

test('CLI: smd agent expands includes through the sandboxed reader; --no-includes points to the files', { skip: !fs.existsSync(cli) && 'run npm run build first' }, () => {
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const expanded = run(['agent', corpusDoc]);
  assert.equal(expanded.status, 0, expanded.stderr);
  assert.match(expanded.stdout, /<included file="include-terms.smd" section="Pricing">\n### Pricing {2}\[L9\]/);
  assert.match(expanded.stdout, /\[include: shared\/glossary.smd — cannot read the file\]/);
  const pointers = run(['agent', corpusDoc, '--no-includes']);
  assert.match(pointers.stdout, /\[include: include-terms.smd § Pricing — read that file for the content\]/);
  assert.doesNotMatch(pointers.stdout, /<included/);
  const valid = run(['validate', corpusDoc]);
  assert.equal(valid.status, 0, valid.stdout);
  assert.match(valid.stdout, /0 error\(s\), 0 warning\(s\)/);
});
