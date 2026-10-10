// The MkDocs plugin's bridge (src/mkdocsBridge.ts): its JSON-lines protocol, and the bundled copy in the Python package.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MkdocsBridge, scopeCodeColors, type BridgeRender } from '../src/mkdocsBridge';

const bundle = join(__dirname, '..', 'dist', 'mkdocs-bridge.cjs');
const packaged = join(__dirname, '..', '..', 'integrations', 'mkdocs', 'mkdocs_styled_markdown', 'bridge.cjs');

const root = mkdtempSync(join(tmpdir(), 'smd-mkdocs-bridge-'));
const docs = join(root, 'docs');
after(() => rmSync(root, { recursive: true, force: true }));

function put(file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

put('secret.smd', '# Secret\n\nOutside the docs folder.\n');
put('docs/_partials/terms.smd', '## Terms\n\nShared terms.\n');
put('docs/b.md', '# B\n\n## Part {#x}\n');
put('docs/guide/a.smd', [
  '---',
  'title: Guide A',
  '---',
  '',
  '## Setup',
  '',
  'See [B](../b.md#x), [home](../index.md), ![logo](img/logo.png) and [web](https://example.com).',
  '',
  ':::include{file="../_partials/terms.smd"}',
  'Fallback for terms.',
  ':::',
  '',
  ':::include{file="../../secret.smd"}',
  'Secret fallback.',
  ':::',
  '',
  '### Details',
  '',
  '[Missing](nowhere.smd)',
  '',
].join('\n'));

const pages = { 'index.md': './', 'b.md': 'b/', 'guide/a.smd': 'guide/a/' };

function fresh(): MkdocsBridge {
  const bridge = new MkdocsBridge();
  bridge.handle({ id: 0, method: 'site', params: { docsDir: docs, pages, today: '2026-10-10' } });
  return bridge;
}

const render = (bridge: MkdocsBridge, params: Record<string, unknown>) => bridge.handle({ id: 7, method: 'render', params }).result as BridgeRender;

test('hello reports the protocol, the package version and Node', () => {
  const { id, result } = new MkdocsBridge().handle({ id: 'h', method: 'hello' });
  assert.equal(id, 'h');
  const hello = result as { protocol: number; version: string; node: string };
  assert.equal(hello.protocol, 1);
  assert.match(hello.version, /^\d+\.\d+\.\d+/);
  assert.equal(hello.node, process.versions.node);
});

test('site counts the pages; render needs it first', () => {
  const bridge = new MkdocsBridge();
  assert.deepEqual(bridge.handle({ id: 1, method: 'render', params: { path: 'guide/a.smd' } }), { id: 1, error: { message: 'Call "site" before "render".' } });
  assert.deepEqual(bridge.handle({ id: 2, method: 'site', params: { docsDir: docs, pages } }), { id: 2, result: { pages: 3 } });
  assert.match(bridge.handle({ id: 3, method: 'site', params: {} }).error!.message, /"docsDir" must be a non-empty string/);
});

test('render: title, headings, links to page URLs, includes sandboxed to the docs folder', () => {
  const page = render(fresh(), { path: 'guide/a.smd' });
  assert.equal(page.title, 'Guide A');
  assert.equal(page.lang, 'en');
  assert.deepEqual(page.headings.map((h) => [h.level, h.text, h.slug]), [[2, 'Setup', 'setup'], [2, 'Terms', 'terms'], [3, 'Details', 'details']]);
  assert.match(page.html, /<h1[^>]*>Guide A<\/h1>/);
  assert.match(page.html, /href="\.\.\/\.\.\/b\/#x"/);
  assert.match(page.html, /href="\.\.\/\.\.\/"/);
  assert.match(page.html, /src="\.\.\/img\/logo\.png"/);
  assert.match(page.html, /href="https:\/\/example\.com"/);
  assert.match(page.html, /href="nowhere\.smd"/, 'a link to a missing .smd stays as written');
  assert.match(page.html, /Shared terms\./);
  assert.doesNotMatch(page.html, /Outside the docs folder/);
  assert.match(page.html, /Secret fallback\./);
  assert.equal(page.diagnostics, undefined);
});

test('render: header false leaves out the front matter header; text overrides the file', () => {
  const page = render(fresh(), { path: 'b.md', text: '---\ntitle: Bee\n---\n\n:::note\nHi\n:::\n', header: false });
  assert.doesNotMatch(page.html, /<h1/);
  assert.match(page.html, /smd-callout/);
  assert.equal(page.title, 'Bee');
  assert.equal(render(fresh(), { path: 'b.md' }).title, 'B');
  assert.equal(render(fresh(), { path: 'b.md', text: 'No heading.' }).title, null);
});

test('render with validate returns 1-based diagnostics, checking files inside the docs folder only', () => {
  const page = render(fresh(), { path: 'guide/a.smd', validate: true });
  // index.md is in the page list but not on disk; the image and nowhere.smd don't exist either.
  const missing = page.diagnostics!.filter((d) => d.code === 'link/missing-file').map((d) => [d.line, d.column, d.severity]);
  assert.deepEqual(missing, [[7, 28, 'warning'], [7, 50, 'warning'], [19, 11, 'warning']]);
  assert.ok(page.diagnostics!.some((d) => d.code.startsWith('include/')), 'the include outside the docs folder is reported');
  const broken = render(fresh(), { path: 'b.md', text: ':::note\nNever closed\n', validate: true });
  assert.deepEqual(broken.diagnostics!.map((d) => [d.line, d.severity, d.code]), [[1, 'error', 'container/unclosed']]);
});

test('errors: bad JSON, unknown methods, paths outside the docs folder, missing files', () => {
  const bridge = fresh();
  assert.deepEqual(bridge.handleLine('{nope'), { id: null, error: { message: 'Not valid JSON.' } });
  assert.deepEqual(bridge.handleLine('{"id":4,"method":"nope"}'), { id: 4, error: { message: 'Unknown method: nope.' } });
  assert.deepEqual(bridge.handle({ id: 5, method: 'render', params: { path: '../secret.smd' } }), { id: 5, error: { message: '../secret.smd is outside the docs folder.' } });
  assert.deepEqual(bridge.handle({ id: 6, method: 'render', params: { path: 'gone.smd' } }), { id: 6, error: { message: 'Cannot read gone.smd.' } });
  assert.deepEqual(bridge.handle([1, 2]), { id: null, error: { message: 'Unknown method: undefined.' } });
});

test('scopeCodeColors limits .hljs rules to .smd code frames', () => {
  assert.equal(scopeCodeColors('.hljs-keyword, .hljs-tag { color: red; }\n.smd-doc { x: y; }'), '.smd-code .hljs-keyword, .smd-code .hljs-tag { color: red; }\n.smd-doc { x: y; }');
});

test('the bundled bridge answers JSON lines in order over stdin/stdout', () => {
  const input = [
    JSON.stringify({ id: 1, method: 'hello' }),
    'not json',
    JSON.stringify({ id: 2, method: 'assets' }),
    JSON.stringify({ id: 3, method: 'site', params: { docsDir: docs, pages } }),
    JSON.stringify({ id: 4, method: 'render', params: { path: 'guide/a.smd' } }),
  ].join('\n') + '\n';
  const run = spawnSync(process.execPath, [bundle], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((l) => l.id), [1, null, 2, 3, 4]);
  assert.equal(lines[0].result.version, JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version);
  assert.match(lines[2].result.css, /\.smd-code \.hljs/);
  assert.doesNotMatch(lines[2].result.css, /^\.hljs/m);
  assert.match(lines[2].result.runtimeJs, /smd-theme/);
  assert.match(lines[4].result.html, /Shared terms\./);
});

test('the Python package ships the current bridge (run npm run build and commit it when this fails)', () => {
  assert.ok(readFileSync(bundle).equals(readFileSync(packaged)), 'integrations/mkdocs/mkdocs_styled_markdown/bridge.cjs is stale');
});
