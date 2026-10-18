import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import {
  agentView, extractTasks, formatSmd, outline, parseSmd, renderSmd, smdToConfluence, smdToMarkdown, validateSmd,
} from '../src/core';
import { escapeQuoted, findAttrsEnd, parseAttrs } from '../src/core/attrs';
import { setAttr, setContainerAttr } from '../src/core/attrEdit';
import { renderBlocks, segmentSmd } from '../src/core/blocks';
import { formatAttrs, quote } from '../src/core/format';
import { editInline, scanInline } from '../src/core/inlineEdit';
import smd from '../src/core/markdownIt';
import { migrationPlan } from '../src/core/migrate';
import { headingAttrList, withoutHeadingAttrs } from '../src/core/sections';
import { inlineFields } from '../src/blockEditorSession';
import { prng } from './fuzz/generate';

/**
 * The inline and attribute rules of spec v2 (`smd: 2`), each read both ways: headings' trailing `{}` and `{word}` are
 * text (RFC proposal 5), `\\` is an escape in quoted values (6), any `:name[…]` is a directive (7b), and directive
 * names are read in any case (11). Documents without `smd: 2` read as in 1.10.
 */

const TODAY = '2026-10-17';
const doc = (body: string, version = 2) => `---\nsmd: ${version}\n---\n\n${body}\n`;
const html = (text: string) => renderSmd(text, { today: TODAY }).html.replaceAll(/ data-line="\d+"/g, '');
const codes = (text: string) => validateSmd(text, { today: TODAY }).map((d) => d.code);
const agent = (text: string) => agentView(text, { today: TODAY, lineRefs: false }).text.trim();
const body = (markdown: string) => markdown.split('---\n').slice(2).join('---\n').trim();
const corpus = (name: string) => readFileSync(join(__dirname, 'compat', 'corpus', name), 'utf8').replaceAll('\r\n', '\n');

// ---------------------------------------------------------------------------
// Proposal 5: a heading's trailing {word} or {} is text
// ---------------------------------------------------------------------------

test('headings: spec v2 reads an empty {} or a bare {word} as text; v1 as an attribute list', () => {
  for (const [line, v1, v2] of [
    ['## Object {}', '<h2 id="object">Object</h2>', '<h2 id="object-">Object {}</h2>'],
    ['## Returns {ok}', '<h2 id="returns">Returns</h2>', '<h2 id="returns-ok">Returns {ok}</h2>'],
    ['## Flag {agent}', '<h2 data-agent="true" id="flag">Flag</h2>', '<h2 id="flag-agent">Flag {agent}</h2>'],
    ['## Mixed {#m ok}', '<h2 id="m">Mixed</h2>', '<h2 id="mixed-m-ok">Mixed {#m ok}</h2>'],
    ['## Kept {#k .c agent=skip}', '<h2 id="k" class="smd-u-c" data-agent="skip">Kept</h2>', '<h2 id="k" class="smd-u-c" data-agent="skip">Kept</h2>'],
  ]) {
    assert.match(html(doc(line, 1)), new RegExp(v1.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)), line);
    assert.match(html(doc(line)), new RegExp(v2.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)), line);
  }
  assert.equal(headingAttrList('Returns {ok}', 1)?.attrs.values.ok, 'true');
  assert.equal(headingAttrList('Returns {ok}', 2), undefined);
  assert.equal(headingAttrList('Object {}', 2), undefined);
  assert.deepEqual(headingAttrList('Setup {#s .c key=v}', 2)?.attrs, { values: { key: 'v' }, classes: ['c'], id: 's' });
  // A list that doesn't parse: v1's line readers drop it anyway (as before), v2's keep it, as rendering does.
  assert.equal(withoutHeadingAttrs('Bad {a="b}', 1), 'Bad');
  assert.equal(withoutHeadingAttrs('Bad {a="b}', 2), 'Bad {a="b}');
});

test('headings: every reader of a spec v2 document keeps {word} as heading text, with the id made from it', () => {
  const text = doc('## Returns {ok}\n\n- [ ] Task\n\n## Setup {#setup-guide}\n\nSee [returns](#returns-ok).');
  assert.deepEqual(parseSmd(text).headings.map((h) => [h.text, h.slug]), [['Returns {ok}', 'returns-ok'], ['Setup', 'setup-guide']]);
  assert.match(agent(text), /^## Returns \{ok\}$/m);
  assert.match(agent(text), /^## Setup$/m);
  assert.match(outline(text), /## Returns \{ok\}/);
  assert.match(smdToMarkdown(text), /^## Returns \{ok\}$/m);
  assert.doesNotMatch(smdToMarkdown(text), /<a id="returns-ok">/, 'GitHub gives the heading the same id');
  assert.equal(extractTasks(text)[0].section, 'Returns {ok}');
  assert.deepEqual(codes(text), [], 'no heading/attrs-text hint, no attrs/unknown, and the link finds the heading');
  assert.equal(formatSmd(doc('## Spaced { ok }')), doc('## Spaced { ok }'), 'fmt keeps text as written');
  assert.equal(formatSmd(doc('## Real {  #id   .c }')), doc('## Real {#id .c}'));
  // The same document read with spec v1, as in 1.10.
  const v1 = text.replace('smd: 2', 'smd: 1');
  assert.deepEqual(parseSmd(v1).headings.map((h) => [h.text, h.slug]), [['Returns', 'returns'], ['Setup', 'setup-guide']]);
  assert.match(agent(v1), /^## Returns$/m);
  assert.equal(extractTasks(v1)[0].section, 'Returns');
  assert.ok(codes(v1).includes('heading/attrs-text'));
  assert.equal(formatSmd(doc('## Spaced { ok }', 1)), doc('## Spaced {ok}', 1));
  // The Block Editor shows the heading as rendering does.
  const blocks = renderBlocks(text, { today: TODAY }).blocks;
  assert.match(blocks.map((b) => b.html).join(''), /Returns \{ok\}/);
  assert.equal(segmentSmd(text).length, segmentSmd(v1).length);
});

// ---------------------------------------------------------------------------
// Proposal 6: \\ in quoted values
// ---------------------------------------------------------------------------

test('escapes: in spec v2 \\\\ is one backslash and a value cannot end in a single one; v1 keeps 1.10\'s reading', () => {
  const src = String.raw`p="C:\docs\\" q="\\\\server\share" r="a\b" s='it\'s \\'`;
  assert.deepEqual(parseAttrs(src, 2)?.values, { p: String.raw`C:\docs\ `.trim(), q: String.raw`\\server\share`, r: String.raw`a\b`, s: String.raw`it's \ `.trim() });
  assert.deepEqual(parseAttrs(src, 1)?.values, { p: String.raw`C:\docs\\`, q: String.raw`\\\\server\share`, r: String.raw`a\b`, s: String.raw`it's \\` });
  // The 1.10 reading of a value that ends in a backslash is for v1 only.
  const old = String.raw`title="C:\docs\" next=1`;
  assert.deepEqual(parseAttrs(old, 1)?.values, { title: String.raw`C:\docs\ `.trim(), next: '1' });
  assert.equal(parseAttrs(old, 2), null);
  const line = String.raw`[x]{title="C:\docs\"} after}`;
  assert.equal(findAttrsEnd(line, 3, 1), line.indexOf('} after'));
  assert.equal(findAttrsEnd(line, 3, 2), -1, 'v2 reads it as an escaped quote, so the value never ends');
});

test('escapes: escapeQuoted writes any value so that spec v2 reads it back', () => {
  const random = prng(20261017);
  const alphabet = ['\\', '"', "'", 'a', ' ', 'b'];
  for (let n = 0; n < 2000; n++) {
    const value = Array.from({ length: Math.floor(random() * 8) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    for (const q of ['"', "'"] as const) {
      const written = `k=${q}${escapeQuoted(value, q)}${q}`;
      assert.equal(parseAttrs(written, 2)?.values.k, value, written);
    }
  }
  assert.equal(escapeQuoted(String.raw`C:\docs\ `.trim(), '"'), String.raw`C:\docs\\`);
  assert.equal(escapeQuoted(String.raw`C:\Users\docs`, '"'), String.raw`C:\Users\docs`, 'a backslash before a letter stays single');
});

test('escapes: fmt, quote() and the attribute editors write v2 escapes in spec v2 documents only', () => {
  assert.equal(quote('title', String.raw`C:\docs\ `.trim(), [], 2), String.raw`"C:\docs\\"`);
  assert.equal(quote('title', String.raw`C:\docs\ `.trim(), [], 1), String.raw`"C:\docs\"`, 'v1 relies on its own fallback, as in 1.10');
  assert.equal(quote('title', String.raw`\\server`, [], 2), String.raw`"\\\\server"`);
  assert.equal(quote('title', 'say "hi"', [], 2), `'say "hi"'`);
  assert.equal(quote('title', String.raw`it's "x" \ `.trim(), [], 2), String.raw`"it's \"x\" \\"`);
  assert.equal(formatAttrs(String.raw`title="C:\\docs\\"`, [], 2), String.raw`title="C:\docs\\"`, 'canonical: only the escapes needed');
  assert.equal(formatAttrs(String.raw`title="C:\\docs\\"`, [], 1), String.raw`title="C:\\docs\\"`);
  const v2 = doc(String.raw`:::note{title="\\\\server\share"}` + '\nx\n:::');
  assert.equal(formatSmd(v2), v2);
  assert.equal(setAttr('', 'title', String.raw`C:\docs\ `.trim(), [], 2), String.raw`title="C:\docs\\"`);
  assert.equal(setContainerAttr(':::note', 'title', String.raw`\\server`, 2), String.raw`:::note{title="\\\\server"}`);
  assert.equal(setContainerAttr(':::note', 'title', String.raw`\\server`), String.raw`:::note{title="\\server"}`);
  const line = String.raw`Saved :metric[3]{label="C:\temp\\" trend=up}`;
  const [item] = scanInline([line], { spec: 2 });
  assert.equal(item.values.label, String.raw`C:\temp\ `.trim());
  assert.equal(editInline(line, item, { attrs: { label: String.raw`D:\\x` } }, 2), String.raw`Saved :metric[3]{label="D:\\\\x" trend=up}`);
});

test('escapes: rendering, validation, the agent view and to-md read v2 values', () => {
  const text = doc(String.raw`:::note{title="\\\\server\share"}` + '\nUNC.\n:::\n\n' + String.raw`Saved :metric[3]{label="C:\temp\\" trend=up} today.`);
  assert.deepEqual(codes(text), []);
  assert.match(agent(text), /<note title="\\\\server\\share">/);
  assert.match(agent(text), /Saved C:\\temp\\: 3 today\./);
  assert.match(smdToMarkdown(text), /\*\*3\*\* C:\\temp\\ today/);
  assert.match(html(text), /<span class="smd-metric-label">C:\\temp\\<\/span>/);
  // In v1 the same list has two backslashes, as in 1.10.
  assert.match(agent(text.replace('smd: 2', 'smd: 1')), /Saved C:\\temp\\\\: 3 today\./);
  // A value that ends in one backslash is malformed in v2: the item is text, and an attrs/syntax error.
  const old = doc(String.raw`Saved :metric[3]{label="C:\temp\" trend=up} today.`);
  assert.ok(codes(old).includes('attrs/syntax'));
  assert.match(html(old), /Saved :metric\[3\]/);
  assert.match(agent(old), /Saved :metric\[3\]\{label="C:\\temp\\" trend=up\} today\./);
  assert.match(smdToMarkdown(old), /Saved :metric\[3\]\{label="C:\\temp\\" trend=up\} today\./);
  assert.deepEqual(codes(old.replace('smd: 2', 'smd: 1')), []);
});

// ---------------------------------------------------------------------------
// Proposals 7b and 11: generic directives, names in any case
// ---------------------------------------------------------------------------

test('directives: spec v2 renders an unknown name\'s content in a smd-directive span, styled as a span; v1 keeps the text', () => {
  const text = doc('Read :abbr[**HTML**]{color=blue .pill #ab}, :sep{.wide} and :x[1].');
  assert.match(html(text), /Read <span class="smd-directive smd-directive-abbr smd-u-pill" style="color:var\(--smd-blue\)" id="ab"><strong>HTML<\/strong><\/span>, <span class="smd-directive smd-directive-sep smd-u-wide"><\/span> and <span class="smd-directive smd-directive-x">1<\/span>\./);
  assert.match(html(text.replace('smd: 2', 'smd: 1')), /Read :abbr<span class="smd-span smd-u-pill"[^>]*><strong>HTML<\/strong><\/span>, :sep\{\.wide\} and :x\[1\]\./);
  // The prefix rule, escapes and code still keep text as text.
  assert.match(html(doc('10:30, note:[x], \\:abbr[y] and `:z[1]`.')), /<p>10:30, note:\[x\], :abbr\[y\] and <code>:z\[1\]<\/code>\.<\/p>/);
  // A list that can't be read leaves the item as text, as for known names.
  assert.match(html(doc('See :abbr[x]{a="b}.')), /See :abbr\[x\]\{a=&quot;b\}\./);
});

test('directives: names are read in any case in spec v2 only', () => {
  const text = doc(':Badge[Shipped]{color=green} :STATUS[ok]{color=green} :Kbd[Ctrl+S]');
  const out = html(text);
  assert.match(out, /<span class="smd-badge" style="--smd-badge:var\(--smd-green\)">Shipped<\/span>/);
  assert.match(out, /class="smd-status"/);
  assert.match(out, /<kbd>Ctrl<\/kbd>/);
  assert.match(html(text.replace('smd: 2', 'smd: 1')), /:Badge<span class="smd-span"/);
  assert.equal(agent(text), '[Shipped] [status: ok (ok)] Ctrl+S');
  assert.equal(body(smdToMarkdown(text)), '`Shipped` 🟢 ok <kbd>Ctrl</kbd>+<kbd>S</kbd>');
  assert.deepEqual(codes(text), []);
  assert.equal(formatSmd(doc(':Badge[x]{ color=green }')), doc(':Badge[x]{color=green}'), 'fmt keeps the case as written');
  // Tasks, references and the overdue check read names in any case.
  const tasks = doc('- [ ] Ship :Due[2026-10-01] :PRIORITY[P1] :Mention[@dana]\n\n:::figure{#f} Flow\nx\n:::\n\nSee :Ref[f].');
  assert.deepEqual(extractTasks(tasks, TODAY).map((t) => [t.due, t.priority, t.assignees, t.overdue]), [['2026-10-01', 'P1', ['@dana'], true]]);
  assert.ok(codes(tasks).includes('task/overdue'));
  assert.match(html(tasks), /<a class="smd-ref" href="#f">Figure 1<\/a>/);
  assert.match(agent(tasks), /See Figure 1 \(f\)\./);
  assert.deepEqual(extractTasks(tasks.replace('smd: 2', 'smd: 1'), TODAY).map((t) => t.due), [undefined]);
});

test('directives: the agent view, to-md and the exports show an unknown directive\'s content, as for a styled span', () => {
  const text = doc('Read :abbr[HTML]{weight=bold} and :term[a *b*].');
  assert.equal(agent(text), 'Read HTML and a *b*.');
  assert.equal(body(smdToMarkdown(text)), 'Read **HTML** and a *b*.');
  assert.match(smdToConfluence(text), /HTML/);
  assert.doesNotMatch(smdToConfluence(text), /:abbr/);
  const v1 = text.replace('smd: 2', 'smd: 1');
  // In v1 the name is text before a styled span, `[HTML]{weight=bold}`.
  assert.equal(agent(v1), 'Read :abbrHTML and :term[a *b*].');
  assert.equal(body(smdToMarkdown(v1)), 'Read :abbr**HTML** and :term[a *b*].');
});

test('directives: the validator reports every unknown name in spec v2, with a fix for a near one; v1 only near ones', () => {
  const text = doc('Read :abbr[HTML], :badg[x] and :tag[y]{color=bleu}.');
  const found = validateSmd(text, { today: TODAY }).map((d) => `${d.code}:${d.severity}:${d.fix?.replacement ?? ''}`);
  assert.deepEqual(found, ['directive/unknown:warning:', 'directive/unknown:warning:badge', 'directive/unknown:warning:', 'attrs/value:error:blue']);
  assert.deepEqual(codes(text.replace('smd: 2', 'smd: 1')), ['directive/unknown']);
  // Other keys of an unknown directive may be its own: not reported.
  assert.deepEqual(codes(doc('Read :abbr[HTML]{title="HyperText"}.')), ['directive/unknown']);
});

test('directives: the Block Editor scans unknown directives in spec v2 and offers the generic form', () => {
  const line = 'Read :Abbr[HTML]{color=red} and :badge[ok].';
  const items = scanInline([line], { spec: 2 });
  assert.deepEqual(items.map((i) => [i.name, i.content, i.at?.start]), [['abbr', 'HTML', 5], ['badge', 'ok', 32]]);
  assert.deepEqual(scanInline([line]).map((i) => i.name), ['span', 'badge'], 'v1: `:Abbr` is text before a styled span');
  assert.deepEqual(inlineFields(items[0])?.map((f) => f.name), ['content', 'color', 'bg', 'border']);
  assert.equal(editInline(line, items[0], { content: 'XML', attrs: { color: null } }, 2), 'Read :Abbr[XML] and :badge[ok].');
  const blocks = renderBlocks(doc(line), { today: TODAY, inlineIndex: true }).blocks;
  assert.deepEqual(blocks.flatMap((b) => b.inline ?? []).map((i) => i.name), ['abbr', 'badge']);
});

test('directives: the markdown-it plugin reads the document\'s version, or the spec option', () => {
  const md = (spec?: 1 | 2) => new MarkdownIt().use(smd, spec ? { spec } : {});
  assert.match(md(2).render('See :abbr[x] and :Badge[y].'), /smd-directive-abbr[^]*smd-badge/);
  assert.match(md().render('See :abbr[x].'), /See :abbr\[x\]\./);
  assert.match(md().render(doc('See :abbr[x].')), /smd-directive-abbr/);
});

// ---------------------------------------------------------------------------
// smd migrate: v2 rendering of the migrated document is the v1 rendering of the original
// ---------------------------------------------------------------------------

/**
 * The rendered body: no header, no source lines or include queries, and each class once (v1 writes a repeated class
 * twice, which migrating's duplicate step leaves out), as in migrate.test.ts.
 */
const rendered = (text: string, readFile?: (p: string) => string | undefined) =>
  renderSmd(text, { today: TODAY, readFile }).html.replace(/<header[^]*?<\/header>/, '').replaceAll(/ data-(?:task-)?line="\d+"/g, '').replaceAll(/ data-include="[^"]*"/g, '')
    .replaceAll(/ class="([^"]*)"/g, (_, names: string) => ` class="${[...new Set(names.split(' '))].join(' ')}"`);

/** Typography and bare-domain links are proposal 8's, kept by their options. */
const KEEP = { keepTypography: true, linkDomains: true };

test('migrate: a migrated document renders under spec v2 as the original does under spec v1', () => {
  const cases = [
    '## Object {}\n\n## Returns {ok}\n\n## Flag {agent}\n\n## Both {#b agent ok}',
    'Read :abbr[HTML], (:x[1]), :sep{.wide}, :Badge[Shipped]{color=green} and :badge[ok].',
    String.raw`:::note{title="\\server\share"}` + '\nx\n:::\n\n' + String.raw`:::note{title="C:\docs\"}` + '\ny\n:::\n\n' + String.raw`Saved :metric[3]{label="C:\temp\\" trend=up}.`,
  ];
  for (const body of cases) {
    const original = doc(body, 1);
    const migrated = migrationPlan(original, KEEP).result;
    assert.match(migrated, /smd: 2/);
    assert.equal(rendered(migrated), rendered(original), body);
  }
  // migrate.smd has a case for every step. Its one difference is proposal 10's, by design: v2 shows `version: 2.10` as
  // written, which the plan only notes.
  for (const name of ['unknown-directives.smd', 'attribute-escapes.smd', 'v2-hints.smd', 'migrate.smd']) {
    const original = corpus(name);
    const readFile = (p: string) => { try { return corpus(p); } catch { return undefined; } };
    const v2 = rendered(migrationPlan(original, { readFile, ...KEEP }).result, readFile).replace('This is version 2.10.', 'This is version 2.1.');
    assert.equal(v2, rendered(original, readFile), name);
  }
});

test('tasks: a character written with a backslash escape stays in the checkbox label', () => {
  // A migrated document escapes `\:name[…]`; its tasks must keep the label they had.
  assert.match(renderSmd(String.raw`- [ ] Pay \$5 and \:x[y]` + '\n').html, /aria-label="Pay \$5 and :x\[y\]"/);
});
