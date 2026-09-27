import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFixes, validateSmd, type ValidateOptions } from '../src/core';

const files: Record<string, string> = {
  'other.smd': '---\nsmd: 1\ntitle: Other\n---\n## Pricing rules\n\n## Refunds {#refund-policy}\n',
  'img.png': '',
  'my file.md': '# Hello\n',
};
const workspace: ValidateOptions = {
  fileExists: (p) => p in files,
  readFile: (p) => files[p],
};
const check = (text: string, options: ValidateOptions = workspace) =>
  validateSmd(text, options).filter((d) => d.code.startsWith('link/'));
const codes = (text: string, options?: ValidateOptions) => check(text, options).map((d) => d.code);

test('anchors resolve to headings, {#id} attributes and HTML ids', () => {
  assert.deepEqual(codes('## Intro\n\n[a](#intro)'), []);
  assert.deepEqual(codes('## Intro {#start}\n\n[a](#start)'), []);
  assert.deepEqual(codes(':::card{#pricing-card} Price\nx\n:::\n\n[a](#pricing-card)'), []);
  assert.deepEqual(codes('<a id="legacy"></a>\n\n[a](#legacy)'), []);
  assert.deepEqual(codes('## Intro\n\n[a](#nowhere)'), ['link/missing-anchor']);
});

test('a missing anchor suggests the closest id as a fix', () => {
  const src = '## Rollout plan\n\nSee [the plan](#rolout-plan).';
  const [d] = check(src);
  assert.match(d.message, /did you mean "#rollout-plan"/);
  assert.equal(applyFixes(src, [d]).text, '## Rollout plan\n\nSee [the plan](#rollout-plan).');
});

test('malformed percent-encoding does not throw', () => {
  assert.deepEqual(codes('[a](#100%)'), ['link/missing-anchor']);
  assert.deepEqual(codes('[a](missing%zz.md)'), ['link/missing-file']);
});

test('relative files must exist, external links are ignored', () => {
  assert.deepEqual(codes('![x](img.png) [y](other.smd) [z](https://example.com/nope) [m](mailto:a@b.c)'), []);
  assert.deepEqual(codes('[x](<my file.md>) [y](my%20file.md)'), []);
  assert.deepEqual(codes('[x](gone.md) ![y](gone.png "Title")'), ['link/missing-file', 'link/missing-file']);
  assert.deepEqual(codes('[x](gone.md)', {}), [], 'file checks need fileExists');
});

test('anchors in other documents are checked', () => {
  assert.deepEqual(codes('[a](other.smd#pricing-rules) [b](other.smd#refund-policy)'), []);
  const [d] = check('[a](other.smd#pricing-rule)');
  assert.equal(d.code, 'link/missing-anchor');
  assert.match(d.message, /in "other.smd" — did you mean "#pricing-rules"/);
  assert.equal(d.fix?.replacement, 'other.smd#pricing-rules');
  // Unreadable files (e.g. outside the workspace) and non-documents are not checked for anchors.
  assert.deepEqual(codes('[a](other.smd#x)', { fileExists: workspace.fileExists }), []);
  assert.deepEqual(codes('[a](img.png#x)'), []);
});

test('links in code are ignored', () => {
  assert.deepEqual(codes('`[a](gone.md)`\n\n```md\n[b](gone.md)\n[c][nope]\n```\n\n~~~\n```\n[d](gone.md)\n~~~'), []);
});

test('reference links need a definition, and definitions are checked', () => {
  assert.deepEqual(codes('See [the spec][spec] and [Other][].\n\n[spec]: other.smd#pricing-rules\n[other]: https://x.y'), []);
  assert.deepEqual(codes('See [the spec][nope].'), ['link/undefined-reference']);
  assert.deepEqual(codes('[spec]: gone.smd\n[top]: #nowhere'), ['link/missing-file', 'link/missing-anchor']);
  assert.deepEqual(codes(':badge[x][y] and - [x] [a](other.smd)'), []);
});

test('HTML href and src are checked', () => {
  assert.deepEqual(codes('<img src="img.png"> <a href="#nowhere">x</a> <a href="gone.md">y</a>'),
    ['link/missing-anchor', 'link/missing-file']);
});

test('front matter related entries must exist', () => {
  const inline = check('---\nsmd: 1\nrelated: [other.smd, gone.smd, https://x.y]\n---\nBody');
  assert.deepEqual(inline.map((d) => [d.code, d.line, d.column]), [['link/missing-file', 2, 21]]);
  assert.match(inline[0].message, /listed in "related"/);
  const block = check('---\nsmd: 1\nrelated:\n  - other.smd#nope\n  - gone.smd\n---\nBody');
  assert.deepEqual(block.map((d) => [d.code, d.line]), [['link/missing-anchor', 3], ['link/missing-file', 4]]);
});
