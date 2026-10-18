// The npm API changes of 2.0 (docs/SPEC-V2-PROPOSALS.smd, "Tool and API changes for 2.0"): inlineText's options
// object, one readFile signature, the read-only vocabulary, the markdown-it plugin's `preset: 'smd'`, and which .md
// files VS Code's built-in Markdown preview gives .smd syntax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import * as api from '../src/core';
import { inlineText, renderSmd, type ReadFile } from '../src/core';
import smd from '../src/core/markdownIt';
import { applySmd, hostContext, smdFeatures } from '../src/core/markdownItSetup';
import { applyWhen, previewApplies, previewMode } from '../src/markdownPreviewGate';

const TODAY = '2026-01-01';

// ---------------------------------------------------------------------------
// inlineText(line, options)
// ---------------------------------------------------------------------------

test('inlineText takes its options as one object', () => {
  const line = 'Ship :badge[v2] by :due[2025-12-30], see :ref[fig-a], for {{team}}';
  const figures = new Map([['fig-a', { label: 'Figure 1', kind: 'figure', number: 1 }]]) as never;
  assert.equal(inlineText(line), 'Ship [v2] by (due 2025-12-30), see :ref[fig-a], for {{team}}');
  assert.equal(inlineText(line, {}), inlineText(line));
  assert.equal(
    inlineText(line, { today: TODAY, openTask: true, figures, variables: { team: 'Core' } }),
    'Ship [v2] by (due 2025-12-30, OVERDUE), see Figure 1 (fig-a), for Core',
  );
  // Overdue only on an open task.
  assert.equal(inlineText(':due[2025-12-30]', { today: TODAY }), '(due 2025-12-30)');
  // `math`: the line's inline math, as read with the lines around it, is kept as written.
  assert.equal(inlineText('a ==b== $x==y$', { math: [[8, 14]] }), 'a b $x==y$');
});

test('inlineText: the 1.x positional arguments throw a TypeError that shows the new call', () => {
  const legacy = inlineText as unknown as (line: string, ...args: unknown[]) => string;
  assert.throws(() => legacy(':due[2025-12-30]', TODAY, true), { name: 'TypeError', message: /inlineText\(line, \{ today, openTask: true \}\)/ });
  assert.throws(() => legacy('x', null), TypeError);
});

// ---------------------------------------------------------------------------
// readFile(relativePath, env?)
// ---------------------------------------------------------------------------

const EMBED = '```ts file="a.ts"\n```\n\n:::include{file="part.smd"}\n:::\n';
const FILES: Record<string, string> = { 'a.ts': 'const a = 1;\n', 'part.smd': 'Included :badge[x].\n' };

test('readFile: renderSmd and the markdown-it plugin call it the same way, with the render env', () => {
  const calls: Array<[string, unknown]> = [];
  const readFile: ReadFile = (path, env) => {
    calls.push([path, env]);
    return FILES[path];
  };
  const html = renderSmd(EMBED, { readFile }).html;
  assert.match(html, /a = <span class="hljs-number">1<\/span>;/);
  assert.match(html, /Included <span class="smd-badge">x<\/span>/);
  assert.deepEqual(calls.map(([path]) => path).sort(), ['a.ts', 'part.smd']);
  assert.ok(calls.every(([, env]) => typeof env === 'object' && env !== null && env === calls[0][1]), 'one env object per render');

  calls.length = 0;
  const env = { doc: 'x.md' };
  const plugin = new MarkdownIt().use(smd, { readFile }).render(EMBED, env);
  assert.match(plugin, /Included <span class="smd-badge">x<\/span>/);
  assert.deepEqual(calls.map(([path, e]) => [path, e === env]).sort(), [['a.ts', true], ['part.smd', true]]);
});

test('readFile: a one-argument function still works for both', () => {
  const readFile = (path: string) => FILES[path];
  assert.match(renderSmd(EMBED, { readFile }).html, /Included <span class="smd-badge">x<\/span>/);
  assert.match(new MarkdownIt().use(smd, { readFile }).render(EMBED), /Included <span class="smd-badge">x<\/span>/);
});

// ---------------------------------------------------------------------------
// The read-only vocabulary
// ---------------------------------------------------------------------------

/** Every exported table of the vocabulary (spec.ts, through `export * from './spec'`). */
const TABLES = [
  'NAMED_COLORS', 'DECISION_STATUS', 'RISK_LEVELS', 'RISK_STATUS', 'HTTP_METHODS', 'PRIORITY_VALUES', 'CALLOUT_TYPES', 'FIGURE_KINDS',
  'CONTAINERS', 'STYLE_KEYS', 'SIZE_VALUES', 'WEIGHT_VALUES', 'FONT_VALUES', 'ALIGN_VALUES', 'TEXT_STYLE_VALUES', 'INLINE_DIRECTIVES',
  'VARIABLE_SYNTAX', 'FRONTMATTER_KEYS', 'STATUS_VALUES', 'AUDIENCE_VALUES', 'MERMAID_TYPES',
] as const;

function assertDeeplyFrozen(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), `${path} is frozen`);
  for (const [key, child] of Object.entries(value)) assertDeeplyFrozen(child, `${path}.${key}`);
}

test('vocabulary: every exported table is deeply frozen', () => {
  const exported = api as unknown as Record<string, unknown>;
  for (const name of TABLES) {
    assert.ok(exported[name] !== undefined, `${name} is exported`);
    assertDeeplyFrozen(exported[name], name);
  }
  // Nested objects and arrays too.
  assert.ok(Object.isFrozen(api.CONTAINERS.decision.values?.status));
  assert.ok(Object.isFrozen(api.INLINE_DIRECTIVES.metric.attrs));
});

test('vocabulary: changing a table throws in strict mode and changes nothing', () => {
  // ES modules and TypeScript output are strict; the arrow functions here are too.
  const tables = api as unknown as {
    CONTAINERS: Record<string, { attrs?: string[] }>; NAMED_COLORS: string[]; FRONTMATTER_KEYS: Record<string, string>;
    INLINE_DIRECTIVES: Record<string, { values?: Record<string, string[]> }>;
  };
  assert.throws(() => { 'use strict'; tables.CONTAINERS.mine = { attrs: [] }; }, TypeError);
  assert.throws(() => { 'use strict'; tables.CONTAINERS.note.attrs?.push('x'); }, TypeError);
  assert.throws(() => { 'use strict'; tables.NAMED_COLORS.push('chartreuse'); }, TypeError);
  assert.throws(() => { 'use strict'; delete tables.FRONTMATTER_KEYS.title; }, TypeError);
  assert.throws(() => { 'use strict'; tables.INLINE_DIRECTIVES.metric.values!.trend[0] = 'sideways'; }, TypeError);
  assert.equal(api.CONTAINERS.mine, undefined);
  assert.deepEqual(api.CONTAINERS.note.attrs, ['title', 'collapsible']);
  assert.equal(api.NAMED_COLORS.length, 14);
  assert.ok(api.FRONTMATTER_KEYS.title);
  // A copy can be changed.
  const mine = { ...api.CONTAINERS, mine: { description: 'Mine' } };
  assert.equal(mine.mine.description, 'Mine');
});

// ---------------------------------------------------------------------------
// The markdown-it plugin's preset: 'smd'
// ---------------------------------------------------------------------------

const PRESET_DOC = [
  '---', 'title: Plan', 'status: draft', '---', '', '# Plan', '', '## Setup', '', '## Setup', '',
  '"Quotes" -- and dashes... at example.com', '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
  ':::note Heads up', 'Use :badge[smd].', ':::', '', '```ts title="app.ts"', 'const a = 1;', '```', '',
].join('\n');

test('preset: smd renders like renderSmd', () => {
  const md = new MarkdownIt({
    html: true,
    highlight: (code, lang) => (lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : ''),
  }).use(smd, { preset: 'smd', today: TODAY });
  const expected = renderSmd(PRESET_DOC, { today: TODAY }).html;
  // The same HTML, but for the line break after the header (the plugin renders it as a block).
  assert.equal(`<article class="smd-doc">${md.render(PRESET_DOC)}</article>`.replace('</header>\n', '</header>'), expected);
  for (const part of ['smd-doc-header', 'id="setup-1"', 'smd-table-wrap', 'scope="col"', '“Quotes” – and dashes…', 'href="http://example.com"', 'smd-code-title', 'data-line']) {
    assert.ok(expected.includes(part), `the comparison covers ${part}`);
  }
});

test('preset: without it the defaults are as before; options passed win over the preset', () => {
  const plain = new MarkdownIt().use(smd).render(PRESET_DOC);
  // (Containers always have their data-line.)
  assert.doesNotMatch(plain, /smd-doc-header|id="setup|smd-table-wrap|“/);
  assert.match(plain, /<h1>Plan<\/h1>/);
  const md = new MarkdownIt().use(smd, { preset: 'smd', headingIds: false, sourceLines: false, frontMatter: false, codeFrames: undefined });
  const html = md.render(PRESET_DOC);
  assert.doesNotMatch(html, /smd-doc-header|id="setup/);
  assert.match(html, /<h1>Plan<\/h1>/);
  assert.match(html, /smd-table-wrap/);
  assert.match(html, /<div class="smd-code"/, 'an option left undefined takes the preset’s value');
  // The instance's typographer and linkify can be set back after the plugin.
  md.set({ typographer: false, linkify: false });
  assert.match(md.render('"a" at example.com'), /^<p>&quot;a&quot; at example.com<\/p>/);
});

test('preset: raw HTML stays the host’s choice', () => {
  assert.match(new MarkdownIt().use(smd, { preset: 'smd' }).render('<b>x</b>'), /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(new MarkdownIt({ html: true }).use(smd, { preset: 'smd' }).render('<b>x</b>'), /<b>x<\/b>/);
});

// ---------------------------------------------------------------------------
// smd.markdownPreview.enabled: which .md files get .smd syntax in VS Code's built-in preview
// ---------------------------------------------------------------------------

test('preview setting: the mode, with 1.x booleans migrated', () => {
  assert.equal(previewMode(undefined), 'opt-in');
  assert.equal(previewMode({}), 'opt-in', 'nothing set: the new default (1.x’s default true no longer counts)');
  assert.equal(previewMode({ globalValue: true }), 'always', 'true set by the user');
  assert.equal(previewMode({ globalValue: false }), 'never');
  assert.equal(previewMode({ globalValue: 'always' }), 'always');
  assert.equal(previewMode({ globalValue: 'never' }), 'never');
  assert.equal(previewMode({ globalValue: 'opt-in' }), 'opt-in');
  assert.equal(previewMode({ globalValue: 'sometimes' }), 'opt-in');
  // The most specific scope wins.
  assert.equal(previewMode({ globalValue: true, workspaceValue: 'never' }), 'never');
  assert.equal(previewMode({ globalValue: 'never', workspaceFolderValue: true }), 'always');
  assert.equal(previewMode({ workspaceFolderValue: false, workspaceFolderLanguageValue: 'always' }), 'always');
});

test('preview setting: which sources get the syntax', () => {
  const plain = '# Notes\n\n:::note\nx\n:::\n';
  for (const source of ['---\nsmd: 1\n---\n# A\n', '---\nsmd: 2\n---\n# A\n', '---\nsmd: "2"\n---\n', '---\ntitle: A\nsmd: 3\n---\n']) {
    assert.equal(previewApplies('opt-in', source), true, source);
  }
  for (const source of [plain, '---\ntitle: A\n---\n# A\n', '---\nsmd: true\n---\n', '---\nsmd: v2\n---\n', '---\nsmd: 1\n', '# A\n---\nsmd: 1\n---\n']) {
    assert.equal(previewApplies('opt-in', source), false, source);
  }
  assert.equal(previewApplies('always', plain), true);
  assert.equal(previewApplies('never', '---\nsmd: 1\n---\n'), false);
});

/** What extendMarkdownIt does in `opt-in` mode, on a host instance like VS Code's. */
function optInPreview(host: MarkdownIt): MarkdownIt {
  const options = { tasks: false };
  applyWhen(host, (source) => previewApplies('opt-in', source), (target) => applySmd(target, smdFeatures(options), hostContext(host, options)));
  return host;
}

const MD_FILE = ':::note Heads up\nUse :badge[smd] in **.md** files.\n:::\n\n```mermaid\ngraph TD; A-->B\n```\n\n```js title="x.js"\nplain();\n```\n\n> [!TIP]\n> An alert.\n';

test('preview opt-in: a .md file without an smd key renders exactly as the host renders it', () => {
  const md = optInPreview(new MarkdownIt());
  assert.equal(md.render(MD_FILE), new MarkdownIt().render(MD_FILE));
  // Parsed once and rendered later, as VS Code does (it caches the tokens).
  const tokens = md.parse(MD_FILE, {});
  assert.equal(md.renderer.render(tokens, md.options, {}), new MarkdownIt().render(MD_FILE));
});

test('preview opt-in: a .md file with smd: 1 or smd: 2 gets the syntax, as with the setting at always', () => {
  const always = new MarkdownIt();
  applySmd(always, smdFeatures({ tasks: false }), hostContext(always, { tasks: false }));
  const md = optInPreview(new MarkdownIt());
  for (const version of [1, 2]) {
    const source = `---\nsmd: ${version}\n---\n\n${MD_FILE}`;
    const html = md.render(source);
    assert.equal(html, always.render(source));
    assert.match(html, /<div class="smd-callout smd-callout-note"/);
    assert.match(html, /<span class="smd-badge">smd<\/span>/);
    assert.match(html, /<pre class="smd-mermaid">/);
    assert.match(html, /smd-callout-tip/);
    // Parsed now, rendered later with another env, as VS Code does.
    assert.equal(md.renderer.render(md.parse(source, {}), md.options, {}), html);
  }
  // Documents of both kinds, one after the other, on one instance.
  assert.equal(md.render(MD_FILE), new MarkdownIt().render(MD_FILE));
  assert.match(md.render(`---\nsmd: 1\n---\n${MD_FILE}`), /smd-callout-note/);
});
