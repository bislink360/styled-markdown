import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { escapeHtml, resolveColor } from './attrs';
import { type FrontMatter, parseFrontMatter } from './frontmatter';
import { applySmd, smdFeatures, type SmdContext } from './markdownItSetup';
import { renderHeader } from './markdownItHtml';
import { documentRiskMatrixHtml } from './riskHtml';

export { HEADING_ATTRS, slugify } from './markdownItRules';
export { dueState } from './markdownItHtml';

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

/** Every .smd rule, reading its options from the env (renderSmd and parseSmd put them there). */
const SMD_CONTEXT: SmdContext = {
  options: (env) => (env as Env | undefined)?.options ?? {},
  title: (text) => titleMarkdown().renderInline(text),
  riskMatrix: (source) => documentRiskMatrixHtml(source),
  ownLines: true,
};

const ALL_SYNTAX = smdFeatures({ codeFrames: true, headingIds: true, sourceLines: true });

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
  applySmd(md, ALL_SYNTAX, SMD_CONTEXT);

  // Make tables horizontally scrollable on narrow previews.
  md.renderer.rules.table_open = (tokens, idx, opts, _env, self) =>
    `<div class="smd-table-wrap">${self.renderToken(tokens, idx, opts)}`;
  md.renderer.rules.table_close = (tokens, idx, opts, _env, self) => `${self.renderToken(tokens, idx, opts)}</div>`;
  // Markdown tables have one header row: each header cell heads its column.
  md.renderer.rules.th_open = (tokens, idx, opts, _env, self) => {
    tokens[idx].attrSet('scope', 'col');
    return self.renderToken(tokens, idx, opts);
  };
  return md;
}

// A shared instance for rendering titles inside containers (raw HTML off).
let titleMd: MarkdownIt | undefined;
function titleMarkdown(): MarkdownIt {
  titleMd ??= createMarkdownIt({ allowHtml: false });
  return titleMd;
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
  const headerHtml = header ? renderHeader((s) => md.renderInline(s), data) : '';
  const html = `<article class="smd-doc"${style}>${headerHtml}${data.toc === true ? renderToc(env.headings) : ''}${body}</article>`;
  return { html, frontMatter: data, headings: env.headings };
}

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

function renderToc(headings: Heading[]): string {
  const items = headings.filter((h) => h.level >= 2 && h.level <= 3);
  if (!items.length) return '';
  return `<nav class="smd-toc" aria-label="Contents"><div class="smd-toc-title">Contents</div><ul>${items
    .map((h) => `<li class="smd-toc-l${h.level}"><a href="#${h.slug}">${escapeHtml(h.text)}</a></li>`)
    .join('')}</ul></nav>`;
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
