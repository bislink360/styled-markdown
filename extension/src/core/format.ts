import { findAttrsEnd } from './attrs';
import { CONTAINER_CLOSE, CONTAINER_OPEN } from './containers';
import { parseFrontMatter } from './frontmatter';
import { HEADING_ATTRS } from './render';
import { CONTAINERS, INLINE_DIRECTIVES, STYLE_KEYS } from './spec';

/**
 * Canonical formatting for .smd documents. It only changes layout, never meaning:
 *
 * - container fences: `:::name` without a space; colons by nesting, so the innermost
 *   container uses `:::` and each enclosing one adds a colon (`::::tabs` around `:::tab`);
 *   closing fences match their opener
 * - attribute lists `{…}`: `#id`, `.classes`, then keys in the spec's order; values quoted
 *   only when they need it, duplicate keys collapsed to the value that wins
 * - pipe tables: aligned columns and delimiter rows
 * - blank lines: one around containers, code fences, math, headings and tables where they
 *   touch paragraph text; runs of blank lines collapsed; one final newline
 *
 * Code, math, raw HTML, front matter and indented lines are left untouched. If containers
 * are unbalanced, fence colons are left as written.
 */
export function formatSmd(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const fm = parseFrontMatter(text);
  const bodyStart = fm.present && !(fm.error && fm.bodyStartLine === 0) ? fm.bodyStartLine : 0;

  const out: Line[] = lines.slice(0, bodyStart).map((t, i) => ({ text: t, kind: i === bodyStart - 1 ? 'fmEnd' : 'raw', indent: 0 }));
  out.push(...formatBody(lines.slice(bodyStart)));
  return spaceBlocks(out).map((l) => l.text).join(eol) + (out.some((l) => l.kind !== 'blank') ? eol : '');
}

type Kind =
  | 'blank' | 'text' | 'raw' | 'heading' | 'fmEnd'
  | 'open' | 'close'
  | 'codeOpen' | 'code' | 'codeClose'
  | 'mathOpen' | 'math' | 'mathClose'
  | 'tableStart' | 'table' | 'tableEnd';

interface Line { text: string; kind: Kind; indent: number }

interface ContainerNode { open: number; close: number; children: ContainerNode[] }

/** State shared by the block readers while the body is formatted. */
interface Body {
  lines: string[];
  out: Line[];
  // Container tree, used to pick colon counts once every fence is known.
  roots: ContainerNode[];
  stack: ContainerNode[];
  balanced: boolean;
  opens: Map<number, { indent: string; name: string; rest: string }>;
  closes: Map<number, string>;
}

/**
 * Reads the block starting at line `i`. Returns the index of the last line it consumed, or
 * null when the line doesn't start that kind of block.
 */
type BlockReader = (b: Body, i: number) => number | null;

const indentOf = (s: string) => /^[ \t]*/.exec(s)![0].replace(/\t/g, '    ').length;
const push = (b: Body, text: string, kind: Kind) => b.out.push({ text, kind, indent: indentOf(text) });
const prevKind = (b: Body) => b.out[b.out.length - 1]?.kind;

function formatBody(lines: string[]): Line[] {
  const b: Body = { lines, out: [], roots: [], stack: [], balanced: true, opens: new Map(), closes: new Map() };
  for (let i = 0; i < lines.length; i++) {
    for (const read of BLOCK_READERS) {
      const last = read(b, i);
      if (last !== null) { i = last; break; }
    }
  }
  if (b.stack.length) b.balanced = false;
  applyFenceColons(b);
  return b.out;
}

/** Fenced code (the same rules as the validator): contents are never touched. */
const readCode: BlockReader = (b, i) => {
  const fenceOpen = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(b.lines[i]);
  if (!fenceOpen || (fenceOpen[2][0] === '`' && fenceOpen[3].includes('`'))) return null;
  const close = new RegExp(`^\\s{0,3}${fenceOpen[2][0] === '`' ? '`' : '~'}{${fenceOpen[2].length},}\\s*$`);
  push(b, b.lines[i].trimEnd(), 'codeOpen');
  let j = i + 1;
  for (; j < b.lines.length && !close.test(b.lines[j]); j++) push(b, b.lines[j], 'code');
  if (j < b.lines.length) push(b, b.lines[j].trimEnd(), 'codeClose');
  return j;
};

/** Display math `$$ … $$`, on one line or several. */
const readMath: BlockReader = (b, i) => {
  const raw = b.lines[i];
  const trimmed = raw.trim();
  if (!trimmed.startsWith('$$')) return null;
  const rest = trimmed.slice(2);
  if (rest.endsWith('$$') && rest.length > 2) { push(b, raw, 'text'); return i; }
  push(b, raw, 'mathOpen');
  let j = i + 1;
  for (; j < b.lines.length && !b.lines[j].trimEnd().endsWith('$$'); j++) push(b, b.lines[j], 'math');
  if (j < b.lines.length) push(b, b.lines[j], 'mathClose');
  return j;
};

/** Raw HTML blocks that start a block: kept verbatim until they end. */
const readHtml: BlockReader = (b, i) => {
  const html = /^\s{0,3}<(?:(pre|script|style|textarea)\b|(!--)|[A-Za-z/?!])/i.exec(b.lines[i]);
  if (!html || prevKind(b) === 'text') return null;
  const [, tag, comment] = html;
  let ends = (s: string) => s.trim() === '';
  if (tag) ends = (s) => new RegExp(`</${tag}>`, 'i').test(s);
  else if (comment) ends = (s) => s.includes('-->');
  let j = i;
  for (; j < b.lines.length && !ends(b.lines[j]); j++) push(b, b.lines[j], 'raw');
  // `<pre>` and comments include their closing line; other blocks end before the blank line.
  if (!tag && !comment) return j - 1;
  if (j < b.lines.length) push(b, b.lines[j], 'raw');
  return j;
};

/** Container fences; the colon counts are fixed afterwards by applyFenceColons. */
const readContainerFence: BlockReader = (b, i) => {
  const raw = b.lines[i];
  const close = CONTAINER_CLOSE.exec(raw);
  if (close) {
    const node = b.stack.pop();
    if (node) node.close = b.out.length; else b.balanced = false;
    b.closes.set(b.out.length, close[1]);
    push(b, `${close[1]}${close[2]}`, 'close');
    return i;
  }
  const open = CONTAINER_OPEN.exec(raw);
  if (!open) return null;
  const node: ContainerNode = { open: b.out.length, close: -1, children: [] };
  (b.stack[b.stack.length - 1]?.children ?? b.roots).push(node);
  b.stack.push(node);
  b.opens.set(b.out.length, { indent: open[1], name: open[3], rest: open[4] });
  push(b, raw, 'open');
  return i;
};

/** Pipe tables, only where one can start, so a new blank line can't turn text into a table. */
const readTableBlock: BlockReader = (b, i) => {
  const table = prevKind(b) === 'text' ? null : readTable(b.lines, i);
  if (!table) return null;
  const rows = formatTable(table.rows);
  rows.forEach((r, k) => {
    let kind: Kind = 'table';
    if (k === 0) kind = 'tableStart';
    else if (k === rows.length - 1) kind = 'tableEnd';
    push(b, r, kind);
  });
  return i + table.rows.length - 1;
};

/** Blank lines, indented lines, headings and paragraph text; always consumes one line. */
const readLine: BlockReader = (b, i) => {
  const raw = b.lines[i];
  if (raw.trim() === '') push(b, '', 'blank');
  // Indented lines may be code blocks: leave them exactly as written.
  else if (indentOf(raw) >= 4) push(b, raw, 'text');
  else if (/^\s{0,3}#{1,6}(\s|$)/.test(raw)) push(b, formatHeading(raw.trimEnd()), 'heading');
  else push(b, formatInline(raw), 'text');
  return i;
};

const BLOCK_READERS: BlockReader[] = [readCode, readMath, readHtml, readContainerFence, readTableBlock, readLine];

/**
 * Within each top-level container, every nesting level shares one colon count: the deepest
 * level uses three and each level above it one more. Unbalanced documents keep their colons.
 */
function applyFenceColons(b: Body): void {
  const colons = new Map<number, number>();
  const height = (n: ContainerNode): number => (n.children.length ? 1 + Math.max(...n.children.map(height)) : 0);
  const assign = (n: ContainerNode, count: number) => {
    colons.set(n.open, count);
    colons.set(n.close, count);
    n.children.forEach((c) => assign(c, count - 1));
  };
  if (b.balanced) b.roots.forEach((r) => assign(r, 3 + height(r)));

  for (const [idx, o] of b.opens) {
    const count = colons.get(idx) ?? /^\s*(:+)/.exec(b.out[idx].text)![1].length;
    b.out[idx].text = `${o.indent}${':'.repeat(count)}${o.name}${formatContainerRest(o.name, o.rest)}`;
  }
  for (const [idx, indent] of b.closes) {
    const count = colons.get(idx);
    if (count) b.out[idx].text = `${indent}${':'.repeat(count)}`;
  }
}

/** Everything after the container name: `{attrs} Title`. */
function formatContainerRest(name: string, rest: string): string {
  let attrs = '';
  if (rest.startsWith('{')) {
    const end = findAttrsEnd(rest, 0);
    if (end === -1) return rest.trimEnd();
    const formatted = formatAttrs(rest.slice(1, end), CONTAINERS[name.toLowerCase()]?.attrs ?? []);
    if (formatted === null) return rest.trimEnd();
    attrs = `{${formatted}}`;
    rest = rest.slice(end + 1);
  }
  const title = formatInline(rest.trim());
  return `${attrs}${title ? ` ${title}` : ''}`;
}

function formatHeading(raw: string): string {
  const m = HEADING_ATTRS.exec(raw);
  const head = formatInline(m ? raw.slice(0, m.index) : raw);
  if (!m) return head;
  const attrs = formatAttrs(m[1], []);
  return attrs === null ? `${head}${m[0]}` : `${head} {${attrs}}`;
}

// ---------------------------------------------------------------------------
// Attribute lists
// ---------------------------------------------------------------------------

const ATTR_TOKEN = /\s*(?:([.#])([A-Za-z0-9_-]+)|([A-Za-z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+)))?)\s*/y;
const STYLE_ORDER = Object.keys(STYLE_KEYS);

/**
 * Canonical form of the inside of `{…}`: `#id .class key=value flag`. Keys follow `order`,
 * then the style keys, then the order they were written in. Returns null when the list is
 * malformed, so the caller keeps it as written.
 */
export function formatAttrs(src: string, order: readonly string[]): string | null {
  let id: string | undefined;
  const classes: string[] = [];
  const entries = new Map<string, string | undefined>();
  let pos = 0;
  while (pos < src.length) {
    ATTR_TOKEN.lastIndex = pos;
    const m = ATTR_TOKEN.exec(src);
    if (!m || m[0].length === 0) {
      if (src.slice(pos).trim() === '') break;
      return null;
    }
    if (m[1] === '#') id = m[2];
    else if (m[1] === '.') { if (!classes.includes(m[2])) classes.push(m[2]); }
    else entries.set(m[3], m[4] ?? m[5] ?? m[6]);
    pos = ATTR_TOKEN.lastIndex;
  }
  const keys = [...entries.keys()];
  const rank = (k: string) => {
    const spec = order.indexOf(k);
    if (spec >= 0) return spec;
    const style = STYLE_ORDER.indexOf(k);
    return style >= 0 ? order.length + style : order.length + STYLE_ORDER.length + keys.indexOf(k);
  };
  keys.sort((a, b) => rank(a) - rank(b));
  return [
    ...(id ? [`#${id}`] : []),
    ...classes.map((c) => `.${c}`),
    ...keys.map((k) => {
      const v = entries.get(k);
      return v === undefined ? k : `${k}=${quote(k, v)}`;
    }),
  ].join(' ');
}

/** Keys whose values are prose, always quoted so they can grow into several words. */
const TEXT_KEYS = ['title', 'label'];

/** Keywords, numbers, dates, sizes and @owners stay bare (`status=accepted width=50%`); the rest is quoted. */
function quote(key: string, value: string): string {
  if (!TEXT_KEYS.includes(key) && /^[\w@][\w.%@-]*$/.test(value)) return value;
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

/** Normalize `[text]{…}` and `:name[…]{…}` attribute lists on one line, outside code and math. */
function formatInline(line: string): string {
  if (!line.includes('{')) return line;
  const masked = line
    .replace(/(`+)[\s\S]*?\1/g, (m) => '\0'.repeat(m.length))
    .replace(/\$[^$\s][^$]*\$/g, (m) => '\0'.repeat(m.length));
  const edits: Array<[number, number, string]> = [];
  for (let p = masked.indexOf('{'); p !== -1; p = masked.indexOf('{', p + 1)) {
    const before = masked.slice(0, p);
    const directive = /(?:^|[\s([{>*_~"'-]):([a-z][a-z0-9-]*)(?:\[[^\]\n]*\])?$/.exec(before);
    if (!directive && !before.endsWith(']')) continue;
    const end = findAttrsEnd(masked, p);
    if (end === -1) continue;
    const formatted = formatAttrs(line.slice(p + 1, end), directive ? INLINE_DIRECTIVES[directive[1]]?.attrs ?? [] : []);
    if (formatted !== null) edits.push([p, end + 1, `{${formatted}}`]);
    p = end;
  }
  let result = line;
  for (const [start, end, text] of edits.reverse()) result = result.slice(0, start) + text + result.slice(end);
  return result;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const DELIMITER_ROW = /^\s{0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A GFM pipe table starting at `start`: header, delimiter row and body rows up to a blank line. */
function readTable(lines: string[], start: number): { rows: string[] } | null {
  const header = lines[start];
  const delimiter = lines[start + 1];
  if (!header || delimiter === undefined || !/^\s{0,3}[^\s>]/.test(header) || !header.includes('|')) return null;
  if (!delimiter.includes('|') || !DELIMITER_ROW.test(delimiter)) return null;
  if (splitRow(header).length !== splitRow(delimiter).length) return null;
  const rows = [header, delimiter];
  for (let i = start + 2; i < lines.length; i++) {
    const l = lines[i];
    // Stop at anything that ends the table; plain text lines without a pipe are left alone.
    if (!l.includes('|') || /^\s{0,3}(>|#{1,6}(\s|$)|:{3,}|`{3,}|~{3,})/.test(l) || /^\s{4}/.test(l)) break;
    rows.push(l);
  }
  return { rows };
}

function splitRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !/(^|[^\\])(\\\\)*\\\|$/.test(s)) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { cell += s[i] + s[++i]; continue; }
    if (s[i] === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += s[i];
  }
  cells.push(cell.trim());
  return cells;
}

function formatTable(rows: string[]): string[] {
  // Pipes inside inline code are ambiguous between renderers: leave such tables alone.
  if (rows.some((r) => [...r.matchAll(/(`+)([\s\S]*?)\1/g)].some((m) => m[2].includes('|')))) return rows.map((r) => r.trimEnd());
  const indent = /^\s*/.exec(rows[0])![0];
  const cells = rows.map((r, i) => splitRow(i === 1 ? r : formatInline(r)));
  const aligns = cells[1].map((c) => (c.startsWith(':') ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : 'none'));
  const columns = aligns.length;
  const widths = aligns.map((_, c) => Math.max(3, ...cells.filter((_, i) => i !== 1).map((r) => textWidth(r[c] ?? ''))));

  return cells.map((row, i) => {
    const out = aligns.map((align, c) => {
      const w = widths[c];
      if (i === 1) {
        if (align === 'center') return `:${'-'.repeat(w - 2)}:`;
        if (align === 'left') return `:${'-'.repeat(w - 1)}`;
        if (align === 'right') return `${'-'.repeat(w - 1)}:`;
        return '-'.repeat(w);
      }
      const text = row[c] ?? '';
      const pad = w - textWidth(text);
      if (align === 'right') return ' '.repeat(pad) + text;
      if (align === 'center') return ' '.repeat(Math.floor(pad / 2)) + text + ' '.repeat(Math.ceil(pad / 2));
      return text + ' '.repeat(pad);
    });
    // Cells past the header's count are ignored by renderers but kept, so no text is lost.
    return `${indent}| ${[...out, ...row.slice(columns)].join(' | ')} |`;
  });
}

/** Display width in a monospace editor: wide East Asian characters and emoji take two columns. */
function textWidth(s: string): number {
  let w = 0;
  let prev = '';
  for (const ch of s) {
    // U+FE0F turns a text-style pictograph such as ⚠ into a two-column emoji.
    if (ch === '️' && /\p{Extended_Pictographic}/u.test(prev) && !/\p{Emoji_Presentation}/u.test(prev)) w += 1;
    else if (/[̀-ͯ​-‍︀-️]/.test(ch)) { /* zero width */ }
    else w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Emoji_Presentation}/u.test(ch) ? 2 : 1;
    prev = ch;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Blank lines
// ---------------------------------------------------------------------------

const BLOCK_START: Kind[] = ['open', 'codeOpen', 'mathOpen', 'heading', 'tableStart'];
const BLOCK_END: Kind[] = ['close', 'codeClose', 'mathClose', 'heading', 'tableEnd', 'fmEnd'];

/**
 * Collapse runs of blank lines and separate top-level blocks from paragraph text. Blocks
 * directly inside a container fence stay tight (`:::tab` followed by a code fence), and
 * neighboring fences are never split (`:::` then `:::column`).
 */
function spaceBlocks(lines: Line[]): Line[] {
  const out: Line[] = [];
  const blank: Line = { text: '', kind: 'blank', indent: 0 };
  const nextContent = (from: number) => lines.slice(from).find((l) => l.kind !== 'blank');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = out[out.length - 1];
    if (line.kind === 'blank') {
      const next = nextContent(i + 1);
      // Blank lines before an indented line may belong to an indented code block.
      const keep = next?.kind === 'text' && next.indent >= 4;
      if (prev && (keep || prev.kind !== 'blank') && next) out.push(blank);
      continue;
    }
    if (prev && prev.kind !== 'blank' && needsBlankBetween(prev, line)) out.push(blank);
    out.push(line);
  }
  return out;
}

function needsBlankBetween(prev: Line, line: Line): boolean {
  if (prev.kind === 'raw' || line.kind === 'raw') return false;
  if (prev.kind === 'fmEnd') return true;
  // First child of a container, and sibling containers, stay tight.
  if (prev.kind === 'open' || line.kind === 'close' || (prev.kind === 'close' && line.kind === 'open')) return false;
  if (BLOCK_START.includes(line.kind) && line.indent === 0) {
    return !(prev.kind === 'text' && prev.indent > 0); // the text may be a list item's continuation
  }
  if (BLOCK_END.includes(prev.kind) && prev.indent === 0) {
    if (prev.kind === 'tableEnd' && line.kind === 'text') return false; // would be a lazy table row
    return line.indent === 0;
  }
  return false;
}
