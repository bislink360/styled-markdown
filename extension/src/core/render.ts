import MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { escapeHtml, resolveColor } from './attrs';
import { type FrontMatter, parseFrontMatter, unreadFrontMatter } from './frontmatter';
import { documentLanguage, EN, isEnglish, isEnglishMessages, messagesFor, runtimeLabels, type Messages } from './i18n';
import { addTableRules, applySmd, smdFeatures, type ReadFile, type SmdContext } from './markdownItSetup';
import { renderFrontMatterError, renderHeader } from './markdownItHtml';
import type { FigureEnv, VariableEnv } from './markdownItRules';
import { documentRiskMatrixHtml } from './riskHtml';
import { resolveSpec, specEnv, type SpecEnv, type SpecVersion } from './specVersion';
import { typographyOf } from './typography';
import { shownValues } from './variables';

export { HEADING_ATTRS, slugify } from './markdownItRules';
export type { ReadFile } from './markdownItSetup';
export { dueState } from './markdownItHtml';

export interface RenderOptions {
  /** Allow raw HTML in the source (scripts are still blocked by the host CSP). */
  allowHtml?: boolean;
  /** How :::agent blocks are presented to human readers. */
  agentBlocks?: 'collapsed' | 'expanded' | 'hidden';
  /**
   * Read a file relative to the document, for ```lang file="…"` embeds and `:::include` blocks (nested includes ask
   * for paths relative to this document too). Return undefined when not allowed/missing. Without it nothing is included.
   * The markdown-it plugin's `readFile` is the same function: the second argument is the render's env (see ReadFile).
   */
  readFile?: ReadFile;
  /** "Today" as YYYY-MM-DD, for :due[] states. Defaults to the current date. */
  today?: string;
  /**
   * The language of the labels the renderer adds ("Note", "Figure 2", "overdue"…) for a document without a `lang:`
   * of its own: a BCP 47 tag such as `de` or `pt-BR`. Unsupported languages, and the default, are English.
   */
  lang?: string;
  /**
   * The spec version for a document whose front matter has no `smd` key, for hosts that can't see the front
   * matter. The document's own `smd` wins over it. Default 1.
   */
  spec?: SpecVersion;
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
  /** The document's language tag: its front matter `lang`, else the `lang` option, else `en`. */
  lang?: string;
  /** The spec version the document was read with: its front matter `smd`, else the `spec` option, else 1. */
  spec?: SpecVersion;
}

export type ResolvedOptions = Required<Omit<RenderOptions, 'readFile' | 'lang' | 'spec'>> & Pick<RenderOptions, 'readFile'>;

export interface Env extends FigureEnv, VariableEnv, SpecEnv {
  lineOffset: number;
  headings: Heading[];
  slugs: Map<string, number>;
  options: ResolvedOptions;
  /** Per heading, the slug before de-duplication, or null for an explicit {#id} (see parse.ts). */
  bases?: Array<string | null>;
  references?: Record<string, unknown>;
  /** The whole document, for blocks that summarize it (`:::risk-matrix`). */
  source?: string;
  /** The labels in the document's language (English when absent). */
  messages?: Messages;
}

/** Every .smd rule, reading its options from the env (renderSmd and parseSmd put them there). */
const SMD_CONTEXT: SmdContext = {
  options: (env) => (env as Env | undefined)?.options ?? {},
  // Only the document's figures, variables, labels and rules (spec version, typography) go along, so `:ref[id]` and
  // `{{name}}` in a title resolve, the title reads with the document's rules, and nothing else changes.
  title: (text, env) => {
    const { smdFigures, smdVariables, messages } = (env as Env | undefined) ?? {};
    return titleMarkdown().renderInline(text, { smdFigures, smdVariables, messages, ...specEnv(env) });
  },
  riskMatrix: (source, messages) => documentRiskMatrixHtml(source, messages),
  ownLines: true,
  variables: true,
  messages: (env) => (env as Env | undefined)?.messages ?? EN,
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
  // Tables scroll on narrow previews, and their header cells head their columns.
  addTableRules(md);
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

/** The front matter of a document and the body after it, however they were split (with the error, when it has one). */
export type ParsedDocument = Pick<FrontMatter, 'data' | 'body' | 'bodyStartLine'> & Partial<Pick<FrontMatter, 'error'>>;

/**
 * renderSmd with the front matter already split off, for hosts that remove it before the
 * remark/rehype plugins run (see unified.ts). `header: false` leaves out the title/status header.
 */
export function renderParsed(text: string, fm: ParsedDocument, options: RenderOptions = {}, header = true): RenderResult {
  const parsed = parseTokens(text, fm, options);
  const { md, tokens, env, lang } = parsed;
  const body = md.renderer.render(tokens, md.options, env);
  const frame = documentFrame(parsed, header);
  const html = `${frame.open}${frame.header}${frame.toc}${body}</article>`;
  return { html, frontMatter: fm.data, headings: env.headings, lang, spec: parsed.spec };
}

/** What renderSmd puts around the body: the `<article>` opening tag, the title header and the table of contents. */
export interface DocumentFrame {
  open: string;
  header: string;
  toc: string;
}

/**
 * The frame of a parsed document, once its body is rendered (the contents come from the env). Front matter that
 * could not be read is shown as written in an error block where the header goes, `header: false` included.
 */
export function documentFrame(parsed: Omit<ParsedTokens, 'tokens'>, header = true): DocumentFrame {
  const { md, env, data, lang, messages, unread } = parsed;
  const accent = typeof data.accent === 'string' ? resolveColor(data.accent) : null;
  const style = accent ? ` style="--smd-accent:${escapeHtml(accent)}"` : '';
  const error = unread ? renderFrontMatterError(unread, messages) : '';
  return {
    open: `<article class="smd-doc"${languageAttrs(lang, messages)}${style}>`,
    header: error + (header ? renderHeader((s) => md.renderInline(s, { messages, ...specEnv(env) }), data, messages, parsed.shown) : ''),
    toc: data.toc === true ? renderToc(env.headings, messages) : '',
  };
}

/** A document parsed into the block tokens renderSmd renders, with what the rules put on the env. */
export interface ParsedTokens {
  md: MarkdownIt;
  tokens: Token[];
  env: Env;
  /** The front matter. */
  data: Record<string, unknown>;
  /** The front matter values the document shows, in `{{name}}` and the header: spelled as written in spec v2 (shownValues). */
  shown: Record<string, unknown>;
  lang: string;
  messages: Messages;
  /** The lines of front matter that could not be read, as written (see unreadFrontMatter). */
  unread?: string[];
  /** The spec version the document is read with (also on the env as `smdSpec`). */
  spec: SpecVersion;
}

/** The tokens of a whole .smd document as renderSmd parses them, for the exporters (exportTree.ts). */
export function parseSmdTokens(text: string, options: RenderOptions = {}): ParsedTokens {
  return parseTokens(text, parseFrontMatter(text), options);
}

function parseTokens(text: string, fm: ParsedDocument, options: RenderOptions): ParsedTokens {
  const opts: ResolvedOptions = {
    allowHtml: options.allowHtml ?? true,
    agentBlocks: options.agentBlocks ?? 'collapsed',
    readFile: options.readFile,
    today: options.today ?? new Date().toISOString().slice(0, 10),
  };
  const md = createMarkdownIt(opts);
  const data = fm.data;
  const lang = documentLanguage(data.lang, options.lang);
  const messages = messagesFor(lang);
  // Before parsing, so every rule reads the version from the env (see specVersion.ts).
  const spec = resolveSpec(data, options.spec);
  const shown = shownValues(data, text, spec) as Record<string, unknown>;
  const env: Env = {
    lineOffset: fm.bodyStartLine, headings: [], slugs: new Map(), options: opts, source: text, smdVariables: shown, messages, smdSpec: spec,
    smdTypography: typographyOf(data),
  };
  // markdown-it treats a lone \r as a line break, but every other tool here splits lines on \r?\n.
  // A space keeps heading lines and data-line (preview scroll sync) in step with the editor.
  const tokens = md.parse(fm.body.replace(/\r(?!\n)/g, ' '), env);
  const unread = unreadFrontMatter(text, fm);
  return { md, tokens, env, data, shown, lang, messages, spec, ...(unread ? { unread } : {}) };
}

/**
 * `lang` on the article for a document that is not in English, and the labels the page runtime shows (copy
 * buttons, diagram messages) when they are translated. English documents get neither, so they render as before.
 */
function languageAttrs(lang: string, messages: Messages): string {
  if (isEnglish(lang)) return '';
  const labels = isEnglishMessages(messages) ? '' : ` data-smd-labels="${escapeHtml(JSON.stringify(runtimeLabels(messages)))}"`;
  return ` lang="${escapeHtml(lang)}"${labels}`;
}

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

function renderToc(headings: Heading[], m: Messages): string {
  const items = headings.filter((h) => h.level >= 2 && h.level <= 3);
  if (!items.length) return '';
  const title = m['toc.title'];
  return `<nav class="smd-toc" aria-label="${escapeHtml(title)}"><div class="smd-toc-title">${title}</div><ul>${items
    .map((h) => `<li class="smd-toc-l${h.level}"><a href="#${h.slug}">${escapeHtml(h.text)}</a></li>`)
    .join('')}</ul></nav>`;
}

/**
 * Render a whole standalone HTML page (used by Export to HTML and the CLI). The front matter's `theme: light|dark`
 * picks the page's theme; without one it is `fallbackTheme` (`auto` follows the reader's system).
 */
export function renderStandaloneHtml(
  text: string, css: string, runtimeJs: string, options: RenderOptions = {}, fallbackTheme: 'auto' | 'light' | 'dark' = 'auto',
): string {
  const result = renderSmd(text, options);
  const title = typeof result.frontMatter.title === 'string' ? result.frontMatter.title : result.headings[0]?.text ?? 'Document';
  const named = String(result.frontMatter.theme).toLowerCase();
  const theme = ['light', 'dark'].includes(named) ? named : fallbackTheme;
  return pageHtml({ title, theme, body: result.html, css, runtimeJs, cdn: true, lang: result.lang });
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
  /** The page's language tag (default `en`). */
  lang?: string;
}

/** The standalone page around rendered HTML: stylesheet, theme preference and runtime inlined. */
export function pageHtml(page: PageParts): string {
  const katex = page.cdn ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">\n' : '';
  const mermaid = page.cdn ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n' : '';
  return `<!DOCTYPE html>
<html lang="${escapeHtml(page.lang ?? 'en')}" data-smd-theme-pref="${page.theme}">
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
