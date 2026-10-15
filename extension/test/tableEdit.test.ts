import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RenderOptions } from '../src/core';
import { segmentSmd, type Segment } from '../src/core/blocks';
import { formatSmd } from '../src/core/format';
import { parseSmdTokens } from '../src/core/render';
import { applyLineEdits } from '../src/core/sourceEdit';
import {
  alignTable, cellContent, cellText, cellTexts, deleteColumn, deleteRow, insertColumn, insertRow, isRefusal, parseTable, readTable, sameShape,
  setAlign, setCell, tableFromTokens, tableShape, type TableAlign, type TableEdit, type TableRefusal, type TableRow, type TableSource,
} from '../src/core/tableEdit';
import { exampleDocuments, fuzzCase, prng, type Random } from './fuzz/generate';

/**
 * Pipe tables for the Block Editor's grid (src/core/tableEdit.ts): the reading agrees with the renderer's for every
 * table block of the examples, the compatibility corpus and generated documents; escaped pipes, code spans, missing
 * outer pipes, alignment rows and ragged rows; and edits that touch only the cell, the row's line, or each line's
 * cell and pipe.
 *
 *   SMD_FUZZ_RUNS=2000 SMD_FUZZ_SEED=7 npm test     more generated cases, another seed
 */
const RUNS = Number(process.env.SMD_FUZZ_RUNS ?? 300);
const SEED = Number(process.env.SMD_FUZZ_SEED ?? 20261015);

const corpusDir = path.join(__dirname, 'compat', 'corpus');
const examplesDir = path.join(__dirname, '..', '..', 'examples');
const readDir = (dir: string) =>
  fs.readdirSync(dir).filter((f) => f.endsWith('.smd')).sort().map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
const options = (dir?: string): RenderOptions => ({
  today: '2026-10-15',
  readFile: (p) => {
    const file = dir && path.join(dir, p);
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  },
});

const documents = [
  ...readDir(examplesDir).map((d) => ({ ...d, name: `examples/${d.name}`, options: options(examplesDir) })),
  ...readDir(corpusDir).map((d) => ({ ...d, name: `corpus/${d.name}`, options: options(corpusDir) })),
];
const random = prng(SEED);
const seeds = exampleDocuments();
const generated = Array.from({ length: RUNS }, (_, i) => ({ name: `fuzz case ${i} (seed ${SEED})`, text: fuzzCase(random, seeds), options: options() }));
const LINE_BREAK = /\r?\n/;

/** Every table block of a document (top-level, or a container's child), with its lines. */
function tableBlocks(text: string, opts: RenderOptions): { seg: Segment; lines: string[] }[] {
  const lines = text.split(LINE_BREAK);
  const all = (segs: readonly Segment[]): Segment[] => segs.flatMap((s) => [s, ...all(s.children ?? [])]);
  return all(segmentSmd(text, opts)).filter((s) => s.kind === 'block' && s.type === 'table').map((seg) => ({ seg, lines: lines.slice(seg.start, seg.end) }));
}

const table = (lines: string[]): TableSource => {
  const t = readTable(lines);
  assert.ok(!isRefusal(t), isRefusal(t) ? t.refused : '');
  return t;
};
const done = (result: TableEdit | TableRefusal): TableEdit => {
  assert.ok(!isRefusal(result), isRefusal(result) ? result.refused : '');
  return result;
};
/** The lines after an edit, checked: they read as a table holding what the edit says. */
function edited(lines: string[], result: TableEdit | TableRefusal, loose = false): string[] {
  const edit = done(result);
  const after = applyLineEdits(lines, edit.edits);
  const back = readTable(after);
  assert.ok(!isRefusal(back), `${isRefusal(back) ? back.refused : ''}\n${after.join('\n')}`);
  assert.ok(sameShape(tableShape(back), edit.expect, loose), `as asked:\n${after.join('\n')}`);
  return after;
}
const texts = (lines: string[]) => cellTexts(table(lines), lines);

test('the reading agrees with the rendered table for every table block of every example, corpus and generated document', () => {
  let checked = 0;
  let readable = 0;
  for (const doc of [...documents, ...generated]) {
    const parsed = parseSmdTokens(doc.text, doc.options);
    const offset = parsed.env.lineOffset;
    for (const { seg, lines } of tableBlocks(doc.text, doc.options)) {
      const at = parsed.tokens.findIndex((t) => t.type === 'table_open' && t.map?.[0] === seg.start - offset && t.map[1] === seg.end - offset);
      const rendered = tableFromTokens(parsed.tokens, at);
      assert.ok(rendered, `${doc.name}, line ${seg.start + 1}: the table is rendered`);
      const where = `${doc.name}, lines ${seg.start + 1}-${seg.end}:\n${lines.join('\n')}`;
      const t = parseTable(lines);
      assert.ok(t, `${where}\nis read as a table`);
      assert.deepEqual(t.aligns, rendered.aligns, `${where}\nalignments`);
      assert.deepEqual(t.rows.map((r) => r.line + seg.start - offset), rendered.rows.map((r) => r.line), `${where}\nrow lines`);
      t.rows.forEach((row, i) => {
        // The renderer fills a short row with empty cells and drops the cells past the header's count.
        const cells = Array.from({ length: t.columns }, (_, c) => row.cells[c]?.content ?? '');
        assert.deepEqual(cells, rendered.rows[i].cells, `${where}\nrow ${i}`);
      });
      const read = readTable(lines);
      if (isRefusal(read)) {
        assert.match(read.refused, /cells and the header has|cuts an HTML tag/, `${where}\nrefused only for a ragged row or cut HTML: ${read.refused}`);
      } else {
        readable++;
      }
      checked++;
    }
  }
  assert.ok(checked > 40, `tables checked (${checked})`);
  assert.ok(readable > 25, `tables the grid can edit (${readable})`);
});

test('every cell of the examples and the corpus is placed between its pipes', () => {
  for (const doc of documents) {
    for (const { lines } of tableBlocks(doc.text, doc.options)) {
      const t = readTable(lines);
      if (isRefusal(t)) continue;
      for (const row of [...t.rows, t.delimiter]) {
        const line = lines[row.line];
        for (const cell of row.cells) {
          assert.ok(row.start <= cell.raw.start && cell.raw.start <= cell.text.start && cell.text.end <= cell.raw.end && cell.raw.end <= row.end, doc.name);
          assert.equal(line.slice(cell.raw.start, cell.text.start).trim(), '', doc.name);
          assert.equal(line.slice(cell.text.end, cell.raw.end).trim(), '', doc.name);
          if (row !== t.delimiter) assert.equal(cellContent(line.slice(cell.text.start, cell.text.end)), cell.content, doc.name);
        }
      }
    }
  }
});

test('escaped pipes and code spans follow GFM: `\\|` is a pipe in the cell, an unescaped pipe splits it, even in code', () => {
  const lines = ['| a | b |', '|---|---|', '| `x\\|y` | p \\| q |', '| `x|y` |'];
  const t = parseTable(lines)!;
  assert.deepEqual(t.rows[1].cells.map((c) => c.content), ['`x|y`', 'p | q']);
  assert.deepEqual(t.rows[2].cells.map((c) => c.content), ['`x', 'y`'], 'GFM: the pipe in the code span splits the cell');
  assert.deepEqual(texts(lines.slice(0, 3)), [['a', 'b'], ['`x\\|y`', 'p \\| q']], 'the grid shows the cells as written');
  // As markdown-it reads it: a pipe after any backslash is escaped, and only that backslash is dropped.
  assert.deepEqual(parseTable(['| a |', '|---|', '| x\\\\|y |'])!.rows[1].cells.map((c) => c.content), ['x\\|y']);
  assert.deepEqual(parseTable(['| a |', '|---|', '| x \\|'])!.rows[1].cells.map((c) => c.content), ['x |'], 'an escaped pipe at the end is not the outer pipe');
  // Editing another cell keeps them as they are.
  assert.deepEqual(edited(lines.slice(0, 3), setCell(table(lines.slice(0, 3)), lines.slice(0, 3), 0, 0, 'A')), ['| A | b |', '|---|---|', '| `x\\|y` | p \\| q |']);
});

test('outer pipes are optional, row by row; alignment rows with and without them', () => {
  const bare = ['Name | Age', ':--- | ---:', 'Alice | 30'];
  const t = table(bare);
  assert.deepEqual(t.aligns, ['left', 'right']);
  assert.deepEqual([t.rows[0].lead, t.rows[0].trail, t.delimiter.lead, t.delimiter.trail], [false, false, false, false]);
  const mixed = table(['| a | b', '|:-:|-', 'x | y |  ']);
  assert.deepEqual(mixed.aligns, ['center', 'none']);
  assert.deepEqual(mixed.rows.map((r) => [r.lead, r.trail]), [[true, false], [false, true]]);
  assert.deepEqual(table(['  |a|b|', '  |-|-|  ', '  |1|2|']).rows[1].cells.map((c) => c.content), ['1', '2'], 'indented, compact');
});

test('readTable refuses ragged rows, a pipe cutting HTML, lines that are not all the table, and non-tables', () => {
  const refused = (lines: string[], allowHtml?: boolean) => {
    const r = readTable(lines, { allowHtml });
    return isRefusal(r) ? r.refused : undefined;
  };
  assert.match(refused(['| a | b |', '|---|---|', '| 1 |'])!, /Line 3 of the table has 1 cells and the header has 2/);
  assert.match(refused(['| a | b |', '|---|---|', '| 1 | 2 | 3 |'])!, /has 3 cells/);
  assert.match(refused(['| a | b |', '|---|---|', '| <span title="x | y">z</span> |'])!, /cuts an HTML tag/);
  assert.equal(refused(['| a | b |', '|---|---|', '| <span title="x | y">z</span> |'], false), undefined, 'raw HTML off: the cells are text');
  assert.equal(refused(['| a | b |', '|---|---|', '| <b>x</b> | <!-- c --> |']), undefined, 'whole tags are fine');
  assert.match(refused(['| a | b |', '|---|---|', '# x | y'])!, /reads differently/, 'a heading ends the table');
  assert.match(refused(['a | b', '--- ---'])!, /can't be read/);
  assert.match(refused(['| a |'])!, /can't be read/);
  assert.match(refused(['| a | b |', '|---|'])!, /can't be read/, 'header and delimiter differ');
});

test('setCell changes only the cell\'s text, keeps the padding, and escapes pipes', () => {
  const lines = ['| Name  | Age |', '| ----- | --: |', '| Alice | 30  |'];
  assert.deepEqual(edited(lines, setCell(table(lines), lines, 1, 0, '  Bob  ')), ['| Name  | Age |', '| ----- | --: |', '| Bob | 30  |']);
  assert.deepEqual(edited(lines, setCell(table(lines), lines, 1, 1, 'a|b')), ['| Name  | Age |', '| ----- | --: |', '| Alice | a\\|b  |']);
  assert.deepEqual(edited(lines, setCell(table(lines), lines, 1, 1, 'a\\|b')), ['| Name  | Age |', '| ----- | --: |', '| Alice | a\\|b  |'], 'already escaped');
  assert.deepEqual(edited(lines, setCell(table(lines), lines, 0, 1, '')), ['| Name  |  |', '| ----- | --: |', '| Alice | 30  |']);
  const empty = ['|a|  |', '|-|-|'];
  assert.deepEqual(edited(empty, setCell(table(empty), empty, 0, 1, 'x')), ['|a| x |', '|-|-|'], 'an empty cell gets its text after the first space');
  // A new row: what is typed takes the place of spaces, so the columns stay as wide as they were.
  const grown = edited(lines, insertRow(table(lines), lines, 2));
  assert.equal(edited(grown, setCell(table(grown), grown, 2, 0, 'Bob'))[3], '| Bob   |     |');
  assert.equal(edited(grown, setCell(table(grown), grown, 2, 1, 'Seventy'))[3], '|       | Seventy |', 'longer than the spaces: one space after it');
  assert.equal(cellText(' a | b \\| c '), 'a \\| b \\| c');
  assert.match((setCell(table(lines), lines, 1, 0, 'two\nlines') as TableRefusal).refused, /one line/);
  assert.match((setCell(table(lines), lines, 3, 0, 'x') as TableRefusal).refused, /no such cell/);
});

test('setCell: an empty first or last cell of a row without that outer pipe gets one', () => {
  const bare = ['Name | Age', '--- | ---', 'Alice | 30'];
  assert.deepEqual(edited(bare, setCell(table(bare), bare, 1, 0, '')), ['Name | Age', '--- | ---', '| | 30']);
  assert.deepEqual(edited(bare, setCell(table(bare), bare, 1, 1, '')), ['Name | Age', '--- | ---', 'Alice | |']);
  assert.deepEqual(edited(bare, setCell(table(bare), bare, 0, 0, '')), ['| | Age', '--- | ---', 'Alice | 30']);
  const one = ['a |', '---', 'x'];
  assert.deepEqual(edited(one, setCell(table(one), one, 1, 0, '')), ['a |', '---', '||']);
});

test('insertRow adds one line, shaped like its neighbour, with outer pipes; deleteRow removes one', () => {
  const lines = ['| Name  | Age |', '| ----- | --: |', '| Alice | 30  |'];
  assert.deepEqual(edited(lines, insertRow(table(lines), lines, 1)), ['| Name  | Age |', '| ----- | --: |', '|       |     |', '| Alice | 30  |']);
  assert.deepEqual(edited(lines, insertRow(table(lines), lines, 2)), [...lines, '|       |     |']);
  const head = ['a | b', '--|--'];
  assert.deepEqual(edited(head, insertRow(table(head), head, 1)), [...head, '|  |  |'], 'a table without body rows: like the header');
  assert.deepEqual(edited(lines, deleteRow(table(lines), 1)), lines.slice(0, 2));
  assert.match((insertRow(table(lines), lines, 0) as TableRefusal).refused, /above the header/);
  assert.match((deleteRow(table(lines), 0) as TableRefusal).refused, /header row can't be deleted/);
  assert.match((deleteRow(table(lines), 2) as TableRefusal).refused, /no such row/);
  assert.deepEqual(done(insertRow(table(lines), lines, 2)).focus, { row: 2, col: 0 });
});

test('insertColumn adds the cell and its pipe on every line, as wide as the delimiter next to it', () => {
  const lines = ['| Name  | Age |', '| ----- | --: |', '| Alice | 30  |'];
  assert.deepEqual(edited(lines, insertColumn(table(lines), lines, 0)), ['|       | Name  | Age |', '| ----- | ----- | --: |', '|       | Alice | 30  |']);
  assert.deepEqual(edited(lines, insertColumn(table(lines), lines, 1)), ['| Name  |     | Age |', '| ----- | --- | --: |', '| Alice |     | 30  |']);
  assert.deepEqual(edited(lines, insertColumn(table(lines), lines, 2)), ['| Name  | Age |     |', '| ----- | --: | --- |', '| Alice | 30  |     |']);
  const bare = ['Name | Age', '--- | ---', 'Alice | 30'];
  assert.deepEqual(edited(bare, insertColumn(table(bare), bare, 0)), ['|     | Name | Age', '--- | --- | ---', '|     | Alice | 30']);
  assert.deepEqual(edited(bare, insertColumn(table(bare), bare, 2)), ['Name | Age |     |', '--- | --- | ---', 'Alice | 30 |     |']);
  const compact = ['|a|b|', '|-|:-:|', '|1|2|'];
  assert.deepEqual(edited(compact, insertColumn(table(compact), compact, 1)), ['|a|   |b|', '|-|---|:-:|', '|1|   |2|']);
  assert.deepEqual(done(insertColumn(table(lines), lines, 1)).expect.aligns, ['none', 'none', 'right']);
});

test('deleteColumn removes the cell and one pipe on every line, keeping a pipe where the row needs it', () => {
  const lines = ['| Name  | Age | Role |', '| ----- | --: | ---- |', '| Alice | 30  | Dev  |'];
  assert.deepEqual(edited(lines, deleteColumn(table(lines), lines, 0)), ['| Age | Role |', '| --: | ---- |', '| 30  | Dev  |']);
  assert.deepEqual(edited(lines, deleteColumn(table(lines), lines, 1)), ['| Name  | Role |', '| ----- | ---- |', '| Alice | Dev  |']);
  assert.deepEqual(edited(lines, deleteColumn(table(lines), lines, 2)), ['| Name  | Age |', '| ----- | --: |', '| Alice | 30  |']);
  const bare = ['Name | Age | Role', '--- | --- | ---', 'Alice |  | Dev'];
  assert.deepEqual(edited(bare, deleteColumn(table(bare), bare, 0)), ['Age | Role', '--- | ---', '|  | Dev'], 'an empty cell becomes first: its pipe stays');
  assert.deepEqual(edited(bare, deleteColumn(table(bare), bare, 2)), ['Name | Age', '--- | ---', 'Alice |  |'], 'an empty cell becomes last: its pipe stays');
  const two = ['Name | Age', '--- | ---', 'Alice | 30'];
  assert.deepEqual(edited(two, deleteColumn(table(two), two, 1)), ['Name |', '---', 'Alice'], 'a header keeps a pipe');
  assert.deepEqual(edited(two, deleteColumn(table(two), two, 0)), ['| Age', '---', '30']);
  assert.match((deleteColumn(table(['| a |', '|---|']), ['| a |', '|---|'], 0) as TableRefusal).refused, /at least one column/);
});

test('setAlign changes only the delimiter cell, as wide as it was; alignTable is smd fmt\'s table formatting', () => {
  const lines = ['| Name  | Age |', '| ----- | --- |', '| Alice | 30  |'];
  const align = (col: number, a: TableAlign) => edited(lines, setAlign(table(lines), lines, col, a))[1];
  assert.equal(align(0, 'left'), '| :---- | --- |');
  assert.equal(align(0, 'center'), '| :---: | --- |');
  assert.equal(align(1, 'right'), '| ----- | --: |');
  assert.equal(align(1, 'none'), '| ----- | --- |');
  assert.equal(edited(['|a|', '|-|'], setAlign(table(['|a|', '|-|']), ['|a|', '|-|'], 0, 'center'))[1], '|:-:|', 'at least one dash');
  const messy = ['Name | Age', ':-- | --:', 'Alice Smith | 30', 'x \\| y | [x]{color=red .c}'];
  const aligned = edited(messy, alignTable(table(messy), messy), true);
  assert.deepEqual(aligned, formatSmd(messy.join('\n')).trimEnd().split('\n'));
  assert.equal(aligned[3], '| x \\| y      | [x]{.c color=red} |', 'attribute lists as smd fmt writes them');
  assert.equal(done(alignTable(table(aligned), aligned)).edits.length, 0, 'aligned already: nothing to change');
  const code = ['a | b', '--|--', '`x\\|y` | z'];
  assert.equal(done(alignTable(table(code), code)).edits.length, 0, 'a pipe in code: smd fmt leaves the table alone');
});

// ---------------------------------------------------------------------------
// Properties over every table the grid can edit
// ---------------------------------------------------------------------------

const CELL_TEXTS = ['', 'x', 'Two words', 'a|b', 'a\\|b', '`code`', '`a\\|b`', ':badge[Done]{color=green}', '**bold**', '漢字 😀', '  padded  ', '42%', '[t]{bg=blue}'];
const pick = <T>(r: Random, list: readonly T[]): T => list[Math.floor(r() * list.length)];

/**
 * `after` is `before` with one run of text inserted or removed somewhere in [lo, hi] of `before`: between the text of
 * the cells on either side of the column (where it lands in a run of spaces doesn't matter).
 */
function oneSplice(before: string, after: string, lo: number, hi: number): boolean {
  const longer = after.length > before.length ? after : before;
  const shorter = longer === after ? before : after;
  const size = longer.length - shorter.length;
  for (let at = lo; at + (longer === before ? size : 0) <= hi; at++) {
    if (longer.slice(0, at) + longer.slice(at + size) === shorter) return true;
  }
  return false;
}

/** The text of other cells of a row, which an edit of one cell or column must not touch. */
function otherTexts(line: string, row: TableRow, skip: number): string[] {
  return row.cells.filter((_, c) => c !== skip).map((c) => line.slice(c.text.start, c.text.end));
}

test('property: a cell edit changes only that cell\'s text; every other line and cell stays byte-identical', () => {
  const r = prng(SEED + 1);
  let checked = 0;
  for (const doc of [...documents, ...generated]) {
    for (const { lines } of tableBlocks(doc.text, doc.options)) {
      const t = readTable(lines);
      if (isRefusal(t)) continue;
      const row = Math.floor(r() * t.rows.length);
      const col = Math.floor(r() * t.columns);
      const text = pick(r, CELL_TEXTS);
      const after = edited(lines, setCell(t, lines, row, col, text));
      const cell = t.rows[row].cells[col];
      const line = t.rows[row].line;
      after.forEach((l, i) => i === line || assert.equal(l, lines[i], `${doc.name}: line ${i} untouched`));
      const before = lines[line];
      const next = after[line];
      // Everything before the cell's text and after it is as it was (an empty edge cell may add its outer pipes; text
      // written into an empty cell of spaces takes their place).
      assert.ok(next.startsWith(before.slice(0, cell.text.start)), doc.name);
      const filled = t.rows[row].cells[col].content === '' && cellText(text) !== '' && /^ {3,}$/.test(before.slice(cell.raw.start, cell.raw.end));
      assert.ok(next.endsWith(before.slice(filled ? cell.raw.end : cell.text.end)), doc.name);
      if (filled) continue;
      const added = next.length - (before.length - (cell.text.end - cell.text.start)) - cellText(text).length;
      const emptied = (before.slice(0, cell.text.start) + before.slice(cell.text.end)).replaceAll('|', '');
      assert.ok(added === 0 || (text.trim() === '' && added <= 2 && next.replaceAll('|', '') === emptied), `${doc.name}: ${JSON.stringify([before, next])}`);
      checked++;
    }
  }
  assert.ok(checked > 40, `cell edits checked (${checked})`);
});

test('property: a row edit inserts or removes exactly one line; nothing else changes', () => {
  const r = prng(SEED + 2);
  let checked = 0;
  for (const doc of [...documents, ...generated]) {
    for (const { lines } of tableBlocks(doc.text, doc.options)) {
      const t = readTable(lines);
      if (isRefusal(t)) continue;
      const insert = t.rows.length < 2 || r() < 0.5;
      const at = insert ? 1 + Math.floor(r() * t.rows.length) : 1 + Math.floor(r() * (t.rows.length - 1));
      const after = edited(lines, insert ? insertRow(t, lines, at) : deleteRow(t, at));
      const line = insert ? (t.rows[at]?.line ?? lines.length) : t.rows[at].line;
      if (insert) assert.deepEqual([...after.slice(0, line), ...after.slice(line + 1)], lines, doc.name);
      else assert.deepEqual(after, [...lines.slice(0, line), ...lines.slice(line + 1)], doc.name);
      checked++;
    }
  }
  assert.ok(checked > 40, `row edits checked (${checked})`);
});

test('property: a column edit changes, on each line, only the affected cell and its pipe; alignment only its delimiter cell', () => {
  const r = prng(SEED + 3);
  let checked = 0;
  for (const doc of [...documents, ...generated]) {
    for (const { lines } of tableBlocks(doc.text, doc.options)) {
      const t = readTable(lines);
      if (isRefusal(t)) continue;
      const kind = pick(r, ['insert', 'delete', 'align'] as const);
      const at = Math.floor(r() * (kind === 'insert' ? t.columns + 1 : t.columns));
      if (kind === 'delete' && t.columns === 1) continue;
      let result: TableEdit | TableRefusal;
      if (kind === 'insert') result = insertColumn(t, lines, at);
      else if (kind === 'delete') result = deleteColumn(t, lines, at);
      else result = setAlign(t, lines, at, pick(r, ['none', 'left', 'center', 'right'] as const));
      const after = edited(lines, result);
      assert.equal(after.length, lines.length, doc.name);
      for (const row of [...t.rows, t.delimiter]) {
        const before = lines[row.line];
        const next = after[row.line];
        if (kind === 'align') {
          const cell = row.cells[at].text;
          if (row !== t.delimiter) assert.equal(next, before, `${doc.name}: only the delimiter row`);
          else assert.equal(next.slice(0, cell.start) + next.slice(next.length - (before.length - cell.end)), before.slice(0, cell.start) + before.slice(cell.end), `${doc.name}: only the delimiter cell`);
          continue;
        }
        // The other cells' text is untouched, and the change lies between the texts of the cells on either side.
        const reread: TableSource = parseTable(after)!;
        const nextRow: TableRow = row === t.delimiter ? reread.delimiter : reread.rows[t.rows.indexOf(row)];
        const kept: string[] = otherTexts(next, nextRow, kind === 'insert' ? at : -1);
        assert.deepEqual(kept, otherTexts(before, row, kind === 'delete' ? at : -1), `${doc.name}: other cells as written`);
        const lo = row.cells[at - 1]?.text.end ?? 0;
        const hi = (kind === 'insert' ? row.cells[at] : row.cells[at + 1])?.text.start ?? before.length;
        assert.ok(oneSplice(before, next, lo, hi), `${doc.name}: line ${row.line + 1} changed only around column ${at + 1}: ${JSON.stringify([before, next])}`);
      }
      checked++;
    }
  }
  assert.ok(checked > 40, `column edits checked (${checked})`);
});
