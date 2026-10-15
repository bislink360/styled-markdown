import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentSmd } from '../src/core/blocks';
import {
  applyLineEdits, applyTextEdit, changedRange, deleteBlock, eolOf, insertBlock, lineEditToTextEdit, minimalEdit, moveBlock, splitLines,
  type LineEdit,
} from '../src/core/sourceEdit';
import { prng } from './fuzz/generate';

/** The block editor's text edits (src/core/sourceEdit.ts): no line outside the edited block ever changes. */

const lines = (text: string) => splitLines(text);
const apply = (text: string, edit: LineEdit) => applyTextEdit(text, lineEditToTextEdit(text, edit));

test('minimalEdit: the common prefix and suffix stay; null when nothing changed', () => {
  assert.equal(minimalEdit('same', 'same'), null);
  assert.deepEqual(minimalEdit('abcdef', 'abXYef'), { from: 2, to: 4, insert: 'XY' });
  assert.deepEqual(minimalEdit('aaa', 'aaaa'), { from: 3, to: 3, insert: 'a' });
  assert.deepEqual(minimalEdit('# Title\n\nText', '# Title\n\nNew text'), { from: 9, to: 10, insert: 'New t' });
  assert.deepEqual(minimalEdit('abc', ''), { from: 0, to: 3, insert: '' });
  assert.deepEqual(changedRange('same', 'same'), { from: 4, to: 4, insert: '' });
});

test('minimalEdit never splits a surrogate pair or a CRLF', () => {
  // 😀 → 😃 share their high surrogate; the edit replaces the whole character.
  assert.deepEqual(minimalEdit('a😀b', 'a😃b'), { from: 1, to: 3, insert: '😃' });
  assert.deepEqual(minimalEdit('a\r\nb', 'a\rx\nb'), { from: 1, to: 3, insert: '\rx\n' });
  const random = prng(5);
  const alphabet = ['a', 'b', '\r\n', '\n', '😀', '😃', 'é', ' '];
  const word = () => Array.from({ length: Math.floor(random() * 8) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
  for (let i = 0; i < 2000; i++) {
    const before = word();
    const after = word();
    const edit = minimalEdit(before, after);
    if (!edit) {
      assert.equal(before, after);
      continue;
    }
    assert.equal(applyTextEdit(before, edit), after, JSON.stringify([before, after]));
    for (const at of [edit.from, edit.to]) {
      assert.ok(!/[\uD800-\uDBFF]$/.test(before.slice(0, at)) || at === 0, `inside a pair: ${JSON.stringify([before, after, edit])}`);
      assert.ok(!(before[at - 1] === '\r' && before[at] === '\n'), `inside CRLF: ${JSON.stringify([before, after, edit])}`);
    }
  }
});

test('lineEditToTextEdit: inserts, replaces and removes whole lines with the document’s line ending', () => {
  const lf = 'A\nB\nC\n';
  assert.equal(apply(lf, { start: 1, end: 1, lines: ['X'] }), 'A\nX\nB\nC\n');
  assert.equal(apply(lf, { start: 1, end: 2, lines: [] }), 'A\nC\n');
  assert.equal(apply(lf, { start: 1, end: 2, lines: ['Y', 'Z'] }), 'A\nY\nZ\nC\n');
  // Through the last line: the line break before the removed lines goes with them.
  assert.equal(apply('A\nB', { start: 1, end: 2, lines: [] }), 'A');
  assert.equal(apply('A\nB', { start: 2, end: 2, lines: ['C'] }), 'A\nB\nC');
  assert.equal(apply('A\nB', { start: 0, end: 2, lines: ['Z'] }), 'Z');
  const crlf = 'A\r\nB\r\n';
  assert.equal(eolOf(crlf), '\r\n');
  assert.equal(apply(crlf, { start: 1, end: 1, lines: ['X'] }), 'A\r\nX\r\nB\r\n');
  assert.deepEqual(lineEditToTextEdit('A\r\nB\r\n', { start: 1, end: 2, lines: [] }), { from: 3, to: 6, insert: '' });
  assert.throws(() => lineEditToTextEdit('A', { start: 0, end: 3, lines: [] }), RangeError);
});

test('lineEditToTextEdit agrees with applyLineEdits', () => {
  const random = prng(11);
  for (let i = 0; i < 500; i++) {
    const count = 1 + Math.floor(random() * 6);
    const doc = Array.from({ length: count }, (_, k) => (random() < 0.3 ? '' : `l${k}`));
    const text = doc.join(random() < 0.5 ? '\n' : '\r\n');
    const start = Math.floor(random() * (count + 1));
    const end = start + Math.floor(random() * (count - start + 1));
    const edit: LineEdit = { start, end, lines: Array.from({ length: Math.floor(random() * 3) }, (_, k) => `n${k}`) };
    const expected = applyLineEdits(doc, [edit]);
    const got = splitLines(apply(text, edit));
    // Removing every line leaves one empty line: an empty text.
    assert.deepEqual(got, expected.length ? expected : [''], JSON.stringify({ text, edit }));
  }
});

test('insertBlock pads with blank lines only where the snippet would touch text', () => {
  const doc = lines('# Title\nPara\n\n:::note\nIn\n:::\n');
  // Between two blocks with no blank line: a blank line on each side.
  assert.deepEqual(insertBlock(doc, 1, 'New'), { edit: { start: 1, end: 1, lines: ['', 'New', ''] }, line: 2 });
  // After a blank line, before a container: none (blank lines around the snippet are dropped).
  assert.deepEqual(insertBlock(doc, 3, '\nNew\n\n'), { edit: { start: 3, end: 3, lines: ['New'] }, line: 3 });
  // After a blank line, before text: one blank line after.
  assert.deepEqual(insertBlock(['A', '', 'B'], 2, 'New'), { edit: { start: 2, end: 2, lines: ['New', ''] }, line: 2 });
  // Right inside a container, next to its fences: none.
  assert.deepEqual(insertBlock(doc, 4, '- item'), { edit: { start: 4, end: 4, lines: ['- item', ''] }, line: 4 });
  assert.deepEqual(insertBlock(doc, 5, '- item'), { edit: { start: 5, end: 5, lines: ['', '- item'] }, line: 6 });
  // At the end of a text without a final line break.
  assert.deepEqual(insertBlock(['Para'], 1, 'New'), { edit: { start: 1, end: 1, lines: ['', 'New'] }, line: 2 });
  // Into an empty document.
  assert.equal(apply('', insertBlock([''], 0, 'New').edit), 'New\n');
});

test('insertBlock leaves every existing line as it was, and the snippet becomes a block of its own', () => {
  const text = '---\ntitle: T\n---\n# A\nText\n\n- a\n- b\n\n> q\n';
  const doc = lines(text);
  for (let at = 3; at <= doc.length; at++) {
    const { edit, line } = insertBlock(doc, at, 'Inserted paragraph');
    assert.equal(edit.start, edit.end, 'only inserts');
    const after = applyLineEdits(doc, [edit]);
    assert.deepEqual(after.filter((_, i) => i < edit.start || i >= edit.start + edit.lines.length), doc);
    assert.equal(after[line], 'Inserted paragraph');
    const seg = segmentSmd(after.join('\n')).find((s) => s.start === line);
    assert.deepEqual([seg?.type, seg?.end], ['paragraph', line + 1], `at ${at}: ${JSON.stringify(after)}`);
  }
});

test('deleteBlock removes one separating blank line and never joins its neighbours', () => {
  const cases: Array<[string[], [number, number], string[]]> = [
    [['A', '', 'B', '', 'C'], [2, 3], ['A', '', 'C']],
    [['A', '', 'B'], [2, 3], ['A']],
    [['A', '', 'B', ''], [2, 3], ['A', '']],
    [['B', '', 'C'], [0, 1], ['C']],
    [['A', 'B', '', 'C'], [1, 2], ['A', '', 'C']],
    [['A', '', 'B', 'C'], [2, 3], ['A', '', 'C']],
    [['Para', '# H', 'Para'], [1, 2], ['Para', '', 'Para']],
    [[':::note', 'B', ':::'], [1, 2], [':::note', ':::']],
    [[':::note', 'B', '', ':::'], [1, 2], [':::note', ':::']],
    [['---', 'x: 1', '---', '', '# T'], [0, 3], ['# T']],
  ];
  for (const [doc, [start, end], expected] of cases) {
    assert.deepEqual(applyLineEdits(doc, [deleteBlock(doc, { start, end })]), expected, JSON.stringify(doc));
  }
});

test('moveBlock moves a block up or down in one set of edits', () => {
  const doc = ['# A', '', 'One', '', 'Two', '', 'Three', ''];
  const down = moveBlock(doc, { start: 2, end: 3 }, 5)!;
  assert.deepEqual(applyLineEdits(doc, down.edits), ['# A', '', 'Two', '', 'One', '', 'Three', '']);
  assert.equal(applyLineEdits(doc, down.edits)[down.line], 'One');
  const up = moveBlock(doc, { start: 6, end: 7 }, 2)!;
  assert.deepEqual(applyLineEdits(doc, up.edits), ['# A', '', 'Three', '', 'One', '', 'Two', '']);
  assert.equal(up.line, 2);
  const last = moveBlock(doc, { start: 2, end: 3 }, 8)!;
  assert.deepEqual(applyLineEdits(doc, last.edits), ['# A', '', 'Two', '', 'Three', '', 'One']);
  assert.equal(moveBlock(doc, { start: 2, end: 3 }, 3), null, 'where it already is');
  // Tight neighbours: the block leaves a blank line behind and gets blank lines where it lands.
  const tight = ['Para', '# H', 'Text', '', 'End'];
  const moved = moveBlock(tight, { start: 1, end: 2 }, 5)!;
  assert.deepEqual(applyLineEdits(tight, moved.edits), ['Para', '', 'Text', '', 'End', '', '# H']);
});

test('moveBlock keeps every other line and lands the block intact, at any segment boundary', () => {
  const text = '# Title\n\nIntro text\nmore\n\n- a\n- b\n\n```ts\ncode\n```\n\n:::note N\nBody\n:::\n\n> quote\n';
  const doc = lines(text);
  const segments = segmentSmd(text);
  const blocks = segments.filter((s) => s.kind === 'block');
  const boundaries = [...segments.map((s) => s.start), doc.length];
  for (const seg of blocks) {
    const block = doc.slice(seg.start, seg.end);
    for (const to of boundaries) {
      const move = moveBlock(doc, seg, to);
      if (!move) continue;
      const after = applyLineEdits(doc, move.edits);
      assert.deepEqual(after.slice(move.line, move.line + block.length), block);
      const others = (l: string[]) => l.filter((x) => x.trim() !== '').join('\n');
      const without = [...doc.slice(0, seg.start), ...doc.slice(seg.end)];
      const rest = [...after.slice(0, move.line), ...after.slice(move.line + block.length)];
      assert.equal(others(rest), others(without), `moving ${seg.start}-${seg.end} to ${to}`);
      // Every block is still a block of its own.
      assert.equal(segmentSmd(after.join('\n')).filter((s) => s.kind === 'block').length, blocks.length, `moving ${seg.start}-${seg.end} to ${to}: ${JSON.stringify(after)}`);
    }
  }
});
