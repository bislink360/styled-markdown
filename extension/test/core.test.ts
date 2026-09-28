import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyFixes, getDocumentInfo, markdownToSmd, renderSmd, smdToMarkdown, validateSmd,
} from '../src/core';

const showcase = readFileSync(join(__dirname, '..', '..', 'examples', 'showcase.smd'), 'utf8');
const codes = (text: string) => validateSmd(text).map((d) => d.code);

test('plain Markdown is valid SMD and renders normally', () => {
  const html = renderSmd('# Hello\n\nSome **bold** text.\n\n| a | b |\n|---|---|\n| 1 | 2 |').html;
  assert.match(html, /<h1[^>]*id="hello"/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<table/);
  assert.deepEqual(codes('# Hello\n\nText'), []);
});

test('showcase example has no problems', () => {
  assert.deepEqual(validateSmd(showcase, { today: '2026-09-01' }), []);
});

test('front matter renders a document header and is validated', () => {
  const html = renderSmd('---\nsmd: 1\ntitle: Plan\nstatus: approved\nowners: [a]\n---\nBody').html;
  assert.match(html, /smd-doc-header/);
  assert.match(html, /smd-doc-status-approved/);
  assert.ok(codes('---\nsmd: 1\nstatus: done\n---\n').includes('frontmatter/status'));
  assert.ok(codes('---\nsmd: 1\ntitle: [unclosed\n---\n').includes('frontmatter/invalid'));
  assert.ok(codes('---\ntitle: x\n---\n').includes('frontmatter/version'));
});

test('callouts render with type, title and collapsible variant', () => {
  const html = renderSmd(':::warning Careful\nBody **text**\n:::').html;
  assert.match(html, /smd-callout smd-callout-warning/);
  assert.match(html, /Careful/);
  assert.match(html, /<strong>text<\/strong>/);
  assert.match(renderSmd(':::tip{collapsible}\nx\n:::').html, /<details class="smd-callout smd-callout-tip"/);
});

test('containers nest with any colon count; a bare ::: closes the innermost', () => {
  const src = ':::card A\n:::note\ninner\n:::\nafter\n:::';
  const html = renderSmd(src).html;
  assert.match(html, /smd-card[\s\S]*smd-callout-note[\s\S]*inner[\s\S]*<\/div><\/div>\n<p[^>]*>after<\/p>/);
  assert.deepEqual(codes(src), []);
});

test('fenced code inside a container does not close it', () => {
  const html = renderSmd(':::note\n```\n:::\n```\nstill inside\n:::').html;
  assert.match(html, /<pre><code>:::\n<\/code><\/pre>[\s\S]*still inside[\s\S]*<\/div><\/div>/);
});

test('unclosed, unknown and misplaced containers are reported', () => {
  assert.ok(codes(':::note\nnever closed').includes('container/unclosed'));
  const unknown = validateSmd(':::warnign\nx\n:::');
  assert.equal(unknown[0].code, 'container/unknown');
  assert.equal(unknown[0].fix?.replacement, 'warning');
  assert.ok(codes(':::tab A\nx\n:::').includes('container/parent'));
  assert.ok(codes('text\n:::').includes('container/stray-close'));
});

test('styled spans only emit whitelisted CSS', () => {
  const html = renderSmd('[hi]{color=red bg=amber weight=bold}').html;
  assert.match(html, /<span class="smd-span" style="color:var\(--smd-red\);background:var\(--smd-amber-soft\)/);
  assert.match(html, /font-weight:700/);
  const evil = renderSmd('[x]{color="red;background:url(javascript:alert(1))"}').html;
  assert.doesNotMatch(evil, /javascript/);
  assert.ok(codes('[x]{color=notacolor}').includes('attrs/value'));
  assert.ok(codes('[x]{colour=red}').includes('attrs/unknown'));
});

test('inline directives render', () => {
  const html = renderSmd(':badge[Done]{color=green} :kbd[Ctrl+S] :progress{value=40} :status[OK]{color=green} :mention[@me]').html;
  assert.match(html, /smd-badge/);
  assert.match(html, /<kbd>Ctrl<\/kbd>/);
  assert.match(html, /aria-valuenow="40"/);
  assert.match(html, /smd-status-dot/);
  assert.match(html, /smd-mention/);
  assert.ok(codes(':progress{value=140}').includes('attrs/value'));
  assert.ok(codes(':badg[x]').includes('directive/unknown'));
});

test('ordinary colons are not directives', () => {
  const html = renderSmd('Time is 10:30 and see:[link](http://x.y)').html;
  assert.match(html, /10:30/);
  assert.deepEqual(codes('Note: this is fine. 10:30 [a](#b)').filter((c) => c !== 'link/missing-anchor'), []);
});

test('mermaid, math and highlight', () => {
  const html = renderSmd('```mermaid\nflowchart LR\n  A-->B\n```\n\n$x^2$ and\n\n$$\n\\frac{1}{2}\n$$\n\n```ts\nconst a = 1;\n```').html;
  assert.match(html, /<pre class="smd-mermaid">flowchart LR/);
  assert.match(html, /class="katex"/);
  assert.match(html, /katex-display/);
  assert.match(html, /hljs-keyword/);
  assert.ok(codes('```mermaid\nflowchat LR\n```').includes('mermaid/type'));
  assert.ok(codes('$$\n\\frac{1}{\n$$').includes('math/syntax'));
});

test('dollar amounts are not math', () => {
  assert.doesNotMatch(renderSmd('It costs $5 and $10 today.').html, /katex/);
});

test('task lists carry source lines for toggling', () => {
  const html = renderSmd('---\nsmd: 1\n---\n- [ ] one\n- [x] two').html;
  assert.match(html, /data-task-line="3"/);
  assert.match(html, /data-task-line="4" checked/);
});

test('anchor links are checked against headings', () => {
  assert.ok(codes('# Intro\n\n[go](#nowhere)').includes('link/missing-anchor'));
  assert.deepEqual(codes('# Intro\n\n[go](#intro)'), []);
});

test('applyFixes repairs typos', () => {
  const src = '---\ntitle: x\n---\n:::warnign\nx\n:::';
  const { text, applied } = applyFixes(src, validateSmd(src));
  assert.equal(applied, 2);
  assert.match(text, /^---\nsmd: 1\ntitle: x/);
  assert.match(text, /:::warning/);
});

test('conversion to plain Markdown keeps meaning', () => {
  const md = smdToMarkdown(':::warning Careful\nBody\n:::\n\n:badge[Done]{color=green} [red]{color=red weight=bold} ==hi==');
  assert.match(md, /> \[!WARNING\]\n> \*\*Careful\*\*/);
  assert.match(md, /`Done` \*\*red\*\* \*\*hi\*\*/);
});

test('conversion from Markdown adds front matter and callouts', () => {
  const smd = markdownToSmd('# Title\n\n> [!NOTE]\n> hello\n', 'fallback');
  assert.match(smd, /^---\nsmd: 1\ntitle: "Title"/);
  assert.match(smd, /:::note\nhello\n:::/);
  assert.deepEqual(validateSmd(smd).filter((d) => d.severity === 'error'), []);
});

test('document info summarises the file for agents', () => {
  const info = getDocumentInfo(showcase);
  assert.equal(info.title, 'Styled Markdown Showcase');
  assert.equal(info.tasks.total, 10);
  assert.equal(info.agentBlocks.length, 1);
  assert.match(info.agentBlocks[0].content, /Do not change the public API/);
  assert.equal(info.diagrams.length, 3);
  assert.equal(info.diagnostics.errors, 0);
});

test('a lone carriage return does not shift heading lines (found by fuzzing)', () => {
  // Every other tool splits lines on \r?\n, so a lone \r is not a line break for the preview either.
  const { headings, html } = renderSmd('para\r# Not a heading\n\n## Next');
  assert.deepEqual(headings.map((h) => [h.text, h.line]), [['Next', 2]]);
  assert.match(html, /data-line="2"/);
});

test('front matter keys are matched literally (found by fuzzing)', () => {
  // Regex characters in a key used to throw while looking for its line.
  const diagnostics = validateSmd('---\nsmd: 1\n"a(b": 1\n"[x": 2\n---\n# T');
  assert.deepEqual(diagnostics.map((d) => d.code), ['frontmatter/unknown-key', 'frontmatter/unknown-key']);
});

test('an unknown key YAML wrote differently gets no rename that rewrites --- (found by fuzzing)', () => {
  const src = '---\nsmd: 1\n"titel": x\n---\n# T';
  const hint = validateSmd(src).find((d) => d.code === 'frontmatter/unknown-key');
  assert.ok(hint);
  assert.equal(hint.line, 0);
  assert.equal(hint.fix, undefined);
  assert.equal(applyFixes(src, validateSmd(src)).text, src);
  // Written as-is, the rename is still offered.
  const plain = validateSmd('---\nsmd: 1\ntitel: x\n---\n# T').find((d) => d.code === 'frontmatter/unknown-key');
  assert.deepEqual(plain?.fix && [plain.fix.line, plain.fix.replacement], [2, 'title']);
});
