import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSmd } from '../src/core';
import { blockquoteToCallout, containerAt, wrapLines, type LineEdit } from '../src/core/refactors';

const apply = (text: string, e: LineEdit) => {
  const lines = text.split('\n');
  lines.splice(e.startLine, e.endLine - e.startLine + 1, ...e.lines);
  return lines.join('\n');
};

test('wrapLines wraps a selection in a container', () => {
  const src = '# T\n\nFirst line.\nSecond line.\n\nAfter.\n';
  const wrapped = apply(src, wrapLines(src, 2, 3, 'warning')!);
  assert.equal(wrapped, '# T\n\n:::warning\nFirst line.\nSecond line.\n:::\n\nAfter.\n');
  assert.deepEqual(validateSmd(wrapped), []);
});

test('wrapLines adds a colon around containers it wraps', () => {
  const src = ':::tip\nA\n:::\n\n::::tabs\n:::tab x\nB\n:::\n::::\n';
  assert.deepEqual(wrapLines(src, 0, 8, 'agent')?.lines[0], ':::::agent');
  assert.deepEqual(wrapLines(src, 0, 2, 'card')?.lines, ['::::card', ':::tip', 'A', ':::', '::::']);
});

test('wrapLines refuses selections that cut through code or containers', () => {
  const src = 'Text\n```js\nx\n```\n:::note\nA\n:::\n';
  assert.equal(wrapLines(src, 0, 1, 'note'), undefined, 'half a code fence');
  assert.equal(wrapLines(src, 4, 5, 'note'), undefined, 'half a container');
  assert.equal(wrapLines(src, 1, 1, 'note'), undefined);
  assert.ok(wrapLines(src, 0, 6, 'note'));
  assert.equal(wrapLines('\n\n', 0, 1, 'note'), undefined, 'blank lines only');
  assert.equal(wrapLines('    code\n', 0, 0, 'note'), undefined, 'indented code');
});

test('containerAt finds the innermost container around a line', () => {
  const src = '::::tabs\n:::tab A\n:::warning\nx\n:::\n:::\n::::\nafter\n';
  assert.equal(containerAt(src, 3)?.name, 'warning');
  assert.deepEqual(containerAt(src, 2), { name: 'warning', openLine: 2, closeLine: 4, nameColumn: 3 });
  assert.equal(containerAt(src, 5)?.name, 'tab');
  assert.equal(containerAt(src, 7), undefined);
  assert.equal(containerAt('```\n:::note\n```\n', 1), undefined, 'fences inside code are not containers');
});

test('blockquoteToCallout converts GitHub alerts and bold labels', () => {
  const alert = 'Intro\n\n> [!WARNING]\n> Rotate the keys first.\n> > Nested quote\n\nAfter';
  const a = blockquoteToCallout(alert, 3)!;
  assert.equal(a.type, 'warning');
  assert.equal(apply(alert, a.edit), 'Intro\n\n:::warning\nRotate the keys first.\n> Nested quote\n:::\n\nAfter');

  const bold = '> **Note:** Staging resets nightly.\n> Plan around it.';
  assert.deepEqual(blockquoteToCallout(bold, 1)!.edit.lines, [':::note', 'Staging resets nightly.', 'Plan around it.', ':::']);
  assert.equal(blockquoteToCallout('> **Tip**: use `smd fmt`', 0)!.edit.lines[1], 'use `smd fmt`');
  assert.equal(blockquoteToCallout('> [!CAUTION]\n> x', 0)!.type, 'danger');
  assert.equal(blockquoteToCallout('> __Important:__ read this', 0)!.type, 'info');

  assert.equal(blockquoteToCallout('> Just a quote', 0), undefined);
  assert.equal(blockquoteToCallout('> **Bold** text', 0), undefined);
  assert.equal(blockquoteToCallout('Not a quote', 0), undefined);
});
