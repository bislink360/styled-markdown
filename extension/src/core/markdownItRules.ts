import type { StateBlock, StateCore, StateInline, Token } from 'markdown-it';
import { attrsToStyle, emptyAttrs, escapeHtml, findAttrsEnd, parseAttrs, type Attrs } from './attrs';
import { ContainerInfo, parseContainerInfo } from './containers';
import { FigureCounter, figureTargets, type FigureNumber } from './figures';
import { normalizeFootnoteLabel } from './footnotes';
import { parseFrontMatter } from './frontmatter';
import { renderInlineDirective, withoutDueNotes } from './markdownItHtml';
import { slugify } from './sections';
import { INLINE_DIRECTIVES } from './spec';
import type { IncludeResult, IncludeScope } from './include';
import type { SmdContext } from './markdownItSetup';
import type { Env, Heading } from './render';
import { substituteLine, variableAt, lookupVariable, type Variables } from './variables';

export { slugify } from './sections';

/**
 * The markdown-it rules behind .smd syntax: block containers, inline spans and directives, math,
 * footnotes, task lists, heading attributes and ids, and source lines. They only use what markdown-it hands
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
  /** The number of a `:::figure` (see numberFigures). */
  figure?: FigureNumber;
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

/** Where numbered figures are kept for `:ref[id]`, on the env of one render (a host's env too). */
export interface FigureEnv {
  smdFigures?: Map<string, FigureNumber>;
}

/**
 * Number the `:::figure` containers of a document in order, one counter per kind, and keep them by id
 * on the env so references anywhere (container titles too) can show "Figure 2". Runs after
 * annotateContainers; inline-only parses (titles) keep the document's figures.
 */
export function numberFigures(state: StateCore): void {
  if (state.inlineMode) return;
  const counter = new FigureCounter();
  const figures: Array<FigureNumber & { id?: string }> = [];
  for (const token of state.tokens) {
    const meta = token.meta as ContainerMeta | null;
    if (token.type !== 'container_smd_open' || meta?.name !== 'figure') continue;
    meta.figure = counter.next(meta.attrs.values.kind);
    figures.push({ ...meta.figure, id: meta.attrs.id });
  }
  const env = state.env as FigureEnv | undefined;
  if (env && typeof env === 'object') env.smdFigures = figureTargets(figures);
}

/** The figures numbered for the document being rendered (empty outside a render). */
export function envFigures(env: unknown): ReadonlyMap<string, FigureNumber> {
  return (env as FigureEnv | undefined)?.smdFigures ?? new Map();
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
    // The attributes as written, for the exporters (exportTree.ts), which map them rather than read the CSS.
    open.meta = { values: attrs.values } satisfies SpanMeta;
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
  if (!silent) pushDirective(state, name, content, attrs, ctx);
  state.pos = pos;
  return true;
}

/**
 * A directive's token: its HTML, or for `:ref[id]` an `smd_ref` token resolved when rendering (the figure may come later).
 * Front matter variables in the content are replaced first (`:badge[v{{version}}]`).
 */
function pushDirective(state: StateInline, name: string, content: string, attrs: Attrs, ctx: SmdContext): void {
  if (name === 'ref') {
    state.push('smd_ref', '', 0).meta = { id: content.trim() };
    return;
  }
  const text = ctx.variables ? substituteLine(content, envVariables(state.env)) : content;
  const token = state.push('html_inline', '', 0);
  token.content = renderInlineDirective(state.md, name, text, attrs.values, ctx.options(state.env).today, ctx.messages(state.env));
  token.meta = { directive: name, content: text, values: attrs.values } satisfies DirectiveMeta;
}

/** What an `smd_span_open` token keeps of `[text]{attrs}`. */
export interface SpanMeta { values: Record<string, string> }

/** What the `html_inline` token of an inline directive keeps of its source, for hosts that don't want its HTML. */
export interface DirectiveMeta {
  directive: string;
  /** The content, front matter variables replaced. */
  content: string;
  values: Record<string, string>;
}

/** The meta of the checkbox token that taskLists puts in front of a task's text. */
export interface TaskBoxMeta { taskBox: true; checked: boolean }

// ---------------------------------------------------------------------------
// Front matter variables  ({{name}})
// ---------------------------------------------------------------------------

/** Where the front matter of the document being rendered is kept for `{{name}}` (a host's env too). */
export interface VariableEnv {
  smdVariables?: Variables;
}

/** The front matter variables of the render (none outside a render). */
export function envVariables(env: unknown): Variables | undefined {
  return (env as VariableEnv | undefined)?.smdVariables;
}

/**
 * Keep the document's front matter on the env for `{{name}}`, unless the env already has it: renderSmd puts
 * it there, and so may a host that removes the front matter before rendering. Inline-only parses (titles)
 * keep the document's.
 */
export function collectVariables(state: StateCore): void {
  const env = state.env as VariableEnv | undefined;
  if (state.inlineMode || !env || typeof env !== 'object' || env.smdVariables) return;
  if (state.src.startsWith('---')) env.smdVariables = parseFrontMatter(state.src).data;
}

/**
 * `{{name}}` for a front matter key with a text value: an `smd_variable` token holding the value (the
 * source stays in `markup` for heading ids). Unknown names are left to the text rule, as written.
 */
export function inlineVariable(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x7b /* { */ || state.src.charCodeAt(start + 1) !== 0x7b) return false;
  const ref = variableAt(state.src, start, state.posMax);
  const value = ref && lookupVariable(envVariables(state.env), ref.name);
  if (!ref || value?.kind !== 'text') return false;
  if (!silent) {
    const token = state.push('smd_variable', '', 0);
    token.content = value.text;
    token.markup = state.src.slice(ref.column, ref.endColumn);
  }
  state.pos = ref.endColumn;
  return true;
}

/**
 * Turn `smd_variable` tokens into text once heading ids and task labels are taken, so a value is text
 * like any other: in image alt text, for the typographer, and for later plugins.
 */
export function variablesAsText(state: StateCore): void {
  const convert = (tokens: Token[] | null) => {
    for (const t of tokens ?? []) {
      if (t.type === 'smd_variable') t.type = 'text';
      else if (t.children) convert(t.children);
    }
  };
  convert(state.tokens);
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
// Footnotes  ([^label] references, [^label]: definitions — as on GitHub)
// ---------------------------------------------------------------------------

/** One parse's footnotes, on the env from the first definition until footnoteTail moves them. */
interface FootnoteState {
  /** Labels (normalized) that have a definition. */
  defined: Set<string>;
  /** Referenced labels in the order of their first reference, with their number and reference count. */
  used: Map<string, { n: number; count: number }>;
  /** Read every `[^label]` as a reference, defined or not (see acceptAnyFootnote). */
  anyLabel?: boolean;
}

/** What footnote tokens carry for rendering: the footnote's number and, on references and back links, which reference. */
export interface FootnoteMeta { n: number; sub: number }

// A symbol, so a host's own env keys (markdown-it-footnote uses `footnotes`) never clash.
const FOOTNOTES = Symbol('smd.footnotes');
type FootnoteEnv = { [FOOTNOTES]?: FootnoteState };

const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:/;

/**
 * Make a parse with this env read every `[^label]` as a reference, defined or not: for parsing part of
 * a document whose definitions may be elsewhere (parse.ts), whose caller decides which labels are defined.
 */
export function acceptAnyFootnote(env: object): void {
  (env as FootnoteEnv)[FOOTNOTES] = { defined: new Set(), used: new Map(), anyLabel: true };
}

/** `[^label]: text` definitions. Lines indented by 4 spaces continue one, as in a list item. */
export function footnoteDefinition(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4 || typeof state.env !== 'object' || !state.env) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const def = FOOTNOTE_DEF.exec(state.src.slice(start, state.eMarks[startLine]));
  if (!def) return false;
  if (silent) return true;

  const env = state.env as FootnoteEnv;
  env[FOOTNOTES] ??= { defined: new Set(), used: new Map() };
  const label = normalizeFootnoteLabel(def[1]);
  env[FOOTNOTES].defined.add(label);
  const open = state.push('smd_footnote_definition_open', '', 1);
  open.block = true;
  open.meta = { label };
  const saved = enterDefinition(state, startLine, start + def[0].length);
  state.md.block.tokenize(state, startLine, endLine);
  leaveDefinition(state, startLine, saved);
  state.push('smd_footnote_definition_close', '', -1).block = true;
  open.map = [startLine, state.line];
  return true;
}

interface SavedLine { bMark: number; tShift: number; sCount: number; parentType: StateBlock['parentType'] }

/** Parse the definition's first line from after the colon, with its content indented one level (markdown-it-footnote's approach). */
function enterDefinition(state: StateBlock, line: number, afterColon: number): SavedLine {
  const saved = { bMark: state.bMarks[line], tShift: state.tShift[line], sCount: state.sCount[line], parentType: state.parentType };
  const initial = state.sCount[line] + afterColon - (state.bMarks[line] + state.tShift[line]);
  let offset = initial;
  let pos = afterColon;
  for (; pos < state.eMarks[line]; pos++) {
    const ch = state.src.charCodeAt(pos);
    if (ch === 0x09) offset += 4 - (offset % 4);
    else if (ch === 0x20) offset++;
    else break;
  }
  state.tShift[line] = pos - afterColon;
  state.sCount[line] = offset - initial;
  state.bMarks[line] = afterColon;
  state.blkIndent += 4;
  state.parentType = 'footnote' as never;
  if (state.sCount[line] < state.blkIndent) state.sCount[line] += state.blkIndent;
  return saved;
}

function leaveDefinition(state: StateBlock, line: number, saved: SavedLine): void {
  state.parentType = saved.parentType;
  state.blkIndent -= 4;
  state.tShift[line] = saved.tShift;
  state.sCount[line] = saved.sCount;
  state.bMarks[line] = saved.bMark;
}

/** Inside a link's text (markdown-it 13+ counts link levels; the types don't list it yet). */
const insideLink = (state: StateInline) => ((state as StateInline & { linkLevel?: number }).linkLevel ?? 0) > 0;

/**
 * `[^label]` for a defined label. Undefined labels stay text, and so do references inside link text.
 * It never matches in silent mode: link labels are scanned that way, and a match there would read as a
 * nested link, so `[see [^1]](url)` would stop being a link.
 */
export function footnoteReference(state: StateInline, silent: boolean): boolean {
  const notes = (state.env as FootnoteEnv | undefined)?.[FOOTNOTES];
  const start = state.pos;
  if (silent || !notes || insideLink(state) || !state.src.startsWith('[^', start)) return false;
  const end = state.src.indexOf(']', start + 2);
  if (end < 0 || end >= state.posMax) return false;
  const raw = state.src.slice(start + 2, end);
  const label = normalizeFootnoteLabel(raw);
  if (!raw || /\s/.test(raw) || !(notes.anyLabel || notes.defined.has(label))) return false;
  let use = notes.used.get(label);
  if (!use) {
    use = { n: notes.used.size + 1, count: 0 };
    notes.used.set(label, use);
  }
  use.count++;
  const token = state.push('smd_footnote_ref', '', 0);
  token.meta = { n: use.n, sub: use.count } satisfies FootnoteMeta;
  // As written, for heading text and slugs: the same as when the label is undefined and stays text.
  token.content = state.src.slice(start, end + 1);
  state.pos = end + 1;
  return true;
}

/**
 * Move definitions out of the text into a footnotes section at the end, numbered by first reference.
 * Unreferenced definitions are left out and the first definition of a label wins, as on GitHub.
 */
export function footnoteTail(state: StateCore): void {
  const env = state.env as FootnoteEnv | undefined;
  const notes = env?.[FOOTNOTES];
  if (!notes) return;
  delete env![FOOTNOTES];
  const { body, definitions } = splitDefinitions(state.tokens);
  if (!notes.used.size) {
    state.tokens = body;
    return;
  }
  const out = [...body, new state.Token('smd_footnotes_open', 'section', 1)];
  for (const [label, use] of notes.used) out.push(...footnoteItem(state, definitions.get(label) ?? [], use));
  out.push(new state.Token('smd_footnotes_close', 'section', -1));
  state.tokens = out;
}

/** The tokens outside definitions, and each label's first definition (nested definitions are their own). */
function splitDefinitions(tokens: Token[]): { body: Token[]; definitions: Map<string, Token[]> } {
  const body: Token[] = [];
  const definitions = new Map<string, Token[]>();
  const open: Array<{ label: string; tokens: Token[] }> = [];
  for (const t of tokens) {
    if (t.type === 'smd_footnote_definition_open') {
      open.push({ label: (t.meta as { label: string }).label, tokens: [] });
    } else if (t.type === 'smd_footnote_definition_close') {
      const def = open.pop();
      if (def && !definitions.has(def.label)) definitions.set(def.label, def.tokens);
    } else {
      (open[open.length - 1]?.tokens ?? body).push(t);
    }
  }
  return { body, definitions };
}

/** One `<li>`: the definition, with a back link to each reference at the end of its last paragraph. */
function footnoteItem(state: StateCore, content: Token[], use: { n: number; count: number }): Token[] {
  const open = new state.Token('smd_footnote_open', 'li', 1);
  open.meta = { n: use.n, sub: 0 } satisfies FootnoteMeta;
  const items = [open, ...content];
  const lastParagraph = items[items.length - 1].type === 'paragraph_close' ? items.pop() : undefined;
  for (let sub = 1; sub <= use.count; sub++) {
    const back = new state.Token('smd_footnote_backref', '', 0);
    back.meta = { n: use.n, sub } satisfies FootnoteMeta;
    items.push(back);
  }
  if (lastParagraph) items.push(lastParagraph);
  items.push(new state.Token('smd_footnote_close', 'li', -1));
  return items;
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
  box.meta = { taskBox: true, checked } satisfies TaskBoxMeta;
  // The task's text names its checkbox (no id: ids in the HTML are the document's anchors).
  const label = taskLabel(inline.children!, checked);
  box.content = `<input type="checkbox" class="smd-task-box"${where}${checked ? ' checked' : ''}${label ? ` aria-label="${escapeHtml(label)}"` : ''}>`;
  inline.children!.unshift(box);
  item.attrJoin('class', `smd-task${checked ? ' smd-task-done' : ''}`);
  markTaskList(tokens, i - 2);
}

/** The plain text of a task's inline tokens: text, code, and the text of inline HTML such as directives. */
function taskLabel(children: Token[], done: boolean): string {
  return children.map((c) => {
    if (c.type === 'text' || c.type === 'code_inline' || c.type === 'smd_variable') return c.content;
    if (c.type === 'html_inline') return htmlText(done ? withoutDueNotes(c.content) : c.content);
    if (c.type === 'image') return taskLabel(c.children ?? [], done);
    return c.type === 'softbreak' || c.type === 'hardbreak' ? ' ' : '';
  }).join('').replace(/\s+/g, ' ').trim();
}

const ENTITIES = new Map([['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"]]);

/** The text of an HTML fragment: tags dropped, the entities escapeHtml writes decoded. */
function htmlText(html: string): string {
  let text = '';
  let pos = 0;
  while (pos < html.length) {
    const open = html.indexOf('<', pos);
    const close = open < 0 ? -1 : html.indexOf('>', open);
    if (close < 0) break;
    text += html.slice(pos, open);
    pos = close + 1;
  }
  text += html.slice(pos);
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES.get(e) ?? e);
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
  const later: Array<[Token, Heading, string]> = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'heading_open') continue;
    const text = headingText(tokens[i + 1], false);
    // Ids come from the source, so `{{version}}` gives the same id whatever its value.
    const source = headingText(tokens[i + 1], true);
    const agent = t.attrGet('data-agent') ?? undefined;
    const heading: Heading = { level: Number(t.tag.slice(1)), text: text.trim(), slug: '', line: (t.map?.[0] ?? 0) + (env?.lineOffset ?? 0), ...(agent ? { agent } : {}) };
    if (includedFrom(t)) later.push([t, heading, source]);
    else heading.slug = ownSlug(t, source, slugs, env);
    env?.headings?.push(heading);
  }
  if (later.length) includedSlugs(tokens, later);
}

/** A heading's text: text, inline code and footnote references; front matter variables as their values, or as written for `source`. */
function headingText(inline: Token, source: boolean): string {
  return (inline.children ?? []).map((c) => {
    if (c.type === 'smd_variable') return source ? c.markup : c.content;
    return ['text', 'code_inline', 'smd_footnote_ref'].includes(c.type) ? c.content : '';
  }).join('');
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
function includedSlugs(tokens: Token[], later: Array<[Token, Heading, string]>): void {
  const used = new Set(tokens.filter((t) => t.type === 'heading_open' && !includedFrom(t)).map((t) => t.attrGet('id')));
  for (const [t, heading, source] of later) {
    const from = includedFrom(t)!;
    const own = t.attrGet('id') ?? numbered(from.slugs, slugify(source.trim()) || 'section');
    let slug = own;
    let n = 0;
    while (used.has(slug)) slug = `${own}-${++n}`;
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
