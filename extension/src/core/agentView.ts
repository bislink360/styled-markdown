import { parseAttrs } from './attrs';
import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo } from './containers';
import { parseFenceInfo, sliceLines } from './fence';
import { parseFrontMatter, asStringList } from './frontmatter';
import { parseSmd } from './parse';
import { dueState, HEADING_ATTRS, slugify, type Heading } from './render';
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
  readFile?: (relativePath: string) => string | undefined;
  today?: string;
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
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TAGS: Record<string, string> = { ...Object.fromEntries(CALLOUT_TYPES.map((c) => [c, c])) };
const NOISE_KEYS = new Set(['smd', 'theme', 'accent', 'toc', 'title', 'summary']);

interface Section { heading: Heading; start: number; end: number }

function sectionsOf(headings: Heading[], lineCount: number): Section[] {
  return headings.map((h, i) => {
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    return { heading: h, start: h.line, end: (next ? next.line : lineCount) - 1 };
  });
}

function matches(h: Heading, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^#+\s*/, '');
  return h.slug === slugify(q) || h.slug === q || h.text.toLowerCase().includes(q);
}

export function agentView(text: string, options: AgentViewOptions = {}): AgentViewResult {
  const fm = parseFrontMatter(text);
  const lines = text.split(/\r?\n/);
  const headings = parseSmd(text).headings;
  const sections = sectionsOf(headings, lines.length);

  // Which lines are in scope?
  const skipped = sections.filter((s) => s.heading.agent === 'skip');
  let selected: Section[] | null = null;
  const missingSections: string[] = [];
  if (options.sections?.length) {
    selected = [];
    for (const q of options.sections) {
      const hit = sections.filter((s) => matches(s.heading, q));
      if (hit.length) selected.push(...hit); else missingSections.push(q);
    }
  }
  const inScope = (line: number) =>
    (!selected || selected.some((s) => line >= s.start && line <= s.end)) &&
    !skipped.some((s) => line >= s.start && line <= s.end && !(selected?.some((sel) => sel.heading === s.heading)));

  const body = transform(lines, fm.bodyStartLine, inScope, options);

  // :::agent blocks outside the selected sections still apply — include them up front.
  let external = '';
  if (selected) {
    const outside = transform(lines, fm.bodyStartLine, (l) => !inScope(l), { ...options, onlyAgentBlocks: true });
    if (outside.trim()) external = `Document-wide agent instructions:\n${outside.trim()}\n\n`;
  }

  const out = [header(fm.data, selected ? selected.map((s) => s.heading.text) : null), external + body]
    .filter((s) => s.trim())
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';

  return {
    text: out,
    originalTokens: estimateTokens(text),
    tokens: estimateTokens(out),
    missingSections,
    skippedSections: skipped.map((s) => s.heading.text),
  };
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
  /** Receives every emitted line with the source line it came from. */
  collect?: Array<[at: number, line: string]>;
}

function transform(lines: string[], from: number, inScope: (line: number) => boolean, options: TransformOptions): string {
  const out: string[] = [];
  const lineRefs = options.lineRefs ?? true;
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
      const title = info.title ? inlineText(info.title, options.today) : '';
      const v = info.attrs.values;
      const attr = (keys: string[]) => keys.filter((k) => v[k]).map((k) => ` ${k}="${v[k]}"`).join('');
      const frame: Frame = { name: info.name, drop: false, start: i };
      stack.push(frame);
      if (info.name === 'human' && !options.includeHuman) { frame.drop = true; continue; }
      if (info.name === 'details' && options.brief) {
        emit(`[details: ${title || 'Details'} — omitted, see L${i + 1}]`, i);
        frame.drop = true;
        continue;
      }
      if (info.name === 'agent') {
        emit(`<agent-instructions${title ? ` title="${title}"` : ''}>`, i);
        frame.close = '</agent-instructions>';
      } else if (TAGS[info.name]) {
        emit(`<${info.name}${title ? ` title="${title}"` : ''}>`, i);
        frame.close = `</${info.name}>`;
      } else if (info.name === 'decision') {
        emit(`<decision${attr(['status', 'date', 'owner'])}>${title ? ` ${title}` : ''}`, i);
        frame.close = '</decision>';
      } else if (info.name === 'risk') {
        emit(`<risk${attr(['impact', 'likelihood', 'owner', 'status'])}>${title ? ` ${title}` : ''}`, i);
        frame.close = '</risk>';
      } else if (info.name === 'api') {
        emit(`API ${(v.method ?? 'GET').toUpperCase()} ${v.path ?? ''}${title ? ` — ${title}` : ''}${v.auth ? ` (auth: ${v.auth})` : ''}`, i);
      } else if (info.name === 'details' || info.name === 'human') {
        emit(`<${info.name}${title ? ` title="${title}"` : ''}>`, i);
        frame.close = `</${info.name}>`;
      } else if (info.name === 'tab') {
        emit(`Tab "${title || 'Tab'}":`, i);
      } else if (info.name === 'card' && title) {
        emit(`${title}:`, i);
      }
      // tabs, columns, column, box, steps, timeline and unknown containers: content only.
      continue;
    }

    // ---- headings ----
    const h = /^(\s{0,3}#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushDone(i);
      emit(`${h[1].trim()} ${inlineText(h[2].replace(HEADING_ATTRS, ''), options.today)}${lineRefs ? `  [L${i + 1}]` : ''}`, i);
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
      emit(isDelimiter ? `|${cells.map(() => '-').join('|')}|` : `|${cells.map((c) => inlineText(c, options.today)).join('|')}|`, i);
      continue;
    }

    const converted = inlineText(line, options.today, task ? task[2] === ' ' : false);
    emit(converted.trimEnd(), i);
  }
  flushDone(lines.length - 1);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The agent view of lines [start, end] (zero-based, inclusive) on their own, e.g. one block. */
export function agentViewOfRange(lines: string[], start: number, end: number, options: AgentViewOptions = {}): string {
  return transform(lines.slice(0, end + 1), start, () => true, options).trim();
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

/** Strip styling syntax from one line, keeping the words. Code spans are left untouched. */
export function inlineText(line: string, today?: string, openTask = false): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, idx) => (idx % 2 === 1 ? part : plain(part, today, openTask)))
    .join('');
}

function plain(s: string, today: string | undefined, openTask: boolean): string {
  return s
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
function sectionViews(lines: string[], from: number, options: TransformOptions): (start: number, end: number) => string {
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

/** The agent view of any line range of a document (zero-based, inclusive), with the context of the whole document. */
export function agentViewRanges(text: string, options: AgentViewOptions = {}): (start: number, end: number) => string {
  const view = sectionViews(text.split(/\r?\n/), parseFrontMatter(text).bodyStartLine, options);
  return (start, end) => view(start, end).replace(/\n{3,}/g, '\n\n').trim();
}

export function outline(text: string, options: AgentViewOptions = {}): string {
  const fm = parseFrontMatter(text);
  const lines = text.split(/\r?\n/);
  const headings = parseSmd(text).headings;
  const full = agentView(text, { ...options, sections: undefined });
  const title = typeof fm.data.title === 'string' ? fm.data.title : headings.find((h) => h.level === 1)?.text ?? '(untitled)';
  const status = typeof fm.data.status === 'string' ? ` · ${fm.data.status}` : '';
  const out: string[] = [
    `${title}${status} · file ≈${full.originalTokens} tokens · full agent view ≈${full.tokens} tokens`,
  ];
  if (typeof fm.data.summary === 'string') out.push(`summary: ${fm.data.summary}`);
  out.push('');

  const sections = sectionsOf(headings, lines.length);
  const sectionView = sectionViews(lines, fm.bodyStartLine, { ...options, lineRefs: false });
  const rows = sections.map((s) => {
    const sectionText = lines.slice(s.start, s.end + 1);
    // Cost of reading this section (including its subsections) through the agent view.
    const view = sectionView(s.start, s.end);
    const openTasks = sectionText.filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s/.test(l)).length;
    const notes = [
      openTasks ? `${openTasks} open task${openTasks > 1 ? 's' : ''}` : '',
      sectionText.some((l) => /^\s*```\s*mermaid/.test(l)) ? 'diagram' : '',
      sectionText.some((l) => /^\s*:{3,}\s*agent\b/.test(l)) ? 'AGENT INSTRUCTIONS' : '',
      sectionText.some((l) => /^\s*:{3,}\s*api\b/.test(l)) ? 'API' : '',
      sectionText.some((l) => /^\s*:{3,}\s*(decision)\b/.test(l)) ? 'decision' : '',
      sectionText.some((l) => /^\s*:{3,}\s*(risk)\b/.test(l)) ? 'risk' : '',
      sectionText.some((l) => /^\s*:{3,}\s*(question)\b/.test(l)) ? 'open question' : '',
      s.heading.agent === 'skip' ? 'skipped for agents' : '',
    ].filter(Boolean).join(', ');
    const range = `L${s.start + 1}-${s.end + 1}`;
    const indent = '  '.repeat(Math.max(0, s.heading.level - 2));
    return { range, head: `${indent}${'#'.repeat(s.heading.level)} ${s.heading.text}`, tokens: `≈${estimateTokens(view)}`, notes };
  });
  const w1 = Math.max(...rows.map((r) => r.range.length), 5);
  const w2 = Math.max(...rows.map((r) => r.head.length), 10);
  for (const r of rows) {
    out.push(`${r.range.padEnd(w1)}  ${r.head.padEnd(w2)}  ${r.tokens.padStart(6)}${r.notes ? `  ${r.notes}` : ''}`);
  }
  out.push('', 'Read a section: smd agent <file> --section "<heading or id>"   (repeatable; add --brief to condense)');
  return out.join('\n') + '\n';
}
