import { tableRowLines } from './parse';
import type { Fix, Severity } from './validate';

type Push = (line: number, column: number, endColumn: number, severity: Severity, code: string, message: string, fix?: Fix) => void;

/** A `|` with no backslash before it: where GFM splits a table row into cells. */
const BARE_PIPE = /(?<!\\)\|/g;

/**
 * The code spans of a line as written, read as if it were not a table row: [start, end) columns, the backtick runs
 * included. A backslash escapes the character after it outside code; a run of backticks closes at the next run of
 * the same length.
 */
function codeSpansOf(line: string): Array<[start: number, end: number, ticks: number]> {
  const spans: Array<[number, number, number]> = [];
  let at = 0;
  while (at < line.length) {
    const next = nextCodeSpan(line, at);
    if (!next) break;
    spans.push(next);
    at = next[1];
  }
  return spans;
}

/** The first code span that starts at or after `from` (see codeSpansOf). */
function nextCodeSpan(line: string, from: number): [number, number, number] | undefined {
  let i = from;
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2;
    } else if (line[i] === '`') {
      const ticks = /^`+/.exec(line.slice(i))![0].length;
      const close = closingRun(line, i + ticks, ticks);
      if (close >= 0) return [i, close + ticks, ticks];
      i += ticks;
    } else {
      i++;
    }
  }
  return undefined;
}

/** The column of the next run of exactly `ticks` backticks from `from`, or -1. */
function closingRun(line: string, from: number, ticks: number): number {
  for (const m of line.slice(from).matchAll(/`+/g)) if (m[0].length === ticks) return from + m.index;
  return -1;
}

/**
 * `table/pipe-in-code`: a `|` inside a code span in a table row still splits the row into cells, as on GitHub, so
 * the code span never forms. The fix escapes each such `|` as `\|`, which the cell keeps as `|`.
 */
export function checkTablePipes(text: string, lines: string[], push: Push): void {
  if (!text.includes('`')) return;
  for (const row of tableRowLines(text)) {
    const line = lines[row] ?? '';
    for (const [start, end, ticks] of codeSpansOf(line)) {
      const inner = line.slice(start + ticks, end - ticks);
      if (inner.search(BARE_PIPE) < 0) continue;
      push(row, start, end, 'info', 'table/pipe-in-code', 'A `|` inside a code span still splits a table cell; write `\\|`', {
        line: row, column: start + ticks, endColumn: end - ticks, replacement: inner.replaceAll(BARE_PIPE, '\\|'), title: 'Escape the `|` as `\\|`',
      });
    }
  }
}
