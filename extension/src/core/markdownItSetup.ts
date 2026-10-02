import type MarkdownIt from 'markdown-it';
import {
  fenceRule, footnoteBackref, footnoteClose, footnoteOpen, footnoteRef, footnotesClose, footnotesOpen, renderContainer, renderHeader,
  renderMath, renderRef, type RenderRule,
} from './markdownItHtml';
import { expandIncludes, includedLinks } from './markdownItInclude';
import {
  annotateContainers, containerBlock, envFigures, footnoteDefinition, footnoteReference, footnoteTail, frontMatterBlock, headingAttrs,
  headingIds, inlineDirective, mark, mathBlock, mathInline, numberFigures, sourceLines, styledSpan, taskLists,
} from './markdownItRules';
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
  /** The computed grid of `:::risk-matrix` for a document's source; left out when absent. */
  riskMatrix?: (source: string) => string;
  /** The `data-line` attributes are the plugin's own (sourceLines), so code frames may move them. */
  ownLines: boolean;
}

/** The syntax to add, all resolved. */
export type SmdFeatures = Required<Pick<MarkdownItSmdOptions,
  'containers' | 'directives' | 'attributes' | 'mark' | 'math' | 'footnotes' | 'tasks' | 'fences' | 'codeFrames' | 'headingIds' | 'sourceLines' |
  'frontMatter'>>;

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
  };
}

/** Context for a host: the plugin's options, and titles rendered by the host's own instance. */
export function hostContext(md: MarkdownIt, options: MarkdownItSmdOptions): SmdContext {
  const render: SmdRenderOptions = { agentBlocks: options.agentBlocks ?? 'collapsed', today: options.today, readFile: options.readFile };
  return {
    options: () => render,
    title: (text, env) => md.renderInline(text, env as object | undefined),
    ownLines: options.sourceLines ?? false,
  };
}

const ALT = { alt: ['paragraph', 'reference', 'blockquote', 'list'] };
const applied = new WeakSet<MarkdownIt>();

/** Register the rules for `features` on `md`. Rule order matches renderSmd's, whatever is left out. */
export function applySmd(md: MarkdownIt, features: SmdFeatures, ctx: SmdContext): void {
  if (applied.has(md)) return;
  applied.add(md);
  if (features.frontMatter) addFrontMatter(md);
  if (features.containers) addContainers(md, ctx);
  if (features.math) addMath(md);
  if (features.footnotes) addFootnotes(md);
  addInline(md, features, ctx);
  addCorePasses(md, features);
  if (features.fences) {
    const previous: RenderRule = md.renderer.rules.fence ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
    md.renderer.rules.fence = fenceRule(previous, ctx, features.codeFrames);
  }
}

function addFrontMatter(md: MarkdownIt): void {
  md.block.ruler.before('table', 'smd_front_matter', frontMatterBlock);
  md.renderer.rules.smd_front_matter = (tokens, idx, _opts, env) =>
    `${renderHeader((s) => md.renderInline(s, env), tokens[idx].meta as Record<string, unknown>)}\n`;
}

function addContainers(md: MarkdownIt, ctx: SmdContext): void {
  md.block.ruler.before('fence', 'smd_container', containerBlock, ALT);
  md.renderer.rules.container_smd_open = (tokens, idx, _opts, env) => renderContainer(tokens, idx, env, ctx);
  md.renderer.rules.container_smd_close = (tokens, idx, _opts, env) => renderContainer(tokens, idx, env, ctx);
  md.core.ruler.after('block', 'smd_container_meta', annotateContainers);
  // :::include splices in the included blocks before inline parsing; their links are rebased at the end.
  md.core.ruler.after('smd_container_meta', 'smd_include', (state) => expandIncludes(state, ctx));
  md.core.ruler.push('smd_include_links', includedLinks);
  // Figures are numbered once included blocks are in place, so their figures count too.
  md.core.ruler.after('smd_include', 'smd_figures', numberFigures);
}

function addMath(md: MarkdownIt): void {
  md.block.ruler.before('fence', 'smd_math_block', mathBlock, ALT);
  md.renderer.rules.smd_math_block = (tokens, idx) =>
    `<div class="smd-math-block" data-line="${tokens[idx].attrGet('data-line') ?? ''}">${renderMath(tokens[idx].content, true)}</div>\n`;
  md.renderer.rules.smd_math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
}

/** GFM footnotes, unless markdown-it-footnote already handles them on this instance. */
function addFootnotes(md: MarkdownIt): void {
  if (md.renderer.rules.footnote_ref) return;
  md.block.ruler.before('reference', 'smd_footnote_def', footnoteDefinition, { alt: ['paragraph', 'reference'] });
  // After links, so `[^1](url)` stays a link.
  md.inline.ruler.after('image', 'smd_footnote_ref', footnoteReference);
  // Added before the passes in addCorePasses, so it runs after them.
  md.core.ruler.after('inline', 'smd_footnote_tail', footnoteTail);
  md.renderer.rules.smd_footnote_ref = footnoteRef;
  md.renderer.rules.smd_footnote_backref = footnoteBackref;
  md.renderer.rules.smd_footnotes_open = footnotesOpen;
  md.renderer.rules.smd_footnotes_close = footnotesClose;
  md.renderer.rules.smd_footnote_open = footnoteOpen;
  md.renderer.rules.smd_footnote_close = footnoteClose;
}

function addInline(md: MarkdownIt, features: SmdFeatures, ctx: SmdContext): void {
  if (features.attributes) md.inline.ruler.before('link', 'smd_span', styledSpan);
  if (features.directives) addDirectives(md, ctx);
  if (features.mark) md.inline.ruler.before('emphasis', 'smd_mark', mark);
  if (features.math) md.inline.ruler.after('escape', 'smd_math_inline', mathInline);
}

function addDirectives(md: MarkdownIt, ctx: SmdContext): void {
  md.inline.ruler.before('emphasis', 'smd_directive', (state, silent) => inlineDirective(state, silent, ctx));
  md.renderer.rules.smd_ref = (tokens, idx, _opts, env) => {
    const id = (tokens[idx].meta as { id: string }).id;
    return renderRef(id, envFigures(env).get(id));
  };
}

function addCorePasses(md: MarkdownIt, features: SmdFeatures): void {
  // Each goes right after 'inline', so the last added runs first: heading attributes, heading ids, tasks.
  if (features.tasks) md.core.ruler.after('inline', 'smd_tasks', taskLists);
  if (features.headingIds) md.core.ruler.after('inline', 'smd_headings', headingIds);
  if (features.attributes) md.core.ruler.after('inline', 'smd_heading_attrs', headingAttrs);
  if (features.sourceLines) md.core.ruler.push('smd_lines', sourceLines);
}
