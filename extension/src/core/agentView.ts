import { parseAttrs } from './attrs';
import { changelogEntries, versionLabel, type ChangelogEntry } from './changelog';
import {
  omissionOrder, omissionPointer, omittableSections, withOmitted, type BudgetResult, type BudgetSection, type Tokenizer,
} from './budget';
import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo, type ContainerInfo } from './containers';
import { parseFenceInfo, sliceLines } from './fence';
import { REF_DIRECTIVE, type Figure, type FigureNumber } from './figures';
import { findFootnotes, type FootnoteDefinition } from './footnotes';
import { parseFrontMatter, asStringList } from './frontmatter';
import {
  includeLabel, includePath, includeProblemText, includeRequest, innerScope, loadInclude, rootScope, type IncludeScope,
} from './include';
import { includedLines, includeSource } from './includeText';
import { figureIndex, parseSmd, type FigureIndex } from './parse';
import { dueState, HEADING_ATTRS, type Heading } from './render';
import { matchesHeading, sectionsOf, type Section } from './sections';
import { quoteCite } from './quote';
import { CALLOUT_TYPES } from './spec';

/**
 * Agent view: a compact, meaning-preserving rendering of an .smd document for LLMs.
 *
 * What it removes (never meaning):  styling syntax, colors, layout wrappers, HTML comments,
 *   image URLs, table padding, :::human blocks, sections marked {agent=skip}, front matter noise.
 * What it keeps verbatim:  headings (with source line refs), prose, lists, tables, code,
 *   :::agent instructions, callouts (as tags), decisions, risks, API endpoints, open tasks.
 * What --brief additionally condenses:  diagrams, long code blocks, :::details, completed tasks.
 */
export interface AgentViewOptions {
  /** Only include these sections (heading text or id, case-insensitive; subsections included). */
  sections?: string[];
  /** Condense diagrams, long code, details blocks and completed tasks. */
  brief?: boolean;
  /** Keep :::human blocks (dropped by default). */
  includeHuman?: boolean;
  /** Append [L12] source line references to headings (default true) so agents can edit precisely. */
  lineRefs?: boolean;
  /** Inline `file="…"` code embeds instead of referencing the path (default false). */
  embed?: boolean;
  /**
   * Show `:::include` blocks as the included text in an `<included file="…">` block (default true; needs
   * `readFile`). False: a one-line pointer to the file instead, to save tokens.
   */
  includes?: boolean;
  /** Reads code embeds and includes, relative to the document. */
  readFile?: (relativePath: string) => string | undefined;
  today?: string;
  /**
   * Shrink the view to at most this many tokens: condense it as `brief` does, then omit whole sections
   * in priority order, each replaced by a one-line pointer (see budget.ts). Counted with `tokenizer` when given.
   */
  maxTokens?: number;
  /** An exact tokenizer: adds `counted` to the result, counts `maxTokens`, and adds counts to outlines. */
  tokenizer?: Tokenizer;
  /** The document's path, used in pointers to omitted sections (default `<file>`). */
  file?: string;
}

export interface AgentViewResult {
  text: string;
  /** Approximate token counts (≈ characters / 4). */
  originalTokens: number;
  tokens: number;
  /** Sections requested but not found. */
  missingSections: string[];
  /** Headings omitted because they are marked {agent=skip}. */
  skippedSections: string[];
  /** Counts by `tokenizer`, when one is given. */
  counted?: { tokenizer: string; tokens: number; originalTokens: number };
  /** What was done to fit `maxTokens`, when it is given. */
  budget?: BudgetResult;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** `:::risk-matrix` in the agent view: a pointer, since every risk it shows is already a `<risk>` block. */
function riskMatrixPointer(title: string): string {
  const label = title ? `risk matrix: ${title}` : 'risk matrix';
  return `[${label} — impact × likelihood of this document's risks except closed ones; each is a <risk> block]`;
}

/** What a container's opening line becomes: a line to emit, and a line that closes it. */
interface ContainerHead { line?: string; close?: string }

interface HeadSource {
  /** The title as plain words. */
  title: string;
  values: Record<string, string>;
  id?: string;
  /** The `:::figure` that opens on this line. */
  figure?: Figure;
}

const titleAttr = (title: string) => (title ? ` title="${title}"` : '');
const titleAfter = (title: string, sep = ' ') => (title ? `${sep}${title}` : '');
const attrList = (values: Record<string, string>, keys: string[]) => keys.filter((k) => values[k]).map((k) => ` ${k}="${values[k]}"`).join('');

/** `<tag title="…">` … `</tag>` */
const tagged = (tag: string) => ({ title }: HeadSource): ContainerHead => ({ line: `<${tag}${titleAttr(title)}>`, close: `</${tag}>` });

function apiHead({ title, values: v }: HeadSource): ContainerHead {
  return { line: `API ${(v.method ?? 'GET').toUpperCase()} ${v.path ?? ''}${titleAfter(title, ' — ')}${v.auth ? ` (auth: ${v.auth})` : ''}` };
}

/** `<figure id="fig-checkout"> Figure 1: Caption` … `</figure>`, numbered as the rendered document numbers it. */
function figureHead({ title, id, figure }: HeadSource): ContainerHead {
  const label = (figure?.label ?? 'Figure') + titleAfter(title, ': ');
  return { line: `<figure${id ? ` id="${id}"` : ''}> ${label}`, close: '</figure>' };
}

/** `<quote author="…" source="…" cite="…">` … `</quote>`: attribution as plain words, and only a cite URL that renders. */
function quoteHead({ values }: HeadSource): ContainerHead {
  const plainValues = { author: inlineText(values.author ?? '').trim(), source: inlineText(values.source ?? '').trim(), cite: quoteCite(values.cite) ?? '' };
  return { line: `<quote${attrList(plainValues, ['author', 'source', 'cite'])}>`, close: '</quote>' };
}

/**
 * The agent view of each container's opening line. `:::human` (unless included) and `:::details` in brief
 * views are dropped before this. tabs, columns, column, box, steps, timeline and unknown containers: content only.
 */
const CONTAINER_HEADS = new Map<string, (c: HeadSource) => ContainerHead>([
  ['agent', tagged('agent-instructions')],
  ...CALLOUT_TYPES.map((c) => [c, tagged(c)] as const),
  ['decision', ({ title, values }) => ({ line: `<decision${attrList(values, ['status', 'date', 'owner'])}>${titleAfter(title)}`, close: '</decision>' })],
  ['risk', ({ title, values }) => ({ line: `<risk${attrList(values, ['impact', 'likelihood', 'owner', 'status'])}>${titleAfter(title)}`, close: '</risk>' })],
  ['risk-matrix', ({ title }) => ({ line: riskMatrixPointer(title) })],
  ['api', apiHead],
  ['details', tagged('details')],
  ['human', tagged('human')],
  ['tab', ({ title }) => ({ line: `Tab "${title || 'Tab'}":` })],
  ['card', ({ title }) => (title ? { line: `${title}:` } : {})],
  ['figure', figureHead],
  // Listed once, as written; uses of the terms in the text are not expanded.
  ['glossary', tagged('glossary')],
  // Its entry headings become `## 1.2.0 (2026-03-01)` lines (see entryHeading).
  ['changelog', tagged('changelog')],
  ['quote', quoteHead],
]);

const NOISE_KEYS = new Set(['smd', 'theme', 'accent', 'toc', 'title', 'summary']);

interface ViewScope {
  data: Record<string, unknown>;
  bodyStart: number;
  lines: string[];
  sections: Section[];
  /** Requested sections, or null for the whole document. */
  selected: Section[] | null;
  skipped: Section[];
  missingSections: string[];
  inScope: (line: number) => boolean;
}

/** Which lines of the document are in the view. */
function viewScope(text: string, options: AgentViewOptions): ViewScope {
  const fm = parseFrontMatter(text);
  const lines = text.split(/\r?\n/);
  const sections = sectionsOf(parseSmd(text).headings, lines.length);
  const skipped = sections.filter((s) => s.heading.agent === 'skip');
  const { selected, missingSections } = selectSections(sections, options.sections);
  const inScope = (line: number) =>
    (!selected || selected.some((s) => line >= s.start && line <= s.end)) &&
    !skipped.some((s) => line >= s.start && line <= s.end && !(selected?.some((sel) => sel.heading === s.heading)));
  return { data: fm.data, bodyStart: fm.bodyStartLine, lines, sections, selected, skipped, missingSections, inScope };
}

function selectSections(sections: Section[], queries: string[] | undefined): { selected: Section[] | null; missingSections: string[] } {
  const missingSections: string[] = [];
  if (!queries?.length) return { selected: null, missingSections };
  const selected: Section[] = [];
  for (const q of queries) {
    const hit = sections.filter((s) => matchesHeading(s.heading, q));
    if (hit.length) selected.push(...hit); else missingSections.push(q);
  }
  return { selected, missingSections };
}

interface ViewHead { header: string; external: string; footnotes: string }

/**
 * The header, plus :::agent blocks outside the selected sections (they still apply) and the footnotes
 * the sections reference but that are defined elsewhere.
 */
function viewHead(scope: ViewScope, options: AgentViewOptions): ViewHead {
  const { selected, lines, bodyStart, inScope } = scope;
  let external = '';
  let footnotes = '';
  if (selected) {
    const outside = transform(lines, bodyStart, (l) => !inScope(l), { ...options, onlyAgentBlocks: true });
    if (outside.trim()) external = `Document-wide agent instructions:\n${outside.trim()}\n\n`;
    footnotes = outsideFootnotes(scope, options);
  }
  return { header: header(scope.data, selected ? selected.map((s) => s.heading.text) : null), external, footnotes };
}

/**
 * Footnotes are kept as written: `[^1]` references in the text and `[^1]: …` definitions where they
 * are. An excerpt lists the definitions its references need once after it, unless a skipped section
 * holds them.
 */
function outsideFootnotes(scope: ViewScope, options: AgentViewOptions): string {
  const { definitions, references } = findFootnotes(scope.lines.join('\n'));
  const wanted = new Set(references.filter((r) => scope.inScope(r.line)).map((r) => r.label));
  const first = new Map<string, FootnoteDefinition>();
  for (const d of definitions) if (wanted.has(d.label) && !first.has(d.label)) first.set(d.label, d);
  const inSkipped = (line: number) => scope.skipped.some((s) => line >= s.start && line <= s.end);
  const ranges = [...first.values()].filter((d) => !scope.inScope(d.line) && !inSkipped(d.line)).map((d) => [d.line, d.endLine]);
  if (!ranges.length) return '';
  const view = transform(scope.lines, scope.bodyStart, (l) => ranges.some(([a, b]) => l >= a && l <= b), options);
  return view.trim() ? `Footnotes referenced above:\n${view.trim()}` : '';
}

function assemble(head: ViewHead, body: string): string {
  return [head.header, head.external + body, head.footnotes]
    .filter((s) => s.trim())
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

export function agentView(text: string, options: AgentViewOptions = {}): AgentViewResult {
  const scope = viewScope(text, options);
  if (options.maxTokens !== undefined) return budgetedView(text, scope, options);
  const body = transform(scope.lines, scope.bodyStart, scope.inScope, options);
  return viewResult(text, scope, assemble(viewHead(scope, options), body), options);
}

function viewResult(text: string, scope: ViewScope, out: string, options: AgentViewOptions, budget?: BudgetResult): AgentViewResult {
  const result: AgentViewResult = {
    text: out,
    originalTokens: estimateTokens(text),
    tokens: estimateTokens(out),
    missingSections: scope.missingSections,
    skippedSections: scope.skipped.map((s) => s.heading.text),
  };
  const tokenizer = options.tokenizer;
  if (tokenizer) result.counted = { tokenizer: tokenizer.name, tokens: tokenizer.count(out), originalTokens: tokenizer.count(text) };
  if (budget) result.budget = budget;
  return result;
}

// ---------------------------------------------------------------------------
// Token budget (maxTokens): condense, then omit sections in priority order.
// ---------------------------------------------------------------------------

/** A view before assembly: its head and every emitted body line with the source line it came from. */
interface Draft {
  head: ViewHead;
  lines: Array<[at: number, line: string]>;
  file?: string;
  count: (text: string) => number;
}

function draftOf(scope: ViewScope, options: AgentViewOptions): Draft {
  const lines: Array<[number, string]> = [];
  transform(scope.lines, scope.bodyStart, scope.inScope, { ...options, collect: lines });
  return { head: viewHead(scope, options), lines, file: options.file, count: options.tokenizer?.count ?? estimateTokens };
}

const joinLines = (lines: string[]) => lines.join('\n').replace(/\n{3,}/g, '\n\n');
const inSection = (at: number, s: BudgetSection) => at >= s.start && at <= s.end;

/** The view text of the lines emitted for one section. */
function draftSection(draft: Draft, s: BudgetSection): string {
  return joinLines(draft.lines.filter(([at]) => inSection(at, s)).map(([, line]) => line));
}

function pointerOf(draft: Draft, s: BudgetSection): string {
  return omissionPointer(s, draft.count(draftSection(draft, s)), draft.file);
}

/** The assembled view with the omitted sections (in document order) replaced by pointers. */
function draftText(draft: Draft, omitted: BudgetSection[]): string {
  const body: string[] = [];
  let next = 0;
  for (const [at, line] of draft.lines) {
    while (next < omitted.length && at > omitted[next].end) body.push(pointerOf(draft, omitted[next++]), '');
    if (!omitted.some((s) => inSection(at, s))) body.push(line);
  }
  for (const s of omitted.slice(next)) body.push('', pointerOf(draft, s));
  return assemble(draft.head, joinLines(body));
}

function budgetedView(text: string, scope: ViewScope, options: AgentViewOptions): AgentViewResult {
  const maxTokens = options.maxTokens ?? Infinity;
  let draft = draftOf(scope, options);
  const condensed = !options.brief && draft.count(draftText(draft, [])) > maxTokens;
  if (condensed) draft = draftOf(scope, { ...options, brief: true });
  const omitted = omitToFit(draft, scope, maxTokens);
  const out = draftText(draft, omitted);
  const tokens = draft.count(out);
  const omittedSections = omitted.map((s) => ({
    heading: s.heading.text, level: s.heading.level, line: s.start, endLine: s.end, tokens: draft.count(draftSection(draft, s)),
  }));
  return viewResult(text, scope, out, options, { maxTokens, tokens, fits: tokens <= maxTokens, condensed, omitted: omittedSections });
}

/** Omit sections, least important first, until the view fits or nothing more may be omitted. */
function omitToFit(draft: Draft, scope: ViewScope, maxTokens: number): BudgetSection[] {
  const cost = (s: BudgetSection) => draft.count(draftSection(draft, s));
  // Omitting a section only helps when its content costs more than its pointer.
  const candidates = omittableSections(scope.sections, scope.lines, scope.selected)
    .filter((s) => cost(s) > draft.count(pointerOf(draft, s)));
  let omitted: BudgetSection[] = [];
  for (const s of omissionOrder(candidates, scope.lines, cost)) {
    if (draft.count(draftText(draft, omitted)) <= maxTokens) break;
    omitted = withOmitted(omitted, s);
  }
  return omitted;
}

function header(data: Record<string, unknown>, sections: string[] | null): string {
  const out: string[] = [];
  if (typeof data.title === 'string') out.push(`# ${data.title}`);
  const facts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (NOISE_KEYS.has(key) || value === null || value === undefined || value === '') continue;
    const v = Array.isArray(value) ? asStringList(value).join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (v) facts.push(`${key}: ${v}`);
  }
  if (facts.length) out.push(facts.join(' · '));
  if (typeof data.summary === 'string') out.push(`summary: ${data.summary}`);
  if (sections) out.push(`(excerpt — sections: ${sections.join(', ')})`);
  return out.join('\n');
}

interface TransformOptions extends AgentViewOptions {
  onlyAgentBlocks?: boolean;
  /** The document's figures, when `lines` are not the whole document (see agentViewOfRange). */
  figures?: FigureIndex;
  /** The document's changelog entry headings by line, when `lines` are not the whole document. */
  changelogs?: ReadonlyMap<number, ChangelogEntry>;
  /** Receives every emitted line with the source line it came from. */
  collect?: Array<[at: number, line: string]>;
  /** Inside an included document: where its own includes resolve. */
  includeScope?: IncludeScope;
}

function transform(lines: string[], from: number, inScope: (line: number) => boolean, options: TransformOptions): string {
  const out: string[] = [];
  const lineRefs = options.lineRefs ?? true;
  const figures = options.figures ?? figureIndex(lines.join('\n'));
  const text = (s: string, openTask = false) => inlineText(s, options.today, openTask, figures.byId);
  const changelogs = options.changelogs ?? changelogEntries(lines);
  interface Frame { name: string; close?: string; drop: boolean; start: number }
  const stack: Frame[] = [];
  const dropping = () => stack.some((f) => f.drop);
  const inAgent = () => stack.some((f) => f.name === 'agent');
  const emit = (line: string, at: number) => {
    if (!inScope(at) || dropping()) return;
    if (options.onlyAgentBlocks && !inAgent()) return;
    out.push(line);
    options.collect?.push([at, line]);
  };

  let fence: { marker: string; start: number; body: string[]; info: string } | null = null;
  let inComment = false;
  let doneTasks = 0;
  const flushDone = (at: number) => {
    if (doneTasks) emit(`- (${doneTasks} completed task${doneTasks > 1 ? 's' : ''} omitted)`, at);
    doneTasks = 0;
  };

  for (let i = from; i < lines.length; i++) {
    const raw = lines[i];

    // ---- fenced code ----
    if (fence) {
      if (new RegExp(`^\\s{0,3}${fence.marker[0] === '`' ? '`' : '~'}{${fence.marker.length},}\\s*$`).test(raw)) {
        for (const l of renderFence(fence, i, options)) emit(l, fence.start);
        fence = null;
      } else {
        fence.body.push(raw);
      }
      continue;
    }
    const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (f) {
      flushDone(i);
      fence = { marker: f[1], start: i, body: [], info: f[2] };
      continue;
    }

    // ---- HTML comments ----
    let line = raw;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, '');
    const startComment = line.indexOf('<!--');
    if (startComment >= 0) { line = line.slice(0, startComment); inComment = true; }
    if (raw.trim() && !line.trim()) continue;

    // ---- containers ----
    if (CONTAINER_CLOSE.test(line)) {
      const frame = stack[stack.length - 1];
      if (frame) {
        flushDone(i);
        if (frame.close) emit(frame.close, i);
        stack.pop();
      }
      continue;
    }
    const open = CONTAINER_OPEN.exec(line);
    const info = open ? parseContainerInfo(open[3] + open[4]) : null;
    if (open && info) {
      flushDone(i);
      const title = info.title ? text(info.title) : '';
      const frame: Frame = { name: info.name, drop: false, start: i };
      stack.push(frame);
      if (info.name === 'human' && !options.includeHuman) { frame.drop = true; continue; }
      if (info.name === 'details' && options.brief) {
        emit(`[details: ${title || 'Details'} — omitted, see L${i + 1}]`, i);
        frame.drop = true;
        continue;
      }
      if (info.name === 'include') {
        includeView(info, lines, options).forEach((l) => emit(l, i));
        frame.drop = true; // the body is fallback text for renderers that can't include
        continue;
      }
      const head = CONTAINER_HEADS.get(info.name)?.({ title, values: info.attrs.values, id: info.attrs.id, figure: figures.byLine.get(i) }) ?? {};
      if (head.line !== undefined) emit(head.line, i);
      frame.close = head.close;
      continue;
    }

    // ---- headings ----
    const h = /^(\s{0,3}#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushDone(i);
      emit(`${h[1].trim()} ${headingText(h[2], changelogs.get(i), text)}${lineRefs ? `  [L${i + 1}]` : ''}`, i);
      continue;
    }

    // ---- tasks ----
    const task = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s+(.*)$/.exec(line);
    if (task && task[2] !== ' ' && options.brief) {
      if (inScope(i) && !dropping()) doneTasks++;
      continue;
    }
    if (!task) {
      if (line.trim()) flushDone(i);
    }

    // ---- tables ----
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      const isDelimiter = cells.every((c) => /^:?-{1,}:?$/.test(c));
      emit(isDelimiter ? `|${cells.map(() => '-').join('|')}|` : `|${cells.map((c) => text(c)).join('|')}|`, i);
      continue;
    }

    const converted = text(line, task ? task[2] === ' ' : false);
    emit(converted.trimEnd(), i);
  }
  flushDone(lines.length - 1);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The agent view of lines [start, end] (zero-based, inclusive) on their own, e.g. one block. */
export function agentViewOfRange(lines: string[], start: number, end: number, options: AgentViewOptions = {}): string {
  const whole = { figures: figureIndex(lines.join('\n')), changelogs: changelogEntries(lines) };
  return transform(lines.slice(0, end + 1), start, () => true, { ...options, ...whole }).trim();
}

/** A heading's words; a changelog release in brief, `1.2.0 (2026-03-01)`, the version without its link. */
function headingText(raw: string, entry: ChangelogEntry | undefined, text: (s: string) => string): string {
  if (!entry) return text(raw.replace(HEADING_ATTRS, ''));
  const version = text(versionLabel(entry.version));
  return entry.date ? `${version} (${text(entry.date)})` : version;
}

/**
 * `:::include` in the agent view: the included text inside `<included file="…" section="…">` (line references in it
 * are lines of that file), or a one-line pointer when it isn't expanded or can't be read.
 */
function includeView(info: ContainerInfo, lines: string[], options: TransformOptions): string[] {
  const request = includeRequest(info.attrs.values);
  if (!request) return ['[include: no file given]'];
  const scope = options.includeScope ?? rootScope(lines.join('\n'));
  const label = includeLabel(includePath(scope.dir, request.file), request.section);
  if (options.includes === false) return [`[include: ${label} — read that file for the content]`];
  const result = loadInclude(request, scope, includeSource(options.readFile));
  if (!result.ok) {
    const problem = includeProblemText(result);
    const reason = result.problem === 'unavailable' ? 'read that file for the content' : problem[0].toLowerCase() + problem.slice(1);
    return [`[include: ${label} — ${reason}]`];
  }
  const inc = result.include;
  const inner = { ...options, collect: undefined, includeScope: innerScope(scope, inc) };
  const body = transform(includedLines(inc).slice(0, inc.end + 1), inc.start, () => true, inner);
  const section = request.section ? ` section="${request.section}"` : '';
  return [`<included file="${inc.path}"${section}>`, ...withoutBlankEnds(body.split('\n')), '</included>'];
}

/** Lines without the blank ones at the start and at the end. */
function withoutBlankEnds(lines: string[]): string[] {
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return [];
  let last = lines.length - 1;
  while (!lines[last].trim()) last--;
  return lines.slice(first, last + 1);
}

function renderFence(fence: { start: number; body: string[]; info: string }, endLine: number, options: TransformOptions): string[] {
  const info = parseFenceInfo(fence.info);
  const lang = info.lang.toLowerCase();
  const ref = `L${fence.start + 1}-L${endLine + 1}`;
  if (lang === 'mermaid') {
    if (!options.brief) return ['```mermaid', ...fence.body, '```'];
    const kind = fence.body.find((l) => l.trim() && !l.trim().startsWith('%%'))?.trim().split(/[\s;:]/)[0] ?? 'diagram';
    const title = fence.body.map((l) => /^\s*title\s+(.+)$/.exec(l)?.[1] ?? /^\s*\w+\s+title\s+(.+)$/.exec(l)?.[1]).find(Boolean);
    return [`[diagram: ${kind}${title ? ` "${title.replace(/"/g, '')}"` : ''}, ${fence.body.length} lines — see ${ref}]`];
  }
  const label = info.title ? `${info.title}:` : null;
  if (info.file) {
    const range = info.lines ? ` lines ${info.lines[0]}-${info.lines[1]}` : '';
    if (options.embed && options.readFile) {
      const content = options.readFile(info.file);
      if (content !== undefined) {
        const body = sliceLines(content, info.lines).text.replace(/\n$/, '').split('\n');
        return [`${info.file}${range}:`, '```' + info.lang, ...body, '```'];
      }
    }
    return [`[code: ${info.file}${range} — read that file for the content]`];
  }
  let body = fence.body;
  if (options.brief && body.length > 15) {
    body = [...body.slice(0, 10), `… (${body.length - 10} more lines, see ${ref})`];
  }
  return [...(label ? [label] : []), '```' + info.lang, ...body, '```'];
}

const STATUS_WORDS: Record<string, string> = { green: 'ok', teal: 'ok', red: 'bad', pink: 'bad', orange: 'warn', amber: 'warn', yellow: 'warn' };

/**
 * Strip styling syntax from one line, keeping the words. Code spans are left untouched. With the
 * document's figures by id, `:ref[id]` becomes `Figure 2 (id)`.
 */
export function inlineText(line: string, today?: string, openTask = false, figures?: ReadonlyMap<string, FigureNumber>): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, idx) => (idx % 2 === 1 ? part : plain(part, today, openTask, figures)))
    .join('');
}

/** `:ref[id]` → `Figure 2 (id)`; references to unknown ids stay as written. */
function refText(s: string, figures: ReadonlyMap<string, FigureNumber> | undefined): string {
  if (!figures?.size) return s;
  return s.replace(REF_DIRECTIVE, (m, pre: string, raw: string) => {
    const id = raw.trim();
    const figure = figures.get(id);
    return figure ? `${pre}${figure.label} (${id})` : m;
  });
}

function plain(s: string, today: string | undefined, openTask: boolean, figures?: ReadonlyMap<string, FigureNumber>): string {
  return refText(s, figures)
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, (_m, alt) => (alt ? `[image: ${alt}]` : ''))
    .replace(/(^|[\s([{>*_~"'-]):([a-z][a-z0-9-]*)(?:\[([^\]\n]*)\])?(?:\{([^{}\n]*)\})?/g, (m, pre, name, content = '', rawAttrs = '') => {
      const v = parseAttrs(rawAttrs)?.values ?? {};
      switch (name) {
        case 'badge': return `${pre}[${content}]`;
        case 'priority': return `${pre}[${content}]`;
        case 'kbd': return `${pre}${content}`;
        case 'mention': return `${pre}${content}`;
        case 'status': return `${pre}[status: ${content}${STATUS_WORDS[v.color] ? ` (${STATUS_WORDS[v.color]})` : ''}]`;
        case 'progress': return `${pre}${v.label ?? `${Math.round(Number(v.value ?? content) || 0)}%`}`;
        case 'due': {
          const late = openTask && dueState(content.trim(), today) === 'overdue';
          return `${pre}(due ${content}${late ? ', OVERDUE' : ''})`;
        }
        case 'metric': return `${pre}${v.label ? `${v.label}: ` : ''}${content}${v.delta ? ` (${v.delta})` : ''}`;
        default: return m;
      }
    })
    .replace(/(!?)\[([^\]\n]*)\]\{([^{}\n]*)\}/g, (m, bang, content, rawAttrs) => (bang || !parseAttrs(rawAttrs) ? m : content))
    .replace(/==(?=\S)([^=\n]+?)(?<=\S)==/g, '$1');
}

// ---------------------------------------------------------------------------
// Outline: a table of contents with per-section token costs, so an agent can
// decide what to read before reading anything.
// ---------------------------------------------------------------------------

/**
 * The agent view of any line range, as `transform` would produce it for that scope. The document is
 * transformed once and each range is cut from the result, so an outline stays linear in document
 * size. Brief views count completed tasks per scope, so they are transformed per range.
 */
function sectionViews(lines: string[], from: number, documentOptions: TransformOptions): (start: number, end: number) => string {
  const options = { ...documentOptions, figures: figureIndex(lines.join('\n')), changelogs: changelogEntries(lines) };
  if (options.brief) return (start, end) => transform(lines, from, (l) => l >= start && l <= end, options);
  const emitted: Array<[number, string]> = [];
  transform(lines, from, () => true, { ...options, collect: emitted });
  const bound = (line: number) => {
    let lo = 0;
    let hi = emitted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (emitted[mid][0] < line) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const ordered = emitted.every((e, i) => i === 0 || emitted[i - 1][0] <= e[0]);
  return (start, end) => {
    const inRange = ordered
      ? emitted.slice(bound(start), bound(end + 1))
      : emitted.filter(([at]) => at >= start && at <= end);
    return inRange.map(([, line]) => line).join('\n').replace(/\n{3,}/g, '\n\n');
  };
}

/** A section (its heading up to the next heading of the same or a higher level) and the cost of reading it. */
export interface SectionCost {
  heading: Heading;
  /** Zero-based first and last line. */
  start: number;
  end: number;
  /** Approximate tokens of the section, subsections included, in the agent view (without line references). */
  tokens: number;
  /** The same text counted with `options.tokenizer`, when one is given. */
  counted?: number;
}

/** Every section of a document with its agent-view token cost, as `outline` lists them. */
export function sectionCosts(text: string, options: AgentViewOptions = {}): SectionCost[] {
  const fm = parseFrontMatter(text);
  const lines = text.split(/\r?\n/);
  const sectionView = sectionViews(lines, fm.bodyStartLine, { ...options, lineRefs: false });
  return sectionsOf(parseSmd(text).headings, lines.length).map((s) => {
    const view = sectionView(s.start, s.end);
    return { ...s, tokens: estimateTokens(view), ...(options.tokenizer ? { counted: options.tokenizer.count(view) } : {}) };
  });
}

/** The agent view of any line range of a document (zero-based, inclusive), with the context of the whole document. */
export function agentViewRanges(text: string, options: AgentViewOptions = {}): (start: number, end: number) => string {
  const view = sectionViews(text.split(/\r?\n/), parseFrontMatter(text).bodyStartLine, options);
  return (start, end) => view(start, end).replace(/\n{3,}/g, '\n\n').trim();
}

export function outline(text: string, options: AgentViewOptions = {}): string {
  const fm = parseFrontMatter(text);
  const lines = text.split(/\r?\n/);
  const headings = parseSmd(text).headings;
  const full = agentView(text, { ...options, sections: undefined, maxTokens: undefined });
  const title = typeof fm.data.title === 'string' ? fm.data.title : headings.find((h) => h.level === 1)?.text ?? '(untitled)';
  const status = typeof fm.data.status === 'string' ? ` · ${fm.data.status}` : '';
  const out: string[] = [
    `${title}${status} · ${outlineCosts(full)}`,
  ];
  if (typeof fm.data.summary === 'string') out.push(`summary: ${fm.data.summary}`);
  out.push('');

  const rows = sectionCosts(text, options).map((s) => {
    const sectionText = lines.slice(s.start, s.end + 1);
    const openTasks = sectionText.filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s/.test(l)).length;
    const notes = [
      openTasks ? `${openTasks} open task${openTasks > 1 ? 's' : ''}` : '',
      sectionText.some((l) => /^\s*```\s*mermaid/.test(l)) ? 'diagram' : '',
      sectionText.some((l) => /^\s*:{3,}\s*agent\b/.test(l)) ? 'AGENT INSTRUCTIONS' : '',
      sectionText.some((l) => /^\s*:{3,}\s*api\b/.test(l)) ? 'API' : '',
      sectionText.some((l) => /^\s*:{3,}\s*(decision)\b/.test(l)) ? 'decision' : '',
      sectionText.some((l) => /^\s*:{3,}\s*(risk)(?![\w-])/.test(l)) ? 'risk' : '',
      sectionText.some((l) => /^\s*:{3,}\s*(question)\b/.test(l)) ? 'open question' : '',
      s.heading.agent === 'skip' ? 'skipped for agents' : '',
    ].filter(Boolean).join(', ');
    const range = `L${s.start + 1}-${s.end + 1}`;
    const indent = '  '.repeat(Math.max(0, s.heading.level - 2));
    return { range, head: `${indent}${'#'.repeat(s.heading.level)} ${s.heading.text}`, tokens: sectionCost(s), notes };
  });
  const w1 = Math.max(...rows.map((r) => r.range.length), 5);
  const w2 = Math.max(...rows.map((r) => r.head.length), 10);
  const w3 = costWidth(rows.map((r) => r.tokens), options.tokenizer);
  for (const r of rows) {
    out.push(`${r.range.padEnd(w1)}  ${r.head.padEnd(w2)}  ${r.tokens.padStart(w3)}${r.notes ? `  ${r.notes}` : ''}`);
  }
  out.push('', 'Read a section: smd agent <file> --section "<heading or id>"   (repeatable; add --brief to condense)');
  return out.join('\n') + '\n';
}

/** `file ≈2430 tokens · full agent view ≈1531 tokens`, with a tokenizer `file ≈2430 est · 2210 o200k_base tokens · …` */
function outlineCosts(full: AgentViewResult): string {
  const counted = full.counted;
  if (!counted) return `file ≈${full.originalTokens} tokens · full agent view ≈${full.tokens} tokens`;
  const pair = (estimate: number, exact: number) => `≈${estimate} est · ${exact} ${counted.tokenizer} tokens`;
  return `file ${pair(full.originalTokens, counted.originalTokens)} · full agent view ${pair(full.tokens, counted.tokens)}`;
}

/** A section's cost column: `≈420`, with a tokenizer `≈420 · 402`. */
function sectionCost(s: SectionCost): string {
  return s.counted === undefined ? `≈${s.tokens}` : `≈${s.tokens} · ${s.counted}`;
}

function costWidth(costs: string[], tokenizer?: Tokenizer): number {
  return tokenizer ? Math.max(...costs.map((c) => c.length), 6) : 6;
}
