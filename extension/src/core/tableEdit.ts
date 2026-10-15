import type MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';
import type { Span } from './attrEdit';
import { formatTable } from './format';
import { createMarkdownIt } from './render';
import type { LineEdit } from './sourceEdit';

/**
 * GFM pipe tables for the Block Editor's grid: a table block's lines read into rows of cells, each with its exact
 * place in its line, and edits that change only what they must. Rows are split as markdown-it's table rule splits
 * them (rules_block/table.mjs: a `|` is a cell boundary unless the character before it is a backslash, `\|` is a
 * pipe in the cell's text, a pipe at either end of a row is an outer pipe), so a pipe in a code span splits the
 * cell unless it is escaped, as GFM says. A table is only offered for editing when this reading and markdown-it's
 * own (the renderer's rules, on the same lines) agree on every row, cell, header and alignment, every row has the
 * header's number of cells, and no HTML tag is cut by a pipe; anything else is edited in the table's source.
 *
 * Each edit returns line edits against the table's lines and the table it should make, which the caller checks by
 * reading the table again after the edit. A cell edit changes only that cell's text on its line; a row edit
 * inserts or removes one line; a column edit changes, on each line, only the affected cell and its pipe. Nothing
 * is realigned except by alignTable, which is `smd fmt`'s table formatting. Browser-safe; not part of the npm API.
 */

export type TableAlign = 'none' | 'left' | 'center' | 'right';
export const TABLE_ALIGNS: readonly TableAlign[] = ['none', 'left', 'center', 'right'];

export interface TableCell {
  /** Between the cell's pipes, or between the row's edge and its first or last pipe. */
  raw: Span;
  /** The cell's text as written, without the whitespace around it; for an empty cell, where text would go. */
  text: Span;
  /** The cell's text as rendered: an escaped pipe `\|` is a `|`. */
  content: string;
}

export interface TableRow {
  /** Zero-based line within the table's lines. */
  line: number;
  /** The row's text, without the whitespace around it. */
  start: number;
  end: number;
  /** A pipe before the first cell. */
  lead: boolean;
  /** A pipe after the last cell. */
  trail: boolean;
  cells: TableCell[];
}

export interface TableSource {
  /** The header row, then the body rows (the delimiter row is not one of them). */
  rows: TableRow[];
  /** The delimiter row (`|---|:--:|`); its cells' text is the dashes and colons. */
  delimiter: TableRow;
  aligns: TableAlign[];
  /** The header's number of cells, which every row has. */
  columns: number;
}

/** Why a table, or an edit of it, is left to its source. */
export interface TableRefusal {
  refused: string;
}

/** What a table holds: every cell's text as rendered, and the alignments. */
export interface TableShape {
  cells: string[][];
  aligns: TableAlign[];
}

/** A cell, by row (0: the header; the delimiter row is not counted) and column. */
export interface TableCellRef {
  row: number;
  col: number;
}

export interface TableEdit {
  /** Against the table's lines: each replaces one line with one, inserts one line or removes one. */
  edits: LineEdit[];
  /** The table the edit makes. */
  expect: TableShape;
  /** The cell to focus afterwards. */
  focus: TableCellRef;
}

export const isRefusal = <T extends object>(value: T | TableRefusal): value is TableRefusal => 'refused' in value;
const refuse = (refused: string): TableRefusal => ({ refused });

const PIPE = '|';
const BACKSLASH = '\\';
const DELIMITER_CELL = /^:?-+:?$/;
const NO_SUCH_CELL = 'There is no such cell.';
const NO_SUCH_COLUMN = 'There is no such column.';
const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);
const NUL = '\0';

/** As renderSmd reads a line: a lone `\r` is a space, NUL is U+FFFD (markdown-it's normalize); lengths stay the same. */
const normalized = (line: string) => line.replaceAll('\r', ' ').replaceAll(NUL, '�');

/** A line without the whitespace around it, as markdown-it's getLine(…).trim() reads a row. */
function bounds(line: string): Span {
  let start = 0;
  while (start < line.length && isSpace(line[start])) start++;
  let end = line.length;
  while (end > start && isSpace(line[end - 1])) end--;
  return { start, end };
}

/** A cell's text inside its raw span; an empty cell's goes after the first space, so `|  |` becomes `| x |`. */
function textSpan(line: string, raw: Span): Span {
  let start = raw.start;
  while (start < raw.end && isSpace(line[start])) start++;
  let end = raw.end;
  while (end > start && isSpace(line[end - 1])) end--;
  if (start < end) return { start, end };
  const at = raw.end > raw.start ? raw.start + 1 : raw.start;
  return { start: at, end: at };
}

/** A cell's text as rendered: escapedSplit drops the backslash before an escaped pipe; then it is trimmed. */
export function cellContent(raw: string): string {
  return raw.replaceAll('\\|', PIPE).trim();
}

/** The spans between `pipes` in [start, end). */
function spansBetween(start: number, end: number, pipes: readonly number[]): Span[] {
  const edges = [start - 1, ...pipes, end];
  return edges.slice(1).map((edge, k) => ({ start: edges[k] + 1, end: edge }));
}

const cellOf = (line: string, raw: Span): TableCell => ({ raw, text: textSpan(line, raw), content: cellContent(line.slice(raw.start, raw.end)) });

/** A header or body row, as markdown-it's escapedSplit and the shift and pop after it read it. */
function splitRow(line: string, index: number): TableRow {
  const { start, end } = bounds(line);
  const pipes: number[] = [];
  for (let i = start; i < end; i++) {
    if (line[i] === PIPE && (i === start || line[i - 1] !== BACKSLASH)) pipes.push(i);
  }
  let raws = spansBetween(start, end, pipes);
  const lead = raws.length > 0 && raws[0].start === raws[0].end;
  if (lead) raws = raws.slice(1);
  const last = raws.at(-1);
  const trail = last !== undefined && last.start === last.end;
  if (trail) raws = raws.slice(0, -1);
  return { line: index, start, end, lead, trail, cells: raws.map((raw) => cellOf(line, raw)) };
}

function alignOf(text: string): TableAlign {
  if (text.endsWith(':')) return text.startsWith(':') ? 'center' : 'right';
  return text.startsWith(':') ? 'left' : 'none';
}

/** The delimiter row, as markdown-it reads it (every `|` splits; an empty column only at either end). */
function splitDelimiter(line: string, index: number): { row: TableRow; aligns: TableAlign[] } | undefined {
  const { start, end } = bounds(line);
  const pipes: number[] = [];
  for (let i = start; i < end; i++) if (line[i] === PIPE) pipes.push(i);
  const raws = spansBetween(start, end, pipes);
  const texts = raws.map((raw) => line.slice(raw.start, raw.end).trim());
  const last = raws.length - 1;
  if (texts.some((t, i) => t === '' && i !== 0 && i !== last)) return undefined;
  const lead = texts[0] === '';
  const trail = last > 0 && texts[last] === '';
  const kept = raws.filter((_, i) => !(i === 0 && lead) && !(i === last && trail));
  const cells = kept.map((raw) => cellOf(line, raw));
  if (!cells.length || !cells.every((c) => DELIMITER_CELL.test(c.content))) return undefined;
  return { row: { line: index, start, end, lead, trail, cells }, aligns: cells.map((c) => alignOf(c.content)) };
}

/**
 * A table's lines read as markdown-it's table rule reads them: the header, the delimiter row and the body rows,
 * each cell with its place. Undefined when the first two lines don't make a table. Rows may have any number of
 * cells here; readTable refuses those that don't have the header's.
 */
export function parseTable(lines: readonly string[]): TableSource | undefined {
  if (lines.length < 2) return undefined;
  const source = lines.map(normalized);
  const delimiter = splitDelimiter(source[1], 1);
  const header = splitRow(source[0], 0);
  if (!delimiter || !source[0].includes(PIPE) || header.cells.length !== delimiter.aligns.length) return undefined;
  const body = source.slice(2).map((line, i) => splitRow(line, i + 2));
  return { rows: [header, ...body], delimiter: delimiter.row, aligns: delimiter.aligns, columns: header.cells.length };
}

// ---------------------------------------------------------------------------
// The table as the renderer reads it
// ---------------------------------------------------------------------------

/** What markdown-it makes of a table: its lines, each row's line and cells' text, and the alignments. */
export interface RenderedTable {
  /** The line after the table. */
  end: number;
  rows: { line: number; cells: string[] }[];
  aligns: TableAlign[];
}

const parsers = new Map<boolean, MarkdownIt>();

function parser(allowHtml: boolean): MarkdownIt {
  let md = parsers.get(allowHtml);
  if (!md) {
    md = createMarkdownIt({ allowHtml });
    parsers.set(allowHtml, md);
  }
  return md;
}

function alignOfStyle(style: string | null): TableAlign {
  const align = style?.replace('text-align:', '');
  return align === 'left' || align === 'center' || align === 'right' ? align : 'none';
}

/** The table markdown-it's tokens hold, starting at `from` (a table_open); undefined when there is none. */
export function tableFromTokens(tokens: readonly Token[], from = 0): RenderedTable | undefined {
  const open = tokens[from];
  if (open?.type !== 'table_open' || !open.map) return undefined;
  const rows: RenderedTable['rows'] = [];
  const aligns: TableAlign[] = [];
  for (const t of tokens.slice(from + 1)) {
    if (t.type === 'table_close') return { end: open.map[1], rows, aligns };
    if (t.type === 'tr_open') rows.push({ line: t.map?.[0] ?? -1, cells: [] });
    else if (t.type === 'th_open') aligns.push(alignOfStyle(t.attrGet('style')));
    else if (t.type === 'inline') rows.at(-1)?.cells.push(t.content);
  }
  return undefined;
}

/** The table markdown-it (with the renderer's rules) makes of these lines, when they start with one. */
function renderedTable(lines: readonly string[], allowHtml: boolean): RenderedTable | undefined {
  const md = parser(allowHtml);
  const tokens: Token[] = [];
  md.block.parse(lines.map(normalized).join('\n'), md, {}, tokens);
  const table = tableFromTokens(tokens);
  return table && tokens[0].map?.[0] === 0 ? table : undefined;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The reading here and the renderer's agree: every line is the table, every row and cell, and the alignments. */
function agrees(table: TableSource, rendered: RenderedTable, lineCount: number): boolean {
  if (rendered.end !== lineCount || rendered.rows.length !== table.rows.length || !sameList(rendered.aligns, table.aligns)) return false;
  return table.rows.every((row, i) => rendered.rows[i].line === row.line && sameList(rendered.rows[i].cells, row.cells.map((c) => c.content)));
}

/** An HTML tag or comment that starts in a cell and is not closed there: a pipe cut it in two. */
function cutsHtml(content: string): boolean {
  const at = content.lastIndexOf('<');
  return at >= 0 && /[A-Za-z!?/]/.test(content[at + 1] ?? '') && !content.includes('>', at);
}

/**
 * A table block's lines (CRLF-free: split on line breaks) read for the grid, or why it can't be: they are not
 * one table, a row has more or fewer cells than the header, an HTML tag in a cell is cut by a pipe, or the
 * renderer reads them differently. `allowHtml` as the document is rendered.
 */
export function readTable(lines: readonly string[], options: { allowHtml?: boolean } = {}): TableSource | TableRefusal {
  const table = parseTable(lines);
  if (!table) return refuse('This table can\'t be read as a grid.');
  const ragged = table.rows.find((r) => r.cells.length !== table.columns);
  if (ragged) {
    return refuse(`Line ${ragged.line + 1} of the table has ${ragged.cells.length} cells and the header has ${table.columns}.`);
  }
  const allowHtml = options.allowHtml ?? true;
  if (allowHtml && table.rows.some((r) => r.cells.some((c) => cutsHtml(c.content)))) return refuse('A pipe cuts an HTML tag in a cell of this table.');
  const rendered = renderedTable(lines, allowHtml);
  if (!rendered || !agrees(table, rendered, lines.length)) return refuse('This table reads differently when it is rendered.');
  return table;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export function tableShape(table: TableSource): TableShape {
  return { cells: table.rows.map((r) => r.cells.map((c) => c.content)), aligns: [...table.aligns] };
}

/** `{…}` attribute lists as `{}`: Align table writes them as `smd fmt` does (order, quotes), which is no change. */
const withoutAttrs = (text: string) => text.replaceAll(/\{[^{}]*\}/g, '{}');

/** Two tables hold the same; `loose`: attribute lists in cells may be written differently. */
export function sameShape(a: TableShape, b: TableShape, loose = false): boolean {
  const text = loose ? withoutAttrs : (s: string) => s;
  return sameList(a.aligns, b.aligns) && a.cells.length === b.cells.length
    && a.cells.every((row, i) => sameList(row.map(text), b.cells[i].map(text)));
}

/** A cell's text as written into its line: trimmed, with every pipe that isn't escaped escaped, so it stays one cell. */
export function cellText(text: string): string {
  const trimmed = text.trim();
  let out = '';
  for (let i = 0; i < trimmed.length; i++) out += trimmed[i] === PIPE && trimmed[i - 1] !== BACKSLASH ? '\\|' : trimmed[i];
  return out;
}

/** The cells' text as written (escaped pipes as `\|`), header row first: what the grid shows. */
export function cellTexts(table: TableSource, lines: readonly string[]): string[][] {
  return table.rows.map((r) => r.cells.map((c) => lines[r.line].slice(c.text.start, c.text.end)));
}

const replaceLine = (line: number, text: string): LineEdit => ({ start: line, end: line + 1, lines: [text] });
const insertAt = (line: string, at: number, text: string) => line.slice(0, at) + text + line.slice(at);
const cutOut = (line: string, span: Span) => line.slice(0, span.start) + line.slice(span.end);
const shapeWith = (table: TableSource, change: (cells: string[][], aligns: TableAlign[]) => void): TableShape => {
  const shape = tableShape(table);
  change(shape.cells, shape.aligns);
  return shape;
};

/**
 * Write `text` into a cell: only the cell's text changes, between its pipes on its own line; the spaces around it
 * stay (text written into an empty cell of spaces takes their place, so the column keeps its width). A pipe in the
 * text is escaped. An empty first or last cell of a row without that outer pipe gets one, or the pipe next to it
 * would read as the outer pipe and the row would lose the cell.
 */
export function setCell(table: TableSource, lines: readonly string[], row: number, col: number, text: string): TableEdit | TableRefusal {
  const r = table.rows[row];
  const cell = r?.cells[col];
  if (!cell) return refuse(NO_SUCH_CELL);
  if (/[\r\n]/.test(text)) return refuse('A cell holds one line of text.');
  const value = cellText(text);
  const line = lines[r.line];
  const empty = value === '';
  const before = line.slice(0, cell.text.start) + (empty && col === 0 && !r.lead ? PIPE : '');
  let after = (empty && col === r.cells.length - 1 && !r.trail ? PIPE : '') + line.slice(cell.text.end);
  const raw = line.slice(cell.raw.start, cell.raw.end);
  if (!empty && cell.content === '' && raw.length > 2 && raw === ' '.repeat(raw.length)) {
    // An empty cell of spaces (a new row or column): the text takes the place of spaces, so the column keeps its width.
    after = ' '.repeat(Math.max(1, raw.length - 1 - value.length)) + line.slice(cell.raw.end);
  }
  return {
    edits: [replaceLine(r.line, before + value + after)],
    expect: shapeWith(table, (cells) => {
      cells[row][col] = cellContent(value);
    }),
    focus: { row, col },
  };
}

/**
 * A new empty row at `at` (1: the first body row; rows.length: after the last). Its cells take the width of the
 * cells of the row it goes before (or after, at the end), so the columns stay as aligned as they were, and it has
 * pipes at both ends: a row of empty cells without them would read as fewer cells.
 */
export function insertRow(table: TableSource, lines: readonly string[], at: number): TableEdit | TableRefusal {
  if (at === 0) return refuse('A row can\'t go above the header.');
  if (at < 0 || at > table.rows.length) return refuse('There is no such row.');
  const template = table.rows[at] ?? table.rows[at - 1];
  const indent = lines[template.line].slice(0, template.start);
  const text = `${indent}|${template.cells.map((c) => ' '.repeat(c.raw.end - c.raw.start)).join(PIPE)}|`;
  const line = at < table.rows.length ? table.rows[at].line : lines.length;
  return {
    edits: [{ start: line, end: line, lines: [text] }],
    expect: shapeWith(table, (cells) => {
      cells.splice(at, 0, Array.from({ length: table.columns }, () => ''));
    }),
    focus: { row: at, col: 0 },
  };
}

/** Remove body row `at` (1 and up): its one line. */
export function deleteRow(table: TableSource, at: number): TableEdit | TableRefusal {
  if (at === 0) return refuse('The header row can\'t be deleted.');
  if (at < 0 || at >= table.rows.length) return refuse('There is no such row.');
  const line = table.rows[at].line;
  return {
    edits: [{ start: line, end: line + 1, lines: [] }],
    expect: shapeWith(table, (cells) => {
      cells.splice(at, 1);
    }),
    focus: { row: Math.min(at, table.rows.length - 2), col: 0 },
  };
}

/** The rows in line order: header, delimiter, body. */
const allRows = (table: TableSource) => [table.rows[0], table.delimiter, ...table.rows.slice(1)];

/** The space a row puts inside its pipes: ' ' when any cell has some before its text. */
const padOf = (line: string, row: TableRow) => (row.cells.some((c) => isSpace(line[c.raw.start])) ? ' ' : '');

/**
 * A row's line with a cell inserted before cell `at` (at the end when `at` is the cell count): `filler` (spaces,
 * or dashes in the delimiter row: `solid`) inside the row's padding, and one pipe. An empty cell at an edge
 * without that outer pipe brings one, else it would not be a cell.
 */
function withCell(line: string, row: TableRow, at: number, filler: string, solid: boolean): string {
  const pad = padOf(line, row);
  const cell = `${pad}${filler}${pad}`;
  if (at < row.cells.length) {
    if (at > 0 || row.lead) return insertAt(line, row.cells[at].raw.start, `${cell}|`);
    return insertAt(line, row.start, solid ? `${filler}${pad}|${pad}` : `|${cell}|${pad}`);
  }
  if (row.trail) return insertAt(line, row.end, `${cell}|`);
  return insertAt(line, row.end, solid ? `${pad}|${pad}${filler}` : `${pad}|${cell}|`);
}

/**
 * A new empty column at `at` (0: first; columns: after the last), aligned as none. On every line only the new cell
 * and its pipe are added: its width is that of the delimiter cell next to it, its padding the row's.
 */
export function insertColumn(table: TableSource, lines: readonly string[], at: number): TableEdit | TableRefusal {
  if (at < 0 || at > table.columns) return refuse(NO_SUCH_COLUMN);
  const neighbour = table.delimiter.cells[Math.min(at, table.columns - 1)];
  const width = Math.max(1, neighbour.text.end - neighbour.text.start);
  const edits = allRows(table).map((row) => {
    const solid = row === table.delimiter;
    return replaceLine(row.line, withCell(lines[row.line], row, at, (solid ? '-' : ' ').repeat(width), solid));
  });
  return {
    edits,
    expect: shapeWith(table, (cells, aligns) => {
      cells.forEach((r) => r.splice(at, 0, ''));
      aligns.splice(at, 0, 'none');
    }),
    focus: { row: 0, col: at },
  };
}

/**
 * What to cut out of a row to remove cell `at`, best first: the cell and the pipe after it (or before it, for the
 * last cell). At an edge without its outer pipe, also the cell alone, its pipe kept as the outer pipe, for when
 * the row would otherwise lose a cell or its last pipe.
 */
function removals(row: TableRow, at: number): Span[] {
  const { cells } = row;
  const cell = cells[at];
  const last = cells.length - 1;
  if (at < last && (at > 0 || row.lead)) return [{ start: cell.raw.start, end: cells[at + 1].raw.start }];
  if (at === last && row.trail) return [{ start: cells[at - 1].raw.end, end: cell.raw.end }];
  const alone = { start: cell.raw.start, end: cell.raw.end };
  return at === 0 ? [{ start: cell.raw.start, end: cells[1].text.start }, alone] : [{ start: cells[at - 1].text.end, end: cell.raw.end }, alone];
}

type RowKind = 'header' | 'body' | 'delimiter';

/** A row's kind by its index in `rows` (-1: the delimiter row, which is not there). */
function rowKind(index: number): RowKind {
  if (index < 0) return 'delimiter';
  return index === 0 ? 'header' : 'body';
}

/** A header or body line reads as these cells (a header needs a pipe); a delimiter line as these alignments. */
function readsAs(line: string, kind: RowKind, expected: readonly string[]): boolean {
  const source = normalized(line);
  if (kind === 'delimiter') return sameList(splitDelimiter(source, 1)?.aligns ?? [], expected);
  if (kind === 'header' && !source.includes(PIPE)) return false;
  return sameList(splitRow(source, 0).cells.map((c) => c.content), expected);
}

/** Remove column `at`: on every line, only that cell and one pipe. */
export function deleteColumn(table: TableSource, lines: readonly string[], at: number): TableEdit | TableRefusal {
  if (at < 0 || at >= table.columns) return refuse(NO_SUCH_COLUMN);
  if (table.columns === 1) return refuse('A table needs at least one column.');
  const expect = shapeWith(table, (cells, aligns) => {
    cells.forEach((r) => r.splice(at, 1));
    aligns.splice(at, 1);
  });
  const edits: LineEdit[] = [];
  for (const row of allRows(table)) {
    const index = table.rows.indexOf(row);
    const kind = rowKind(index);
    const expected = kind === 'delimiter' ? expect.aligns : expect.cells[index];
    const next = removals(row, at).map((span) => cutOut(lines[row.line], span)).find((text) => readsAs(text, kind, expected));
    if (next === undefined) return refuse(`Column ${at + 1} can't be removed from line ${row.line + 1} without changing other cells.`);
    edits.push(replaceLine(row.line, next));
  }
  return { edits, expect, focus: { row: 0, col: Math.min(at, table.columns - 2) } };
}

/** Align column `col`: only its delimiter cell changes, to as many characters as it had (at least one dash). */
export function setAlign(table: TableSource, lines: readonly string[], col: number, align: TableAlign): TableEdit | TableRefusal {
  const cell = table.delimiter.cells[col];
  if (!cell) return refuse(NO_SUCH_COLUMN);
  const line = lines[table.delimiter.line];
  const left = align === 'left' || align === 'center' ? ':' : '';
  const right = align === 'right' || align === 'center' ? ':' : '';
  const dashes = '-'.repeat(Math.max(1, cell.text.end - cell.text.start - left.length - right.length));
  const next = line.slice(0, cell.text.start) + left + dashes + right + line.slice(cell.text.end);
  return {
    edits: [replaceLine(table.delimiter.line, next)],
    expect: shapeWith(table, (_cells, aligns) => {
      aligns[col] = align;
    }),
    focus: { row: 0, col },
  };
}

/**
 * Align the whole table as `smd fmt` does (formatTable): padded columns, outer pipes, dashes as wide as each
 * column, attribute lists in cells written canonically. Only lines that change are edited; none when it is aligned.
 */
export function alignTable(table: TableSource, lines: readonly string[]): TableEdit {
  const next = formatTable([...lines]);
  const edits = next.flatMap((text, i) => (text === lines[i] ? [] : [replaceLine(i, text)]));
  return { edits, expect: tableShape(table), focus: { row: 0, col: 0 } };
}
