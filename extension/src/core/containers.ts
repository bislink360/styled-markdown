import { Attrs, emptyAttrs, findAttrsEnd, parseAttrs } from './attrs';

/** A parsed container opening line: `:::name{attrs} Title text`. */
export interface ContainerInfo {
  name: string;
  attrs: Attrs;
  title: string;
  /** Set when `{...}` is present but malformed. */
  attrsError?: string;
}

export const CONTAINER_OPEN = /^(\s{0,3})(:{3,})\s*([a-zA-Z][\w-]*)(.*)$/;
export const CONTAINER_CLOSE = /^(\s{0,3})(:{3,})\s*$/;

/**
 * For the line scanners that pair container fences: the last line of the `$$` display math that line `i` opens, or
 * -1. As rendering reads it (mathBlock): a line starting with `$$` (after up to three spaces) opens math that ends
 * on itself for `$$…$$`, else on the next line ending with `$$`; with no such line it opens nothing. Math is opaque,
 * as code is, so a `:::` line inside it neither opens nor closes a container.
 */
function displayMathEnd(lines: readonly string[], i: number): number {
  const open = /^ {0,3}\$\$/.exec(lines[i]);
  if (!open) return -1;
  const rest = lines[i].slice(open[0].length);
  if (rest.trimEnd().endsWith('$$') && rest.trim().length > 2) return i;
  for (let l = i + 1; l < lines.length; l++) if (lines[l].trimEnd().endsWith('$$')) return l;
  return -1;
}

/**
 * A test for the lines of `$$` display math (see displayMathEnd), for a scan that asks about its lines in order and
 * skips code fences itself: true for a line that opens math and for the lines up to its closing line.
 */
export function displayMath(lines: readonly string[]): (line: number) => boolean {
  let end = -1;
  return (line) => {
    if (line <= end) return true;
    end = displayMathEnd(lines, line);
    return end >= 0;
  };
}

export function parseContainerInfo(info: string): ContainerInfo | null {
  const m = /^\s*([a-zA-Z][\w-]*)(.*)$/.exec(info);
  if (!m) return null;
  const name = m[1].toLowerCase();
  let rest = m[2];
  let attrs = emptyAttrs();
  let attrsError: string | undefined;
  if (rest.startsWith('{')) {
    const end = findAttrsEnd(rest, 0);
    if (end === -1) {
      attrsError = 'Attribute list is missing its closing "}".';
    } else {
      const parsed = parseAttrs(rest.slice(1, end));
      if (parsed) attrs = parsed; else attrsError = 'Malformed attribute list.';
      rest = rest.slice(end + 1);
    }
  }
  const title = (attrs.values.title ?? rest.trim()) || '';
  return { name, attrs, title, attrsError };
}
