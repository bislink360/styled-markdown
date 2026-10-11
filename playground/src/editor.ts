/** Pure text helpers for the playground's `<textarea>` editor. */

export const INDENT = '  ';

export interface Edit {
  text: string;
  /** The selection after the edit. */
  start: number;
  end: number;
}

/** Offset of the start of the line holding `offset`. */
function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/** The offsets at which each line touched by [start, end) begins. */
function touchedLineStarts(text: string, start: number, end: number): number[] {
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const starts = [lineStart(text, start)];
  let next = text.indexOf('\n', starts[0]);
  while (next !== -1 && next < last) {
    starts.push(next + 1);
    next = text.indexOf('\n', next + 1);
  }
  return starts;
}

/** Tab: insert an indent at the caret, or indent every line of a multi-line selection. */
export function indent(text: string, start: number, end: number): Edit {
  if (!text.slice(start, end).includes('\n')) {
    return { text: text.slice(0, start) + INDENT + text.slice(end), start: start + INDENT.length, end: start + INDENT.length };
  }
  const starts = touchedLineStarts(text, start, end);
  let out = text;
  for (const at of [...starts].reverse()) out = out.slice(0, at) + INDENT + out.slice(at);
  return { text: out, start: start + INDENT.length, end: end + INDENT.length * starts.length };
}

/** Shift+Tab: remove up to one indent from every line the selection touches. */
export function outdent(text: string, start: number, end: number): Edit {
  const starts = touchedLineStarts(text, start, end);
  let out = text;
  let removedTotal = 0;
  let removedFirst = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    const at = starts[i];
    const removed = leadingIndent(out, at);
    out = out.slice(0, at) + out.slice(at + removed);
    removedTotal += removed;
    if (i === 0) removedFirst = removed;
  }
  const newStart = start - Math.min(removedFirst, start - starts[0]);
  return { text: out, start: newStart, end: Math.max(newStart, end - removedTotal) };
}

/** Length of the indent to remove at a line start: up to two spaces, or one tab. */
function leadingIndent(text: string, at: number): number {
  if (text[at] === '\t') return 1;
  let n = 0;
  while (n < INDENT.length && text[at + n] === ' ') n++;
  return n;
}

/** Offset of a zero-based line and column, clamped to the text. */
export function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 0; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  const end = text.indexOf('\n', offset);
  const lineEnd = end === -1 ? text.length : end;
  return Math.min(offset + Math.max(0, column), lineEnd);
}

/** The smallest replacement that turns `before` into `after`: replace [from, to) of `before` with `insert`. */
export function changedRange(before: string, after: string): { from: number; to: number; insert: string } {
  const max = Math.min(before.length, after.length);
  let from = 0;
  while (from < max && before[from] === after[from]) from++;
  let tail = 0;
  while (tail < max - from && before.at(-1 - tail) === after.at(-1 - tail)) tail++;
  return { from, to: before.length - tail, insert: after.slice(from, after.length - tail) };
}

/** "1\n2\n…" for the line-number gutter. */
export function lineNumbers(text: string): string {
  const count = text.split('\n').length;
  return Array.from({ length: count }, (_, i) => String(i + 1)).join('\n');
}
