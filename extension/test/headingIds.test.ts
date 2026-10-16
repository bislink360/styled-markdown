import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToSmd, renderSmd, slugify, smdToMarkdown, validateSmd } from '../src/core';
import { renameHeading } from '../src/core/anchors';
import { githubIds, githubSlug, markdownHeadings } from '../src/core/githubSlug';
import { aliasedHeading, anchorNames, anchorOrAliasLine, githubAliases, headingAlias } from '../src/core/headingAliases';
import { sectionExcerpt } from '../src/core/symbols';
import { githubHeadingIds } from '../src/core/toMarkdown';

const ids = (body: string) => renderSmd(body).headings.map((h) => h.slug);

// ---------------------------------------------------------------------------
// Styled Markdown's own ids (SPEC §4.2.3): pinned, since links depend on them
// ---------------------------------------------------------------------------

test('slugify: lower-case, punctuation and `_` removed, whitespace runs to one hyphen, hyphens collapsed', () => {
  assert.equal(slugify('Getting Started'), 'getting-started');
  assert.equal(slugify('foo_bar'), 'foobar');
  assert.equal(slugify('C++ & Rust: a -- b'), 'c-rust-a-b');
  assert.equal(slugify("What's new?"), 'whats-new');
  assert.equal(slugify('  Spaced \t out  '), 'spaced-out');
  assert.equal(slugify('A --- B'), 'a-b');
  // Changelog headings: dots go, and the dash between version and date collapses into one hyphen.
  assert.equal(slugify('1.2.0 — 2026-03-01'), '120-2026-03-01');
  assert.equal(slugify('[1.1.0] - 2026-01-15'), '110-2026-01-15');
  // Leading and trailing hyphens stay.
  assert.equal(slugify('Foo -'), 'foo-');
  assert.equal(slugify('- Foo'), '-foo');
  // Anything between < and > goes, even in code.
  assert.equal(slugify('Map<K, V> type'), 'map-type');
  assert.equal(slugify('!!!'), '');
});

test('slugify: letters and numbers of every script stay; marks and emoji go', () => {
  assert.equal(slugify('Ünïcödé Straße'), 'ünïcödé-straße');
  assert.equal(slugify('Привет мир'), 'привет-мир');
  assert.equal(slugify('你好 世界'), '你好-世界');
  assert.equal(slugify('x² ½'), 'x²-½');
  // A combining mark is not a letter: decomposed "é" loses its accent, Devanagari loses its vowel signs.
  assert.equal(slugify('Café'), 'cafe');
  assert.equal(slugify('हिन्दी'), 'हनद');
  // Emoji go after trimming, so the space after a leading one becomes a hyphen.
  assert.equal(slugify('🚀 Launch'), '-launch');
  assert.equal(slugify('Done ✅'), 'done-');
});

test('heading ids: the text as written, without directives, HTML, images or math; empty is "section"', () => {
  assert.deepEqual(ids('## Install :badge[beta]\n\n## A ![img](x.png) B\n\n## Math $x^2$ here\n\n## `Map<K, V>` type\n\n## [Link](http://x.y) end'),
    ['install', 'a-b', 'math-here', 'map-type', 'link-end']);
  assert.deepEqual(ids('## <span>html</span> tag\n\n## *emph* and **strong** and ==mark==\n\n## [red]{color=red} span\n\n## !!!'),
    ['html-tag', 'emph-and-strong-and-mark', 'red-span', 'section']);
  // A footnote reference counts as written, and so does a variable, whatever its value.
  assert.deepEqual(ids('---\nversion: "2.0"\n---\n## Note[^1]\n\n## New in {{version}}\n\n[^1]: x'), ['note1', 'new-in-version']);
});

test('heading ids: repeats are numbered -1, -2…; {#id} is used as written and never counted', () => {
  assert.deepEqual(ids('## A\n\n## A\n\n## A'), ['a', 'a-1', 'a-2']);
  assert.deepEqual(ids('## A {#a}\n\n## A\n\n## A {#Custom_ID}\n\n## A'), ['a', 'a', 'Custom_ID', 'a-1']);
  // Numbered ids are not checked against other headings, so `A-1` can repeat one.
  assert.deepEqual(ids('## A\n\n## A\n\n## A-1'), ['a', 'a-1', 'a-1']);
  // Headings that differ only in punctuation share a base.
  assert.deepEqual(ids('## foo_bar\n\n## foobar\n\n## Foo-Bar\n\n## Foo -- Bar'), ['foobar', 'foobar-1', 'foo-bar', 'foo-bar-1']);
  assert.deepEqual(ids('## !!!\n\n## ???'), ['section', 'section-1']);
});

// ---------------------------------------------------------------------------
// GitHub's ids
// ---------------------------------------------------------------------------

test('githubSlug: lower-case, punctuation removed except - and _, each space a hyphen, nothing collapsed', () => {
  assert.equal(githubSlug('Getting Started'), 'getting-started');
  assert.equal(githubSlug('foo_bar'), 'foo_bar');
  assert.equal(githubSlug('max_tokens'), 'max_tokens');
  assert.equal(githubSlug('A -- B'), 'a----b');
  assert.equal(githubSlug('C++ & Rust'), 'c--rust');
  assert.equal(githubSlug("What's new?"), 'whats-new');
  assert.equal(githubSlug('1.2.0 — 2026-03-01'), '120--2026-03-01');
  assert.equal(githubSlug('[1.1.0] - 2026-01-15'), '110---2026-01-15');
  assert.equal(githubSlug('Foo -'), 'foo--');
  // Only spaces become hyphens; tabs and other whitespace go.
  assert.equal(githubSlug('a\tb c'), 'abc');
  assert.equal(githubSlug('heading with `code`'), 'heading-with-code');
});

test('githubSlug: letters, marks and digits of every script stay; other numbers and emoji go', () => {
  assert.equal(githubSlug('Привет non-latin 你好'), 'привет-non-latin-你好');
  assert.equal(githubSlug('Ünïcödé Straße'), 'ünïcödé-straße');
  assert.equal(githubSlug('Café'), 'café');
  assert.equal(githubSlug('हिन्दी'), 'हिन्दी');
  assert.equal(githubSlug('x² ½'), 'x-');
  assert.equal(githubSlug('😄 emoji'), '-emoji');
  assert.equal(githubSlug('Done ✅'), 'done-');
});

test('githubIds: repeats get -1, -2…, skipping ids already given', () => {
  assert.deepEqual(githubIds(['A', 'A', 'A']), ['a', 'a-1', 'a-2']);
  assert.deepEqual(githubIds(['A', 'A', 'A-1']), ['a', 'a-1', 'a-1-1']);
  assert.deepEqual(githubIds(['A', 'A-1', 'A']), ['a', 'a-1', 'a-2']);
  assert.deepEqual(githubIds(['foo_bar', 'foobar', 'Foo Bar']), ['foo_bar', 'foobar', 'foo-bar']);
  assert.deepEqual(githubIds(['!!!', '???']), ['', '-1']);
});

test('markdownHeadings: the text GitHub sees, ATX and setext', () => {
  const md = '# Title `code` [link](x) ![img](i.png) <kbd>Ctrl</kbd> &amp; \\_x\\_\n\nSetext\n===\n\n> ## Quoted\n\n```\n# not a heading\n```\n';
  assert.deepEqual(markdownHeadings(md), [
    { line: 0, text: 'Title code link  Ctrl & _x_', atx: true },
    { line: 2, text: 'Setext', atx: false },
    { line: 5, text: 'Quoted', atx: true },
  ]);
});

test('githubHeadingIds: the ids of the to-md output, where badges, variables and spans are text', () => {
  const src = '---\nversion: "2.10"\n---\n## Install :badge[beta]\n\n## New in {{version}}\n\n## foo_bar {#custom}\n\n## [Bold]{weight=bold} part\n\n## A\n\n## A';
  assert.deepEqual(githubHeadingIds(src), ['install-beta', 'new-in-210', 'foo_bar', 'bold-part', 'a', 'a-1']);
  assert.deepEqual(ids(src), ['install', 'new-in-version', 'custom', 'bold-part', 'a', 'a-1']);
});

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

const ALIASES = '# Guide\n\n## foo_bar\n\n## A -- B\n\n## Plain\n\n## Same_name\n\n## samename {#Same_name-x}\n\n<a id="same_name"></a>\n';

test('githubAliases: GitHub ids that differ from the heading id, unless something has that id itself', () => {
  const aliases = githubAliases(ALIASES);
  assert.deepEqual([...aliases].map(([id, h]) => [id, h.slug]), [['foo_bar', 'foobar'], ['a----b', 'a-b']]);
  assert.equal(aliasedHeading(ALIASES, 'foo_bar')?.line, 2);
  assert.equal(aliasedHeading(ALIASES, 'foobar'), undefined, 'a real id is not an alias');
  assert.equal(aliasedHeading(ALIASES, 'same_name'), undefined, 'an HTML id wins over a GitHub id');
  assert.equal(headingAlias(ALIASES, 4), 'a----b');
  assert.equal(headingAlias(ALIASES, 6), undefined);
  assert.equal(anchorOrAliasLine(ALIASES, 'a----b'), 4);
  assert.equal(anchorOrAliasLine(ALIASES, 'plain'), 6);
  assert.equal(anchorOrAliasLine(ALIASES, 'nowhere'), undefined);
  assert.deepEqual(anchorNames(ALIASES, 'foobar'), ['foobar', 'foo_bar']);
  assert.deepEqual(anchorNames(ALIASES, 'foo_bar'), ['foobar', 'foo_bar']);
  assert.deepEqual(anchorNames(ALIASES, 'plain'), ['plain']);
  assert.deepEqual(anchorNames(ALIASES, 'nowhere'), ['nowhere']);
});

test('sectionExcerpt: a GitHub id shows the heading\'s section', () => {
  const excerpt = sectionExcerpt('## foo_bar\n\nThe body.\n\n## Next\n', 'foo_bar');
  assert.equal(excerpt?.title, 'foo_bar');
  assert.deepEqual(excerpt?.lines, ['The body.']);
});

const found = (src: string, options = {}) => validateSmd(src, options).map((d) => `${d.line}:${d.code}:${d.severity}`);

test('validate: a link by GitHub id is info, with a fix to the heading id; never a warning', () => {
  const src = '---\nsmd: 1\n---\n## foo_bar\n\n## 1.2.0 — 2026-03-01\n\nSee [x](#foo_bar), [y](#120--2026-03-01) and [z](#foobar).\n';
  const diags = validateSmd(src);
  assert.deepEqual(diags.map((d) => `${d.line}:${d.code}:${d.severity}`), ['7:link/github-anchor:info', '7:link/github-anchor:info']);
  assert.equal(diags[0].message,
    '"#foo_bar" is the id GitHub gives the heading "foo_bar" in this document; its Styled Markdown id is "#foobar". The link works on GitHub, but not in the preview or rendered HTML.');
  assert.deepEqual(diags[0].fix, { line: 7, column: 8, endColumn: 16, replacement: '#foobar', title: 'Change to "#foobar"' });
  assert.equal(diags[1].fix?.replacement, '#120-2026-03-01');
  // A link that is neither id still warns.
  assert.deepEqual(found('## foo_bar\n\n[x](#foo_baz)'), ['2:link/missing-anchor:warning']);
  // The rule can be configured like any other.
  assert.deepEqual(found('## foo_bar\n\n[x](#foo_bar)', { rules: { 'link/github-anchor': 'off' } }), []);
});

test('validate: links to another document by GitHub id are info too', () => {
  const files: Record<string, string> = { 'other.smd': '## max_tokens\n\nText.\n' };
  const options = { fileExists: (p: string) => p in files, readFile: (p: string) => files[p] };
  const diags = validateSmd('[a](other.smd#max_tokens) [b](other.smd#maxtokens) [c](other.smd#max-tokens)\n', options);
  assert.deepEqual(diags.map((d) => [d.code, d.severity, d.fix?.replacement]), [
    ['link/github-anchor', 'info', 'other.smd#maxtokens'],
    ['link/missing-anchor', 'warning', 'other.smd#maxtokens'],
  ]);
  assert.match(diags[0].message, /heading "max_tokens" in "other\.smd"/);
});

// ---------------------------------------------------------------------------
// to-md and from-md
// ---------------------------------------------------------------------------

test('to-md: an anchor with the heading id before each heading whose GitHub id differs', () => {
  assert.equal(smdToMarkdown('## foo_bar\n\nText.\n\n## Plain\n'), '<a id="foobar"></a>\n## foo_bar\n\nText.\n\n## Plain\n');
  // `{#id}`, which GitHub can't read, keeps working through the anchor.
  assert.equal(smdToMarkdown('## Setup {#install}\n'), '<a id="install"></a>\n## Setup\n');
  // Nothing changes where the ids agree.
  assert.equal(smdToMarkdown('# Title\n\n## Getting started\n\n## Getting started\n'), '# Title\n\n## Getting started\n\n## Getting started\n');
});

test('to-md: anchors stay inside blockquotes, apart from paragraphs and before setext headings', () => {
  assert.equal(smdToMarkdown(':::note Heads up\n## foo_bar\n:::\n'), '> [!NOTE]\n> **Heads up**\n>\n> <a id="foobar"></a>\n> ## foo_bar\n\n');
  assert.equal(smdToMarkdown('Text.\n## A & B\n'), 'Text.\n\n<a id="a-b"></a>\n## A & B\n');
  assert.equal(smdToMarkdown('A & B\n=====\n'), '<a id="a-b"></a>\n\nA & B\n=====\n');
});

test('to-md: lone carriage returns get no anchors rather than misplaced ones (fuzz seed 20260928, case 499)', () => {
  // markdown-it ends a line at a lone `\r`, so its heading lines don't index the output's `\n` lines.
  const text = '- a\r- b\r- c\n### Sub {#custom .cls agent=skip}';
  assert.doesNotThrow(() => smdToMarkdown(text));
  assert.doesNotMatch(smdToMarkdown(text), /<a id=/);
  // CRLF output still gets them.
  assert.match(smdToMarkdown('## foo_bar\r\n\r\nText.\r\n'), /<a id="foobar"><\/a>/);
});

test('to-md: GitHub numbers repeats over the converted headings, included ones too', () => {
  // GitHub gives the third heading `a-1-1`; Styled Markdown gives it `a-1`.
  assert.equal(smdToMarkdown('## A\n\n## A\n\n## A-1\n'), '## A\n\n## A\n\n<a id="a-1"></a>\n## A-1\n');
  const files: Record<string, string> = { 'part.smd': '## foo_bar\n\nIncluded.\n' };
  const md = smdToMarkdown('## Intro\n\n:::include{file="part.smd"}\n:::\n', { readFile: (p) => files[p] });
  assert.equal(md, '## Intro\n\n<!-- included from part.smd -->\n\n<a id="foobar"></a>\n## foo_bar\n\nIncluded.\n\n');
});

test('from-md: the anchors to-md writes are dropped again; other anchors stay', () => {
  const src = '---\nsmd: 1\ntitle: T\n---\n\n## foo_bar\n\nText.\n\n## A & B\n\nMore.\n\nSetext & title\n===\n\n## Setup {#install}\n';
  const md = smdToMarkdown(src);
  assert.match(md, /<a id="foobar"><\/a>\n## foo_bar/);
  const back = markdownToSmd(md, 'T');
  assert.equal(back, '---\nsmd: 1\ntitle: T\n---\n\n## foo_bar\n\nText.\n\n## A & B\n\nMore.\n\nSetext & title\n===\n\n<a id="install"></a>\n## Setup\n');
  assert.deepEqual(renderSmd(back).headings.map((h) => h.slug), ['foobar', 'a-b', 'setext-title', 'setup']);
  // An anchor before a heading with another id, or before no heading, is kept.
  assert.equal(markdownToSmd('---\nsmd: 1\n---\n<a id="top"></a>\n## Intro\n\n<a id="foo"></a>\n\nText\n', 'T'),
    '---\nsmd: 1\n---\n<a id="top"></a>\n## Intro\n\n<a id="foo"></a>\n\nText\n');
});

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

test('renameHeading: links by GitHub id follow the heading', () => {
  const src = '## foo_bar\n\n## Plain\n';
  assert.deepEqual(renameHeading(src, 0, 'max_tokens')?.changes, [
    { from: 'foobar', to: 'maxtokens' },
    { from: 'foo_bar', to: 'max_tokens' },
  ]);
  // When the new GitHub id is the heading id, links by the old GitHub id move to it.
  assert.deepEqual(renameHeading(src, 0, 'Max tokens')?.changes, [
    { from: 'foobar', to: 'max-tokens' },
    { from: 'foo_bar', to: 'max-tokens' },
  ]);
});
