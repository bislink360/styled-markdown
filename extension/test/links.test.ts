import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFixes, validateSmd, type ValidateOptions } from '../src/core';
import { anchorLine, anchorTargets, linkAt, linkCompletionContext } from '../src/core/links';

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

test('linkAt finds the link target or reference under the cursor', () => {
  const src = 'See [intro](#intro) and [the spec][spec].\n\n[spec]: other.smd#pricing-rules';
  assert.equal(linkAt(src, 0, 0), undefined);
  const inline = linkAt(src, 0, 14);
  assert.deepEqual([inline?.link.target, inline?.start, inline?.end, inline?.reference], ['#intro', 12, 18, false]);
  const ref = linkAt(src, 0, 30);
  assert.deepEqual([ref?.link.target, ref?.link.line, ref?.start, ref?.reference], ['other.smd#pricing-rules', 2, 24, true]);
  assert.equal(linkAt('[a][undefined]', 0, 2), undefined);
  assert.equal(linkAt('```\n[a](#x)\n```', 1, 5), undefined);
});

test('anchorLine locates headings, {#id} blocks and HTML ids', () => {
  const src = '---\nsmd: 1\n---\n## Intro\n\n## Refunds {#refund-policy}\n\n:::card{#price-card .wide} Price\nx\n:::\n\n<a id="legacy.v1"></a>';
  assert.equal(anchorLine(src, 'intro'), 3);
  assert.equal(anchorLine(src, 'refund-policy'), 5);
  assert.equal(anchorLine(src, 'price-card'), 7);
  assert.equal(anchorLine(src, 'legacy.v1'), 11);
  assert.equal(anchorLine(src, 'legacy-v1'), undefined);
  assert.equal(anchorLine(src, 'price'), undefined);
});

test('link completion context: links, definitions, related and embeds', () => {
  // `|` marks the cursor.
  const ctx = (src: string) => {
    const lines = src.split('\n');
    const line = lines.findIndex((l) => l.includes('|'));
    return linkCompletionContext(src.replace('|', ''), line, lines[line].indexOf('|'));
  };
  assert.deepEqual(ctx('See [the plan](docs/pl|'), { kind: 'link', target: 'docs/pl', column: 15 });
  assert.deepEqual(ctx('![logo](|'), { kind: 'link', target: '', column: 8 });
  assert.deepEqual(ctx('[a](other.smd#pri|'), { kind: 'link', target: 'other.smd#pri', column: 4 });
  assert.deepEqual(ctx('[a](<my fi|'), undefined, 'spaces need a closing > first');
  assert.deepEqual(ctx('[ref]: ../specs/|'), { kind: 'link', target: '../specs/', column: 7 });
  assert.deepEqual(ctx('---\nrelated: [a.smd, docs/b|]\n---\n'), { kind: 'related', target: 'docs/b', column: 17 });
  assert.deepEqual(ctx('---\nrelated: "x|"\n---\n'), { kind: 'related', target: 'x', column: 10 });
  assert.deepEqual(ctx('---\nrelated:\n  - adr.smd\n  - specs/|\n---\n'), { kind: 'related', target: 'specs/', column: 4 });
  assert.equal(ctx('---\ntags:\n  - specs/|\n---\n'), undefined);
  assert.deepEqual(ctx('```ts file="src/pri|'), { kind: 'embed', target: 'src/pri', column: 12 });
  assert.equal(ctx('```ts\n[a](x|\n```'), undefined, 'inside a code block');
  assert.equal(ctx('Use `[a](x|` here'), undefined, 'inside inline code');
  assert.equal(ctx('[a](done.smd) and more|'), undefined);
});

test('anchor targets list headings, then {#id} blocks and HTML ids', () => {
  const targets = anchorTargets('# Guide\n\n## Pricing rules {#pricing}\n\n:::card{#price-card} Price\nx\n:::\n\n<a id="legacy"></a>\n');
  assert.deepEqual(targets, [
    { id: 'guide', text: 'Guide', level: 1, line: 0 },
    { id: 'pricing', text: 'Pricing rules', level: 2, line: 2 },
    { id: 'price-card', line: 4 },
    { id: 'legacy', line: 8 },
  ]);
});
