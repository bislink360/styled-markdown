import type { StateCore, Token } from 'markdown-it';
import { escapeHtml } from './attrs';
import { isAbbreviation, parseEntry, termId, termKey, termMatcher, type TermMatcher } from './glossary';
import type { ContainerMeta } from './markdownItRules';

/**
 * The glossary pass of the markdown-it plugin. The list directly inside a `:::glossary` becomes a `<dl>`
 * (`<dt id="term-…"><dfn>Term</dfn></dt><dd>definition</dd>`) when every item is `**Term**: definition`.
 * Then the first use of each term in every section (text between headings) links to its definition, with
 * the definition as a tooltip: `<a class="smd-term" href="#term-api"><abbr title="…">API</abbr></a>`
 * for abbreviations, `<a class="smd-term" href="#term-…" title="…">term</a>` for other terms. Headings,
 * glossaries, links, code, URLs and attribute values never change. A document without a glossary
 * keeps its tokens as they are.
 */

/** A rendered entry: its term, the id of its `<dt>` and the plain text of its definition. */
interface Entry {
  term: string;
  id: string;
  title: string;
}

export function glossaryTerms(state: StateCore): void {
  if (state.inlineMode || !state.tokens.some(isGlossaryOpen)) return;
  const entries: Entry[] = [];
  state.tokens = convertGlossaries(state, entries);
  const matcher = termMatcher(entries);
  if (matcher) markTerms(state, matcher);
}

const isGlossaryOpen = (t: Token) => t.type === 'container_smd_open' && (t.meta as ContainerMeta | null)?.name === 'glossary';
const isGlossaryClose = (t: Token) => t.type === 'container_smd_close' && (t.meta as ContainerMeta | null)?.name === 'glossary';

// ---------------------------------------------------------------------------
// The glossary block: <ul> → <dl>
// ---------------------------------------------------------------------------

/** The tokens with each bullet list directly inside a glossary turned into a definition list, when it is one. */
function convertGlossaries(state: StateCore, entries: Entry[]): Token[] {
  const tokens = state.tokens;
  const out: Token[] = [];
  const containers: Token[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'bullet_list_open' && directlyInGlossary(containers, t)) {
      const end = closingIndex(tokens, i);
      const list = convertList(state, tokens.slice(i, end + 1), entries, ids);
      if (list) {
        for (const token of list) out.push(token);
        i = end;
        continue;
      }
    }
    if (t.type === 'container_smd_open') containers.push(t);
    else if (t.type === 'container_smd_close') containers.pop();
    out.push(t);
  }
  return out;
}

function directlyInGlossary(containers: Token[], token: Token): boolean {
  const parent = containers.at(-1);
  return !!parent && isGlossaryOpen(parent) && token.level === parent.level + 1;
}

/** The index of the token that closes the one opened at `start`. */
function closingIndex(tokens: Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    depth += tokens[i].nesting;
    if (depth === 0) return i;
  }
  return tokens.length - 1;
}

/** One list item's tokens, from `list_item_open` to `list_item_close`. */
function itemsOf(list: Token[]): Token[][] {
  const items: Token[][] = [];
  for (let i = 1; i < list.length - 1; i++) {
    const end = closingIndex(list, i);
    items.push(list.slice(i, end + 1));
    i = end;
  }
  return items;
}

interface SplitEntry {
  term: string;
  termChildren: Token[];
  definitionChildren: Token[];
}

function convertList(state: StateCore, list: Token[], entries: Entry[], ids: Set<string>): Token[] | undefined {
  const items = itemsOf(list);
  const split = items.map(splitItem);
  if (!split.every(Boolean)) return undefined;
  const open = block(state, 'smd_glossary_open', 'dl', 1, list[0]);
  open.attrSet('class', 'smd-glossary-list');
  const out = [open];
  items.forEach((item, n) => out.push(...entryTokens(state, item, split[n]!, entries, ids)));
  out.push(block(state, 'smd_glossary_close', 'dl', -1, list[0]));
  return out;
}

/** A new block token, placed where `at` is. */
function block(state: StateCore, type: string, tag: string, nesting: 1 | 0 | -1, at: Token): Token {
  const token = new state.Token(type, tag, nesting);
  token.block = true;
  token.level = at.level;
  if (nesting === 1) token.map = at.map;
  return token;
}

/** `<dt id><dfn>Term</dfn></dt><dd>definition …</dd>` for one item. Only the first `<dt>` of a term gets the id. */
function entryTokens(state: StateCore, item: Token[], split: SplitEntry, entries: Entry[], ids: Set<string>): Token[] {
  const [, paragraphOpen, inline, paragraphClose] = item;
  const id = termId(split.term);
  const dt = block(state, 'smd_glossary_term_open', 'dt', 1, item[0]);
  if (!ids.has(id)) {
    ids.add(id);
    dt.attrSet('id', id);
    entries.push({ term: split.term, id, title: plainText(split.definitionChildren) });
  }
  // Levels as the item's own inline token: parse.ts groups top-level blocks by level-0 tokens.
  const term = new state.Token('inline', '', 0);
  term.level = inline.level;
  term.content = split.term;
  term.children = [new state.Token('smd_dfn_open', 'dfn', 1), ...split.termChildren, new state.Token('smd_dfn_close', 'dfn', -1)];
  const definition = new state.Token('inline', '', 0);
  definition.level = inline.level;
  definition.content = inline.content;
  definition.map = inline.map;
  definition.children = split.definitionChildren;
  return [
    dt, term, block(state, 'smd_glossary_term_close', 'dt', -1, item[0]),
    block(state, 'smd_glossary_definition_open', 'dd', 1, item[0]),
    paragraphOpen, definition, paragraphClose, ...item.slice(4, -1),
    block(state, 'smd_glossary_definition_close', 'dd', -1, item[0]),
  ];
}

/** The term and definition of an item whose first paragraph starts `**Term**:` or `**Term:**`. */
function splitItem(item: Token[]): SplitEntry | undefined {
  const [, paragraph, inline] = item;
  const entry = paragraph?.type === 'paragraph_open' && inline?.type === 'inline' ? parseEntry(inline.content) : undefined;
  // Emphasis can leave an empty text token before the `**`.
  const children = (inline?.children ?? []).filter((c, i) => i > 0 || c.type !== 'text' || c.content);
  if (!entry || children[0]?.type !== 'strong_open') return undefined;
  const close = closingIndex(children, 0);
  const termChildren = children.slice(1, close);
  const definitionChildren = children.slice(close + 1);
  const last = termChildren.at(-1);
  if (last?.type === 'text' && last.content.endsWith(':')) {
    last.content = last.content.slice(0, -1);
  } else if (definitionChildren[0]?.type !== 'text' || !definitionChildren[0].content.trimStart().startsWith(':')) {
    return undefined;
  }
  const first = definitionChildren[0];
  if (first?.type === 'text') first.content = first.content.replace(/^\s*:?\s*/, '');
  if (first?.type === 'text' && !first.content) definitionChildren.shift();
  return { term: entry.term, termChildren, definitionChildren };
}

/** The text of inline tokens for a tooltip: text and code, inline HTML without its tags, images by their alt. */
function plainText(children: Token[]): string {
  return children.map((c) => {
    if (c.type === 'text' || c.type === 'code_inline') return c.content;
    if (c.type === 'html_inline') return htmlText(c.content);
    if (c.type === 'image') return plainText(c.children ?? []);
    return c.type === 'softbreak' || c.type === 'hardbreak' ? ' ' : '';
  }).join('').replaceAll(/\s+/g, ' ').trim();
}

const ENTITIES = new Map([['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"]]);

function htmlText(html: string): string {
  return html.replaceAll(/<[^>]*>/g, '').replaceAll(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES.get(e) ?? e);
}

// ---------------------------------------------------------------------------
// Uses of the terms
// ---------------------------------------------------------------------------

/** Where the walk over the document is. */
interface Walk {
  /** Terms already linked in this section. */
  seen: Set<string>;
  inHeading: boolean;
  /** Open blocks whose text is never marked: glossaries and footnotes. */
  skipped: number;
}

function markTerms(state: StateCore, matcher: TermMatcher<Entry>): void {
  const walk: Walk = { seen: new Set(), inHeading: false, skipped: 0 };
  for (const token of state.tokens) {
    if (follow(token, walk)) continue;
    if (token.type === 'inline' && token.children && !walk.inHeading && !walk.skipped) {
      token.children = markChildren(state, token.children, matcher, walk.seen);
    }
  }
}

/** The footnotes section and footnote definitions (ours, and markdown-it-footnote's on a host). */
const FOOTNOTE_BLOCKS = new Set(['smd_footnotes', 'smd_footnote_definition', 'footnote_block']);

/** +1 for a token that opens a block whose text is never marked, -1 for one that closes it. */
function skipDepth(token: Token): number {
  const footnote = FOOTNOTE_BLOCKS.has(token.type.replace(/_(?:open|close)$/, ''));
  if (isGlossaryOpen(token) || (footnote && token.nesting === 1)) return 1;
  if (isGlossaryClose(token) || (footnote && token.nesting === -1)) return -1;
  return 0;
}

/** Track headings (each starts a section) and skipped blocks; true for the tokens that only move the walk on. */
function follow(token: Token, walk: Walk): boolean {
  if (token.type === 'heading_open') {
    walk.seen = new Set();
    walk.inHeading = true;
  } else if (token.type === 'heading_close') {
    walk.inHeading = false;
  } else {
    const depth = skipDepth(token);
    walk.skipped += depth;
    return depth !== 0;
  }
  return true;
}

/** An inline token's children with the first use of each term (not inside a link) linked to its definition. */
function markChildren(state: StateCore, children: Token[], matcher: TermMatcher<Entry>, seen: Set<string>): Token[] {
  const out: Token[] = [];
  let links = 0;
  for (const child of children) {
    links += linkDepth(child);
    if (child.type === 'text' && links === 0) out.push(...splitText(state, child, matcher, seen));
    else out.push(child);
  }
  return out;
}

/** +1 for a token that opens a link (Markdown or raw `<a>`), -1 for one that closes it. */
function linkDepth(token: Token): number {
  if (token.type === 'link_open' || (token.type === 'html_inline' && /^<a[\s>]/i.test(token.content))) return 1;
  if (token.type === 'link_close' || (token.type === 'html_inline' && /^<\/a\s*>/i.test(token.content))) return -1;
  return 0;
}

function splitText(state: StateCore, token: Token, matcher: TermMatcher<Entry>, seen: Set<string>): Token[] {
  const out: Token[] = [];
  let pos = 0;
  for (const m of matcher.find(token.content)) {
    const key = termKey(m.entry.term);
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.index > pos) out.push(text(state, token.content.slice(pos, m.index)));
    out.push(html(state, termOpen(m.entry)), text(state, m.text), html(state, isAbbreviation(m.entry.term) ? '</abbr></a>' : '</a>'));
    pos = m.index + m.text.length;
  }
  if (!pos) return [token];
  if (pos < token.content.length) out.push(text(state, token.content.slice(pos)));
  return out;
}

function termOpen(entry: Entry): string {
  const title = escapeHtml(entry.title);
  if (isAbbreviation(entry.term)) return `<a class="smd-term" href="#${entry.id}"><abbr title="${title}">`;
  return `<a class="smd-term" href="#${entry.id}" title="${title}">`;
}

function text(state: StateCore, content: string): Token {
  const token = new state.Token('text', '', 0);
  token.content = content;
  return token;
}

function html(state: StateCore, content: string): Token {
  const token = new state.Token('html_inline', '', 0);
  token.content = content;
  return token;
}
