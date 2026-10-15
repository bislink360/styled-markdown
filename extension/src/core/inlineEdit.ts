import type MarkdownIt from 'markdown-it';
import type { StateInline, Token } from 'markdown-it';
import { removeAttr, setAttr, type Span } from './attrEdit';
import { parseContainerInfo } from './containers';
import { EN } from './i18n';
import { inlineDirective, styledSpan, type DirectiveMeta, type SpanMeta } from './markdownItRules';
import type { SmdContext } from './markdownItSetup';
import { createMarkdownIt } from './render';
import { INLINE_DIRECTIVES } from './spec';

/**
 * The inline directives (`:badge[x]{color=green}`, `:due[2026-10-30]`…) and styled spans (`[text]{color=red}`) of a
 * block, with their place in its lines, for the Block Editor's inline forms. Inline tokens carry no source offsets,
 * so the block is parsed with the renderer's own rules (markdownItRules.ts: inlineDirective, styledSpan), recording
 * where each one starts and ends in the text of its inline token; that text is then found in the block's lines.
 * Code spans, math, escapes, code blocks and HTML are skipped as rendering skips them, because they are the same
 * rules. The items come in the order renderBlocks numbers them (`data-smd-inline`, see blocks.ts). Browser-safe;
 * not part of the npm API.
 */

export type InlineKind = 'directive' | 'span';

/** The name a styled span goes by (no directive has it). */
export const SPAN = 'span';

/** Where an inline item is: one line of the block, in columns of that line. */
export interface InlinePlace {
  /** Zero-based line within the lines given. */
  line: number;
  /** The whole item, `:name[…]{…}` or `[…]{…}`. */
  start: number;
  end: number;
  /** Inside the brackets, when there are brackets. */
  content?: Span;
  /** `{…}` with its braces, when there is an attribute list. */
  attrs?: Span;
}

export interface InlineItem {
  kind: InlineKind;
  /** The directive's name, or SPAN. */
  name: string;
  /** The text inside the brackets as written (front matter variables not replaced); undefined without brackets. */
  content?: string;
  /** The attribute values as parseAttrs reads them (the last of a repeated key wins). */
  values: Record<string, string>;
  /** Undefined when the item can't be placed on one line (it runs over a line break, or its text was rewritten). */
  at?: InlinePlace;
}

/** What a directive or span as rendered says about itself (renderBlocks with `inlineIndex`). */
export interface RenderedInline {
  kind: InlineKind;
  name: string;
  /** A directive's content as rendered (front matter variables replaced); '' for a span. */
  content: string;
  values: Record<string, string>;
}

/** One item as recorded in the text of an inline token: offsets into that text. */
interface Recorded {
  kind: InlineKind;
  name: string;
  start: number;
  end: number;
  content?: Span;
  attrs?: Span;
  values: Record<string, string>;
}

interface Recorder {
  src: string;
  items: Recorded[];
}

type RecordingEnv = { smdInlineRecorder?: Recorder };

/** The rules' context for parsing only: no variables (content stays as written), English labels. */
const CONTEXT: SmdContext = {
  options: () => ({}),
  title: () => '',
  ownLines: true,
  variables: false,
  messages: () => EN,
};

/** The recorder for a rule call that pushes tokens in the text being recorded (not in alt text or nested renders). */
function recorderOf(state: StateInline, silent: boolean): Recorder | undefined {
  const recorder = (state.env as RecordingEnv | undefined)?.smdInlineRecorder;
  return !silent && recorder?.src === state.src ? recorder : undefined;
}

function recordSpan(state: StateInline, silent: boolean): boolean {
  const recorder = recorderOf(state, silent);
  const start = state.pos;
  if (!recorder || state.src.charCodeAt(start) !== 0x5b /* [ */) return styledSpan(state, silent);
  const labelEnd = state.md.helpers.parseLinkLabel(state, start, true);
  // The span goes before the items inside its text, as its opening token does.
  const index = recorder.items.length;
  const from = state.tokens.length;
  if (!styledSpan(state, silent)) return false;
  // Its opening token, after any text pushed before it (spans inside its text come later).
  const open = state.tokens.slice(from).find((t) => t.type === 'smd_span_open');
  const values = (open?.meta as SpanMeta | undefined)?.values ?? {};
  recorder.items.splice(index, 0, {
    kind: 'span', name: SPAN, start, end: state.pos, content: { start: start + 1, end: labelEnd }, attrs: { start: labelEnd + 1, end: state.pos }, values,
  });
  return true;
}

function recordDirective(state: StateInline, silent: boolean): boolean {
  const recorder = recorderOf(state, silent);
  const start = state.pos;
  if (!inlineDirective(state, silent, CONTEXT)) return false;
  const token = state.tokens.at(-1);
  const meta = token?.meta as DirectiveMeta | undefined;
  // `:ref[id]` becomes a link when rendered, not a directive token: it is never numbered.
  if (!recorder || token?.type !== 'html_inline' || !meta?.directive) return true;
  const item: Recorded = { kind: 'directive', name: meta.directive, start, end: state.pos, values: meta.values };
  let at = start + 1 + meta.directive.length;
  if (state.src[at] === '[') {
    item.content = { start: at + 1, end: at + 1 + meta.content.length };
    at = item.content.end + 1;
  }
  if (state.src[at] === '{') item.attrs = { start: at, end: state.pos };
  recorder.items.push(item);
  return true;
}

const parsers = new Map<boolean, MarkdownIt>();

/** A markdown-it instance with the renderer's rules, the directive and span rules recording where they match. */
function parser(allowHtml: boolean): MarkdownIt {
  let md = parsers.get(allowHtml);
  if (!md) {
    md = createMarkdownIt({ allowHtml });
    md.inline.ruler.at('smd_span', recordSpan);
    md.inline.ruler.at('smd_directive', recordDirective);
    parsers.set(allowHtml, md);
  }
  return md;
}

/** As renderSmd reads a line: a lone `\r` is a space, NUL is U+FFFD (markdown-it's normalize); lengths stay the same. */
const normalized = (line: string) => line.replaceAll('\r', ' ').replaceAll('\0', '�');

/**
 * The inline tokens whose directives and spans are numbered, in order: both the scan here and renderBlocks pick
 * them this way. Not those in an `:::include` block (its body is the included text, or the fallback when that
 * fails) nor in footnote definitions (rendered with the footnotes, after every block).
 */
export function numberedInlineTokens(tokens: readonly Token[]): Array<{ token: Token; line: number }> {
  const out: Array<{ token: Token; line: number }> = [];
  let skipped = 0;
  // A table cell's text has no lines of its own: it is on its row's line.
  let line = 0;
  const stack: boolean[] = [];
  for (const t of tokens) {
    if (t.map) line = t.map[0];
    if (t.type === 'container_smd_open' || t.type === 'smd_footnote_definition_open') {
      const skip = t.type === 'smd_footnote_definition_open' || parseContainerInfo(t.info)?.name === 'include';
      stack.push(skip);
      if (skip) skipped++;
    } else if (t.type === 'container_smd_close' || t.type === 'smd_footnote_definition_close') {
      if (stack.pop()) skipped--;
    } else if (t.type === 'inline' && skipped === 0) {
      out.push({ token: t, line });
    }
  }
  return out;
}

/**
 * The column where a line of inline text starts in its source line: the end of the line (a paragraph's lines lose
 * only their indentation, list marker or `>`), else its first place after `from` (a table cell, a heading with
 * closing `#`s). -1 when it is not there.
 */
function columnOf(source: string, part: string, from: number): number {
  if (source.endsWith(part) && source.length - part.length >= from) return source.length - part.length;
  const trimmed = source.trimEnd();
  if (trimmed.endsWith(part) && trimmed.length - part.length >= from) return trimmed.length - part.length;
  return source.indexOf(part, from);
}

/** Place the items recorded in an inline token's text on the block's lines. */
function place(text: string, first: number, recorded: readonly Recorded[], lines: readonly string[], cursors: Map<number, number>): InlineItem[] {
  const parts = text.split('\n');
  const starts: number[] = [];
  const columns: number[] = [];
  let offset = 0;
  parts.forEach((part, k) => {
    const line = first + k;
    const column = line < lines.length ? columnOf(lines[line], part, cursors.get(line) ?? 0) : -1;
    if (column >= 0) cursors.set(line, column + part.length);
    starts.push(offset);
    columns.push(column);
    offset += part.length + 1;
  });
  return recorded.map((r) => {
    const item: InlineItem = { kind: r.kind, name: r.name, values: r.values };
    if (r.content) item.content = text.slice(r.content.start, r.content.end);
    const at = placeOf(r, text, lines, { first, starts, columns });
    if (at) item.at = at;
    return item;
  });
}

interface Layout {
  first: number;
  starts: readonly number[];
  columns: readonly number[];
}

/** An item's place on its line, when the item is on one line that was found and holds its text there. */
function placeOf(r: Recorded, text: string, lines: readonly string[], layout: Layout): InlinePlace | undefined {
  // The line of the text the item starts on.
  const k = layout.starts.reduce((last, start, i) => (start <= r.start ? i : last), 0);
  const column = layout.columns[k];
  const lineEnd = (layout.starts[k + 1] ?? text.length + 1) - 1;
  if (column < 0 || r.end > lineEnd) return undefined;
  const shift = column - layout.starts[k];
  const line = layout.first + k;
  const move = (span: Span | undefined) => span && { start: span.start + shift, end: span.end + shift };
  const at: InlinePlace = { line, start: r.start + shift, end: r.end + shift };
  if (lines[line].slice(at.start, at.end) !== text.slice(r.start, r.end)) return undefined;
  const content = move(r.content);
  const attrs = move(r.attrs);
  if (content) at.content = content;
  if (attrs) at.attrs = attrs;
  return at;
}

/**
 * Every inline directive and styled span of a block, in the order rendering numbers them, with its place in
 * `lines` (the block's own lines, as split on line breaks). Directives and spans inside code, math, HTML, escapes,
 * link destinations, image text and `:::include` blocks are not there, as they are not rendered as such.
 */
export function scanInline(lines: readonly string[], options: { allowHtml?: boolean } = {}): InlineItem[] {
  const md = parser(options.allowHtml ?? true);
  const source = lines.map(normalized);
  const env: RecordingEnv & Record<string, unknown> = {};
  const tokens: Token[] = [];
  md.block.parse(source.join('\n'), md, env, tokens);
  const items: InlineItem[] = [];
  const cursors = new Map<number, number>();
  for (const { token, line } of numberedInlineTokens(tokens)) {
    const recorder: Recorder = { src: token.content, items: [] };
    env.smdInlineRecorder = recorder;
    md.inline.parse(token.content, md, env, []);
    env.smdInlineRecorder = undefined;
    items.push(...place(token.content, line, recorder.items, source, cursors));
  }
  return items;
}

// ---------------------------------------------------------------------------
// Editing one item
// ---------------------------------------------------------------------------

/** A change to one item: new content, and attributes to set (a value) or remove (null). */
export interface InlineChange {
  content?: string;
  attrs?: Readonly<Record<string, string | null>>;
}

const splice = (text: string, span: Span, insert: string) => text.slice(0, span.start) + insert + text.slice(span.end);

/** The canonical order of an item's keys (formatAttrs'): its directive's attributes, then the style keys. */
export const inlineOrder = (name: string): readonly string[] => (name === SPAN ? [] : INLINE_DIRECTIVES[name]?.attrs ?? []);

/** The inside of an attribute list with the change's attributes set or removed; null when one can't be written. */
function editAttrs(inner: string, name: string, attrs: Readonly<Record<string, string | null>>): string | null {
  let out: string | null = inner;
  for (const [key, value] of Object.entries(attrs)) {
    if (out === null) return null;
    out = value === null ? removeAttr(out, key) : setAttr(out, key, value, inlineOrder(name));
  }
  return out;
}

/**
 * The item's line with the change made: the content inside its brackets, the attributes inside its braces (kept
 * in their order and quotes; new keys at their canonical place, as `smd fmt` writes them). A directive with
 * content loses `{}` when no attribute is left; a span, or a directive without brackets, keeps it, since without
 * it the text would no longer be one. Null when the item has no place or the change can't be written there.
 */
export function editInline(line: string, item: InlineItem, change: InlineChange): string | null {
  const at = item.at;
  if (!at) return null;
  let attrsText = at.attrs ? line.slice(at.attrs.start + 1, at.attrs.end - 1) : '';
  if (change.attrs) {
    const next = editAttrs(attrsText, item.name, change.attrs);
    if (next === null) return null;
    attrsText = next;
  }
  const keepBraces = item.kind === SPAN || !at.content;
  const braces = attrsText.trim() || keepBraces ? `{${attrsText}}` : '';
  // The attribute list first, so the content's span still holds.
  let out = at.attrs ? splice(line, at.attrs, braces) : splice(line, { start: at.end, end: at.end }, braces);
  if (change.content !== undefined) {
    if (!at.content || /[\r\n]/.test(change.content)) return null;
    out = splice(out, at.content, change.content);
  }
  return out;
}
