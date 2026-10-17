import type MarkdownIt from 'markdown-it';
import type { StateInline, Token } from 'markdown-it';
import { alertOf } from './alerts';
import { isKnownContainer } from './containers';
import { FigureCounter, figureTargets, type Figure } from './figures';
import { normalizeFootnoteLabel } from './footnotes';
import { parseFrontMatter } from './frontmatter';
import { acceptAnyFootnote, mathInline, type ContainerMeta, type TaskBoxMeta } from './markdownItRules';
import { createMarkdownIt, type Env, type Heading, type ResolvedOptions } from './render';
import { CALLOUT_TYPES } from './spec';
import { specVersion, type SpecVersion } from './specVersion';
import type { Variables } from './variables';

/**
 * Incremental parsing for headings and anchor ids: what validation, outlines, the outline view and
 * go to definition need, without rendering HTML.
 *
 * The previous parse of a document is kept as a list of top-level blocks. After an edit, parsing
 * restarts at the top-level block before the first changed line, over a window that grows until a new
 * block starts where an old one did after the last changed line; the old blocks from there on are
 * reused. markdown-it decides every block boundary, and a top-level block parses the same from its
 * first line as in place, so the result equals a full parse:
 * - a window can only cut its last block short (fences, containers and HTML blocks run to its end),
 *   which is left out; display math is the exception, since an unclosed `$$` is not math at all, so
 *   the window always reaches the line that closes each `$$` in it
 * - heading slugs are de-duplicated over the whole document (`#setup`, `#setup-1`)
 * - reference definitions are recorded where markdown-it accepts them; when the set of labels
 *   changes, everything is parsed again, since `## [Title][ref]` reads differently
 */
export interface ParseResult {
  headings: Heading[];
  /** Every id a `#fragment` can point at: heading slugs, `{#id}` attributes and raw HTML ids/names. */
  ids: ReadonlySet<string>;
  frontMatter: Record<string, unknown>;
  /** The `:::figure` blocks in document order, numbered as the rendered HTML numbers them. */
  figures: Figure[];
  /**
   * The lines of code blocks, indented and fenced, nested ones included, as markdown-it reads them:
   * [first, end) zero-based, the end exclusive. Text there is never substituted or styled.
   */
  code: Array<[number, number]>;
  /**
   * The lines of `$$` display math blocks, on one line or several, nested ones included, as markdown-it
   * reads them: [first, end) zero-based, the end exclusive. Math is not text: never substituted or styled.
   */
  math: Array<[number, number]>;
  /**
   * The `$inline math$` on each line of inline text that runs over several lines (a paragraph, a list item's
   * text) and has `$` signs to pair, as rendering reads that text as a whole: zero-based line → [start, end)
   * columns. Math can run from one line to the next, so a span may end a line or start one. Other lines are
   * read on their own (see inlineMathSpans and mathSpansOf).
   */
  inlineMath: ReadonlyMap<number, Array<[number, number]>>;
  /** The spec version the document is read with: its front matter `smd` (see specVersion.ts). */
  spec: SpecVersion;
}

/** A `:::figure` before numbering, with a body-relative line. */
interface FigureSource { id?: string; kind?: string; line: number }

/** A line and the [start, end) columns of the inline math on it. */
type LineSpans = [line: number, spans: Array<[number, number]>];

/** A reference definition markdown-it accepted, and the line it starts on. */
interface Definition { line: number; label: string }

/** One top-level block, with lines relative to the document body. */
interface Block {
  start: number;
  end: number;
  /** Headings, with body-relative lines and slugs not yet de-duplicated. */
  headings: Heading[];
  bases: Array<string | null>;
  /** Ids other than heading ids, outside footnote definitions. */
  ids: string[];
  figures: FigureSource[];
  /** Code blocks in the block (nested ones too), [first, end) with body-relative lines. */
  code: Array<[number, number]>;
  /** Display math blocks in the block (nested ones too), [first, end) with body-relative lines. */
  math: Array<[number, number]>;
  /** Inline math on the lines of inline text that runs over several lines (see ParseResult.inlineMath), body-relative lines. */
  inlineMath: LineSpans[];
  /** The opening lines of the fenced code blocks in the block (nested ones too), body-relative. */
  fences: number[];
  /** Definitions after the previous block, up to the end of this one (inside it too). */
  definitions: Definition[];
  /** Footnote definitions in the block, with the ids inside each: they render only if the footnote does. */
  notes: Array<{ label: string; ids: string[] }>;
  /** Footnote references (`[^label]`, defined or not) in order, with the index in `notes` of the definition they are in, or -1. */
  noteRefs: Array<{ label: string; inside: number }>;
  /** GitHub alerts in the block (inside containers too), body-relative. */
  alerts: AlertLines[];
  /** The lines where task list items have their checkbox (see renderedTaskLines), body-relative. */
  tasks: number[];
  /** The lines of table rows, header and body (see tableRowLines), body-relative. */
  rows: number[];
  /** Inline items that run over several lines (see InlineItem), body-relative lines. */
  items: InlineItem[];
}

/**
 * An inline directive, styled span or `==mark==` whose text runs over several lines, as CommonMark link text may
 * (`:badge[foo` on one line, `bar]{color=green}` on the next). The line-based views convert it as a whole, as
 * rendering reads it, and put each line's part back on its line (see inlineItemLines and convertedParts).
 */
export interface InlineItem {
  /** Its source as the inline parser reads it: the parts on its lines, joined with `\n`. */
  text: string;
  /** Each part in order: its zero-based line and [start, end) columns there. */
  parts: ReadonlyArray<readonly [line: number, start: number, end: number]>;
}

/** The part of a multi-line inline item on one line: [start, end) columns, the item, and which of its parts this is. */
export interface InlinePart { start: number; end: number; item: InlineItem; index: number }

/** A document's multi-line inline items by zero-based line (see inlineItemLines). */
export type InlineItemLines = ReadonlyMap<number, ReadonlyArray<InlinePart>>;

/** A GitHub alert (`> [!NOTE]`, see alerts.ts) by its lines: zero-based, the end exclusive. */
export interface AlertLines {
  /** The blockquote's first line and the line after its last (blank lines after it may count). */
  start: number;
  end: number;
  /** The marker's line. */
  marker: number;
  /** The callout it renders as. */
  callout: string;
}

interface State {
  lines: string[];
  blocks: Block[];
  /** Definitions after the last block. */
  trailing: Definition[];
  /** The label set inline parsing used. */
  refKey: string;
  /** The front matter variables inline parsing used (see documentVariablesOf). */
  vars: ParseVariables;
}

/**
 * Front matter variables for `{{name}}` in headings, so their text matches renderSmd's. `key` is the raw
 * front matter when the body uses `{{` at all, else empty: states are only reused under the same key, so
 * editing the front matter of a document without variables keeps incremental parsing. States are only reused
 * under the same spec version too, since the rules differ.
 */
interface ParseVariables {
  key: string;
  data: Variables;
  spec: SpecVersion;
}

function documentVariablesOf(lines: string[], fm: { data: Record<string, unknown>; bodyStartLine: number }, text: string): ParseVariables {
  const uses = lines.some((l) => l.includes('{{'));
  return { key: uses ? text.split(/\r?\n/, fm.bodyStartLine).join('\n') : '', data: uses ? fm.data : {}, spec: specVersion(fm.data) };
}

const OPTIONS: ResolvedOptions = { allowHtml: true, agentBlocks: 'collapsed', readFile: undefined, today: '' };
let md: MarkdownIt | undefined;
const parser = () => (md ??= recordingInlineItems(recordingInlineMath(recordingDefinitions(inPlaceFootnotes(createMarkdownIt(OPTIONS))))));
/** Container titles render as inline Markdown with raw HTML off (see renderContainer). */
let titleMd: MarkdownIt | undefined;
const titleParser = () => (titleMd ??= createMarkdownIt({ allowHtml: false }));
const TITLED = new Set<string>([...CALLOUT_TYPES, 'details', 'card', 'tab', 'agent', 'human', 'decision', 'risk', 'api', 'figure', 'glossary']);
/** Whether a container renders its title: the ones above, and unknown containers (spec §3). */
const rendersTitle = (name: string): boolean => TITLED.has(name) || !isKnownContainer(name);

/** A `$inline math$` the inline parser accepted: its columns in the text being parsed, and that text's length. */
interface InlineMath { start: number; end: number; length: number }

/**
 * The inline items (directives, styled spans, `==marks==`) the inline parser accepted over a line break, by the text being
 * parsed: [start, end) columns in it.
 */
type ItemsByText = Map<string, Array<[number, number]>>;

type ParseEnv = Env & { definitions: Definition[]; inlineMath?: InlineMath[]; inlineItems?: ItemsByText };

/** The inline rules whose items the line-based views convert (see InlineItem). */
const ITEM_RULES = new Set(['smd_directive', 'smd_span', 'smd_mark']);

/**
 * Wrap the rules of inline directives, styled spans and marks so each item they accept over a line break is recorded
 * with its columns in the text being parsed, for an env that asks (see parseRange).
 */
function recordingInlineItems(instance: MarkdownIt): MarkdownIt {
  const rules = (instance.inline.ruler as unknown as { __rules__: Array<{ name: string; fn: (state: StateInline, silent: boolean) => boolean }> }).__rules__;
  for (const { name, fn } of rules.filter((r) => ITEM_RULES.has(r.name))) {
    instance.inline.ruler.at(name, (state, silent) => {
      const start = state.pos;
      const accepted = fn(state, silent);
      const found = (state.env as ParseEnv).inlineItems;
      if (accepted && !silent && found && state.src.slice(start, state.pos).includes('\n')) {
        const items = found.get(state.src) ?? [];
        if (!items.some(([s, e]) => s === start && e === state.pos)) items.push([start, state.pos]);
        found.set(state.src, items);
      }
      return accepted;
    });
  }
  return instance;
}

/** Wrap the inline math rule so every `$…$` it accepts is recorded with its columns, for an env that asks (see inlineMathSpans). */
function recordingInlineMath(instance: MarkdownIt): MarkdownIt {
  instance.inline.ruler.at('smd_math_inline', (state, silent) => {
    const start = state.pos;
    const accepted = mathInline(state, silent);
    if (accepted && !silent) (state.env as ParseEnv).inlineMath?.push({ start, end: state.pos, length: state.src.length });
    return accepted;
  });
  return instance;
}

/**
 * Wrap the reference rule so every definition markdown-it accepts is recorded with its line, including
 * ones inside containers, lists or quotes. (A label that is already known is not stored again, so the
 * references object alone can't say where definitions are.)
 */
function recordingDefinitions(instance: MarkdownIt): MarkdownIt {
  const rules = (instance.block.ruler as unknown as { __rules__: Array<{ name: string; fn: (...args: unknown[]) => boolean }> }).__rules__;
  const rule = rules.find((r) => r.name === 'reference')!.fn;
  instance.block.ruler.at('reference', (state, startLine, endLine, silent) => {
    const accepted = rule(state, startLine, endLine, silent);
    if (accepted && !silent) {
      const source = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[state.line - 1]);
      const label = /^\[((?:[^\]\\]|\\.)+)\]:/.exec(source);
      if (label) (state.env as ParseEnv).definitions.push({ line: startLine, label: instance.utils.normalizeReference(label[1]) });
    }
    return accepted;
  });
  return instance;
}

/**
 * Keep footnote definitions where they are written instead of moving them to the end: each stays a
 * top-level block at its own lines, so a window parses it the same as the whole document does.
 */
function inPlaceFootnotes(instance: MarkdownIt): MarkdownIt {
  instance.core.ruler.disable('smd_footnote_tail');
  return instance;
}

/** Recent documents: the final results by text, and the block states edits start from. */
const results: Array<{ text: string; result: ParseResult }> = [];
const states: State[] = [];
/** The opening lines of the fenced code blocks of each result (see fenceLines): zero-based, in the whole document. */
const fenceStarts = new WeakMap<ParseResult, number[]>();
/** The GitHub alerts of each result (see alertLines), in the whole document. */
const alertsOf = new WeakMap<ParseResult, AlertLines[]>();

const shiftAlert = (a: AlertLines, delta: number): AlertLines => ({ ...a, start: a.start + delta, end: a.end + delta, marker: a.marker + delta });

/**
 * The GitHub alerts of a document (`> [!NOTE]` blockquotes that render as callouts, see alerts.ts) in document
 * order, with zero-based lines in the whole document, as markdown-it reads them.
 */
export function alertLines(text: string): readonly AlertLines[] {
  return alertsOf.get(parseSmd(text)) ?? [];
}

/** The task lines of each result (see renderedTaskLines), in the whole document. */
const tasksOf = new WeakMap<ParseResult, ReadonlySet<number>>();
/** The multi-line inline items of each result (see inlineItemLines), in the whole document. */
const itemsOf = new WeakMap<ParseResult, InlineItem[]>();

const shiftItem = (item: InlineItem, delta: number): InlineItem =>
  (delta ? { ...item, parts: item.parts.map(([line, start, end]) => [line + delta, start, end] as const) } : item);

/**
 * The zero-based lines where rendering shows a task list item's checkbox (`- [ ] …`, `1. [x] …`), as markdown-it
 * reads them: a task-shaped line in code, in raw HTML or display math, or one that continues a paragraph is not one.
 */
export function renderedTaskLines(text: string): ReadonlySet<number> {
  return tasksOf.get(parseSmd(text)) ?? new Set();
}

/** The table row lines of each result (see tableRowLines), in the whole document. */
const rowsOf = new WeakMap<ParseResult, ReadonlySet<number>>();

/** The zero-based lines of a document's table rows, the header row and body rows (not the delimiter row), as markdown-it reads them. */
export function tableRowLines(text: string): ReadonlySet<number> {
  return rowsOf.get(parseSmd(text)) ?? new Set();
}

/**
 * The parts of a document's inline items that run over several lines (see InlineItem) by zero-based line, plus
 * `offset`, as rendering reads them. Other inline items are on one line and read from it.
 */
export function inlineItemLines(text: string, offset = 0): InlineItemLines {
  const found = new Map<number, InlinePart[]>();
  for (const item of itemsOf.get(parseSmd(text)) ?? []) {
    const moved = shiftItem(item, offset);
    moved.parts.forEach(([line, start, end], index) => found.set(line, [...(found.get(line) ?? []), { start, end, item: moved, index }]));
  }
  return found;
}

/**
 * The parts of multi-line inline items on a line (see inlineItemLines), each with the text `convert` gives its whole
 * item, cut at the item's line breaks: [start, end) columns and that text, for aroundInlineMath. When the converted
 * text has fewer line breaks than the item, the last parts are empty; when it has more, the last part keeps the rest.
 */
export function convertedParts(parts: ReadonlyArray<InlinePart> | undefined, convert: (text: string) => string): Array<[number, number, string]> {
  return (parts ?? []).map((p) => [p.start, p.end, cutLines(convert(p.item.text), p.item.parts.length)[p.index]]);
}

function cutLines(text: string, count: number): string[] {
  const cut = text.split('\n');
  if (cut.length > count) return [...cut.slice(0, count - 1), cut.slice(count - 1).join(' ')];
  while (cut.length < count) cut.push('');
  return cut;
}

/** Forget every cached parse. For tests: the next parse of each document is a full one. */
export function resetParseCache(): void {
  results.length = 0;
  states.length = 0;
}

export function parseSmd(text: string): ParseResult {
  const hit = results.find((r) => r.text === text);
  if (hit) return hit.result;

  const fm = parseFrontMatter(text);
  // markdown-it treats a lone \r as a line break, but line numbers everywhere else split on \r?\n.
  // A space keeps them in step, as in renderSmd.
  let lines = text.split(/\r?\n/).slice(fm.bodyStartLine);
  if (text.includes('\r')) lines = lines.map((l) => l.replace(/\r/g, ' '));
  const state = update(lines, documentVariablesOf(lines, fm, text));

  const headings: Heading[] = [];
  const ids = new Set<string>();
  const slugs = new Map<string, number>();
  for (const block of state.blocks) {
    block.headings.forEach((h, i) => {
      // The same de-duplication as a full parse: explicit ids don't count, repeats get -1, -2…
      const base = block.bases[i];
      let slug = h.slug;
      if (base !== null) {
        const n = slugs.get(base) ?? 0;
        slugs.set(base, n + 1);
        slug = n ? `${base}-${n}` : base;
      }
      headings.push({ ...h, slug, line: h.line + fm.bodyStartLine });
      ids.add(slug);
    });
    for (const id of block.ids) ids.add(id);
  }
  for (const id of footnoteIds(state.blocks)) ids.add(id);
  // The document header renders the title and summary as inline Markdown.
  for (const key of ['title', 'summary']) {
    const value = fm.data[key];
    if (typeof value === 'string') collectIds(parser().parseInline(value, newEnv(0, labelsOf(state), {}, state.vars.spec)), ids, false, state.vars.spec);
  }

  const inDocument = ([start, end]: [number, number]): [number, number] => [start + fm.bodyStartLine, end + fm.bodyStartLine];
  const code = state.blocks.flatMap((b) => b.code).map(inDocument);
  const math = state.blocks.flatMap((b) => b.math).map(inDocument);
  const inlineMath = new Map(state.blocks.flatMap((b) => b.inlineMath).map(([line, spans]) => [line + fm.bodyStartLine, spans]));
  const result: ParseResult = {
    headings, ids, frontMatter: fm.data, figures: numberFigures(state.blocks, fm.bodyStartLine), code, math, inlineMath, spec: state.vars.spec,
  };
  fenceStarts.set(result, state.blocks.flatMap((b) => b.fences).map((line) => line + fm.bodyStartLine));
  alertsOf.set(result, state.blocks.flatMap((b) => b.alerts).map((a) => shiftAlert(a, fm.bodyStartLine)));
  tasksOf.set(result, new Set(state.blocks.flatMap((b) => b.tasks).map((line) => line + fm.bodyStartLine)));
  rowsOf.set(result, new Set(state.blocks.flatMap((b) => b.rows).map((line) => line + fm.bodyStartLine)));
  itemsOf.set(result, state.blocks.flatMap((b) => b.items).map((item) => shiftItem(item, fm.bodyStartLine)));
  results.unshift({ text, result });
  results.length = Math.min(results.length, 3);
  return result;
}

/** A document's figures by the line of their opening fence and by id (the first figure with an id wins). */
export interface FigureIndex {
  byLine: ReadonlyMap<number, Figure>;
  byId: ReadonlyMap<string, Figure>;
}

export function figureIndex(text: string): FigureIndex {
  const figures = parseSmd(text).figures;
  return { byLine: new Map(figures.map((f) => [f.line, f])), byId: figureTargets(figures) };
}

/** The zero-based lines of a document that are code (see ParseResult.code), plus `offset`. */
export function codeLines(text: string, offset = 0): Set<number> {
  return linesIn(parseSmd(text).code, offset);
}

/**
 * The zero-based lines of a document that open fenced code (```` ``` ````, `~~~`), nested ones included, as markdown-it
 * reads them: a fence-shaped line in other code, in display math or in raw HTML opens nothing.
 */
export function fenceLines(text: string): Set<number> {
  return new Set(fenceStarts.get(parseSmd(text)));
}

/**
 * A test for a set of lines that is only computed when first asked, e.g. `lazyLineSet(() => codeLines(text))`:
 * a scan that asks only about lines of a rare shape parses nothing for a document without them.
 */
export function lazyLineSet(lines: () => ReadonlySet<number>): (line: number) => boolean {
  let set: ReadonlySet<number> | undefined;
  return (line) => (set ??= lines()).has(line);
}

/**
 * The zero-based lines of a document that are shown as written, plus `offset`: code and display math
 * (see ParseResult.code and ParseResult.math). Nothing on them is inline syntax or a `{{name}}`.
 */
export function literalLines(text: string, offset = 0): Set<number> {
  const { code, math } = parseSmd(text);
  return linesIn([...code, ...math], offset);
}

/**
 * The `$inline math$` on one line of text, as the inline parser reads that line: [start, end) columns, the
 * `$` signs included. It is the rule rendering uses, after the rules that come first: `\$` is escaped,
 * `$5 and $10` is text, and a `$` in a code span, a link destination or an HTML tag opens nothing.
 */
export function inlineMathSpans(line: string): Array<[number, number]> {
  // Math needs an opening and a closing `$`.
  if (line.indexOf('$') === line.lastIndexOf('$')) return [];
  const env = newEnv(0, []);
  const found: InlineMath[] = [];
  env.inlineMath = found;
  parser().parseInline(line, env);
  // Text that is parsed apart from the line, such as an image's alt text, has columns of its own.
  return found
    .filter((m) => m.length === line.length && line[m.start] === '$' && line[m.end - 1] === '$')
    .map((m): [number, number] => [m.start, m.end]);
}

/** A document's `$inline math$` by zero-based line: [start, end) columns, `$` signs included where they are on the line. */
export type InlineMathLines = ReadonlyMap<number, ReadonlyArray<[number, number]>>;

/**
 * The `$inline math$` of the lines of a document whose inline text runs over several lines, as rendering reads that
 * text, plus `offset` (see ParseResult.inlineMath). Other lines are read on their own: see mathOnLine.
 */
export function inlineMathLines(text: string, offset = 0): InlineMathLines {
  const found = parseSmd(text).inlineMath;
  return offset ? new Map([...found].map(([line, spans]) => [line + offset, spans])) : found;
}

/** The `$inline math$` on one line of a document: from `lines` (see inlineMathLines) when listed there, else read from `text`. */
export function mathOnLine(lines: InlineMathLines, line: number, text: string): ReadonlyArray<[number, number]> {
  return lines.get(line) ?? inlineMathSpans(text);
}

/** Private-use characters: each stands for one math span while a line is converted. */
const MARKS = /[-]/g;
const FIRST_MARK = 0xe000;

/**
 * `convert` applied to a line of text with its `$inline math$` set aside, then put back as written: math is
 * not text, so nothing in it is inline syntax or a `{{name}}`. Each span is one character while the line is
 * converted, so syntax around math (`==a $x$ b==`) still converts. A line without math goes to `convert` as it is.
 * `known` gives the spans when the line's text is read with the lines around it (see mathOnLine); else they are read from the line.
 * `replaced` are parts of the line already converted, [start, end) columns and their text (see convertedParts): they are
 * set aside the same way and put back as that text.
 */
export function aroundInlineMath(
  line: string, convert: (text: string) => string, known?: ReadonlyArray<[number, number]>, replaced: ReadonlyArray<[number, number, string]> = [],
): string {
  if (line.search(MARKS) >= 0) return convert(line);
  // Math inside a converted part was read with the whole item.
  const apart = ([start, end]: readonly [number, number]) => replaced.every(([s, e]) => end <= s || start >= e);
  const math = (known ?? inlineMathSpans(line)).filter(apart).map(([start, end]): [number, number, string] => [start, end, line.slice(start, end)]);
  const spans = [...math, ...replaced].sort((a, b) => a[0] - b[0]);
  if (!spans.length) return convert(line);
  let masked = '';
  let last = 0;
  spans.forEach(([start, end], i) => {
    masked += line.slice(last, start) + String.fromCodePoint(FIRST_MARK + i);
    last = end;
  });
  const restore = (mark: string) => spans[(mark.codePointAt(0) ?? 0) - FIRST_MARK]?.[2] ?? mark;
  return convert(masked + line.slice(last)).replaceAll(MARKS, restore);
}

function linesIn(ranges: Array<[number, number]>, offset: number): Set<number> {
  const lines = new Set<number>();
  for (const [start, end] of ranges) {
    for (let line = start; line < end; line++) lines.add(line + offset);
  }
  return lines;
}

/** Every block's figures in order, numbered per kind, with lines in the whole document. */
function numberFigures(blocks: Block[], bodyStart: number): Figure[] {
  const counter = new FigureCounter();
  return blocks.flatMap((b) => b.figures).map((f) => ({ ...counter.next(f.kind), ...(f.id ? { id: f.id } : {}), line: f.line + bodyStart }));
}

const labelsOf = (state: Pick<State, 'blocks' | 'trailing'>): string[] =>
  [...new Set([...state.blocks.flatMap((b) => b.definitions), ...state.trailing].map((d) => d.label))].sort();

/** The block state for `lines`: an incremental update of the closest recent state, or a full parse. */
function update(lines: string[], vars: ParseVariables): State {
  let best: { state: State; prefix: number; suffix: number } | undefined;
  for (const state of states.filter((s) => s.vars.key === vars.key && s.vars.spec === vars.spec)) {
    const prefix = commonPrefix(state.lines, lines);
    const suffix = commonSuffix(state.lines, lines, prefix);
    if (!best || prefix + suffix > best.prefix + best.suffix) best = { state, prefix, suffix };
  }
  let next = best && best.prefix + best.suffix > 0 ? incremental(best.state, lines, best.prefix, best.suffix) : undefined;
  if (next && labelsOf(next).join('\u0001') !== next.refKey) next = full(lines, vars, labelsOf(next)); // labels changed
  next ??= full(lines, vars);
  const i = best ? states.indexOf(best.state) : -1;
  if (i >= 0) states.splice(i, 1); // the old state of this document is replaced
  states.unshift(next);
  states.length = Math.min(states.length, 3);
  return next;
}

/** Parse everything. Inline parsing needs every reference label, so repeat once if new ones turn up. */
function full(lines: string[], vars: ParseVariables, labels: string[] = []): State {
  for (;;) {
    const parsed = parseRange(lines, 0, lines.length, { labels, vars: vars.data, spec: vars.spec }, true);
    const state: State = { lines, ...parsed, refKey: labels.join('\u0001'), vars };
    const found = labelsOf(state);
    if (found.join('\u0001') === state.refKey) return state;
    labels = found;
  }
}

function incremental(old: State, lines: string[], prefix: number, suffix: number): State | undefined {
  const delta = lines.length - old.lines.length;
  const damageEnd = lines.length - suffix; // first unchanged line after the edit, in new lines
  // Restart at the last block that starts before the changed line (the edit may extend or end it), or
  // earlier when a `$$` above is closed by a line at or after the edit (or not at all): adding or removing
  // that closing line decides whether the opener starts math.
  // An opener is closed by the next line ending with `$$`, so only openers from the last such line
  // before the edit onward can depend on it.
  let limit = prefix;
  let lastClose = prefix - 1;
  while (lastClose >= 0 && !lines[lastClose].trimEnd().endsWith('$$')) lastClose--;
  for (let p = Math.max(0, lastClose); p < prefix; p++) {
    if (isMathOpener(lines[p])) { limit = p + 1; break; }
  }
  let k = -1;
  for (let i = 0; i < old.blocks.length && old.blocks[i].start < limit; i++) k = i;
  const from = k >= 0 ? old.blocks[k].start : 0;
  // Definitions between the previous block and the restart point are unchanged.
  const carried = k >= 0 ? old.blocks[k].definitions.filter((d) => d.line < from) : [];
  const oldStarts = new Map(old.blocks.map((b, i) => [b.start, i]));
  const labels = old.refKey ? old.refKey.split('\u0001') : [];
  const kept = old.blocks.slice(0, Math.max(0, k));

  let to = Math.min(lines.length, damageEnd + 64);
  for (;;) {
    const atEnd = to === lines.length;
    const parsed = parseRange(lines, from, to, { labels, vars: old.vars.data, spec: old.vars.spec }, atEnd, carried);
    if (atEnd) return { lines, blocks: [...kept, ...parsed.blocks], trailing: parsed.trailing, refKey: old.refKey, vars: old.vars };
    const grow = () => Math.min(lines.length, Math.max(parsed.mathHorizon, to + Math.max(256, (to - from) * 2)));
    // A `$$` the window couldn't close may be math in the full document: parse up to its closing line.
    if (parsed.mathHorizon > to) { to = grow(); continue; }
    // The first new block after the edit that starts where an old block did is where they rejoin.
    const join = parsed.blocks.findIndex((b) => b.start >= damageEnd && oldStarts.has(b.start - delta));
    if (join >= 0) {
      const at = parsed.blocks[join];
      const rest = old.blocks.slice(oldStarts.get(at.start - delta)!).map((b) => shift(b, delta));
      rest[0] = { ...rest[0], definitions: at.definitions };
      return { lines, blocks: [...kept, ...parsed.blocks.slice(0, join), ...rest], trailing: old.trailing.map((d) => ({ ...d, line: d.line + delta })), refKey: old.refKey, vars: old.vars };
    }
    to = grow();
  }
}

/**
 * A line that may open multi-line display math (see mathBlock in render.ts). Any indentation or quote
 * prefix counts, since math can open inside lists and quotes: a false positive only widens a window.
 */
function isMathOpener(line: string): boolean {
  const text = line.replace(/^[\s>]*/, '');
  if (!text.startsWith('$$')) return false;
  const rest = text.slice(2);
  return !(rest.trimEnd().endsWith('$$') && rest.trim().length > 2);
}

function shift(block: Block, delta: number): Block {
  if (!delta) return block;
  return {
    ...block,
    start: block.start + delta,
    end: block.end + delta,
    headings: block.headings.map((h) => ({ ...h, line: h.line + delta })),
    figures: block.figures.map((f) => ({ ...f, line: f.line + delta })),
    code: block.code.map(([start, end]) => [start + delta, end + delta]),
    math: block.math.map(([start, end]) => [start + delta, end + delta]),
    inlineMath: block.inlineMath.map(([line, spans]) => [line + delta, spans]),
    fences: block.fences.map((line) => line + delta),
    definitions: block.definitions.map((d) => ({ ...d, line: d.line + delta })),
    alerts: block.alerts.map((a) => shiftAlert(a, delta)),
    tasks: block.tasks.map((line) => line + delta),
    rows: block.rows.map((line) => line + delta),
    items: block.items.map((item) => shiftItem(item, delta)),
  };
}

/**
 * Parse lines [from, to) into top-level blocks. Unless `complete`, the range may cut the last block
 * short, so it is left out; blocks before it ended within the range and are exact.
 */
function parseRange(
  lines: string[], from: number, to: number, scope: { labels: string[]; vars: Variables; spec: SpecVersion }, complete: boolean, carried: Definition[] = [],
): { blocks: Block[]; trailing: Definition[]; mathHorizon: number } {
  const env = newEnv(from, scope.labels, scope.vars, scope.spec);
  acceptAnyFootnote(env); // which labels are defined is known once every block is (footnoteIds)
  const items: ItemsByText = new Map();
  env.inlineItems = items;
  const tokens = parser().parse(lines.slice(from, to).join('\n'), env);
  const definitions = [...carried, ...env.definitions.map((d) => ({ ...d, line: d.line + from }))];

  // `$$` lines that did not become math and are not inside code, HTML or math: display math the window
  // couldn't close. If a line after the window closes one, the window must reach it.
  let mathHorizon = 0;
  if (!complete) {
    const skip: Array<[number, number]> = tokens
      .filter((t) => t.map && ['smd_math_block', 'fence', 'code_block', 'html_block'].includes(t.type))
      .map((t) => [from + t.map![0], from + t.map![1]]);
    for (let p = from; p < to; p++) {
      if (!isMathOpener(lines[p]) || skip.some(([a, b]) => p >= a && p < b)) continue;
      let close = p + 1;
      while (close < lines.length && !lines[close].trimEnd().endsWith('$$')) close++;
      if (close >= to && close < lines.length) mathHorizon = Math.max(mathHorizon, close + 1);
    }
  }

  // Group tokens by top-level block: each starts with a level-0 token that has a source map.
  const groups: Array<{ start: number; end: number; tokens: Token[] }> = [];
  for (const t of tokens) {
    if (t.level === 0 && t.nesting !== -1 && t.map) groups.push({ start: from + t.map[0], end: from + t.map[1], tokens: [] });
    groups[groups.length - 1]?.tokens.push(t);
  }
  if (!complete) groups.pop();

  const blocks: Block[] = [];
  let h = 0;
  let d = 0;
  for (const g of groups) {
    const block: Block = {
      start: g.start, end: g.end, headings: [], bases: [], ids: [], figures: figuresIn(g.tokens, from), code: linesOf(g.tokens, from, CODE_TOKENS),
      math: linesOf(g.tokens, from, MATH_TOKENS), inlineMath: multiLineMath(g.tokens, lines, from),
      fences: linesOf(g.tokens, from, ['fence']).map(([first]) => first), definitions: [], notes: [], noteRefs: [], alerts: alertsIn(g.tokens, from),
      tasks: taskLinesIn(g.tokens, from), rows: linesOf(g.tokens, from, ['tr_open']).map(([first]) => first), items: multiLineItems(g.tokens, lines, from, items),
    };
    while (h < env.headings.length && env.headings[h].line < g.end) {
      if (env.headings[h].line >= g.start) { block.headings.push(env.headings[h]); block.bases.push(env.bases![h]); }
      h++;
    }
    while (d < definitions.length && definitions[d].line < g.end) block.definitions.push(definitions[d++]);
    collectBlockIds(g.tokens, block, scope.spec);
    blocks.push(block);
  }
  return { blocks, trailing: complete ? definitions.slice(d) : [], mathHorizon };
}

/** A block's ids, footnote definitions and references; ids inside a definition go with it. */
function collectBlockIds(tokens: Token[], block: Block, spec: SpecVersion): void {
  const open: number[] = [];
  for (const t of tokens) {
    if (t.type === 'smd_footnote_definition_open') {
      open.push(block.notes.push({ label: (t.meta as { label: string }).label, ids: [] }) - 1);
      continue;
    }
    if (t.type === 'smd_footnote_definition_close') {
      open.pop();
      continue;
    }
    const inside = open[open.length - 1] ?? -1;
    collectIds([t], inside < 0 ? block.ids : block.notes[inside].ids, true, spec);
    block.noteRefs.push(...noteRefsIn(t, inside));
  }
}

const noteRefsIn = (t: Token, inside: number): Block['noteRefs'] => (t.children ?? [])
  .filter((c) => c.type === 'smd_footnote_ref')
  .map((c) => ({ label: normalizeFootnoteLabel(c.content.slice(2, -1)), inside }));

/**
 * The ids footnotes render (see footnoteTail): `fn-N` for each referenced footnote, numbered by first
 * reference, `fnref-N` and `fnref-N-K` for each reference, the hidden `footnote-label` heading, and the
 * ids inside definitions that are shown. References to undefined labels are text; a definition is shown
 * when it is the first for its label and referenced, and references inside other definitions vanish with them.
 */
function footnoteIds(blocks: Block[]): string[] {
  const { notes, refs } = documentNotes(blocks);
  const defined = new Set(notes.map((n) => n.label));
  const used = new Map<string, { n: number; count: number }>();
  const refIds: Array<{ id: string; inside: number }> = [];
  for (const r of refs.filter((ref) => defined.has(ref.label))) {
    const use = used.get(r.label) ?? { n: used.size + 1, count: 0 };
    used.set(r.label, use);
    use.count++;
    refIds.push({ id: use.count > 1 ? `fnref-${use.n}-${use.count}` : `fnref-${use.n}`, inside: r.inside });
  }
  const first = new Map<string, number>();
  notes.forEach((note, i) => { if (!first.has(note.label)) first.set(note.label, i); });
  const shown = (i: number) => i < 0 || (first.get(notes[i].label) === i && used.has(notes[i].label));
  return [
    ...(used.size ? ['footnote-label'] : []),
    ...[...used.keys()].map((_, i) => `fn-${i + 1}`),
    ...refIds.filter((r) => shown(r.inside)).map((r) => r.id),
    ...notes.filter((_, i) => shown(i)).flatMap((note) => note.ids),
  ];
}

/** Every block's footnote definitions and references, with `inside` indexing the whole list. */
function documentNotes(blocks: Block[]): { notes: Block['notes']; refs: Block['noteRefs'] } {
  const notes: Block['notes'] = [];
  const refs: Block['noteRefs'] = [];
  for (const block of blocks) {
    const base = notes.length;
    notes.push(...block.notes);
    refs.push(...block.noteRefs.map((r) => ({ label: r.label, inside: r.inside < 0 ? -1 : r.inside + base })));
  }
  return { notes, refs };
}

function newEnv(lineOffset: number, labels: Iterable<string>, smdVariables: Variables = {}, smdSpec: SpecVersion = 1): ParseEnv {
  const references: Record<string, unknown> = {};
  for (const label of labels) references[label] = { href: '', title: '' };
  // Blocks are parsed apart from the front matter, so its variables and spec version come along explicitly (never from the source).
  return { lineOffset, headings: [], slugs: new Map(), options: OPTIONS, bases: [], references, definitions: [], smdVariables, smdSpec };
}

/** The `:::figure` openers among a block's tokens (nested ones too), with body-relative lines. */
function figuresIn(tokens: Token[], from: number): FigureSource[] {
  return tokens
    .filter((t) => t.type === 'container_smd_open' && (t.meta as ContainerMeta | null)?.name === 'figure')
    .map((t) => {
      const meta = t.meta as ContainerMeta;
      return { id: meta.attrs.id, kind: meta.attrs.values.kind, line: from + (t.map?.[0] ?? 0) };
    });
}

/** The GitHub alerts among a block's tokens, body-relative. */
function alertsIn(tokens: Token[], from: number): AlertLines[] {
  return tokens.flatMap((t) => {
    const alert = t.type === 'blockquote_open' && t.map ? alertOf(t) : undefined;
    return alert ? [{ start: from + t.map![0], end: from + t.map![1], marker: from + alert.markerLine, callout: alert.name }] : [];
  });
}

/** Indented and fenced code blocks. */
const CODE_TOKENS = ['code_block', 'fence'];
/** `$$` display math blocks. */
const MATH_TOKENS = ['smd_math_block'];

/** The lines of the tokens of these types among a block's tokens, nested ones too, body-relative. */
function linesOf(tokens: Token[], from: number, types: string[]): Array<[number, number]> {
  return tokens
    .filter((t) => t.map && types.includes(t.type))
    .map((t): [number, number] => [from + t.map![0], from + t.map![1]]);
}

/**
 * Inline math on the lines of each inline token (nested ones too) whose text runs over several lines and has `$`
 * signs to pair, with body-relative lines: the text is read as a whole, as rendering reads it (see ParseResult.inlineMath).
 */
function multiLineMath(tokens: Token[], lines: string[], from: number): LineSpans[] {
  return tokens
    .filter((t) => t.type === 'inline' && t.map && t.content.includes('\n') && t.content.indexOf('$') !== t.content.lastIndexOf('$'))
    .flatMap((t) => inlineTextMath(t.content, lines, from + t.map![0]));
}

/**
 * The inline math of inline text whose lines are the source lines from `first` on, each without what comes before
 * it there (indentation, a list marker, `>`) and the last without trailing spaces. Each span is cut at the line
 * ends it runs over. Nothing when a line of the text is not such a cut of its source line.
 */
function inlineTextMath(content: string, lines: string[], first: number): LineSpans[] {
  const text = inlineTextLines(content, lines, first);
  if (!text) return [];
  const spans = text.parts.map((): Array<[number, number]> => []);
  for (const [start, end] of inlineMathSpans(content)) {
    for (const [line, lo, hi] of spanOnLines(text, start, end)) if (lo < hi) spans[line - first].push([lo, hi]);
  }
  return spans.map((s, k): LineSpans => [first + k, s]);
}

/** Inline text read from source lines (see inlineTextMath): its lines, where each starts in it and in its source line. */
interface InlineTextLines { first: number; parts: string[]; starts: number[]; columns: number[] }

/** The lines of inline text whose lines are the source lines from `first` on (see inlineTextMath), or undefined. */
function inlineTextLines(content: string, lines: string[], first: number): InlineTextLines | undefined {
  const parts = content.split('\n');
  const columns = parts.map((part, k) => cutAt(lines[first + k] ?? '', part));
  if (columns.includes(-1)) return undefined;
  const starts: number[] = [];
  let at = 0;
  for (const part of parts) {
    starts.push(at);
    at += part.length + 1;
  }
  return { first, parts, starts, columns };
}

/** A [start, end) span of inline text on each source line it runs over: the line and [start, end) columns there. */
function spanOnLines(text: InlineTextLines, start: number, end: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  text.parts.forEach((part, k) => {
    const lo = Math.max(start, text.starts[k]);
    const hi = Math.min(end, text.starts[k] + part.length);
    // A line the span reaches (an empty part where it starts or ends at a line break too).
    if (start <= text.starts[k] + part.length && end > text.starts[k]) out.push([text.first + k, text.columns[k] + lo - text.starts[k], text.columns[k] + hi - text.starts[k]]);
  });
  return out;
}

/**
 * The inline items of a block's inline tokens (nested ones too) that run over several lines, as the inline parser
 * accepted them (`found`, by the text parsed), with body-relative lines. An item inside another is converted with it.
 */
function multiLineItems(tokens: Token[], lines: string[], from: number, found: ItemsByText): InlineItem[] {
  if (!found.size) return [];
  return tokens.filter((t) => t.type === 'inline' && t.map && found.has(t.content)).flatMap((t) => {
    const text = inlineTextLines(t.content, lines, from + t.map![0]);
    const spans = found.get(t.content)!;
    const outer = spans.filter(([s, e]) => !spans.some(([s2, e2]) => s2 <= s && e <= e2 && e2 - s2 > e - s));
    return text ? outer.map(([s, e]) => ({ text: t.content.slice(s, e), parts: spanOnLines(text, s, e) })) : [];
  });
}

/** The lines of a block's task list items (see renderedTaskLines): the first line of each task's text, body-relative. */
function taskLinesIn(tokens: Token[], from: number): number[] {
  return tokens.flatMap((t) => (t.type === 'inline' && t.map && (t.children?.[0]?.meta as TaskBoxMeta | null)?.taskBox ? [from + t.map[0]] : []));
}

/** The column where `part` starts as the end of `source` (or of `source` without trailing spaces), or -1. */
function cutAt(source: string, part: string): number {
  if (source.endsWith(part)) return source.length - part.length;
  const trimmed = source.trimEnd();
  return trimmed.endsWith(part) ? trimmed.length - part.length : -1;
}

function collectIds(tokens: Token[], out: Set<string> | string[], skipHeadings = false, spec: SpecVersion = 1): void {
  const add = (id: string) => (out instanceof Set ? out.add(id) : out.push(id));
  for (const t of tokens) {
    const id = t.attrGet('id');
    if (id && !(skipHeadings && t.type === 'heading_open')) add(id);
    const meta = t.meta as { name?: string; title?: string; attrs?: { id?: string } } | null;
    if (t.type === 'container_smd_open') {
      if (meta?.attrs?.id) add(meta.attrs.id);
      if (meta?.title && rendersTitle(meta.name ?? '')) collectIds(titleParser().parseInline(meta.title, newEnv(0, [], {}, spec)), out, false, spec);
    }
    if (t.type === 'html_block' || t.type === 'html_inline') {
      for (const m of t.content.matchAll(/\s(?:id|name)="([^"]*)"/g)) add(unescapeHtml(m[1]));
    }
    if (t.children) collectIds(t.children, out, skipHeadings, spec);
  }
}

function unescapeHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function commonPrefix(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string[], b: string[], prefix: number): number {
  const n = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
