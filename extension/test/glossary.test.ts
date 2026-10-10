import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import smd from '../src/core/markdownIt';
import { agentView, formatSmd, parseSmd, querySmd, renderSmd, smdToMarkdown, validateSmd, type Diagnostic } from '../src/core';
import { findGlossary, findTermUses, isAbbreviation, parseEntry, termAt, termHover, termMatcher } from '../src/core/glossary';
import { hoverAt } from '../src/lspAssist';

const corpus = readFileSync(join(__dirname, 'compat', 'corpus', 'glossary.smd'), 'utf8');
const codes = (diagnostics: Diagnostic[]) => diagnostics.map((d) => `${d.line}:${d.code}:${d.severity}`);
const body = (html: string) => html.replace(/^<article class="smd-doc">/, '').replace(/<\/article>$/, '');

const GLOSSARY = [
  ':::glossary Terms',
  '- **API**: Application *Programming* Interface',
  '- **SLO:** Service level "objective"',
  '- **Error budget**: How much unreliability is allowed.',
  '  It is spent by failures.',
  ':::',
].join('\n');

const API = '<a class="smd-term" href="#term-api"><abbr title="Application Programming Interface">API</abbr></a>';

test('glossary: the block renders as a definition list with an optional title', () => {
  const html = body(renderSmd(`${GLOSSARY}\n`).html);
  assert.equal(html, '<div class="smd-glossary" data-line="0"><div class="smd-glossary-title">Terms</div>\n'
    + '<dl class="smd-glossary-list" data-line="1">\n'
    + '<dt id="term-api" data-line="1"><dfn>API</dfn></dt>\n<dd data-line="1">Application <em>Programming</em> Interface</dd>\n'
    + '<dt id="term-slo" data-line="2"><dfn>SLO</dfn></dt>\n<dd data-line="2">Service level “objective”</dd>\n'
    + '<dt id="term-error-budget" data-line="3"><dfn>Error budget</dfn></dt>\n<dd data-line="3">How much unreliability is allowed.\nIt is spent by failures.</dd>\n'
    + '</dl>\n</div>\n');
  assert.match(body(renderSmd(':::glossary\n- **A**: b\n:::\n').html), /^<div class="smd-glossary" data-line="0">\n<dl/);
});

test('glossary: the first use of each term per section links to its definition, with the definition as a tooltip', () => {
  const html = renderSmd(`The API and the API.\n\nThe SLO, an error budget.\n\n## Next\n\nError budget, API.\n\n${GLOSSARY}\n`).html;
  assert.match(html, new RegExp(`<p data-line="0">The ${API} and the API\\.</p>`));
  assert.match(html, /<p data-line="2">The <a class="smd-term" href="#term-slo"><abbr title="Service level “objective”">SLO<\/abbr><\/a>, an <a class="smd-term" href="#term-error-budget" title="How much unreliability is allowed\. It is spent by failures\.">error budget<\/a>\.<\/p>/);
  assert.match(html, new RegExp(`<p data-line="6"><a class="smd-term" href="#term-error-budget" title="[^"]*">Error budget</a>, ${API}\\.</p>`));
  assert.match(html, /<h2 id="next" data-line="4">Next<\/h2>/);
});

test('glossary: headings, code, links, URLs, attribute values, compounds and container titles are left alone', () => {
  const src = [
    '## The API {#api-section}', '', '### API', '',
    '`API` [API](x) <https://e.com/API> https://e.com/API [x]{.API} API-first API.md /API #API @API :badge[API]', '',
    ':::note About API', 'Body.', ':::', '', GLOSSARY, '',
  ].join('\n');
  const html = renderSmd(src).html;
  assert.ok(!html.includes('smd-term'), html);
  assert.match(html, /<h2 id="api-section" data-line="0">The API<\/h2>/);
  assert.match(html, /<h3 id="api" data-line="2">API<\/h3>/);
  assert.deepEqual(parseSmd(src).headings.map((h) => h.slug), ['api-section', 'api']);
});

test('glossary: abbreviations match as written; other terms also with a capital or small first letter; longer terms win', () => {
  const src = `api Api API. ERROR BUDGET, Error budget\n\n${GLOSSARY}\n\n:::glossary\n- **API gateway**: The edge.\n:::\n`;
  const html = renderSmd(src).html;
  assert.match(html, /<p data-line="0">api Api <a class="smd-term" href="#term-api">.*?API<\/abbr><\/a>\. ERROR BUDGET, <a class="smd-term" href="#term-error-budget"[^>]*>Error budget<\/a><\/p>/);
  assert.match(renderSmd(`The API gateway and API.\n\n${GLOSSARY}\n\n:::glossary\n- **API gateway**: The edge.\n:::\n`).html,
    /The <a class="smd-term" href="#term-api-gateway" title="The edge\.">API gateway<\/a> and <a class="smd-term" href="#term-api">/);
  assert.equal(isAbbreviation('P99'), true);
  assert.equal(isAbbreviation('k8s'), false);
  assert.equal(isAbbreviation('2FA'), true);
});

test('glossary: a list that is not all entries stays a list and defines nothing; the first definition of a term wins', () => {
  const mixed = renderSmd('API\n\n:::glossary\n- **API**: Interface\n- just text\n:::\n').html;
  assert.match(mixed, /<ul data-line="3">/);
  assert.ok(!mixed.includes('smd-term'));
  const twice = renderSmd('API\n\n:::glossary\n- **API**: First\n- **API**: Second\n:::\n').html;
  assert.match(twice, /<abbr title="First">API<\/abbr>/);
  assert.match(twice, /<dt id="term-api" data-line="3"><dfn>API<\/dfn><\/dt>[\s\S]*<dt data-line="4"><dfn>API<\/dfn><\/dt>/);
  assert.ok(parseSmd('API\n\n:::glossary\n- **API**: First\n:::\n').ids.has('term-api'));
});

test('glossary: documents without a glossary render exactly as with the feature turned off', () => {
  const docs = [
    ...readdirSync(join(__dirname, '..', '..', 'examples')).filter((f) => f.endsWith('.smd')).map((f) => join(__dirname, '..', '..', 'examples', f)),
    ...readdirSync(join(__dirname, 'compat', 'corpus')).filter((f) => f !== 'glossary.smd').map((f) => join(__dirname, 'compat', 'corpus', f)),
  ];
  assert.ok(docs.length > 5);
  const on = new MarkdownIt({ html: true, linkify: true, typographer: true }).use(smd, { headingIds: true, sourceLines: true });
  const off = new MarkdownIt({ html: true, linkify: true, typographer: true }).use(smd, { headingIds: true, sourceLines: true, glossary: false });
  for (const file of docs) {
    const text = readFileSync(file, 'utf8');
    assert.equal(on.render(text, {}), off.render(text, {}), file);
  }
});

test('glossary: markdown-it plugin renders like renderSmd; glossary: false and containers: false turn it off', () => {
  const src = `## Intro\n\nThe API.\n\n${GLOSSARY}\n`;
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true }).use(smd, { codeFrames: true, headingIds: true, sourceLines: true });
  assert.equal(`<article class="smd-doc">${md.render(src, {})}</article>`, renderSmd(src).html);
  const plain = new MarkdownIt().use(smd).render('API\n\n:::glossary\n- **API**: Interface\n:::\n');
  assert.equal(plain, `<p><a class="smd-term" href="#term-api"><abbr title="Interface">API</abbr></a></p>\n`
    + '<div class="smd-glossary" data-line="2">\n<dl class="smd-glossary-list">\n<dt id="term-api"><dfn>API</dfn></dt>\n<dd>Interface</dd>\n</dl>\n</div>\n');
  const off = new MarkdownIt().use(smd, { glossary: false }).render('API\n\n:::glossary\n- **API**: Interface\n:::\n');
  assert.match(off, /^<p>API<\/p>\n<div class="smd-glossary" data-line="2">\n<ul>/);
  assert.ok(!new MarkdownIt().use(smd, { containers: false }).render('API\n\n:::glossary\n- **API**: Interface\n:::\n').includes('smd-term'));
});

test('glossary: the agent view lists the glossary once and leaves uses of the terms as written', () => {
  const view = agentView(`The API and the SLO.\n\n${GLOSSARY}\n`, { lineRefs: false }).text;
  assert.match(view, /^The API and the SLO\.$/m);
  assert.match(view, /^<glossary title="Terms">\n- \*\*API\*\*: Application \*Programming\* Interface\n[\s\S]*It is spent by failures\.\n<\/glossary>$/m);
  assert.equal(querySmd(`${GLOSSARY}\n`, 'glossary').length, 1);
});

test('glossary: to-md keeps the list and the title, and the text as written', () => {
  assert.equal(smdToMarkdown('The API.\n\n:::glossary Terms\n- **API**: Interface\n:::\n'), 'The API.\n\n**Terms**\n\n- **API**: Interface\n');
  assert.equal(smdToMarkdown(':::glossary\n- **API**: Interface\n:::\n'), '- **API**: Interface\n');
});

test('glossary: validation reports malformed entries, duplicates and unused terms, never errors', () => {
  const src = ['The API.', '', ':::glossary', '- **API**: One', '- **Api**: Two', '- **SLO**: Unused', ':::', '', ':::glossary', '- **X**:', '- plain', ':::', ''].join('\n');
  const diagnostics = validateSmd(src);
  assert.deepEqual(codes(diagnostics), ['4:glossary/duplicate:warning', '5:glossary/unused:info', '10:glossary/entry:warning']);
  const [duplicate, unused, entry] = diagnostics;
  assert.deepEqual([duplicate.column, duplicate.endColumn], [4, 7]);
  assert.match(duplicate.message, /"Api" is already defined on line 4/);
  assert.match(unused.message, /"SLO" is defined in the glossary but never used/);
  assert.match(entry.message, /renders as a plain list and defines no terms/);
  assert.deepEqual(codes(validateSmd('X\n\n:::glossary\n- **X**:\n:::\n')), ['3:glossary/entry:warning']);
  assert.deepEqual(codes(validateSmd(src, { rules: { 'glossary/*': 'off' } })), []);
  assert.deepEqual(validateSmd(corpus), []);
});

test('glossary: entries, uses and the term under the cursor', () => {
  assert.deepEqual(parseEntry('**API**: x y'), { term: 'API', definition: 'x y' });
  assert.deepEqual(parseEntry('**API:** x'), { term: 'API', definition: 'x' });
  assert.equal(parseEntry('**API** x'), undefined);
  assert.equal(parseEntry('** API**: x'), undefined);
  const lines = ['API `API` and ```', '```', 'API', '```', '# API', ':::glossary', '- **API**: Interface', ':::'];
  const glossary = findGlossary(lines);
  assert.deepEqual(glossary.entries.map((e) => [e.term, e.line, e.column, e.endColumn, e.id]), [['API', 6, 4, 7, 'term-api']]);
  assert.deepEqual(glossary.blocks, [[5, 7]]);
  assert.deepEqual(findTermUses(lines, 0, glossary).map((u) => [u.line, u.column]), [[0, 0]]);
  const matcher = termMatcher([{ term: 'Error budget' }])!;
  assert.deepEqual(matcher.find('error budget, Error budget, ERROR BUDGET, error budgets').map((m) => m.index), [0, 14]);

  const doc = `---\ntitle: T\n---\nThe API.\n\n${GLOSSARY}\n`;
  assert.equal(termAt(doc, 3, 5)?.entry.term, 'API');
  assert.equal(termAt(doc, 3, 1), undefined);
  assert.deepEqual(termHover(doc, 3, 4), { markdown: '**API** — Application *Programming* Interface\n\nGlossary, line 7', start: 4, end: 7 });
  assert.equal(hoverAt(doc, 3, 4)?.markdown, '**API** — Application *Programming* Interface\n\nGlossary, line 7');
  assert.equal(hoverAt(doc, 6, 5)?.markdown, '**API** — Application *Programming* Interface\n\nGlossary, line 7');
});

test('glossary: the compatibility corpus document is valid and formatted', () => {
  assert.equal(formatSmd(corpus), corpus);
  const html = renderSmd(corpus).html;
  assert.equal((html.match(/class="smd-term"/g) ?? []).length, 6);
  assert.deepEqual(renderSmd(corpus).headings.map((h) => h.slug), ['overview', 'operations', 'the-api-in-this-section', 'glossary']);
});

test('glossary: included text is part of the document: its glossary applies, and so do the document\'s terms', () => {
  const files: Record<string, string> = {
    'terms.smd': '---\ntitle: Terms\n---\n:::glossary\n- **API**: Application Programming Interface\n:::\n',
    'part.smd': '## Part\n\nThe SLO of the API.\n',
  };
  const readFile = (p: string) => files[p];
  const doc = 'Uses API.\n\n:::include{file="part.smd"}\n:::\n\n:::include{file="terms.smd"}\n:::\n\n:::glossary\n- **SLO**: Service level objective\n:::\n';
  const html = renderSmd(doc, { readFile }).html;
  assert.match(html, /<p data-line="0">Uses <a class="smd-term" href="#term-api"><abbr title="Application Programming Interface">API<\/abbr><\/a>\.<\/p>/);
  assert.match(html, /<p data-line="2">The <a class="smd-term" href="#term-slo"><abbr title="Service level objective">SLO<\/abbr><\/a> of the <a class="smd-term" href="#term-api">/);
  assert.match(html, /<dt id="term-api" data-line="5"><dfn>API<\/dfn><\/dt>/);
  // A term used only in included text is used when the include can be read.
  const onlyIncluded = 'Nothing here.\n\n:::include{file="part.smd"}\n:::\n\n:::glossary\n- **SLO**: Service level objective\n:::\n';
  assert.deepEqual(codes(validateSmd(onlyIncluded, { readFile })), []);
  assert.deepEqual(codes(validateSmd(onlyIncluded)), ['6:glossary/unused:info']);
});

test('glossary: a term used only in a {{name}} value is used, as rendering marks it there', () => {
  const glossaryCodes = (diagnostics: Diagnostic[]) => codes(diagnostics.filter((d) => d.code.startsWith('glossary/')));
  const doc = '---\nproduct: the API gateway\nlabel: API\n---\nWe ship {{product}}.\n\n:::glossary\n- **API**: Application Programming Interface\n- **SLO**: Service level objective\n:::\n';
  assert.match(renderSmd(doc).html, /We ship the <a class="smd-term" href="#term-api">/);
  assert.deepEqual(glossaryCodes(validateSmd(doc)), ['8:glossary/unused:info']);
  // Values in places where terms are never marked don't count: code, headings, and names the front matter lacks.
  const unmarked = '---\nproduct: the API gateway\n---\n## {{product}}\n\n`{{product}}` and {{nope}} API-free.\n\n```\n{{product}}\n```\n\n:::glossary\n- **API**: Interface\n:::\n';
  assert.ok(!renderSmd(unmarked).html.includes('smd-term'));
  assert.deepEqual(glossaryCodes(validateSmd(unmarked)), ['12:glossary/unused:info']);
  // A use written in the text still counts when a value is substituted next to it.
  assert.deepEqual(glossaryCodes(validateSmd('---\nv: "2"\n---\nThe API {{v}}.\n\n:::glossary\n- **API**: Interface\n:::\n')), []);
});

test('glossary: footnote references and definitions are never marked', () => {
  const doc = 'See the note.[^api]\n\n[^api]: The API in a footnote.\n    More about the API.\n\n:::glossary\n- **API**: Interface\n:::\n';
  const html = renderSmd(doc).html;
  assert.ok(!html.includes('smd-term'), html);
  assert.match(html, /<li id="fn-1">\n<p data-line="2">The API in a footnote\.\nMore about the API\./);
  assert.deepEqual(codes(validateSmd(doc)), ['6:glossary/unused:info']);
  assert.match(renderSmd(`API.[^1]\n\n[^1]: API.\n\n:::glossary\n- **API**: Interface\n:::\n`).html, /<p data-line="0"><a class="smd-term" href="#term-api">.*<\/a>\.<sup class="smd-footnote-ref">/);
});
