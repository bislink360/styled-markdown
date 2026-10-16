import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import smd from '../src/core/markdownIt';
import { agentView, formatSmd, getDocumentInfo, querySmd, renderSmd, smdToMarkdown, validateSmd } from '../src/core';
import { segmentSmd } from '../src/core/blocks';
import { findChangelogs } from '../src/core/changelog';
import { findGlossary } from '../src/core/glossary';

/**
 * `$$` display math is opaque to the container scan (1.10, spec v2 RFC proposal 2): a `:::` line inside display math
 * neither closes nor opens a container, in rendering and in every reader that pairs container fences.
 */

const corpus = (name: string) => readFileSync(join(__dirname, 'compat', 'corpus', name), 'utf8');
const codes = (text: string) => validateSmd(text, { today: '2026-10-15' }).map((d) => d.code);

const MATH_IN_NOTE = ':::note\nBefore.\n\n$$\na\n:::\nb\n$$\n\nStill inside.\n:::\n\nOutside.\n';

test('math: a ::: line inside $$ math inside a container does not close it', () => {
  const html = renderSmd(MATH_IN_NOTE).html;
  // The math holds the ::: line, and the paragraph after it is still in the note's body.
  assert.match(html, /<annotation encoding="application\/x-tex">a\n:::\nb<\/annotation>/);
  assert.match(html, /smd-callout-body">[\s\S]*Still inside\.<\/p>\n<\/div><\/div>\n<p data-line="12">Outside\.<\/p>/);
  assert.deepEqual(codes(MATH_IN_NOTE), [], 'the validator always read it so');
});

test('math: nested containers, one-line math and math next to code', () => {
  const nested = '::::tabs\n:::tab A\n$$ E = mc^2 $$\n\n$$\nx\n::::\ny\n$$\n:::\n:::tab B\nTwo.\n:::\n::::\n';
  const html = renderSmd(nested).html;
  assert.equal(html.match(/<section class="smd-tab"/g)?.length, 2);
  assert.match(html, /x\n::::\ny<\/annotation>[\s\S]*<\/section>\n<section class="smd-tab" data-line="10"/);
  assert.deepEqual(codes(nested), []);
  const doc = corpus('math-in-containers.smd');
  assert.deepEqual(validateSmd(doc, { today: '2026-10-15' }), []);
  assert.equal(formatSmd(doc), doc);
});

test('math: $$ that never closes opens no math, so a ::: line after it still closes the container', () => {
  const html = renderSmd(':::note\n$$ costs\n:::\nAfter.\n').html;
  assert.match(html, /\$\$ costs<\/p>\n<\/div><\/div>\n<p data-line="3">After\.<\/p>/);
});

test('math: with math off (a markdown-it host), $$ lines are text and ::: closes the container', () => {
  const src = ':::note\n$$\n:::\n$$\nAfter.\n';
  const off = new MarkdownIt().use(smd, { math: false }).render(src);
  assert.match(off, /<\/div><\/div>\n<p>\$\$\nAfter\.<\/p>/);
  const on = new MarkdownIt().use(smd).render(src);
  assert.match(on, /smd-math-block[\s\S]*After\.<\/p>\n<\/div><\/div>/);
});

test('math: the Block Editor segments, the agent view, to-md and the line scanners agree', () => {
  const container = segmentSmd(MATH_IN_NOTE).find((s) => s.type === 'container');
  assert.deepEqual([container?.start, container?.end], [0, 11]);
  assert.equal(agentView(MATH_IN_NOTE).text, '<note>\nBefore.\n\n$$\na\n:::\nb\n$$\n\nStill inside.\n</note>\n\nOutside.\n');
  assert.match(smdToMarkdown(MATH_IN_NOTE), /> \$\$\n> a\n> :::\n> b\n> \$\$\n>\n> Still inside\.\n\nOutside\./);

  const agent = ':::agent Steps\n$$\n:::\n$$\nRun the job.\n:::\n';
  assert.equal(getDocumentInfo(agent).agentBlocks[0]?.content, '$$\n:::\n$$\nRun the job.');
  const decision = ':::decision{status=accepted} One\n$$\n:::\n$$\n:::\n:::decision{status=proposed} Two\n:::\n';
  assert.deepEqual(querySmd(decision, 'decision').map((m) => [m.line, m.endLine]), [[0, 4], [5, 6]]);
  const changelog = ':::changelog\n## 1.1.0\n$$\n:::\n$$\n## 1.0.0\n:::\n';
  assert.deepEqual(findChangelogs(changelog.split('\n')).map((b) => b.entries.map((e) => e.line)), [[1, 5]]);
  const glossary = ':::glossary\n$$\n:::\n$$\n\n- **Term**: A definition.\n:::\n';
  assert.deepEqual(findGlossary(glossary.split('\n')).entries.map((e) => e.term), ['Term']);
  assert.deepEqual(findGlossary(glossary.split('\n')).blocks, [[0, 6]]);
});
