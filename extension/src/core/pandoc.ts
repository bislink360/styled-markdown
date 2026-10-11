import { escapeHtml } from './attrs';
import { parseFrontMatter } from './frontmatter';
import {
  classes, element, findElement, parseHtml, serializeHtml, text, textContent, type HtmlElement, type HtmlNode,
} from './htmlTree';
import { messagesFor } from './i18n';
import { renderParsed, type RenderOptions } from './render';

/**
 * The "pandoc" profile of the renderer: a whole HTML page that Pandoc's HTML reader maps well to Word
 * (`pandoc -f html -t docx`). It reshapes renderSmd's own output, so it follows the human view and its labels:
 *
 * - callouts, decisions and risks become block quotes under a bold title; cards, `:::details` and other boxes
 *   are expanded to their title (bold) and content; tabs become sections under a heading one level down
 * - figures keep `<figure>` and `<figcaption>` (Word captions); a figure around a lone table captions the table
 * - math is MathML with its TeX annotation in `<span class="math inline|display">`, which Pandoc reads as TeX
 * - footnotes take Pandoc's own footnote markup, so they become real Word footnotes
 * - tasks start with ☐ or ☑; badges, priorities and statuses are bold text; progress bars their percentage
 * - code blocks are plain text with their language (Pandoc highlights them); Mermaid diagrams keep their source
 * - the front matter becomes the title, subtitle (summary), authors (owners), keywords (tags) and, with
 *   `toc: true`, a table of contents; status, version and dates are the first paragraph
 * - agent blocks are left out, as in print; no scripts, no classes and no styles but table cell alignment
 */

/** Options of smdToPandocHtml: those of renderSmd. Agent blocks are hidden unless `agentBlocks` says otherwise. */
export type PandocHtmlOptions = RenderOptions;

/** The front matter, as Pandoc reads it from `<title>` and `<meta>`. */
interface Meta {
  title?: string;
  subtitle?: string;
  authors: string[];
  keywords: string[];
}

interface Context {
  /** The level of the last heading, for the headings that tabs get. */
  level: number;
  meta: Meta;
}

type Rule = (el: HtmlElement, ctx: Context) => HtmlNode[];

const PARAGRAPH = 'p';
const STRONG = 'strong';
const SPAN = 'span';
const BLOCKQUOTE = 'blockquote';
const EMPHASIS = 'em';
const CODE = 'code';
const LINK = 'a';
const FIGCAPTION = 'figcaption';
const ID = 'id';
const HREF = 'href';
const DOT = ' · ';

/** An .smd document as an HTML page for Pandoc (see above). */
export function smdToPandocHtml(source: string, options: PandocHtmlOptions = {}): string {
  const fm = parseFrontMatter(source);
  const result = renderParsed(source, fm, { ...options, agentBlocks: options.agentBlocks ?? 'hidden' });
  const lang = result.lang ?? 'en';
  const ctx: Context = { level: 1, meta: { authors: [], keywords: [] } };
  const body = serializeHtml(convert(parseHtml(result.html), ctx)).replaceAll(/\n{3,}/g, '\n\n').trim();
  const toc = result.frontMatter.toc === true ? messagesFor(lang)['toc.title'] : undefined;
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
${headLines(ctx.meta, toc).join('\n')}
</head>
<body>
${body}
</body>
</html>
`;
}

/** `<title>` and the `<meta>` elements Pandoc turns into document metadata. */
function headLines(meta: Meta, tocTitle: string | undefined): string[] {
  const fields: Array<[string, string | undefined]> = [
    ['subtitle', meta.subtitle],
    ...meta.authors.map((a): [string, string] => ['author', a]),
    ['keywords', meta.keywords.join(', ')],
    ['toc', tocTitle === undefined ? undefined : 'true'],
    ['toc-title', tocTitle],
  ];
  const lines = meta.title ? [`<title>${escapeHtml(meta.title)}</title>`] : [];
  for (const [name, value] of fields) {
    if (value) lines.push(`<meta name="${name}" content="${escapeHtml(value)}">`);
  }
  return lines;
}

function convert(nodes: readonly HtmlNode[], ctx: Context): HtmlNode[] {
  return nodes.flatMap((node) => (node.kind === 'text' ? [node] : convertElement(node, ctx)));
}

function convertElement(el: HtmlElement, ctx: Context): HtmlNode[] {
  if (isHidden(el)) return [];
  const names = classes(el);
  const byClass = names.map((c) => CLASS_RULES.get(c)).find((rule) => rule !== undefined);
  return (byClass ?? TAG_RULES.get(el.tag) ?? keep)(el, ctx);
}

/** Hidden and decorative elements (icons, the status dot), and what print leaves out. */
function isHidden(el: HtmlElement): boolean {
  return el.attrs.has('hidden') || el.attrs.get('aria-hidden') === 'true' || classes(el).includes('smd-u-no-print');
}

const isTag = (tag: string) => (el: HtmlElement) => el.tag === tag;
const hasClass = (name: string) => (el: HtmlElement) => classes(el).includes(name);
const childElement = (el: HtmlElement, test: (e: HtmlElement) => boolean) =>
  el.children.find((c): c is HtmlElement => c.kind === 'element' && test(c));

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** The attributes Pandoc reads; everything else (classes, styles, data-*, ARIA) is dropped. */
const KEPT_ATTRIBUTES = new Set([
  ID, HREF, 'src', 'alt', 'title', 'colspan', 'rowspan', 'start', 'reversed', 'type', 'lang', 'dir', 'cite', 'width', 'height', 'value',
]);

function keptAttributes(el: HtmlElement): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of el.attrs) {
    if (KEPT_ATTRIBUTES.has(name)) kept[name] = value;
  }
  // Pandoc reads a cell's alignment from `align`.
  const align = /text-align:\s*(left|center|right)/.exec(el.attrs.get('style') ?? '')?.[1];
  if (align && (el.tag === 'td' || el.tag === 'th')) kept.align = align;
  return kept;
}

const keep: Rule = (el, ctx) => [element(el.tag, convert(el.children, ctx), keptAttributes(el))];
const unwrap: Rule = (el, ctx) => convert(el.children, ctx);
const drop: Rule = () => [];
/** As is, attributes and all: MathML and SVG. */
const verbatim: Rule = (el) => [el];
const wrapIn = (tag: string): Rule => (el, ctx) => [element(tag, convert(el.children, ctx))];
const boldParagraph: Rule = (el, ctx) => [element(PARAGRAPH, [element(STRONG, convert(el.children, ctx))])];
/** Bold text in brackets: `[Shipped]`. */
const bracketed: Rule = (el, ctx) => [element(STRONG, [text('['), ...convert(el.children, ctx), text(']')])];

/** A `<div>` or `<span>` without an id says nothing to Pandoc: its content stands in for it. */
const container: Rule = (el, ctx) => (el.attrs.has(ID) || el.attrs.has('lang') ? keep(el, ctx) : unwrap(el, ctx));

/** The child elements, each converted, joined by `separator` (heads made of separate pieces). */
const joined = (separator: string): Rule => (el, ctx) => {
  const parts = el.children
    .filter((c): c is HtmlElement => c.kind === 'element')
    .map((c) => convertElement(c, ctx))
    .filter((nodes) => textContent(nodes).trim());
  return parts.flatMap((nodes, i) => (i ? [text(separator), ...nodes] : nodes));
};
const joinedParagraph = (separator: string): Rule => (el, ctx) => [element(PARAGRAPH, joined(separator)(el, ctx))];

/** Text that the stylesheet capitalizes. */
const capitalized: Rule = (el) => {
  const value = textContent(el.children).trim();
  return [element(STRONG, [text(value.charAt(0).toUpperCase() + value.slice(1))])];
};

function heading(el: HtmlElement, ctx: Context): HtmlNode[] {
  ctx.level = Number(el.tag.slice(1));
  return keep(el, ctx);
}

/** A tab's label: a heading one level below the section the tabs are in. */
const tabLabel: Rule = (el, ctx) => [element(`h${Math.min(ctx.level + 1, 6)}`, convert(el.children, ctx))];

/** The document header: title, summary, owners and tags go to the metadata; status, version and dates stay as text. */
function documentHeader(el: HtmlElement, ctx: Context): HtmlNode[] {
  const title = findElement(el.children, hasClass('smd-doc-title'));
  const summary = findElement(el.children, hasClass('smd-doc-summary'));
  if (title) ctx.meta.title = textContent(title.children).trim();
  if (summary) ctx.meta.subtitle = textContent(summary.children).trim();
  ctx.meta.authors = collect(el.children, hasClass('smd-mention'));
  ctx.meta.keywords = collect(el.children, hasClass('smd-tag'));
  const facts = findElement(el.children, hasClass('smd-doc-top'));
  return facts ? [element(PARAGRAPH, convert(facts.children, ctx))] : [];
}

/** The text of every element `test` accepts. */
function collect(nodes: readonly HtmlNode[], test: (el: HtmlElement) => boolean): string[] {
  return nodes.flatMap((node) => {
    if (node.kind !== 'element') return [];
    return test(node) ? [textContent(node.children).trim()] : collect(node.children, test);
  });
}

/** `:::figure`: Pandoc reads `<figure>` with `<figcaption>` as a figure with a Word caption; a lone table takes it as its caption. */
function figure(el: HtmlElement, ctx: Context): HtmlNode[] {
  const caption = childElement(el, isTag(FIGCAPTION));
  const content = convert(el.children.filter((c) => c !== caption), ctx);
  const captionNodes = caption ? convert(caption.children, ctx) : [];
  const id = el.attrs.get(ID);
  const blocks = content.filter((n) => n.kind === 'element' || n.html.trim());
  const table = blocks.length === 1 && blocks[0].kind === 'element' && blocks[0].tag === 'table' ? blocks[0] : undefined;
  if (table && caption) {
    table.children.unshift(element('caption', captionNodes));
    if (id) table.attrs.set(ID, id);
    return [table];
  }
  const children = caption ? [...content, element(FIGCAPTION, captionNodes)] : content;
  return [element('figure', children, id ? { id } : {})];
}

/** `:::quote`: the quote, then its attribution as the last paragraph (not a figure caption). */
function quote(el: HtmlElement, ctx: Context): HtmlNode[] {
  const inner = childElement(el, isTag(BLOCKQUOTE));
  const caption = childElement(el, isTag(FIGCAPTION));
  const body = inner ? convert(inner.children, ctx) : [];
  return [element(BLOCKQUOTE, caption ? [...body, element(PARAGRAPH, convert(caption.children, ctx))] : body)];
}

/** A code block as plain text, with its language for Pandoc's highlighting. */
function codeBlock(code: string, language: string | undefined): HtmlNode[] {
  return [element('pre', [element(CODE, [text(code)], language ? { class: `language-${language}` } : {})])];
}

/** `<pre>`: the code's text without the highlighting markup or the highlighted-line bands. */
function preformatted(el: HtmlElement): HtmlNode[] {
  const code = childElement(el, isTag(CODE));
  const language = code ? classes(code).find((c) => c.startsWith('language-'))?.slice('language-'.length) : undefined;
  return codeBlock(textContent(code ? code.children : el.children), language);
}

/** KaTeX output → its MathML, which carries the TeX as an annotation, in Pandoc's math span. */
const math = (display: boolean): Rule => (el) => {
  const mathml = findElement(el.children, isTag('math'));
  if (!mathml) return [text(textContent(el.children))];
  const span = element(SPAN, [mathml], { class: display ? 'math display' : 'math inline' });
  return display ? [element(PARAGRAPH, [span])] : [span];
};

/** A footnote reference in Pandoc's markup: `<a class="footnote-ref" role="doc-noteref"><sup>1</sup></a>`. */
function footnoteRef(el: HtmlElement): HtmlNode[] {
  const link = findElement(el.children, isTag(LINK));
  if (!link) return [];
  const attrs = { href: link.attrs.get(HREF) ?? '', id: link.attrs.get(ID) ?? '', class: 'footnote-ref', role: 'doc-noteref' };
  return [element(LINK, [element('sup', [text(textContent(link.children))])], attrs)];
}

/** The footnotes in Pandoc's markup: `<section class="footnotes" role="doc-endnotes"><ol><li role="doc-endnote">`. */
function footnotes(el: HtmlElement, ctx: Context): HtmlNode[] {
  const list = findElement(el.children, isTag('ol'));
  const items = (list?.children ?? [])
    .filter((c): c is HtmlElement => c.kind === 'element' && c.tag === 'li')
    .map((li) => element('li', convert(li.children, ctx), { id: li.attrs.get(ID) ?? '', role: 'doc-endnote' }));
  return [element('section', [element('ol', items)], { class: 'footnotes', role: 'doc-endnotes' })];
}

function footnoteBackref(el: HtmlElement): HtmlNode[] {
  return [element(LINK, [text('↩︎')], { href: el.attrs.get(HREF) ?? '', class: 'footnote-back', role: 'doc-backlink' })];
}

/** A task's checkbox as a character. Other form controls are left out. */
function input(el: HtmlElement): HtmlNode[] {
  if (el.attrs.get('type') !== 'checkbox') return [];
  return [text(el.attrs.has('checked') ? '☑ ' : '☐ ')];
}

/** `[text]{weight=bold style=italic …}`: the attributes Word can show become formatting; colours are dropped. */
const SPAN_STYLES: Array<[RegExp, string]> = [
  [/font-weight:\s*(?:[6-9]00|bold)/, STRONG],
  [/font-style:\s*italic/, EMPHASIS],
  [/line-through/, 'del'],
  [/text-decoration:[^;]*underline/, 'u'],
  [/font-family:[^;]*mono/, CODE],
];

function styledSpan(el: HtmlElement, ctx: Context): HtmlNode[] {
  const style = el.attrs.get('style') ?? '';
  let nodes = convert(el.children, ctx);
  for (const [pattern, tag] of SPAN_STYLES) {
    if (pattern.test(style)) nodes = [element(tag, nodes)];
  }
  const id = el.attrs.get(ID);
  return id ? [element(SPAN, nodes, { id })] : nodes;
}

/** A status dot without text speaks its colour. */
const statusDot: Rule = (el) => [text(el.attrs.get('aria-label') ?? '')];

/** A progress bar: its label (the percentage). */
const progress: Rule = (el) => {
  const label = findElement(el.children, hasClass('smd-progress-label'));
  return [text(label ? textContent(label.children) : '')];
};

/** `:due[date]`: the date and its note, without the calendar emoji. */
const due: Rule = (el, ctx) => {
  const nodes = convert(el.children, ctx);
  const first = nodes[0];
  if (first?.kind === 'text') nodes[0] = { kind: 'text', html: first.html.replace(/^\u{1F4C5}\s*/u, '') };
  return nodes;
};

/** A done task is neither overdue nor due soon: its due notes are left out, as the stylesheet hides them. */
const doneTask: Rule = (el, ctx) => keep({ ...el, children: withoutClass(el.children, 'smd-due-note') }, ctx);

function withoutClass(nodes: readonly HtmlNode[], name: string): HtmlNode[] {
  return nodes
    .filter((n) => n.kind === 'text' || !classes(n).includes(name))
    .map((n) => (n.kind === 'text' ? n : { ...n, children: withoutClass(n.children, name) }));
}

const errorNote: Rule = (el, ctx) => {
  const note = element(EMPHASIS, convert(el.children, ctx));
  return el.tag === 'div' ? [element(PARAGRAPH, [note])] : [note];
};

/** Rules by class, for the renderer's own markup; the first class of an element with a rule wins. */
const CLASS_RULES = new Map<string, Rule>([
  ['smd-doc-header', documentHeader],
  ['smd-toc', drop],
  ['smd-doc-status', capitalized],
  ['smd-dot', () => [text(DOT)]],
  // Blocks with a title: callouts, decisions and risks are quotes, the rest is unwrapped.
  ['smd-callout', wrapIn(BLOCKQUOTE)],
  ['smd-decision', wrapIn(BLOCKQUOTE)],
  ['smd-risk', wrapIn(BLOCKQUOTE)],
  ['smd-callout-title', boldParagraph],
  ['smd-card-title', boldParagraph],
  ['smd-human-title', boldParagraph],
  ['smd-agent-title', boldParagraph],
  ['smd-decision-title', boldParagraph],
  ['smd-risk-head', boldParagraph],
  ['smd-risk-matrix-title', boldParagraph],
  ['smd-glossary-title', boldParagraph],
  ['smd-changelog-title', boldParagraph],
  ['smd-code-title', boldParagraph],
  ['smd-decision-head', joinedParagraph(DOT)],
  ['smd-decision-status', capitalized],
  ['smd-risk-facts', wrapIn(PARAGRAPH)],
  ['smd-api-head', joinedParagraph(' ')],
  ['smd-api-method', wrapIn(STRONG)],
  ['smd-include-note', (el, ctx) => [element(PARAGRAPH, [element(EMPHASIS, convert(el.children, ctx))])]],
  ['smd-tab-label', tabLabel],
  // Release headings stay headings, not list items.
  ['smd-changelog-list', unwrap],
  ['smd-changelog-entry', unwrap],
  ['smd-code-lang', drop],
  ['smd-risk-cell-count', drop],
  ['smd-figure', figure],
  ['smd-quote', quote],
  ['smd-mermaid', (el) => codeBlock(textContent(el.children), 'mermaid')],
  ['katex', math(false)],
  ['smd-math-block', math(true)],
  ['smd-footnote-ref', footnoteRef],
  ['smd-footnotes', footnotes],
  ['smd-footnote-backref', footnoteBackref],
  // Inline directives.
  ['smd-badge', bracketed],
  ['smd-priority', bracketed],
  ['smd-status', wrapIn(STRONG)],
  ['smd-status-dot', statusDot],
  ['smd-progress', progress],
  ['smd-metric', joined(' ')],
  ['smd-metric-value', wrapIn(STRONG)],
  ['smd-due', due],
  ['smd-span', styledSpan],
  ['smd-task-done', doneTask],
  // Glossary terms link to their entries, which Word lists have no anchors for.
  ['smd-term', unwrap],
  ['smd-error', errorNote],
]);

/** Rules by element, for the rest. */
const TAG_RULES = new Map<string, Rule>([
  ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((tag): [string, Rule] => [tag, heading]),
  ...['div', SPAN, 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'details'].map((tag): [string, Rule] => [tag, container]),
  ...['abbr', 'dfn', 'time', 'label', 'font', 'center'].map((tag): [string, Rule] => [tag, unwrap]),
  ...['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'button', 'select', 'textarea', 'form', 'link', 'meta']
    .map((tag): [string, Rule] => [tag, drop]),
  ['summary', boldParagraph],
  ['kbd', wrapIn(CODE)],
  ['pre', preformatted],
  ['input', input],
  ['math', verbatim],
  ['svg', verbatim],
]);
