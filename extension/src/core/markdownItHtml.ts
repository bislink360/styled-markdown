import type MarkdownIt from 'markdown-it';
import type { Options, Renderer, Token } from 'markdown-it';
import katex from 'katex';
import { attrsToStyle, escapeHtml, htmlAttrs, resolveColor, type Attrs } from './attrs';
import { asStringList } from './frontmatter';
import { langFromPath, parseFenceInfo, sliceLines, type FenceInfo } from './fence';
import { CALLOUT_TYPES, STATUS_VALUES } from './spec';
import type { SmdContext } from './markdownItSetup';
import type { ContainerMeta } from './markdownItRules';
import type { Env } from './render';

/** HTML for .smd blocks and inline directives, shared by renderSmd and the markdown-it plugin. */

export type RenderRule = (tokens: Token[], idx: number, options: Options, env: unknown, self: Renderer) => string;

const CALLOUT_ICONS: Record<string, string> = {
  note: '✎', info: 'ℹ', tip: '💡', success: '✔', warning: '⚠', danger: '⛔', question: '?',
};

// ---------------------------------------------------------------------------
// Document header (front matter)
// ---------------------------------------------------------------------------

/** The header card for front matter: status, version, title, summary, owners and tags. Empty without any of them. */
export function renderHeader(inline: (text: string) => string, data: Record<string, unknown>): string {
  const title = typeof data.title === 'string' ? data.title : '';
  const summary = typeof data.summary === 'string' ? data.summary : '';
  const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
  const owners = asStringList(data.owners);
  const tags = asStringList(data.tags);
  if (!title && !summary && !status && !owners.length && !tags.length) return '';

  const top = headerFacts(data, status);
  const meta = [metaRow('Owners', owners, 'smd-mention'), metaRow('Tags', tags, 'smd-tag')].filter(Boolean);
  return `<header class="smd-doc-header" data-line="0">
${top.length ? `<div class="smd-doc-top">${top.join('<span class="smd-dot">·</span>')}</div>` : ''}
${title ? `<h1 class="smd-doc-title">${inline(title)}</h1>` : ''}
${summary ? `<p class="smd-doc-summary">${inline(summary)}</p>` : ''}
${meta.length ? `<div class="smd-doc-meta">${meta.map((m) => `<div>${m}</div>`).join('')}</div>` : ''}
</header>`;
}

function headerFacts(data: Record<string, unknown>, status: string): string[] {
  const top: string[] = [];
  if (status) {
    const known = STATUS_VALUES.includes(status) ? status : 'unknown';
    top.push(`<span class="smd-doc-status smd-doc-status-${known}">${escapeHtml(status)}</span>`);
  }
  if (data.version !== undefined) top.push(`<span>v${escapeHtml(String(data.version))}</span>`);
  if (data.updated !== undefined) top.push(`<span>Updated ${escapeHtml(String(data.updated))}</span>`);
  if (typeof data.audience === 'string') top.push(`<span>For ${escapeHtml(data.audience)}</span>`);
  return top;
}

function metaRow(label: string, items: string[], cls: string): string {
  if (!items.length) return '';
  return `<span class="smd-doc-meta-label">${label}</span>${items.map((i) => `<span class="${cls}">${escapeHtml(i)}</span>`).join(' ')}`;
}

// ---------------------------------------------------------------------------
// Block containers
// ---------------------------------------------------------------------------

/** What a container's opening HTML is built from. */
interface ContainerView {
  name: string;
  meta: ContainerMeta;
  attrs: Attrs;
  style: string;
  /** ` data-line="…"` */
  dataLine: string;
  /** Inline Markdown for titles. */
  inline: (text: string) => string;
  env: Env | undefined;
  ctx: SmdContext;
}

/** Opening HTML of a container; sets meta.close to the matching closing tags. */
type ContainerOpen = (c: ContainerView) => string;

export function renderContainer(tokens: Token[], idx: number, env: unknown, ctx: SmdContext): string {
  const token = tokens[idx];
  const meta = token.meta as ContainerMeta;
  if (token.nesting === -1) return `${meta.close}\n`;

  const smdEnv = env as Env | undefined;
  const line = token.map ? token.map[0] + (smdEnv?.lineOffset ?? 0) : '';
  const view: ContainerView = {
    name: meta.name,
    meta,
    attrs: meta.attrs,
    style: attrsToStyle(meta.attrs, true).style,
    dataLine: ` data-line="${line}"`,
    inline: (s) => ctx.title(s, env),
    env: smdEnv,
    ctx,
  };
  if ((CALLOUT_TYPES as readonly string[]).includes(meta.name)) return calloutOpen(view);
  return (CONTAINERS.get(meta.name) ?? boxOpen)(view);
}

function calloutOpen(c: ContainerView): string {
  const { name, meta, attrs } = c;
  const type = name[0].toUpperCase() + name.slice(1);
  // With its own title, the type shows only as icon and colour; screen readers get it as text.
  const typeText = meta.title ? `<span class="smd-sr-only">${type}: </span>` : '';
  const head = `<span class="smd-callout-icon" aria-hidden="true">${CALLOUT_ICONS[name]}</span><span>${typeText}${c.inline(meta.title || type)}</span>`;
  const cls = htmlAttrs(attrs, ['smd-callout', `smd-callout-${name}`], c.style);
  if (attrs.values.collapsible !== undefined) {
    meta.close = '</div></details>';
    const open = attrs.values.collapsible === 'open' ? ' open' : '';
    return `<details${cls}${c.dataLine}${open}><summary class="smd-callout-title">${head}</summary><div class="smd-callout-body">\n`;
  }
  meta.close = '</div></div>';
  return `<div${cls}${c.dataLine}><div class="smd-callout-title">${head}</div><div class="smd-callout-body">\n`;
}

/** A plain `<div class="…">` container (tabs, columns, steps, timeline). */
const divOpen = (cls: string): ContainerOpen => (c) => {
  c.meta.close = '</div>';
  return `<div${htmlAttrs(c.attrs, [cls], c.style)}${c.dataLine}>\n`;
};

/** `box` and unknown names render as a styled block; the validator flags unknown names. */
function boxOpen(c: ContainerView): string {
  c.meta.close = '</div>';
  return `<div${htmlAttrs(c.attrs, ['smd-box', `smd-box-${c.name}`], c.style)}${c.dataLine}>\n`;
}

function detailsOpen(c: ContainerView): string {
  c.meta.close = '</div></details>';
  const open = c.attrs.values.open === undefined ? '' : ' open';
  return `<details${htmlAttrs(c.attrs, ['smd-details'], c.style)}${c.dataLine}${open}><summary>${c.inline(c.meta.title || 'Details')}</summary><div class="smd-details-body">\n`;
}

function cardOpen(c: ContainerView): string {
  c.meta.close = '</div></div>';
  const accent = c.attrs.values.accent ? resolveColor(c.attrs.values.accent) : null;
  const cardStyle = [c.style, accent ? `--smd-card-accent:${accent}` : ''].filter(Boolean).join(';');
  const title = c.meta.title ? `<div class="smd-card-title">${c.inline(c.meta.title)}</div>` : '';
  return `<div${htmlAttrs(c.attrs, ['smd-card'], cardStyle)}${c.dataLine}>${title}<div class="smd-card-body">\n`;
}

/**
 * A pane under its title, so it reads well without scripts and in print. The runtime adds the tab bar and the
 * WAI-ARIA tabs roles; it gives the panes ids then, so generated ids never mix with the document's anchors.
 */
function tabOpen(c: ContainerView): string {
  c.meta.close = '</section>';
  const title = c.meta.title || 'Tab';
  return `<section${htmlAttrs(c.attrs, ['smd-tab'], c.style)}${c.dataLine} data-title="${escapeHtml(title)}"><div class="smd-tab-label">${c.inline(title)}</div>\n`;
}

function columnOpen(c: ContainerView): string {
  c.meta.close = '</div>';
  const width = c.attrs.values.width;
  let flex = '';
  if (width && /^\d+(\.\d+)?%$/.test(width)) flex = `flex:0 0 ${width}`;
  else if (width && /^\d+(\.\d+)?$/.test(width)) flex = `flex:${width} 1 0`;
  return `<div${htmlAttrs(c.attrs, ['smd-column'], [c.style, flex].filter(Boolean).join(';'))}${c.dataLine}>\n`;
}

function agentOpen(c: ContainerView): string {
  const mode = c.ctx.options(c.env).agentBlocks;
  const label = `<span class="smd-agent-icon" aria-hidden="true">🤖</span><span>For agents${c.meta.title ? `: ${c.inline(c.meta.title)}` : ''}</span>`;
  const cls = htmlAttrs(c.attrs, ['smd-agent'], c.style);
  if (mode === 'hidden') {
    c.meta.close = '</div>';
    return `<div${cls}${c.dataLine} hidden>\n`;
  }
  c.meta.close = '</div></details>';
  return `<details${cls}${c.dataLine}${mode === 'expanded' ? ' open' : ''}><summary class="smd-agent-title">${label}</summary><div class="smd-agent-body">\n`;
}

function humanOpen(c: ContainerView): string {
  c.meta.close = '</div></div>';
  const label = `<span aria-hidden="true">👤</span><span>For humans${c.meta.title ? `: ${c.inline(c.meta.title)}` : ''}</span>`;
  return `<div${htmlAttrs(c.attrs, ['smd-human'], c.style)}${c.dataLine}><div class="smd-human-title">${label}</div><div class="smd-human-body">\n`;
}

function decisionOpen(c: ContainerView): string {
  c.meta.close = '</div></div>';
  const values = c.attrs.values;
  const status = (values.status ?? 'proposed').toLowerCase();
  const facts = [values.date, values.owner].filter(Boolean).map((f) => `<span>${escapeHtml(f!)}</span>`).join('<span class="smd-dot">·</span>');
  return `<div${htmlAttrs(c.attrs, ['smd-decision', `smd-decision-${status}`], c.style)}${c.dataLine}>` +
    `<div class="smd-decision-head"><span class="smd-decision-label">Decision</span><span class="smd-decision-status">${escapeHtml(status)}</span>${facts ? `<span class="smd-decision-facts">${facts}</span>` : ''}</div>` +
    `${c.meta.title ? `<div class="smd-decision-title">${c.inline(c.meta.title)}</div>` : ''}<div class="smd-decision-body">\n`;
}

function riskOpen(c: ContainerView): string {
  c.meta.close = '</div></div>';
  const values = c.attrs.values;
  const impact = (values.impact ?? 'medium').toLowerCase();
  const likelihood = values.likelihood?.toLowerCase();
  const facts = [
    `Impact <b>${escapeHtml(impact)}</b>`,
    likelihood ? `Likelihood <b>${escapeHtml(likelihood)}</b>` : '',
    values.owner ? `Owner ${escapeHtml(values.owner)}` : '',
    values.status ? `<span class="smd-risk-status">${escapeHtml(values.status)}</span>` : '',
  ].filter(Boolean).join('<span class="smd-dot">·</span>');
  return `<div${htmlAttrs(c.attrs, ['smd-risk', `smd-risk-${impact}`], c.style)}${c.dataLine}>` +
    `<div class="smd-risk-head"><span class="smd-risk-icon" aria-hidden="true">⚑</span><span class="smd-risk-title">${c.inline(c.meta.title || 'Risk')}</span></div>` +
    `<div class="smd-risk-facts">${facts}</div><div class="smd-risk-body">\n`;
}

function apiOpen(c: ContainerView): string {
  c.meta.close = '</div></div>';
  const values = c.attrs.values;
  const method = (values.method ?? 'GET').toUpperCase();
  const auth = values.auth ? `<span class="smd-api-auth">🔒 ${escapeHtml(values.auth)}</span>` : '';
  return `<div${htmlAttrs(c.attrs, ['smd-api'], c.style)}${c.dataLine}>` +
    `<div class="smd-api-head"><span class="smd-api-method smd-api-${method.toLowerCase()}">${escapeHtml(method)}</span>` +
    `<code class="smd-api-path">${escapeHtml(values.path ?? '/')}</code>${c.meta.title ? `<span class="smd-api-title">${c.inline(c.meta.title)}</span>` : ''}${auth}</div>` +
    `<div class="smd-api-body">\n`;
}

function riskMatrixOpen(c: ContainerView): string {
  c.meta.close = '</div></div>';
  const title = c.meta.title ? `<div class="smd-risk-matrix-title">${c.inline(c.meta.title)}</div>` : '';
  const source = c.env?.source ?? c.meta.source ?? '';
  const grid = c.ctx.riskMatrix?.(source) ?? '';
  return `<div${htmlAttrs(c.attrs, ['smd-risk-matrix'], c.style)}${c.dataLine}>${title}${grid}<div class="smd-risk-matrix-body">\n`;
}

const CONTAINERS = new Map<string, ContainerOpen>([
  ['details', detailsOpen],
  ['card', cardOpen],
  ['tabs', divOpen('smd-tabs')],
  ['tab', tabOpen],
  ['columns', divOpen('smd-columns')],
  ['column', columnOpen],
  ['steps', divOpen('smd-steps')],
  ['agent', agentOpen],
  ['human', humanOpen],
  ['decision', decisionOpen],
  ['risk', riskOpen],
  ['api', apiOpen],
  ['risk-matrix', riskMatrixOpen],
  ['timeline', divOpen('smd-timeline')],
]);

// ---------------------------------------------------------------------------
// Inline directives
// ---------------------------------------------------------------------------

interface Directive {
  md: MarkdownIt;
  content: string;
  values: Record<string, string>;
  color: string | null;
  today?: string;
}

export function renderInlineDirective(md: MarkdownIt, name: string, content: string, values: Record<string, string>, today?: string): string {
  const color = values.color ? resolveColor(values.color) : null;
  const render = DIRECTIVES.get(name);
  return render ? render({ md, content, values, color, today }) : escapeHtml(content);
}

function badge({ md, content, color }: Directive): string {
  const style = color ? ` style="--smd-badge:${escapeHtml(color)}"` : '';
  return `<span class="smd-badge"${style}>${md.renderInline(content)}</span>`;
}

function kbd({ content }: Directive): string {
  return content
    .split('+')
    .map((k) => `<kbd>${escapeHtml(k.trim())}</kbd>`)
    .join('<span class="smd-kbd-plus">+</span>');
}

function progress({ content, values, color }: Directive): string {
  const raw = Number.parseFloat(values.value ?? content ?? '0');
  const value = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  const barStyle = `width:${value}%${color ? `;background:${color}` : ''}`;
  const label = values.label ?? `${Math.round(value)}%`;
  // A progress bar needs a name; the label inside it is presentational to assistive technology.
  const name = escapeHtml(values.label ?? 'Progress');
  return `<span class="smd-progress" role="progressbar" aria-label="${name}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><span class="smd-progress-track"><span class="smd-progress-bar" style="${escapeHtml(barStyle)}"></span></span><span class="smd-progress-label">${escapeHtml(label)}</span></span>`;
}

const PRIORITY_COLORS = new Map(Object.entries({
  p0: 'red', critical: 'red', p1: 'orange', high: 'orange', p2: 'amber', medium: 'amber', p3: 'blue', low: 'gray', p4: 'gray',
}));

function priority({ content }: Directive): string {
  const level = content.trim();
  const color = PRIORITY_COLORS.get(level.toLowerCase()) ?? 'gray';
  return `<span class="smd-priority" style="--smd-badge:var(--smd-${color})">${escapeHtml(level)}</span>`;
}

function due({ content, today }: Directive): string {
  const date = content.trim();
  const state = dueState(date, today);
  // ISO dates stay as written: unambiguous for distributed teams.
  return `<span class="smd-due smd-due-${state}" title="Due ${escapeHtml(date)}${state === 'overdue' ? ' (overdue)' : ''}">📅 ${escapeHtml(date)}${dueNote(state)}</span>`;
}

/** Overdue and due soon in words as well as colour: "overdue" visibly, "due soon" for screen readers. Hidden on done tasks. */
export function dueNote(state: string): string {
  if (state === 'overdue') return '<span class="smd-due-note"> · overdue</span>';
  return state === 'soon' ? '<span class="smd-due-note smd-sr-only"> (due soon)</span>' : '';
}

const DUE_NOTE = '<span class="smd-due-note';

/** HTML without the notes dueNote adds: a done task is neither overdue nor due soon. */
export function withoutDueNotes(html: string): string {
  let out = html;
  for (let at = out.indexOf(DUE_NOTE); at >= 0; at = out.indexOf(DUE_NOTE, at)) {
    const end = out.indexOf('</span>', at);
    if (end < 0) break;
    out = out.slice(0, at) + out.slice(end + '</span>'.length);
  }
  return out;
}

const TREND_ARROWS = new Map([['up', '▲'], ['down', '▼'], ['flat', '■']]);

/** The trend as written, or from the sign of `delta`. */
function metricTrend(values: Record<string, string>): string {
  if (values.trend !== undefined) return values.trend;
  if (!values.delta) return '';
  return values.delta.trim().startsWith('-') ? 'down' : 'up';
}

function metricTone(trend: string, good: string): string {
  if (!trend || trend === 'flat') return 'flat';
  return trend === good ? 'good' : 'bad';
}

function metric({ md, content, values }: Directive): string {
  const trend = metricTrend(values);
  const tone = metricTone(trend, values.good ?? 'up');
  const arrow = TREND_ARROWS.get(trend) ?? '';
  // Good or bad shows as colour; screen readers get it as text, and the arrow as the trend's name.
  const spoken = [TREND_ARROWS.has(trend) ? trend : '', tone === 'flat' ? '' : tone].filter(Boolean).join(', ');
  const sr = spoken ? `<span class="smd-sr-only"> (${spoken})</span>` : '';
  const delta = values.delta ? `<span class="smd-metric-delta smd-metric-${tone}"><span aria-hidden="true">${arrow}</span> ${escapeHtml(values.delta)}${sr}</span>` : '';
  return `<span class="smd-metric"><span class="smd-metric-value">${md.renderInline(content)}</span><span class="smd-metric-label">${escapeHtml(values.label ?? '')}</span>${delta}</span>`;
}

function status({ md, content, values, color }: Directive): string {
  const dot = color ?? 'var(--smd-gray)';
  // The text says the status; the dot only repeats it in colour. Without text, the colour name stands in.
  const text = content.trim() ? '' : escapeHtml(values.color ?? 'status');
  const dotA11y = text ? ` role="img" aria-label="${text}"` : ' aria-hidden="true"';
  return `<span class="smd-status"><span class="smd-status-dot" style="background:${escapeHtml(dot)}"${dotA11y}></span>${md.renderInline(content)}</span>`;
}

const DIRECTIVES = new Map<string, (d: Directive) => string>([
  ['badge', badge],
  ['kbd', kbd],
  ['progress', progress],
  ['mention', ({ content }) => `<span class="smd-mention">${escapeHtml(content)}</span>`],
  ['priority', priority],
  ['due', due],
  ['metric', metric],
  ['status', status],
]);

/** overdue | soon (≤ 7 days) | later | invalid */
export function dueState(date: string, today = new Date().toISOString().slice(0, 10)): 'overdue' | 'soon' | 'later' | 'invalid' {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return 'invalid';
  const days = (Date.parse(date) - Date.parse(today)) / 86_400_000;
  if (days < 0) return 'overdue';
  return days <= 7 ? 'soon' : 'later';
}

// ---------------------------------------------------------------------------
// Math and code fences
// ---------------------------------------------------------------------------

export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' });
  } catch (e) {
    return `<span class="smd-error">${escapeHtml(String(e))}</span>`;
  }
}

const MATH_FENCES = new Set(['math', 'latex', 'katex']);

/** Fenced code: Mermaid diagrams, math, and titles, file embeds and line highlights around the host's own rendering. */
export function fenceRule(previous: RenderRule, ctx: SmdContext, frames: boolean): RenderRule {
  return (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const fence = parseFenceInfo(token.info);
    const line = token.attrGet('data-line') ?? '';
    const lower = fence.lang.toLowerCase();
    if (lower === 'mermaid') {
      return `<div class="smd-diagram" data-line="${line}"><pre class="smd-mermaid">${escapeHtml(token.content)}</pre></div>\n`;
    }
    if (MATH_FENCES.has(lower)) return `<div class="smd-math-block" data-line="${line}">${renderMath(token.content, true)}</div>\n`;
    if (!frames && !fence.title && !fence.file && !fence.highlight.size) return previous(tokens, idx, opts, env, self);
    // data-line moves to the frame when renderSmd's own source lines put it there; a host's attributes stay.
    if (ctx.ownLines) token.attrs = (token.attrs ?? []).filter(([k]) => k !== 'data-line');
    return framedFence({ tokens, idx, opts, env, self }, previous, fence, line, ctx);
  };
}

interface RuleCall {
  tokens: Token[];
  idx: number;
  opts: Options;
  env: unknown;
  self: Renderer;
}

/** ```ts file="../src/app.ts" lines="10-20" — embed (part of) a real file so docs never drift from code. */
function framedFence(call: RuleCall, previous: RenderRule, fence: FenceInfo, line: string, ctx: SmdContext): string {
  const token = call.tokens[call.idx];
  let title = fence.title;
  if (fence.file) {
    const loaded = ctx.options(call.env).readFile?.(fence.file, call.env);
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
  const code = highlightLines(previous(call.tokens, call.idx, call.opts, call.env, call.self), fence);
  return `<div class="smd-code" data-line="${line}">${codeHeader(title, fence.lang)}${code}</div>\n`;
}

/** Absolutely positioned bands behind the code; keeps hljs markup intact across lines. */
function highlightLines(code: string, fence: FenceInfo): string {
  if (!fence.highlight.size) return code;
  const shift = fence.file && fence.lines ? fence.lines[0] - 1 : 0;
  const bands = [...fence.highlight].sort((a, b) => a - b)
    .map((n) => n - shift)
    .filter((n) => n >= 1)
    .map((n) => `<span class="smd-hl-line" style="top:calc(14px + ${n - 1} * 1.55em)"></span>`).join('');
  return code.replace('<pre>', `<pre class="smd-has-hl">${bands}`);
}

function codeHeader(title: string | undefined, lang: string): string {
  if (title) return `<div class="smd-code-title">${escapeHtml(title)}</div>`;
  return lang ? `<div class="smd-code-lang">${escapeHtml(lang)}</div>` : '';
}
