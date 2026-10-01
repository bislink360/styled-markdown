import { agentViewOfRange, inlineText } from './agentView';
import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo, type ContainerInfo } from './containers';
import { parseFrontMatter } from './frontmatter';
import { extractTasks } from './meta';
import { parseSmd } from './parse';
import type { Heading } from './render';
import { CALLOUT_TYPES, CONTAINERS, RISK_LEVELS, STYLE_KEYS } from './spec';
import { suggest } from './util';

/**
 * Block queries: select decisions, risks, API endpoints, callouts, tasks and headings by type and
 * attributes with CSS-like selectors, and get each match in the agent view.
 *
 *   decision[status=accepted]      risk[impact>=high][status!=closed]      api[method=POST|PUT]
 *   task[owner=@maya][done=false]  task[due<today]                          question, risk
 *   heading[level=2]               callout[title*=migration]                *[owner=@maya]
 *
 * A selector is a block type (`*` or none for any, `callout` for any callout) followed by attribute
 * tests; commas list alternatives. Values compare case-insensitively and ignore a leading `@`.
 * `a|b` lists alternative values. `<`, `<=`, `>`, `>=` compare numbers, YYYY-MM-DD dates (and `today`),
 * priorities (P0 < P1 < … and critical < high < medium < low) and risk levels (low < … < critical).
 */

export type QueryOperator = '=' | '!=' | '*=' | '^=' | '$=' | '<' | '<=' | '>' | '>=' | 'exists';

export interface AttributeTest {
  key: string;
  op: QueryOperator;
  /** Alternatives, written `a|b`: the test passes when any of them does (for `!=`, when none equals). */
  values: string[];
}

/** One selector: a block type (`*` for any) and the attribute tests a block must pass. */
export interface Selector { type: string; tests: AttributeTest[] }

/** A selector that can't be parsed, or names an unknown block type or attribute. */
export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelectorError';
  }
}

export interface QueryOptions {
  /** Condense diagrams, long code, details blocks and completed tasks in each match (as `smd agent --brief`). */
  brief?: boolean;
  /** Append [L12] source line references to headings in each match (default true). */
  lineRefs?: boolean;
  /** YYYY-MM-DD used for `today` and overdue tasks; defaults to the current date. */
  today?: string;
}

export interface QueryMatch {
  /** Container name (`decision`, `risk`, `api`, `warning`…), `task` or `heading`. */
  type: string;
  /** Zero-based first line. */
  line: number;
  /** Zero-based last line: the closing fence, the task line itself, or the last line of a heading's section. */
  endLine: number;
  title: string;
  /**
   * Attributes as written plus the spec's defaults (a decision is `proposed`, a risk's impact `medium`).
   * Tasks have `done`, `overdue`, and `owner` (a list), `priority` and `due` when given; headings `level` and `id`.
   */
  attrs: Record<string, string | string[]>;
  /** The nearest heading above the block; for a heading, its parent heading. */
  section: string | null;
  /** The block in the agent view. */
  text: string;
}

const CONTAINER_TYPES = Object.keys(CONTAINERS);
const BLOCK_TYPES = ['*', 'task', 'heading', 'callout', ...CONTAINER_TYPES];
const COMMON_KEYS = ['title', 'section', 'type'];
const OWN_KEYS: Record<string, string[]> = {
  task: ['done', 'owner', 'priority', 'due', 'overdue'],
  heading: ['level', 'id', 'agent'],
};
const DEFAULTS: Record<string, Record<string, string>> = {
  decision: { status: 'proposed' },
  risk: { impact: 'medium' },
  api: { method: 'GET' },
  figure: { kind: 'figure' },
};
const PRIORITY_RANK: Record<string, number> = { p0: 0, critical: 0, p1: 1, high: 1, p2: 2, medium: 2, p3: 3, low: 3, p4: 4 };

/** Attributes a block type can have, or undefined when any key is allowed (`*`). */
function knownKeys(type: string): string[] | undefined {
  if (type === '*') return undefined;
  if (OWN_KEYS[type]) return [...COMMON_KEYS, ...OWN_KEYS[type]];
  const spec = CONTAINERS[type === 'callout' ? 'note' : type];
  return [...COMMON_KEYS, 'id', 'class', ...(spec.attrs ?? []).filter((k) => k !== 'title'), ...Object.keys(STYLE_KEYS)];
}

/** Parse `decision[status=accepted], risk[impact>=high]`. Throws a SelectorError that says what's wrong. */
export function parseSelector(source: string): Selector[] {
  return new SelectorParser(source).parse();
}

const ORDERED = new Set<QueryOperator>(['<', '<=', '>', '>=']);

class SelectorParser {
  private readonly src: string;
  private i = 0;

  constructor(source: string) {
    this.src = source.trim();
  }

  parse(): Selector[] {
    if (!this.src) throw new SelectorError('Empty selector. Try e.g. "decision[status=accepted]".');
    const selectors = [this.selector()];
    while (this.i < this.src.length) {
      if (this.src[this.i] !== ',') this.fail(`Unexpected "${this.src[this.i]}". List several selectors with commas, e.g. "decision, risk"`);
      this.i++;
      selectors.push(this.selector());
    }
    return selectors;
  }

  private selector(): Selector {
    this.space();
    const start = this.i;
    const name = this.take(/^(?:\*|[A-Za-z][\w-]*)/);
    const type = (name ?? '*').toLowerCase();
    if (!BLOCK_TYPES.includes(type)) {
      this.i = start;
      this.fail(`Unknown block type "${type}".${didYouMean(type, BLOCK_TYPES)} Types: ${BLOCK_TYPES.join(', ')}`);
    }
    const tests: AttributeTest[] = [];
    while (this.src[this.i] === '[') {
      this.i++;
      tests.push(this.test());
    }
    if (!name && !tests.length) this.fail(this.src[this.i] === undefined ? 'Missing a selector after ","' : `Unexpected "${this.src[this.i]}"`);
    checkKeys(type, tests);
    this.space();
    return { type, tests };
  }

  /** One `[key op values]`, after its `[`. */
  private test(): AttributeTest {
    this.space();
    const key = this.take(/^[A-Za-z_][\w-]*/);
    if (!key) this.fail('Expected an attribute name after "["');
    this.space();
    const op = this.take(/^(?:!=|\*=|\^=|\$=|<=|>=|=|<|>)/) as QueryOperator | undefined;
    const values = op ? this.values(op) : [];
    if (this.src[this.i] !== ']') this.fail(this.expected(op));
    this.i++;
    return { key: key.toLowerCase(), op: op ?? 'exists', values };
  }

  private expected(op: QueryOperator | undefined): string {
    if (!op) return 'Expected "]" or an operator: = != *= ^= $= < <= > >=';
    return this.src[this.i] === undefined ? 'Missing "]"' : `Unexpected "${this.src[this.i]}"`;
  }

  /** `a|"b c"|d`, up to the closing `]`. */
  private values(op: QueryOperator): string[] {
    const values = [this.value(op)];
    while (this.src[this.i] === '|') {
      this.i++;
      values.push(this.value(op));
    }
    if (values.length > 1 && ORDERED.has(op)) this.fail(`"${op}" takes one value`);
    return values;
  }

  private value(op: QueryOperator): string {
    this.space();
    const quote = this.src[this.i];
    let value: string;
    if (quote === '"' || quote === "'") {
      const end = this.src.indexOf(quote, this.i + 1);
      if (end < 0) this.fail(`Missing closing ${quote}`);
      value = this.src.slice(this.i + 1, end);
      this.i = end + 1;
    } else {
      value = (this.take(/^[^\]|"']*/) ?? '').trim();
      if (!value) this.fail(`Missing value after "${op}"`);
    }
    this.space();
    return value;
  }

  /** Consume what `pattern` matches at the current position. */
  private take(pattern: RegExp): string | undefined {
    const match = pattern.exec(this.src.slice(this.i))?.[0];
    if (match) this.i += match.length;
    return match || undefined;
  }

  private space(): void {
    while (/\s/.test(this.src[this.i] ?? '')) this.i++;
  }

  private fail(message: string): never {
    throw new SelectorError(`${message} (column ${this.i + 1} of "${this.src}")`);
  }
}

function checkKeys(type: string, tests: AttributeTest[]): void {
  const known = knownKeys(type);
  const unknown = known && tests.find((t) => !known.includes(t.key));
  if (known && unknown) {
    throw new SelectorError(`"${type}" has no attribute "${unknown.key}".${didYouMean(unknown.key, known)} Attributes: ${known.join(', ')}`);
  }
}

function didYouMean(word: string, candidates: string[]): string {
  const hint = suggest(word, candidates);
  return hint ? ` Did you mean "${hint}"?` : '';
}

type Block = Omit<QueryMatch, 'text'>;

/** The blocks of a document that match any of the selectors, in document order. */
export function querySmd(text: string, selector: string | Selector[], options: QueryOptions = {}): QueryMatch[] {
  const selectors = typeof selector === 'string' ? parseSelector(selector) : selector;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const lines = text.split(/\r?\n/);
  const matched = blocksOf(text, lines, today).filter((b) => selectors.some((s) => selects(s, b, today)));
  return matched.map((b) => ({
    ...b,
    text: agentViewOfRange(lines, b.line, b.endLine, { brief: options.brief, lineRefs: options.lineRefs, today, includeHuman: b.type === 'human' }),
  }));
}

function blocksOf(text: string, lines: string[], today: string): Block[] {
  const headings = parseSmd(text).headings;
  const sectionAt = (line: number) => {
    let section: string | null = null;
    for (const h of headings) {
      if (h.line >= line) break;
      section = h.text;
    }
    return section;
  };
  return [
    ...headingBlocks(headings, lines.length),
    ...taskBlocks(text, today, sectionAt),
    ...containerBlocks(lines, parseFrontMatter(text).bodyStartLine, sectionAt),
  ].sort((a, b) => a.line - b.line);
}

function headingBlocks(headings: Heading[], lineCount: number): Block[] {
  return headings.map((h, i) => {
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    const parent = headings.slice(0, i).reverse().find((p) => p.level < h.level);
    return {
      type: 'heading', line: h.line, endLine: (next?.line ?? lineCount) - 1, title: h.text,
      attrs: { level: String(h.level), id: h.slug, ...(h.agent ? { agent: h.agent } : {}) },
      section: parent?.text ?? null,
    };
  });
}

function taskBlocks(text: string, today: string, sectionAt: (line: number) => string | null): Block[] {
  return extractTasks(text, today).map((t) => ({
    type: 'task', line: t.line, endLine: t.line, title: t.text,
    attrs: {
      done: String(t.done),
      overdue: String(t.overdue ?? false),
      ...(t.assignees.length ? { owner: t.assignees } : {}),
      ...(t.priority ? { priority: t.priority } : {}),
      ...(t.due ? { due: t.due } : {}),
    },
    section: sectionAt(t.line),
  }));
}

function containerBlocks(lines: string[], from: number, sectionAt: (line: number) => string | null): Block[] {
  const blocks: Block[] = [];
  const open: Block[] = [];
  let fence: Fence = null;
  for (let i = from; i < lines.length; i++) {
    const step = fenceStep(lines[i], fence);
    fence = step.fence;
    if (step.code) continue;
    if (CONTAINER_CLOSE.test(lines[i])) {
      const done = open.pop();
      if (done) done.endLine = i;
      continue;
    }
    const info = openingOf(lines[i]);
    if (!info) continue;
    const block: Block = { type: info.name, line: i, endLine: lines.length - 1, title: inlineText(info.title), attrs: containerAttrs(info), section: sectionAt(i) };
    blocks.push(block);
    open.push(block);
  }
  return blocks;
}

type Fence = { char: string; len: number } | null;

/** Follow fenced code: the fence open after `line`, and whether `line` is code or a fence line. */
function fenceStep(line: string, fence: Fence): { fence: Fence; code: boolean } {
  const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  if (!fence) return { fence: mark ? { char: mark[1][0], len: mark[1].length } : null, code: !!mark };
  const closes = !!mark && mark[1].startsWith(fence.char) && mark[1].length >= fence.len && !line.slice(mark[0].length).trim();
  return { fence: closes ? null : fence, code: true };
}

function openingOf(line: string): ContainerInfo | null {
  const open = CONTAINER_OPEN.exec(line);
  return open ? parseContainerInfo(open[3] + open[4]) : null;
}

/** Attributes as written plus the spec's defaults; the title is a field of its own. */
function containerAttrs(info: ContainerInfo): Record<string, string | string[]> {
  const attrs: Record<string, string | string[]> = { ...DEFAULTS[info.name], ...info.attrs.values };
  delete attrs.title;
  if (info.name === 'api') attrs.method = String(attrs.method).toUpperCase();
  if (info.attrs.id) attrs.id = info.attrs.id;
  if (info.attrs.classes.length) attrs.class = info.attrs.classes;
  return attrs;
}

function selects(selector: Selector, block: Block, today: string): boolean {
  const type = selector.type;
  if (type !== '*' && type !== block.type && !(type === 'callout' && (CALLOUT_TYPES as readonly string[]).includes(block.type))) return false;
  return selector.tests.every((t) => passes(t, valueOf(block, t.key), today));
}

function valueOf(block: Block, key: string): string | string[] | undefined {
  if (key === 'title') return block.title;
  if (key === 'section') return block.section ?? undefined;
  if (key === 'type') return block.type;
  return block.attrs[key];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/^@/, '');

function passes(test: AttributeTest, actual: string | string[] | undefined, today: string): boolean {
  const list = [actual ?? []].flat();
  const any = (check: (a: string, v: string) => boolean) => list.some((a) => test.values.some((v) => check(norm(a), norm(v))));
  switch (test.op) {
    case 'exists': return list.some((a) => a.trim() !== '' && norm(a) !== 'false');
    case '=': return any((a, v) => a === v);
    case '!=': return !any((a, v) => a === v);
    case '*=': return any((a, v) => a.includes(v));
    case '^=': return any((a, v) => a.startsWith(v));
    case '$=': return any((a, v) => a.endsWith(v));
    default: {
      const want = rank(test.key, test.values[0], today);
      return want !== undefined && list.some((a) => {
        const have = rank(test.key, a, today);
        if (have === undefined) return false;
        switch (test.op) {
          case '<': return have < want;
          case '<=': return have <= want;
          case '>': return have > want;
          default: return have >= want;
        }
      });
    }
  }
}

/** A value's place in its order, for `<` and friends; undefined when it has none. */
function rank(key: string, value: string, today: string): number | undefined {
  const v = value.trim().toLowerCase();
  if (key === 'priority') return PRIORITY_RANK[v];
  if (key === 'impact' || key === 'likelihood') {
    const level = RISK_LEVELS.indexOf(v);
    return level < 0 ? undefined : level;
  }
  const date = v === 'today' ? today : v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const time = Date.parse(date);
    return Number.isNaN(time) ? undefined : time;
  }
  return /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : undefined;
}
