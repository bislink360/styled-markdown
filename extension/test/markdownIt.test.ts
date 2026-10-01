import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import smd, { markdownItSmd, type MarkdownItSmdOptions } from '../src/core/markdownIt';
import { renderSmd } from '../src/core';

const TODAY = '2026-01-01';

/** The same markdown-it options renderSmd uses. */
const smdLikeHost = () => new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (code, lang) => (lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : ''),
});

const body = [
  '# Plan {#plan .lead}',
  '',
  '## Setup',
  '',
  '## Setup',
  '',
  ':::warning{collapsible} Mind the *gap*',
  'Body with :badge[beta]{color=green}, :kbd[Ctrl+K], :progress[40], :due[2025-12-30] and ==marked== text.',
  ':::',
  '',
  ':::tabs',
  ':::tab npm',
  '```bash',
  'npm i styled-markdown',
  '```',
  ':::',
  ':::tab Math',
  'Inline $E=mc^2$ and display:',
  '',
  '$$',
  'x^2',
  '$$',
  ':::',
  ':::',
  '',
  ':::decision{status=accepted owner=@ana} Use markdown-it',
  '[styled text]{color=red weight=bold} and a :metric[42]{label=Users delta=+5}.',
  ':::',
  '',
  ':::agent Instructions',
  'Read SPEC.md first.',
  ':::',
  '',
  '- [ ] open task :priority[P1]',
  '- [x] done task',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '```ts title="app.ts" {2}',
  'const a = 1;',
  'const b = 2;',
  '```',
  '',
].join('\n');

test('markdown-it plugin: a plain instance renders .smd syntax exactly like renderSmd', () => {
  const md = smdLikeHost().use(smd, { codeFrames: true, headingIds: true, sourceLines: true, today: TODAY });
  const expected = renderSmd(body, { today: TODAY }).html;
  assert.equal(`<article class="smd-doc">${md.render(body)}</article>`, expected);
  for (const cls of ['smd-callout-warning', 'smd-tabs', 'smd-tab', 'smd-decision', 'smd-agent', 'smd-badge', 'smd-due-overdue', 'smd-task', 'smd-diagram', 'smd-hl-line', 'katex']) {
    assert.ok(expected.includes(cls), `the comparison covers ${cls}`);
  }
});

test('markdown-it plugin: with defaults, plain Markdown renders as the host renders it', () => {
  const plain = [
    '# Title', '', 'Some *emphasis*, `code`, a [link](https://example.com) and $5 or $10.', '',
    '> quote', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '```js', 'console.log(1);', '```', '',
    '    indented code', '', '1. one', '2. two', '',
  ].join('\n');
  for (const options of [{}, { html: true, linkify: true, typographer: true }]) {
    assert.equal(new MarkdownIt(options).use(smd).render(plain), new MarkdownIt(options).render(plain));
  }
});

test('markdown-it plugin: nested containers, directives and math on a default instance', () => {
  const html = new MarkdownIt().use(smd).render(':::card Outer\n:::note\nInner :mention[@ana] $a+b$\n:::\n:::\n');
  assert.match(html, /^<div class="smd-card" data-line="0"><div class="smd-card-title">Outer<\/div><div class="smd-card-body">/);
  assert.match(html, /<div class="smd-callout smd-callout-note" data-line="1">/);
  assert.match(html, /<span class="smd-mention">@ana<\/span>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /<\/div><\/div>\n<\/div><\/div>\n$/);
  // No heading ids or source lines unless asked for.
  assert.equal(new MarkdownIt().use(smd).render('# A'), '<h1>A</h1>\n');
});

test('markdown-it plugin: options turn syntax off', () => {
  const render = (src: string, options: MarkdownItSmdOptions) => new MarkdownIt().use(smd, options).render(src);
  assert.equal(render(':::note\nx\n:::', { containers: false }), '<p>:::note\nx\n:::</p>\n');
  assert.equal(render('a :badge[x] b', { directives: false }), '<p>a :badge[x] b</p>\n');
  assert.equal(render('[a]{color=red}', { attributes: false }), '<p>[a]{color=red}</p>\n');
  assert.equal(render('==a==', { mark: false }), '<p>==a==</p>\n');
  assert.equal(render('$x$', { math: false }), '<p>$x$</p>\n');
  assert.equal(render('- [ ] a', { tasks: false }), '<ul>\n<li>[ ] a</li>\n</ul>\n');
  assert.equal(render('```mermaid\nA\n```', { fences: false }), '<pre><code class="language-mermaid">A\n</code></pre>\n');
  assert.match(render('- [x] a', {}), /<input type="checkbox" class="smd-task-box" data-task-line="0" checked>a/);
  assert.match(render('```js\nx\n```', { codeFrames: true }), /^<div class="smd-code" data-line=""><div class="smd-code-lang">js<\/div><pre>/);
  assert.match(render(':::agent\nx\n:::', { agentBlocks: 'hidden' }), /<div class="smd-agent" data-line="0" hidden>/);
  assert.match(render(':due[2026-01-03]', { today: TODAY }), /smd-due-soon/);
});

test('markdown-it plugin: front matter becomes the document header when enabled', () => {
  const src = '---\ntitle: Plan *A*\nstatus: approved\ntags: [x]\n---\n\n# Body\n';
  const html = new MarkdownIt().use(smd, { frontMatter: true }).render(src);
  assert.match(html, /^<header class="smd-doc-header" data-line="0">/);
  assert.match(html, /<h1 class="smd-doc-title">Plan <em>A<\/em><\/h1>/);
  assert.match(html, /smd-doc-status-approved/);
  assert.match(html, /<\/header>\n<h1>Body<\/h1>\n$/);
  // Off by default: the host decides what front matter means.
  assert.match(new MarkdownIt().use(smd).render(src), /^<hr>/);
  // Not front matter: unclosed, or not on the first line.
  assert.match(new MarkdownIt().use(smd, { frontMatter: true }).render('---\ntitle: x\n'), /^<hr>/);
  assert.match(new MarkdownIt().use(smd, { frontMatter: true }).render('text\n\n---\ntitle: x\n---\n'), /^<p>text<\/p>\n<hr>/);
});

test('markdown-it plugin: coexists with other plugins and keeps host options', () => {
  // Another plugin that wraps the fence renderer and adds an inline rule.
  const other = (md: MarkdownIt) => {
    const fence = md.renderer.rules.fence!;
    md.renderer.rules.fence = (tokens, idx, opts, env, self) => `<div class="other">${fence(tokens, idx, opts, env, self)}</div>`;
    md.inline.ruler.before('emphasis', 'shout', (state, silent) => {
      if (!state.src.startsWith('!!', state.pos)) return false;
      if (!silent) state.push('html_inline', '', 0).content = '<b>!</b>';
      state.pos += 2;
      return true;
    });
  };
  const src = ':::note <i>Title</i>\nHi!! <u>raw</u>\n:::\n\n```js\nx\n```\n\n```mermaid\nA\n```\n';
  for (const md of [new MarkdownIt({ html: false }).use(other).use(smd), new MarkdownIt({ html: false }).use(smd).use(other)]) {
    const html = md.render(src);
    assert.match(html, /<span>&lt;i&gt;Title&lt;\/i&gt;<\/span>/, 'raw HTML stays off in titles');
    assert.match(html, /Hi<b>!<\/b> &lt;u&gt;raw&lt;\/u&gt;/, 'the other inline rule and html: false apply');
    assert.match(html, /<div class="other"><pre><code class="language-js">x\n<\/code><\/pre>\n<\/div>/, 'plain code goes through the other renderer');
    assert.match(html, /<pre class="smd-mermaid">A\n<\/pre>/);
  }
  const allowed = new MarkdownIt({ html: true }).use(smd).render(':::note <i>Title</i>\n:::\n');
  assert.match(allowed, /<span><i>Title<\/i><\/span>/, "the host's html option applies to titles");
});

test('markdown-it plugin: file embeds read through readFile with the render env', () => {
  const seen: unknown[] = [];
  const md = new MarkdownIt().use(smd, {
    readFile: (path, env) => {
      seen.push(env);
      return path === 'a.ts' ? 'one\ntwo\nthree\n' : undefined;
    },
  });
  const env = { doc: 'guide.md' };
  assert.match(md.render('```ts file="a.ts" lines="2-3"\n```\n', env), /<div class="smd-code-title">a.ts:2-3<\/div><pre><code class="language-ts">two\nthree\n<\/code><\/pre>/);
  assert.equal(seen[0], env);
  assert.match(md.render('```ts file="b.ts"\n```\n'), /<div class="smd-error">Cannot read b.ts<\/div>/);
  assert.match(new MarkdownIt().use(smd).render('```ts file="a.ts"\n```\n'), /Cannot read a.ts/);
});

test('markdown-it plugin: renders without an env, is idempotent, and leaves its rules named', () => {
  const md = new MarkdownIt().use(smd, { headingIds: true, sourceLines: true });
  const tokens = md.parse(':::note\n- [ ] a\n:::\n\n# H {#h}\n', {});
  assert.match(md.renderer.render(tokens, md.options, undefined), /smd-callout-note/);
  const once = md.render(':::tip\n==x==\n:::\n');
  markdownItSmd(md);
  md.use(smd);
  assert.equal(md.render(':::tip\n==x==\n:::\n'), once);
  // Hosts can switch single rules off by name.
  const host = new MarkdownIt().use(smd).disable(['smd_container', 'smd_directive']);
  assert.equal(host.render(':::note\n:badge[x] ==y==\n:::'), '<p>:::note\n:badge[x] <mark>y</mark>\n:::</p>\n');
});

test('markdown-it plugin: heading ids are unique within a document without a shared env', () => {
  const md = new MarkdownIt().use(smd, { headingIds: true });
  assert.equal(md.render('# Setup\n# Setup\n# Other {#mine}'), '<h1 id="setup">Setup</h1>\n<h1 id="setup-1">Setup</h1>\n<h1 id="mine">Other</h1>\n');
  assert.equal(md.render('# Setup'), '<h1 id="setup">Setup</h1>\n', 'each render starts over');
});

const npmDir = join(__dirname, '..', '..', 'npm');
const built = existsSync(join(npmDir, 'dist', 'markdown-it.cjs'));
const skipNpm = !built && 'run npm run build:npm first';

test('npm package: styled-markdown/markdown-it resolves and loads with require and import', { skip: skipNpm }, async () => {
  const pkg = JSON.parse(readFileSync(join(npmDir, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'zero runtime dependencies');
  assert.equal(pkg.peerDependenciesMeta['markdown-it'].optional, true);
  // Resolve through the package's own exports map (self-reference by name).
  const requireFromPkg = createRequire(join(npmDir, 'package.json'));
  const cjsPath = requireFromPkg.resolve('styled-markdown/markdown-it');
  assert.ok(cjsPath.endsWith(join('dist', 'markdown-it.cjs')));
  assert.ok(existsSync(join(npmDir, pkg.exports['./markdown-it'].types)), 'types are emitted');

  const cjs = requireFromPkg('styled-markdown/markdown-it');
  assert.equal(typeof cjs, 'function', 'require() returns the plugin itself');
  assert.equal(cjs.default, cjs);
  assert.match(new MarkdownIt().use(cjs).render(':::note\nx\n:::'), /smd-callout-note/);

  const esm = await import(pathToFileURL(join(npmDir, pkg.exports['./markdown-it'].import)).href);
  assert.match(new MarkdownIt().use(esm.default).render(':badge[x]'), /smd-badge/);

  // The plugin bundle never carries its own markdown-it.
  const source = readFileSync(cjsPath, 'utf8');
  assert.doesNotMatch(source, /require\("markdown-it"\)/);
  assert.doesNotMatch(source, /linkify-it|punycode/);
});
