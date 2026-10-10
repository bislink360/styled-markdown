import MarkdownIt from 'markdown-it';
import type { StateInline, Token } from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { findAttrsEnd, parseAttrs } from './core/attrs';
import { parseFenceInfo } from './core/fence';
import { parseFrontMatter } from './core/frontmatter';
import { markdownItSmd } from './core/markdownIt';
import { INLINE_DIRECTIVES } from './core/spec';

/**
 * The renderer behind the Obsidian plugin (integrations/obsidian), bundled into its main.js. It is the markdown-it
 * plugin's rules on an instance of its own with raw HTML off, so nothing from a note reaches the page as HTML except
 * through the engine's own markup, plus what Obsidian needs around it:
 *
 * - `document(text)`: where the `:::` containers of a note are (by line), and its front matter variables.
 * - `render(source, doc)`: one range of a note's lines as HTML (the plugin sanitizes it again before showing it).
 * - `inlineSegments(text, doc)`: the inline directives and styled spans in one text node of Obsidian's own rendering.
 *
 * Math and diagrams are left as placeholders (`.smd-obsidian-math`, `.smd-diagram`) for the plugin to hand to Obsidian's
 * MathJax and Mermaid, so they look like the rest of the note. `[[wikilinks]]` become Obsidian's internal links.
 */

export type AgentBlocks = 'collapsed' | 'expanded' | 'hidden';

export interface ObsidianEngineOptions {
  /** `:::` block containers. */
  containers: boolean;
  /** Inline directives (`:badge[…]`, `:status[…]`, `:due[…]`…) and `[text]{attrs}` styled spans. */
  directives: boolean;
  /** How `:::agent` blocks are shown. */
  agentBlocks: AgentBlocks;
  /** "Today" as YYYY-MM-DD for `:due[]` states; defaults to the current date. */
  today?: string;
}

/** Lines `start` to `end` of a note, both included and zero-based. */
export interface LineRange {
  start: number;
  end: number;
}

/** What the engine knows about a whole note. */
export interface NoteModel {
  /** The note's lines. */
  lines: string[];
  /** The outermost `:::` containers, in order and not overlapping. */
  containers: LineRange[];
  /** Front matter values, for `{{name}}` variables. */
  variables: Record<string, unknown>;
  /** The note's front matter `lang`, if any. */
  lang?: string;
}

/** What a render takes from the note: its front matter variables and language. */
export type NoteContext = Pick<NoteModel, 'variables' | 'lang'>;

/** A piece of a text node: text to keep as it is, or the engine's HTML for an inline directive. */
export type Segment = { text: string; html?: undefined } | { html: string; text?: undefined };

const MATH_FENCES = new Set(['math', 'latex', 'katex']);
const MATH_CLASS = 'smd-obsidian-math';
/** What may come right before an inline directive (as in the engine's own rule). */
const DIRECTIVE_BEFORE = /[\s([{>*_~"'-]/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export class ObsidianEngine {
  readonly md: MarkdownIt;
  private cached?: { text: string; model: NoteModel };

  constructor(readonly options: ObsidianEngineOptions) {
    this.md = createObsidianMarkdownIt(options);
  }

  /** The note's containers and front matter; the last note asked for is kept, as every section of a render asks again. */
  document(text: string): NoteModel {
    if (this.cached?.text === text) return this.cached.model;
    const model = noteModel(this.md, text, this.options.containers);
    this.cached = { text, model };
    return model;
  }

  /** Lines `range.start`–`range.end` of the note as HTML. */
  renderLines(doc: NoteModel, range: LineRange): string {
    return this.render(doc.lines.slice(range.start, range.end + 1).join('\n'), doc);
  }

  /** Markdown with .smd syntax as HTML, with the note's variables and language. */
  render(source: string, doc?: NoteContext): string {
    return this.md.render(source, renderEnv(doc));
  }

  /**
   * A fenced ```smd block: a document of its own, whose front matter (if any) adds to the note's variables and is not
   * shown (Obsidian shows the note's properties itself).
   */
  renderFenced(source: string, doc?: NoteContext): string {
    const fm = parseFrontMatter(source);
    const variables = { ...doc?.variables, ...fm.data };
    const lang = typeof fm.data.lang === 'string' ? fm.data.lang : doc?.lang;
    return this.md.render(fm.body, renderEnv({ variables, lang }));
  }

  /** The text split around its inline directives and styled spans, or null when it has none the engine renders. */
  inlineSegments(text: string, doc?: NoteContext): Segment[] | null {
    if (!this.options.directives) return null;
    const matches = findInlineSyntax(text);
    if (!matches.length) return null;
    const env = renderEnv(doc);
    const segments: Segment[] = [];
    let at = 0;
    let rendered = 0;
    for (const { start, end } of matches) {
      const source = text.slice(start, end);
      const html = this.md.renderInline(source, env);
      // The engine didn't take it as .smd syntax after all: leave the text alone.
      if (html === this.md.utils.escapeHtml(source)) continue;
      if (start > at) segments.push({ text: text.slice(at, start) });
      segments.push({ html });
      at = end;
      rendered++;
    }
    if (!rendered) return null;
    if (at < text.length) segments.push({ text: text.slice(at) });
    return segments;
  }
}

/** The markdown-it instance: .smd rules for Obsidian, raw HTML off. */
export function createObsidianMarkdownIt(options: ObsidianEngineOptions): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, highlight });
  // Before the .smd span rule and links, so `[[Note]]` is a wikilink and not a bracketed label.
  md.inline.ruler.before('link', 'obsidian_wikilink', wikiLink);
  md.renderer.rules.obsidian_wikilink = (tokens, idx) => wikiLinkHtml(tokens[idx]);
  markdownItSmd(md, {
    containers: options.containers,
    directives: options.directives,
    attributes: options.directives,
    // Obsidian numbers and links footnotes across the whole note; a container's own footnote list would not.
    footnotes: false,
    codeFrames: true,
    agentBlocks: options.agentBlocks,
    today: options.today,
  });
  mathPlaceholders(md);
  return md;
}

function highlight(code: string, lang: string): string {
  if (!lang || !hljs.getLanguage(lang)) return '';
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return '';
  }
}

/** `$…$`, `$$…$$` and ```` ```math ```` as placeholders with their TeX, for Obsidian's MathJax. */
function mathPlaceholders(md: MarkdownIt): void {
  const escape = md.utils.escapeHtml;
  md.renderer.rules.smd_math_inline = (tokens, idx) => {
    const tex = tokens[idx].content;
    return `<span class="${MATH_CLASS}" data-tex="${escape(tex)}">${escape(tex)}</span>`;
  };
  const block = (source: string) => {
    const tex = source.trim();
    return `<div class="smd-math-block ${MATH_CLASS}" data-tex="${escape(tex)}" data-display="true">${escape(tex)}</div>\n`;
  };
  md.renderer.rules.smd_math_block = (tokens, idx) => block(tokens[idx].content);
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    if (MATH_FENCES.has(parseFenceInfo(tokens[idx].info).lang.toLowerCase())) return block(tokens[idx].content);
    return fence ? fence(tokens, idx, opts, env, self) : self.renderToken(tokens, idx, opts);
  };
}

function renderEnv(doc?: NoteContext): Record<string, unknown> {
  return { smdVariables: doc?.variables ?? {}, smdLang: doc?.lang };
}

/** A note's lines, containers and front matter. */
export function noteModel(md: MarkdownIt, text: string, containers = true): NoteModel {
  const lines = text.split(/\r?\n/);
  const fm = parseFrontMatter(text);
  const lang = typeof fm.data.lang === 'string' ? fm.data.lang : undefined;
  return { lines, containers: containers ? containerRanges(md, lines, fm.bodyStartLine) : [], variables: fm.data, lang };
}

/**
 * The outermost `:::` containers of a note, by line, as the engine's block parser finds them (so code fences, nesting
 * and containers inside lists or quotes are as the engine sees them). The front matter lines are blanked first. A
 * container left open runs to the end of the note.
 */
export function containerRanges(md: MarkdownIt, lines: string[], bodyStartLine = 0): LineRange[] {
  const source = lines.map((line, i) => (i < bodyStartLine ? '' : line)).join('\n');
  const tokens: Token[] = [];
  md.block.parse(source, md, {}, tokens);
  const last = lines.length - 1;
  const ranges = tokens
    .filter((t) => t.type === 'container_smd_open' && t.map)
    .map((t) => ({ start: t.map![0], end: Math.min(t.map![1], last) }))
    .sort((a, b) => a.start - b.start);
  const outer: LineRange[] = [];
  for (const range of ranges) {
    const previous = outer.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else outer.push({ ...range });
  }
  return outer;
}

// ---------------------------------------------------------------------------
// Inline syntax in Obsidian's text nodes
// ---------------------------------------------------------------------------

/** Where `:name[…]{…}` directives and `[text]{attrs}` spans are in a text, as `[start, end)` ranges. */
export function findInlineSyntax(text: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < text.length) {
    const end = syntaxEnd(text, i);
    if (end > i) {
      found.push({ start: i, end });
      i = end;
    } else {
      i++;
    }
  }
  return found;
}

/** The end of the directive or span that starts at `i`, or -1. */
function syntaxEnd(text: string, i: number): number {
  const before = i > 0 ? text[i - 1] : ' ';
  if (text[i] === ':' && DIRECTIVE_BEFORE.test(before)) return directiveEnd(text, i);
  if (text[i] === '[' && before !== '!' && before !== ']' && before !== '\\') return spanEnd(text, i);
  return -1;
}

function directiveEnd(text: string, start: number): number {
  const m = /^:([a-z][a-z0-9-]*)(?=[[{])/.exec(text.slice(start, start + 40));
  if (!m || !Object.hasOwn(INLINE_DIRECTIVES, m[1])) return -1;
  let pos = start + m[0].length;
  if (text[pos] === '[') {
    const close = labelEnd(text, pos);
    if (close < 0) return -1;
    pos = close + 1;
  }
  if (text[pos] !== '{') return pos;
  const attrsEnd = attributesEnd(text, pos);
  return attrsEnd < 0 ? -1 : attrsEnd;
}

function spanEnd(text: string, start: number): number {
  const close = labelEnd(text, start);
  if (close < 0 || text[close + 1] !== '{') return -1;
  return attributesEnd(text, close + 1);
}

/** The end (exclusive) of a valid `{…}` attribute list at `open`, or -1. */
function attributesEnd(text: string, open: number): number {
  const close = findAttrsEnd(text, open);
  if (close < 0 || !parseAttrs(text.slice(open + 1, close))) return -1;
  return close + 1;
}

/** The `]` that closes the `[` at `open` (nested brackets and backslash escapes allowed), or -1. */
export function labelEnd(text: string, open: number): number {
  let depth = 0;
  let i = open + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && depth === 0) return i;
    else if (c === ']') depth--;
    i++;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// [[Wikilinks]]
// ---------------------------------------------------------------------------

export interface WikiLink {
  /** The note (and `#heading` or `^block`) linked to. */
  target: string;
  /** The text shown. */
  label: string;
  /** `![[…]]`: an embed in Obsidian; shown as a link here. */
  embed: boolean;
}

/** `[[target|label]]` or `![[target]]` at the current position. */
function wikiLink(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const embed = state.src.charCodeAt(start) === 0x21; /* ! */
  const open = embed ? start + 1 : start;
  if (!state.src.startsWith('[[', open)) return false;
  const close = state.src.indexOf(']]', open + 2);
  if (close < 0 || close + 2 > state.posMax) return false;
  const link = parseWikiLink(state.src.slice(open + 2, close), embed);
  if (!link) return false;
  if (!silent) state.push('obsidian_wikilink', 'a', 0).meta = link;
  state.pos = close + 2;
  return true;
}

/** The parts of a wikilink's inside (`Note#Heading|Label`), or null when it isn't one. */
export function parseWikiLink(inner: string, embed = false): WikiLink | null {
  if (/[[\]\n]/.test(inner)) return null;
  const bar = inner.indexOf('|');
  const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  if (!target) return null;
  const label = bar < 0 ? '' : inner.slice(bar + 1).trim();
  return { target, label: label || target, embed };
}

/** Obsidian's own markup for an internal link, which its reading view opens and previews on hover. */
export function wikiLinkHtml(token: Pick<Token, 'meta'>): string {
  const { target, label, embed } = token.meta as WikiLink;
  const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const href = URL_SCHEME.test(target) ? '' : ` href="${escape(target)}"`;
  const cls = embed ? 'internal-link smd-obsidian-embed' : 'internal-link';
  return `<a class="${cls}" data-href="${escape(target)}"${href} target="_blank" rel="noopener nofollow">${escape(label)}</a>`;
}
