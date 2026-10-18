import { isFlagItem, lexAttrItems, parseAttrs, type Attrs } from './attrs';
import type { Heading } from './render';
import type { SpecVersion } from './specVersion';

/** Heading ids and sections: a heading up to the next heading of the same or a higher level. */

/** `## Title {#custom-id .class agent=skip}` — trailing attribute list on a heading. */
export const HEADING_ATTRS = /\s+\{([^{}]*)\}\s*$/; // NOSONAR(typescript:S5852): matched against one heading line

/** A heading's trailing attribute list: the HEADING_ATTRS match (`index` is where its spaces start) and what it says. */
export interface HeadingAttrList {
  match: RegExpExecArray;
  attrs: Attrs;
}

/**
 * The attribute list ending a heading's text, as rendering reads it with the rules of `spec`: a trailing `{…}` that
 * parses. In spec v2 it must also have items, each `#id`, `.class` or `key=value` (RFC proposal 5): an empty `{}` or
 * a list with a bare word (`{ok}`) is heading text. Undefined when the heading has none.
 */
export function headingAttrList(text: string, spec: SpecVersion = 1): HeadingAttrList | undefined {
  const match = HEADING_ATTRS.exec(text);
  const attrs = match ? parseAttrs(match[1], spec) : null;
  if (!match || !attrs || (spec >= 2 && !recognisableItems(match[1], spec))) return undefined;
  return { match, attrs };
}

/** A list that has items, none of them a bare word. */
function recognisableItems(src: string, spec: SpecVersion): boolean {
  const items = lexAttrItems(src, spec);
  return !!items?.length && !items.some(({ match }) => isFlagItem(match));
}

/**
 * A heading's text without its trailing attribute list, for the line-based readers. In spec v1 any trailing `{…}` is
 * removed, as these readers always did, whether or not it parses; in spec v2 only a list that rendering reads as
 * attributes (headingAttrList), so the rest stays heading text, as it renders.
 */
export function withoutHeadingAttrs(text: string, spec: SpecVersion = 1): string {
  if (spec < 2) return text.replace(HEADING_ATTRS, '');
  const list = headingAttrList(text, spec);
  return list ? text.slice(0, list.match.index) : text;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replaceAll(/<[^>]+>/g, '') // NOSONAR(typescript:S5852): one heading's text; another pattern would change slugs
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, '')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-');
}

export interface Section { heading: Heading; start: number; end: number }

/** Every section, with zero-based inclusive line ranges; subsections are inside their parent's range. */
export function sectionsOf(headings: Heading[], lineCount: number): Section[] {
  return headings.map((h, i) => {
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    return { heading: h, start: h.line, end: (next ? next.line : lineCount) - 1 };
  });
}

const normalizeQuery = (query: string) => query.trim().toLowerCase().replace(/^#+\s*/, '');

const sameId = (h: Heading, q: string) => h.slug === slugify(q) || h.slug === q;

/** Does a heading match a `--section` query: its id, or its text (case-insensitive, a part is enough)? */
export function matchesHeading(h: Heading, query: string): boolean {
  const q = normalizeQuery(query);
  return sameId(h, q) || h.text.toLowerCase().includes(q);
}

/** Does a heading match a query exactly, as spec v2's `:::include{section}` matches: its id, or its whole text in any case? */
export function matchesExactly(h: Heading, query: string): boolean {
  const q = normalizeQuery(query);
  return sameId(h, q) || h.text.trim().toLowerCase() === q;
}

/**
 * The one section an `:::include{section}` names (SPEC §3.4): the first whose id it is, else the first it matches. Spec
 * v1 matches a part of a heading's text too ({@link matchesHeading}); spec v2 only an id or the whole text in any case
 * ({@link matchesExactly}). The including document's version decides.
 */
export function findSection(sections: Section[], query: string, spec: SpecVersion = 1): Section | undefined {
  const q = normalizeQuery(query);
  const matches = spec === 2 ? matchesExactly : matchesHeading;
  const hits = sections.filter((s) => matches(s.heading, q));
  return hits.find((s) => sameId(s.heading, q)) ?? hits[0];
}
