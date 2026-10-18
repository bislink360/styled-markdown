import { parseAttrs } from './attrs';
import { closedBy, CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo, unknownContainerTitle, type ContainerInfo } from './containers';
import { parseFenceInfo, sliceLines } from './fence';
import { refDirective, type Figure, type FigureNumber } from './figures';
import {
  containerEnd, hasIncludes, includeHref, includeLabel, includePath, includeRequest, innerScope, loadInclude, rootScope, type IncludeScope,
} from './include';
import { githubIds, markdownHeadings, type MarkdownHeading } from './githubSlug';
import { expandedFigures, figuresOf, includedLines, includeKey, includeSource, type ExpandedFigures } from './includeText';
import { aroundInlineMath, convertedParts, inlineItemLines, inlineMathLines, literalLines, parseSmd, type InlinePart } from './parse';
import { quoteCite } from './quote';
import { renderSmd } from './render';
import { riskMatrixMarkdown } from './risks';
import { withoutHeadingAttrs } from './sections';
import { INLINE_DIRECTIVES } from './spec';
import { specVersion, type SpecVersion } from './specVersion';
import { own } from './util';
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
  const numbering = figureNumbering(options, text);
  const figures = { byId: numbering.figures.byId, own: figuresOf(numbering.figures, numbering.key) };
  const variables = variablesOf(options, lines);
  // The document's spec version, from its front matter: an included document's is the including one's, as in rendering.
  const spec = specVersion(variables);
  // Indented code and display math reach the line handling below; they stay as written, as in rendering.
  const literal = literalLines(text);
  // `$inline math$` may run on from one line to the next; it stays as written too.
  const inlineMath = inlineMathLines(text);
  // So may an inline item's text (`:badge[foo` on one line, `bar]{color=green}` on the next): it converts as a whole.
  const inlineItems = inlineItemLines(text);
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
  const bodyStart = i;

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

    // A container line in display math is math, as in rendering: it neither closes nor opens a container.
    const notLiteral = !literal.has(i);
    const close = notLiteral && CONTAINER_CLOSE.exec(line);
    if (close && stack.length) {
      closeFrames(stack, closedBy(stack.map((f) => f.len), close[2].length, spec), emit);
      continue;
    }
    const open = notLiteral && CONTAINER_OPEN.exec(line);
    const info = open ? parseContainerInfo(open[3] + open[4], spec) : null;
    if (open && info) {
      if (info.name === 'include') {
        const len = open[2].length;
        i = includeMarkdown(info, { lines, open: i, from: bodyStart, spec, options, numbering, emit, keepBody: () => stack.push({ len, prefix: '' }) });
        continue;
      }
      const title = info.title ? convertInline(substituteLine(info.title, variables, spec), figures.byId, spec) : '';
      const head = containerMarkdown({ name: info.name, title, values: info.attrs.values, id: info.attrs.id, figure: figures.own.get(i + numbering.offset), text, spec });
      for (const l of head.before ?? []) emit(l);
      stack.push({ len: open[2].length, prefix: head.prefix, ...(head.close === undefined ? {} : { close: head.close }), ...(head.end ? { end: head.end } : {}) });
      for (const l of head.inside ?? []) emit(l);
      continue;
    }
    emit(lineMarkdown(line, literal.has(i), { variables, figures: figures.byId, spec }, inlineMath.get(i), inlineItems.get(i)));
  }
  return headingAnchors(text, out.join('\n').replace(/\n{3,}/g, '\n\n'), options);
}

/** A heading of the converted text with the id Styled Markdown gives it and the one GitHub gives it. */
interface HeadingIds extends MarkdownHeading { smd: string; github: string }

/** The heading ids of the last conversion with these options, for githubHeadingIds. */
const convertedIds = new WeakMap<ToMarkdownOptions, HeadingIds[] | undefined>();

/**
 * `<a id="smd-id"></a>` before each heading whose GitHub id differs from its own, so that links written with
 * either id work on GitHub. Added once, to the whole document, after its includes are converted into it.
 */
function headingAnchors(text: string, markdown: string, options: ToMarkdownOptions): string {
  if (includeScopes.has(options)) return markdown;
  const pairs = headingIdPairs(text, markdown, options.readFile);
  convertedIds.set(options, pairs);
  // markdown-it also ends lines at a lone `\r`, so its line numbers only match these lines when there is none.
  if (/\r(?!\n)/.test(markdown)) return markdown;
  const lines = markdown.split('\n');
  const differ = (pairs ?? []).filter((p) => p.github !== p.smd && p.line < lines.length);
  if (!differ.length) return markdown;
  // From the last heading up, so the lines of those above stay where they are.
  for (let k = differ.length - 1; k >= 0; k--) lines.splice(differ[k].line, 0, ...anchorLines(lines, differ[k]));
  return lines.join('\n');
}

/**
 * The document's headings paired with the headings of its plain Markdown, which come in the same order.
 * Undefined when they don't pair up (the converted text has more or fewer headings).
 */
function headingIdPairs(text: string, markdown: string, readFile: ToMarkdownOptions['readFile']): HeadingIds[] | undefined {
  const own = readFile && hasIncludes(text) ? renderSmd(text, { readFile }).headings : parseSmd(text).headings;
  const plain = markdownHeadings(withoutFrontMatter(markdown));
  if (plain.length !== own.length) return undefined;
  const github = githubIds(plain.map((h) => h.text));
  return plain.map((h, i) => ({ ...h, smd: own[i].slug, github: github[i] }));
}

/** Front matter as blank lines: GitHub shows it as a table, so its lines are never headings. */
function withoutFrontMatter(markdown: string): string {
  const lines = markdown.split('\n');
  if (lines[0]?.trimEnd() !== '---') return markdown;
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  return end < 0 ? markdown : [...lines.slice(0, end + 1).map(() => ''), ...lines.slice(end + 1)].join('\n');
}

/**
 * The lines that go before a heading for its Styled Markdown id: the anchor, inside the same blockquotes as the
 * heading. A blank line keeps it out of a paragraph or table just above, and out of a setext heading's text.
 */
function anchorLines(lines: string[], heading: HeadingIds): string[] {
  const line = lines[heading.line];
  const prefix = line.slice(0, line.length - line.replace(/^[>\s]+/, '').length);
  const blank = prefix.trimEnd();
  const above = heading.line > 0 ? lines[heading.line - 1].replace(/^[>\s]+/, '') : '';
  const anchor = `${prefix}<a id="${heading.smd.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></a>`;
  return [...(above ? [blank] : []), anchor, ...(heading.atx ? [] : [blank])];
}

/**
 * The id GitHub gives each of the document's own headings (as `parseSmd` lists them) in its `to-md` output.
 * When that output's headings don't pair up with the document's, each heading's text stands in for its output.
 */
export function githubHeadingIds(text: string): string[] {
  const options: ToMarkdownOptions = {};
  smdToMarkdown(text, options);
  const pairs = convertedIds.get(options);
  return pairs ? pairs.map((p) => p.github) : githubIds(parseSmd(text).headings.map((h) => h.text));
}

/** The include scope of the converted text, for included documents (the root document has none). */
const includeScopes = new WeakMap<ToMarkdownOptions, IncludeScope>();
/** The front matter variables of the including document, for included documents. */
const includeVariables = new WeakMap<ToMarkdownOptions, Variables>();
const variablesOf = (options: ToMarkdownOptions, lines: string[]) => includeVariables.get(options) ?? documentVariables(lines);
/**
 * How the converted text's figures are numbered: together with the whole document's, as rendered output numbers
 * them. `key` is the document's in `figures`, and `offset` turns a line of the text into a line of that document.
 */
interface FigureNumbering { figures: ExpandedFigures; key: string; offset: number }
/** The figure numbering of included documents (the root document numbers its own). */
const includeNumbering = new WeakMap<ToMarkdownOptions, FigureNumbering>();
const figureNumbering = (options: ToMarkdownOptions, text: string): FigureNumbering =>
  includeNumbering.get(options) ?? { figures: expandedFigures(text, options.readFile), key: '', offset: 0 };
/**
 * A line of text in plain Markdown: a heading without its attributes, `{{name}}` replaced and inline syntax
 * converted. A line of code or display math (`literal`) stays as written, since nothing on it is inline syntax.
 * `math` is the line's inline math when it is read with the lines around it (see mathOnLine), and `parts` its parts of
 * inline items that run over several lines (see inlineItemLines): each item converts as a whole.
 */
function lineMarkdown(
  line: string, literal: boolean, document: { variables: Variables; figures: ReadonlyMap<string, FigureNumber>; spec: SpecVersion }, math?: ReadonlyArray<[number, number]>,
  parts?: ReadonlyArray<InlinePart>,
): string {
  if (literal) return line;
  // In spec v2 a trailing `{}` or `{word}` is heading text, which GitHub shows too.
  const content = /^\s{0,3}#{1,6}\s/.test(line) ? withoutHeadingAttrs(line, document.spec) : line;
  // Math is set aside before `{{name}}` is replaced, as rendering reads it.
  const convert = (text: string) => convertInline(substituteLine(text, document.variables, document.spec), document.figures, document.spec);
  const asWritten = content === line;
  return aroundInlineMath(content, convert, asWritten ? math : undefined, asWritten ? convertedParts(parts, (whole) => aroundInlineMath(whole, convert)) : []);
}

/** A container being converted: its colon count, the prefix of its lines, and what closes it. */
interface Frame { len: number; prefix: string; close?: string; end?: string[] }

/** A closing fence closes the frames from index `at` on (see closedBy), innermost first. */
function closeFrames(stack: Frame[], at: number, emit: (line: string) => void): void {
  while (stack.length > Math.max(at, 0)) {
    stack.at(-1)!.end?.forEach((l) => emit(l));
    const frame = stack.pop()!;
    if (frame.close !== undefined) emit(frame.close);
    if (frame.prefix) emit(''); // end the blockquote so the next one doesn't merge into it
  }
}

interface IncludeAt {
  lines: string[];
  /** The line of the `:::include`. */
  open: number;
  /** The first body line, and the version: spec v2 pairs closing fences by colon count. */
  from: number;
  spec: SpecVersion;
  options: ToMarkdownOptions;
  numbering: FigureNumbering;
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
  const end = containerEnd(lines, open, at.spec, at.from);
  const result = request && loadInclude(request, scope, includeSource(options.readFile));
  if (result?.ok) {
    const inc = result.include;
    const child: ToMarkdownOptions = { readFile: options.readFile };
    includeScopes.set(child, innerScope(scope, inc));
    // Included text uses this document's front matter variables, as the rendered HTML does.
    includeVariables.set(child, variablesOf(options, lines));
    // Its figures are numbered with this document's, and `:ref` resolves across both.
    const { numbering } = at;
    includeNumbering.set(child, { figures: numbering.figures, key: includeKey(numbering.key, open + numbering.offset), offset: inc.start - 1 });
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
  /** The document's spec version, for inline text in attribute values. */
  spec: SpecVersion;
}

/**
 * What a container becomes: lines before its content (outside it), the prefix of its content lines
 * (`> ` for blockquotes), lines that start its content, lines that end it (inside it) and a line that closes it.
 */
interface ContainerMarkdown { before?: string[]; prefix: string; inside?: string[]; end?: string[]; close?: string }

const withTitle = (label: string, title: string) => `**${label}${title ? `: ${title}` : ''}**`;

/** The content as it is, after a `**Title**` paragraph when there is a title. */
const titledContent = (title: string): ContainerMarkdown => ({ before: title ? [`**${title}**`, ''] : [], prefix: '' });

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
function quoteMarkdown({ values, spec }: ContainerSource): ContainerMarkdown {
  const author = values.author?.trim() ? convertInline(values.author.trim(), undefined, spec) : '';
  const cite = quoteCite(values.cite);
  const source = values.source?.trim() ? convertInline(values.source.trim(), undefined, spec) : '';
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
  ['glossary', ({ title }) => titledContent(title)],
  // Its `## 1.2.0 — 2026-03-01` headings and lists are plain Markdown already.
  ['changelog', ({ title }) => titledContent(title)],
  ['quote', quoteMarkdown],
]);

/**
 * Callouts become alerts; box, tabs, columns, column, steps and timeline keep the content only, and unknown
 * containers keep their title as a `**Title**` paragraph before it (spec §3).
 */
function containerMarkdown(c: ContainerSource): ContainerMarkdown {
  const kind = own(ALERTS, c.name);
  if (kind) return alert(kind, c.title ? `**${c.title}**` : '');
  return CONTAINER_MARKDOWN.get(c.name)?.(c) ?? titledContent(unknownContainerTitle(c.name, c.title));
}

const ALERTS: Record<string, string> = {
  note: 'NOTE', info: 'NOTE', tip: 'TIP', success: 'TIP', question: 'IMPORTANT', warning: 'WARNING', danger: 'CAUTION',
};

const STATUS_EMOJI: Record<string, string> = {
  green: '🟢', teal: '🟢', red: '🔴', pink: '🔴', orange: '🟠', amber: '🟡', yellow: '🟡',
  blue: '🔵', cyan: '🔵', indigo: '🔵', purple: '🟣', gray: '⚪', muted: '⚪',
};

/** Convert inline SMD syntax on one line, leaving code spans and `$inline math$` untouched. */
export function convertInline(line: string, figures?: ReadonlyMap<string, FigureNumber>, spec: SpecVersion = 1): string {
  return aroundInlineMath(line, (text) => text
    .split(/(`+[^`]*`+)/)
    .map((part, idx) => (idx % 2 === 1 ? part : convertText(part, figures, spec)))
    .join(''));
}

/** `:ref[id]` → `[Figure 2](#id)`; references to unknown ids stay as written. */
function refLinks(s: string, figures: ReadonlyMap<string, FigureNumber> | undefined, spec: SpecVersion): string {
  if (!figures?.size) return s;
  return s.replace(refDirective(spec), (m, pre: string, raw: string) => {
    const id = raw.trim();
    const figure = figures.get(id);
    return figure ? `${pre}[${figure.label}](#${id})` : m;
  });
}

/**
 * `:name[content]{attrs}` in text: a lower-case name in spec v1, any case in spec v2 (RFC proposal 11). A name with
 * neither `[content]` nor `{attributes}` is text, as in rendering. Content may run over a line break when an item is
 * read whole (see convertedParts).
 */
const DIRECTIVE_TEXT_V1 = /(^|[\s([{>*_~"'-]):([a-z][a-z0-9-]*)(?:\[([^\]]*)\])?(?:\{([^{}\n]*)\})?/g;
const DIRECTIVE_TEXT_V2 = /(^|[\s([{>*_~"'-]):([A-Za-z][A-Za-z0-9-]*)(?:\[([^\]]*)\])?(?:\{([^{}\n]*)\})?/g;

function convertText(s: string, figures: ReadonlyMap<string, FigureNumber> | undefined, spec: SpecVersion): string {
  return refLinks(s, figures, spec)
    .replace(spec >= 2 ? DIRECTIVE_TEXT_V2 : DIRECTIVE_TEXT_V1, (m, pre: string, name: string, content?: string, rawAttrs?: string) =>
      (content === undefined && rawAttrs === undefined ? m : directiveText(m, { pre, name, content: content ?? '', rawAttrs: rawAttrs ?? '' }, spec)))
    .replace(/(!?)\[([^\]]*)\]\{([^{}\n]*)\}/g, (m, bang, content, rawAttrs) => {
      if (bang) return m;
      const attrs = parseAttrs(rawAttrs, spec);
      return attrs ? spanMarkdown(content, attrs.values) : m;
    })
    .replace(/==(?=\S)([^=]+?)(?<=\S)==/g, '**$1**');
}

/** A styled span's text, bold, italic or struck through as its `weight` and `style` say. */
function spanMarkdown(content: string, values: Record<string, string>): string {
  let t = content;
  const style = values.style ?? '';
  if (values.weight === 'bold') t = `**${t}**`;
  if (style.includes('italic')) t = `*${t}*`;
  if (style.includes('strike')) t = `~~${t}~~`;
  return t;
}

/**
 * One `:name[content]{attrs}` (`m` as written). In spec v2 a name outside the vocabulary is a directive (RFC proposal
 * 7b): its content converts as a styled span's does, unless its attribute list can't be read, when rendering shows it
 * as text too. In spec v1 it is text.
 */
function directiveText(m: string, d: { pre: string; name: string; content: string; rawAttrs: string }, spec: SpecVersion): string {
  const name = spec >= 2 ? d.name.toLowerCase() : d.name;
  const attrs = parseAttrs(d.rawAttrs, spec);
  if (spec >= 2) {
    // A list that can't be read leaves the whole item as text, as rendering does.
    if (!attrs) return m;
    if (!Object.hasOwn(INLINE_DIRECTIVES, name)) return `${d.pre}${spanMarkdown(d.content, attrs.values)}`;
  }
  return directiveMarkdown(m, d.pre, name, d.content, attrs?.values ?? {});
}

/** One `:name[content]{attrs}` in plain Markdown (`m` as written), or `m` for a name kept as written. */
function directiveMarkdown(m: string, pre: string, name: string, content: string, v: Record<string, string>): string {
  switch (name) {
    case 'badge': return `${pre}\`${content}\``;
    case 'kbd': return `${pre}${content.split('+').map((k: string) => `<kbd>${k.trim()}</kbd>`).join('+')}`;
    case 'mention': return `${pre}${content}`;
    case 'priority': return `${pre}**${content}**`;
    case 'due': return `${pre}📅 ${content}`;
    case 'metric': return `${pre}**${content}**${v.label ? ` ${v.label}` : ''}${v.delta ? ` (${v.delta})` : ''}`;
    case 'status': return `${pre}${own(STATUS_EMOJI, v.color ?? '') ?? '⚪'} ${content}`;
    case 'progress': {
      const n = Math.max(0, Math.min(100, Number(v.value ?? content) || 0));
      const filled = Math.round(n / 10);
      return `${pre}${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${v.label ?? `${Math.round(n)}%`}`;
    }
    default: return m;
  }
}
