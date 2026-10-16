import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatSmd, renderSmd, renderStandaloneHtml, validateSmd } from '../src/core';

/**
 * Enumerated values in any case (1.10, spec v2 RFC proposal 11): directive and front matter values match in any case,
 * render as their lower-case value, and `smd fmt` writes attribute values as the vocabulary lists them.
 */

const corpus = (name: string) => readFileSync(join(__dirname, 'compat', 'corpus', name), 'utf8');
const codes = (text: string) => validateSmd(text, { today: '2026-10-15' }).map((d) => d.code);

test('case: directive and front matter values are matched in any case', () => {
  assert.deepEqual(codes(':metric[4%]{label=x trend=Up good=DOWN}'), []);
  assert.deepEqual(codes('---\nsmd: 1\nstatus: Draft\naudience: Both\ntheme: Dark\n---\n'), []);
  assert.ok(codes(':metric[4%]{label=x trend=sideways}').includes('attrs/value'), 'other values are still errors');
  assert.ok(codes('---\nsmd: 1\naudience: everyone\n---\n').includes('frontmatter/audience'));
  const doc = corpus('vocabulary-case.smd');
  assert.deepEqual(validateSmd(doc, { today: '2026-10-15' }), []);
  assert.equal(formatSmd(doc), doc);
});

test('case: rendering reads them as their lower-case value', () => {
  const lower = renderSmd(':metric[4%]{label=x delta="+1%" trend=up good=down}').html;
  assert.equal(renderSmd(':metric[4%]{label=x delta="+1%" trend=Up good=Down}').html, lower);
  assert.match(lower, /smd-metric-bad"><span aria-hidden="true">▲<\/span>/);
  assert.match(renderStandaloneHtml('---\ntheme: Dark\n---\nx\n', '', ''), /data-smd-theme-pref="dark"/);
});

test('case: fmt writes enumerated attribute values as the vocabulary lists them, and nothing else', () => {
  assert.equal(formatSmd(':::decision{status=Accepted} T\nx\n:::\n'), ':::decision{status=accepted} T\nx\n:::\n');
  assert.equal(formatSmd(':::api{method=get path="/v1"}\nx\n:::\n'), ':::api{method=GET path="/v1"}\nx\n:::\n');
  assert.equal(formatSmd(':metric[1]{label="x" trend="Up"}\n'), ':metric[1]{label="x" trend=up}\n');
  // Values outside the vocabulary, keys without one and the front matter stay as written.
  assert.equal(formatSmd(':metric[1]{label="Up" trend=Sideways}\n'), ':metric[1]{label="Up" trend=Sideways}\n');
  assert.equal(formatSmd('---\nstatus: Draft\n---\n\n[x]{color=red}\n'), '---\nstatus: Draft\n---\n\n[x]{color=red}\n');
});
