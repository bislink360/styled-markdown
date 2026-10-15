import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FROZEN, blockLabel, blockName, cellLabel, cellSource, clampCell, desiredOrder, editLabel, findView, followEdit, formRequest, gridActionEnabled,
  gridAnnouncement, gridKeyTarget, gridLabel, gridRequest, inlineAnnouncement, inlineItemLabel, inlineRequest, isUndoRedo, itemAnnouncement, itemForLine,
  linesLabel, listKeyTarget, mergeProblems, fixLabel, fixesAnnouncement, frontMatterValue, boundaryY, dropAnnouncement, dropIndex, dropMoves, dropTo, imageProblem, toBase64, orderMoves, problemsLabel, refreshedValue, shiftLine, textareaRows, toolbarKeyTarget, topRange, typeAhead, withoutLines,
  type GridAction,
} from '../src/webview/blockEditorModel';
import type { BlockView } from '../src/blockEditorSession';
import { cellText } from '../src/core/tableEdit';
import { prng } from './fuzz/generate';

// The Block Editor page's logic (src/webview/blockEditorModel.ts), and what the page script may and may not do.

const view = (key: string, start: number, end: number, extra: Partial<BlockView> = {}): BlockView =>
  ({ key, kind: 'block', type: 'paragraph', start, end, source: '', ...extra });

test('labels say what a block is and where, one-based', () => {
  assert.equal(blockLabel(view('a#0', 2, 5)), 'Paragraph, lines 3–5');
  assert.equal(blockLabel(view('a#0', 0, 1, { type: 'heading' })), 'Heading, line 1');
  assert.equal(blockName({ type: 'container', container: 'warning' }), 'Warning container');
  assert.equal(blockName({ type: 'fence' }), 'Code block');
  assert.equal(blockName({ type: 'gap' }), 'Unrendered lines');
  assert.equal(blockName({ type: 'frontmatter' }), 'Front matter');
  assert.equal(blockName({ type: 'dl' }), 'Dl', 'other markdown-it block types');
  assert.equal(editLabel(view('a#0', 9, 12, { type: 'container', container: 'risk' })), 'Edit source of risk container, lines 10–12');
  assert.equal(editLabel(view('a#0', 0, 3, { type: 'frontmatter' })), 'Edit source of front matter, lines 1–3');
  assert.equal(linesLabel({ start: 4, end: 5 }), 'line 5');
  assert.equal(problemsLabel(undefined), '');
  assert.equal(problemsLabel({ count: 1, severity: 'error', messages: [] }), '1 problem');
  assert.equal(problemsLabel({ count: 3, severity: 'warning', messages: [] }), '3 problems');
});

test('withoutLines and shiftLine: a block that only moved keeps its rendering, with its line numbers moved', () => {
  const a = '<p data-line="4">x <input class="smd-task-box" data-task-line="4"></p>';
  const b = '<p data-line="9">x <input class="smd-task-box" data-task-line="9"></p>';
  assert.equal(withoutLines(a), withoutLines(b));
  assert.notEqual(withoutLines(a), withoutLines('<p data-line="4">y</p>'));
  assert.equal(shiftLine('4', 5), '9');
  assert.equal(shiftLine('10', -3), '7');
  assert.equal(shiftLine('', 2), '', 'empty values stay');
  assert.equal(shiftLine('x', 2), 'x');
});

test('desiredOrder: the block being edited stands in for every block on its lines, never replaced', () => {
  const blocks = [view('a', 0, 1), view('b', 2, 4), view('c', 4, 6), view('d', 7, 8)];
  assert.deepEqual(desiredOrder(blocks, null), ['a', 'b', 'c', 'd']);
  assert.deepEqual(desiredOrder(blocks, { start: 2, end: 6 }), ['a', FROZEN, 'd'], 'its lines split into two blocks');
  assert.deepEqual(desiredOrder(blocks, { start: 2, end: 4 }), ['a', FROZEN, 'c', 'd']);
  assert.deepEqual(desiredOrder(blocks, { start: 6, end: 7 }), ['a', 'b', 'c', FROZEN, 'd'], 'its lines are a gap now');
  assert.deepEqual(desiredOrder(blocks, { start: 20, end: 21 }), ['a', 'b', 'c', 'd', FROZEN], 'past the end');
});

test('orderMoves: inserts and removals move nothing else; a reorder moves one element', () => {
  assert.deepEqual(orderMoves(['a', 'b', 'c'], ['a', 'b', 'c']), []);
  assert.deepEqual(orderMoves(['a', 'c'], ['a', 'b', 'c']), [{ id: 'b', before: 'c' }]);
  assert.deepEqual(orderMoves(['a', 'b', 'c'], ['a', 'c']), [], 'removed first, by the caller');
  assert.deepEqual(orderMoves(['a', 'b', 'c'], ['b', 'a', 'c']), [{ id: 'b', before: 'a' }]);
  assert.deepEqual(orderMoves(['a', 'b'], ['a', 'b', 'x']), [{ id: 'x', before: null }]);
  // Any change of order ends in the order wanted.
  const apply = (current: string[], desired: string[]) => {
    const now = current.filter((id) => desired.includes(id));
    for (const m of orderMoves(current, desired)) {
      const from = now.indexOf(m.id);
      if (from >= 0) now.splice(from, 1);
      now.splice(m.before === null ? now.length : now.indexOf(m.before), 0, m.id);
    }
    return now;
  };
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const random = prng(42);
  for (let i = 0; i < 200; i++) {
    const pool = [...ids, `n${i}`];
    const desired: string[] = [];
    while (desired.length < 5) desired.push(...pool.splice(Math.floor(random() * pool.length), 1));
    assert.deepEqual(apply(ids, desired), desired);
  }
});

test('listKeyTarget and toolbarKeyTarget: arrows, Home and End', () => {
  assert.equal(listKeyTarget('ArrowDown', 0, 3), 1);
  assert.equal(listKeyTarget('ArrowDown', 2, 3), 2, 'stops at the last block');
  assert.equal(listKeyTarget('ArrowDown', 2, 3, true), 0, 'menus wrap');
  assert.equal(listKeyTarget('ArrowUp', 0, 3), 0);
  assert.equal(listKeyTarget('ArrowUp', 0, 3, true), 2);
  assert.equal(listKeyTarget('Home', 2, 3), 0);
  assert.equal(listKeyTarget('End', 0, 3), 2);
  assert.equal(listKeyTarget('x', 0, 3), -1);
  assert.equal(listKeyTarget('ArrowDown', 0, 0), -1);
  assert.equal(toolbarKeyTarget('ArrowRight', 7, 8), 0);
  assert.equal(toolbarKeyTarget('ArrowLeft', 0, 8), 7);
  assert.equal(toolbarKeyTarget('End', 0, 8), 7);
  assert.equal(toolbarKeyTarget('ArrowDown', 0, 8), -1);
});

test('typeAhead finds the next name starting with a letter, wrapping', () => {
  const names = ['Callout', 'Card', 'Details', 'Code with title'];
  assert.equal(typeAhead(names, 'c', 0), 1);
  assert.equal(typeAhead(names, 'C', 1), 3);
  assert.equal(typeAhead(names, 'c', 3), 0);
  assert.equal(typeAhead(names, 'z', 0), -1);
});

test('itemForLine: the item on a line, else the next one, else the last', () => {
  assert.equal(itemForLine([0, 4, 9], 4), 1);
  assert.equal(itemForLine([0, 4, 9], 5), 2);
  assert.equal(itemForLine([0, 4, 9], 50), 2);
});

test('isUndoRedo: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y, by key or by physical key', () => {
  assert.equal(isUndoRedo({ key: 'z', ctrlKey: true, metaKey: false }), true);
  assert.equal(isUndoRedo({ key: 'Z', ctrlKey: true, metaKey: false }), true);
  assert.equal(isUndoRedo({ key: 'y', ctrlKey: false, metaKey: true }), true);
  assert.equal(isUndoRedo({ key: 'я', code: 'KeyZ', ctrlKey: true, metaKey: false }), true, 'another keyboard layout');
  assert.equal(isUndoRedo({ key: 'z', ctrlKey: false, metaKey: false }), false);
  assert.equal(isUndoRedo({ key: 's', ctrlKey: true, metaKey: false }), false, 'save reaches VS Code');
});

test('formRequest: what each control asks for', () => {
  assert.deepEqual(formRequest({ name: 'title', kind: 'title' }, '  New title '), { type: 'setTitle', title: 'New title' });
  assert.deepEqual(formRequest({ name: 'collapsible', kind: 'flag' }, true), { type: 'setAttr', name: 'collapsible', value: true });
  assert.deepEqual(formRequest({ name: 'collapsible', kind: 'flag' }, false), { type: 'setAttr', name: 'collapsible', value: null });
  assert.deepEqual(formRequest({ name: 'status', kind: 'select' }, ''), { type: 'setAttr', name: 'status', value: null });
  assert.deepEqual(formRequest({ name: 'color', kind: 'color' }, 'teal'), { type: 'setAttr', name: 'color', value: 'teal' });
  assert.deepEqual(formRequest({ name: 'owner', kind: 'text' }, ' @a '), { type: 'setAttr', name: 'owner', value: '@a' });
});

test('findView, followEdit and topRange: the block being edited across renders', () => {
  const child = view('c#0', 5, 6);
  const blocks = [view('a#0', 0, 1), view('box#0', 4, 8, { type: 'container', children: [child] })];
  assert.equal(findView(blocks, 'c#0'), child);
  assert.equal(findView(blocks, 'zz#0'), undefined);
  const render = { blocks, renamed: { 'old#0': 'c#0' }, pins: { 'split#0': { start: 4, end: 7 } } };
  assert.deepEqual(followEdit(render, 'old#0', { start: 0, end: 1 }), { key: 'c#0', range: { start: 5, end: 6 } }, 'renamed');
  assert.deepEqual(followEdit(render, 'a#0', { start: 9, end: 9 }), { key: 'a#0', range: { start: 0, end: 1 } }, 'still there');
  assert.deepEqual(followEdit(render, 'split#0', { start: 2, end: 3 }), { key: 'split#0', range: { start: 4, end: 7 } }, 'pinned');
  assert.deepEqual(followEdit(render, 'gone#0', { start: 5, end: 6 }), { key: 'c#0', range: { start: 5, end: 6 } }, 'the block on its first line');
  assert.deepEqual(followEdit(render, 'gone#0', { start: 2, end: 3 }), { key: 'gone#0', range: { start: 2, end: 3 } }, 'nothing there');
  assert.deepEqual(topRange(blocks, { start: 5, end: 6 }), { start: 4, end: 8 });
  assert.deepEqual(topRange(blocks, { start: 2, end: 3 }), { start: 2, end: 3 });
});

test('inlineRequest asks only for what changed: content trimmed, emptied attributes removed', () => {
  const fields = [
    { name: 'content', value: 'Beta' },
    { name: 'color', value: 'blue' },
    { name: 'label', value: '' },
  ];
  assert.equal(inlineRequest(fields, { content: 'Beta', color: 'blue', label: '' }), null, 'nothing changed');
  assert.equal(inlineRequest(fields, { content: ' Beta ' }), null, 'only spaces around it');
  assert.deepEqual(inlineRequest(fields, { content: ' GA ' }), { content: 'GA' });
  assert.deepEqual(inlineRequest(fields, { color: '', label: 'Act' }), { attrs: { color: null, label: 'Act' } });
  assert.deepEqual(inlineRequest(fields, { content: '', color: 'red' }), { content: '', attrs: { color: 'red' } }, 'content may be emptied');
});

test('inline labels and announcements', () => {
  assert.equal(inlineItemLabel({ label: 'Badge', text: 'Shipped' }), 'Badge "Shipped", press Enter to edit');
  assert.equal(inlineItemLabel({ label: 'Progress bar', text: '' }), 'Progress bar, press Enter to edit');
  const fields = [{ name: 'content', kind: 'text' as const, label: 'Text', value: 'A' }, { name: 'color', kind: 'color' as const, label: 'Color', value: '' }];
  assert.equal(inlineAnnouncement({ label: 'Badge', fields }, { content: 'Done', attrs: { color: 'green' } }), 'Badge: Text "Done", Color green.');
  assert.equal(inlineAnnouncement({ label: 'Badge', fields }, { attrs: { color: null, bg: 'red' } }), 'Badge: Color removed, bg red.');
});

test('page: inline items get a popover in a closed shadow root, keyboard stops in the current block, focus back after Escape', () => {
  assert.match(pageSource, /const popRoot = chromeRoot\(popHost\);/);
  assert.match(pageSource, /type: 'setInline'/);
  assert.match(pageSource, /rt\.announce\(inlineAnnouncement\(/);
  assert.match(pageSource, /if \(escape\) closePop\(true\);/);
  assert.match(pageSource, /if \(msg\.fallback\) editSourceOf\(msg\.fallback\);/, 'a refused inline change opens the block\'s source');
  assert.match(pageSource, /el\.setAttribute\(TABINDEX, '0'\);/);
});

test('grid: arrow keys, Enter and Shift+Enter move between cells, ← → only from the edges of the text, never past the grid', () => {
  const size = { rows: 3, cols: 2 };
  const edges = { atStart: true, atEnd: true };
  const inside = { atStart: false, atEnd: false };
  assert.deepEqual(gridKeyTarget('ArrowDown', { row: 0, col: 1 }, size, inside), { row: 1, col: 1 });
  assert.deepEqual(gridKeyTarget('ArrowUp', { row: 2, col: 0 }, size, inside), { row: 1, col: 0 });
  assert.deepEqual(gridKeyTarget('Enter', { row: 1, col: 0 }, size, inside), { row: 2, col: 0 });
  assert.deepEqual(gridKeyTarget('Enter', { row: 1, col: 0 }, size, inside, true), { row: 0, col: 0 }, 'Shift+Enter goes up');
  assert.equal(gridKeyTarget('Enter', { row: 2, col: 0 }, size, inside), null, 'the last row: Enter stays');
  assert.equal(gridKeyTarget('ArrowRight', { row: 0, col: 0 }, size, inside), null, 'inside the text, the caret moves');
  assert.deepEqual(gridKeyTarget('ArrowRight', { row: 0, col: 0 }, size, edges), { row: 0, col: 1 });
  assert.deepEqual(gridKeyTarget('ArrowLeft', { row: 0, col: 1 }, size, { atStart: true, atEnd: false }), { row: 0, col: 0 });
  assert.equal(gridKeyTarget('ArrowLeft', { row: 0, col: 0 }, size, edges), null);
  assert.equal(gridKeyTarget('ArrowUp', { row: 0, col: 0 }, size, edges), null);
  assert.equal(gridKeyTarget('Tab', { row: 0, col: 0 }, size, edges), null, 'Tab is the browser\'s: the next field');
  assert.equal(gridKeyTarget('toString', { row: 0, col: 0 }, size, edges), null);
  assert.deepEqual(clampCell({ row: 9, col: -1 }, size), { row: 2, col: 0 });
});

test('grid: cell labels, the grid\'s label and announcements', () => {
  const header = ['Name', ' ', 'Age'];
  assert.equal(cellLabel(header, { row: 0, col: 2 }, 4), 'Header, column 3 of 3');
  assert.equal(cellLabel(header, { row: 2, col: 0 }, 4), 'Name, row 2 of 3');
  assert.equal(cellLabel(header, { row: 1, col: 1 }, 4), 'Column 2, row 1 of 3', 'an empty header: the column number');
  assert.equal(gridLabel({ start: 4, end: 8 }), 'Table grid, lines 5–8');
  assert.equal(gridAnnouncement({ type: 'tableRow', op: 'insert', at: 2 }), 'Row 2 added.');
  assert.equal(gridAnnouncement({ type: 'tableRow', op: 'delete', at: 1 }), 'Row 1 deleted.');
  assert.equal(gridAnnouncement({ type: 'tableCol', op: 'insert', at: 0 }), 'Column 1 added.');
  assert.equal(gridAnnouncement({ type: 'tableCol', op: 'delete', at: 2 }), 'Column 3 deleted.');
  assert.equal(gridAnnouncement({ type: 'tableCol', op: 'align', at: 1, align: 'center' }), 'Column 2 aligned centered.');
  assert.equal(gridAnnouncement({ type: 'tableCol', op: 'align', at: 1, align: 'none' }), 'Column 2 alignment removed.');
  assert.equal(gridAnnouncement({ type: 'tableAlign' }), 'Table aligned.');
});

test('grid: the toolbar\'s actions as requests, and when they can be taken', () => {
  const cell = { row: 2, col: 1 };
  const expected: Record<GridAction, unknown> = {
    rowAbove: { type: 'tableRow', op: 'insert', at: 2 },
    rowBelow: { type: 'tableRow', op: 'insert', at: 3 },
    delRow: { type: 'tableRow', op: 'delete', at: 2 },
    colLeft: { type: 'tableCol', op: 'insert', at: 1 },
    colRight: { type: 'tableCol', op: 'insert', at: 2 },
    delCol: { type: 'tableCol', op: 'delete', at: 1 },
    alignTable: { type: 'tableAlign' },
  };
  for (const [action, request] of Object.entries(expected)) assert.deepEqual(gridRequest(action as GridAction, cell), request, action);
  const header = { row: 0, col: 0 };
  assert.equal(gridActionEnabled('rowAbove', header, { rows: 3, cols: 2 }), false, 'nothing above the header');
  assert.equal(gridActionEnabled('delRow', header, { rows: 3, cols: 2 }), false, 'the header stays');
  assert.equal(gridActionEnabled('rowBelow', header, { rows: 1, cols: 2 }), true);
  assert.equal(gridActionEnabled('delCol', header, { rows: 3, cols: 1 }), false, 'the last column stays');
  assert.equal(gridActionEnabled('delRow', cell, { rows: 3, cols: 2 }), true);
});

test('grid: a cell is written as the extension writes it, and a render keeps what the user typed and has not written', () => {
  const r = prng(5);
  const chars = ['a', '|', '\\', ' ', '`', 'é'];
  for (let i = 0; i < 500; i++) {
    const text = Array.from({ length: Math.floor(r() * 8) }, () => chars[Math.floor(r() * chars.length)]).join('');
    assert.equal(cellSource(text), cellText(text), JSON.stringify(text));
  }
  // Written, and the render has it: the user's own text stays while they are in the cell (a trailing space they typed).
  assert.equal(refreshedValue('a ', 'a', 'a', true), 'a ');
  assert.equal(refreshedValue('a|b', 'a\\|b', 'a\\|b', false), 'a\\|b', 'out of the cell: the text as written');
  assert.equal(refreshedValue('x', 'x', 'y', false), 'y', 'changed in another editor');
  assert.equal(refreshedValue('typed', 'x', 'y', true), 'typed', 'not written yet: kept');
  assert.equal(refreshedValue('typed', 'x', 'y', false), 'typed');
});

test('page: the grid is a labelled role="grid" table of text fields in a closed shadow root, and sends the table messages', () => {
  assert.match(pageSource, /const root = chromeRoot\(host\);\n\s+const label = h\('p', \{ className: 'label', text: gridLabel\(view\), attrs: \{ id: 'grid-label' \} \}\);/);
  assert.match(pageSource, /h\('table', \{ className: 'grid', attrs: \{ role: 'grid', 'aria-labelledby': 'grid-label' \} \}\)/);
  assert.match(pageSource, /input\.setAttribute\(ARIA_LABEL, cellLabel\(/);
  assert.match(pageSource, /role: 'toolbar', \[ARIA_LABEL\]: 'Table rows and columns'/);
  assert.match(pageSource, /type: 'tableCell', key: g\.key/);
  assert.match(pageSource, /post\(\{ \.\.\.request, key: g\.key, editId \}\)/);
  assert.match(pageSource, /rt\.announce\(gridAnnouncement\(request\)\)/);
  assert.match(pageSource, /g\.timer = setTimeout\(\(\) => commitCell\(g, cell\), AUTOSAVE_DELAY\)/, 'typing is written after a pause, as in the source editor');
});

test('problems: merged for a container that shows a lost child\'s, and announced with the block', () => {
  const warn = { count: 1, severity: 'warning' as const, messages: ['Line 3: a'] };
  const err = { count: 2, severity: 'error' as const, messages: ['Line 5: b', 'Line 6: c'] };
  assert.equal(mergeProblems(), undefined);
  assert.equal(mergeProblems(undefined, undefined), undefined);
  assert.equal(mergeProblems(warn, undefined), warn, 'one list is itself');
  assert.deepEqual(mergeProblems(warn, err), { count: 3, severity: 'error', messages: ['Line 3: a', 'Line 5: b', 'Line 6: c'] });
  const many = { count: 12, severity: 'info' as const, messages: Array.from({ length: 10 }, (_, i) => `m${i}`) };
  assert.equal(mergeProblems(many, warn)!.messages.length, 10, 'at most as many messages as the extension sends');
  assert.equal(mergeProblems(many, warn)!.count, 13);
  assert.equal(itemAnnouncement(view('a', 2, 4), undefined), 'Paragraph, lines 3–4');
  assert.equal(itemAnnouncement(view('a', 2, 4), err), 'Paragraph, lines 3–4, 2 problems. Ctrl+. shows them.');
});

test('page: problem badges on top-level blocks and children, in closed shadow roots, open the problems list', () => {
  assert.match(pageSource, /updateChrome\(el, mergeProblems\(child\.problems, annotateChildren\(el, child\.children\)\), true\)/, 'children get badges');
  assert.match(pageSource, /lost = mergeProblems\(lost, child\.problems/, 'a child not in the HTML: its container shows its problems');
  assert.match(pageSource, /h\('button', \{ className: 'badge', attrs: \{ type: 'button', \[TABINDEX\]: '-1', 'aria-hidden': TRUE \} \}\)/, 'one tab stop: the badge is for the mouse');
  assert.match(pageSource, /event\.key === '\.' && \(event\.ctrlKey \|\| event\.metaKey\)/, 'Ctrl+. on a block');
  assert.match(pageSource, /problems: button\('Problems…'/);
  assert.match(pageSource, /h\('ul', \{ className: 'problems' \}, problems\.messages\.map\(\(m\) => h\('li', \{ text: m \}\)\)\)/);
});

test('quick fixes: each button says what more than the block it changes, and the list is announced', () => {
  assert.equal(fixLabel({ title: 'Change to "blue"', scope: 'block' }), 'Change to "blue"');
  assert.equal(fixLabel({ title: 'Add ":::"', scope: 'lines' }), 'Add ":::" (also changes other lines)');
  assert.equal(fixLabel({ title: 'Rename', scope: 'files' }), 'Rename (also changes other files)');
  assert.equal(fixesAnnouncement([]), 'No quick fixes.');
  assert.equal(fixesAnnouncement([{ title: 'Change to "blue"', scope: 'block' }]), '1 quick fix: Change to "blue".');
  assert.equal(fixesAnnouncement([{ title: 'a', scope: 'block' }, { title: 'b', scope: 'lines' }]), '2 quick fixes.');
});

test('page: quick fixes are asked for by block and applied by number; the page never sends an edit of its own', () => {
  assert.match(pageSource, /post\(\{ type: 'getFixes', key: view\.key, requestId \}\)/);
  assert.match(pageSource, /post\(\{ type: 'applyFix', key: target\.key, index, version: target\.version, \.\.\.\(confirm \? \{ confirm: true \} : \{\}\), editId: target\.editId \}\)/);
  assert.match(pageSource, /case 'confirmFix':\n\s+onConfirmFix\(msg\.editId, msg\.index, msg\.text\);/, 'a fix that changes more than the block is confirmed first');
  assert.match(pageSource, /'aria-live': 'polite'/, 'the fixes arriving are read');
});

test('front matter form: a field\'s value as setFrontMatter takes it', () => {
  assert.equal(frontMatterValue({ kind: 'text' }, '  New title '), 'New title');
  assert.equal(frontMatterValue({ kind: 'select' }, ''), null, 'emptied: the key is removed');
  assert.equal(frontMatterValue({ kind: 'date' }, '2026-10-15'), '2026-10-15');
  assert.deepEqual(frontMatterValue({ kind: 'list' }, '@maya, @api ,, x y'), ['@maya', '@api', 'x y']);
  assert.equal(frontMatterValue({ kind: 'list' }, ' , '), null);
});

test('page: the front matter\'s fields are in the Properties panel, labelled, with the YAML a button away', () => {
  assert.match(pageSource, /post\(\{ type: 'setFrontMatter', key, name: field\.name, value: frontMatterValue\(field, control\.value\), editId: nextId\(\) \}\)/);
  assert.match(pageSource, /if \(view\?\.type === 'frontmatter'\) \{\n\s+fillFrontMatterProps\(view\);/);
  assert.match(pageSource, /control\.setAttribute\('aria-describedby', notes\.map\(\(n\) => n\.id\)\.join\(' '\)\)/, 'list and refusal notes are read with the field');
  assert.match(pageSource, /button\('Edit YAML'/);
});

test('drag and drop: the boundary nearest the pointer, never right next to the block, and what is announced', () => {
  const boxes = [{ top: 0, bottom: 20 }, { top: 30, bottom: 50 }, { top: 60, bottom: 100 }];
  assert.deepEqual([0, 1, 2, 3].map((i) => boundaryY(boxes, i)), [0, 25, 55, 100]);
  assert.equal(boundaryY([], 0), 0);
  assert.equal(dropIndex(boxes, -40), 0);
  assert.equal(dropIndex(boxes, 10), 0, 'nearer the top of the first box than the space after it');
  assert.equal(dropIndex(boxes, 20), 1);
  assert.equal(dropIndex(boxes, 60), 2);
  assert.equal(dropIndex(boxes, 90), 3, 'after the last one');
  assert.equal(dropIndex([], 5), 0);
  assert.equal(dropMoves(1, 1), false, 'right before itself');
  assert.equal(dropMoves(2, 1), false, 'right after itself');
  assert.equal(dropMoves(0, 1), true);
  assert.equal(dropMoves(3, 1), true);
  assert.equal(dropTo(['a#0', 'b#0'], 1), 'b#0');
  assert.equal(dropTo(['a#0', 'b#0'], 2), 'end');
  assert.equal(dropAnnouncement({ type: 'paragraph' }, view('h', 4, 5, { type: 'heading' })), 'Paragraph moved before heading, line 5.');
  assert.equal(dropAnnouncement({ type: 'container', container: 'note' }, undefined), 'Note container moved to the end.');
});

test('page: one drag handle in a closed shadow root; a drop sends move with a sibling key, never lines', () => {
  assert.match(pageSource, /attrs: \{ draggable: TRUE, 'aria-hidden': TRUE, title: 'Drag to move this block \(Alt\+Up and Alt\+Down from the keyboard\)' \}/);
  assert.match(pageSource, /post\(\{ type: 'move', key: d\.view\.key, to: dropTo\(keys, index\), editId \}\)/);
  assert.match(pageSource, /drops\.set\(editId, dropAnnouncement\(/, 'the result of a drop is announced');
  assert.match(pageSource, /siblingGroups\.set\(el, complete \? group : \[\]\)/, 'children are dropped only among their own siblings');
});

test('images: what the page sends, and what it doesn\'t', () => {
  assert.equal(imageProblem({ name: 'a.png', type: 'image/png', size: 100 }), undefined);
  assert.equal(imageProblem({ type: 'image/svg+xml', size: 100 }), undefined);
  assert.equal(imageProblem({ name: 'a.tiff', type: 'image/tiff', size: 100 }), '"a.tiff" is not a PNG, JPEG, GIF, WebP, BMP, AVIF or SVG image.');
  assert.equal(imageProblem({ type: 'text/plain', size: 1 }), 'The pasted file is not a PNG, JPEG, GIF, WebP, BMP, AVIF or SVG image.');
  assert.equal(imageProblem({ name: 'big.png', type: 'image/png', size: 10 * 1024 * 1024 + 1 }), '"big.png" is larger than 10 MB.');
  assert.equal(imageProblem({ name: 'e.png', type: 'image/png', size: 0 }), '"e.png" is empty.');
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'), 'in chunks, the same as in one go');
  assert.equal(toBase64(new Uint8Array()), '');
});

test('page: pasted and dropped images go to the extension as bytes with a type, never as a path', () => {
  assert.match(pageSource, /post\(\{ type: 'image', mime: file\.type, data, \.\.\.\(named && file\.name \? \{ name: file\.name \} : \{\}\), \.\.\.place, editId: nextId\(\) \}\)/);
  assert.match(pageSource, /document\.addEventListener\('paste', \(event\) => \{/);
  assert.match(pageSource, /data: DataTransfer \| null\): File\[\] => Array\.from\(data\?\.files \?\? \[\]\)/);
  assert.doesNotMatch(pageSource, /\.path\b.*type: 'image'/);
});

test('textareaRows grows with the text, within limits', () => {
  assert.equal(textareaRows(''), 2);
  assert.equal(textareaRows('a\nb\nc'), 4);
  assert.equal(textareaRows('x\n'.repeat(100)), 40);
});

// ---------------------------------------------------------------------------
// The page script itself
// ---------------------------------------------------------------------------

const pageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'blockEditor.ts'), 'utf8');
const modelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'blockEditorModel.ts'), 'utf8');

test('page: the editor chrome is built with createElement and textContent; innerHTML only takes rendered document HTML', () => {
  const uses = [...pageSource.matchAll(/(\w+)\.innerHTML\s*=\s*([^;]+);/g)].map((m) => `${m[1]} = ${m[2].trim()}`).sort();
  // The header, contents and footnotes; the article's opening tag; a block's HTML. All from the extension's renderer.
  assert.deepEqual(uses, ["content = view.html ?? ''", 'holder = html', 'template = `${open}</article>`']);
  assert.doesNotMatch(pageSource, /insertAdjacentHTML|outerHTML\s*=|document\.write/);
  assert.match(pageSource, /attachShadow\(\{ mode: 'closed' \}\)/);
  assert.doesNotMatch(pageSource, /postMessage\([^)]*,\s*['"]\*['"]/, 'no postMessage to any origin');
  assert.match(pageSource, /if \(event\.origin !== window\.origin\) return;/, 'host messages only from the page\'s own origin');
  assert.doesNotMatch(pageSource, /acquireVsCodeApi|setState\(/, 'the runtime owns the VS Code handle and the saved state');
});

test('page: the webview code imports no part of the .smd engine (types only from the session)', () => {
  for (const source of [pageSource, modelSource]) {
    const imports = [...source.matchAll(/^import (type )?[^;]*from '([^']+)';/gm)].map((m) => [m[1] ?? '', m[2]]);
    for (const [kind, from] of imports) {
      if (from === '../blockEditorSession') assert.equal(kind, 'type ', 'only types from the session module');
      else assert.equal(from, './blockEditorModel');
    }
  }
});
