import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import {
  agentView, applyFixes, extractTasks, formatSmd, getDocumentInfo, querySmd, renderSmd, smdToMarkdown, validateSmd,
} from '../src/core';
import smd from '../src/core/markdownIt';
import { segmentSmd, type Segment } from '../src/core/blocks';
import { findChangelogs } from '../src/core/changelog';
import { closedBy, displayMath } from '../src/core/containers';
import { findGlossary, findTermUses } from '../src/core/glossary';
import { containerEnd, findIncludes } from '../src/core/include';
import { migrationPlan } from '../src/core/migrate';
import { parseSmd, resetParseCache } from '../src/core/parse';
import { findQuotes } from '../src/core/quote';
import { containerAt, wrapLines } from '../src/core/refactors';
import { scanTasks } from '../src/core/taskLines';
import { findVariables, substituteLine } from '../src/core/variables';
import { containerRanges, createObsidianMarkdownIt } from '../src/obsidianEngine';

/**
 * The spec v2 block rules (RFC proposals 2 and 3), through every reader, both ways: a document with `smd: 2` gets the
 * v2 rule, the same text with `smd: 1` reads as in 1.10. corpus/v2-math.smd and corpus/v2-fences.smd pin each case.
 */

const TODAY = '2026-10-17';
const doc = (spec: 1 | 2, body: string) => `---\nsmd: ${spec}\n---\n${body}`;
const corpus = (name: string) => readFileSync(join(__dirname, 'compat', 'corpus', name), 'utf8').replaceAll('\r\n', '\n');
/** The same document read with the other version: its twin. */
const asV1 = (v2: string) => v2.replace('\nsmd: 2\n', '\nsmd: 1\n');
const codes = (text: string) => validateSmd(text, { today: TODAY }).map((d) => `${d.line}:${d.severity}:${d.code}`);
const shape = (segments: Segment[]): unknown[] => segments.map((s) => [s.type ?? s.kind, s.start, s.end, ...(s.children ? [shape(s.children)] : [])]);
const mathTex = (html: string) => [...html.matchAll(/<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// The rules themselves
// ---------------------------------------------------------------------------

test('closedBy: v1 closes the innermost; v2 the innermost with as many colons, else the innermost', () => {
  assert.equal(closedBy([], 3, 2), -1);
  assert.equal(closedBy([4, 3], 4, 1), 1);
  assert.equal(closedBy([4, 3], 4, 2), 0);
  assert.equal(closedBy([3, 4, 3], 3, 2), 2);
  assert.equal(closedBy([4, 3], 5, 2), 1, 'no container has five colons');
});

test('displayMath: v2 opens on a line that is only $$ (or $$…$$) and closes on a line that is only $$', () => {
  const lines = ['$$ x', 'y $$', '$$', 'a $$', '$$', '$$ z $$'];
  const v1 = displayMath(lines, 1);
  const v2 = displayMath(lines, 2);
  assert.deepEqual(lines.map((_, i) => v1(i)), [true, true, true, true, true, true]);
  assert.deepEqual(lines.map((_, i) => v2(i)), [false, false, true, true, true, true]);
});

// ---------------------------------------------------------------------------
// Proposal 2: $$ delimiters
// ---------------------------------------------------------------------------

const PRICING = 'Pricing:\n$$5 per seat\n\n## Plans\n\n- [ ] Ship {{nope}}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nThe plan costs $$\n';

test('math: render, parse, the plugin and the Block Editor read text beside $$ as text in v2, as math in v1', () => {
  const v1 = doc(1, PRICING);
  const v2 = doc(2, PRICING);
  assert.match(renderSmd(v1).html, /smd-math-block/);
  assert.doesNotMatch(renderSmd(v1).html, /id="plans"/);
  assert.doesNotMatch(renderSmd(v2).html, /smd-math-block/);
  assert.match(renderSmd(v2).html, /<h2 id="plans" data-line="6">Plans<\/h2>/);
  assert.deepEqual(parseSmd(v1).math, [[4, 15]]);
  assert.deepEqual(parseSmd(v2).math, []);
  assert.deepEqual(parseSmd(v2).headings.map((h) => h.slug), ['plans']);
  // The markdown-it plugin reads the version from the front matter, or from its spec option.
  const plugin = (spec?: 1 | 2) => new MarkdownIt().use(smd, { frontMatter: true, spec });
  assert.match(plugin().render(v2), /<h2>Plans<\/h2>/);
  assert.match(plugin(2).render(PRICING), /<h2>Plans<\/h2>/);
  assert.match(plugin().render(PRICING), /smd-math-block/);
  assert.deepEqual(shape(segmentSmd(v1)).map((s) => (s as unknown[])[0]), ['frontmatter', 'paragraph', 'math', 'gap']);
  assert.deepEqual(shape(segmentSmd(v2)).filter((s) => (s as unknown[])[0] !== 'gap').map((s) => (s as unknown[])[0]),
    ['frontmatter', 'paragraph', 'heading', 'list', 'table', 'paragraph']);
});

test('math: the agent view, to-md, tasks, query, meta, the validator and fmt agree', () => {
  const v1 = doc(1, PRICING);
  const v2 = doc(2, PRICING);
  assert.doesNotMatch(agentView(v1).text, /## Plans {2}\[L7\]/, 'v1: the heading is math, shown as written');
  assert.match(agentView(v2).text, /## Plans {2}\[L7\]/);
  assert.deepEqual([extractTasks(v1).length, extractTasks(v2).length], [0, 1]);
  assert.deepEqual(scanTasks(v2).map((t) => t.kind), ['heading', 'task']);
  assert.deepEqual(querySmd(v2, 'task').map((m) => m.line), [8]);
  assert.equal(getDocumentInfo(v2, { today: TODAY }).tasks.total, 1);
  assert.deepEqual(codes(v1), ['4:error:math/syntax'], 'v1: the math holds a heading, which KaTeX rejects');
  assert.deepEqual(codes(v2), ['8:info:variable/undefined'], 'v2: the text is text, its {{nope}} too');
  // fmt aligns the table in v2, where it is a table; v1 leaves the math as written, and parts the paragraph from it.
  assert.match(formatSmd(v2), /\| a {3}\| b {3}\|/);
  assert.match(formatSmd(v1), /\| a \| b \|/);
  assert.match(formatSmd(v1), /Pricing:\n\n\$\$5 per seat/);
  assert.match(formatSmd(v2), /Pricing:\n\$\$5 per seat/);
  // to-md keeps math as written, and converts text: {{title}} is replaced in v2, where the line is text.
  const title = (spec: 1 | 2) => smdToMarkdown(`---\nsmd: ${spec}\ntitle: T\n---\n$$ {{title}}\n\n$$\n`);
  assert.match(title(1), /\$\$ \{\{title\}\}/);
  assert.match(title(2), /\$\$ T/);
  assert.equal(substituteLine('$$ {{title}}', { title: 'T' }, 1), '$$ {{title}}');
  assert.equal(substituteLine('$$ {{title}}', { title: 'T' }, 2), '$$ T');
  assert.equal(substituteLine('$$ {{title}} $$', { title: 'T' }, 2), '$$ {{title}} $$', 'math on one line is math');
  assert.deepEqual(findVariables(['$$ {{a}}', '{{b}}', '$$'], 0, () => false, 2).map((v) => v.name), ['a', 'b']);
  assert.deepEqual(findVariables(['$$ {{a}}', '{{b}}', '$$'], 0, () => false, 1).map((v) => v.name), []);
});

test('math: only a line that is just $$ closes, in every reader; math still interrupts a paragraph on its own line', () => {
  const body = 'Text\n$$\nx = 1 $$\ny\n$$\n\nAfter.\n';
  assert.deepEqual(parseSmd(doc(2, body)).math, [[4, 8]]);
  assert.deepEqual(parseSmd(doc(1, body)).math, [[4, 6]]);
  assert.match(renderSmd(doc(2, body)).html, /<div class="smd-math-block" data-line="4">[\s\S]*<p data-line="9">After\.<\/p>/);
  assert.deepEqual(codes(doc(1, body)), ['7:error:math/unclosed']);
  assert.ok(codes(doc(2, body)).every((c) => c.endsWith('math/syntax')), 'v2: one block, whose $$ KaTeX rejects');
  // One-line math, and math in a container that holds a ::: line, read the same.
  for (const one of ['$$ E = mc^2 $$\n', ':::note\n$$\n:::\n$$\nIn.\n:::\n\nOut.\n']) {
    assert.equal(renderSmd(doc(2, one)).html, renderSmd(doc(1, one)).html);
    assert.ok(mathTex(renderSmd(doc(2, one)).html).length === 1, one);
    assert.deepEqual(codes(doc(2, one)), []);
  }
});

test('math: the glossary, changelog, include and quote scans skip v2 math only', () => {
  const lines = ['$$ x', ':::glossary', '- **Term**: A definition.', ':::', 'y $$', 'Use the Term.'];
  assert.deepEqual(findGlossary(lines, 0, 1).entries, []);
  const v2 = findGlossary(lines, 0, 2);
  assert.deepEqual(v2.entries.map((e) => e.term), ['Term']);
  assert.deepEqual(findTermUses(lines, 0, v2, 2).map((u) => u.line), [5]);
  const changelog = ['$$ x', ':::changelog', '## 1.0.0', ':::', 'y $$'];
  assert.deepEqual(findChangelogs(changelog, 0, 1), []);
  assert.deepEqual(findChangelogs(changelog, 0, 2).map((b) => b.entries.map((e) => e.line)), [[2]]);
  const include = ['$$ x', ':::include{file="a.smd"}', ':::', 'y $$'];
  assert.deepEqual(findIncludes(include, 0, undefined, 1), []);
  assert.deepEqual(findIncludes(include, 0, undefined, 2).map((b) => b.line), [1]);
});

test('math: an incremental parse of a v2 document equals a full one when an edit adds or removes a closing $$', () => {
  const base = `${doc(2, 'Intro\n\n$$\nx\n')}${'\npara\n'.repeat(200)}`;
  const edits = [`${base}\n$$\n`, base.replace('x\n', 'x $$\n'), `${base}\n$$\n`.replace('$$\nx\n', '$$ x\n')];
  for (const text of [base, ...edits]) {
    const incremental = parseSmd(text);
    resetParseCache();
    assert.deepEqual(parseSmd(text).math, incremental.math, text.slice(0, 40));
  }
});

// ---------------------------------------------------------------------------
// Proposal 3: closing fences
// ---------------------------------------------------------------------------

const TABS = '::::tabs\n:::tab A\nOne\n::::\n\nAfter.\n';

test('fences: render, the plugin, the Block Editor and Obsidian close the tabs and the tab with them in v2', () => {
  const v1 = renderSmd(doc(1, TABS)).html;
  const v2 = renderSmd(doc(2, TABS)).html;
  assert.match(v1, /After\.<\/p>\n<\/div>\n<\/article>/, 'v1: the tabs never close');
  assert.match(v2, /<\/section>\n<\/div>\n<p data-line="8">After\.<\/p>/);
  assert.match(new MarkdownIt().use(smd, { spec: 2 }).render(TABS), /<\/div>\n<p>After\.<\/p>/);
  assert.deepEqual(shape(segmentSmd(doc(2, TABS))), [
    ['frontmatter', 0, 3], ['container', 3, 7, [['container', 4, 6, [['paragraph', 5, 6]]]]], ['gap', 7, 8], ['paragraph', 8, 9], ['gap', 9, 10],
  ]);
  assert.deepEqual(shape(segmentSmd(doc(1, TABS))), [
    ['frontmatter', 0, 3], ['container', 3, 9, [['container', 4, 7, [['paragraph', 5, 6]]], ['gap', 7, 8], ['paragraph', 8, 9]]], ['gap', 9, 10],
  ]);
  const md = createObsidianMarkdownIt({ containers: true, directives: true } as Parameters<typeof createObsidianMarkdownIt>[0]);
  const lines = TABS.split('\n');
  assert.deepEqual(containerRanges(md, lines, 0, 2), [{ start: 0, end: 3 }]);
  assert.deepEqual(containerRanges(md, lines, 0, 1), [{ start: 0, end: 6 }]);
});

test('fences: the agent view, to-md, query, meta, quotes and includes pair closing fences by colon count in v2', () => {
  const agent = '::::agent Do\n:::note\nx\n::::\n\nAfter.\n';
  assert.equal(agentView(doc(2, agent)).text, '<agent-instructions title="Do">\n<note>\nx\n</note>\n</agent-instructions>\n\nAfter.\n');
  assert.equal(agentView(doc(1, agent)).text, '<agent-instructions title="Do">\n<note>\nx\n</note>\n\nAfter.\n');
  assert.match(smdToMarkdown(doc(2, agent)), /> > x\n>\n\nAfter\.\n$/);
  assert.match(smdToMarkdown(doc(1, agent)), /> After\.\n>$/);
  assert.deepEqual(querySmd(doc(2, agent), '*').map((m) => [m.type, m.line, m.endLine]), [['agent', 3, 6], ['note', 4, 5]]);
  assert.deepEqual(querySmd(doc(1, agent), '*').map((m) => [m.type, m.line, m.endLine]), [['agent', 3, 9], ['note', 4, 6]]);
  assert.deepEqual(getDocumentInfo(doc(2, agent)).agentBlocks, [{ title: 'Do', line: 3, content: ':::note\nx' }]);
  assert.deepEqual(getDocumentInfo(doc(1, agent)).agentBlocks, []);
  const quote = ['::::note', ':::quote{author="A"}', 'Words.', '::::', 'After.'];
  assert.deepEqual(findQuotes(quote, 0, 2).map((q) => q.empty), [false]);
  assert.equal(containerEnd(quote, 1, 2), 2, 'v2: the quote ends before the note\'s fence');
  assert.equal(containerEnd(quote, 0, 2), 3);
  assert.equal(containerEnd(quote, 1, 1), 3, 'v1: the fence closes the quote');
});

test('fences: the validator reports a container closed with one around it, and a fence that matches none', () => {
  const nested = ':::::details More\n::::note\n:::tip\nx\n:::::\n\nAfter.\n';
  assert.deepEqual(codes(doc(2, nested)), ['4:warning:container/unclosed', '5:warning:container/unclosed']);
  assert.deepEqual(codes(doc(1, nested)), ['3:error:container/unclosed', '4:error:container/unclosed', '7:hint:container/colons']);
  // The fixes add each container's own closing fence, before the one that closed it: the document then reads the same.
  const fixed = applyFixes(doc(2, nested), validateSmd(doc(2, nested))).text;
  assert.equal(fixed, doc(2, ':::::details More\n::::note\n:::tip\nx\n:::\n::::\n:::::\n\nAfter.\n'));
  assert.deepEqual(codes(fixed), []);
  assert.equal(renderSmd(fixed).html.replaceAll(/ data-line="\d+"/g, ''), renderSmd(doc(2, nested)).html.replaceAll(/ data-line="\d+"/g, ''));
  // A fence that matches no open container closes the innermost one: a warning in v2, the 1.10 hint in v1.
  const loose = ':::warning\nx\n:::::\n\nAfter.\n';
  const v2 = validateSmd(doc(2, loose));
  assert.deepEqual(v2.map((d) => `${d.line}:${d.severity}:${d.code}`), ['5:warning:container/colons']);
  assert.equal(v2[0].fix?.replacement, ':::');
  assert.deepEqual(codes(doc(1, loose)), ['5:hint:container/colons']);
  assert.equal(renderSmd(doc(2, loose)).html, renderSmd(doc(1, loose)).html);
});

test('fences: fmt writes canonical colons only where every container has its own fence', () => {
  // Balanced in v2: rewritten as in v1, and the result pairs the same way.
  const loose = ':::note\n::::warning\nx\n:::::\n:::\n';
  assert.equal(formatSmd(doc(2, loose)), doc(2, '\n::::note\n:::warning\nx\n:::\n::::\n'));
  const lineless = (text: string) => renderSmd(text).html.replaceAll(/ data-line="\d+"/g, '');
  assert.equal(lineless(formatSmd(doc(2, loose))), lineless(doc(2, loose)));
  // A container closed with the one around it has no fence of its own: the colons are left as written.
  assert.equal(formatSmd(doc(2, TABS)), doc(2, `\n${TABS}`));
  assert.match(formatSmd(doc(1, TABS)), /::::tabs\n:::tab A\nOne\n::::\n/);
});

test('fences: refactors find containers and wrap lines as the version pairs them', () => {
  const text = doc(2, '::::note\n:::tip\nx\n::::\n\nAfter.\n');
  assert.deepEqual(containerAt(text, 5), { name: 'tip', openLine: 4, closeLine: 5, nameColumn: 3 });
  assert.equal(containerAt(text, 8), undefined);
  assert.equal(containerAt(asV1(text), 8)?.name, 'note');
  // `:::tip` … `::::` closes a container outside the lines in v2, so wrapping them would change the document.
  assert.equal(wrapLines(text, 4, 6, 'box'), undefined);
  assert.ok(wrapLines(asV1(text), 4, 6, 'box'));
  assert.ok(wrapLines(text, 4, 5, 'box') === undefined, 'an unclosed tip is not balanced either');
});

// ---------------------------------------------------------------------------
// The corpus documents and their v1 twins
// ---------------------------------------------------------------------------

test('corpus/v2-math.smd and corpus/v2-fences.smd: valid and formatted; their v1 twins read differently', () => {
  const math = corpus('v2-math.smd');
  assert.deepEqual(codes(math), []);
  assert.equal(formatSmd(math), math);
  assert.deepEqual(parseSmd(math).math.length, 3);
  assert.ok(parseSmd(math).headings.some((h) => h.slug === 'plans'));
  assert.ok(!parseSmd(asV1(math)).headings.some((h) => h.slug === 'plans'), 'v1: the heading is in math');
  assert.deepEqual(codes(asV1(math)), ['21:error:math/syntax']);

  const fences = corpus('v2-fences.smd');
  assert.deepEqual(codes(fences), ['22:warning:container/unclosed', '32:warning:container/colons', '39:warning:container/unclosed', '40:warning:container/unclosed']);
  assert.equal(formatSmd(fences), fences);
  assert.deepEqual(codes(asV1(fences)), [
    '21:error:container/unclosed', '24:hint:container/colons', '32:hint:container/colons', '38:error:container/unclosed', '39:error:container/unclosed',
    '42:hint:container/colons',
  ]);
  assert.notEqual(renderSmd(fences).html, renderSmd(asV1(fences)).html);
  // The twins migrate to documents that read under v2 as they read under v1 (see migrate.test.ts for every document).
  for (const twin of [asV1(math), asV1(fences)]) {
    const result = migrationPlan(twin).result;
    const shown = (t: string) => renderSmd(t, { today: TODAY }).html.replaceAll(/ data-line="\d+"/g, '');
    assert.equal(shown(result), shown(twin));
  }
});
