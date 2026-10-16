import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatSmd, renderSmd, validateSmd } from '../src/core';
import { findGlossary, findTermUses, termMatcher } from '../src/core/glossary';

/**
 * Glossary terms with quotes and dashes (1.10, spec v2 RFC proposal 8): straight and typographic quotes and dashes are
 * the same for matching, so a term is marked in rendered text, where the typographer changed them.
 */

const corpus = (name: string) => readFileSync(join(__dirname, 'compat', 'corpus', name), 'utf8');

test('glossary: terms with quotes and dashes are marked in typographic text', () => {
  const doc = corpus('glossary-typography.smd');
  const html = renderSmd(doc).html;
  assert.match(html, /<a class="smd-term" href="#term-builders-rule"[^>]*>builder’s rule<\/a>/);
  assert.match(html, /<a class="smd-term" href="#term-two-pizza-team"[^>]*>“Two pizza” team<\/a>/);
  assert.match(html, /<a class="smd-term" href="#term-end-to-end"[^>]*>end–to–end<\/a>/);
  assert.deepEqual(validateSmd(doc, { today: '2026-10-15' }), []);
  assert.equal(formatSmd(doc), doc);
});

test('glossary: straight and typographic forms of a quote or dash are one term', () => {
  const matcher = termMatcher([{ term: "Builder's rule" }, { term: 'a--b' }, { term: 'x — y' }])!;
  const found = (text: string) => matcher.find(text).map((m) => [m.text, m.entry.term]);
  assert.deepEqual(found("the builder's rule"), [["builder's rule", "Builder's rule"]]);
  assert.deepEqual(found('the builder’s rule'), [['builder’s rule', "Builder's rule"]]);
  assert.deepEqual(found('a–b and a--b'), [['a–b', 'a--b'], ['a--b', 'a--b']]);
  assert.deepEqual(found('x --- y'), [['x --- y', 'x — y']]);
  const lines = ['The builder’s rule.', '', ':::glossary', "- **Builder's rule**: Run it.", ':::'];
  assert.deepEqual(findTermUses(lines, 0, findGlossary(lines)).map((u) => [u.line, u.column]), [[0, 4]]);
});
