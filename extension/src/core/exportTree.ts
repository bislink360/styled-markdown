import type { Token } from 'markdown-it';
import { resolveColor } from './attrs';
import { langFromPath, parseFenceInfo, sliceLines } from './fence';
import { FigureCounter } from './figures';
import { label, term, type MessageKey, type Messages } from './i18n';
import { includeHref, includeLabel, includeProblemText, includeRequest } from './include';
import { figureLabel, PRIORITY_COLORS } from './markdownItHtml';
import {
  envFigures, type ContainerMeta, type DirectiveMeta, type FootnoteMeta, type SpanMeta, type TaskBoxMeta,
} from './markdownItRules';
import { quoteCite } from './quote';
import { parseSmdTokens, type ParsedTokens } from './render';
import { riskMatrix, riskRegister } from './risks';
import { CALLOUT_TYPES } from './spec';

/**
 * The document tree the exporters (confluence.ts, notion.ts) write. It is built from the very tokens renderSmd
 * renders, so every .smd rule (includes, figures, footnotes, glossaries, variables, tasks) has already run; this
 * only reads them. Human view rules apply as in rendering: `:::agent` follows `agentBlocks`, `:::human` and
 * `{agent=skip}` sections stay. Raw HTML never passes through: its tags are dropped and its text kept.
 */

export interface ExportOptions {
  /** Read a file relative to the document, for `:::include` blocks and ```lang file="…"` embeds. Without it nothing is included. */
  readFile?: (relativePath: string) => string | undefined;
  /** How `:::agent` blocks are exported: `collapsed` (the default) as an expand/toggle, `expanded` as a panel, `hidden` left out. */
  agentBlocks?: 'collapsed' | 'expanded' | 'hidden';
  /** The language of the labels added ("Note", "Figure 2") for a document without a `lang:` of its own. */
  lang?: string;
  /** Start with the front matter's status, version, dates, summary, owners and tags (default true). The title is the page's own. */
  header?: boolean;
}

/** Text styles. Colours are as written in the document: a named colour (`red`) or a CSS colour (`#0ea5e9`). */
export interface Marks {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
  /** A background colour (`==mark==` is `yellow`). */
  highlight?: string;
  /** A link: `#id` for a place in the document, else the URL as markdown-it normalized it. */
  href?: string;
}

export type Inline =
  | { kind: 'text'; text: string; marks: Marks }
  | { kind: 'break' }
  | { kind: 'math'; tex: string; marks: Marks }
  /** `:badge`, `:status`, `:priority` and statuses of decisions: a coloured label. */
  | { kind: 'status'; text: string; color: string }
  /** A YYYY-MM-DD date (`:due`, decision dates, changelog dates). */
  | { kind: 'date'; date: string }
  | { kind: 'footnote'; n: number }
  | { kind: 'image'; src: string; alt: string };

/** What a panel stands for, so a writer can give it an icon. */
export type PanelType = 'card' | 'agent' | 'human' | 'decision' | 'risk' | 'api';

export interface ListItem {
  /** Set for task list items. */
  task?: { checked: boolean };
  blocks: Block[];
}

export type Block =
  | { kind: 'heading'; level: number; content: Inline[]; id?: string }
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  /** Fenced code; Mermaid diagrams are code with lang `mermaid`. */
  | { kind: 'code'; code: string; lang: string; title?: string }
  | { kind: 'math'; tex: string }
  | { kind: 'quote'; blocks: Block[] }
  /** A callout: `type` is one of CALLOUT_TYPES; `title` is plain text. */
  | { kind: 'callout'; type: string; title: string; blocks: Block[] }
  | { kind: 'panel'; type: PanelType; title: string; blocks: Block[] }
  /** Content shown on demand: `:::details`, tabs, collapsed agent blocks and collapsible callouts. */
  | { kind: 'expand'; title: string; blocks: Block[] }
  | { kind: 'rule' }
  | { kind: 'table'; header: boolean; rows: Inline[][][] }
  /** A place links can point at (`#id`), such as a figure's id. */
  | { kind: 'anchor'; id: string }
  | { kind: 'footnotes'; items: Array<{ n: number; blocks: Block[] }> };

export interface ExportDocument {
  blocks: Block[];
  /** The front matter title, for the page's own title. */
  title?: string;
  lang: string;
  messages: Messages;
}

/** The export tree of a .smd document. */
export function exportTree(text: string, options: ExportOptions = {}): ExportDocument {
  const parsed = parseSmdTokens(text, { readFile: options.readFile, agentBlocks: options.agentBlocks, lang: options.lang, today: '1970-01-01' });
  const builder = new TreeBuilder(parsed, options);
  const header = options.header === false ? [] : builder.header();
  const blocks = [...header, ...builder.blocks(0, parsed.tokens.length)];
  const title = typeof parsed.data.title === 'string' ? parsed.data.title : undefined;
  return { blocks, title, lang: parsed.lang, messages: parsed.messages };
}

/** The blocks directly inside a block. */
export function childBlocks(block: Block): Block[] {
  switch (block.kind) {
    case 'quote': case 'callout': case 'panel': case 'expand':
      return block.blocks;
    case 'list':
      return block.items.flatMap((i) => i.blocks);
    case 'footnotes':
      return block.items.flatMap((i) => i.blocks);
    default:
      return [];
  }
}

/** The runs of inline content of a block itself (not of the blocks inside it). */
export function blockInlines(block: Block): Inline[][] {
  if (block.kind === 'heading' || block.kind === 'paragraph') return [block.content];
  return block.kind === 'table' ? block.rows.flat() : [];
}

/** The text of inline content, without styles. */
export function inlineText(inlines: Inline[]): string {
  return inlines.map((i) => INLINE_TEXT[i.kind](i as never)).join('');
}

const INLINE_TEXT: { [K in Inline['kind']]: (i: Extract<Inline, { kind: K }>) => string } = {
  text: (i) => i.text,
  break: () => '\n',
  math: (i) => i.tex,
  status: (i) => i.text,
  date: (i) => i.date,
  footnote: (i) => `[${i.n}]`,
  image: (i) => i.alt,
};

/** A named colour (`red`), else a CSS colour the renderer accepts (`#0ea5e9`, `rgb(…)`), else undefined. */
export function exportColor(value: string | undefined): { named?: string; css?: string } | undefined {
  if (value === undefined) return undefined;
  const css = resolveColor(value);
  if (!css) return undefined;
  return css.startsWith('var(') ? { named: value.trim() } : { css };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_STATUS_COLORS = new Map([['draft', 'amber'], ['review', 'blue'], ['approved', 'green'], ['deprecated', 'red']]);
const DECISION_COLORS = new Map([['proposed', 'blue'], ['accepted', 'green'], ['rejected', 'red']]);
const MATH_FENCES = new Set(['math', 'latex', 'katex']);
const text = (value: string, marks: Marks = {}): Inline => ({ kind: 'text', text: value, marks });
const paragraph = (content: Inline[]): Block => ({ kind: 'paragraph', content });
const dateOrText = (value: string, marks: Marks = {}): Inline => (ISO_DATE.test(value) ? { kind: 'date', date: value } : text(value, marks));
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Facts joined with ` · `. */
function joinFacts(facts: Inline[][]): Inline[] {
  return facts.filter((f) => f.length).flatMap((f, n) => (n ? [text(' · '), ...f] : f));
}

/** The index of the token that closes the one opened at `open` (same type, `_open` → `_close`, nested ones skipped). */
function closeOf(tokens: Token[], open: number): number {
  const type = tokens[open].type;
  const closeType = type.replace(/_open$/, '_close');
  let depth = 0;
  for (let j = open + 1; j < tokens.length; j++) {
    const t = tokens[j].type;
    if (t === type) depth++;
    else if (t === closeType && depth-- === 0) return j;
  }
  return tokens.length;
}

interface Step { blocks: Block[]; next: number }

/** A container being exported: its meta, its plain title and its body. */
interface ContainerCall {
  b: TreeBuilder;
  meta: ContainerMeta;
  title: string;
  body: () => Block[];
}

class TreeBuilder {
  readonly tokens: Token[];
  readonly m: Messages;
  private readonly inlines: InlineReader;

  constructor(readonly parsed: ParsedTokens, readonly options: ExportOptions) {
    this.tokens = parsed.tokens;
    this.m = parsed.messages;
    this.inlines = new InlineReader(this);
  }

  /** The blocks of the tokens from `from` up to (not including) `to`. */
  blocks(from: number, to: number): Block[] {
    const out: Block[] = [];
    let i = from;
    while (i < to) {
      const step = this.block(i);
      out.push(...step.blocks);
      i = step.next;
    }
    return out;
  }

  /** Inline content of an `inline` token. */
  inline(token: Token | undefined): Inline[] {
    return this.inlines.read(token?.children ?? []);
  }

  /** Inline Markdown in a title or an attribute, parsed as renderSmd parses container titles. */
  inlineMarkdown(source: string): Inline[] {
    const { smdVariables, smdFigures } = this.parsed.env;
    const tokens = this.parsed.md.parseInline(source, { smdVariables, smdFigures, messages: this.m });
    return this.inline(tokens[0]);
  }

  plain(source: string): string {
    return inlineText(this.inlineMarkdown(source)).trim();
  }

  private block(i: number): Step {
    const t = this.tokens[i];
    const close = () => closeOf(this.tokens, i);
    switch (t.type) {
      case 'heading_open': {
        const id = t.attrGet('id') ?? undefined;
        return { blocks: [{ kind: 'heading', level: Number(t.tag.slice(1)), content: this.inline(this.tokens[i + 1]), id }], next: close() + 1 };
      }
      case 'paragraph_open':
        return { blocks: [paragraph(this.inline(this.tokens[i + 1]))], next: close() + 1 };
      case 'bullet_list_open':
      case 'ordered_list_open':
        return this.list(i, close());
      case 'blockquote_open':
        return { blocks: [{ kind: 'quote', blocks: this.blocks(i + 1, close()) }], next: close() + 1 };
      case 'table_open':
        return this.table(i, close());
      case 'container_smd_open':
        return this.container(i, close());
      case 'smd_footnotes_open':
        return this.footnotes(i, close());
      case 'smd_glossary_open':
        return this.glossary(i, close());
      case 'fence':
        return { blocks: this.fence(t), next: i + 1 };
      case 'code_block':
        return { blocks: [{ kind: 'code', code: t.content.replace(/\n$/, ''), lang: '' }], next: i + 1 };
      case 'smd_math_block':
        return { blocks: [{ kind: 'math', tex: t.content.trim() }], next: i + 1 };
      case 'hr':
        return { blocks: [{ kind: 'rule' }], next: i + 1 };
      case 'html_block':
        return { blocks: htmlParagraphs(t.content), next: i + 1 };
      default:
        // Wrappers without meaning of their own (changelog lists, the tokens of other plugins): their content is read on.
        return { blocks: [], next: i + 1 };
    }
  }

  private list(open: number, close: number): Step {
    const items: ListItem[] = [];
    let j = open + 1;
    while (j < close) {
      const end = closeOf(this.tokens, j);
      const item = this.tokens[j];
      if (item.type === 'list_item_open') {
        const cls = item.attrGet('class') ?? '';
        const task = /\bsmd-task\b/.test(cls) ? { checked: /\bsmd-task-done\b/.test(cls) } : undefined;
        items.push({ task, blocks: this.blocks(j + 1, end) });
      }
      j = end + 1;
    }
    return { blocks: [{ kind: 'list', ordered: this.tokens[open].type === 'ordered_list_open', items }], next: close + 1 };
  }

  private table(open: number, close: number): Step {
    const rows: Inline[][][] = [];
    let header = false;
    for (let j = open + 1; j < close; j++) {
      const t = this.tokens[j];
      if (t.type === 'thead_open') header = true;
      else if (t.type === 'tr_open') rows.push([]);
      else if (t.type === 'inline') rows.at(-1)?.push(this.inline(t));
    }
    return { blocks: [{ kind: 'table', header, rows }], next: close + 1 };
  }

  private footnotes(open: number, close: number): Step {
    const items: Array<{ n: number; blocks: Block[] }> = [];
    let j = open + 1;
    while (j < close) {
      const end = closeOf(this.tokens, j);
      if (this.tokens[j].type === 'smd_footnote_open') items.push({ n: (this.tokens[j].meta as FootnoteMeta).n, blocks: this.blocks(j + 1, end) });
      j = end + 1;
    }
    return { blocks: [{ kind: 'footnotes', items }], next: close + 1 };
  }

  /** `:::glossary` lists became `<dl>` tokens; they go back to `- **Term**: definition` items. */
  private glossary(open: number, close: number): Step {
    const items: ListItem[] = [];
    let j = open + 1;
    while (j < close) {
      const end = closeOf(this.tokens, j);
      if (this.tokens[j].type === 'smd_glossary_term_open') items.push(this.glossaryEntry(j, end));
      j = this.tokens[end + 1]?.type === 'smd_glossary_definition_open' ? closeOf(this.tokens, end + 1) + 1 : end + 1;
    }
    return { blocks: [{ kind: 'list', ordered: false, items }], next: close + 1 };
  }

  private glossaryEntry(termOpen: number, termClose: number): ListItem {
    const termText = this.inline(this.tokens[termOpen + 1]);
    const dd = termClose + 1;
    const definition = this.tokens[dd]?.type === 'smd_glossary_definition_open' ? this.blocks(dd + 1, closeOf(this.tokens, dd)) : [];
    const [first, ...rest] = definition;
    if (first?.kind !== 'paragraph') return { blocks: [paragraph(termText), ...definition] };
    return { blocks: [paragraph([...termText, text(': '), ...first.content]), ...rest] };
  }

  private fence(t: Token): Block[] {
    const info = parseFenceInfo(t.info);
    const lang = info.lang.toLowerCase();
    if (MATH_FENCES.has(lang)) return [{ kind: 'math', tex: t.content.trim() }];
    if (!info.file) return [{ kind: 'code', code: t.content.replace(/\n$/, ''), lang: info.lang, title: info.title }];
    const loaded = this.options.readFile?.(info.file);
    const range = info.lines ? `:${info.lines[0]}-${info.lines[1]}` : '';
    const title = info.title ?? info.file + range;
    if (loaded === undefined) {
      const problem = label(this.m, 'code.cannotRead', { file: info.file });
      return [paragraph([text(title, { code: true }), text(` ${problem}`, { italic: true })])];
    }
    return [{ kind: 'code', code: sliceLines(loaded, info.lines).text.replace(/\n$/, ''), lang: info.lang || langFromPath(info.file), title }];
  }

  private container(open: number, close: number): Step {
    const meta = this.tokens[open].meta as ContainerMeta;
    const call: ContainerCall = { b: this, meta, title: meta.title ? this.plain(meta.title) : '', body: () => this.blocks(open + 1, close) };
    const rule = (CALLOUT_TYPES as readonly string[]).includes(meta.name) ? callout : CONTAINERS.get(meta.name);
    return { blocks: rule ? rule(call) : call.body(), next: close + 1 };
  }

  /** The front matter facts renderSmd shows in its header, but the title (the page's own). */
  header(): Block[] {
    const data = this.parsed.data;
    const m = this.m;
    const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
    const facts = joinFacts([
      status ? [{ kind: 'status', text: term(m, 'docStatus', status), color: DOC_STATUS_COLORS.get(status) ?? 'gray' }] : [],
      data.version === undefined ? [] : [text(label(m, 'header.version', { version: String(data.version) }))],
      data.updated === undefined ? [] : [text(label(m, 'header.updated', { date: String(data.updated) }))],
    ]);
    const lists = joinFacts([listFact(m['header.owners'], data.owners), listFact(m['header.tags'], data.tags)]);
    const summary = typeof data.summary === 'string' ? this.inlineMarkdown(data.summary) : [];
    return [facts, summary, lists].filter((c) => c.length).map(paragraph);
  }
}

function listFact(name: string, value: unknown): Inline[] {
  const items = (Array.isArray(value) ? value : [value]).filter((v) => typeof v === 'string' || typeof v === 'number').map(String);
  return items.length ? [text(`${name}: `, { bold: true }), text(items.join(', '))] : [];
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

const withTitle = (prefix: string, title: string) => (title ? `${prefix}: ${title}` : prefix);
/** A bold title paragraph, then the body. */
const titled = (c: ContainerCall): Block[] => (c.title ? [paragraph([text(c.title, { bold: true })]), ...c.body()] : c.body());

function callout(c: ContainerCall): Block[] {
  const type = c.meta.name;
  const typeLabel = c.b.m[`callout.${type}` as MessageKey];
  if (c.meta.attrs.values.collapsible === undefined) return [{ kind: 'callout', type, title: c.title || typeLabel, blocks: c.body() }];
  // Collapsible: the title on the expand, the type on the callout inside it.
  return [{ kind: 'expand', title: c.title || typeLabel, blocks: [{ kind: 'callout', type, title: typeLabel, blocks: c.body() }] }];
}

function agent(c: ContainerCall): Block[] {
  const mode = c.b.options.agentBlocks ?? 'collapsed';
  if (mode === 'hidden') return [];
  const title = withTitle(c.b.m['agent.label'], c.title);
  return [mode === 'expanded' ? { kind: 'panel', type: 'agent', title, blocks: c.body() } : { kind: 'expand', title, blocks: c.body() }];
}

function decision(c: ContainerCall): Block[] {
  const { values } = c.meta.attrs;
  const status = (values.status ?? 'proposed').toLowerCase();
  const facts = joinFacts([
    [{ kind: 'status', text: term(c.b.m, 'decisionStatus', status), color: DECISION_COLORS.get(status) ?? 'gray' }],
    values.date ? [dateOrText(values.date)] : [],
    values.owner ? [text(values.owner)] : [],
  ]);
  return [{ kind: 'panel', type: 'decision', title: withTitle(c.b.m['decision.label'], c.title), blocks: [paragraph(facts), ...c.body()] }];
}

function risk(c: ContainerCall): Block[] {
  const { values } = c.meta.attrs;
  const { m } = c.b;
  const level = (name: string, group: 'impact' | 'likelihood', value: string | undefined) =>
    (value ? [text(`${name} `), text(term(m, group, value.toLowerCase()), { bold: true })] : []);
  const facts = joinFacts([
    level(m['label.impact'], 'impact', values.impact ?? 'medium'),
    level(m['label.likelihood'], 'likelihood', values.likelihood),
    values.owner ? [text(`${m['label.owner']} ${values.owner}`)] : [],
    values.status ? [{ kind: 'status', text: term(m, 'riskStatus', values.status), color: 'gray' }] : [],
  ]);
  return [{ kind: 'panel', type: 'risk', title: withTitle(m['risk.title'], c.title), blocks: [paragraph(facts), ...c.body()] }];
}

function api(c: ContainerCall): Block[] {
  const { values } = c.meta.attrs;
  const head = `${(values.method ?? 'GET').toUpperCase()} ${values.path ?? '/'}`;
  const auth = values.auth ? [paragraph([text('🔒 '), text(values.auth, { code: true })])] : [];
  return [{ kind: 'panel', type: 'api', title: c.title ? `${head} — ${c.title}` : head, blocks: [...auth, ...c.body()] }];
}

/** `:::risk-matrix`: a table of the document's risks (closed ones left out) by impact and likelihood, as rendered. */
function riskMatrixBlocks(c: ContainerCall): Block[] {
  const { m } = c.b;
  const risks = riskRegister([{ path: '', text: c.b.parsed.env.source ?? c.meta.source ?? '' }]).risks;
  const matrix = riskMatrix(risks);
  const head = [[text(m['riskMatrix.corner'])], ...matrix.likelihood.map((l) => [text(capitalize(term(m, 'likelihood', l)))])];
  const rows = matrix.impact.map((impact) => [
    [text(capitalize(term(m, 'impact', impact)), { bold: true })],
    ...matrix.likelihood.map((likelihood) => risks
      .filter((r) => r.impact === impact && r.likelihood === likelihood)
      .flatMap((r, n): Inline[] => (n ? [{ kind: 'break' }, text(r.title)] : [text(r.title)]))),
  ]);
  return titled({ ...c, body: () => [{ kind: 'table', header: true, rows: [head, ...rows] }, ...c.body()] });
}

/** `:::include`: the included blocks (spliced in by markdownItInclude.ts), or a note and the fallback body. */
function include(c: ContainerCall): Block[] {
  const result = c.meta.include;
  if (result?.ok) return c.body();
  const request = includeRequest(c.meta.attrs.values);
  const { m } = c.b;
  if (!request) return [paragraph([text(m['include.needsFile'], { italic: true })]), ...c.body()];
  const failure = result && !result.ok ? result : undefined;
  const path = failure?.path ?? request.file;
  const href = includeHref(path, request.section);
  const note = [
    text(`${failure ? includeProblemText(failure, m) : m['include.unavailable']}: `, { italic: true }),
    text(includeLabel(path, request.section), { code: true, href }),
  ];
  return [paragraph(note), ...c.body()];
}

/** `:::figure`: an anchor for its id, the content, then the numbered caption. */
function figure(c: ContainerCall): Block[] {
  const { meta } = c;
  const number = figureLabel(meta.figure ?? new FigureCounter().next(meta.attrs.values.kind), c.b.m);
  const caption = meta.title ? c.b.inlineMarkdown(meta.title).map((i) => withMarks(i, { italic: true })) : [];
  // "Figure 1: Caption", "Figure 1" without a caption.
  const content = caption.length ? [text(`${number}:`, { bold: true }), text(' '), ...caption] : [text(number, { bold: true })];
  const anchor: Block[] = meta.attrs.id ? [{ kind: 'anchor', id: meta.attrs.id }] : [];
  return [...anchor, ...c.body(), paragraph(content)];
}

/** `:::quote`: the quoted blocks, then `— Author, Source` (the source linking to `cite`). */
function quote(c: ContainerCall): Block[] {
  const { values } = c.meta.attrs;
  const { m } = c.b;
  const href = quoteCite(values.cite);
  const source = values.source ? c.b.inlineMarkdown(values.source).map((i) => withMarks(i, { italic: true, href })) : [];
  const author = values.author ? c.b.inlineMarkdown(values.author) : [];
  const by = [author, source].filter((p) => p.length).flatMap((p, n) => (n ? [text(m['quote.separator']), ...p] : p));
  const [before, after] = m['quote.caption'].split('{by}');
  const caption = by.length ? [paragraph([text(before), ...by, text(after ?? '')].filter((i) => i.kind !== 'text' || i.text))] : [];
  return [{ kind: 'quote', blocks: [...c.body(), ...caption] }];
}

function withMarks(inline: Inline, marks: Marks): Inline {
  return 'marks' in inline ? { ...inline, marks: { ...marks, ...inline.marks, href: inline.marks.href ?? marks.href } } : inline;
}

const CONTAINERS = new Map<string, (c: ContainerCall) => Block[]>([
  ['details', (c) => [{ kind: 'expand', title: c.title || c.b.m['details.title'], blocks: c.body() }]],
  ['tab', (c) => [{ kind: 'expand', title: c.title || c.b.m['tab.title'], blocks: c.body() }]],
  ['card', (c) => [{ kind: 'panel', type: 'card', title: c.title, blocks: c.body() }]],
  ['human', (c) => [{ kind: 'panel', type: 'human', title: withTitle(c.b.m['human.label'], c.title), blocks: c.body() }]],
  ['agent', agent],
  ['decision', decision],
  ['risk', risk],
  ['api', api],
  ['risk-matrix', riskMatrixBlocks],
  ['include', include],
  ['figure', figure],
  ['quote', quote],
  ['glossary', titled],
  ['changelog', titled],
]);

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

/** The marks a token opens; the matching `_close` token ends them. */
const MARK_OPENERS = new Map<string, (t: Token) => Marks>([
  ['strong_open', () => ({ bold: true })],
  ['em_open', () => ({ italic: true })],
  ['s_open', () => ({ strike: true })],
  ['smd_mark_open', () => ({ highlight: 'yellow' })],
  ['smd_dfn_open', () => ({ bold: true })],
  ['link_open', (t) => ({ href: t.attrGet('href') ?? undefined })],
  ['smd_span_open', (t) => spanMarks((t.meta as SpanMeta | null)?.values ?? {})],
]);
const MARK_CLOSERS = new Set([...MARK_OPENERS.keys()].map((k) => k.replace(/_open$/, '_close')));

const SPAN_STYLES = new Map<string, Marks>([['italic', { italic: true }], ['underline', { underline: true }], ['strike', { strike: true }]]);

/** `[text]{color=red weight=bold}`: the styles a page can keep (colours, weight, style, monospace); size, border and alignment are dropped. */
function spanMarks(values: Record<string, string>): Marks {
  const marks: Marks = { ...SPAN_STYLES.get(values.style ?? '') };
  if (values.weight === 'bold') marks.bold = true;
  if (values.font === 'mono') marks.code = true;
  if (exportColor(values.color)) marks.color = values.color.trim();
  if (exportColor(values.bg)) marks.highlight = values.bg.trim();
  return marks;
}

class InlineReader {
  private out: Inline[] = [];
  private stack: Marks[] = [{}];

  constructor(private readonly b: TreeBuilder) {}

  read(children: Token[]): Inline[] {
    const saved = { out: this.out, stack: this.stack };
    this.out = [];
    this.stack = [{}];
    for (const c of children) this.token(c);
    const result = this.out;
    Object.assign(this, saved);
    return result;
  }

  private get marks(): Marks {
    return this.stack.at(-1)!;
  }

  private text(value: string, extra: Marks = {}): void {
    if (value) this.out.push(text(value, { ...this.marks, ...extra }));
  }

  private token(c: Token): void {
    const opener = MARK_OPENERS.get(c.type);
    if (opener) {
      this.stack.push({ ...this.marks, ...opener(c) });
      return;
    }
    if (MARK_CLOSERS.has(c.type)) {
      if (this.stack.length > 1) this.stack.pop();
      return;
    }
    this.leaf(c);
  }

  /** Content tokens; the rest (footnote back links, changelog version spans) add nothing. */
  private leaf(c: Token): void {
    switch (c.type) {
      case 'text':
      case 'smd_variable':
        return this.text(c.content);
      case 'code_inline':
        return this.text(c.content, { code: true });
      case 'softbreak':
        return this.text(' ');
      case 'smd_ref':
        return this.ref((c.meta as { id: string }).id);
      case 'html_inline':
        return this.html(c);
      default: {
        const inline = this.content(c);
        if (inline) this.out.push(inline);
      }
    }
  }

  private content(c: Token): Inline | undefined {
    switch (c.type) {
      case 'hardbreak':
        return { kind: 'break' };
      case 'image':
        return { kind: 'image', src: c.attrGet('src') ?? '', alt: c.content };
      case 'smd_math_inline':
        return { kind: 'math', tex: c.content, marks: this.marks };
      case 'smd_footnote_ref':
        return { kind: 'footnote', n: (c.meta as FootnoteMeta).n };
      case 'smd_changelog_date':
        return dateOrText(c.content, this.marks);
      default:
        return undefined;
    }
  }

  /** `:ref[id]`: the figure's label ("Figure 2"), linking to it. */
  private ref(id: string): void {
    const figure = envFigures(this.b.parsed.env).get(id);
    this.text(figure ? figureLabel(figure, this.b.m) : id, { href: `#${id}` });
  }

  /** A directive or task box from the .smd rules, else raw HTML: tags are dropped (the text between them is in text tokens). */
  private html(c: Token): void {
    const meta = c.meta as Partial<DirectiveMeta & TaskBoxMeta> | null;
    if (meta?.directive) this.out.push(...directive(meta as DirectiveMeta, this.b, this.marks));
    else if (!meta?.taskBox && /^<br\s*\/?>$/i.test(c.content.trim())) this.out.push({ kind: 'break' });
  }
}

// ---------------------------------------------------------------------------
// Inline directives
// ---------------------------------------------------------------------------

type DirectiveExport = (d: DirectiveMeta, b: TreeBuilder, marks: Marks) => Inline[];

const statusColor = (value: string | undefined): string => (exportColor(value)?.named ?? 'gray');

const DIRECTIVES = new Map<string, DirectiveExport>([
  ['badge', (d, b) => [{ kind: 'status', text: b.plain(d.content), color: statusColor(d.values.color) }]],
  ['status', (d, b) => {
    const content = b.plain(d.content);
    const fallback = d.values.color === undefined ? b.m['statusDot.label'] : term(b.m, 'color', d.values.color);
    return [{ kind: 'status', text: content || fallback, color: statusColor(d.values.color) }];
  }],
  ['priority', (d, b) => {
    const level = d.content.trim();
    return [{ kind: 'status', text: term(b.m, 'priority', level), color: PRIORITY_COLORS.get(level.toLowerCase()) ?? 'gray' }];
  }],
  ['due', (d, _b, marks) => [dateOrText(d.content.trim(), marks)]],
  ['kbd', (d, _b, marks) => [text(d.content.trim(), { ...marks, code: true })]],
  ['mention', (d, _b, marks) => [text(d.content, marks)]],
  ['progress', (d, _b, marks) => [text(progressText(d), marks)]],
  ['metric', metric],
]);

function directive(d: DirectiveMeta, b: TreeBuilder, marks: Marks): Inline[] {
  return (DIRECTIVES.get(d.directive) ?? ((x: DirectiveMeta) => [text(x.content, marks)]))(d, b, marks);
}

function progressText(d: DirectiveMeta): string {
  const raw = Number.parseFloat(d.values.value ?? d.content ?? '0');
  const value = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  return d.values.label ?? `${Math.round(value)}%`;
}

const TREND_ARROWS = new Map([['up', '▲'], ['down', '▼'], ['flat', '■']]);

/** `:metric[42%]{label="Activation" delta="+3%" trend=up}` → **42%** Activation ▲ +3% */
function metric(d: DirectiveMeta, b: TreeBuilder, marks: Marks): Inline[] {
  const { values } = d;
  const trend = values.trend ?? (values.delta?.trim().startsWith('-') ? 'down' : 'up');
  const delta = values.delta ? [TREND_ARROWS.get(trend), values.delta] : [];
  const rest = [values.label, ...delta].filter(Boolean).join(' ');
  return [text(b.plain(d.content), { ...marks, bold: true }), ...(rest ? [text(` ${rest}`, marks)] : [])];
}

// ---------------------------------------------------------------------------
// Raw HTML
// ---------------------------------------------------------------------------

/** An HTML block as paragraphs of its text: tags, comments, scripts and styles dropped, entities decoded. */
export function htmlParagraphs(html: string): Block[] {
  return htmlToText(html).split(/\n[^\S\n]*\n/).map((p) => p.replaceAll(/\s+/g, ' ').trim()).filter(Boolean).map((p) => paragraph([text(p)]));
}

const SKIPPED_ELEMENTS = new Set(['script', 'style', 'template', 'textarea', 'title']);

/** The text of HTML: tags, comments, scripts and styles dropped, entities decoded. A `<` that starts no markup is text. */
export function htmlToText(html: string): string {
  let out = '';
  let pos = 0;
  while (pos < html.length) {
    const open = html.indexOf('<', pos);
    if (open < 0) break;
    const end = markupEnd(html, open);
    out += html.slice(pos, end === undefined ? open + 1 : open);
    pos = end ?? open + 1;
  }
  return decodeEntities(out + html.slice(pos));
}

/** The position after the markup starting at `open` (a comment, a tag, or an element whose content is not text), if it is markup. */
function markupEnd(html: string, open: number): number | undefined {
  if (html.startsWith('<!--', open)) return after(html, '-->', open + 4);
  const m = /^<(\/?)([a-z][a-z0-9-]*)|^<[!?]/i.exec(html.slice(open, open + 40));
  if (!m) return undefined;
  const end = after(html, '>', open);
  const name = m[2]?.toLowerCase();
  if (m[1] || !name || !SKIPPED_ELEMENTS.has(name)) return end;
  const closeAt = html.toLowerCase().indexOf(`</${name}`, end);
  return closeAt < 0 ? html.length : after(html, '>', closeAt);
}

/** The position after the first `token` at or after `from`, or the end. */
function after(html: string, token: string, from: number): number {
  const at = html.indexOf(token, from);
  return at < 0 ? html.length : at + token.length;
}

const ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' ']]);

function decodeEntities(s: string): string {
  return s.replaceAll(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (!body.startsWith('#')) return ENTITIES.get(body.toLowerCase()) ?? whole;
    const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}
