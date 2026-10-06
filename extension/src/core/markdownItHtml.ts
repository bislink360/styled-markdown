import type MarkdownIt from 'markdown-it';
import type { Options, Renderer, Token } from 'markdown-it';
import katex from 'katex';
import { attrsToStyle, escapeHtml, htmlAttrs, resolveColor, type Attrs } from './attrs';
import { FigureCounter, type FigureNumber } from './figures';
import { asStringList } from './frontmatter';
import { langFromPath, parseFenceInfo, sliceLines, type FenceInfo } from './fence';
import { EN, label, term, type MessageKey, type Messages } from './i18n';
import {
  includeHref, includeLabel, includeProblemText, includeRequest, type IncludeRequest, type IncludeResult,
} from './include';
import { quoteCite } from './quote';
import { CALLOUT_TYPES, STATUS_VALUES } from './spec';
import type { SmdContext } from './markdownItSetup';
import type { ContainerMeta, FootnoteMeta } from './markdownItRules';
import type { Env } from './render';

/** HTML for .smd blocks and inline directives, shared by renderSmd and the markdown-it plugin. */

export type RenderRule = (tokens: Token[], idx: number, options: Options, env: unknown, self: Renderer) => string;

const CALLOUT_ICONS: Record<string, string> = {
  note: '✎', info: 'ℹ', tip: '💡', success: '✔', warning: '⚠', danger: '⛔', question: '?',
};

// ---------------------------------------------------------------------------
// Document header (front matter)
// ---------------------------------------------------------------------------

/**
 * The header card for front matter: status, version, title, summary, owners and tags. Empty without any of them.
 * `m` gives the labels in the document's language (English by default).
 */
export function renderHeader(inline: (text: string) => string, data: Record<string, unknown>, m: Messages = EN): string {
  const title = typeof data.title === 'string' ? data.title : '';
  const summary = typeof data.summary === 'string' ? data.summary : '';
  const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
  const owners = asStringList(data.owners);
  const tags = asStringList(data.tags);
  if (!title && !summary && !status && !owners.length && !tags.length) return '';

  const top = headerFacts(data, status, m);
  const meta = [metaRow(m['header.owners'], owners, 'smd-mention'), metaRow(m['header.tags'], tags, 'smd-tag')].filter(Boolean);
  return `<header class="smd-doc-header" data-line="0">
${top.length ? `<div class="smd-doc-top">${top.join('<span class="smd-dot">·</span>')}</div>` : ''}
${title ? `<h1 class="smd-doc-title">${inline(title)}</h1>` : ''}
${summary ? `<p class="smd-doc-summary">${inline(summary)}</p>` : ''}
${meta.length ? `<div class="smd-doc-meta">${meta.map((m) => `<div>${m}</div>`).join('')}</div>` : ''}
</header>`;
}

function headerFacts(data: Record<string, unknown>, status: string, m: Messages): string[] {
  const top: string[] = [];
  if (status) {
    const known = STATUS_VALUES.includes(status) ? status : 'unknown';
    top.push(`<span class="smd-doc-status smd-doc-status-${known}">${escapeHtml(term(m, 'docStatus', status))}</span>`);
  }
  if (data.version !== undefined) top.push(`<span>${label(m, 'header.version', { version: escapeHtml(String(data.version)) })}</span>`);
  if (data.updated !== undefined) top.push(`<span>${label(m, 'header.updated', { date: escapeHtml(String(data.updated)) })}</span>`);
  if (typeof data.audience === 'string') {
    top.push(`<span>${label(m, 'header.audience', { audience: escapeHtml(term(m, 'audience', data.audience)) })}</span>`);
  }
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
  /** The instance rendering, for its link checks (`:::quote{cite}`). */
  md?: MarkdownIt;
  /** The labels in the document's language. */
  m: Messages;
}

/** Opening HTML of a container; sets meta.close to the matching closing tags. */
type ContainerOpen = (c: ContainerView) => string;

export function renderContainer(tokens: Token[], idx: number, env: unknown, ctx: SmdContext, md?: MarkdownIt): string {
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
    md,
    m: ctx.messages(env),
  };
  if ((CALLOUT_TYPES as readonly string[]).includes(meta.name)) return calloutOpen(view);
  return (CONTAINERS.get(meta.name) ?? boxOpen)(view);
}

function calloutOpen(c: ContainerView): string {
  const { name, meta, attrs } = c;
  const type = c.m[`callout.${name}` as MessageKey];
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
  return `<details${htmlAttrs(c.attrs, ['smd-details'], c.style)}${c.dataLine}${open}><summary>${c.inline(c.meta.title || c.m['details.title'])}</summary><div class="smd-details-body">\n`;
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
  const title = c.meta.title || c.m['tab.title'];
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
  const label = `<span class="smd-agent-icon" aria-hidden="true">🤖</span><span>${c.m['agent.label']}${c.meta.title ? `: ${c.inline(c.meta.title)}` : ''}</span>`;
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
  const label = `<span aria-hidden="true">👤</span><span>${c.m['human.label']}${c.meta.title ? `: ${c.inline(c.meta.title)}` : ''}</span>`;
  return `<div${htmlAttrs(c.attrs, ['smd-human'], c.style)}${c.dataLine}><div class="smd-human-title">${label}</div><div class="smd-human-body">\n`;
}

function decisionOpen(c: ContainerView): string {
  c.meta.close = '</div></div>';
  const values = c.attrs.values;
  const status = (values.status ?? 'proposed').toLowerCase();
  const facts = [values.date, values.owner].filter(Boolean).map((f) => `<span>${escapeHtml(f!)}</span>`).join('<span class="smd-dot">·</span>');
  return `<div${htmlAttrs(c.attrs, ['smd-decision', `smd-decision-${status}`], c.style)}${c.dataLine}>` +
    `<div class="smd-decision-head"><span class="smd-decision-label">${c.m['decision.label']}</span><span class="smd-decision-status">${escapeHtml(term(c.m, 'decisionStatus', status))}</span>${facts ? `<span class="smd-decision-facts">${facts}</span>` : ''}</div>` +
    `${c.meta.title ? `<div class="smd-decision-title">${c.inline(c.meta.title)}</div>` : ''}<div class="smd-decision-body">\n`;
}

function riskOpen(c: ContainerView): string {
  c.meta.close = '</div></div>';
  const { values } = c.attrs;
  const { m } = c;
  const impact = (values.impact ?? 'medium').toLowerCase();
  const likelihood = values.likelihood?.toLowerCase();
  const facts = [
    `${m['label.impact']} <b>${escapeHtml(term(m, 'impact', impact))}</b>`,
    likelihood ? `${m['label.likelihood']} <b>${escapeHtml(term(m, 'likelihood', likelihood))}</b>` : '',
    values.owner ? `${m['label.owner']} ${escapeHtml(values.owner)}` : '',
    values.status ? `<span class="smd-risk-status">${escapeHtml(term(m, 'riskStatus', values.status))}</span>` : '',
  ].filter(Boolean).join('<span class="smd-dot">·</span>');
  return `<div${htmlAttrs(c.attrs, ['smd-risk', `smd-risk-${impact}`], c.style)}${c.dataLine}>` +
    `<div class="smd-risk-head"><span class="smd-risk-icon" aria-hidden="true">⚑</span><span class="smd-risk-title">${c.inline(c.meta.title || m['risk.title'])}</span></div>` +
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
  const grid = c.ctx.riskMatrix?.(source, c.m) ?? '';
  return `<div${htmlAttrs(c.attrs, ['smd-risk-matrix'], c.style)}${c.dataLine}>${title}${grid}<div class="smd-risk-matrix-body">\n`;
}

/** `:::include`: the included content (spliced in by markdownItInclude.ts), or a note with a link, then the fallback body. */
function includeOpen(c: ContainerView): string {
  c.meta.close = '</div>';
  const result = c.meta.include;
  const request = includeRequest(c.attrs.values);
  if (result?.ok) {
    const from = includeLabel(result.include.path, request?.section);
    return `<div${htmlAttrs(c.attrs, ['smd-include'], c.style)}${c.dataLine} data-include="${escapeHtml(from)}">\n`;
  }
  return `<div${htmlAttrs(c.attrs, ['smd-include', 'smd-include-missing'], c.style)}${c.dataLine}>${includeNote(result, request, c.m)}\n`;
}

function includeNote(result: IncludeResult | undefined, request: IncludeRequest | undefined, m: Messages): string {
  if (!request) return `<div class="smd-include-note">${m['include.needsFile']}</div>`;
  const failure = result && !result.ok ? result : undefined;
  const path = failure?.path ?? request.file;
  const text = failure ? includeProblemText(failure, m) : m['include.unavailable'];
  const label = escapeHtml(includeLabel(path, request.section));
  const href = includeHref(path, request.section);
  const target = href === undefined ? `<code>${label}</code>` : `<a href="${escapeHtml(href)}">${label}</a>`;
  return `<div class="smd-include-note">${escapeHtml(text)}: ${target}</div>`;
}

/** A figure's label in the document's language: `Figure 2`, `Table 1`. */
export const figureLabel = (figure: FigureNumber, m: Messages): string =>
  label(m, `figure.${figure.kind}` as MessageKey, { n: figure.number });

/** `:::figure`: the content, then a caption with the figure's number (see numberFigures). */
function figureOpen(c: ContainerView): string {
  const figure = c.meta.figure ?? new FigureCounter().next(c.attrs.values.kind);
  const caption = c.meta.title ? ` ${c.inline(c.meta.title)}` : '';
  const head = `<span class="smd-figure-label">${figureLabel(figure, c.m)}${caption ? ':' : ''}</span>`;
  c.meta.close = `<figcaption class="smd-figure-caption">${head}${caption}</figcaption></figure>`;
  return `<figure${htmlAttrs(c.attrs, ['smd-figure', `smd-figure-${figure.kind}`], c.style)}${c.dataLine}>\n`;
}

/** `:::glossary`: an optional title above the definition list (see markdownItGlossary.ts). */
function glossaryOpen(c: ContainerView): string {
  c.meta.close = '</div>';
  const title = c.meta.title ? `<div class="smd-glossary-title">${c.inline(c.meta.title)}</div>` : '';
  return `<div${htmlAttrs(c.attrs, ['smd-glossary'], c.style)}${c.dataLine}>${title}\n`;
}

/** `:::changelog`: an optional title, then the entries (wrapped in a list by markdownItChangelog.ts). */
function changelogOpen(c: ContainerView): string {
  c.meta.close = '</div>';
  const title = c.meta.title ? `<div class="smd-changelog-title">${c.inline(c.meta.title)}</div>` : '';
  return `<div${htmlAttrs(c.attrs, ['smd-changelog'], c.style)}${c.dataLine}>${title}
`;
}

/**
 * `:::quote`: `<figure class="smd-quote"><blockquote cite="…">` the body `</blockquote>`, then `— Author, <cite>Source</cite>`.
 * The `cite` URL goes through the same checks as links (only http, https and relative URLs); the source links to it.
 * Not a numbered figure.
 */
function quoteOpen(c: ContainerView): string {
  const href = quoteHref(c.attrs.values.cite, c.md);
  c.meta.close = `</blockquote>${quoteCaption(c, href)}</figure>`;
  const cite = href ? ` cite="${escapeHtml(href)}"` : '';
  return `<figure${htmlAttrs(c.attrs, ['smd-quote'], c.style)}${c.dataLine}><blockquote${cite}>
`;
}

/** A `cite` URL that is http(s) or relative and that markdown-it would link to, normalized as it normalizes links. */
function quoteHref(value: string | undefined, md: MarkdownIt | undefined): string | undefined {
  const url = quoteCite(value);
  if (!url || !md) return url;
  return md.validateLink(url) ? md.normalizeLink(url) : undefined;
}

function quoteCaption(c: ContainerView, href: string | undefined): string {
  const { author, source } = c.attrs.values;
  const parts: string[] = [];
  if (author?.trim()) parts.push(`<span class="smd-quote-author">${c.inline(author.trim())}</span>`);
  if (source?.trim()) {
    const text = c.inline(source.trim());
    parts.push(`<cite>${href && !text.includes('<a ') ? `<a href="${escapeHtml(href)}">${text}</a>` : text}</cite>`);
  }
  if (!parts.length) return '';
  return `<figcaption class="smd-quote-caption">${label(c.m, 'quote.caption', { by: parts.join(c.m['quote.separator']) })}</figcaption>`;
}

/** `:ref[id]`: the number of the figure with that id, linked to it; an unknown id is shown as written. */
export function renderRef(id: string, figure: FigureNumber | undefined, m: Messages = EN): string {
  const safe = escapeHtml(id);
  if (!figure) return `<span class="smd-ref smd-ref-missing" title="${escapeHtml(m['figure.missingRef'])}">${safe}</span>`;
  return `<a class="smd-ref" href="#${safe}">${figureLabel(figure, m)}</a>`;
}

const CONTAINERS = new Map<string, ContainerOpen>([
  ['include', includeOpen],
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
  ['figure', figureOpen],
  ['changelog', changelogOpen],
  ['quote', quoteOpen],
  ['glossary', glossaryOpen],
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
  m: Messages;
}

export function renderInlineDirective(
  md: MarkdownIt, name: string, content: string, values: Record<string, string>, today?: string, m: Messages = EN,
): string {
  const color = values.color ? resolveColor(values.color) : null;
  const render = DIRECTIVES.get(name);
  return render ? render({ md, content, values, color, today, m }) : escapeHtml(content);
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

function progress({ content, values, color, m }: Directive): string {
  const raw = Number.parseFloat(values.value ?? content ?? '0');
  const value = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  const barStyle = `width:${value}%${color ? `;background:${color}` : ''}`;
  const label = values.label ?? `${Math.round(value)}%`;
  // A progress bar needs a name; the label inside it is presentational to assistive technology.
  const name = escapeHtml(values.label ?? m['progress.label']);
  return `<span class="smd-progress" role="progressbar" aria-label="${name}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><span class="smd-progress-track"><span class="smd-progress-bar" style="${escapeHtml(barStyle)}"></span></span><span class="smd-progress-label">${escapeHtml(label)}</span></span>`;
}

const PRIORITY_COLORS = new Map(Object.entries({
  p0: 'red', critical: 'red', p1: 'orange', high: 'orange', p2: 'amber', medium: 'amber', p3: 'blue', low: 'gray', p4: 'gray',
}));

function priority({ content, m }: Directive): string {
  const level = content.trim();
  const color = PRIORITY_COLORS.get(level.toLowerCase()) ?? 'gray';
  return `<span class="smd-priority" style="--smd-badge:var(--smd-${color})">${escapeHtml(term(m, 'priority', level))}</span>`;
}

function due({ content, today, m }: Directive): string {
  const date = content.trim();
  const state = dueState(date, today);
  const title = label(m, state === 'overdue' ? 'due.titleOverdue' : 'due.title', { date });
  // ISO dates stay as written: unambiguous for distributed teams.
  return `<span class="smd-due smd-due-${state}" title="${escapeHtml(title)}">📅 ${escapeHtml(date)}${dueNote(state, m)}</span>`;
}

/** Overdue and due soon in words as well as colour: "overdue" visibly, "due soon" for screen readers. Hidden on done tasks. */
export function dueNote(state: string, m: Messages = EN): string {
  if (state === 'overdue') return `<span class="smd-due-note"> · ${m['due.overdue']}</span>`;
  return state === 'soon' ? `<span class="smd-due-note smd-sr-only"> (${m['due.soon']})</span>` : '';
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

function metric({ md, content, values, m }: Directive): string {
  const trend = metricTrend(values);
  const tone = metricTone(trend, values.good ?? 'up');
  const arrow = TREND_ARROWS.get(trend) ?? '';
  // Good or bad shows as colour; screen readers get it as text, and the arrow as the trend's name.
  const spoken = [TREND_ARROWS.has(trend) ? term(m, 'trend', trend) : '', tone === 'flat' ? '' : term(m, 'tone', tone)].filter(Boolean).join(', ');
  const sr = spoken ? `<span class="smd-sr-only"> (${spoken})</span>` : '';
  const delta = values.delta ? `<span class="smd-metric-delta smd-metric-${tone}"><span aria-hidden="true">${arrow}</span> ${escapeHtml(values.delta)}${sr}</span>` : '';
  return `<span class="smd-metric"><span class="smd-metric-value">${md.renderInline(content)}</span><span class="smd-metric-label">${escapeHtml(values.label ?? '')}</span>${delta}</span>`;
}

function status({ md, content, values, color, m }: Directive): string {
  const dot = color ?? 'var(--smd-gray)';
  // The text says the status; the dot only repeats it in colour. Without text, the colour name stands in.
  const text = content.trim() ? '' : escapeHtml(values.color === undefined ? m['statusDot.label'] : term(m, 'color', values.color));
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
// Footnotes (GitHub's markup: ids, data-footnote-* attributes and the hidden "Footnotes" label)
// ---------------------------------------------------------------------------

/** The id of the n-th footnote's reference number `sub` (1-based): fnref-1, fnref-1-2… */
const footnoteRefId = ({ n, sub }: FootnoteMeta) => (sub > 1 ? `fnref-${n}-${sub}` : `fnref-${n}`);

/** `<sup>` with the footnote's number, linking to it. */
export const footnoteRef: RenderRule = (tokens, idx) => {
  const meta = tokens[idx].meta as FootnoteMeta;
  return `<sup class="smd-footnote-ref"><a href="#fn-${meta.n}" id="${footnoteRefId(meta)}" data-footnote-ref role="doc-noteref" aria-describedby="footnote-label">${meta.n}</a></sup>`;
};

/** A back link from a footnote to one of its references; the second and later ones are numbered. */
export const footnoteBackref = (m: (env: unknown) => Messages): RenderRule => (tokens, idx, _opts, env) => {
  const meta = tokens[idx].meta as FootnoteMeta;
  const id = footnoteRefId(meta);
  const backTo = escapeHtml(label(m(env), 'footnote.backref', { ref: id.slice(6) }));
  return ` <a href="#${id}" class="smd-footnote-backref" data-footnote-backref role="doc-backlink" aria-label="${backTo}">↩︎${meta.sub > 1 ? `<sup>${meta.sub}</sup>` : ''}</a>`;
};

export const footnotesOpen = (m: (env: unknown) => Messages): RenderRule => (_tokens, _idx, _opts, env) =>
  `<section class="footnotes smd-footnotes" data-footnotes>\n<h2 id="footnote-label" class="smd-sr-only">${m(env)['footnote.heading']}</h2>\n<ol>\n`;
export const footnotesClose: RenderRule = () => '</ol>\n</section>\n';
export const footnoteOpen: RenderRule = (tokens, idx) => `<li id="fn-${(tokens[idx].meta as FootnoteMeta).n}">\n`;
export const footnoteClose: RenderRule = () => '</li>\n';

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
      return `<div class="smd-code" data-line="${line}"><div class="smd-code-title">${escapeHtml(title)}</div><div class="smd-error">${label(ctx.messages(call.env), 'code.cannotRead', { file: escapeHtml(fence.file) })}</div></div>\n`;
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
