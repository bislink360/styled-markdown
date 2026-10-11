import {
  exportColor, exportTree, inlineText, type Block, type ExportOptions, type Inline, type ListItem, type Marks, type PanelType,
} from './exportTree';

/**
 * Notion API block objects: what `PATCH /v1/blocks/{block_id}/children` takes as `children`. The blocks keep
 * within Notion's request limits (NOTION_LIMITS): long text is split over several rich text objects, deeper
 * nesting is flattened, and notionRequests cuts the top-level blocks into request bodies. Nothing is sent
 * anywhere: the caller makes the requests.
 */

/** Notion's limits on one request, from its API reference. */
export const NOTION_LIMITS = {
  /** Characters in one rich text object's `text.content` (and link URL). */
  text: 2000,
  /** Characters in an equation's expression. */
  equation: 1000,
  /** Rich text objects in one array. */
  richText: 100,
  /** Blocks in one `children` array. */
  children: 100,
  /** Levels of nesting below the blocks of a request. */
  depth: 2,
  /** Blocks in one request, nested ones included. */
  requestBlocks: 1000,
  /** A margin under the 500 KB payload limit, in characters of JSON. */
  requestChars: 450_000,
} as const;

export interface NotionAnnotations {
  bold?: true;
  italic?: true;
  strikethrough?: true;
  underline?: true;
  code?: true;
  color?: string;
}

export type NotionRichText =
  | { type: 'text'; text: { content: string; link?: { url: string } }; annotations?: NotionAnnotations }
  | { type: 'equation'; equation: { expression: string }; annotations?: NotionAnnotations }
  | { type: 'mention'; mention: { type: 'date'; date: { start: string } } };

/** A block object: `{ object: 'block', type: 'paragraph', paragraph: { rich_text, children? } }`. */
export interface NotionBlock {
  object: 'block';
  type: string;
  [type: string]: unknown;
}

/** One `PATCH /v1/blocks/{block_id}/children` request body. */
export interface NotionRequest {
  children: NotionBlock[];
}

/** The document as Notion blocks, within the nesting and size limits; send them with notionRequests. */
export function smdToNotion(text: string, options: ExportOptions = {}): NotionBlock[] {
  const doc = exportTree(text, options);
  return fit(doc.blocks.flatMap(notionBlocks), 0);
}

/** Request bodies for `PATCH /v1/blocks/{block_id}/children`, in order: at most 100 top-level and 1000 blocks each. */
export function notionRequests(blocks: NotionBlock[]): NotionRequest[] {
  const requests: NotionRequest[] = [];
  let current: NotionBlock[] = [];
  let count = 0;
  let size = 0;
  for (const block of blocks) {
    const n = countBlocks(block);
    const chars = JSON.stringify(block).length;
    const full = current.length >= NOTION_LIMITS.children || count + n > NOTION_LIMITS.requestBlocks || size + chars > NOTION_LIMITS.requestChars;
    if (current.length && full) {
      requests.push({ children: current });
      current = [];
      count = 0;
      size = 0;
    }
    current.push(block);
    count += n;
    size += chars;
  }
  if (current.length) requests.push({ children: current });
  return requests;
}

// ---------------------------------------------------------------------------
// Rich text
// ---------------------------------------------------------------------------

/** smd named colour → Notion colour. Notion has no teal, cyan or indigo; `accent` follows the page theme, so it is dropped. */
const COLORS = new Map([
  ['red', 'red'], ['orange', 'orange'], ['amber', 'yellow'], ['yellow', 'yellow'], ['green', 'green'], ['teal', 'green'], ['cyan', 'blue'],
  ['blue', 'blue'], ['indigo', 'purple'], ['purple', 'purple'], ['pink', 'pink'], ['gray', 'gray'], ['muted', 'gray'],
]);

const notionColor = (value: string | undefined): string | undefined => COLORS.get(exportColor(value)?.named ?? '');

function annotations(marks: Marks): NotionAnnotations | undefined {
  const a: NotionAnnotations = {};
  if (marks.bold) a.bold = true;
  if (marks.italic) a.italic = true;
  if (marks.strike) a.strikethrough = true;
  if (marks.underline) a.underline = true;
  if (marks.code) a.code = true;
  const highlight = notionColor(marks.highlight);
  const color = notionColor(marks.color) ?? (highlight && `${highlight}_background`);
  if (color) a.color = color;
  return Object.keys(a).length ? a : undefined;
}

/** A link Notion takes: an absolute http(s) URL. Links within the document (`#id`) and relative ones stay plain text. */
const linkOf = (href: string | undefined) => (href && /^https?:\/\//i.test(href) && href.length <= NOTION_LIMITS.text ? { url: href } : undefined);

function textItem(content: string, marks: Marks = {}): NotionRichText {
  const link = linkOf(marks.href);
  const a = annotations(marks);
  return { type: 'text', text: link ? { content, link } : { content }, ...(a ? { annotations: a } : {}) };
}

const RICH_TEXT: { [K in Inline['kind']]: (i: Extract<Inline, { kind: K }>) => NotionRichText } = {
  text: (i) => textItem(i.text, i.marks),
  break: () => textItem('\n'),
  math: (i) => {
    if (i.tex.length > NOTION_LIMITS.equation) return textItem(i.tex, { ...i.marks, code: true });
    const a = annotations({ ...i.marks, href: undefined });
    return { type: 'equation', equation: { expression: i.tex }, ...(a ? { annotations: a } : {}) };
  },
  // A status reads as a coloured code span, the closest Notion has to a label.
  status: (i) => textItem(i.text, { code: true, color: i.color }),
  date: (i) => ({ type: 'mention', mention: { type: 'date', date: { start: i.date } } }),
  footnote: (i) => textItem(`[${i.n}]`),
  image: (i) => textItem(i.alt || i.src, { href: i.src }),
};

export function richText(inlines: Inline[]): NotionRichText[] {
  return merged(inlines.map((i) => RICH_TEXT[i.kind](i as never))).flatMap(splitLong);
}

/** Neighbouring text with the same styles and link as one object, so fewer of the 100 a block may have are used. */
function merged(items: NotionRichText[]): NotionRichText[] {
  const out: NotionRichText[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last?.type === 'text' && item.type === 'text' && sameStyle(last, item)) {
      out[out.length - 1] = { ...last, text: { ...last.text, content: last.text.content + item.text.content } };
    } else {
      out.push(item);
    }
  }
  return out;
}

const styleKey = (t: Extract<NotionRichText, { type: 'text' }>) => JSON.stringify([t.text.link?.url, t.annotations]);
const sameStyle = (a: Extract<NotionRichText, { type: 'text' }>, b: Extract<NotionRichText, { type: 'text' }>) => styleKey(a) === styleKey(b);

/** Text over 2000 characters as several objects with the same styles, never splitting a surrogate pair. */
function splitLong(item: NotionRichText): NotionRichText[] {
  if (item.type !== 'text' || item.text.content.length <= NOTION_LIMITS.text) return [item];
  return splitText(item.text.content, NOTION_LIMITS.text).map((content) => ({ ...item, text: { ...item.text, content } }));
}

export function splitText(value: string, size: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + size, value.length);
    // A code point above U+FFFF starting at end - 1 is a surrogate pair that the cut would split.
    if (end < value.length && (value.codePointAt(end - 1) ?? 0) > 0xffff) end--;
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts;
}

/** Plain text as rich text objects of at most 2000 characters. */
const plainRich = (value: string, marks: Marks = {}): NotionRichText[] => splitText(value, NOTION_LIMITS.text).map((c) => textItem(c, marks));

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function block(type: string, body: Record<string, unknown>, children: NotionBlock[] = []): NotionBlock {
  return { object: 'block', type, [type]: children.length ? { ...body, children } : body };
}

/**
 * Blocks of one type for rich text: over 100 objects continue in more blocks of the same type, the first
 * one keeping the children.
 */
function textBlocks(type: string, rich: NotionRichText[], extra: Record<string, unknown> = {}, children: NotionBlock[] = []): NotionBlock[] {
  return chunked(rich, NOTION_LIMITS.richText).map((chunk, n) => block(type, { rich_text: chunk, ...extra }, n ? [] : children));
}

/** A list in pieces of at most `size`; an empty list is one empty piece. */
function chunked<T>(list: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < list.length; at += size) chunks.push(list.slice(at, at + size));
  return chunks.length ? chunks : [[]];
}

const CALLOUTS = new Map([
  ['note', ['📝', 'gray_background']], ['info', ['ℹ️', 'blue_background']], ['tip', ['💡', 'green_background']],
  ['success', ['✅', 'green_background']], ['warning', ['⚠️', 'yellow_background']], ['danger', ['⛔', 'red_background']],
  ['question', ['❓', 'purple_background']],
]);

const PANEL_ICONS: Record<PanelType, string> = { card: '🗂️', agent: '🤖', human: '👤', decision: '⚖️', risk: '🚩', api: '🔌' };

/** Fence language → Notion code language (a fixed list; anything else is "plain text"). */
const CODE_ALIASES = new Map([
  ['ts', 'typescript'], ['tsx', 'typescript'], ['js', 'javascript'], ['jsx', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
  ['sh', 'shell'], ['zsh', 'shell'], ['console', 'shell'], ['py', 'python'], ['yml', 'yaml'], ['rb', 'ruby'], ['kt', 'kotlin'],
  ['cs', 'c#'], ['csharp', 'c#'], ['cpp', 'c++'], ['md', 'markdown'], ['ps1', 'powershell'], ['golang', 'go'], ['rs', 'rust'],
  ['dockerfile', 'docker'], ['tex', 'latex'], ['jsonc', 'json'], ['proto', 'protobuf'], ['text', 'plain text'], ['txt', 'plain text'],
]);
const CODE_LANGUAGES = new Set([
  'bash', 'c', 'c#', 'c++', 'clojure', 'css', 'dart', 'diff', 'docker', 'elixir', 'erlang', 'go', 'graphql', 'groovy', 'haskell', 'html',
  'java', 'javascript', 'json', 'julia', 'kotlin', 'latex', 'less', 'lua', 'makefile', 'markdown', 'mermaid', 'nix', 'ocaml', 'perl', 'php',
  'plain text', 'powershell', 'protobuf', 'python', 'r', 'ruby', 'rust', 'sass', 'scala', 'scss', 'shell', 'sql', 'swift', 'toml',
  'typescript', 'xml', 'yaml',
]);

function codeLanguage(lang: string): string {
  const lower = lang.toLowerCase();
  const name = CODE_ALIASES.get(lower) ?? lower;
  return CODE_LANGUAGES.has(name) ? name : 'plain text';
}

/** Code over 100 × 2000 characters continues in more code blocks; the caption is the title. Mermaid stays a mermaid block, which Notion draws. */
function code(source: string, lang: string, title?: string): NotionBlock[] {
  const caption = title ? plainRich(title) : [];
  return textBlocks('code', plainRich(source), { language: codeLanguage(lang), caption });
}

/** A list item, quote or footnote: a first paragraph is its text, the rest its children. */
function textAndChildren(blocks: Block[]): { rich: NotionRichText[]; children: NotionBlock[] } {
  const [first, ...rest] = blocks.filter((b) => b.kind !== 'anchor');
  if (first?.kind !== 'paragraph') return { rich: [], children: blocks.flatMap(notionBlocks) };
  return { rich: richText(first.content), children: rest.flatMap(notionBlocks) };
}

function listItem(ordered: boolean, item: ListItem): NotionBlock[] {
  const { rich, children } = textAndChildren(item.blocks);
  if (item.task) return textBlocks('to_do', rich, { checked: item.task.checked }, children);
  return textBlocks(ordered ? 'numbered_list_item' : 'bulleted_list_item', rich, {}, children);
}

/** A paragraph that is only an image with a URL becomes an image block; other images are their alt text. */
function paragraph(content: Inline[]): NotionBlock[] {
  const visible = content.filter((i) => !(i.kind === 'text' && !i.text.trim()));
  const only = visible.length === 1 ? visible[0] : undefined;
  if (only?.kind === 'image' && /^https?:\/\//i.test(only.src) && only.src.length <= NOTION_LIMITS.text) {
    return [block('image', { type: 'external', external: { url: only.src }, caption: only.alt ? plainRich(only.alt) : [] })];
  }
  return textBlocks('paragraph', richText(content));
}

/** A table of at most 100 rows a block (more continue in another table, under the same header row). */
function table(header: boolean, rows: Inline[][][]): NotionBlock[] {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const toRow = (cells: Inline[][]) => block('table_row', {
    cells: Array.from({ length: width }, (_, n) => cellText(cells[n] ?? [])),
  });
  const head = header ? rows[0] : undefined;
  const body = header ? rows.slice(1) : rows;
  const per = NOTION_LIMITS.children - (head ? 1 : 0);
  return chunked(body, per).map((chunk) => {
    const rowBlocks = chunk.map(toRow);
    const props = { table_width: width, has_column_header: Boolean(head), has_row_header: false };
    return block('table', props, head ? [toRow(head), ...rowBlocks] : rowBlocks);
  });
}

/** A table cell holds one rich text array: past 100 objects, its plain text instead. */
function cellText(cell: Inline[]): NotionRichText[] {
  const rich = richText(cell);
  return rich.length <= NOTION_LIMITS.richText ? rich : plainRich(inlineText(cell)).slice(0, NOTION_LIMITS.richText);
}

/** A callout: the title in bold, an emoji icon, a colour, and the content as children. */
function callout(title: string, emoji: string, color: string, blocks: Block[]): NotionBlock[] {
  return textBlocks('callout', plainRich(title, { bold: true }), { icon: { type: 'emoji', emoji }, color }, blocks.flatMap(notionBlocks));
}

function notionBlocks(b: Block): NotionBlock[] {
  switch (b.kind) {
    case 'heading':
      return textBlocks(`heading_${Math.min(b.level, 3)}`, richText(b.content));
    case 'paragraph':
      return paragraph(b.content);
    case 'list':
      return b.items.flatMap((item) => listItem(b.ordered, item));
    case 'code':
      return code(b.code, b.lang, b.title);
    case 'math':
      return b.tex.length <= NOTION_LIMITS.equation ? [block('equation', { expression: b.tex })] : code(b.tex, 'latex');
    case 'quote': {
      const { rich, children } = textAndChildren(b.blocks);
      return textBlocks('quote', rich, {}, children);
    }
    case 'callout': {
      const [emoji, color] = CALLOUTS.get(b.type) ?? ['📝', 'gray_background'];
      return callout(b.title, emoji, color, b.blocks);
    }
    case 'panel':
      return callout(b.title, PANEL_ICONS[b.type], 'default', b.blocks);
    case 'expand':
      return textBlocks('toggle', plainRich(b.title), {}, b.blocks.flatMap(notionBlocks));
    case 'rule':
      return [block('divider', {})];
    case 'table':
      return table(b.header, b.rows);
    case 'anchor':
      // Notion has no anchors of its own: links to them are plain text.
      return [];
    case 'footnotes':
      return [block('divider', {}), ...b.items.flatMap((item) => listItem(true, { blocks: item.blocks }))];
  }
}

// ---------------------------------------------------------------------------
// Nesting limits
// ---------------------------------------------------------------------------

function childrenOf(b: NotionBlock): NotionBlock[] {
  return (b[b.type] as { children?: NotionBlock[] }).children ?? [];
}

function withChildren(b: NotionBlock, children: NotionBlock[]): NotionBlock {
  const body = { ...(b[b.type] as Record<string, unknown>) };
  delete body.children;
  return block(b.type, body, children);
}

function countBlocks(b: NotionBlock): number {
  return 1 + childrenOf(b).reduce((sum, c) => sum + countBlocks(c), 0);
}

/**
 * Blocks within the nesting limits: below two levels, children follow their block instead of nesting in it
 * (a table's rows become paragraphs), and past 100 children the rest follow it.
 */
function fit(blocks: NotionBlock[], depth: number): NotionBlock[] {
  return blocks.flatMap((b) => fitBlock(b, depth));
}

function fitBlock(b: NotionBlock, depth: number): NotionBlock[] {
  const children = childrenOf(b);
  if (!children.length) return [b];
  if (depth >= NOTION_LIMITS.depth) return b.type === 'table' ? children.flatMap(rowParagraphs) : [withChildren(b, []), ...fit(children, depth)];
  const fitted = fit(children, depth + 1);
  return [withChildren(b, fitted.slice(0, NOTION_LIMITS.children)), ...fitted.slice(NOTION_LIMITS.children)];
}

/** A table row as a paragraph, its cells separated by ` | `. */
function rowParagraphs(row: NotionBlock): NotionBlock[] {
  const cells = (row.table_row as { cells: NotionRichText[][] }).cells;
  const separator = textItem(' | ');
  return textBlocks('paragraph', cells.flatMap((cell, n) => (n ? [separator, ...cell] : cell)));
}
