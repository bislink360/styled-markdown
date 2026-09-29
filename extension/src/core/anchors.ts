import { findLinks, splitTarget } from './links';
import { HEADING_ATTRS, renderSmd } from './render';

/** A heading's editable text on its line (without `#` markers, closing `#`s or `{…}` attributes). */
export interface HeadingRange {
  line: number;
  start: number;
  end: number;
  text: string;
  /** The anchor id links use: the slug, or the `{#id}` given explicitly. */
  slug: string;
}

/** The heading on a zero-based line, or undefined when the line is not a heading. */
export function headingAt(text: string, line: number): HeadingRange | undefined {
  const heading = renderSmd(text).headings.find((h) => h.line === line);
  if (!heading) return undefined;
  const raw = text.split(/\r?\n/)[line] ?? '';
  const attrs = HEADING_ATTRS.exec(raw);
  let body = attrs ? raw.slice(0, attrs.index) : raw.trimEnd();
  const atx = /^\s{0,3}#{1,6}(?:\s+|$)/.exec(body);
  const start = atx ? atx[0].length : raw.length - raw.trimStart().length;
  // An ATX heading may end with a closing sequence of #s.
  if (atx) body = body.replace(/(?:\s+#+)?\s*$/, '');
  const end = Math.max(start, body.length);
  return { line, start, end, text: raw.slice(start, end), slug: heading.slug };
}

/** Where a link's `#anchor` sits: zero-based line and columns of the text after `#`. */
export interface AnchorLink {
  line: number;
  column: number;
  endColumn: number;
  /** The anchor as written, which may be percent-encoded. */
  raw: string;
}

/**
 * Links in `text` that point at anchor `id` of a document. `isTarget(path)` says whether a link's path
 * (decoded, relative to `text`'s document; `''` for a same-document `#anchor`) is that document.
 */
export function linksToAnchor(text: string, id: string, isTarget: (path: string) => boolean): AnchorLink[] {
  const found: AnchorLink[] = [];
  for (const link of findLinks(text).links) {
    const hash = link.target.indexOf('#');
    if (hash < 0) continue;
    const parts = splitTarget(link.target);
    if (!parts || parts.anchor !== id || !isTarget(parts.path)) continue;
    found.push({ line: link.line, column: link.column + hash + 1, endColumn: link.column + link.target.length, raw: link.target.slice(hash + 1) });
  }
  return found;
}

/**
 * Rename the heading on `line` to `newText`. Returns the new line and every anchor that changes as a
 * result: the heading's own slug, and the numbered slugs of later headings with the same text.
 * Headings with an explicit `{#id}` keep their anchor, so they report no changes.
 */
export function renameHeading(text: string, line: number, newText: string): { lineText: string; changes: Array<{ from: string; to: string }> } | undefined {
  const heading = headingAt(text, line);
  if (!heading) return undefined;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const raw = lines[line];
  const lineText = raw.slice(0, heading.start) + newText.replace(/\r?\n/g, ' ') + raw.slice(heading.end);
  lines[line] = lineText;
  const before = renderSmd(text).headings;
  const after = renderSmd(lines.join(eol)).headings;
  const changes: Array<{ from: string; to: string }> = [];
  // A single-line edit keeps every heading on its line, so they pair up by line.
  const next = new Map(after.map((h) => [h.line, h.slug]));
  for (const h of before) {
    const to = next.get(h.line);
    if (to !== undefined && to !== h.slug) changes.push({ from: h.slug, to });
  }
  return { lineText, changes };
}

/** The replacement for an anchor as written: percent-encoded if the original was. */
export function encodeAnchor(raw: string, slug: string): string {
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep as written */ }
  return decoded === raw ? slug : encodeURIComponent(slug);
}
