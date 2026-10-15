import { CONTAINER_CLOSE, CONTAINER_OPEN } from './containers';

/**
 * Text edits for the block editor. Every edit is either the smallest splice between two texts or whole lines
 * inserted, removed or moved, so the lines around a block are never rewritten. Pure and browser-safe; not part of
 * the npm API.
 */

/** Replace [from, to) of a text with `insert` (offsets in UTF-16 code units). */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/** Replace lines [start, end) with `lines`: an insert when start === end, a removal when `lines` is empty. */
export interface LineEdit {
  start: number;
  end: number;
  lines: string[];
}

/** A block put into a document: the edit, and the line its first line lands on. */
export interface BlockInsert {
  edit: LineEdit;
  line: number;
}

/** A block moved: the edits (against the original lines, in document order) and the line it lands on. */
export interface BlockMove {
  edits: LineEdit[];
  line: number;
}

/** A line range [start, end), such as a segment of blocks.ts. */
export interface LineRange {
  start: number;
  end: number;
}

const LINE_BREAK = /\r?\n/;
const isBlank = (line: string | undefined) => line !== undefined && /^[ \t\r]*$/.test(line);
const isFence = (line: string) => CONTAINER_OPEN.test(line) || CONTAINER_CLOSE.test(line);
/** A line a new block may sit right next to: blank, a container fence, or the edge of the document. */
const isSeparator = (line: string | undefined) => line === undefined || isBlank(line) || isFence(line);

/** The lines of a text, split as everything else here splits them (a lone `\r` stays in its line). */
export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

const CRLF = '\r\n';
const LF = '\n';

/** The line ending a text uses, as formatSmd picks it. */
export function eolOf(text: string): typeof CRLF | typeof LF {
  return text.includes(CRLF) ? CRLF : LF;
}

/** The smallest replacement that turns `before` into `after`: replace [from, to) of `before` with `insert`. */
export function changedRange(before: string, after: string): TextEdit {
  const max = Math.min(before.length, after.length);
  let from = 0;
  while (from < max && before[from] === after[from]) from++;
  let tail = 0;
  while (tail < max - from && before.at(-1 - tail) === after.at(-1 - tail)) tail++;
  return { from, to: before.length - tail, insert: after.slice(from, after.length - tail) };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** True when an offset falls inside a surrogate pair or a `\r\n`, where an edit must not start or end. */
function splitsPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  return isHighSurrogate(text.charCodeAt(offset - 1)) || (text[offset - 1] === '\r' && text[offset] === '\n');
}

/**
 * The smallest splice (common prefix and suffix) from `oldText` to `newText`, or null when they are equal. It never
 * starts or ends inside a surrogate pair or a `\r\n`, so it can be applied to a document as it is.
 */
export function minimalEdit(oldText: string, newText: string): TextEdit | null {
  if (oldText === newText) return null;
  let { from, to } = changedRange(oldText, newText);
  if (splitsPair(oldText, from)) from--;
  if (splitsPair(oldText, to)) to++;
  const tail = oldText.length - to;
  return { from, to, insert: newText.slice(from, newText.length - tail) };
}

/** Apply a text edit. */
export function applyTextEdit(text: string, edit: TextEdit): string {
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

/** Apply line edits that don't overlap, all given against `lines`. */
export function applyLineEdits(lines: readonly string[], edits: readonly LineEdit[]): string[] {
  const out = [...lines];
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  ordered.forEach((e, i) => {
    const next = ordered[i - 1];
    if (e.start > e.end || (next && e.end > next.start)) throw new RangeError('Line edits overlap.');
    out.splice(e.start, e.end - e.start, ...e.lines);
  });
  return out;
}

/** The offsets where each line of a text starts, and where its content ends (before the line break). */
function lineBounds(text: string): { starts: number[]; ends: number[] } {
  const starts = [0];
  const ends: number[] = [];
  const re = /\r?\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    ends.push(m.index);
    starts.push(m.index + m[0].length);
  }
  ends.push(text.length);
  return { starts, ends };
}

/**
 * A line edit as a text edit on `text`, with `eol` (the text's own by default) after each new line. Removing the
 * last lines also removes the line break before them, so no line is left behind.
 */
export function lineEditToTextEdit(text: string, edit: LineEdit, eol: string = eolOf(text)): TextEdit {
  const { starts, ends } = lineBounds(text);
  const count = starts.length;
  if (edit.start > edit.end || edit.end > count) throw new RangeError(`Lines ${edit.start}-${edit.end} are outside the text (${count} lines).`);
  if (edit.end < count) {
    return { from: starts[edit.start], to: starts[edit.end], insert: edit.lines.map((l) => l + eol).join('') };
  }
  if (edit.start === 0) return { from: 0, to: text.length, insert: edit.lines.join(eol) };
  // Up to the end: the edit starts at the end of the line before, so the text keeps its last line break as it was.
  return { from: ends[edit.start - 1], to: text.length, insert: edit.lines.map((l) => eol + l).join('') };
}

/** Lines without the blank lines at either end. */
function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start])) start++;
  while (end > start && isBlank(lines[end - 1])) end--;
  return lines.slice(start, end);
}

/** Insert `block` before line `at`, with a blank line on each side where it would touch another block. */
function insertLines(lines: readonly string[], at: number, block: readonly string[]): BlockInsert {
  const line = Math.min(Math.max(0, at), lines.length);
  const lead = isSeparator(lines[line - 1]) ? [] : [''];
  const trail = isSeparator(lines[line]) ? [] : [''];
  return { edit: { start: line, end: line, lines: [...lead, ...block, ...trail] }, line: line + lead.length };
}

/**
 * Insert a snippet as a block of its own before line `atLine` (0 to lines.length). Only new lines are added: a
 * blank line goes on either side where the neighbour is text, none next to a blank line, a container fence or the
 * edge of the document. Blank lines around the snippet are dropped.
 */
export function insertBlock(lines: readonly string[], atLine: number, snippet: string): BlockInsert {
  return insertLines(lines, atLine, trimBlankEdges(splitLines(snippet)));
}

/**
 * Remove a block's lines and one blank line that separated it, without joining its neighbours: when text is on
 * both sides, a blank line takes the block's place.
 */
export function deleteBlock(lines: readonly string[], seg: LineRange): LineEdit {
  const { start, end } = seg;
  const before = lines[start - 1];
  const after = lines[end];
  if (isBlank(after) && isSeparator(before)) return { start, end: end + 1, lines: [] };
  if (isBlank(before) && isSeparator(after)) return { start: start - 1, end, lines: [] };
  if (!isSeparator(before) && !isSeparator(after)) return { start, end, lines: [''] };
  return { start, end, lines: [] };
}

/**
 * Move a block so it starts before line `toLine` of the original lines: deleteBlock and insertBlock as one set of
 * edits. Null when `toLine` is inside or at the edge of the block, where it already is.
 */
export function moveBlock(lines: readonly string[], seg: LineRange, toLine: number): BlockMove | null {
  if (toLine >= seg.start && toLine <= seg.end) return null;
  const removal = deleteBlock(lines, seg);
  const removed = removal.end - removal.start;
  const rest = applyLineEdits(lines, [removal]);
  const at = toLine <= removal.start ? toLine : toLine - removed + removal.lines.length;
  const { edit, line } = insertLines(rest, at, lines.slice(seg.start, seg.end));
  return { edits: inOriginal(removal, edit), line };
}

/** The removal and an insert made after it, as edits against the lines before both. */
function inOriginal(removal: LineEdit, insert: LineEdit): LineEdit[] {
  const offset = insert.start - removal.start;
  if (offset < 0) return [insert, removal];
  if (offset <= removal.lines.length) {
    const lines = [...removal.lines.slice(0, offset), ...insert.lines, ...removal.lines.slice(offset)];
    return [{ start: removal.start, end: removal.end, lines }];
  }
  const start = insert.start - removal.lines.length + (removal.end - removal.start);
  return [removal, { start, end: start, lines: insert.lines }];
}
