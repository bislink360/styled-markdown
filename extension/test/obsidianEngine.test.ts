// The Obsidian plugin's pure logic (integrations/obsidian): the engine it bundles (src/obsidianEngine.ts), the
// section-to-source mapping, the render sync, settings, DOM helpers that need no DOM, and the styles.css transform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ObsidianEngine, findInlineSyntax, labelEnd, parseWikiLink, type ObsidianEngineOptions } from '../src/obsidianEngine';
import { RenderSync, planSection } from '../../integrations/obsidian/src/sections';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../integrations/obsidian/src/settings';
import { fenced, mayHaveSyntax, tabKeyTarget } from '../../integrations/obsidian/src/dom';
import { SCOPE, obsidianCss, obsidianSelector, parseCss, splitSelectors } from '../../integrations/obsidian/scripts/styles.mjs';

const ALL: ObsidianEngineOptions = { containers: true, directives: true, agentBlocks: 'collapsed', today: '2026-10-10' };
const engine = (options: Partial<ObsidianEngineOptions> = {}) => new ObsidianEngine({ ...ALL, ...options });

const NOTE = [
  '---', //                                 0
  'version: 2.1', //                        1
  '---', //                                 2
  'Intro :badge[Beta]{color=green}', //     3
  '', //                                    4
  ':::note Setup', //                       5
  'First paragraph.', //                    6
  '', //                                    7
  '```js', //                               8
  ':::', //                                 9  (inside a code fence: not a close)
  '```', //                                 10
  '', //                                    11
  ':::tip', //                              12
  'Nested {{version}}.', //                 13
  ':::', //                                 14
  ':::', //                                 15
  'Right after the container.', //         16
  '', //                                    17
  ':::warning Left open', //                18
  'Runs to the end.', //                    19
].join('\n');

test('document() finds the outermost containers by line, past fences and nesting, and reads the front matter', () => {
  const doc = engine().document(NOTE);
  assert.deepEqual(doc.containers, [{ start: 5, end: 15 }, { start: 18, end: 19 }]);
  assert.deepEqual(doc.variables, { version: 2.1 });
  assert.equal(doc.lines.length, 20);
  assert.equal(engine().document(NOTE.replaceAll('\n', '\r\n')).containers.length, 2);
  assert.deepEqual(engine({ containers: false }).document(NOTE).containers, []);
});

test('document() caches the last note and blanks the front matter before parsing', () => {
  const e = engine();
  assert.equal(e.document(NOTE), e.document(NOTE));
  // A `:::` line inside the front matter is no container.
  assert.deepEqual(e.document('---\nx: ":::note"\n:::note\n---\nText').containers, []);
  // Containers inside a list are found where the engine sees them.
  assert.deepEqual(e.document('- item\n\n  :::note\n  Inside\n  :::\n').containers, [{ start: 2, end: 4 }]);
});

test('renderLines() renders a container with its nested blocks and the note variables', () => {
  const e = engine();
  const doc = e.document(NOTE);
  const html = e.renderLines(doc, doc.containers[0]);
  assert.match(html, /class="smd-callout smd-callout-note"/);
  assert.match(html, /class="smd-callout smd-callout-tip"/);
  assert.match(html, /Nested 2\.1\./);
  assert.match(html, /<span class="hljs-keyword">const<\/span>|:::/);
});

test('raw HTML in a note is never passed through as HTML', () => {
  const e = engine();
  const html = e.render(':::note\n<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n:badge[<b>x</b>]\n:::');
  assert.doesNotMatch(html, /<script|<img|<b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const segments = e.inlineSegments(':badge[<img src=x onerror=alert(1)>]');
  assert.doesNotMatch(JSON.stringify(segments), /<img/);
});

test('wikilinks become Obsidian internal links; links with a scheme get no href', () => {
  const html = engine().render(':::note\n[[Projects/Plan#Goals|the plan]] and ![[diagram.png]] and [[javascript:alert(1)]]\n:::');
  assert.match(html, /<a class="internal-link" data-href="Projects\/Plan#Goals" href="Projects\/Plan#Goals" target="_blank" rel="noopener nofollow">the plan<\/a>/);
  assert.match(html, /<a class="internal-link smd-obsidian-embed" data-href="diagram.png" href="diagram.png"/);
  assert.match(html, /<a class="internal-link" data-href="javascript:alert\(1\)" target="_blank"/);
  assert.deepEqual(parseWikiLink(' Note | Label '), { target: 'Note', label: 'Label', embed: false });
  assert.equal(parseWikiLink('a[b'), null);
  assert.equal(parseWikiLink(' |x'), null);
});

test('math and Mermaid are left for Obsidian to render', () => {
  const e = engine();
  const html = e.render(':::note\nInline $x^2$.\n\n$$\na<b\n$$\n\n```math\ny\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n:::');
  assert.match(html, /<span class="smd-obsidian-math" data-tex="x\^2">x\^2<\/span>/);
  assert.match(html, /<div class="smd-math-block smd-obsidian-math" data-tex="a&lt;b" data-display="true">/);
  assert.match(html, /data-tex="y" data-display="true"/);
  assert.match(html, /<div class="smd-diagram"[^>]*><pre class="smd-mermaid">graph TD\n {2}A--&gt;B\n<\/pre><\/div>/);
  assert.doesNotMatch(html, /class="katex/);
});

test('agent blocks follow the setting', () => {
  const source = ':::agent\nFor the agent.\n:::';
  assert.match(engine().render(source), /<details class="smd-agent"/);
  assert.match(engine({ agentBlocks: 'expanded' }).render(source), /For the agent\./);
  assert.match(engine({ agentBlocks: 'hidden' }).render(source), /<div class="smd-agent"[^>]* hidden>/);
});

test('renderFenced() renders a ```smd block as its own document, with its front matter as variables', () => {
  const html = engine().renderFenced('---\nowner: Ana\n---\n:::note\n{{owner}} owns {{version}}.\n:::', { variables: { version: '3' } });
  assert.match(html, /Ana owns 3\./);
  assert.doesNotMatch(html, /owner: Ana/);
});

test('findInlineSyntax() finds directives and styled spans where the engine would', () => {
  const text = 'A :badge[Beta]{color=green}, [red]{color=red} and :due[2026-10-01] but not a:badge[x], :nope[x], ![img]{x=1} or [x]{=}';
  const found = findInlineSyntax(text).map(({ start, end }) => text.slice(start, end));
  assert.deepEqual(found, [':badge[Beta]{color=green}', '[red]{color=red}', ':due[2026-10-01]']);
  assert.deepEqual(findInlineSyntax(':progress{value=60} (:kbd[Ctrl+[]])').map((m) => m.end - m.start), [19, 13]);
  assert.deepEqual(findInlineSyntax(':badge[unclosed'), []);
  assert.equal(labelEnd('[a\\]b]', 0), 5);
  assert.equal(labelEnd('[a[b]c]', 0), 6);
});

test('inlineSegments() splits a text node around what the engine renders', () => {
  const e = engine();
  const segments = e.inlineSegments('Ship :status[done] by :due[2026-10-01] :badge[v{{version}}]', { variables: { version: '2' } });
  assert.ok(segments);
  assert.deepEqual(segments.map((s) => s.html !== undefined), [false, true, false, true, false, true]);
  assert.equal(segments[0].text, 'Ship ');
  assert.match(String(segments[1].html), /class="smd-status"/);
  assert.match(String(segments[3].html), /class="smd-due smd-due-overdue"/);
  assert.match(String(segments[5].html), />v2</);
  assert.equal(e.inlineSegments('Plain text: nothing [here].'), null);
  assert.equal(engine({ directives: false }).inlineSegments(':badge[x]'), null);
});

test('planSection() keeps, renders or hides a section', () => {
  const containers = [{ start: 5, end: 15 }, { start: 18, end: 19 }];
  assert.deepEqual(planSection(containers, 3, 3), { kind: 'keep', owned: [] });
  // The section with the opening line draws the whole container.
  assert.deepEqual(planSection(containers, 5, 6), { kind: 'render', start: 5, end: 15, partOf: undefined, owned: [containers[0]] });
  // Sections inside it are hidden…
  assert.deepEqual(planSection(containers, 8, 10), { kind: 'hide', partOf: containers[0], owned: [] });
  assert.equal(planSection(containers, 12, 15).kind, 'hide');
  // …and one that runs past its end keeps its own lines after it, here with the next container.
  assert.deepEqual(planSection(containers, 13, 18), { kind: 'render', start: 16, end: 19, partOf: containers[0], owned: [containers[1]] });
  assert.deepEqual(planSection(containers, 14, 16), { kind: 'render', start: 16, end: 16, partOf: containers[0], owned: [] });
  // Text right before a container in the same section is drawn with it.
  assert.deepEqual(planSection(containers, 3, 5), { kind: 'render', start: 3, end: 15, partOf: undefined, owned: [containers[0]] });
});

const NOTE_PATH = 'a.md';

test('RenderSync asks for a full render only when an incremental render left a container stale', () => {
  const sync = new RenderSync();
  const c = { start: 0, end: 4 };
  // First render: the drawing section and the hidden ones agree.
  assert.equal(sync.drawn(NOTE_PATH, 'v1', c, 'src1', 1), false);
  assert.equal(sync.hidden(NOTE_PATH, 'v1', c, 'src1'), false);
  // An edit inside the container re-renders only the hidden section: the drawing is stale.
  assert.equal(sync.hidden(NOTE_PATH, 'v2', c, 'src2'), true);
  // Asked once per text: the full render that follows doesn't ask again.
  assert.equal(sync.hidden(NOTE_PATH, 'v2', c, 'src2'), false);
  assert.equal(sync.drawn(NOTE_PATH, 'v2', c, 'src2', 1), false);
  assert.equal(sync.hidden(NOTE_PATH, 'v2', c, 'src2'), false);
  // The container grows: the sections after its old end must be rendered again.
  assert.equal(sync.drawn(NOTE_PATH, 'v3', { start: 0, end: 6 }, 'src3', 1), true);
  // A new container spanning other sections, after the first render.
  assert.equal(sync.drawn(NOTE_PATH, 'v4', { start: 8, end: 12 }, 'src4', 9), true);
  // …but not one that fits in its own section.
  assert.equal(sync.drawn(NOTE_PATH, 'v5', { start: 20, end: 21 }, 'src5', 21), false);
  // On a note's first render a hidden section may come before the one that draws its container.
  assert.equal(sync.hidden('b.md', 'w1', c, 'x'), false);
  sync.clear();
  assert.equal(sync.drawn(NOTE_PATH, 'v6', c, 'src', 1), false);
});

test('settings: saved data is normalized', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ containers: false, agentBlocks: 'hidden', smdFiles: 'yes', extra: 1 }), {
    containers: false, inlineDirectives: true, agentBlocks: 'hidden', smdFiles: true,
  });
  assert.equal(normalizeSettings({ agentBlocks: 'toString' }).agentBlocks, 'collapsed');
});

test('DOM helpers: tab keys, fences and the quick syntax test', () => {
  assert.equal(tabKeyTarget('ArrowRight', 2, 3), 0);
  assert.equal(tabKeyTarget('ArrowLeft', 0, 3), 2);
  assert.equal(tabKeyTarget('Home', 2, 3), 0);
  assert.equal(tabKeyTarget('End', 0, 3), 2);
  assert.equal(tabKeyTarget('Enter', 0, 3), -1);
  assert.equal(tabKeyTarget('ArrowRight', -1, 3), -1);
  assert.equal(fenced('mermaid', 'graph TD\n'), '```mermaid\ngraph TD\n```');
  assert.equal(fenced('mermaid', 'a ```` b'), '`````mermaid\na ```` b\n`````');
  assert.equal(mayHaveSyntax('Plain text.'), false);
  assert.equal(mayHaveSyntax('Time: 10:30'), false);
  assert.equal(mayHaveSyntax(':badge[x]'), true);
  assert.equal(mayHaveSyntax('[x]{color=red}'), true);
});

test('styles.css: smd.css scoped to rendered notes, on Obsidian theme variables', () => {
  const smdCss = readFileSync(join(__dirname, '..', 'media', 'smd.css'), 'utf8');
  const css = obsidianCss(smdCss);
  const rules = parseCss(css);
  const selectors = rules.flatMap((r) => (r.children ?? [r]).flatMap((c) => splitSelectors(c.prelude)));
  for (const s of selectors) {
    assert.ok(s.startsWith(SCOPE) || s.startsWith('body') || s.startsWith('.smd-obsidian'), s);
  }
  assert.doesNotMatch(css, /:root|\.smd-doc(?![\w-])|\.smd-body/);
  assert.match(css, /body\.theme-light, body\.theme-dark \{[^}]*--smd-bg: var\(--background-primary\)/);
  assert.match(css, /--smd-accent-default: var\(--interactive-accent\)/);
  // The theme mapping comes after smd.css's own dark palette, so it wins.
  assert.ok(css.indexOf('body.theme-light, body.theme-dark') > css.indexOf('body.theme-dark {'));
  assert.match(css, new RegExp(`${escapeRegExp(SCOPE)} \\.smd-code \\.hljs-keyword`));
  assert.match(css, /\.smd-obsidian-hidden \{ display: none; \}/);
  assert.match(css, /@media print \{/);
});

test('styles.css: selectors for plain Markdown elements are left out', () => {
  assert.equal(obsidianSelector('.smd-doc h2'), null);
  assert.equal(obsidianSelector('html'), null);
  assert.equal(obsidianSelector('body.smd-body'), null);
  assert.equal(obsidianSelector('.smd-doc a.smd-term'), `${SCOPE} a.smd-term`);
  assert.equal(obsidianSelector('.smd-doc-header'), `${SCOPE} .smd-doc-header`);
  assert.equal(obsidianSelector('.hljs-string'), `${SCOPE} .smd-code .hljs-string`);
  assert.equal(obsidianSelector(':root[data-smd-theme="dark"]'), 'body.theme-dark');
  assert.deepEqual(splitSelectors('a, :is(b, c), d[x=","]'), ['a', ':is(b, c)', 'd[x=","]']);
  assert.throws(() => obsidianCss(':root { --a: 1; }'), /no :root\[data-smd-theme="dark"\] palette/);
});

function escapeRegExp(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
