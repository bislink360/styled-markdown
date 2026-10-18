import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import MarkdownIt from 'markdown-it';
import {
  agentView, extractTasks, FRONTMATTER_SCHEMA, frontMatterValues, renderSmd, renderSmdFile, smdToConfluence, smdToMarkdown, smdToNotion,
  smdToPandocHtml, validateSmd,
} from '../src/core';
import smd from '../src/core/markdownIt';
import { renderBlocks } from '../src/core/blocks';
import { frontMatterFields, isFrontMatterRefusal } from '../src/core/frontMatterEdit';
import { specEnv } from '../src/core/specVersion';
import { typographyOf, typographyOn } from '../src/core/typography';
import { ObsidianEngine } from '../src/obsidianEngine';

/**
 * Spec v2's text rules (RFC proposal 8): no typographic replacements unless the front matter says `typography: true`,
 * and only GFM autolink literals become links. Spec v1 documents read as in 1.10.
 */

const today = '2026-10-17';
const corpusDir = path.join(__dirname, 'compat', 'corpus');
const corpus = (name: string) => fs.readFileSync(path.join(corpusDir, name), 'utf8').replaceAll('\r\n', '\n');
const doc = (smdLine: string, body: string) => `---\n${smdLine}\n---\n\n${body}\n`;
const html = (text: string) => renderSmd(text, { today }).html;

const TYPOGRAPHIC = /[‘’“”–—…©®™±]/;
const TEXT = '"Quotes", \'single\', it\'s 10--20 --- wait... (c) (tm) (r) +-1';
const STRAIGHT = '&quot;Quotes&quot;, \'single\', it\'s 10--20 --- wait... (c) (tm) (r) +-1';
const CURLED = '“Quotes”, ‘single’, it’s 10–20 — wait… © ™ ® ±1';

// ---------------------------------------------------------------------------
// The corpus: v2-typography.smd and v2-typography-on.smd, and their v1 twins
// ---------------------------------------------------------------------------

test('corpus/v2-typography.smd: no typographic character anywhere in the render, and only GFM autolink literals linked', () => {
  const v2 = corpus('v2-typography.smd');
  const out = html(v2);
  assert.doesNotMatch(out, TYPOGRAPHIC);
  assert.match(out, /<h1 class="smd-doc-title">Typography in spec v2: &quot;as written&quot; -- by default<\/h1>/);
  assert.match(out, /<p data-line="11">&quot;Double quotes&quot;, 'single quotes' and the builder's apostrophe stay straight\. Dashes stay as typed: pages 10--20, and a pause --- like this\. Ellipses too\.\.\. and so do \(c\) 2026, \(tm\), \(r\) and \+-5\.<\/p>/);
  assert.match(out, /&quot;Quoted&quot; titles -- as written<\/span>/, 'a container title');
  assert.match(out, /<span class="smd-badge">&quot;quoted&quot; -- badge<\/span>/, 'directive content');
  assert.match(out, /<td>&quot;a&quot; -- 'b'<\/td>/, 'a table cell');
  const links = [...out.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => `${m[2]} → ${m[1]}`);
  assert.deepEqual(links, [
    'www.example.com/docs → http://www.example.com/docs', 'https://example.org/guide → https://example.org/guide',
    'ftp://files.example.net → ftp://files.example.net', 'team@example.com → mailto:team@example.com',
    'the guide → https://example.org/guide', 'https://example.com → https://example.com',
  ]);
});

test('corpus/v2-typography.smd as a v1 document (smd: 1): typography and fuzzy links as in 1.10', () => {
  const v1 = corpus('v2-typography.smd').replace('\nsmd: 2\n', '\nsmd: 1\n');
  const out = html(v1);
  assert.match(out, /“Double quotes”, ‘single quotes’ and the builder’s apostrophe stay straight\. Dashes stay as typed: pages 10–20, and a pause — like this\. Ellipses too… and so do © 2026, ™, ® and ±5\./);
  assert.match(out, /“Quoted” titles – as written/);
  assert.match(out, /<span class="smd-badge">“quoted” – badge<\/span>/);
  assert.match(out, /<a href="http:\/\/example\.com">example\.com<\/a>, <a href="http:\/\/docs\.example\.org\/guide">docs\.example\.org\/guide<\/a> and <a href="http:\/\/README\.md">README\.md<\/a>/);
  assert.match(out, /<a href="\/\/cdn\.example\.com">\/\/cdn\.example\.com<\/a>, and so is <a href="http:\/\/WWW\.EXAMPLE\.COM">WWW\.EXAMPLE\.COM<\/a>/);
  // The same document without an smd key reads the same.
  assert.equal(html(v1.replace('\nsmd: 1\n', '\n# no smd\n')), out);
});

test('corpus/v2-typography-on.smd: typography: true curls as v1 does, and links still follow GFM', () => {
  const on = corpus('v2-typography-on.smd');
  const out = html(on);
  assert.match(out, /<h1 class="smd-doc-title">Typography in spec v2: “turned on” – by the front matter<\/h1>/);
  assert.match(out, /“Double quotes”, ‘single quotes’ and the builder’s apostrophe curl\. Dashes join: pages 10–20, and a pause — like this\. Ellipses too… and so do © 2026, ™, ® and ±5\./);
  assert.match(out, /“Quoted” titles – typographic/);
  assert.match(out, /<span class="smd-badge">“quoted” – badge<\/span>/);
  assert.match(out, /Bare domains are text: example\.com, docs\.example\.org\/guide and README\.md\. So is \/\/cdn\.example\.com, and so is WWW\.EXAMPLE\.COM in capitals\./);
  // As v1 renders it, apart from the links v1 adds.
  const v1 = html(on.replace('\nsmd: 2\n', '\nsmd: 1\n'));
  const unlinked = (s: string) => s.replaceAll(/<a href="(?:http:)?\/\/(?!www\.example)[^"]*">([^<]*)<\/a>/g, '$1');
  assert.equal(unlinked(v1), out);
});

test('the corpus documents are valid, formatted, and spec v2 documents', () => {
  for (const name of ['v2-typography.smd', 'v2-typography-on.smd']) {
    const text = corpus(name);
    assert.deepEqual(validateSmd(text, { today }), [], name);
    assert.equal(renderSmd(text).spec, 2, name);
  }
});

// ---------------------------------------------------------------------------
// Text: paragraphs, titles, the header, directive content, both versions
// ---------------------------------------------------------------------------

test('render: v1 curls; v2 keeps the text as written; v2 with typography: true curls', () => {
  assert.match(html(doc('smd: 1', TEXT)), new RegExp(`<p data-line="4">${CURLED}</p>`));
  assert.match(html(doc('smd: 2', TEXT)), new RegExp(`<p data-line="4">${STRAIGHT.replaceAll(/[.()+]/g, '\\$&')}</p>`));
  assert.match(html(doc('smd: 2\ntypography: true', TEXT)), new RegExp(`<p data-line="5">${CURLED}</p>`));
  // `typography: false`, other values, and v1 with either: as the version says.
  assert.doesNotMatch(html(doc('smd: 2\ntypography: false', TEXT)), TYPOGRAPHIC);
  assert.doesNotMatch(html(doc('smd: 2\ntypography: "true"', TEXT)), TYPOGRAPHIC, 'only the boolean true');
  assert.match(html(doc('smd: 1\ntypography: false', TEXT)), new RegExp(CURLED), 'v1 always has typography');
  // The spec option, for documents without an smd key.
  assert.doesNotMatch(renderSmd(TEXT, { spec: 2 }).html, TYPOGRAPHIC);
  assert.match(renderSmd(`---\ntypography: true\n---\n${TEXT}`, { spec: 2 }).html, new RegExp(CURLED));
});

test('titles, the header and directive content read with the document\'s typography', () => {
  const body = ':::note "A" -- title\n:::\n\n:::card{title="\'B\' -- card"}\nx\n:::\n\n:badge["C" -- badge] :status["D"]{color=green} :metric["E"]{label=x}';
  const fm = 'title: "\\"T\\" -- title"\nsummary: "\\"S\\"..."';
  const v2 = html(doc(`smd: 2\n${fm}`, body));
  assert.doesNotMatch(v2, TYPOGRAPHIC);
  for (const s of ['&quot;T&quot; -- title</h1>', '&quot;S&quot;...</p>', '&quot;A&quot; -- title</span>', '\'B\' -- card</div>', '&quot;C&quot; -- badge</span>', '&quot;D&quot;</span>', '&quot;E&quot;</span>']) {
    assert.ok(v2.includes(s), s);
  }
  for (const smdLine of ['smd: 1', 'smd: 2\ntypography: true']) {
    const out = html(doc(`${smdLine}\n${fm}`, body));
    for (const s of ['“T” – title</h1>', '“S”…</p>', '“A” – title</span>', '‘B’ – card</div>', '“C” – badge</span>', '“D”</span>', '“E”</span>']) {
      assert.ok(out.includes(s), `${smdLine}: ${s}`);
    }
  }
});

test('code, math, URLs and HTML are never typographic, in either version', () => {
  const body = '`"a" -- b` $x--y$ <span title="a -- b">"h"</span> [l](https://x.com/a--b)';
  for (const smdLine of ['smd: 1', 'smd: 2', 'smd: 2\ntypography: true']) {
    const out = html(doc(smdLine, body));
    assert.match(out, /<code>&quot;a&quot; -- b<\/code>/, smdLine);
    assert.match(out, /<span title="a -- b">/, smdLine);
    assert.match(out, /href="https:\/\/x\.com\/a--b"/, smdLine);
  }
});

test('included text reads with the including document\'s typography', () => {
  const readFile = (p: string) => (p === 'part.smd' ? '---\nsmd: 1\n---\n\n"Included" -- text.\n' : undefined);
  const including = (smdLine: string) => renderSmd(doc(smdLine, ':::include{file="part.smd"}\n:::'), { readFile, today }).html;
  assert.match(including('smd: 1'), /“Included” – text\./);
  assert.match(including('smd: 2'), /&quot;Included&quot; -- text\./);
  assert.match(including('smd: 2\ntypography: true'), /“Included” – text\./);
});

test('specEnv passes the version and typography along; typographyOn reads them', () => {
  assert.deepEqual(specEnv({ smdSpec: 2, smdTypography: true, other: 1 }), { smdSpec: 2, smdTypography: true });
  assert.deepEqual(specEnv({ smdSpec: 2, smdTypography: false }), { smdSpec: 2 });
  assert.deepEqual(specEnv(undefined), { smdSpec: 1 });
  assert.equal(typographyOn({}), true);
  assert.equal(typographyOn({ smdSpec: 1 }), true);
  assert.equal(typographyOn({ smdSpec: 2 }), false);
  assert.equal(typographyOn({ smdSpec: 2, smdTypography: true }), true);
  assert.equal(typographyOf({ typography: true }), true);
  for (const value of [false, 'true', 1, 'yes', null]) assert.equal(typographyOf({ typography: value }), false, String(value));
  assert.equal(typographyOf(undefined), false);
});

// ---------------------------------------------------------------------------
// Links: fuzzy (v1) and GFM autolink literals (v2)
// ---------------------------------------------------------------------------

/** Each link of the HTML as `text → href`. */
const linksOf = (out: string) => [...out.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => `${m[2]} → ${m[1]}`);
const LINKS = 'a example.com b www.example.com/x?y=1. c https://e.org d foo@bar.com e //proto.com f README.md g WWW.CAPS.com h ftp://f.org i mailto:a@b.co (www.paren.org) www.shop.test a.www.example.com';

test('links: v1 links fuzzy domains; v2 links only GFM autolink literals, with typography or without', () => {
  assert.deepEqual(linksOf(html(doc('smd: 1', LINKS))), [
    'example.com → http://example.com', 'www.example.com/x?y=1 → http://www.example.com/x?y=1', 'https://e.org → https://e.org',
    'foo@bar.com → mailto:foo@bar.com', '//proto.com → //proto.com', 'README.md → http://README.md', 'WWW.CAPS.com → http://WWW.CAPS.com',
    'ftp://f.org → ftp://f.org', 'mailto:a@b.co → mailto:a@b.co', 'www.paren.org → http://www.paren.org', 'a.www.example.com → http://a.www.example.com',
  ]);
  const gfm = [
    'www.example.com/x?y=1 → http://www.example.com/x?y=1', 'https://e.org → https://e.org', 'foo@bar.com → mailto:foo@bar.com',
    'ftp://f.org → ftp://f.org', 'mailto:a@b.co → mailto:a@b.co', 'www.paren.org → http://www.paren.org', 'www.shop.test → http://www.shop.test',
    'www.example.com → http://www.example.com',
  ];
  assert.deepEqual(linksOf(html(doc('smd: 2', LINKS))), gfm);
  assert.deepEqual(linksOf(html(doc('smd: 2\ntypography: true', LINKS))), gfm);
  // Explicit links and <autolinks> are links in both.
  for (const smdLine of ['smd: 1', 'smd: 2']) {
    assert.deepEqual(linksOf(html(doc(smdLine, '[x](example.com) <https://e.org> <a@b.co>'))), ['x → example.com', 'https://e.org → https://e.org', 'a@b.co → mailto:a@b.co'], smdLine);
  }
});

test('links: a v2 render leaves the instance as it was, so the next v1 render is unchanged', () => {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true }).use(smd);
  const linkify = md.linkify;
  const v1 = md.render(doc('smd: 1', `${TEXT} example.com`));
  md.render(doc('smd: 2', `${TEXT} example.com`));
  assert.equal(md.linkify, linkify);
  assert.equal(md.options.typographer, true);
  assert.equal(md.render(doc('smd: 1', `${TEXT} example.com`)), v1);
  assert.match(v1, /<a href="http:\/\/example\.com">/);
});

// ---------------------------------------------------------------------------
// The markdown-it plugin, remark, Obsidian
// ---------------------------------------------------------------------------

test('markdown-it plugin: spec v2 (option or front matter) takes typography and fuzzy links away from the host', () => {
  const host = (spec?: 1 | 2) => new MarkdownIt({ linkify: true, typographer: true }).use(smd, { spec });
  assert.equal(host().render(`${TEXT} example.com`), new MarkdownIt({ linkify: true, typographer: true }).render(`${TEXT} example.com`), 'v1: the host\'s settings');
  const v2 = host(2).render(`${TEXT} example.com www.example.com`);
  assert.doesNotMatch(v2, TYPOGRAPHIC);
  assert.match(v2, /example\.com <a href="http:\/\/www\.example\.com">www\.example\.com<\/a>/);
  // The document's front matter: in the source, or passed as env.smdVariables.
  assert.doesNotMatch(host().render(doc('smd: 2', TEXT)), TYPOGRAPHIC);
  assert.match(host().render(doc('smd: 2\ntypography: true', TEXT)), new RegExp(CURLED));
  assert.match(host(2).render(TEXT, { smdVariables: { typography: true } }), new RegExp(CURLED));
  assert.doesNotMatch(host(2).render(TEXT, { smdVariables: { smd: 2 } }), TYPOGRAPHIC);
  // A reused env doesn't keep the last document's typography.
  const env: Record<string, unknown> = {};
  host().render(doc('smd: 2\ntypography: true', TEXT), env);
  assert.equal(env.smdTypography, true);
  assert.doesNotMatch(host().render(doc('smd: 2', TEXT), env), TYPOGRAPHIC);
  assert.equal(Object.hasOwn(env, 'smdTypography'), false, 'nothing of its own left on the host env');
});

test('markdown-it plugin: the rules only take away, so a host without the typographer or linkify keeps them off', () => {
  const plain = new MarkdownIt({ linkify: false, typographer: false }).use(smd);
  for (const smdLine of ['smd: 1', 'smd: 2', 'smd: 2\ntypography: true']) {
    const out = plain.render(doc(smdLine, `${TEXT} www.example.com`));
    assert.doesNotMatch(out, TYPOGRAPHIC, smdLine);
    assert.doesNotMatch(out, /<a /, smdLine);
  }
});

test('markdown-it plugin: titles and directive content follow the document\'s typography', () => {
  const md = new MarkdownIt({ typographer: true }).use(smd, { frontMatter: true });
  const body = ':::note "A" -- title\n:badge["B"]\n:::';
  assert.doesNotMatch(md.render(doc('smd: 2\ntitle: \'"T"\'', body)), TYPOGRAPHIC);
  const on = md.render(doc('smd: 2\ntypography: true\ntitle: \'"T"\'', body));
  for (const s of ['“T”</h1>', '“A” – title</span>', '“B”</span>']) assert.ok(on.includes(s), s);
});

test('remark: the file\'s front matter decides', () => {
  assert.doesNotMatch(renderSmdFile({ value: doc('smd: 2', TEXT) }, { today })?.html ?? '', TYPOGRAPHIC);
  assert.match(renderSmdFile({ value: doc('smd: 2\ntypography: true', TEXT) }, { today })?.html ?? '', new RegExp(CURLED));
  assert.match(renderSmdFile({ value: doc('smd: 1', TEXT) }, { today })?.html ?? '', new RegExp(CURLED));
});

test('Obsidian: its typographer stays off in every version; v2 notes link only GFM autolink literals', () => {
  const engine = new ObsidianEngine({ containers: true, directives: true, agentBlocks: 'collapsed', today });
  const note = (variables: Record<string, unknown>) => engine.render(`:::note "N" -- t\n${TEXT} example.com\n:::`, { variables, lang: undefined });
  assert.doesNotMatch(note({ smd: 1 }), TYPOGRAPHIC);
  assert.match(note({ smd: 1 }), /<a href="http:\/\/example\.com">/);
  assert.doesNotMatch(note({ smd: 2, typography: true }), TYPOGRAPHIC);
  assert.doesNotMatch(note({ smd: 2 }), /<a /);
});

// ---------------------------------------------------------------------------
// Exporters, the Block Editor, and the readers that keep the source
// ---------------------------------------------------------------------------

test('exporters: Pandoc HTML, Confluence and Notion follow the version and typography', () => {
  const body = `## "H" -- 1\n\n${TEXT} example.com\n\n:::note "A" -- title\nx\n:::`;
  const v1 = doc('smd: 1', body);
  const v2 = doc('smd: 2', body);
  const on = doc('smd: 2\ntypography: true', body);
  assert.match(smdToPandocHtml(v1, { today }), new RegExp(CURLED));
  assert.doesNotMatch(smdToPandocHtml(v2, { today }), TYPOGRAPHIC);
  assert.doesNotMatch(smdToPandocHtml(v2, { today }), /href="http:\/\/example\.com"/);
  assert.match(smdToPandocHtml(on, { today }), new RegExp(CURLED));
  assert.match(smdToConfluence(v1), /“A” – title/);
  assert.match(smdToConfluence(v1), /href="http:\/\/example\.com"/);
  assert.doesNotMatch(smdToConfluence(v2), TYPOGRAPHIC);
  assert.doesNotMatch(smdToConfluence(v2), /href="http:\/\/example\.com"/);
  assert.match(smdToConfluence(on), /“A” – title/);
  const notion = (text: string) => JSON.stringify(smdToNotion(text));
  assert.match(notion(v1), /“Quotes”/);
  assert.doesNotMatch(notion(v2), TYPOGRAPHIC);
  assert.match(notion(on), /“Quotes”/);
});

test('the Block Editor renders blocks with the document\'s typography and links', () => {
  const body = `${TEXT} example.com`;
  const block = (text: string) => renderBlocks(text, { today }).blocks.map((b) => b.html).join('');
  assert.match(block(doc('smd: 1', body)), new RegExp(CURLED));
  assert.match(block(doc('smd: 1', body)), /href="http:\/\/example\.com"/);
  assert.doesNotMatch(block(doc('smd: 2', body)), TYPOGRAPHIC);
  assert.doesNotMatch(block(doc('smd: 2', body)), /<a /);
  assert.match(block(doc('smd: 2\ntypography: true', body)), new RegExp(CURLED));
});

test('the agent view, to-md and tasks keep the source text in either version', () => {
  const body = `## "H" -- 1\n\n- [ ] "Ship" -- it... example.com :due[2026-11-01]\n\n${TEXT}`;
  for (const smdLine of ['smd: 1', 'smd: 2', 'smd: 2\ntypography: true']) {
    const text = doc(smdLine, body);
    assert.doesNotMatch(agentView(text, { today }).text, TYPOGRAPHIC, smdLine);
    assert.ok(agentView(text, { today }).text.includes(TEXT), smdLine);
    assert.ok(smdToMarkdown(text).includes(`- [ ] "Ship" -- it... example.com`), smdLine);
    assert.deepEqual(extractTasks(text, today).map((t) => t.text), ['"Ship" -- it... example.com'], smdLine);
  }
});

// ---------------------------------------------------------------------------
// The front matter key
// ---------------------------------------------------------------------------

test('typography is a front matter key: in the schema, the validator and the Block Editor\'s form', () => {
  const prop = (FRONTMATTER_SCHEMA.properties as Record<string, { type?: string; description: string }>).typography;
  assert.equal(prop.type, 'boolean');
  assert.match(prop.description, /^Spec v2: true turns on typographic quotes, dashes and ellipses \(v1 always has them\)$/);
  assert.deepEqual(frontMatterValues('typography'), ['true', 'false']);
  // Known in every version, so no unknown-key hint; v1 accepts it and it has no effect there.
  for (const smdLine of ['smd: 1\ntypography: true', 'smd: 1\ntypography: false', 'smd: 2\ntypography: true']) {
    assert.deepEqual(validateSmd(doc(smdLine, 'Text.'), { today }).map((d) => d.code), [], smdLine);
  }
  assert.deepEqual(validateSmd(doc('smd: 2\ntypography: yes', 'Text.'), { today }).map((d) => `${d.code}:${d.severity}`), ['frontmatter/type:warning']);
  const fields = frontMatterFields(['---', 'smd: 2', 'typography: true', '---']);
  assert.ok(!isFrontMatterRefusal(fields));
  const field = fields.find((f) => f.name === 'typography');
  assert.deepEqual([field?.kind, field?.value, field?.options], ['select', 'true', ['', 'true', 'false']]);
});
