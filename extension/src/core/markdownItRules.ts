import type { StateBlock, StateCore, StateInline, Token } from 'markdown-it';
import { emptyAttrs, findAttrsEnd, parseAttrs, attrsToStyle } from './attrs';
import { ContainerInfo, parseContainerInfo } from './containers';
import { parseFrontMatter } from './frontmatter';
import { renderInlineDirective } from './markdownItHtml';
import { slugify } from './sections';
import { INLINE_DIRECTIVES } from './spec';
import type { IncludeResult, IncludeScope } from './include';
import type { SmdContext } from './markdownItSetup';
import type { Env, Heading } from './render';

export { slugify } from './sections';

/**
 * The markdown-it rules behind .smd syntax: block containers, inline spans and directives, math,
 * task lists, heading attributes and ids, and source lines. They only use what markdown-it hands
 * them (state.md, state.env), so they work on any markdown-it instance (see markdownIt.ts).
 */

const lineText = (state: StateBlock, l: number) => state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]);

// ---------------------------------------------------------------------------
// Block containers  (:::name{attrs} Title … :::)
// ---------------------------------------------------------------------------

/**
 * Block rule for `:::name …` containers. Unlike markdown-it-container, it
 * tracks nesting: a bare `:::` closes the innermost open container, and
 * fenced code inside a container is skipped. Colon counts are cosmetic.
 */
export function containerBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const open = /^(:{3,})\s*([a-zA-Z].*)$/.exec(lineText(state, startLine));
  if (!open) return false;
  if (silent) return true;

  const closeLine = findContainerClose(state, startLine, endLine);
  const end = closeLine === -1 ? endLine : closeLine;

  const oldParent = state.parentType;
  const oldLineMax = state.lineMax;
  state.parentType = 'container' as never;
  state.lineMax = end;
  const openToken = state.push('container_smd_open', 'div', 1);
  openToken.markup = open[1];
  openToken.block = true;
  openToken.info = open[2];
  openToken.map = [startLine, end];
  state.md.block.tokenize(state, startLine + 1, end);
  const closeToken = state.push('container_smd_close', 'div', -1);
  closeToken.markup = open[1];
  closeToken.block = true;
  state.parentType = oldParent;
  state.lineMax = oldLineMax;
  state.line = closeLine === -1 ? end : closeLine + 1;
  return true;
}

interface ContainerScan {
  /** Containers opened inside the one being closed. */
  depth: number;
  /** The open code fence (``` or ~~~ run), if any. */
  fence: string | null;
}

/** The line of the bare `:::` that closes the container opened on startLine, or -1 when it runs to the end. */
function findContainerClose(state: StateBlock, startLine: number, endLine: number): number {
  const scan: ContainerScan = { depth: 0, fence: null };
  for (let l = startLine + 1; l < endLine; l++) {
    const text = lineText(state, l);
    if (text.length && state.sCount[l] < state.blkIndent) break; // outdented: parent list/quote ended
    if (closesContainer(state, l, text, scan)) return l;
  }
  return -1;
}

/** Follow fences and nesting over one line; true when it is the bare `:::` that closes the scanned container. */
function closesContainer(state: StateBlock, l: number, text: string, scan: ContainerScan): boolean {
  if (scan.fence) {
    if (closesFence(text, scan.fence)) scan.fence = null;
    return false;
  }
  const indented = state.sCount[l] - state.blkIndent >= 4;
  const fence = /^(`{3,}|~{3,})/.exec(text);
  if (fence && !indented) {
    scan.fence = fence[1];
    return false;
  }
  if (indented) return false;
  if (/^:{3,}\s*[a-zA-Z]/.test(text)) {
    scan.depth++;
    return false;
  }
  if (!/^:{3,}\s*$/.test(text)) return false;
  if (scan.depth === 0) return true;
  scan.depth--;
  return false;
}

/** A fence closes on a line of at least its own run of the same character and nothing else. */
function closesFence(text: string, fence: string): boolean {
  return text.startsWith(fence) && [...text.slice(fence.length).trim()].every((c) => c === fence[0]);
}

export interface ContainerMeta extends ContainerInfo {
  /** Tag used to close the container (varies with presentation). */
  close: string;
  /** The parsed source, for `:::risk-matrix` when the env doesn't carry the document. */
  source?: string;
  /** For `:::include`: what was included, or why nothing was (see markdownItInclude.ts). */
  include?: IncludeResult;
}

export function annotateContainers(state: StateCore): void {
  annotateTokens(state.tokens, state.src);
}

/** Parse the opening line of every container in `tokens` (parsed from `src`) into its meta. */
export function annotateTokens(tokens: Token[], src: string): void {
  const stack: Token[] = [];
  for (const token of tokens) {
    if (token.type === 'container_smd_open') {
      const info = parseContainerInfo(token.info) ?? { name: 'box', attrs: emptyAttrs(), title: '' };
      const meta: ContainerMeta = { ...info, close: '</div>' };
      if (info.name === 'risk-matrix') meta.source = src;
      token.meta = meta;
      stack.push(token);
    } else if (token.type === 'container_smd_close') {
      const open = stack.pop();
      token.meta = open?.meta ?? { name: 'box', attrs: emptyAttrs(), title: '', close: '</div>' };
    }
  }
}

// ---------------------------------------------------------------------------
// Inline syntax
// ---------------------------------------------------------------------------

/** `[styled text]{color=red weight=bold}` → <span style=…> */
export function styledSpan(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x5b /* [ */) return false;
  const labelEnd = state.md.helpers.parseLinkLabel(state, start, true);
  if (labelEnd < 0 || state.src[labelEnd + 1] !== '{') return false;
  const attrsEnd = findAttrsEnd(state.src, labelEnd + 1);
  if (attrsEnd < 0) return false;
  const attrs = parseAttrs(state.src.slice(labelEnd + 2, attrsEnd));
  if (!attrs) return false;

  if (!silent) {
    const { style } = attrsToStyle(attrs);
    const open = state.push('smd_span_open', 'span', 1);
    const classes = ['smd-span', ...attrs.classes.map((c) => `smd-u-${c}`)];
    open.attrSet('class', classes.join(' '));
    if (style) open.attrSet('style', style);
    if (attrs.id) open.attrSet('id', attrs.id);
    const oldMax = state.posMax;
    state.pos = start + 1;
    state.posMax = labelEnd;
    state.md.inline.tokenize(state);
    state.posMax = oldMax;
    state.push('smd_span_close', 'span', -1);
  }
  state.pos = attrsEnd + 1;
  return true;
}

/** `:name[content]{attrs}` inline directives (badge, kbd, progress, mention, status). */
export function inlineDirective(state: StateInline, silent: boolean, ctx: SmdContext): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x3a /* : */) return false;
  const prev = start > 0 ? state.src[start - 1] : ' ';
  if (!/[\s([{>*_~"'-]/.test(prev)) return false;
  const m = /^:([a-z][a-z0-9-]*)(?=[[{])/.exec(state.src.slice(start, state.posMax));
  if (!m || !(m[1] in INLINE_DIRECTIVES)) return false;
  const name = m[1];
  let pos = start + m[0].length;

  let content = '';
  if (state.src[pos] === '[') {
    const end = state.md.helpers.parseLinkLabel(state, pos, true);
    if (end < 0) return false;
    content = state.src.slice(pos + 1, end);
    pos = end + 1;
  }
  let attrs = emptyAttrs();
  if (state.src[pos] === '{') {
    const end = findAttrsEnd(state.src, pos);
    if (end < 0) return false;
    const parsed = parseAttrs(state.src.slice(pos + 1, end));
    if (!parsed) return false;
    attrs = parsed;
    pos = end + 1;
  }
  if (!silent) {
    const token = state.push('html_inline', '', 0);
    token.content = renderInlineDirective(state.md, name, content, attrs.values, ctx.options(state.env).today);
  }
  state.pos = pos;
  return true;
}

/** `==highlighted==` */
export function mark(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x3d || state.src.charCodeAt(start + 1) !== 0x3d) return false;
  if (/\s|=/.test(state.src[start + 2] ?? ' ')) return false;
  const end = state.src.indexOf('==', start + 2);
  if (end < 0 || end > state.posMax - 2 || /\s/.test(state.src[end - 1])) return false;
  if (!silent) {
    state.push('smd_mark_open', 'mark', 1);
    const oldMax = state.posMax;
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = oldMax;
    state.push('smd_mark_close', 'mark', -1);
  }
  state.pos = end + 2;
  return true;
}

/** `$inline math$` (Pandoc rules: no space inside the delimiters, no digit after the closer). */
export function mathInline(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src[start] !== '$' || state.src[start + 1] === '$') return false;
  if (/\s/.test(state.src[start + 1] ?? ' ')) return false;
  let end = start + 1;
  while ((end = state.src.indexOf('$', end)) !== -1) {
    if (end >= state.posMax) return false;
    if (state.src[end - 1] !== '\\' && !/\s/.test(state.src[end - 1]) && !/\d/.test(state.src[end + 1] ?? '')) break;
    end++;
  }
  if (end === -1 || end === start + 1) return false;
  if (!silent) {
    const token = state.push('smd_math_inline', 'math', 0);
    token.content = state.src.slice(start + 1, end);
  }
  state.pos = end + 1;
  return true;
}

/** `$$ … $$` display math blocks. */
export function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const first = lineText(state, startLine);
  if (!first.startsWith('$$')) return false;
  let content: string;
  let last = startLine;
  const rest = first.slice(2);
  if (rest.trimEnd().endsWith('$$') && rest.trim().length > 2) {
    content = rest.trimEnd().slice(0, -2);
  } else {
    const lines = [rest];
    let found = false;
    for (let l = startLine + 1; l < endLine; l++) {
      const t = lineText(state, l);
      if (t.trimEnd().endsWith('$$')) {
        lines.push(t.trimEnd().slice(0, -2));
        last = l;
        found = true;
        break;
      }
      lines.push(t);
    }
    if (!found) return false;
    content = lines.join('\n');
  }
  if (silent) return true;
  const token = state.push('smd_math_block', 'math', 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, last + 1];
  state.line = last + 1;
  return true;
}

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

/** `---` YAML front matter on the first line, as one `smd_front_matter` token carrying the parsed data. */
export function frontMatterBlock(state: StateBlock, startLine: number, _endLine: number, silent: boolean): boolean {
  if (startLine !== 0 || state.blkIndent !== 0 || lineText(state, 0).trimEnd() !== '---') return false;
  const fm = parseFrontMatter(state.src);
  if (!fm.present || fm.bodyStartLine === 0) return false; // never closed: not front matter
  if (silent) return true;
  const token = state.push('smd_front_matter', '', 0);
  token.block = true;
  token.map = [0, fm.bodyStartLine];
  token.meta = fm.data;
  state.line = fm.bodyStartLine;
  return true;
}

// ---------------------------------------------------------------------------
// Core passes
// ---------------------------------------------------------------------------

const TASK = /^\[([ xX])\][ \t]/;

/** GFM task lists: `- [ ] open` / `- [x] done`, clickable in the preview. */
export function taskLists(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const checked = taskState(tokens, i);
    if (checked !== undefined) markTask(state, i, checked);
  }
}

/** Whether the inline token at i is the text of a task list item, and if so whether it is checked. */
function taskState(tokens: Token[], i: number): boolean | undefined {
  const inline = tokens[i];
  if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') return undefined;
  const m = TASK.exec(inline.content);
  const first = inline.children?.[0];
  if (!m || first?.type !== 'text' || !first.content.startsWith(m[0].slice(0, 3))) return undefined;
  return m[1] !== ' ';
}

function markTask(state: StateCore, i: number, checked: boolean): void {
  const tokens = state.tokens;
  const inline = tokens[i];
  const first = inline.children![0];
  first.content = first.content.slice(3).replace(/^[ \t]/, '');
  const item = tokens[i - 2];
  const line = (item.map?.[0] ?? 0) + ((state.env as Env | undefined)?.lineOffset ?? 0);
  // A task from an included document lives in another file, so the preview can't toggle it.
  const where = includedFrom(item) ? ' disabled' : ` data-task-line="${line}"`;
  const box = new state.Token('html_inline', '', 0);
  box.content = `<input type="checkbox" class="smd-task-box"${where}${checked ? ' checked' : ''}>`;
  inline.children!.unshift(box);
  item.attrJoin('class', `smd-task${checked ? ' smd-task-done' : ''}`);
  markTaskList(tokens, i - 2);
}

/** Add `smd-task-list` to the list that directly contains the item at index `item`. */
function markTaskList(tokens: Token[], item: number): void {
  const level = tokens[item].level - 1;
  for (let j = item - 1; j >= 0; j--) {
    const t = tokens[j];
    if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === level) {
      t.attrJoin('class', 'smd-task-list');
      return;
    }
  }
}

/** Where tokens spliced in by `:::include` came from (see markdownItInclude.ts). */
export interface IncludedFrom {
  /** The scope of the included document. */
  scope: IncludeScope;
  /** Slugs of the included headings in their own document, by base. */
  slugs: Map<string, number>;
  /** Included heading ids that changed to stay unique in the including document: own id → new id. */
  renames: Map<string, string>;
}

const included = new WeakMap<Token, IncludedFrom>();

/** The include a token was spliced in by, if any. */
export const includedFrom = (token: Token): IncludedFrom | undefined => included.get(token);

export function markIncluded(token: Token, from: IncludedFrom): void {
  included.set(token, from);
}

export function headingIds(state: StateCore): void {
  const env = state.env as Env | undefined;
  // Without a shared map (a host's env), slugs are still unique within one document.
  const slugs = env?.slugs ?? new Map<string, number>();
  const tokens = state.tokens;
  // Included headings get their ids last, so they never change the ids of the document's own headings.
  const later: Array<[Token, Heading]> = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'heading_open') continue;
    const text = headingText(tokens[i + 1]);
    const agent = t.attrGet('data-agent') ?? undefined;
    const heading: Heading = { level: Number(t.tag.slice(1)), text: text.trim(), slug: '', line: (t.map?.[0] ?? 0) + (env?.lineOffset ?? 0), ...(agent ? { agent } : {}) };
    if (includedFrom(t)) later.push([t, heading]);
    else heading.slug = ownSlug(t, text, slugs, env);
    env?.headings?.push(heading);
  }
  if (later.length) includedSlugs(tokens, later);
}

function headingText(inline: Token): string {
  return (inline.children ?? [])
    .filter((c) => c.type === 'text' || c.type === 'code_inline')
    .map((c) => c.content)
    .join('');
}

/** `base`, or `base-1`, `base-2`… for its later uses. */
function numbered(slugs: Map<string, number>, base: string): string {
  const n = slugs.get(base) ?? 0;
  slugs.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

/** The id of one of the document's own headings: its `{#id}`, or a numbered slug of its text. */
function ownSlug(t: Token, text: string, slugs: Map<string, number>, env: Env | undefined): string {
  let slug = t.attrGet('id');
  env?.bases?.push(slug ? null : slugify(text) || 'section');
  if (!slug) {
    slug = numbered(slugs, slugify(text) || 'section');
    t.attrSet('id', slug);
  }
  return slug;
}

/** Ids for included headings: the ones they have in their own document, numbered on where this document uses them. */
function includedSlugs(tokens: Token[], later: Array<[Token, Heading]>): void {
  const used = new Set(tokens.filter((t) => t.type === 'heading_open' && !includedFrom(t)).map((t) => t.attrGet('id')));
  for (const [t, heading] of later) {
    const from = includedFrom(t)!;
    const own = t.attrGet('id') ?? numbered(from.slugs, slugify(heading.text) || 'section');
    let slug = own;
    for (let n = 1; used.has(slug); n++) slug = `${own}-${n}`;
    used.add(slug);
    t.attrSet('id', slug);
    heading.slug = slug;
    if (slug !== own) from.renames.set(own, slug);
  }
}

/** `## Title {#custom-id .class agent=skip}` — trailing attribute list on a heading. */
export const HEADING_ATTRS = /\s+\{([^{}]*)\}\s*$/; // NOSONAR(typescript:S5852): matched against one heading line

export function headingAttrs(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const last = inline.children?.[inline.children.length - 1];
    if (!last || last.type !== 'text') continue;
    const m = HEADING_ATTRS.exec(last.content);
    const attrs = m ? parseAttrs(m[1]) : null;
    if (!m || !attrs) continue;
    last.content = last.content.slice(0, m.index);
    inline.content = inline.content.replace(HEADING_ATTRS, '');
    if (attrs.id) tokens[i].attrSet('id', attrs.id);
    if (attrs.classes.length) tokens[i].attrJoin('class', attrs.classes.map((c) => `smd-u-${c}`).join(' '));
    if (attrs.values.agent) tokens[i].attrSet('data-agent', attrs.values.agent);
  }
}

/** Add data-line to block tokens so the preview can follow the editor. */
export function sourceLines(state: StateCore): void {
  const offset = (state.env as Env | undefined)?.lineOffset ?? 0;
  for (const t of state.tokens) {
    if (t.map && t.block && t.nesting >= 0 && !t.type.startsWith('container_')) {
      t.attrSet('data-line', String(t.map[0] + offset));
    }
  }
}
