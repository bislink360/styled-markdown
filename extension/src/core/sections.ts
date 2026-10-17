import type { Heading } from './render';
import type { SpecVersion } from './specVersion';

/** Heading ids and sections: a heading up to the next heading of the same or a higher level. */

/** `## Title {#custom-id .class agent=skip}` — trailing attribute list on a heading. */
export const HEADING_ATTRS = /\s+\{([^{}]*)\}\s*$/; // NOSONAR(typescript:S5852): matched against one heading line

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
