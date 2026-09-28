import { parseFrontMatter } from './frontmatter';
import { renderSmd } from './render';

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
  /** Normalized labels of every `[label]: target` definition. */
  definitions: Set<string>;
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
  const definitions = new Set<string>();
  const add = (target: string, line: number, column: number, kind: LinkTarget['kind']) => {
    if (target.startsWith('<') && target.endsWith('>')) { target = target.slice(1, -1); column++; }
    if (target) links.push({ target, line, column, kind });
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
      definitions.add(normalizeLabel(def[2]));
      add(def[3], i, def[1].length, 'definition');
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
  add: (target: string, line: number, column: number, kind: LinkTarget['kind']) => void,
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
  const result = renderSmd(text);
  const ids = new Set(result.headings.map((h) => h.slug));
  for (const m of result.html.matchAll(/\s(?:id|name)="([^"]*)"/g)) ids.add(unescapeHtml(m[1]));
  return ids;
}

/** Files whose headings can be linked to with `file#anchor`. */
export const isDocumentPath = (path: string): boolean => /\.(?:smd|md|markdown)$/i.test(path);

function unescapeHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
