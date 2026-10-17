import { anchorLine } from './links';
import { parseSmd } from './parse';
import type { Heading } from './render';
import { githubHeadingIds } from './toMarkdown';

/**
 * GitHub ids as aliases of heading ids. A heading's GitHub id is the id GitHub gives it in the document's
 * `smd to-md` output (githubHeadingIds). Where that differs from its own id (`## foo_bar` is `#foobar` here and
 * `#foo_bar` on GitHub), links written with the GitHub id still name the heading. The rendered HTML has only
 * the heading's own id, so such links work on GitHub but not in the preview.
 */

let cached: { text: string; aliases: Map<string, Heading> } | undefined;

/**
 * The document's headings by their GitHub ids, for the headings whose GitHub id differs from their own. An id
 * that something in the document has itself (a heading, a `{#id}` block, an HTML id) is never an alias.
 */
export function githubAliases(text: string): Map<string, Heading> {
  if (cached?.text === text) return cached.aliases;
  const { headings, ids } = parseSmd(text);
  const github = githubHeadingIds(text);
  const aliases = new Map<string, Heading>();
  headings.forEach((h, i) => {
    const id = github[i];
    if (id !== undefined && id !== h.slug && !ids.has(id) && !aliases.has(id)) aliases.set(id, h);
  });
  cached = { text, aliases };
  return aliases;
}

/** The heading whose GitHub id `id` is, when nothing in the document has that id itself. */
export function aliasedHeading(text: string, id: string): Heading | undefined {
  return parseSmd(text).ids.has(id) ? undefined : githubAliases(text).get(id);
}

/** The GitHub id of the heading on a zero-based line, when it is an alias (it differs from the heading's own id). */
export function headingAlias(text: string, line: number): string | undefined {
  for (const [id, h] of githubAliases(text)) if (h.line === line) return id;
  return undefined;
}

/** The zero-based line an anchor points at: the heading or element with that id, else the heading it is an alias of. */
export function anchorOrAliasLine(text: string, id: string): number | undefined {
  return anchorLine(text, id) ?? aliasedHeading(text, id)?.line;
}

/**
 * Every anchor that names the same heading as `id`: the heading's own id first, then its GitHub id when that is an
 * alias. Just `[id]` when `id` names no heading.
 */
export function anchorNames(text: string, id: string): string[] {
  const heading = parseSmd(text).headings.find((h) => h.slug === id) ?? aliasedHeading(text, id);
  if (!heading) return [id];
  const alias = headingAlias(text, heading.line);
  return alias ? [heading.slug, alias] : [heading.slug];
}
