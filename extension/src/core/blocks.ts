import type { Token } from 'markdown-it';
import { CONTAINER_CLOSE } from './containers';
import { numberedInlineTokens, SPAN, type RenderedInline } from './inlineEdit';
import type { ContainerMeta, DirectiveMeta, SpanMeta } from './markdownItRules';
import { documentFrame, parseSmdTokens, type Heading, type ParsedTokens, type RenderOptions } from './render';
import type { SpecVersion } from './specVersion';

/**
 * The block editor's view of a document: its lines cut into front matter, blocks and the gaps between them, and
 * each top-level block rendered on its own from one parse. Segments always cover every line once, in order, so the
 * editor can hand a block's own lines to the user and leave all others alone. Browser-safe; not part of the npm API.
 */

export type SegmentKind = 'frontmatter' | 'block' | 'gap';

export interface Segment {
  kind: SegmentKind;
  /** Zero-based document line (front matter included), inclusive. */
  start: number;
  /** Exclusive. */
  end: number;
  /**
   * For a block: 'paragraph', 'heading', 'fence', 'code' (indented), 'table', 'list', 'blockquote', 'math', 'html',
   * 'hr' or 'container' (or another markdown-it block type without `_open`).
   */
  type?: string;
  /** The container's name, when type is 'container'. */
  container?: string;
  /**
   * A container's body: the lines between its opening line and its closing `:::` (to the end of the container when
   * it is not closed). Its children cover exactly these lines.
   */
  bodyStart?: number;
  bodyEnd?: number;
  /** A container's blocks and gaps. */
  children?: Segment[];
  /** Stable across re-parses: a hash of the segment's kind and text, and which occurrence of that hash it is. */
  key: string;
}

export interface RenderedBlock {
  key: string;
  start: number;
  end: number;
  html: string;
  /** With `inlineIndex`: the block's inline directives and styled spans, by their `data-smd-inline` number. */
  inline?: RenderedInline[];
}

/** renderBlocks' options: renderSmd's, and what only the Block Editor asks for. */
export interface BlockRenderOptions extends RenderOptions {
  /**
   * Number each inline directive and styled span of a block, in order from 0, as `data-smd-inline="n"` (on the span,
   * or on a `<span>` around the directive), and list them in RenderedBlock.inline: the Block Editor finds them in the
   * source in the same order (scanInline). Off by default, so the HTML is renderSmd's.
   */
  inlineIndex?: boolean;
}

/** A document rendered block by block: the parts of renderSmd's HTML, and what renderSmd returns besides. */
export interface BlockRender {
  segments: Segment[];
  /** One per top-level 'block' segment, in order. */
  blocks: RenderedBlock[];
  /** The `<article …>` opening tag. */
  open: string;
  /** The title header made from the front matter (empty without one). */
  header: string;
  /** The table of contents (`toc: true`). */
  toc: string;
  /** HTML that belongs to no line, after the last block: the footnotes. */
  tail: string;
  frontMatter: Record<string, unknown>;
  headings: Heading[];
  lang: string;
}

const LINE_BREAK = /\r?\n/;
/** Blank as markdown-it sees it: a lone `\r` is a space to the renderer (see parseSmdTokens). */
const BLANK = /^[ \t\r]*$/;
const CONTAINER = 'container';
const LIST = 'list';
const BLOCK: SegmentKind = 'block';
const GAP: SegmentKind = 'gap';

const BLOCK_TYPES: Readonly<Record<string, string>> = {
  paragraph_open: 'paragraph',
  heading_open: 'heading',
  fence: 'fence',
  code_block: 'code',
  table_open: 'table',
  bullet_list_open: LIST,
  ordered_list_open: LIST,
  blockquote_open: 'blockquote',
  smd_math_block: 'math',
  html_block: 'html',
  hr: 'hr',
  container_smd_open: CONTAINER,
};
/** Block types whose token map runs on over the blank lines after them. */
const TRIMMED = new Set([LIST, 'blockquote']);

const blockType = (t: Token) => BLOCK_TYPES[t.type] ?? t.type.replace(/_open$/, '');

/** The document's lines, where markdown-it's line 0 is in them, and the spec version the document is read with. */
interface Source {
  lines: string[];
  offset: number;
  spec: SpecVersion;
}

/**
 * Whether a container group ends on the line at `end`, its closing fence. Spec v1: when that line is a closing fence.
 * Spec v2: when the container has a closing fence of its own (the close token's line, see containerBlock); one closed
 * with a container around it ends before that one's fence.
 */
function closedOn(group: readonly Token[], src: Source, end: number): boolean {
  if (src.spec === 1) return CONTAINER_CLOSE.test(src.lines[end]);
  const close = group.at(-1);
  return close?.type === 'container_smd_close' && close.map?.[0] === end - src.offset;
}

/** Segments of a range of lines, and for each token group the index of the segment it is in (-1 for none). */
interface Layout {
  segments: Segment[];
  owner: number[];
}

/** Split tokens of one nesting level into groups: a block token, or an opening token up to its closing token. */
function groupTokens(tokens: readonly Token[]): Token[][] {
  const groups: Token[][] = [];
  let depth = 0;
  for (const t of tokens) {
    if (depth === 0) groups.push([]);
    groups.at(-1)!.push(t);
    depth = Math.max(0, depth + t.nesting);
  }
  return groups;
}

/**
 * Inside a container, groups without a source line (the list a :::changelog wraps its entries in) only wrap
 * blocks that have one: those blocks take their place.
 */
function unwrapUnmapped(groups: Token[][]): Token[][] {
  return groups.flatMap((g) => (g[0].map || g.length < 2 ? [g] : unwrapUnmapped(groupTokens(g.slice(1, -1)))));
}

/** The document lines of a group, normalized: closed containers take their closing line, lists and quotes lose trailing blank lines. */
function blockRange(group: readonly Token[], src: Source, to: number): { start: number; end: number; body: number } | null {
  const map = group[0].map;
  if (!map) return null;
  const start = map[0] + src.offset;
  const body = Math.min(map[1] + src.offset, to);
  let end = body;
  const type = blockType(group[0]);
  if (type === CONTAINER && end < to && closedOn(group, src, end)) end++;
  if (TRIMMED.has(type)) {
    while (end > start + 1 && BLANK.test(src.lines[end - 1])) end--;
  }
  return { start, end, body };
}

/** Lay groups out over lines [from, to): blocks where they have lines, gaps between. */
function layout(groups: readonly Token[][], src: Source, from: number, to: number): Layout {
  const segments: Segment[] = [];
  const owner: number[] = [];
  let at = from;
  for (const group of groups) {
    const range = blockRange(group, src, to);
    const start = Math.max(range?.start ?? to, from);
    const last = segments.length - 1;
    if (!range) {
      // No source line at all (the footnotes): it belongs to no block.
      owner.push(-1);
    } else if (range.end <= start) {
      // No line inside [from, to) (blocks an :::include put in): it goes with the block before it.
      owner.push(segments[last]?.kind === BLOCK ? last : -1);
    } else if (start < at) {
      // Lines shared with the block before: one block.
      segments[last].end = Math.max(segments[last].end, range.end);
      at = segments[last].end;
      owner.push(last);
    } else {
      if (start > at) segments.push(segment(GAP, at, start));
      segments.push(blockSegment(group, src, start, range.end, Math.max(range.body, start + 1)));
      at = range.end;
      owner.push(segments.length - 1);
    }
  }
  if (at < to) segments.push(segment(GAP, at, to));
  return { segments, owner };
}

const segment = (kind: SegmentKind, start: number, end: number): Segment => ({ kind, start, end, key: '' });

function blockSegment(group: readonly Token[], src: Source, start: number, end: number, bodyEnd: number): Segment {
  const first = group[0];
  const seg: Segment = { ...segment(BLOCK, start, end), type: blockType(first) };
  if (seg.type !== CONTAINER) return seg;
  seg.container = (first.meta as ContainerMeta | null)?.name;
  seg.bodyStart = start + 1;
  seg.bodyEnd = Math.min(bodyEnd, end);
  const inner = group.at(-1)?.type === 'container_smd_close' ? group.slice(1, -1) : group.slice(1);
  seg.children = layout(unwrapUnmapped(groupTokens(inner)), src, seg.bodyStart, seg.bodyEnd).segments;
  return seg;
}

/** 32-bit FNV-1a of a string, in base 36. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Give every segment, in document order, its content hash and occurrence number (as stableKeys in media/runtime.js). */
function assignKeys(segments: readonly Segment[], lines: readonly string[], seen = new Map<string, number>()): void {
  for (const seg of segments) {
    const sig = hash(`${seg.kind}\u0000${seg.type ?? ''}\u0000${lines.slice(seg.start, seg.end).join('\n')}`);
    const n = seen.get(sig) ?? 0;
    seen.set(sig, n + 1);
    seg.key = `${sig}#${n}`;
    if (seg.children) assignKeys(seg.children, lines, seen);
  }
}

/** The segments of a parsed document, with the top-level token groups and the segment each belongs to. */
function segmentParsed(text: string, parsed: ParsedTokens): Layout & { groups: Token[][] } {
  const lines = text.split(LINE_BREAK);
  const src: Source = { lines, offset: parsed.env.lineOffset, spec: parsed.spec };
  const groups = groupTokens(parsed.tokens);
  const body = layout(groups, src, src.offset, lines.length);
  const segments = src.offset > 0 ? [segment('frontmatter', 0, src.offset), ...body.segments] : body.segments;
  const shift = segments.length - body.segments.length;
  assignKeys(segments, lines);
  return { segments, groups, owner: body.owner.map((o) => (o < 0 ? o : o + shift)) };
}

/**
 * Cut a document into segments: front matter, top-level blocks as renderSmd parses them (containers with their
 * children), and gaps for the lines between (blank lines, link reference and footnote definitions). The segments
 * cover every line of `text.split(/\r?\n/)` once, in order; a container's children cover its body the same way.
 */
export function segmentSmd(text: string, options: RenderOptions = {}): Segment[] {
  return segmentParsed(text, parseSmdTokens(text, options)).segments;
}

/**
 * Render a document block by block, from one parse with every rule renderSmd runs. `open`, `header`, `toc`, the
 * blocks' HTML in order and `tail`, then `</article>`, make exactly renderSmd's HTML (see blocksHtml).
 */
export function renderBlocks(text: string, options: BlockRenderOptions = {}): BlockRender {
  const parsed = parseSmdTokens(text, options);
  const { segments, groups, owner } = segmentParsed(text, parsed);
  const { md, env } = parsed;
  const html = segments.map(() => '');
  const inline = options.inlineIndex ? numberInline(groups, owner, segments.length) : undefined;
  let pending = '';
  groups.forEach((group, i) => {
    const out = pending + md.renderer.render(group, md.options, env);
    if (owner[i] < 0) {
      pending = out;
    } else {
      html[owner[i]] += out;
      pending = '';
    }
  });
  const blocks = segments.flatMap((s, i): RenderedBlock[] => {
    if (s.kind !== BLOCK) return [];
    const block: RenderedBlock = { key: s.key, start: s.start, end: s.end, html: html[i] };
    if (inline) block.inline = inline[i];
    return [block];
  });
  const frame = documentFrame(parsed);
  return { segments, blocks, ...frame, tail: pending, frontMatter: parsed.data, headings: env.headings, lang: parsed.lang };
}

/**
 * Number the inline directives and styled spans of each segment's token groups in order (see inlineIndex): the
 * tokens are marked before rendering, and what each says of itself is listed per segment.
 */
function numberInline(groups: readonly Token[][], owner: readonly number[], count: number): RenderedInline[][] {
  const lists = Array.from({ length: count }, (): RenderedInline[] => []);
  groups.forEach((group, i) => {
    if (owner[i] < 0) return;
    const list = lists[owner[i]];
    for (const { token } of numberedInlineTokens(group)) {
      for (const child of token.children ?? []) markInline(child, list);
    }
  });
  return lists;
}

function markInline(token: Token, list: RenderedInline[]): void {
  const n = String(list.length);
  if (token.type === 'smd_span_open') {
    token.attrSet('data-smd-inline', n);
    list.push({ kind: 'span', name: SPAN, content: '', values: { ...(token.meta as SpanMeta).values } });
    return;
  }
  const meta = token.meta as DirectiveMeta | null;
  if (token.type !== 'html_inline' || !meta?.directive) return;
  token.content = `<span data-smd-inline="${n}">${token.content}</span>`;
  list.push({ kind: 'directive', name: meta.directive, content: meta.content, values: { ...meta.values } });
}

/** The whole document's HTML from its blocks: what renderSmd returns for the same text and options. */
export function blocksHtml(r: BlockRender): string {
  return `${r.open}${r.header}${r.toc}${r.blocks.map((b) => b.html).join('')}${r.tail}</article>`;
}
