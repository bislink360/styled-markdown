import type MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';
import { FigureCounter, figureTargets, type Figure } from './figures';
import { normalizeFootnoteLabel } from './footnotes';
import { parseFrontMatter } from './frontmatter';
import { acceptAnyFootnote, type ContainerMeta } from './markdownItRules';
import { createMarkdownIt, type Env, type Heading, type ResolvedOptions } from './render';
import { CALLOUT_TYPES } from './spec';
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
}

/** A `:::figure` before numbering, with a body-relative line. */
interface FigureSource { id?: string; kind?: string; line: number }

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
  /** Definitions after the previous block, up to the end of this one (inside it too). */
  definitions: Definition[];
  /** Footnote definitions in the block, with the ids inside each: they render only if the footnote does. */
  notes: Array<{ label: string; ids: string[] }>;
  /** Footnote references (`[^label]`, defined or not) in order, with the index in `notes` of the definition they are in, or -1. */
  noteRefs: Array<{ label: string; inside: number }>;
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
 * editing the front matter of a document without variables keeps incremental parsing.
 */
interface ParseVariables {
  key: string;
  data: Variables;
}

function documentVariablesOf(lines: string[], fm: { data: Record<string, unknown>; bodyStartLine: number }, text: string): ParseVariables {
  const uses = lines.some((l) => l.includes('{{'));
  return { key: uses ? text.split(/\r?\n/, fm.bodyStartLine).join('\n') : '', data: uses ? fm.data : {} };
}

const OPTIONS: ResolvedOptions = { allowHtml: true, agentBlocks: 'collapsed', readFile: undefined, today: '' };
let md: MarkdownIt | undefined;
const parser = () => (md ??= recordingDefinitions(inPlaceFootnotes(createMarkdownIt(OPTIONS))));
/** Container titles render as inline Markdown with raw HTML off (see renderContainer). */
let titleMd: MarkdownIt | undefined;
const titleParser = () => (titleMd ??= createMarkdownIt({ allowHtml: false }));
const TITLED = new Set<string>([...CALLOUT_TYPES, 'details', 'card', 'tab', 'agent', 'human', 'decision', 'risk', 'api', 'figure', 'glossary']);

type ParseEnv = Env & { definitions: Definition[] };

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
    if (typeof value === 'string') collectIds(parser().parseInline(value, newEnv(0, labelsOf(state))), ids);
  }

  const code = state.blocks.flatMap((b) => b.code).map(([start, end]): [number, number] => [start + fm.bodyStartLine, end + fm.bodyStartLine]);
  const result: ParseResult = { headings, ids, frontMatter: fm.data, figures: numberFigures(state.blocks, fm.bodyStartLine), code };
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
  const lines = new Set<number>();
  for (const [start, end] of parseSmd(text).code) {
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
  for (const state of states.filter((s) => s.vars.key === vars.key)) {
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
    const parsed = parseRange(lines, 0, lines.length, { labels, vars: vars.data }, true);
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
    const parsed = parseRange(lines, from, to, { labels, vars: old.vars.data }, atEnd, carried);
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
    definitions: block.definitions.map((d) => ({ ...d, line: d.line + delta })),
  };
}

/**
 * Parse lines [from, to) into top-level blocks. Unless `complete`, the range may cut the last block
 * short, so it is left out; blocks before it ended within the range and are exact.
 */
function parseRange(
  lines: string[], from: number, to: number, scope: { labels: string[]; vars: Variables }, complete: boolean, carried: Definition[] = [],
): { blocks: Block[]; trailing: Definition[]; mathHorizon: number } {
  const env = newEnv(from, scope.labels, scope.vars);
  acceptAnyFootnote(env); // which labels are defined is known once every block is (footnoteIds)
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
      start: g.start, end: g.end, headings: [], bases: [], ids: [], figures: figuresIn(g.tokens, from), code: codeIn(g.tokens, from), definitions: [], notes: [], noteRefs: [],
    };
    while (h < env.headings.length && env.headings[h].line < g.end) {
      if (env.headings[h].line >= g.start) { block.headings.push(env.headings[h]); block.bases.push(env.bases![h]); }
      h++;
    }
    while (d < definitions.length && definitions[d].line < g.end) block.definitions.push(definitions[d++]);
    collectBlockIds(g.tokens, block);
    blocks.push(block);
  }
  return { blocks, trailing: complete ? definitions.slice(d) : [], mathHorizon };
}

/** A block's ids, footnote definitions and references; ids inside a definition go with it. */
function collectBlockIds(tokens: Token[], block: Block): void {
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
    collectIds([t], inside < 0 ? block.ids : block.notes[inside].ids, true);
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

function newEnv(lineOffset: number, labels: Iterable<string>, smdVariables: Variables = {}): ParseEnv {
  const references: Record<string, unknown> = {};
  for (const label of labels) references[label] = { href: '', title: '' };
  // Blocks are parsed apart from the front matter, so its variables come along explicitly (never from the source).
  return { lineOffset, headings: [], slugs: new Map(), options: OPTIONS, bases: [], references, definitions: [], smdVariables };
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

/** The lines of the indented and fenced code blocks among a block's tokens, nested ones too, body-relative. */
function codeIn(tokens: Token[], from: number): Array<[number, number]> {
  return tokens
    .filter((t) => t.map && (t.type === 'code_block' || t.type === 'fence'))
    .map((t): [number, number] => [from + t.map![0], from + t.map![1]]);
}

function collectIds(tokens: Token[], out: Set<string> | string[], skipHeadings = false): void {
  const add = (id: string) => (out instanceof Set ? out.add(id) : out.push(id));
  for (const t of tokens) {
    const id = t.attrGet('id');
    if (id && !(skipHeadings && t.type === 'heading_open')) add(id);
    const meta = t.meta as { name?: string; title?: string; attrs?: { id?: string } } | null;
    if (t.type === 'container_smd_open') {
      if (meta?.attrs?.id) add(meta.attrs.id);
      if (meta?.title && TITLED.has(meta.name ?? '')) collectIds(titleParser().parseInline(meta.title, newEnv(0, [])), out);
    }
    if (t.type === 'html_block' || t.type === 'html_inline') {
      for (const m of t.content.matchAll(/\s(?:id|name)="([^"]*)"/g)) add(unescapeHtml(m[1]));
    }
    if (t.children) collectIds(t.children, out, skipHeadings);
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
