import { agentViewRanges } from './agentView';
import { parseFrontMatter } from './frontmatter';
import type { Heading } from './render';

/**
 * The search index of a static site (`smd build`): per page its title, summary and an excerpt of each section,
 * as plain text from the agent view (human-only content included). The site's search box loads it as a script,
 * so search also works when the site is opened from disk (file://), where pages can't fetch JSON.
 */

/** Plain-text characters kept per section, so the index stays small on large sites. */
export const EXCERPT_MAX = 280;

export interface SearchSection {
  /** Heading text. */
  h: string;
  /** Heading id on the page. */
  a: string;
  /** Excerpt of the section's own text (up to the next heading). */
  x: string;
}

export interface SearchDoc {
  /** Title. */
  t: string;
  /** Page path relative to the site root, e.g. `guide/setup.html`. */
  u: string;
  /** Front matter summary, or empty. */
  s: string;
  /** Excerpt of the text before the first heading. */
  x: string;
  h: SearchSection[];
}

export interface SearchIndex {
  /** Format version of the index. */
  v: 1;
  docs: SearchDoc[];
}

export interface SearchPage {
  output: string;
  title: string;
  text: string;
  headings: Heading[];
}

/** One page's entry: the intro and each section cut from the agent view of the whole document. */
export function searchDoc(page: SearchPage, options: { today?: string } = {}): SearchDoc {
  const fm = parseFrontMatter(page.text);
  const view = agentViewRanges(page.text, { includeHuman: true, lineRefs: false, today: options.today });
  const lastLine = page.text.split(/\r?\n/).length - 1;
  const range = (start: number, end: number) => (start <= end ? excerpt(view(start, end)) : '');
  const headings = page.headings;
  const first = headings[0]?.line ?? lastLine + 1;
  return {
    t: page.title,
    u: page.output,
    s: typeof fm.data.summary === 'string' ? fm.data.summary.trim() : '',
    x: range(fm.bodyStartLine, first - 1),
    h: headings.map((h, i) => ({ h: h.text, a: h.slug, x: range(h.line + 1, (headings[i + 1]?.line ?? lastLine + 1) - 1) })),
  };
}

/** Agent-view text as a short plain excerpt: tags, Markdown marks and extra whitespace removed. */
export function excerpt(text: string, max = EXCERPT_MAX): string {
  const plain = text
    .replace(/<\/?[a-z][^<>\n]*>/gi, ' ')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/[`*]+/g, '')
    .replace(/[|#]+/g, ' ')
    // List bullets and table rules: dashes and colons on their own.
    .replace(/(^|\s)[-:]+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.lastIndexOf(' ', max);
  return plain.slice(0, cut > max / 2 ? cut : max) + '…';
}

/** The index as a script that sets `window.SMD_SEARCH_INDEX`; `<` is escaped so no text can close a script tag. */
export function searchIndexScript(index: SearchIndex): string {
  const json = JSON.stringify(index).replace(/</g, '\\u003c');
  return `window.SMD_SEARCH_INDEX=${json};\n`;
}
