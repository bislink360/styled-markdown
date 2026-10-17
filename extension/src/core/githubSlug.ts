import MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';

/**
 * The ids GitHub gives headings, for links written GitHub's way (`#foo_bar`) and for `smd to-md` output.
 * Internal to core: Styled Markdown's own ids come from `slugify` (sections.ts) and do not change.
 *
 * GitHub (and github-slugger, which reimplements it) lower-cases the heading's text, removes every
 * character that is not a letter, mark, decimal digit, connector punctuation (`_`), space or hyphen,
 * and turns each space into a hyphen. Nothing is trimmed or collapsed, so `A -- B` is `a----b`.
 */
const NOT_KEPT = /[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc} -]/gu;

/** The id GitHub gives one heading with this text, before duplicates are numbered. */
export function githubSlug(text: string): string {
  return text.toLowerCase().replaceAll(NOT_KEPT, '').replaceAll(' ', '-');
}

/**
 * GitHub's ids for a page's headings, in order: the first use of an id as is, later ones `-1`, `-2`…,
 * skipping any that an earlier heading already has (so `A`, `A`, `A-1` are `a`, `a-1`, `a-1-1`).
 */
export function githubIds(texts: readonly string[]): string[] {
  const occurrences = new Map<string, number>();
  return texts.map((text) => {
    const base = githubSlug(text);
    let id = base;
    while (occurrences.has(id)) {
      const n = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, n);
      id = `${base}-${n}`;
    }
    occurrences.set(id, 0);
    return id;
  });
}

/** A heading of plain Markdown as GitHub reads it. */
export interface MarkdownHeading {
  /** Zero-based line where the heading starts. */
  line: number;
  /** Its text content: text and code spans, without markup, raw HTML or images. */
  text: string;
  /** An ATX (`## Title`) heading, rather than a setext one (a line underlined with `===` or `---`). */
  atx: boolean;
}

let blocks: MarkdownIt | undefined;

/**
 * Plain Markdown parsed into blocks only: the core `inline` rule is off, so paragraphs, lists and tables are not
 * inline-parsed. Headings are, one by one, with the same env, so reference links in them still resolve.
 */
function blockParser(): MarkdownIt {
  blocks ??= new MarkdownIt({ html: true }).disable('inline');
  return blocks;
}

/** The headings of a plain (GitHub-flavored) Markdown text, in order. */
export function markdownHeadings(markdown: string): MarkdownHeading[] {
  const md = blockParser();
  const env = {};
  const tokens = md.parse(markdown, env);
  const headings: MarkdownHeading[] = [];
  tokens.forEach((t, i) => {
    if (t.type === 'heading_open') headings.push({ line: t.map?.[0] ?? 0, text: headingText(md, tokens[i + 1], env), atx: t.markup.startsWith('#') });
  });
  return headings;
}

function headingText(md: MarkdownIt, inline: Token | undefined, env: object): string {
  if (!inline) return '';
  const children: Token[] = [];
  md.inline.parse(inline.content, md, env, children);
  // `text_special` (an escaped character) is text: the core `text_join` rule, which runs after `inline`, makes it so.
  return children.map((c) => (c.type === 'text' || c.type === 'text_special' || c.type === 'code_inline' ? c.content : '')).join('');
}
