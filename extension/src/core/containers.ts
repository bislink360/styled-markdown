import { Attrs, emptyAttrs, findAttrsEnd, parseAttrs } from './attrs';
import { CONTAINERS } from './spec';
import type { SpecVersion } from './specVersion';

/** A parsed container opening line: `:::name{attrs} Title text`. */
export interface ContainerInfo {
  name: string;
  attrs: Attrs;
  title: string;
  /** Set when `{...}` is present but malformed. */
  attrsError?: string;
}

/**
 * Whether the vocabulary defines a container name (spec §3.1). Any other name is an unknown container: it renders as
 * a box that keeps its title, and the validator warns (spec §3).
 */
export const isKnownContainer = (name: string): boolean => Object.hasOwn(CONTAINERS, name);

/** An unknown container's title, which it keeps when it degrades (spec §3); empty for known containers. */
export const unknownContainerTitle = (name: string, title: string): string => (isKnownContainer(name) ? '' : title);

export const CONTAINER_OPEN =/^(\s{0,3})(:{3,})\s*([a-zA-Z][\w-]*)(.*)$/;
export const CONTAINER_CLOSE = /^(\s{0,3})(:{3,})\s*$/;

/**
 * Which open container a closing fence with `colons` colons closes (spec §3): its index in `open`, the colon counts of
 * the open containers, outermost first; -1 when none is open. The containers after that index close with it.
 * - Spec v1: the innermost; colon counts are cosmetic.
 * - Spec v2 (proposal 3): the innermost opened with exactly as many colons, so the ones opened inside it close with it
 *   (they have no closing fence of their own); when none has as many, the innermost, as in v1 (`container/colons`).
 */
export function closedBy(open: readonly number[], colons: number, spec: SpecVersion): number {
  const same = spec === 2 ? open.lastIndexOf(colons) : -1;
  return same >= 0 ? same : open.length - 1;
}

/**
 * For the line scanners that keep a stack of open containers: take off the ones a closing fence with `colons` colons
 * closes (see closedBy), innermost first. The last one is the container the fence closes; any before it close with
 * it, without a closing fence of their own (spec v2 only). Empty when nothing is open.
 */
export function closeContainers<T>(stack: T[], colons: number, spec: SpecVersion, colonsOf: (open: T) => number): T[] {
  const at = closedBy(stack.map(colonsOf), colons, spec);
  return at < 0 ? [] : stack.splice(at).reverse();
}

/** The colon count of a closing fence line (see CONTAINER_CLOSE), or 0 for any other line. */
export const closerColons = (line: string): number => CONTAINER_CLOSE.exec(line)?.[2].length ?? 0;

/** The colon count of a container's opening line (see CONTAINER_OPEN), or 0 for any other line. */
export const openerColons = (line: string): number => CONTAINER_OPEN.exec(line)?.[2].length ?? 0;

/**
 * How a line opens `$$` display math (spec §4.4), given its text after its indentation (and after the `>` and list
 * markers of the blocks it is in): `line` for `$$…$$` on one line, `block` for math that a later line closes (see
 * closesDisplayMath), null when it opens none.
 * - Spec v1: any line starting with `$$`.
 * - Spec v2 (proposal 2): a line that is only `$$`, or `$$…$$` on one line.
 */
export function displayMathOpener(text: string, spec: SpecVersion): 'line' | 'block' | null {
  if (!text.startsWith('$$')) return null;
  const rest = text.slice(2);
  if (rest.trimEnd().endsWith('$$') && rest.trim().length > 2) return 'line';
  return spec === 1 || !rest.trim() ? 'block' : null;
}

/** Whether a line closes multi-line `$$` display math: v1, any line ending with `$$`; v2, a line that is only `$$`. */
export function closesDisplayMath(text: string, spec: SpecVersion): boolean {
  return spec === 1 ? text.trimEnd().endsWith('$$') : text.trim() === '$$';
}

/**
 * For the line scanners that pair container fences: the last line of the `$$` display math that line `i` opens, or
 * -1. As rendering reads it (mathBlock): a line that opens math (after up to three spaces, see displayMathOpener)
 * ends it on itself for `$$…$$`, else on the next line that closes it (closesDisplayMath); with no such line it opens
 * nothing. Math is opaque, as code is, so a `:::` line inside it neither opens nor closes a container.
 */
function displayMathEnd(lines: readonly string[], i: number, spec: SpecVersion): number {
  const open = /^ {0,3}\$\$/.exec(lines[i]);
  if (!open) return -1;
  const opener = displayMathOpener(lines[i].trimStart(), spec);
  if (opener !== 'block') return opener === 'line' ? i : -1;
  for (let l = i + 1; l < lines.length; l++) if (closesDisplayMath(lines[l], spec)) return l;
  return -1;
}

/**
 * A test for the lines of `$$` display math (see displayMathEnd), for a scan that asks about its lines in order and
 * skips code fences itself: true for a line that opens math and for the lines up to its closing line.
 */
export function displayMath(lines: readonly string[], spec: SpecVersion = 1): (line: number) => boolean {
  let end = -1;
  return (line) => {
    if (line <= end) return true;
    end = displayMathEnd(lines, line, spec);
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
