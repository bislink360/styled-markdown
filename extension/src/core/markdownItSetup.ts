import type MarkdownIt from 'markdown-it';
import { escapeHtml } from './attrs';
import {
  fenceRule, footnoteBackref, footnoteClose, footnoteOpen, footnoteRef, footnotesClose, footnotesOpen, renderContainer, renderHeader,
  renderMath, renderRef, type RenderRule,
} from './markdownItHtml';
import { addChangelogRules, changelogEntries } from './markdownItChangelog';
import { expandIncludes, includedLinks } from './markdownItInclude';
import {
  annotateContainers, collectVariables, containerBlock, envFigures, footnoteDefinition, footnoteReference, footnoteTail, frontMatterBlock,
  headingAttrs, headingIds, inlineDirective, inlineVariable, mark, mathBlock, mathInline, numberFigures, sourceLines, styledSpan, taskLists,
  variablesAsText,
} from './markdownItRules';
import { glossaryTerms } from './markdownItGlossary';
import { documentLanguage, languageTag, messagesFor, type Messages } from './i18n';
import type { MarkdownItSmdOptions } from './markdownIt';

/** Registers the .smd rules on a markdown-it instance, for renderSmd and for markdown-it hosts. */

/** Options read while rendering. */
export interface SmdRenderOptions {
  agentBlocks?: 'collapsed' | 'expanded' | 'hidden';
  today?: string;
  readFile?: (relativePath: string, env?: unknown) => string | undefined;
}

/** What the rules read at render time; renderSmd and markdown-it hosts fill it differently. */
export interface SmdContext {
  /** The options for one render. */
  options(env: unknown): SmdRenderOptions;
  /** Inline Markdown in container titles. */
  title(text: string, env: unknown): string;
  /** The computed grid of `:::risk-matrix` for a document's source, labelled with `messages`; left out when absent. */
  riskMatrix?: (source: string, messages: Messages) => string;
  /** The `data-line` attributes are the plugin's own (sourceLines), so code frames may move them. */
  ownLines: boolean;
  /** Front matter variables are on: `{{name}}` in directive content is replaced too. */
  variables?: boolean;
  /** The labels for one render, in the document's language. */
  messages(env: unknown): Messages;
}

/** The syntax to add, all resolved. */
export type SmdFeatures = Required<Pick<MarkdownItSmdOptions,
  'containers' | 'directives' | 'attributes' | 'mark' | 'math' | 'footnotes' | 'tasks' | 'fences' | 'codeFrames' | 'headingIds' | 'sourceLines' |
  'frontMatter' | 'glossary' | 'variables'>>;

export function smdFeatures(options: MarkdownItSmdOptions): SmdFeatures {
  return {
    containers: options.containers ?? true,
    directives: options.directives ?? true,
    attributes: options.attributes ?? true,
    mark: options.mark ?? true,
    math: options.math ?? true,
    footnotes: options.footnotes ?? true,
    tasks: options.tasks ?? true,
    fences: options.fences ?? true,
    codeFrames: options.codeFrames ?? false,
    headingIds: options.headingIds ?? false,
    sourceLines: options.sourceLines ?? false,
    frontMatter: options.frontMatter ?? false,
    glossary: options.glossary ?? true,
    variables: options.variables ?? true,
  };
}

/** Context for a host: the plugin's options, and titles rendered by the host's own instance. */
export function hostContext(md: MarkdownIt, options: MarkdownItSmdOptions): SmdContext {
  const render: SmdRenderOptions = { agentBlocks: options.agentBlocks ?? 'collapsed', today: options.today, readFile: options.readFile };
  return {
    options: () => render,
    title: (text, env) => md.renderInline(text, env as object | undefined),
    ownLines: options.sourceLines ?? false,
    variables: options.variables ?? true,
    messages: (env) => messagesFor(hostLanguage(env, options.lang)),
  };
}

/** What a host's render env may say about the language: `lang`, and the front matter's (see addFrontMatter). */
interface LanguageEnv {
  lang?: unknown;
  smdLang?: unknown;
}

/** A host render's language: the document's front matter `lang`, else `env.lang`, else the plugin's `lang` option. */
function hostLanguage(env: unknown, fallback: string | undefined): string {
  const e = (env && typeof env === 'object' ? env : {}) as LanguageEnv;
  return documentLanguage(e.smdLang, languageTag(e.lang) ?? fallback);
}

const ALT = { alt: ['paragraph', 'reference', 'blockquote', 'list'] };
const applied = new WeakSet<MarkdownIt>();

/** Register the rules for `features` on `md`. Rule order matches renderSmd's, whatever is left out. */
export function applySmd(md: MarkdownIt, features: SmdFeatures, ctx: SmdContext): void {
  if (applied.has(md)) return;
  applied.add(md);
  if (features.frontMatter) addFrontMatter(md, ctx);
  if (features.containers) addContainers(md, ctx);
  if (features.math) addMath(md);
  if (features.footnotes) addFootnotes(md, ctx);
  addInline(md, features, ctx);
  // After linkify and the typographer, so URLs are links by then; before source lines.
  if (features.containers && features.glossary) md.core.ruler.push('smd_glossary', glossaryTerms);
  addCorePasses(md, features);
  if (features.fences) {
    const previous: RenderRule = md.renderer.rules.fence ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
    md.renderer.rules.fence = fenceRule(previous, ctx, features.codeFrames);
  }
}

function addFrontMatter(md: MarkdownIt, ctx: SmdContext): void {
  md.block.ruler.before('table', 'smd_front_matter', frontMatterBlock);
  // The front matter's `lang` goes on the env before inline parsing, so every label of the render follows it.
  md.core.ruler.after('block', 'smd_front_matter_lang', (state) => {
    const data = state.tokens.find((t) => t.type === 'smd_front_matter')?.meta as Record<string, unknown> | undefined;
    if (data?.lang !== undefined && state.env && typeof state.env === 'object') (state.env as LanguageEnv).smdLang = data.lang;
  });
  // Front matter values are shown as written: `{{name}}` in the title is not replaced.
  md.renderer.rules.smd_front_matter = (tokens, idx, _opts, env) => {
    const header = renderHeader((s) => md.renderInline(s, { ...(env as object), smdVariables: {} }), tokens[idx].meta as Record<string, unknown>, ctx.messages(env));
    return `${header}\n`;
  };
}

function addContainers(md: MarkdownIt, ctx: SmdContext): void {
  md.block.ruler.before('fence', 'smd_container', containerBlock, ALT);
  md.renderer.rules.container_smd_open = (tokens, idx, _opts, env) => renderContainer(tokens, idx, env, ctx, md);
  md.renderer.rules.container_smd_close = (tokens, idx, _opts, env) => renderContainer(tokens, idx, env, ctx, md);
  md.core.ruler.after('block', 'smd_container_meta', annotateContainers);
  // :::include splices in the included blocks before inline parsing; their links are rebased at the end.
  md.core.ruler.after('smd_container_meta', 'smd_include', (state) => expandIncludes(state, ctx));
  md.core.ruler.push('smd_include_links', includedLinks);
  // Figures are numbered once included blocks are in place, so their figures count too.
  md.core.ruler.after('smd_include', 'smd_figures', numberFigures);
  // After inline parsing and the heading passes, so entry headings keep the ids and outline entries they have anywhere.
  md.core.ruler.push('smd_changelog', changelogEntries);
  addChangelogRules(md.renderer.rules);
}

function addMath(md: MarkdownIt): void {
  md.block.ruler.before('fence', 'smd_math_block', mathBlock, ALT);
  md.renderer.rules.smd_math_block = (tokens, idx) =>
    `<div class="smd-math-block" data-line="${tokens[idx].attrGet('data-line') ?? ''}">${renderMath(tokens[idx].content, true)}</div>\n`;
  md.renderer.rules.smd_math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
}

/** GFM footnotes, unless markdown-it-footnote already handles them on this instance. */
function addFootnotes(md: MarkdownIt, ctx: SmdContext): void {
  if (md.renderer.rules.footnote_ref) return;
  md.block.ruler.before('reference', 'smd_footnote_def', footnoteDefinition, { alt: ['paragraph', 'reference'] });
  // After links, so `[^1](url)` stays a link.
  md.inline.ruler.after('image', 'smd_footnote_ref', footnoteReference);
  // Added before the passes in addCorePasses, so it runs after them.
  md.core.ruler.after('inline', 'smd_footnote_tail', footnoteTail);
  md.renderer.rules.smd_footnote_ref = footnoteRef;
  md.renderer.rules.smd_footnote_backref = footnoteBackref(ctx.messages);
  md.renderer.rules.smd_footnotes_open = footnotesOpen(ctx.messages);
  md.renderer.rules.smd_footnotes_close = footnotesClose;
  md.renderer.rules.smd_footnote_open = footnoteOpen;
  md.renderer.rules.smd_footnote_close = footnoteClose;
}

function addInline(md: MarkdownIt, features: SmdFeatures, ctx: SmdContext): void {
  if (features.attributes) md.inline.ruler.before('link', 'smd_span', styledSpan);
  if (features.directives) addDirectives(md, ctx);
  if (features.mark) md.inline.ruler.before('emphasis', 'smd_mark', mark);
  if (features.math) md.inline.ruler.after('escape', 'smd_math_inline', mathInline);
  if (features.variables) addVariables(md);
}

function addVariables(md: MarkdownIt): void {
  md.core.ruler.before('inline', 'smd_variables', collectVariables);
  md.inline.ruler.before('emphasis', 'smd_variable', inlineVariable);
  md.renderer.rules.smd_variable = (tokens, idx) => escapeHtml(tokens[idx].content);
}

function addDirectives(md: MarkdownIt, ctx: SmdContext): void {
  md.inline.ruler.before('emphasis', 'smd_directive', (state, silent) => inlineDirective(state, silent, ctx));
  md.renderer.rules.smd_ref = (tokens, idx, _opts, env) => {
    const id = (tokens[idx].meta as { id: string }).id;
    return renderRef(id, envFigures(env).get(id), ctx.messages(env));
  };
}

function addCorePasses(md: MarkdownIt, features: SmdFeatures): void {
  // Each goes right after 'inline', so the last added runs first: heading attributes, heading ids, tasks, then
  // variables become text.
  if (features.variables) md.core.ruler.after('inline', 'smd_variable_text', variablesAsText);
  if (features.tasks) md.core.ruler.after('inline', 'smd_tasks', taskLists);
  if (features.headingIds) md.core.ruler.after('inline', 'smd_headings', headingIds);
  if (features.attributes) md.core.ruler.after('inline', 'smd_heading_attrs', headingAttrs);
  if (features.sourceLines) md.core.ruler.push('smd_lines', sourceLines);
}
