import { parseAttrs } from './attrs';
import { changelogEntries, versionLabel, type ChangelogEntry } from './changelog';
import {
  omissionOrder, omissionPointer, omittableSections, withOmitted, type BudgetResult, type BudgetSection, type Tokenizer,
} from './budget';
import { closedBy, closerColons, CONTAINER_CLOSE, CONTAINER_OPEN, isKnownContainer, parseContainerInfo, type ContainerInfo } from './containers';
import { parseFenceInfo, sliceLines } from './fence';
import { refDirective, type Figure, type FigureNumber } from './figures';
import { findFootnotes, type FootnoteDefinition } from './footnotes';
import { parseFrontMatter, asStringList, unreadFrontMatter } from './frontmatter';
import {
  includeLabel, includePath, includeProblemText, includeRequest, innerScope, loadInclude, rootScope, type IncludeScope,
} from './include';
import {
  expandedFigures, figuresOf, includedAlerts, includedInlineItems, includedInlineMath, includedLines, includedLiteralLines, includedTaskLines, includeKey,
  includeSource, type ExpandedFigures,
} from './includeText';
import {
  alertLines, aroundInlineMath, convertedParts, fenceLines, inlineItemLines, inlineMathLines, lazyLineSet, literalLines, parseSmd, renderedTaskLines,
  type AlertLines, type InlineItemLines, type InlineMathLines, type InlinePart,
} from './parse';
import { dueState, type Heading } from './render';
import { matchesHeading, sectionsOf, withoutHeadingAttrs, type Section } from './sections';
import { quoteCite } from './quote';
import { CALLOUT_TYPES, INLINE_DIRECTIVES } from './spec';
import { specVersion, type SpecVersion } from './specVersion';
import { openTaskLines } from './taskLines';
import { own } from './util';
import { documentVariables, shownValues, substituteVariables, type Variables } from './variables';

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

/** `Title:`, or nothing without a title. */
const titleLine = ({ title }: HeadSource): ContainerHead => (title ? { line: `${title}:` } : {});

/**
 * The agent view of each container's opening line. `:::human` (unless included) and `:::details` in brief
 * views are dropped before this. tabs, columns, column, box, steps and timeline: content only. Unknown containers:
 * their title as a `Title:` line, as a card's (see containerHead), then the content.
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
  ['card', titleLine],
  ['figure', figureHead],
  // Listed once, as written; uses of the terms in the text are not expanded.
  ['glossary', tagged('glossary')],
  // Its entry headings become `## 1.2.0 (2026-03-01)` lines (see entryHeading).
  ['changelog', tagged('changelog')],
  ['quote', quoteHead],
]);

/** The agent view of a container's opening line: its own (CONTAINER_HEADS), a known one's content only, an unknown one's title. */
function containerHead(name: string, source: HeadSource): ContainerHead {
  const head = CONTAINER_HEADS.get(name);
  if (head) return head(source);
  return isKnownContainer(name) ? {} : titleLine(source);
}

/** What the view reads included files with: nothing when includes are only pointers. */
const viewReader = (options: AgentViewOptions) => (options.includes === false ? undefined : options.readFile);

/** Front matter keys the agent view's header leaves out of its facts. */
export const AGENT_HEADER_HIDDEN: ReadonlySet<string> = new Set(['smd', 'theme', 'accent', 'toc', 'title', 'summary']);

interface ViewScope {
  data: Record<string, unknown>;
  /** The front matter as the document shows it: spelled as written in spec v2 (shownValues). */
  shown: Variables;
  /** The lines of front matter that could not be read, as written (see unreadFrontMatter). */
  unread?: string[];
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
  const shown = shownValues(fm.data, text, specVersion(fm.data));
  return {
    data: fm.data, shown, unread: unreadFrontMatter(text, fm), bodyStart: fm.bodyStartLine, lines, sections, selected, skipped, missingSections, inScope,
  };
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
  const head = [header(scope.data, scope.shown, selected ? selected.map((s) => s.heading.text) : null), unreadBlock(scope.unread)].filter(Boolean).join('\n');
  return { header: head, external, footnotes };
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

export function agentView(text: string, viewOptions: AgentViewOptions = {}): AgentViewResult {
  // Figures are numbered once, for every pass over the document.
  const options: TransformOptions = { ...viewOptions, figures: expandedFigures(text, viewReader(viewOptions)) };
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

/**
 * Front matter that could not be read: a `[front matter could not be read]` line and its lines as written, in a
 * fence longer than any backtick run in them, as the rendered document shows them in an error block.
 */
function unreadBlock(unread: string[] | undefined): string {
  if (!unread) return '';
  const longest = Math.max(2, ...unread.map((l) => Math.max(0, ...[...l.matchAll(/`+/g)].map((m) => m[0].length))));
  const fence = '`'.repeat(longest + 1);
  return ['[front matter could not be read]', `${fence}yaml`, ...unread, fence].join('\n');
}

/** The view's header. `data` decides which facts are shown, `shown` how they are spelled (as written in spec v2). */
function header(data: Record<string, unknown>, shown: Variables, sections: string[] | null): string {
  const out: string[] = [];
  if (typeof data.title === 'string') out.push(`# ${data.title}`);
  const facts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (AGENT_HEADER_HIDDEN.has(key) || value === null || value === undefined || value === '') continue;
    const v = factText(Object.hasOwn(shown, key) ? shown[key] : value);
    if (v) facts.push(`${key}: ${v}`);
  }
  if (facts.length) out.push(facts.join(' · '));
  if (typeof data.summary === 'string') out.push(`summary: ${data.summary}`);
  if (sections) out.push(`(excerpt — sections: ${sections.join(', ')})`);
  return out.join('\n');
}

/** A front matter value as one header fact: a list joined with ", ", a mapping as JSON. */
function factText(value: unknown): string {
  if (Array.isArray(value)) return asStringList(value).join(', ');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

interface TransformOptions extends AgentViewOptions {
  onlyAgentBlocks?: boolean;
  /** The figures of the document and of what it includes, numbered together; found from `lines` when left out. */
  figures?: ExpandedFigures;
  /** Which document of `figures` the lines are: an included one's key (see includeKey), `''` for the root document. */
  figureKey?: string;
  /** The document's changelog entry headings by line, when `lines` are not the whole document. */
  changelogs?: ReadonlyMap<number, ChangelogEntry>;
  /** The document's front matter, for `{{name}}`; read from `lines` when left out. */
  variables?: Variables;
  /** The lines of `lines` that are code or display math, kept as written; found in `lines` when left out. */
  literalLines?: ReadonlySet<number>;
  /** The inline math of the lines of `lines` whose inline text runs over several lines (see inlineMathLines); found in `lines` when left out. */
  inlineMath?: InlineMathLines;
  /** The GitHub alerts of `lines` (see alertLines); found in `lines` when left out. */
  alerts?: readonly AlertLines[];
  /** The inline items of `lines` that run over several lines (see inlineItemLines); found in `lines` when left out. */
  inlineItems?: InlineItemLines;
  /** The lines of `lines` where rendering shows a task's checkbox (see renderedTaskLines); found in `lines` when left out. */
  taskLines?: ReadonlySet<number>;
  /** Receives every emitted line with the source line it came from. */
  collect?: Array<[at: number, line: string]>;
  /** Inside an included document: where its own includes resolve. */
  includeScope?: IncludeScope;
}

/**
 * A closing fence closes the open containers from index `at` on (see closedBy), innermost first: `close` sees each
 * while it is still open, then it is taken off.
 */
function popFrames<T>(stack: T[], at: number, close: (frame: T) => unknown): void {
  while (stack.length > Math.max(at, 0)) {
    close(stack.at(-1)!);
    stack.pop();
  }
}

function transform(lines: string[], from: number, inScope: (line: number) => boolean, options: TransformOptions): string {
  const out: string[] = [];
  const lineRefs = options.lineRefs ?? true;
  const { figures, ownFigures, literal, inlineMath, alerts, inlineItems, taskLines } = documentContext(lines, options);
  const variables = options.variables ?? documentVariables(lines);
  // The document's spec version, from its front matter: an included document's is the including one's, as in rendering.
  const spec = specVersion(variables);
  const text = (s: string, openTask = false, math?: ReadonlyArray<[number, number]>, parts?: ReadonlyArray<InlinePart>) => {
    const read: TextContext = { today: options.today, openTask, figures: figures.byId, variables, spec };
    // An item that runs over several lines is read whole, as rendering reads it; each line shows its part.
    return styledText(s, read, math, convertedParts(parts, (whole) => styledText(whole, read)));
  };
  const changelogs = options.changelogs ?? changelogEntries(lines, 0, spec);
  interface Frame { name: string; colons: number; close?: string; drop: boolean; start: number }
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
  const alertView = alertTags(alerts, lines, emit, flushDone);

  for (let i = from; i < lines.length; i++) {
    // Inside a GitHub alert, the line without its quote marker; nothing for the alert's own marker line.
    const raw = alertView.line(i, lines[i]);
    if (raw === undefined) continue;

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

    // ---- indented code and display math: as written, like fenced code (no line of them is a task, a table or a comment) ----
    if (literal.has(i)) {
      flushDone(i);
      emit(raw, i);
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
      // The containers the fence closes, innermost first (spec v2 may close several, see closedBy).
      const at = closedBy(stack.map((f) => f.colons), closerColons(line), spec);
      if (at >= 0) flushDone(i);
      popFrames(stack, at, (frame) => frame.close && emit(frame.close, i));
      continue;
    }
    const open = CONTAINER_OPEN.exec(line);
    const info = open ? parseContainerInfo(open[3] + open[4], spec) : null;
    if (open && info) {
      flushDone(i);
      const title = info.title ? text(info.title) : '';
      const frame: Frame = { name: info.name, colons: open[2].length, drop: false, start: i };
      stack.push(frame);
      if (info.name === 'human' && !options.includeHuman) { frame.drop = true; continue; }
      if (info.name === 'details' && options.brief) {
        emit(`[details: ${title || 'Details'} — omitted, see L${i + 1}]`, i);
        frame.drop = true;
        continue;
      }
      if (info.name === 'include') {
        includeView(info, lines, i, { ...options, figures }).forEach((l) => emit(l, i));
        frame.drop = true; // the body is fallback text for renderers that can't include
        continue;
      }
      const head = containerHead(info.name, { title, values: info.attrs.values, id: info.attrs.id, figure: ownFigures.get(i) });
      if (head.line !== undefined) emit(head.line, i);
      frame.close = head.close;
      continue;
    }

    // ---- headings ----
    const h = /^(\s{0,3}#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushDone(i);
      emit(`${h[1].trim()} ${headingText(h[2], changelogs.get(i), text, spec)}${lineRefs ? `  [L${i + 1}]` : ''}`, i);
      continue;
    }

    // ---- tasks ----
    // A task-shaped line that rendering shows as text (in a paragraph it continues) is not a task.
    const shape = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s+(.*)$/.exec(line);
    const task = shape && taskLines.has(i) ? shape : null;
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

    // Math and items that run on from one line to the next are known for the line as written (not with a comment or an
    // alert's quote marker cut out).
    const asWritten = line === lines[i];
    const converted = text(line, task ? task[2] === ' ' : false, asWritten ? inlineMath.get(i) : undefined, asWritten ? inlineItems.get(i) : undefined);
    emit(converted.trimEnd(), i);
  }
  alertView.end();
  flushDone(lines.length - 1);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

interface DocumentContext {
  figures: ExpandedFigures; ownFigures: ReadonlyMap<number, Figure>; literal: ReadonlySet<number>; inlineMath: InlineMathLines; alerts: readonly AlertLines[];
  inlineItems: InlineItemLines; taskLines: ReadonlySet<number>;
}

/**
 * The figures (numbered with the rest of the expanded document), this document's own figures by line, the lines
 * of code and display math, its GitHub alerts, multi-line inline items and task lines, from `options` when the
 * caller has them, else from `lines`.
 */
function documentContext(lines: string[], options: TransformOptions): DocumentContext {
  const text = lines.join('\n');
  const figures = options.figures ?? expandedFigures(text, viewReader(options));
  return {
    figures, ownFigures: figuresOf(figures, options.figureKey ?? ''), literal: options.literalLines ?? literalLines(text), inlineMath: options.inlineMath ?? inlineMathLines(text),
    alerts: options.alerts ?? alertLines(text), inlineItems: options.inlineItems ?? inlineItemLines(text), taskLines: options.taskLines ?? renderedTaskLines(text),
  };
}

/** A blockquote's `>` marker, with the space after it. */
const QUOTE_MARKER = /^ {0,3}> ?/;

/**
 * GitHub alerts in the agent view, as callouts (spec §3.8): `<warning>` on the quote's first line, its lines without
 * the `>` marker (the marker line itself left out), then `</warning>` after its last line that isn't blank.
 */
function alertTags(alerts: readonly AlertLines[], lines: string[], emit: (line: string, at: number) => void, flush: (at: number) => void) {
  const byStart = new Map(alerts.map((a) => [a.start, a]));
  let open: { alert: AlertLines; last: number } | undefined;
  const close = () => {
    if (!open) return;
    flush(open.last);
    emit(`</${open.alert.callout}>`, open.last);
    open = undefined;
  };
  return {
    /** Line `i` as the view reads it, or undefined for an alert's marker line. */
    line(i: number, raw: string): string | undefined {
      if (open && i > open.last) close();
      const alert = byStart.get(i);
      if (alert) {
        close();
        let last = alert.end - 1;
        while (last > alert.start && !lines[last]?.trim()) last--;
        open = { alert, last };
        flush(i);
        emit(`<${alert.callout}>`, i);
      }
      if (!open) return raw;
      return i === open.alert.marker ? undefined : raw.replace(QUOTE_MARKER, '');
    },
    /** Close an alert that runs to the end of the lines. */
    end: close,
  };
}

/** The agent view of lines [start, end] (zero-based, inclusive) on their own, e.g. one block. */
export function agentViewOfRange(lines: string[], start: number, end: number, options: AgentViewOptions = {}): string {
  const text = lines.join('\n');
  const variables = documentVariables(lines);
  const whole = { figures: expandedFigures(text, viewReader(options)), changelogs: changelogEntries(lines, 0, specVersion(variables)), variables, literalLines: literalLines(text), inlineMath: inlineMathLines(text),
    alerts: alertLines(text), inlineItems: inlineItemLines(text), taskLines: renderedTaskLines(text) };
  return transform(lines.slice(0, end + 1), start, () => true, { ...options, ...whole }).trim();
}

/** A heading's words; a changelog release in brief, `1.2.0 (2026-03-01)`, the version without its link. */
function headingText(raw: string, entry: ChangelogEntry | undefined, text: (s: string) => string, spec: SpecVersion): string {
  if (!entry) return text(withoutHeadingAttrs(raw, spec));
  const version = text(versionLabel(entry.version));
  return entry.date ? `${version} (${text(entry.date)})` : version;
}

/**
 * `:::include` in the agent view: the included text inside `<included file="…" section="…">` (line references in it
 * are lines of that file), or a one-line pointer when it isn't expanded or can't be read.
 */
function includeView(info: ContainerInfo, lines: string[], line: number, options: TransformOptions): string[] {
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
  // Included text uses this document's front matter variables, as the rendered HTML does.
  const inner = {
    ...options, collect: undefined, includeScope: innerScope(scope, inc), variables: options.variables ?? documentVariables(lines), literalLines: includedLiteralLines(inc),
    inlineMath: includedInlineMath(inc), alerts: includedAlerts(inc), inlineItems: includedInlineItems(inc), taskLines: includedTaskLines(inc),
    // Its figures are numbered with the including document's, and `:ref` resolves across both, as in rendered output.
    figureKey: includeKey(options.figureKey ?? '', line),
  };
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
 * Strip styling syntax from one line, keeping the words. Code spans and `$inline math$` are left
 * untouched. With the document's figures by id, `:ref[id]` becomes `Figure 2 (id)`; with its front matter,
 * `{{name}}` becomes the value of `name`. `math` is the line's inline math when it is read with the lines around
 * it (see mathOnLine); else it is read from the line.
 */
export function inlineText(
  line: string, today?: string, openTask = false, figures?: ReadonlyMap<string, FigureNumber>, variables?: Variables, math?: ReadonlyArray<[number, number]>,
): string {
  // The front matter decides the rules: a spec v2 document's directives read in any case, and unknown ones show their content.
  return styledText(line, { today, openTask, figures, variables, spec: specVersion(variables) }, math);
}

/** inlineText read with the rules of `spec`, its `{{name}}` replaced from `variables` when given. Internal. */
export function plainInlineText(line: string, spec: SpecVersion, variables?: Variables): string {
  return styledText(line, { openTask: false, spec, variables });
}

/** How inlineText reads a line: the date for overdue tasks, whether it is an open task's, the figures and front matter. */
interface TextContext { today?: string; openTask: boolean; figures?: ReadonlyMap<string, FigureNumber>; variables?: Variables; spec: SpecVersion }

/**
 * inlineText, with parts of the line already converted (see convertedParts): they are put back as converted, and the
 * rest of the line is read around them.
 */
function styledText(line: string, read: TextContext, math?: ReadonlyArray<[number, number]>, replaced?: ReadonlyArray<[number, number, string]>): string {
  return aroundInlineMath(line, (text) => text
    .split(/(`+[^`]*`+)/)
    .map((part, idx) => (idx % 2 === 1 ? part : plain(substituteVariables(part, read.variables), read)))
    .join(''), math, replaced);
}

/** `:ref[id]` → `Figure 2 (id)`; references to unknown ids stay as written. */
function refText(s: string, figures: ReadonlyMap<string, FigureNumber> | undefined, spec: SpecVersion): string {
  if (!figures?.size) return s;
  return s.replace(refDirective(spec), (m, pre: string, raw: string) => {
    const id = raw.trim();
    const figure = figures.get(id);
    return figure ? `${pre}${figure.label} (${id})` : m;
  });
}

/**
 * `:name[content]{attrs}` in text: a lower-case name in spec v1, any case in spec v2 (RFC proposal 11). A name with
 * neither `[content]` nor `{attributes}` is text, as in rendering. Content may run over a line break when an item is
 * read whole (see convertedParts).
 */
const DIRECTIVE_TEXT_V1 = /(^|[\s([{>*_~"'-]):([a-z][a-z0-9-]*)(?:\[([^\]]*)\])?(?:\{([^{}\n]*)\})?/g;
const DIRECTIVE_TEXT_V2 = /(^|[\s([{>*_~"'-]):([A-Za-z][A-Za-z0-9-]*)(?:\[([^\]]*)\])?(?:\{([^{}\n]*)\})?/g;

function plain(s: string, { today, openTask, figures, spec }: TextContext): string {
  return refText(s, figures, spec)
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, (_m, alt) => (alt ? `[image: ${alt}]` : ''))
    .replace(spec >= 2 ? DIRECTIVE_TEXT_V2 : DIRECTIVE_TEXT_V1, (m, pre: string, name: string, content?: string, rawAttrs?: string) =>
      (content === undefined && rawAttrs === undefined
        ? m
        : directiveText(m, { pre, name: spec >= 2 ? name.toLowerCase() : name, content: content ?? '', rawAttrs: rawAttrs ?? '' }, { today, openTask, spec })))
    .replace(/(!?)\[([^\]]*)\]\{([^{}\n]*)\}/g, (m, bang, content, rawAttrs) => (bang || !parseAttrs(rawAttrs, spec) ? m : content))
    .replace(/==(?=\S)([^=]+?)(?<=\S)==/g, '$1');
}

/**
 * One `:name[content]{attrs}` in plain text (`m` as written), or `m` for a name the agent view keeps as written. In
 * spec v2 a name outside the vocabulary is a directive that shows its content (RFC proposal 7b), as a styled span does;
 * in spec v1 it is text.
 */
function directiveText(
  m: string, { pre, name, content, rawAttrs }: { pre: string; name: string; content: string; rawAttrs: string },
  { today, openTask, spec }: { today: string | undefined; openTask: boolean; spec: SpecVersion },
): string {
  const attrs = parseAttrs(rawAttrs, spec);
  // In spec v2 a list that can't be read leaves the whole item as text, as rendering does.
  if (spec >= 2 && !attrs) return m;
  if (spec >= 2 && !Object.hasOwn(INLINE_DIRECTIVES, name)) return `${pre}${content}`;
  const v = attrs?.values ?? {};
  const status = own(STATUS_WORDS, v.color ?? '');
  switch (name) {
    case 'badge': return `${pre}[${content}]`;
    case 'priority': return `${pre}[${content}]`;
    case 'kbd': return `${pre}${content}`;
    case 'mention': return `${pre}${content}`;
    case 'status': return `${pre}[status: ${content}${status ? ` (${status})` : ''}]`;
    case 'progress': return `${pre}${v.label ?? `${Math.round(Number(v.value ?? content) || 0)}%`}`;
    case 'due': {
      const late = openTask && dueState(content.trim(), today) === 'overdue';
      return `${pre}(due ${content}${late ? ', OVERDUE' : ''})`;
    }
    case 'metric': return `${pre}${v.label ? `${v.label}: ` : ''}${content}${v.delta ? ` (${v.delta})` : ''}`;
    default: return m;
  }
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
  const text = lines.join('\n');
  const variables = documentVariables(lines);
  const options = {
    ...documentOptions, figures: expandedFigures(text, viewReader(documentOptions)), changelogs: changelogEntries(lines, 0, specVersion(variables)), variables, literalLines: literalLines(text),
    inlineMath: inlineMathLines(text),
  };
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

/** An outline note and the line that earns it: a fence that opens a diagram, or a container's opening line. */
interface SectionMark { note: string; line: RegExp; fence?: true }

const SECTION_MARKS: SectionMark[] = [
  { note: 'diagram', line: /^\s*```\s*mermaid/, fence: true },
  { note: 'AGENT INSTRUCTIONS', line: /^\s*:{3,}\s*agent\b/ },
  { note: 'API', line: /^\s*:{3,}\s*api\b/ },
  { note: 'decision', line: /^\s*:{3,}\s*decision\b/ },
  { note: 'risk', line: /^\s*:{3,}\s*risk(?![\w-])/ },
  { note: 'open question', line: /^\s*:{3,}\s*question\b/ },
];

/**
 * Whether lines [start, end] of a document have a line that earns a note, as rendering reads them: code and
 * display math are shown as written, so a `:::decision` line there is text, and a ```` ```mermaid ```` line is a
 * diagram only where it opens a fence. The document is parsed only when a line has the shape of a mark.
 */
function sectionMarks(text: string, lines: string[]): (mark: SectionMark, start: number, end: number) => boolean {
  const opensFence = lazyLineSet(() => fenceLines(text));
  const isLiteral = lazyLineSet(() => literalLines(text));
  const counts = (mark: SectionMark, i: number) => (mark.fence ? opensFence(i) : !isLiteral(i));
  return (mark, start, end) => lines.slice(start, end + 1).some((l, k) => mark.line.test(l) && counts(mark, start + k));
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

  // Counted as `smd tasks` counts them: a task-shaped line in code is code.
  const openTaskAt = openTaskLines(text);
  const marked = sectionMarks(text, lines);
  const rows = sectionCosts(text, options).map((s) => {
    const openTasks = openTaskAt.filter((l) => l >= s.start && l <= s.end).length;
    const notes = [
      openTasks ? `${openTasks} open task${openTasks > 1 ? 's' : ''}` : '',
      ...SECTION_MARKS.map((mark) => (marked(mark, s.start, s.end) ? mark.note : '')),
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
