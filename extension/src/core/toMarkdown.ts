import { parseAttrs } from './attrs';
import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo, type ContainerInfo } from './containers';
import { parseFenceInfo, sliceLines } from './fence';
import { REF_DIRECTIVE, type Figure, type FigureNumber } from './figures';
import {
  containerEnd, includeHref, includeLabel, includePath, includeRequest, innerScope, loadInclude, rootScope, type IncludeScope,
} from './include';
import { includedLines, includeSource } from './includeText';
import { figureIndex } from './parse';
import { quoteCite } from './quote';
import { HEADING_ATTRS } from './render';
import { riskMatrixMarkdown } from './risks';
import { documentVariables, substituteLine, type Variables } from './variables';

export interface ToMarkdownOptions {
  /**
   * Read files for file="…" code embeds and `:::include` blocks; without it an embed becomes a link only,
   * and an include its fallback body (or a link when it has none).
   */
  readFile?: (relativePath: string) => string | undefined;
}

const TICK = '`';

/**
 * Convert .smd to plain GitHub-flavored Markdown. Styling is dropped but the
 * meaning is kept: callouts become GitHub alerts, tabs become labelled
 * sections, badges become code spans, and so on. Mermaid and math are left
 * untouched because GitHub renders both natively.
 */
export function smdToMarkdown(text: string, options: ToMarkdownOptions = {}): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const figures = figureIndex(text);
  const variables = variablesOf(options, lines);
  interface Frame { len: number; prefix: string; close?: string; end?: string[] }
  const stack: Frame[] = [];
  const prefix = () => stack.map((f) => f.prefix).join('');
  const emit = (line: string) => {
    const p = prefix();
    out.push(line.trim() === '' ? p.trimEnd() : p + line);
  };

  let fence: string | null = null;
  let i = 0;

  // Keep front matter verbatim.
  if (lines[0]?.trimEnd() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) {
      out.push(...lines.slice(0, end + 1));
      i = end + 1;
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      emit(line);
      if (new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) fence = null;
      continue;
    }
    const fenceOpen = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceOpen) {
      const info = parseFenceInfo(fenceOpen[3]);
      const marker = fenceOpen[2];
      const isClose = (l: string) => l.trim().startsWith(marker) && l.trim().replace(new RegExp(`^\\${marker[0]}+`), '') === '';
      if (info.file) {
        // GitHub cannot embed files: link to the file and inline its current content when readable.
        let j = i + 1;
        while (j < lines.length && !isClose(lines[j])) j++;
        const range = info.lines ? `#L${info.lines[0]}-L${info.lines[1]}` : '';
        emit(`[${TICK}${info.title ?? info.file}${TICK}](${info.file}${range})`);
        const content = options.readFile?.(info.file);
        if (content !== undefined) {
          emit('');
          emit(marker + info.lang);
          for (const l of sliceLines(content, info.lines).text.replace(/\n$/, '').split('\n')) emit(l);
          emit(marker);
        }
        i = j;
        continue;
      }
      fence = marker;
      if (info.title) { emit(`**${TICK}${info.title}${TICK}**`); emit(''); }
      emit(fenceOpen[1] + marker + info.lang);
      continue;
    }

    const close = CONTAINER_CLOSE.exec(line);
    if (close && stack.length) {
      stack.at(-1)!.end?.forEach((l) => emit(l));
      const frame = stack.pop()!;
      if (frame.close !== undefined) emit(frame.close);
      if (frame.prefix) emit(''); // end the blockquote so the next one doesn't merge into it
      continue;
    }
    const open = CONTAINER_OPEN.exec(line);
    const info = open ? parseContainerInfo(open[3] + open[4]) : null;
    if (open && info) {
      if (info.name === 'include') {
        const len = open[2].length;
        i = includeMarkdown(info, { lines, open: i, options, emit, keepBody: () => stack.push({ len, prefix: '' }) });
        continue;
      }
      const title = info.title ? convertInline(substituteLine(info.title, variables), figures.byId) : '';
      const head = containerMarkdown({ name: info.name, title, values: info.attrs.values, id: info.attrs.id, figure: figures.byLine.get(i), text });
      for (const l of head.before ?? []) emit(l);
      stack.push({ len: open[2].length, prefix: head.prefix, ...(head.close === undefined ? {} : { close: head.close }), ...(head.end ? { end: head.end } : {}) });
      for (const l of head.inside ?? []) emit(l);
      continue;
    }
    const content = /^\s{0,3}#{1,6}\s/.test(line) ? line.replace(HEADING_ATTRS, '') : line;
    emit(convertInline(substituteLine(content, variables), figures.byId));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The include scope of the converted text, for included documents (the root document has none). */
const includeScopes = new WeakMap<ToMarkdownOptions, IncludeScope>();
/** The front matter variables of the including document, for included documents. */
const includeVariables = new WeakMap<ToMarkdownOptions, Variables>();
const variablesOf = (options: ToMarkdownOptions, lines: string[]) => includeVariables.get(options) ?? documentVariables(lines);

interface IncludeAt {
  lines: string[];
  /** The line of the `:::include`. */
  open: number;
  options: ToMarkdownOptions;
  emit: (line: string) => void;
  /** Convert the block's body as content, as for a box. */
  keepBody: () => void;
}

/**
 * `:::include` in plain Markdown, which GitHub can't include: the included text, converted, in place of the block.
 * When it can't be read, the fallback body is kept, after a link to the file when the body is empty. Returns the
 * line to go on after: the closing `:::` when the body is skipped.
 */
function includeMarkdown(info: ContainerInfo, at: IncludeAt): number {
  const { lines, open, options } = at;
  const request = includeRequest(info.attrs.values);
  const scope = includeScopes.get(options) ?? rootScope(lines.join('\n'));
  const end = containerEnd(lines, open);
  const result = request && loadInclude(request, scope, includeSource(options.readFile));
  if (result?.ok) {
    const inc = result.include;
    const child: ToMarkdownOptions = { readFile: options.readFile };
    includeScopes.set(child, innerScope(scope, inc));
    // Included text uses this document's front matter variables, as the rendered HTML does.
    includeVariables.set(child, variablesOf(options, lines));
    // A leading blank line, so a body that starts with `---` is not taken for front matter.
    const text = ['', ...includedLines(inc).slice(inc.start, inc.end + 1)].join('\n');
    at.emit(`<!-- included from ${includeLabel(inc.path, request?.section)} -->`);
    smdToMarkdown(text, child).split('\n').slice(1).forEach(at.emit);
    return end;
  }
  if (request && !lines.slice(open + 1, end).some((l) => l.trim())) {
    const path = includePath(scope.dir, request.file);
    at.emit(`[${includeLabel(path, request.section)}](${includeHref(path, request.section) ?? path})`);
  }
  at.keepBody();
  return open;
}

/** A container's opening line in plain Markdown. */
interface ContainerSource {
  name: string;
  /** The title, converted. */
  title: string;
  values: Record<string, string>;
  id?: string;
  /** The `:::figure` that opens on this line. */
  figure?: Figure;
  /** The whole document (`:::risk-matrix` summarizes its risks). */
  text: string;
}

/**
 * What a container becomes: lines before its content (outside it), the prefix of its content lines
 * (`> ` for blockquotes), lines that start its content, lines that end it (inside it) and a line that closes it.
 */
interface ContainerMarkdown { before?: string[]; prefix: string; inside?: string[]; end?: string[]; close?: string }

const withTitle = (label: string, title: string) => `**${label}${title ? `: ${title}` : ''}**`;

/** A GitHub alert (`> [!NOTE]`) with a bold first line. */
const alert = (kind: string, first: string): ContainerMarkdown => ({ before: [`> [!${kind}]`], prefix: '> ', inside: first ? [first, ''] : [] });

function decisionMarkdown({ title, values: v }: ContainerSource): ContainerMarkdown {
  const facts = [v.status ?? 'proposed', v.date, v.owner].filter(Boolean).join(' · ');
  return alert('NOTE', withTitle(`Decision (${facts})`, title));
}

function riskMarkdown({ title, values: v }: ContainerSource): ContainerMarkdown {
  const facts = [`impact ${v.impact ?? 'medium'}`, v.likelihood ? `likelihood ${v.likelihood}` : '', v.owner ? `owner ${v.owner}` : '', v.status ?? '']
    .filter(Boolean).join(', ');
  return alert(v.impact === 'high' || v.impact === 'critical' ? 'CAUTION' : 'WARNING', withTitle(`Risk (${facts})`, title));
}

function apiMarkdown({ title, values: v }: ContainerSource): ContainerMarkdown {
  const head = `**${TICK}${(v.method ?? 'GET').toUpperCase()} ${v.path ?? ''}${TICK}**${title ? ` — ${title}` : ''}${v.auth ? ` (auth: ${v.auth})` : ''}`;
  return { before: [head, ''], prefix: '' };
}

/** An anchor for `[Figure 2](#id)` links, the content, then the number and caption. */
function figureMarkdown({ title, id, figure }: ContainerSource): ContainerMarkdown {
  const label = figure?.label ?? 'Figure';
  return { before: id ? [`<a id="${id}"></a>`, ''] : [], prefix: '', close: `\n${title ? `**${label}:** ${title}` : `**${label}**`}` };
}

/** A blockquote of the body, then `— Author, *Source*` (the source linked to `cite` when that is http(s) or relative). */
function quoteMarkdown({ values }: ContainerSource): ContainerMarkdown {
  const author = values.author?.trim() ? convertInline(values.author.trim()) : '';
  const cite = quoteCite(values.cite);
  const source = values.source?.trim() ? convertInline(values.source.trim()) : '';
  const linked = cite && source && !source.includes('](') ? `[${source}](${cite})` : source;
  const cited = linked && !/^[*_]/.test(linked) ? `*${linked}*` : linked;
  const by = [author, cited].filter(Boolean).join(', ');
  return { prefix: '> ', end: by ? ['', `— ${by}`] : [] };
}

const CONTAINER_MARKDOWN = new Map<string, (c: ContainerSource) => ContainerMarkdown>([
  ['agent', ({ title }) => alert('NOTE', withTitle('For agents', title))],
  ['human', ({ title }) => alert('NOTE', withTitle('For humans', title))],
  ['decision', decisionMarkdown],
  ['risk', riskMarkdown],
  ['api', apiMarkdown],
  ['details', ({ title, values }) => ({
    before: [`<details${values.open === undefined ? '' : ' open'}><summary>${title || 'Details'}</summary>`, ''], prefix: '', close: '\n</details>',
  })],
  ['card', ({ title }) => ({ prefix: '> ', inside: title ? [`**${title}**`, ''] : [] })],
  ['risk-matrix', ({ title, text }) => ({ before: riskMatrixMarkdown(text, title), prefix: '' })],
  ['tab', ({ title }) => ({ before: [`**${title || 'Tab'}**`, ''], prefix: '', close: '' })],
  ['figure', figureMarkdown],
  // The `- **Term**: definition` list reads well as it is.
  ['glossary', ({ title }) => ({ before: title ? [`**${title}**`, ''] : [], prefix: '' })],
  // Its `## 1.2.0 — 2026-03-01` headings and lists are plain Markdown already.
  ['changelog', ({ title }) => ({ before: title ? [`**${title}**`, ''] : [], prefix: '' })],
  ['quote', quoteMarkdown],
]);

/** Callouts become alerts; box, tabs, columns, column, steps and unknown containers keep the content only. */
function containerMarkdown(c: ContainerSource): ContainerMarkdown {
  const kind = ALERTS[c.name];
  if (kind) return alert(kind, c.title ? `**${c.title}**` : '');
  return CONTAINER_MARKDOWN.get(c.name)?.(c) ?? { prefix: '' };
}

const ALERTS: Record<string, string> = {
  note: 'NOTE', info: 'NOTE', tip: 'TIP', success: 'TIP', question: 'IMPORTANT', warning: 'WARNING', danger: 'CAUTION',
};

const STATUS_EMOJI: Record<string, string> = {
  green: '🟢', teal: '🟢', red: '🔴', pink: '🔴', orange: '🟠', amber: '🟡', yellow: '🟡',
  blue: '🔵', cyan: '🔵', indigo: '🔵', purple: '🟣', gray: '⚪', muted: '⚪',
};

/** Convert inline SMD syntax on one line, leaving code spans untouched. */
export function convertInline(line: string, figures?: ReadonlyMap<string, FigureNumber>): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, idx) => (idx % 2 === 1 ? part : convertText(part, figures)))
    .join('');
}

/** `:ref[id]` → `[Figure 2](#id)`; references to unknown ids stay as written. */
function refLinks(s: string, figures: ReadonlyMap<string, FigureNumber> | undefined): string {
  if (!figures?.size) return s;
  return s.replace(REF_DIRECTIVE, (m, pre: string, raw: string) => {
    const id = raw.trim();
    const figure = figures.get(id);
    return figure ? `${pre}[${figure.label}](#${id})` : m;
  });
}

function convertText(s: string, figures?: ReadonlyMap<string, FigureNumber>): string {
  return refLinks(s, figures)
    .replace(/(^|[\s([{>*_~"'-]):([a-z][a-z0-9-]*)(?:\[([^\]\n]*)\])?(?:\{([^{}\n]*)\})?/g, (m, pre, name, content = '', rawAttrs = '') => {
      const v = parseAttrs(rawAttrs)?.values ?? {};
      switch (name) {
        case 'badge': return `${pre}\`${content}\``;
        case 'kbd': return `${pre}${content.split('+').map((k: string) => `<kbd>${k.trim()}</kbd>`).join('+')}`;
        case 'mention': return `${pre}${content}`;
        case 'priority': return `${pre}**${content}**`;
        case 'due': return `${pre}📅 ${content}`;
        case 'metric': return `${pre}**${content}**${v.label ? ` ${v.label}` : ''}${v.delta ? ` (${v.delta})` : ''}`;
        case 'status': return `${pre}${STATUS_EMOJI[v.color] ?? '⚪'} ${content}`;
        case 'progress': {
          const n = Math.max(0, Math.min(100, Number(v.value ?? content) || 0));
          const filled = Math.round(n / 10);
          return `${pre}${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${v.label ?? `${Math.round(n)}%`}`;
        }
        default: return m;
      }
    })
    .replace(/(!?)\[([^\]\n]*)\]\{([^{}\n]*)\}/g, (m, bang, content, rawAttrs) => {
      if (bang) return m;
      const attrs = parseAttrs(rawAttrs);
      if (!attrs) return m;
      let t = content;
      const style = attrs.values.style ?? '';
      if (attrs.values.weight === 'bold') t = `**${t}**`;
      if (style.includes('italic')) t = `*${t}*`;
      if (style.includes('strike')) t = `~~${t}~~`;
      return t;
    })
    .replace(/==(?=\S)([^=\n]+?)(?<=\S)==/g, '**$1**');
}
