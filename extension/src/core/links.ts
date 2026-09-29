import { parseFrontMatter } from './frontmatter';
import { parseSmd } from './parse';

/** A link target found in a document. Positions are zero-based; `column` is where `target` starts. */
export interface LinkTarget {
  target: string;
  line: number;
  column: number;
  kind: 'inline' | 'definition' | 'html' | 'related';
}

/** A full or collapsed reference link, `[text][label]` or `[label][]`. */
export interface LinkReference {
  /** Normalized label (case-folded, whitespace collapsed), as used to match definitions. */
  label: string;
  line: number;
  column: number;
  endColumn: number;
}

export interface DocumentLinks {
  links: LinkTarget[];
  references: LinkReference[];
  /** Every `[label]: target` definition, by normalized label. The first definition of a label wins. */
  definitions: Map<string, LinkTarget>;
}

// `](target "title")`: the tail of an inline link or image. Angle-bracket targets may contain spaces,
// bare targets may contain balanced parentheses.
const INLINE_LINK = /\]\(\s*(<[^>\n]*>|[^\s()<]+(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const DEFINITION = /^(\s{0,3}\[([^\]\n]+)\]:\s*)(<[^>\n]*>|\S+)/;
const REFERENCE = /\[((?:[^[\]\n]|\[[^\]\n]*\])+)\]\[([^\]\n]*)\]/g;
const HTML_LINK = /<(?:a|img|source)\b[^>]*?\s(?:href|src)\s*=\s*(["'])([^"'\n]*)\1/gi;

export const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Every link target in the document: inline links and images, reference definitions, HTML href/src
 * and front matter `related:` entries. Code fences and inline code are skipped.
 */
export function findLinks(text: string): DocumentLinks {
  const lines = text.split(/\r?\n/);
  const fm = parseFrontMatter(text);
  const links: LinkTarget[] = [];
  const references: LinkReference[] = [];
  const definitions = new Map<string, LinkTarget>();
  const add = (target: string, line: number, column: number, kind: LinkTarget['kind']): LinkTarget | undefined => {
    if (target.startsWith('<') && target.endsWith('>')) { target = target.slice(1, -1); column++; }
    if (!target) return undefined;
    const link = { target, line, column, kind };
    links.push(link);
    return link;
  };

  if (fm.present && !fm.error) addRelated(fm.data.related, lines, fm.bodyStartLine, add);

  let fence: { char: string; len: number } | null = null;
  for (let i = fm.bodyStartLine; i < lines.length; i++) {
    const raw = lines[i];
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (fenceMark && fenceMark[1][0] === fence.char && fenceMark[1].length >= fence.len && !raw.slice(fenceMark[0].length).trim()) fence = null;
      continue;
    }
    if (fenceMark) { fence = { char: fenceMark[1][0], len: fenceMark[1].length }; continue; }

    // Blank out inline code so its contents are never treated as links.
    const line = raw.replace(/(`+)([\s\S]*?)\1/g, (m) => ' '.repeat(m.length));

    const def = DEFINITION.exec(line);
    if (def) {
      const link = add(def[3], i, def[1].length, 'definition');
      const label = normalizeLabel(def[2]);
      if (link && !definitions.has(label)) definitions.set(label, link);
      continue;
    }
    for (const m of line.matchAll(INLINE_LINK)) add(m[1], i, m.index! + m[0].indexOf(m[1]), 'inline');
    for (const m of line.matchAll(HTML_LINK)) add(m[2], i, m.index! + m[0].lastIndexOf(m[2]), 'html');
    for (const m of line.matchAll(REFERENCE)) {
      // `:badge[x][y]` is a directive, and `[a][b][c]` is matched from its first bracket.
      const before = line.slice(0, m.index!);
      if (/(?::[a-z][a-z0-9-]*|\])$/i.test(before)) continue;
      references.push({ label: normalizeLabel(m[2] || m[1]), line: i, column: m.index!, endColumn: m.index! + m[0].length });
    }
  }
  return { links, references, definitions };
}

function addRelated(
  related: unknown, lines: string[], end: number,
  add: (target: string, line: number, column: number, kind: LinkTarget['kind']) => unknown,
): void {
  const entries = typeof related === 'string' ? [related] : Array.isArray(related) ? related.filter((r): r is string => typeof r === 'string') : [];
  if (!entries.length) return;
  const start = lines.findIndex((l, i) => i < end && /^related\s*:/.test(l));
  if (start < 0) return;
  let from = start;
  for (const entry of entries) {
    // Entries are listed in order, either inline (`related: [a, b]`) or as a block list below the key.
    for (let i = from; i < end; i++) {
      const col = lines[i].indexOf(entry, i === start ? lines[i].indexOf(':') + 1 : 0);
      if (col >= 0) { add(entry, i, col, 'related'); from = i; break; }
    }
  }
}

/** A link target split into its path and #fragment. Returns undefined for external URLs. */
export function splitTarget(target: string): { path: string; anchor?: string } | undefined {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return undefined;
  const hash = target.indexOf('#');
  const path = decode((hash < 0 ? target : target.slice(0, hash)).split('?')[0]);
  const anchor = hash < 0 ? undefined : decode(target.slice(hash + 1));
  return { path, ...(anchor ? { anchor } : {}) };
}

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Every id a `#fragment` can point at: heading slugs, `{#id}` attributes and raw HTML ids/names. */
export function anchorIds(text: string): Set<string> {
  // The same ids the rendered HTML carries, from an incremental parse instead of a render.
  return new Set(parseSmd(text).ids);
}

/** Files whose headings can be linked to with `file#anchor`. */
export const isDocumentPath = (path: string): boolean => /\.(?:smd|md|markdown)$/i.test(path);

/**
 * The link target under a zero-based position, for go to definition. On a reference `[text][label]`,
 * `link` is its definition and `reference` is true. `start`/`end` span what the cursor is on.
 */
export function linkAt(
  text: string, line: number, character: number,
): { link: LinkTarget; start: number; end: number; reference: boolean } | undefined {
  const { links, references, definitions } = findLinks(text);
  for (const link of links) {
    if (link.line === line && character >= link.column && character <= link.column + link.target.length) {
      return { link, start: link.column, end: link.column + link.target.length, reference: false };
    }
  }
  for (const ref of references) {
    const def = definitions.get(ref.label);
    if (def && ref.line === line && character >= ref.column && character <= ref.endColumn) {
      return { link: def, start: ref.column, end: ref.endColumn, reference: true };
    }
  }
  return undefined;
}

/**
 * Zero-based line that defines an id: a heading (by slug or `{#id}`), a block with `{#id}`, or an HTML
 * element with `id`/`name`. Returns undefined when nothing in the document has that id.
 */
export function anchorLine(text: string, id: string): number | undefined {
  const heading = parseSmd(text).headings.find((h) => h.slug === id);
  if (heading) return heading.line;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attr = new RegExp(`\\{[^{}\\n]*#${escaped}(?=[\\s}])|\\s(?:id|name)\\s*=\\s*(["'])${escaped}\\1`);
  const i = text.split(/\r?\n/).findIndex((l) => attr.test(l));
  return i < 0 ? undefined : i;
}

/**
 * What is being typed at a cursor, for path and anchor completion. `target` is the partial link
 * target before the cursor and `column` where it starts. Kinds:
 * - `link`: an inline link or image `](…`, or a reference definition `[label]: …`
 * - `related`: a front matter `related:` entry (documents only)
 * - `embed`: a code fence `file="…"` (any file, no anchors)
 */
export interface LinkCompletionContext {
  kind: 'link' | 'related' | 'embed';
  target: string;
  column: number;
}

export function linkCompletionContext(text: string, line: number, character: number): LinkCompletionContext | undefined {
  const lines = text.split(/\r?\n/);
  const prefix = (lines[line] ?? '').slice(0, character);
  const at = (kind: LinkCompletionContext['kind'], target: string): LinkCompletionContext =>
    ({ kind, target, column: character - target.length });

  const fm = parseFrontMatter(text);
  if (fm.present && line > 0 && line < fm.bodyStartLine - 1) {
    const inline = /^related\s*:\s*(?:\[(?:[^\]]*,)?)?\s*["']?([^\s,"'[\]]*)$/.exec(prefix);
    if (inline) return at('related', inline[1]);
    const item = /^\s*-\s+["']?([^\s"']*)$/.exec(prefix);
    if (item) {
      // A block list item belongs to the nearest key above it.
      for (let i = line - 1; i > 0; i--) {
        const key = /^([\w-]+)\s*:/.exec(lines[i]);
        if (key) return key[1] === 'related' ? at('related', item[1]) : undefined;
      }
    }
    return undefined;
  }

  const fence = codeFenceAt(lines, line, fm.bodyStartLine);
  if (fence === 'open') {
    const embed = /\bfile\s*=\s*["']([^"']*)$/.exec(prefix);
    return embed ? at('embed', embed[1]) : undefined;
  }
  if (fence === 'inside') return undefined;
  // Inside inline code: an odd number of backtick runs before the cursor.
  if ((prefix.match(/`+/g) ?? []).length % 2 === 1) return undefined;

  const inlineLink = /\]\(\s*<?([^\s()<>]*)$/.exec(prefix);
  if (inlineLink) return at('link', inlineLink[1]);
  const definition = /^\s{0,3}\[[^\]\n]+\]:\s*<?([^\s<>]*)$/.exec(prefix);
  if (definition) return at('link', definition[1]);
  return undefined;
}

/** Whether `line` opens a code fence, is inside one, or neither. */
function codeFenceAt(lines: string[], line: number, start: number): 'open' | 'inside' | undefined {
  let fence: { char: string; len: number } | null = null;
  for (let i = start; i <= line && i < lines.length; i++) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      if (i === line) return 'inside';
      if (mark && mark[1][0] === fence.char && mark[1].length >= fence.len && !lines[i].slice(mark[0].length).trim()) fence = null;
      continue;
    }
    if (mark) {
      if (i === line) return 'open';
      fence = { char: mark[1][0], len: mark[1].length };
    }
  }
  return undefined;
}

/** Something a `#fragment` can point at, for completion: headings first, then other ids. */
export interface AnchorTarget {
  id: string;
  /** Heading text, or undefined for `{#id}` blocks and HTML ids. */
  text?: string;
  level?: number;
  line?: number;
}

export function anchorTargets(text: string): AnchorTarget[] {
  // From the incremental parse, like anchorIds: headings, then `{#id}` blocks and HTML ids/names.
  const { headings, ids } = parseSmd(text);
  const targets: AnchorTarget[] = headings.map((h) => ({ id: h.slug, text: h.text, level: h.level, line: h.line }));
  const seen = new Set(targets.map((t) => t.id));
  for (const id of ids) {
    if (id && !seen.has(id)) { seen.add(id); targets.push({ id, line: anchorLine(text, id) }); }
  }
  return targets;
}
