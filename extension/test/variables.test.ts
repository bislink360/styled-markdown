import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import smd from '../src/core/markdownIt';
import {
  agentView, applyFixes, extractTasks, formatSmd, outline, parseSmd, querySmd, renderSmd, smdToMarkdown, validateSmd, type Diagnostic,
} from '../src/core';
import { resetParseCache } from '../src/core/parse';
import {
  findVariables, lookupVariable, substituteLine, variableCompletion, variableHover, variableNames, variablesIn, variableText,
} from '../src/core/variables';
import { completionsAt, hoverAt } from '../src/lspAssist';

const root = join(__dirname, '..', '..');
const corpus = readFileSync(join(__dirname, 'compat', 'corpus', 'variables.smd'), 'utf8');
const codes = (diagnostics: Diagnostic[]) => diagnostics.map((d) => `${d.line}:${d.code}:${d.severity}`);
const body = (html: string) => html.replace(/^<article class="smd-doc">/, '').replace(/<\/article>$/, '');

const FM = ['---', 'title: "Release {{version}}"', 'version: "2.10"', 'owner:', '  name: Maya <b>Chen</b>', 'tags: [api, q4]', 'launch: 2026-10-20', '---'];
const doc = (...lines: string[]) => [...FM, ...lines].join('\n');

test('variables: {{name}} shows the front matter value in text, headings, lists, tables and titles', () => {
  const html = body(renderSmd(doc(
    "## What's new in {{version}}", '', 'Hi {{ owner.name }}: {{tags}}.', '', '- [ ] Ship {{version}}', '', '| v |', '|---|', '| {{version}} |', '',
    ':::note Upgrade to {{version}}', 'Body', ':::',
  ), { today: '2026-10-01' }).html);
  // The id comes from the heading as written; the text shows the value.
  assert.match(html, /<h2 id="whats-new-in-version" data-line="8">What’s new in 2.10<\/h2>/);
  // Values are text: HTML in a value is escaped, never rendered.
  assert.match(html, /Hi Maya &lt;b&gt;Chen&lt;\/b&gt;: api, q4\./);
  assert.match(html, /aria-label="Ship 2.10">Ship 2.10<\/li>/);
  assert.match(html, /<td>2.10<\/td>/);
  assert.match(html, /<\/span>Upgrade to 2.10<\/span>/);
  // The header shows the front matter as written.
  assert.match(html, /<h1 class="smd-doc-title">Release \{\{version\}\}<\/h1>/);
});

test('variables: code, math, URLs, raw HTML, escapes, triple braces and unknown names stay as written', () => {
  const html = body(renderSmd(doc(
    'A `{{version}}` b \\{{version}} c {{{version}}} d {{missing}} e {{owner}} f $x^{{version}}$',
    '', '[link {{version}}](https://x.test/{{version}}) ![Logo {{version}}](logo.png) <span title="{{version}}">{{version}}</span>',
    '', '```', '{{version}}', '```',
  )).html);
  assert.match(html, /<code>\{\{version\}\}<\/code> b \{\{version\}\} c \{\{\{version\}\}\} d \{\{missing\}\} e \{\{owner\}\} f /);
  assert.match(html, /<annotation encoding="application\/x-tex">x\^\{\{version\}\}<\/annotation>/);
  assert.match(html, /<a href="https:\/\/x.test\/%7B%7Bversion%7D%7D">link 2.10<\/a>/);
  assert.match(html, /alt="Logo 2.10"/);
  assert.match(html, /<span title="\{\{version\}\}">2.10<\/span>/);
  assert.match(html, /<pre[^>]*><code[^>]*>\{\{version\}\}\n<\/code><\/pre>/);
});

test('variables: directive content is substituted, so :due[{{launch}}] is a date', () => {
  const html = renderSmd(doc(':badge[v{{version}}]{color=indigo} :due[{{launch}}] :kbd[{{version}}]'), { today: '2026-10-01' }).html;
  assert.match(html, /<span class="smd-badge"[^>]*>v2.10<\/span>/);
  assert.match(html, /smd-due smd-due-later" title="Due 2026-10-20"/);
  assert.match(html, /<kbd>2.10<\/kbd>/);
  assert.deepEqual(codes(validateSmd(doc('- [ ] Ship :due[{{launch}}]'), { today: '2026-10-01' })).filter((c) => !c.includes('frontmatter/')), []);
});

test('variables: heading ids do not depend on the value, and parseSmd agrees with renderSmd', () => {
  resetParseCache();
  const a = doc('## Notes for {{version}}', '', '[x](#notes-for-version)');
  const b = a.replace('version: "2.10"', 'version: "3.0"');
  for (const text of [a, b]) {
    const rendered = renderSmd(text).headings;
    assert.deepEqual(parseSmd(text).headings, rendered);
    assert.equal(rendered[0].slug, 'notes-for-version');
    assert.deepEqual(codes(validateSmd(text)).filter((c) => c.includes('link/')), []);
  }
  // The parse cache is keyed on the front matter of documents that use variables: the heading follows the edit.
  assert.equal(parseSmd(b).headings[0].text, 'Notes for 3.0');
  assert.equal(parseSmd(a).headings[0].text, 'Notes for 2.10');
});

test('variables: the markdown-it plugin reads the front matter, can be turned off, and takes env.smdVariables', () => {
  const src = doc('Version {{version}}.');
  assert.match(new MarkdownIt().use(smd).render(src), /<p>Version 2.10.<\/p>/);
  assert.match(new MarkdownIt().use(smd, { variables: false }).render(src), /<p>Version \{\{version\}\}.<\/p>/);
  const host = new MarkdownIt().use(smd);
  assert.equal(host.render('Version {{version}}.', { smdVariables: { version: 7 } }), '<p>Version 7.</p>\n');
  assert.equal(host.render('Version {{version}}.'), '<p>Version {{version}}.</p>\n');
  // The header renders the front matter as written.
  assert.match(new MarkdownIt().use(smd, { frontMatter: true }).render(src), /<h1 class="smd-doc-title">Release \{\{version\}\}<\/h1>/);
});

test('variables: documents that do not use them render exactly as before', () => {
  const files = execFileSync('git', ['ls-files', '*.smd', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter((f) => f && !f.endsWith('variables.smd') && !f.includes('node_modules'));
  assert.ok(files.length > 30);
  const on = new MarkdownIt({ html: true }).use(smd, { frontMatter: true });
  const off = new MarkdownIt({ html: true }).use(smd, { frontMatter: true, variables: false });
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    // Writer templates use {{title}} as a placeholder that `smd init` fills in before anyone renders them.
    if (f.includes('assets/templates/') && /\{\{title\}\}/.test(text.split('---')[2] ?? '')) continue;
    assert.equal(on.render(text, {}), off.render(text, {}), f);
  }
});

test('variables: the agent view, smd to-md, tasks and query show the values', () => {
  const text = doc("## What's new in {{version}}", '', 'By {{owner.name}}, `{{version}}`.', '', '- [ ] Ship {{version}} :due[{{launch}}]', '', ':::decision{status=accepted} Ship {{version}}', ':::');
  const view = agentView(text, { today: '2026-10-01' }).text;
  assert.match(view, /^## What's new in 2.10 {2}\[L9\]$/m);
  assert.match(view, /^By Maya <b>Chen<\/b>, `\{\{version\}\}`\.$/m);
  assert.match(view, /^- \[ \] Ship 2.10 \(due 2026-10-20\)$/m);
  assert.match(view, /^<decision status="accepted"> Ship 2.10$/m);
  assert.match(view, /^version: 2.10/m);
  assert.match(outline(text), /What's new in 2.10/);
  const md = smdToMarkdown(text);
  assert.match(md, /^## What's new in 2.10$/m);
  assert.match(md, /^By Maya <b>Chen<\/b>, `\{\{version\}\}`\.$/m);
  assert.match(md, /^title: "Release \{\{version\}\}"$/m);
  const [task] = extractTasks(text, '2026-10-01');
  assert.equal(task.text, 'Ship 2.10');
  assert.equal(task.due, '2026-10-20');
  assert.equal(task.section, "What's new in 2.10");
  assert.equal(querySmd(text, 'decision')[0].title, 'Ship 2.10');
});

test('variables: included text uses the including document\'s front matter', () => {
  const files: Record<string, string> = { 'part.smd': '---\nversion: "9"\n---\nIncluded {{version}}.\n' };
  const readFile = (p: string) => files[p];
  const text = doc(':::include{file="part.smd"}', ':::');
  assert.match(renderSmd(text, { readFile }).html, /<p data-line="8">Included 2.10.<\/p>/);
  assert.match(agentView(text, { readFile }).text, /^Included 2.10\.$/m);
  assert.match(smdToMarkdown(text, { readFile }), /^Included 2.10\.$/m);
});

test('variables: values are substituted before glossary terms are marked', () => {
  const html = renderSmd('---\nproduct: the API gateway\n---\n## Intro\n\nWe ship {{product}}.\n\n:::glossary\n- **API**: Application Programming Interface\n:::\n').html;
  assert.match(html, /We ship the <a class="smd-term" href="#term-api"><abbr title="Application Programming Interface">API<\/abbr><\/a> gateway\./);
});

test('variables: validation reports undefined names (info, with a fix) and values that are not text (warning)', () => {
  const text = doc('Version {{verison}}, {{owner}}, {{customer}}, \\{{nope}}, `{{nope}}`.', '', '```', '{{nope}}', '```', '', '<!-- {{nope}} -->', '[ref]: https://x.test/{{nope}}');
  const found = validateSmd(text).filter((d) => d.code.startsWith('variable/'));
  assert.deepEqual(codes(found), ['8:variable/undefined:info', '8:variable/not-text:warning', '8:variable/undefined:info']);
  assert.match(found[0].message, /did you mean "version"\?/);
  assert.match(found[1].message, /e\.g\. \{\{owner\.name\}\}/);
  assert.equal(applyFixes(text, [found[0]]).text.split('\n')[8], 'Version {{version}}, {{owner}}, {{customer}}, \\{{nope}}, `{{nope}}`.');
  // Existing checks don't change: a document without variables gets no new diagnostics.
  assert.deepEqual(codes(validateSmd('Use {{name}} in a Handlebars template.')), ['0:variable/undefined:info']);
  assert.deepEqual(codes(validateSmd('Use {{name}}.', { rules: { 'variable/*': 'off' } })), []);
});

test('variables: custom keys shown with {{key}} get no unknown-key hint', () => {
  const unknown = (text: string) => codes(validateSmd(text)).filter((c) => c.includes('unknown-key'));
  assert.deepEqual(unknown('---\nsmd: 1\nproduct: Acme\n---\nAbout {{product}}.\n'), []);
  assert.deepEqual(unknown('---\nsmd: 1\nproduct: Acme\n---\nAbout it.\n'), ['2:frontmatter/unknown-key:hint']);
});

test('variables: the compatibility corpus document is valid and formatted, and smd fmt leaves variables as written', () => {
  assert.deepEqual(validateSmd(corpus), []);
  assert.equal(formatSmd(corpus), corpus);
  const plain = '---\nv: 1\n---\n\nA {{ v }} and \\{{v}}, [x]{color=red} {{v}}.\n';
  assert.equal(formatSmd(plain), plain);
});

test('variables: completion after {{ and hover on a variable, in the language server', () => {
  const text = doc('Version {{ve', '', 'Version {{version}} by {{owner.name}}.', '', '```', '{{', '```');
  const completion = completionsAt(text, 8, 12)!;
  assert.equal(completion.from, 10);
  assert.deepEqual(completion.items.map((i) => [i.label, i.detail, i.insertText]), [
    ['title', 'Release {{version}}', 'title}}'], ['version', '2.10', 'version}}'], ['owner.name', 'Maya <b>Chen</b>', 'owner.name}}'],
    ['tags', 'api, q4', 'tags}}'], ['launch', '2026-10-20', 'launch}}'],
  ]);
  assert.equal(completionsAt('---\nv: 1\n---\nA {{v}}', 3, 5)!.items[0].insertText, 'v');
  // Not inside code or front matter.
  assert.equal(variableCompletion(text, 13, 2), undefined);
  assert.equal(variableCompletion(text, 1, 10), undefined);
  const hover = hoverAt(text, 10, 12)!;
  assert.deepEqual([hover.start, hover.end], [8, 19]);
  assert.equal(hover.markdown, '**{{version}}** — front matter value: `2.10`');
  assert.match(hoverAt(text, 10, 26)!.markdown, /Maya <b>Chen<\/b>/);
  assert.match(variableHover(doc('{{nope}}'), 8, 3)!.markdown, /not defined in the front matter/);
});

test('variables: values, names and spans', () => {
  assert.equal(variableText(2.1), '2.1');
  assert.equal(variableText(true), 'true');
  assert.equal(variableText(['a', 2]), 'a, 2');
  assert.equal(variableText('one\n  two'), 'one two');
  assert.equal(variableText({ a: 1 }), undefined);
  assert.equal(variableText(null), undefined);
  assert.deepEqual(lookupVariable({ 'a.b': 'key', a: { b: 'path' } }, 'a.b'), { kind: 'text', text: 'key' });
  assert.deepEqual(lookupVariable({ list: ['x', 'y'] }, 'list.1'), { kind: 'text', text: 'y' });
  assert.deepEqual(lookupVariable({}, 'constructor'), { kind: 'undefined' });
  assert.deepEqual(lookupVariable({ m: { a: 1 } }, 'm'), { kind: 'not-text' });
  assert.deepEqual(variableNames({ a: 1, m: { b: 'x', c: { d: true } }, l: [1] }).map((n) => n.name), ['a', 'm.b', 'm.c.d', 'l']);
  assert.deepEqual(variablesIn('{{a}} \\{{b}} {{{c}}} [x]{t="{{d}}"} ](u/{{e}}) <i {{f}}> $x{{g}}$ \\\\{{h}}').map((v) => v.name), ['a', 'h']);
  assert.equal(substituteLine('{{a}} `{{a}}` [r]: {{a}}', { a: 'A' }), 'A `{{a}}` [r]: A');
  assert.equal(substituteLine('[r]: https://x.test/{{a}}', { a: 'A' }), '[r]: https://x.test/{{a}}');
  assert.deepEqual(findVariables(['{{a}}', '```', '{{b}}', '```', '$$', '{{c}}', '$$', '<!-- {{d}}', '{{e}} -->', '{{f}} <!-- {{g}}', '-->']).map((v) => v.name), ['a', 'f']);
});
