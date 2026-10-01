import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rehypeSmd, remarkSmd, renderSmd, renderSmdFile, type SmdTree, type SmdVFile } from '../src/core';

// unified is not a dependency: these tests drive the plugins with hand-built trees and files,
// the way unified calls a transformer (tree, file).
const showcase = readFileSync(join(__dirname, '..', '..', 'examples', 'showcase.smd'), 'utf8');
const today = '2026-09-01';
const mdast = (): SmdTree => ({ type: 'root', children: [{ type: 'paragraph' }, { type: 'code', value: 'x' }] });

test('remarkSmd replaces the mdast with one html node holding renderSmd output', () => {
  const tree = mdast();
  const file: SmdVFile = { value: showcase, path: 'docs/showcase.smd', data: {} };
  remarkSmd({ today })(tree, file);
  assert.deepEqual(tree.children, [{ type: 'html', value: renderSmd(showcase, { today }).html }]);
  assert.equal((file.data?.smd as { frontMatter: { title: string } }).frontMatter.title, renderSmd(showcase).frontMatter.title);
  assert.ok((file.data?.smd as { headings: unknown[] }).headings.length > 3);
});

test('rehypeSmd puts the same HTML in a raw node; Uint8Array sources are decoded', () => {
  const tree: SmdTree = { type: 'root', children: [{ type: 'element' }] };
  rehypeSmd({ today })(tree, { value: new TextEncoder().encode(':::tip\nHi\n:::') });
  assert.deepEqual(tree.children, [{ type: 'raw', value: renderSmd(':::tip\nHi\n:::').html }]);
});

test('front matter, MDX import/export nodes are kept; other nodes are replaced', () => {
  const tree: SmdTree = {
    type: 'root',
    children: [{ type: 'yaml', value: 'title: x' }, { type: 'heading' }, { type: 'mdxjsEsm', value: 'export const toc = []' }],
  };
  remarkSmd()(tree, { value: '---\ntitle: x\n---\nText' });
  assert.deepEqual(tree.children?.map((n) => n.type), ['yaml', 'mdxjsEsm', 'html']);
});

test('front matter removed by the host is read from Astro, vfile-matter or the frontMatter option', () => {
  const header = (file: SmdVFile, options = {}) => renderSmdFile(file, options)?.html.match(/smd-doc-title">([^<]*)/)?.[1];
  // Astro blanks the front matter lines and keeps the parsed data in file.data.astro.frontmatter.
  assert.equal(header({ value: '\n\n\n# Body', data: { astro: { frontmatter: { title: 'From Astro' } } } }), 'From Astro');
  assert.equal(header({ value: 'Body', data: { matter: { title: 'From matter' } } }), 'From matter');
  assert.equal(header({ value: 'Body', data: { frontmatter: { title: 'Plain' } } }), 'Plain');
  assert.equal(header({ value: 'Body', data: { matter: { title: 'Ignored' } } }, { frontMatter: () => ({ title: 'Option' }) }), 'Option');
  assert.equal(header({ value: 'Body' }), undefined);
  // The file's own front matter wins over the host's copy.
  assert.equal(header({ value: '---\ntitle: Own\n---\nBody', data: { matter: { title: 'Host' } } }), 'Own');
});

test('host dates show as YYYY-MM-DD; toc and accent from host front matter apply', () => {
  const data = { astro: { frontmatter: { title: 'T', updated: new Date('2026-09-30T00:00:00Z'), toc: true, accent: 'teal' } } };
  const result = renderSmdFile({ value: '## One\n\n## Two', data });
  assert.match(result?.html ?? '', /Updated 2026-09-30/);
  assert.match(result?.html ?? '', /smd-toc/);
  assert.match(result?.html ?? '', /--smd-accent:/);
  assert.equal(result?.frontMatter.updated, '2026-09-30');
});

test('header: false leaves out the document header but keeps the body', () => {
  const html = renderSmdFile({ value: '---\ntitle: T\nstatus: draft\n---\n# Body' }, { header: false })?.html ?? '';
  assert.doesNotMatch(html, /smd-doc-header/);
  assert.match(html, /<h1 id="body"/);
  assert.equal(html, renderSmd('---\ntitle: T\nstatus: draft\n---\n# Body').html.replace(/<header[\s\S]*?<\/header>/, ''));
});

test('test option limits the plugin to matching paths', () => {
  const tree = mdast();
  remarkSmd({ test: /\.smd$/ })(tree, { value: '# x', path: 'a.md' });
  assert.deepEqual(tree, mdast());
  remarkSmd({ test: /\.smd$/g })(tree, { value: '# x' });
  assert.deepEqual(tree, mdast(), 'no path: not matched');
  const global = /\.smd$/g;
  assert.ok(renderSmdFile({ value: '# x', path: 'a.smd' }, { test: global }));
  assert.ok(renderSmdFile({ value: '# x', path: 'b.smd' }, { test: global }), 'a global regexp matches every time');
  assert.ok(renderSmdFile({ value: '# x', path: 'docs/a.md' }, { test: (path) => path.startsWith('docs/') }));
});

test('readFile receives the file, and render options pass through', () => {
  const seen: string[] = [];
  const html = renderSmdFile(
    { value: '```ts file="b.ts"\n```\n\n:::agent\nhidden\n:::', path: 'docs/a.smd' },
    { readFile: (rel, file) => { seen.push(`${file.path}:${rel}`); return 'const b = 1;'; }, agentBlocks: 'hidden' },
  )?.html ?? '';
  assert.deepEqual(seen, ['docs/a.smd:b.ts']);
  assert.match(html, /const/);
  assert.doesNotMatch(html, /secretword/);
});

test('files without data get file.data.smd; a missing value renders an empty document', () => {
  const file: SmdVFile = {};
  remarkSmd()(mdast(), file);
  assert.deepEqual(file.data?.smd, { frontMatter: {}, headings: [] });
});
