import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAnchor, headingAt, linksToAnchor, renameHeading } from '../src/core/anchors';

test('headingAt finds the editable heading text', () => {
  const src = '---\ntitle: T\n---\n# Guide\n\n## Pricing rules ##\n\n### Refunds {#refund-policy}\n\nSetext title\n============\n\nText';
  assert.deepEqual(headingAt(src, 3), { line: 3, start: 2, end: 7, text: 'Guide', slug: 'guide' });
  assert.deepEqual(headingAt(src, 5), { line: 5, start: 3, end: 16, text: 'Pricing rules', slug: 'pricing-rules' });
  assert.deepEqual(headingAt(src, 7), { line: 7, start: 4, end: 11, text: 'Refunds', slug: 'refund-policy' });
  assert.deepEqual(headingAt(src, 9), { line: 9, start: 0, end: 12, text: 'Setext title', slug: 'setext-title' });
  assert.equal(headingAt(src, 12), undefined);
  assert.equal(headingAt('```\n# not a heading\n```', 1), undefined);
});

test('linksToAnchor finds links to an anchor, in this and other documents', () => {
  const src = [
    '[a](#pricing) [b](other.smd#pricing) [c](other.smd#refunds) [d](#pricing-2)',
    '',
    '[ref]: ./other.smd#pricing',
    '<a href="#pricing">e</a> `[f](#pricing)`',
  ].join('\n');
  const here = linksToAnchor(src, 'pricing', (p) => p === '');
  assert.deepEqual(here.map((l) => [l.line, l.column, l.endColumn]), [[0, 5, 12], [3, 10, 17]]);
  const other = linksToAnchor(src, 'pricing', (p) => p === 'other.smd' || p === './other.smd');
  assert.deepEqual(other.map((l) => [l.line, l.column]), [[0, 28], [2, 19]]);
});

test('renameHeading reports every anchor that changes', () => {
  const src = '## Intro\n\n## Setup\n\n## Setup\n\n## API {#api}\n';
  assert.deepEqual(renameHeading(src, 0, 'Getting started'), {
    lineText: '## Getting started', changes: [{ from: 'intro', to: 'getting-started' }],
  });
  // Renaming the first "Setup" shifts the numbering of the second one.
  assert.deepEqual(renameHeading(src, 2, 'Install')?.changes, [
    { from: 'setup', to: 'install' },
    { from: 'setup-1', to: 'setup' },
  ]);
  assert.deepEqual(renameHeading(src, 6, 'HTTP API'), { lineText: '## HTTP API {#api}', changes: [] });
  assert.equal(renameHeading(src, 1, 'x'), undefined);
});

test('encodeAnchor keeps percent-encoding when the link used it', () => {
  assert.equal(encodeAnchor('intro', 'café'), 'café');
  assert.equal(encodeAnchor('caf%C3%A9', 'thé'), 'th%C3%A9');
});
