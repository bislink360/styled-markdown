import type MarkdownIt from 'markdown-it';
import type { StateCore, Token } from 'markdown-it';
import { parseFrontMatter } from './frontmatter';
import {
  includeRequest, innerScope, loadInclude, rebaseFenceFile, rebaseUrl, rootScope, shiftedLevel, type IncludeScope, type LoadedInclude,
} from './include';
import {
  annotateTokens, headingIds, includedFrom, markIncluded, type ContainerMeta, type IncludedFrom,
} from './markdownItRules';
import type { SmdContext } from './markdownItSetup';
import type { Env, Heading } from './render';

/**
 * `:::include` in markdown-it. Right after block parsing, the body of each include is replaced by the block
 * tokens of the included lines, so inline syntax, heading ids, tasks, other plugins and nested includes work as if
 * the text were written there. Spliced tokens keep the include's own source line (for scroll sync), headings
 * move by `level`, and code embeds, links and images keep pointing where they did from their own document.
 * When nothing can be included, the body stays: it is the fallback, under a note (see includeOpen).
 */

/** The env of a parse that only looks for headings in a file to include; it includes nothing itself. */
interface ScanEnv { smdIncludeScan: true }

const isScan = (env: unknown) => (env as Partial<ScanEnv> | undefined)?.smdIncludeScan === true;

export function expandIncludes(state: StateCore, ctx: SmdContext): void {
  if (isScan(state.env)) return;
  // One scope (and so one budget) per document, made when it first includes.
  let root: IncludeScope | undefined;
  const rootOf = () => (root ??= rootScope((state.env as Env | undefined)?.source ?? state.src));
  // Spliced tokens are visited too, so nested includes expand in turn.
  for (let i = 0; i < state.tokens.length; i++) {
    const t = state.tokens[i];
    if (t.type === 'container_smd_open' && (t.meta as ContainerMeta | null)?.name === 'include') expandInclude(state, i, rootOf, ctx);
  }
}

function expandInclude(state: StateCore, i: number, root: () => IncludeScope, ctx: SmdContext): void {
  const open = state.tokens[i];
  const meta = open.meta as ContainerMeta;
  const request = includeRequest(meta.attrs.values);
  if (!request) return;
  const scope = includedFrom(open)?.scope ?? root();
  const read = ctx.options(state.env).readFile;
  const result = loadInclude(request, scope, {
    readFile: read && ((path) => read(path, state.env)),
    headings: (text) => headingsOf(state.md, text),
  });
  meta.include = result;
  if (!result.ok) return;
  const tokens = includedTokens(state, open, innerScope(scope, result.include), result.include);
  state.tokens.splice(i + 1, closeOf(state.tokens, i) - i - 1, ...tokens);
}

/** The index of the token closing the container opened at `open`. */
function closeOf(tokens: Token[], open: number): number {
  let depth = 0;
  for (let j = open + 1; j < tokens.length; j++) {
    if (tokens[j].type === 'container_smd_open') depth++;
    else if (tokens[j].type === 'container_smd_close' && depth-- === 0) return j;
  }
  return tokens.length;
}

/** Block tokens of the included lines, adopted by the including document. */
function includedTokens(state: StateCore, open: Token, scope: IncludeScope, include: LoadedInclude): Token[] {
  const src = include.lines.slice(include.start, include.end + 1).join('\n');
  const tokens: Token[] = [];
  state.md.block.parse(src, state.md, state.env, tokens);
  annotateTokens(tokens, src);
  const from: IncludedFrom = { scope, slugs: new Map(), renames: new Map() };
  const line = open.map?.[0] ?? 0;
  for (const t of tokens) adopt(t, from, open.level + 1, line);
  return tokens;
}

/** Make a spliced token part of the including document: nested in the include, on its source line. */
function adopt(t: Token, from: IncludedFrom, level: number, line: number): void {
  markIncluded(t, from);
  t.level += level;
  if (t.map) t.map = [line, line + 1];
  if (t.type === 'heading_open' || t.type === 'heading_close') t.tag = shiftedTag(t.tag, from.scope.shift);
  if (t.type === 'fence') t.info = rebaseFenceFile(t.info, from.scope.dir);
}

const shiftedTag = (tag: string, shift: number) => (shift ? `h${shiftedLevel(Number(tag.slice(1)), shift)}` : tag);

/** The headings of a whole file, with the ids headingIds gives them, to find a section in. */
function headingsOf(md: MarkdownIt, text: string): Heading[] {
  const fm = parseFrontMatter(text);
  const scan: ScanEnv = { smdIncludeScan: true };
  const tokens = md.parse(fm.body, scan);
  // A host may leave heading ids off, so they are given here (ids the parse gave are kept).
  const env = { headings: [] as Heading[], slugs: new Map<string, number>(), lineOffset: fm.bodyStartLine };
  headingIds({ tokens, env } as unknown as StateCore);
  return env.headings;
}

/** Relative links and images in included text point where they did from their own document; anchors follow renamed ids. */
export function includedLinks(state: StateCore): void {
  for (const t of state.tokens) {
    const from = t.type === 'inline' ? includedFrom(t) : undefined;
    if (from) t.children?.forEach((c) => rebaseLink(c, from));
  }
}

function rebaseLink(c: Token, from: IncludedFrom): void {
  const key = c.type === 'image' ? 'src' : 'href';
  const url = c.type === 'link_open' || c.type === 'image' ? c.attrGet(key) : null;
  if (url === null) return;
  c.attrSet(key, url.startsWith('#') ? `#${renamedAnchor(url.slice(1), from)}` : rebaseUrl(url, from.scope.dir));
}

function renamedAnchor(anchor: string, from: IncludedFrom): string {
  let id = anchor;
  try { id = decodeURIComponent(anchor); } catch { /* keep it as written */ }
  return from.renames.get(id) ?? anchor;
}
