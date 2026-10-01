import MarkdownIt, { type StateBlock, type StateCore, type StateInline, type Token } from 'markdown-it';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import {
  attrsToStyle, emptyAttrs, escapeHtml, findAttrsEnd, htmlAttrs, parseAttrs, resolveColor,
} from './attrs';
import { ContainerInfo, parseContainerInfo } from './containers';
import { asStringList, type FrontMatter, parseFrontMatter } from './frontmatter';
import { langFromPath, parseFenceInfo, sliceLines } from './fence';
import { CALLOUT_TYPES, INLINE_DIRECTIVES, STATUS_VALUES } from './spec';
import { documentRiskMatrixHtml } from './riskHtml';

export interface RenderOptions {
  /** Allow raw HTML in the source (scripts are still blocked by the host CSP). */
  allowHtml?: boolean;
  /** How :::agent blocks are presented to human readers. */
  agentBlocks?: 'collapsed' | 'expanded' | 'hidden';
  /** Read a file relative to the document (for ```lang file="…"` embeds). Return undefined when not allowed/missing. */
  readFile?: (relativePath: string) => string | undefined;
  /** "Today" as YYYY-MM-DD, for :due[] states. Defaults to the current date. */
  today?: string;
}

export interface Heading {
  level: number;
  text: string;
  slug: string;
  /** Zero-based line in the full .smd file. */
  line: number;
  /** `agent=skip` from a heading attribute list: the section is omitted from agent views. */
  agent?: string;
}

export interface RenderResult {
  html: string;
  frontMatter: Record<string, unknown>;
  headings: Heading[];
}

export type ResolvedOptions = Required<Omit<RenderOptions, 'readFile'>> & Pick<RenderOptions, 'readFile'>;

export interface Env {
  lineOffset: number;
  headings: Heading[];
  slugs: Map<string, number>;
  options: ResolvedOptions;
  /** Per heading, the slug before de-duplication, or null for an explicit {#id} (see parse.ts). */
  bases?: Array<string | null>;
  references?: Record<string, unknown>;
  /** The whole document, for blocks that summarize it (`:::risk-matrix`). */
  source?: string;
}

const CALLOUT_ICONS: Record<string, string> = {
  note: '✎', info: 'ℹ', tip: '💡', success: '✔', warning: '⚠', danger: '⛔', question: '?',
};

export function createMarkdownIt(options: RenderOptions = {}): MarkdownIt {
  const md = new MarkdownIt({
    html: options.allowHtml ?? true,
    linkify: true,
    typographer: true,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch { /* fall through to default escaping */ }
      }
      return '';
    },
  });

  md.block.ruler.before('fence', 'smd_container', containerBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.container_smd_open = renderContainer as never;
  md.renderer.rules.container_smd_close = renderContainer as never;
  md.core.ruler.after('block', 'smd_container_meta', annotateContainers);
  md.block.ruler.before('fence', 'smd_math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.inline.ruler.before('link', 'smd_span', styledSpan);
  md.inline.ruler.before('emphasis', 'smd_directive', inlineDirective);
  md.inline.ruler.before('emphasis', 'smd_mark', mark);
  md.inline.ruler.after('escape', 'smd_math_inline', mathInline);
  md.core.ruler.after('inline', 'smd_tasks', taskLists);
  md.core.ruler.after('inline', 'smd_headings', headingIds);
  md.core.ruler.before('smd_headings', 'smd_heading_attrs', headingAttrs);
  md.core.ruler.push('smd_lines', sourceLines);

  const defaultFence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, opts, env: Env, self) => {
    const token = tokens[idx];
    const fence = parseFenceInfo(token.info);
    const line = token.attrGet('data-line') ?? '';
    const lower = fence.lang.toLowerCase();
    if (lower === 'mermaid') {
      return `<div class="smd-diagram" data-line="${line}"><pre class="smd-mermaid">${escapeHtml(token.content)}</pre></div>\n`;
    }
    if (lower === 'math' || lower === 'latex' || lower === 'katex') {
      return `<div class="smd-math-block" data-line="${line}">${renderMath(token.content, true)}</div>\n`;
    }
    token.attrs = (token.attrs ?? []).filter(([k]) => k !== 'data-line');

    // ```ts file="../src/app.ts" lines="10-20" — embed (part of) a real file so docs never drift from code.
    let title = fence.title;
    if (fence.file) {
      const loaded = env.options?.readFile?.(fence.file);
      const range = fence.lines ? `:${fence.lines[0]}-${fence.lines[1]}` : '';
      title ??= fence.file + range;
      if (loaded === undefined) {
        return `<div class="smd-code" data-line="${line}"><div class="smd-code-title">${escapeHtml(title)}</div><div class="smd-error">Cannot read ${escapeHtml(fence.file)}</div></div>\n`;
      }
      token.content = sliceLines(loaded, fence.lines).text;
      if (!fence.lang) token.info = langFromPath(fence.file);
    }
    // Highlight hljs output needs a language without the extra info words.
    token.info = (fence.lang || token.info).trim();

    let code = defaultFence(tokens, idx, opts, env, self);
    if (fence.highlight.size) {
      // Absolutely positioned bands behind the code; keeps hljs markup intact across lines.
      const first = fence.lines?.[0] ?? 1;
      const bands = [...fence.highlight].sort((a, b) => a - b)
        .map((n) => n - (fence.file && fence.lines ? first - 1 : 0))
        .filter((n) => n >= 1)
        .map((n) => `<span class="smd-hl-line" style="top:calc(14px + ${n - 1} * 1.55em)"></span>`).join('');
      code = code.replace('<pre>', `<pre class="smd-has-hl">${bands}`);
    }
    const header = title
      ? `<div class="smd-code-title">${escapeHtml(title)}</div>`
      : fence.lang ? `<div class="smd-code-lang">${escapeHtml(fence.lang)}</div>` : '';
    return `<div class="smd-code" data-line="${line}">${header}${code}</div>\n`;
  };
  md.renderer.rules.smd_math_block = (tokens, idx) =>
    `<div class="smd-math-block" data-line="${tokens[idx].attrGet('data-line') ?? ''}">${renderMath(tokens[idx].content, true)}</div>\n`;
  md.renderer.rules.smd_math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);

  // Make tables horizontally scrollable on narrow previews.
  md.renderer.rules.table_open = (tokens, idx, opts, _env, self) =>
    `<div class="smd-table-wrap">${self.renderToken(tokens, idx, opts)}`;
  md.renderer.rules.table_close = (tokens, idx, opts, _env, self) => `${self.renderToken(tokens, idx, opts)}</div>`;
  return md;
}

/** Render a complete .smd document (front matter + body) to an HTML fragment. */
export function renderSmd(text: string, options: RenderOptions = {}): RenderResult {
  return renderParsed(text, parseFrontMatter(text), options);
}

/** The front matter of a document and the body after it, however they were split. */
export type ParsedDocument = Pick<FrontMatter, 'data' | 'body' | 'bodyStartLine'>;

/**
 * renderSmd with the front matter already split off, for hosts that remove it before the
 * remark/rehype plugins run (see unified.ts). `header: false` leaves out the title/status header.
 */
export function renderParsed(text: string, fm: ParsedDocument, options: RenderOptions = {}, header = true): RenderResult {
  const opts: ResolvedOptions = {
    allowHtml: options.allowHtml ?? true,
    agentBlocks: options.agentBlocks ?? 'collapsed',
    readFile: options.readFile,
    today: options.today ?? new Date().toISOString().slice(0, 10),
  };
  const md = createMarkdownIt(opts);
  const env: Env = { lineOffset: fm.bodyStartLine, headings: [], slugs: new Map(), options: opts, source: text };
  // markdown-it treats a lone \r as a line break, but every other tool here splits lines on \r?\n.
  // A space keeps heading lines and data-line (preview scroll sync) in step with the editor.
  const tokens = md.parse(fm.body.replace(/\r(?!\n)/g, ' '), env);
  const body = md.renderer.render(tokens, md.options, env);

  const data = fm.data;
  const accent = typeof data.accent === 'string' ? resolveColor(data.accent) : null;
  const style = accent ? ` style="--smd-accent:${escapeHtml(accent)}"` : '';
  const html = `<article class="smd-doc"${style}>${header ? renderHeader(md, data) : ''}${data.toc === true ? renderToc(env.headings) : ''}${body}</article>`;
  return { html, frontMatter: data, headings: env.headings };
}

// ---------------------------------------------------------------------------
// Document header and table of contents
// ---------------------------------------------------------------------------

function renderHeader(md: MarkdownIt, data: Record<string, unknown>): string {
  const title = typeof data.title === 'string' ? data.title : '';
  const summary = typeof data.summary === 'string' ? data.summary : '';
  const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
  const owners = asStringList(data.owners);
  const tags = asStringList(data.tags);
  if (!title && !summary && !status && !owners.length && !tags.length) return '';

  const top: string[] = [];
  if (status) {
    const known = STATUS_VALUES.includes(status) ? status : 'unknown';
    top.push(`<span class="smd-doc-status smd-doc-status-${known}">${escapeHtml(status)}</span>`);
  }
  if (data.version !== undefined) top.push(`<span>v${escapeHtml(String(data.version))}</span>`);
  if (data.updated !== undefined) top.push(`<span>Updated ${escapeHtml(String(data.updated))}</span>`);
  if (typeof data.audience === 'string') top.push(`<span>For ${escapeHtml(data.audience)}</span>`);

  const meta: string[] = [];
  if (owners.length) {
    meta.push(`<span class="smd-doc-meta-label">Owners</span>${owners.map((o) => `<span class="smd-mention">${escapeHtml(o)}</span>`).join(' ')}`);
  }
  if (tags.length) {
    meta.push(`<span class="smd-doc-meta-label">Tags</span>${tags.map((t) => `<span class="smd-tag">${escapeHtml(t)}</span>`).join(' ')}`);
  }

  return `<header class="smd-doc-header" data-line="0">
${top.length ? `<div class="smd-doc-top">${top.join('<span class="smd-dot">·</span>')}</div>` : ''}
${title ? `<h1 class="smd-doc-title">${md.renderInline(title)}</h1>` : ''}
${summary ? `<p class="smd-doc-summary">${md.renderInline(summary)}</p>` : ''}
${meta.length ? `<div class="smd-doc-meta">${meta.map((m) => `<div>${m}</div>`).join('')}</div>` : ''}
</header>`;
}

function renderToc(headings: Heading[]): string {
  const items = headings.filter((h) => h.level >= 2 && h.level <= 3);
  if (!items.length) return '';
  return `<nav class="smd-toc"><div class="smd-toc-title">Contents</div><ul>${items
    .map((h) => `<li class="smd-toc-l${h.level}"><a href="#${h.slug}">${escapeHtml(h.text)}</a></li>`)
    .join('')}</ul></nav>`;
}

// ---------------------------------------------------------------------------
// Block containers  (:::name{attrs} Title … :::)
// ---------------------------------------------------------------------------

/**
 * Block rule for `:::name …` containers. Unlike markdown-it-container, it
 * tracks nesting: a bare `:::` closes the innermost open container, and
 * fenced code inside a container is skipped. Colon counts are cosmetic.
 */
function containerBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const lineText = (l: number) => state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]);
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const open = /^(:{3,})\s*([a-zA-Z][\w-]*.*)$/.exec(lineText(startLine));
  if (!open) return false;
  if (silent) return true;

  let depth = 0;
  let fence: string | null = null;
  let closeLine = -1;
  for (let l = startLine + 1; l < endLine; l++) {
    const text = lineText(l);
    if (text.length && state.sCount[l] < state.blkIndent) break; // outdented: parent list/quote ended
    if (fence) {
      if (text.startsWith(fence) && text.slice(fence.length).trim().replace(new RegExp(`^\\${fence[0]}+`), '') === '') fence = null;
      continue;
    }
    const f = /^(`{3,}|~{3,})/.exec(text);
    if (f && state.sCount[l] - state.blkIndent < 4) { fence = f[1]; continue; }
    if (state.sCount[l] - state.blkIndent >= 4) continue;
    if (/^:{3,}\s*[a-zA-Z]/.test(text)) depth++;
    else if (/^:{3,}\s*$/.test(text)) {
      if (depth === 0) { closeLine = l; break; }
      depth--;
    }
  }
  const end = closeLine === -1 ? endLine : closeLine;

  const oldParent = state.parentType;
  const oldLineMax = state.lineMax;
  state.parentType = 'container' as never;
  state.lineMax = end;
  const openToken = state.push('container_smd_open', 'div', 1);
  openToken.markup = open[1];
  openToken.block = true;
  openToken.info = open[2];
  openToken.map = [startLine, end];
  state.md.block.tokenize(state, startLine + 1, end);
  const closeToken = state.push('container_smd_close', 'div', -1);
  closeToken.markup = open[1];
  closeToken.block = true;
  state.parentType = oldParent;
  state.lineMax = oldLineMax;
  state.line = closeLine === -1 ? end : closeLine + 1;
  return true;
}

interface ContainerMeta extends ContainerInfo {
  /** Tag used to close the container (varies with presentation). */
  close: string;
}

function annotateContainers(state: StateCore): void {
  const stack: Token[] = [];
  for (const token of state.tokens) {
    if (token.type === 'container_smd_open') {
      const info = parseContainerInfo(token.info) ?? { name: 'box', attrs: emptyAttrs(), title: '' };
      token.meta = { ...info, close: '</div>' } satisfies ContainerMeta;
      stack.push(token);
    } else if (token.type === 'container_smd_close') {
      const open = stack.pop();
      token.meta = open?.meta ?? { name: 'box', attrs: emptyAttrs(), title: '', close: '</div>' };
    }
  }
}

function renderContainer(tokens: Token[], idx: number, _opts: unknown, env: Env): string {
  const token = tokens[idx];
  const meta = token.meta as ContainerMeta;
  if (token.nesting === -1) return `${meta.close}\n`;

  const line = token.map ? token.map[0] + env.lineOffset : '';
  const { name, attrs } = meta;
  const inline = (s: string) => md().renderInline(s);
  const { style } = attrsToStyle(attrs, true);
  const dataLine = ` data-line="${line}"`;

  if ((CALLOUT_TYPES as readonly string[]).includes(name)) {
    const title = meta.title || name[0].toUpperCase() + name.slice(1);
    const head = `<span class="smd-callout-icon" aria-hidden="true">${CALLOUT_ICONS[name]}</span><span>${inline(title)}</span>`;
    const cls = htmlAttrs(attrs, ['smd-callout', `smd-callout-${name}`], style);
    if (attrs.values.collapsible !== undefined) {
      meta.close = '</div></details>';
      const open = attrs.values.collapsible === 'open' ? ' open' : '';
      return `<details${cls}${dataLine}${open}><summary class="smd-callout-title">${head}</summary><div class="smd-callout-body">\n`;
    }
    meta.close = '</div></div>';
    return `<div${cls}${dataLine}><div class="smd-callout-title">${head}</div><div class="smd-callout-body">\n`;
  }

  switch (name) {
    case 'details': {
      meta.close = '</div></details>';
      const open = attrs.values.open !== undefined ? ' open' : '';
      return `<details${htmlAttrs(attrs, ['smd-details'], style)}${dataLine}${open}><summary>${inline(meta.title || 'Details')}</summary><div class="smd-details-body">\n`;
    }
    case 'card': {
      meta.close = '</div></div>';
      const accent = attrs.values.accent ? resolveColor(attrs.values.accent) : null;
      const cardStyle = [style, accent ? `--smd-card-accent:${accent}` : ''].filter(Boolean).join(';');
      const title = meta.title ? `<div class="smd-card-title">${inline(meta.title)}</div>` : '';
      return `<div${htmlAttrs(attrs, ['smd-card'], cardStyle)}${dataLine}>${title}<div class="smd-card-body">\n`;
    }
    case 'tabs':
      meta.close = '</div>';
      return `<div${htmlAttrs(attrs, ['smd-tabs'], style)}${dataLine}>\n`;
    case 'tab': {
      meta.close = '</section>';
      const title = meta.title || 'Tab';
      return `<section${htmlAttrs(attrs, ['smd-tab'], style)}${dataLine} data-title="${escapeHtml(title)}"><div class="smd-tab-label">${inline(title)}</div>\n`;
    }
    case 'columns':
      meta.close = '</div>';
      return `<div${htmlAttrs(attrs, ['smd-columns'], style)}${dataLine}>\n`;
    case 'column': {
      meta.close = '</div>';
      const width = attrs.values.width;
      let flex = '';
      if (width && /^\d+(\.\d+)?%$/.test(width)) flex = `flex:0 0 ${width}`;
      else if (width && /^\d+(\.\d+)?$/.test(width)) flex = `flex:${width} 1 0`;
      return `<div${htmlAttrs(attrs, ['smd-column'], [style, flex].filter(Boolean).join(';'))}${dataLine}>\n`;
    }
    case 'steps':
      meta.close = '</div>';
      return `<div${htmlAttrs(attrs, ['smd-steps'], style)}${dataLine}>\n`;
    case 'agent': {
      const mode = env.options.agentBlocks;
      const label = `<span class="smd-agent-icon" aria-hidden="true">🤖</span><span>For agents${meta.title ? `: ${inline(meta.title)}` : ''}</span>`;
      const cls = htmlAttrs(attrs, ['smd-agent'], style);
      if (mode === 'hidden') {
        meta.close = '</div>';
        return `<div${cls}${dataLine} hidden>\n`;
      }
      meta.close = '</div></details>';
      return `<details${cls}${dataLine}${mode === 'expanded' ? ' open' : ''}><summary class="smd-agent-title">${label}</summary><div class="smd-agent-body">\n`;
    }
    case 'human': {
      meta.close = '</div></div>';
      const label = `<span aria-hidden="true">👤</span><span>For humans${meta.title ? `: ${inline(meta.title)}` : ''}</span>`;
      return `<div${htmlAttrs(attrs, ['smd-human'], style)}${dataLine}><div class="smd-human-title">${label}</div><div class="smd-human-body">\n`;
    }
    case 'decision': {
      meta.close = '</div></div>';
      const status = (attrs.values.status ?? 'proposed').toLowerCase();
      const facts = [attrs.values.date, attrs.values.owner].filter(Boolean).map((f) => `<span>${escapeHtml(f!)}</span>`).join('<span class="smd-dot">·</span>');
      return `<div${htmlAttrs(attrs, ['smd-decision', `smd-decision-${status}`], style)}${dataLine}>` +
        `<div class="smd-decision-head"><span class="smd-decision-label">Decision</span><span class="smd-decision-status">${escapeHtml(status)}</span>${facts ? `<span class="smd-decision-facts">${facts}</span>` : ''}</div>` +
        `${meta.title ? `<div class="smd-decision-title">${inline(meta.title)}</div>` : ''}<div class="smd-decision-body">\n`;
    }
    case 'risk': {
      meta.close = '</div></div>';
      const impact = (attrs.values.impact ?? 'medium').toLowerCase();
      const likelihood = attrs.values.likelihood?.toLowerCase();
      const facts = [
        `Impact <b>${escapeHtml(impact)}</b>`,
        likelihood ? `Likelihood <b>${escapeHtml(likelihood)}</b>` : '',
        attrs.values.owner ? `Owner ${escapeHtml(attrs.values.owner)}` : '',
        attrs.values.status ? `<span class="smd-risk-status">${escapeHtml(attrs.values.status)}</span>` : '',
      ].filter(Boolean).join('<span class="smd-dot">·</span>');
      return `<div${htmlAttrs(attrs, ['smd-risk', `smd-risk-${impact}`], style)}${dataLine}>` +
        `<div class="smd-risk-head"><span class="smd-risk-icon" aria-hidden="true">⚑</span><span class="smd-risk-title">${inline(meta.title || 'Risk')}</span></div>` +
        `<div class="smd-risk-facts">${facts}</div><div class="smd-risk-body">\n`;
    }
    case 'api': {
      meta.close = '</div></div>';
      const method = (attrs.values.method ?? 'GET').toUpperCase();
      const auth = attrs.values.auth ? `<span class="smd-api-auth">🔒 ${escapeHtml(attrs.values.auth)}</span>` : '';
      return `<div${htmlAttrs(attrs, ['smd-api'], style)}${dataLine}>` +
        `<div class="smd-api-head"><span class="smd-api-method smd-api-${method.toLowerCase()}">${escapeHtml(method)}</span>` +
        `<code class="smd-api-path">${escapeHtml(attrs.values.path ?? '/')}</code>${meta.title ? `<span class="smd-api-title">${inline(meta.title)}</span>` : ''}${auth}</div>` +
        `<div class="smd-api-body">\n`;
    }
    case 'risk-matrix': {
      meta.close = '</div></div>';
      const title = meta.title ? `<div class="smd-risk-matrix-title">${inline(meta.title)}</div>` : '';
      return `<div${htmlAttrs(attrs, ['smd-risk-matrix'], style)}${dataLine}>${title}${documentRiskMatrixHtml(env.source ?? '')}<div class="smd-risk-matrix-body">\n`;
    }
    case 'timeline':
      meta.close = '</div>';
      return `<div${htmlAttrs(attrs, ['smd-timeline'], style)}${dataLine}>\n`;
    default:
      // `box` and unknown names render as a styled block; the validator flags unknown names.
      meta.close = '</div>';
      return `<div${htmlAttrs(attrs, ['smd-box', `smd-box-${name}`], style)}${dataLine}>\n`;
  }
}

// A shared instance for rendering titles inside containers.
let titleMd: MarkdownIt | undefined;
function md(): MarkdownIt {
  return (titleMd ??= createMarkdownIt({ allowHtml: false }));
}

// ---------------------------------------------------------------------------
// Inline syntax
// ---------------------------------------------------------------------------

/** `[styled text]{color=red weight=bold}` → <span style=…> */
function styledSpan(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x5b /* [ */) return false;
  const labelEnd = state.md.helpers.parseLinkLabel(state, start, true);
  if (labelEnd < 0 || state.src[labelEnd + 1] !== '{') return false;
  const attrsEnd = findAttrsEnd(state.src, labelEnd + 1);
  if (attrsEnd < 0) return false;
  const attrs = parseAttrs(state.src.slice(labelEnd + 2, attrsEnd));
  if (!attrs) return false;

  if (!silent) {
    const { style } = attrsToStyle(attrs);
    const open = state.push('smd_span_open', 'span', 1);
    const classes = ['smd-span', ...attrs.classes.map((c) => `smd-u-${c}`)];
    open.attrSet('class', classes.join(' '));
    if (style) open.attrSet('style', style);
    if (attrs.id) open.attrSet('id', attrs.id);
    const oldMax = state.posMax;
    state.pos = start + 1;
    state.posMax = labelEnd;
    state.md.inline.tokenize(state);
    state.posMax = oldMax;
    state.push('smd_span_close', 'span', -1);
  }
  state.pos = attrsEnd + 1;
  return true;
}

/** `:name[content]{attrs}` inline directives (badge, kbd, progress, mention, status). */
function inlineDirective(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x3a /* : */) return false;
  const prev = start > 0 ? state.src[start - 1] : ' ';
  if (!/[\s([{>*_~"'-]/.test(prev)) return false;
  const m = /^:([a-z][a-z0-9-]*)(?=[[{])/.exec(state.src.slice(start, state.posMax));
  if (!m || !(m[1] in INLINE_DIRECTIVES)) return false;
  const name = m[1];
  let pos = start + m[0].length;

  let content = '';
  if (state.src[pos] === '[') {
    const end = state.md.helpers.parseLinkLabel(state, pos, true);
    if (end < 0) return false;
    content = state.src.slice(pos + 1, end);
    pos = end + 1;
  }
  let attrs = emptyAttrs();
  if (state.src[pos] === '{') {
    const end = findAttrsEnd(state.src, pos);
    if (end < 0) return false;
    const parsed = parseAttrs(state.src.slice(pos + 1, end));
    if (!parsed) return false;
    attrs = parsed;
    pos = end + 1;
  }
  if (!silent) {
    const token = state.push('html_inline', '', 0);
    token.content = renderInlineDirective(state.md, name, content, attrs.values, (state.env as Env).options?.today);
  }
  state.pos = pos;
  return true;
}

function renderInlineDirective(md: MarkdownIt, name: string, content: string, values: Record<string, string>, today?: string): string {
  const color = values.color ? resolveColor(values.color) : null;
  switch (name) {
    case 'badge': {
      const style = color ? ` style="--smd-badge:${escapeHtml(color)}"` : '';
      return `<span class="smd-badge"${style}>${md.renderInline(content)}</span>`;
    }
    case 'kbd':
      return content
        .split('+')
        .map((k) => `<kbd>${escapeHtml(k.trim())}</kbd>`)
        .join('<span class="smd-kbd-plus">+</span>');
    case 'progress': {
      const raw = Number.parseFloat(values.value ?? content ?? '0');
      const value = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
      const barStyle = `width:${value}%${color ? `;background:${color}` : ''}`;
      const label = values.label ?? `${Math.round(value)}%`;
      return `<span class="smd-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><span class="smd-progress-track"><span class="smd-progress-bar" style="${escapeHtml(barStyle)}"></span></span><span class="smd-progress-label">${escapeHtml(label)}</span></span>`;
    }
    case 'mention':
      return `<span class="smd-mention">${escapeHtml(content)}</span>`;
    case 'priority': {
      const level = content.trim();
      const key = level.toLowerCase();
      const color = ({ p0: 'red', critical: 'red', p1: 'orange', high: 'orange', p2: 'amber', medium: 'amber', p3: 'blue', low: 'gray', p4: 'gray' } as Record<string, string>)[key] ?? 'gray';
      return `<span class="smd-priority" style="--smd-badge:var(--smd-${color})">${escapeHtml(level)}</span>`;
    }
    case 'due': {
      const date = content.trim();
      const state = dueState(date, today);
      // ISO dates stay as written: unambiguous for distributed teams.
      return `<span class="smd-due smd-due-${state}" title="Due ${escapeHtml(date)}${state === 'overdue' ? ' (overdue)' : ''}">📅 ${escapeHtml(date)}</span>`;
    }
    case 'metric': {
      const trend = values.trend ?? (values.delta?.trim().startsWith('-') ? 'down' : values.delta ? 'up' : '');
      const good = values.good ?? 'up';
      const tone = !trend || trend === 'flat' ? 'flat' : trend === good ? 'good' : 'bad';
      const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : trend === 'flat' ? '■' : '';
      const delta = values.delta ? `<span class="smd-metric-delta smd-metric-${tone}">${arrow} ${escapeHtml(values.delta)}</span>` : '';
      return `<span class="smd-metric"><span class="smd-metric-value">${md.renderInline(content)}</span><span class="smd-metric-label">${escapeHtml(values.label ?? '')}</span>${delta}</span>`;
    }
    case 'status': {
      const dot = color ?? 'var(--smd-gray)';
      return `<span class="smd-status"><span class="smd-status-dot" style="background:${escapeHtml(dot)}"></span>${md.renderInline(content)}</span>`;
    }
    default:
      return escapeHtml(content);
  }
}

/** `==highlighted==` */
function mark(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x3d || state.src.charCodeAt(start + 1) !== 0x3d) return false;
  if (/\s|=/.test(state.src[start + 2] ?? ' ')) return false;
  const end = state.src.indexOf('==', start + 2);
  if (end < 0 || end > state.posMax - 2 || /\s/.test(state.src[end - 1])) return false;
  if (!silent) {
    state.push('smd_mark_open', 'mark', 1);
    const oldMax = state.posMax;
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = oldMax;
    state.push('smd_mark_close', 'mark', -1);
  }
  state.pos = end + 2;
  return true;
}

/** `$inline math$` (Pandoc rules: no space inside the delimiters, no digit after the closer). */
function mathInline(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src[start] !== '$' || state.src[start + 1] === '$') return false;
  if (/\s/.test(state.src[start + 1] ?? ' ')) return false;
  let end = start + 1;
  while ((end = state.src.indexOf('$', end)) !== -1) {
    if (end >= state.posMax) return false;
    if (state.src[end - 1] !== '\\' && !/\s/.test(state.src[end - 1]) && !/\d/.test(state.src[end + 1] ?? '')) break;
    end++;
  }
  if (end === -1 || end === start + 1) return false;
  if (!silent) {
    const token = state.push('smd_math_inline', 'math', 0);
    token.content = state.src.slice(start + 1, end);
  }
  state.pos = end + 1;
  return true;
}

/** `$$ … $$` display math blocks. */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const lineText = (l: number) => state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]);
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const first = lineText(startLine);
  if (!first.startsWith('$$')) return false;
  let content: string;
  let last = startLine;
  const rest = first.slice(2);
  if (rest.trimEnd().endsWith('$$') && rest.trim().length > 2) {
    content = rest.trimEnd().slice(0, -2);
  } else {
    const lines = [rest];
    let found = false;
    for (let l = startLine + 1; l < endLine; l++) {
      const t = lineText(l);
      if (t.trimEnd().endsWith('$$')) {
        lines.push(t.trimEnd().slice(0, -2));
        last = l;
        found = true;
        break;
      }
      lines.push(t);
    }
    if (!found) return false;
    content = lines.join('\n');
  }
  if (silent) return true;
  const token = state.push('smd_math_block', 'math', 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, last + 1];
  state.line = last + 1;
  return true;
}

function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' });
  } catch (e) {
    return `<span class="smd-error">${escapeHtml(String(e))}</span>`;
  }
}

// ---------------------------------------------------------------------------
// Core passes
// ---------------------------------------------------------------------------

/** GFM task lists: `- [ ] todo` / `- [x] done`, clickable in the preview. */
function taskLists(state: StateCore): void {
  const tokens = state.tokens;
  const env = state.env as Env;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const m = /^\[([ xX])\][ \t]/.exec(inline.content);
    const first = inline.children?.[0];
    if (!m || !first || first.type !== 'text' || !first.content.startsWith(m[0].slice(0, 3))) continue;
    first.content = first.content.slice(3).replace(/^[ \t]/, '');
    const checked = m[1] !== ' ';
    const line = (tokens[i - 2].map?.[0] ?? 0) + (env.lineOffset ?? 0);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" class="smd-task-box" data-task-line="${line}"${checked ? ' checked' : ''}>`;
    inline.children!.unshift(box);
    tokens[i - 2].attrJoin('class', `smd-task${checked ? ' smd-task-done' : ''}`);
    for (let j = i - 3; j >= 0; j--) {
      if (tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') {
        if (tokens[j].level === tokens[i - 2].level - 1) {
          tokens[j].attrJoin('class', 'smd-task-list');
          break;
        }
      }
    }
  }
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function headingIds(state: StateCore): void {
  const env = state.env as Env;
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'heading_open') continue;
    const text = (tokens[i + 1].children ?? [])
      .filter((c) => c.type === 'text' || c.type === 'code_inline')
      .map((c) => c.content)
      .join('');
    let slug = t.attrGet('id');
    env.bases?.push(slug ? null : slugify(text) || 'section');
    if (!slug) {
      const base = slugify(text) || 'section';
      const n = env.slugs?.get(base) ?? 0;
      env.slugs?.set(base, n + 1);
      slug = n ? `${base}-${n}` : base;
      t.attrSet('id', slug);
    }
    const agent = t.attrGet('data-agent') ?? undefined;
    env.headings?.push({ level: Number(t.tag.slice(1)), text: text.trim(), slug, line: (t.map?.[0] ?? 0) + (env.lineOffset ?? 0), ...(agent ? { agent } : {}) });
  }
}

/** `## Title {#custom-id .class agent=skip}` — trailing attribute list on a heading. */
export const HEADING_ATTRS = /\s+\{([^{}]*)\}\s*$/;

function headingAttrs(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const last = inline.children?.[inline.children.length - 1];
    if (!last || last.type !== 'text') continue;
    const m = HEADING_ATTRS.exec(last.content);
    const attrs = m ? parseAttrs(m[1]) : null;
    if (!m || !attrs) continue;
    last.content = last.content.slice(0, m.index);
    inline.content = inline.content.replace(HEADING_ATTRS, '');
    if (attrs.id) tokens[i].attrSet('id', attrs.id);
    if (attrs.classes.length) tokens[i].attrJoin('class', attrs.classes.map((c) => `smd-u-${c}`).join(' '));
    if (attrs.values.agent) tokens[i].attrSet('data-agent', attrs.values.agent);
  }
}

/** overdue | soon (≤ 7 days) | later | invalid */
export function dueState(date: string, today = new Date().toISOString().slice(0, 10)): 'overdue' | 'soon' | 'later' | 'invalid' {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return 'invalid';
  const days = (Date.parse(date) - Date.parse(today)) / 86_400_000;
  return days < 0 ? 'overdue' : days <= 7 ? 'soon' : 'later';
}

/** Add data-line to block tokens so the preview can follow the editor. */
function sourceLines(state: StateCore): void {
  const offset = (state.env as Env).lineOffset ?? 0;
  for (const t of state.tokens) {
    if (t.map && t.block && t.nesting >= 0 && !t.type.startsWith('container_')) {
      t.attrSet('data-line', String(t.map[0] + offset));
    }
  }
}

/** Render a whole standalone HTML page (used by Export to HTML and the CLI). */
export function renderStandaloneHtml(text: string, css: string, runtimeJs: string, options: RenderOptions = {}): string {
  const result = renderSmd(text, options);
  const title = typeof result.frontMatter.title === 'string' ? result.frontMatter.title : result.headings[0]?.text ?? 'Document';
  const theme = ['light', 'dark'].includes(String(result.frontMatter.theme)) ? String(result.frontMatter.theme) : 'auto';
  return pageHtml({ title, theme, body: result.html, css, runtimeJs, cdn: true });
}

export interface PageParts {
  title: string;
  /** `light`, `dark` or `auto` (follow the reader's system). */
  theme: string;
  /** HTML inside `<main>`. */
  body: string;
  css: string;
  runtimeJs: string;
  /** Load the KaTeX stylesheet and Mermaid from a CDN (for documents with math or diagrams). */
  cdn: boolean;
}

/** The standalone page around rendered HTML: stylesheet, theme preference and runtime inlined. */
export function pageHtml(page: PageParts): string {
  const katex = page.cdn ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">\n' : '';
  const mermaid = page.cdn ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n' : '';
  return `<!DOCTYPE html>
<html lang="en" data-smd-theme-pref="${page.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Styled Markdown">
<title>${escapeHtml(page.title)}</title>
${katex}<style>
${page.css}
</style>
</head>
<body class="smd-body">
<main id="smd-root">${page.body}</main>
${mermaid}<script>
${page.runtimeJs}
</script>
</body>
</html>
`;
}
