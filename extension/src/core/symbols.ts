import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo } from './containers';
import { parseFenceInfo, sliceLines } from './fence';
import { parseFrontMatter } from './frontmatter';
import { anchorLine } from './links';
import { renderSmd, type Heading } from './render';

/** Something worth jumping to from anywhere in a workspace. */
export interface SmdSymbol {
  kind: 'heading' | 'decision' | 'risk' | 'api';
  /** What the symbol search matches: the heading text, a decision or risk title, `POST /v1/orders — Title`. */
  name: string;
  /** Short context: `H2`, `accepted · 2026-09-12`, `impact high`. */
  detail: string;
  /** Zero-based line. */
  line: number;
}

/** Headings, decisions, risks and API endpoints, in document order. */
export function documentSymbols(text: string): SmdSymbol[] {
  const symbols: SmdSymbol[] = renderSmd(text).headings.map((h) => ({
    kind: 'heading' as const, name: h.text || '(untitled)', detail: `H${h.level}`, line: h.line,
  }));
  const lines = text.split(/\r?\n/);
  let fence: { char: string; len: number } | null = null;
  for (let i = parseFrontMatter(text).bodyStartLine; i < lines.length; i++) {
    const raw = lines[i];
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (mark && mark[1][0] === fence.char && mark[1].length >= fence.len && !raw.slice(mark[0].length).trim()) fence = null;
      continue;
    }
    if (mark) { fence = { char: mark[1][0], len: mark[1].length }; continue; }
    if (CONTAINER_CLOSE.test(raw)) continue;
    const open = CONTAINER_OPEN.exec(raw);
    const info = open && parseContainerInfo(open[3] + open[4]);
    if (!info) continue;
    const v = info.attrs.values;
    if (info.name === 'decision') {
      symbols.push({ kind: 'decision', name: info.title || 'Decision', detail: [v.status, v.date].filter(Boolean).join(' · '), line: i });
    } else if (info.name === 'risk') {
      symbols.push({ kind: 'risk', name: info.title || 'Risk', detail: v.impact ? `impact ${v.impact}` : '', line: i });
    } else if (info.name === 'api') {
      const endpoint = `${(v.method ?? '').toUpperCase()} ${v.path ?? ''}`.trim();
      symbols.push({ kind: 'api', name: [endpoint, info.title].filter(Boolean).join(' — ') || 'API', detail: v.auth ? `auth ${v.auth}` : '', line: i });
    }
  }
  return symbols.sort((a, b) => a.line - b.line);
}

/** A few lines of a section, for hover previews. */
export interface Excerpt {
  /** The heading's text, or undefined when the anchor is a `{#id}` block or HTML id. */
  title?: string;
  level?: number;
  line: number;
  lines: string[];
  truncated: boolean;
}

/**
 * The start of the section an anchor points at: from the heading to the next heading of the same or a
 * higher level (or, for other ids, from the element's line), at most `maxLines` lines.
 */
export function sectionExcerpt(text: string, id: string, maxLines = 20): Excerpt | undefined {
  const lines = text.split(/\r?\n/);
  const headings = renderSmd(text).headings;
  const i = headings.findIndex((h) => h.slug === id);
  if (i >= 0) {
    const h = headings[i];
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    return excerpt(lines, h.line + 1, next ? next.line : lines.length, maxLines, h);
  }
  const line = anchorLine(text, id);
  return line === undefined ? undefined : excerpt(lines, line, lines.length, maxLines);
}

function excerpt(lines: string[], from: number, to: number, maxLines: number, heading?: Heading): Excerpt {
  let body = lines.slice(from, to);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const truncated = body.length > maxLines;
  if (truncated) body = body.slice(0, maxLines);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return { title: heading?.text, level: heading?.level, line: heading?.line ?? from, lines: body, truncated };
}

/** What a linked document is about: its title, summary and top-level sections. */
export function documentPreview(text: string, maxSections = 8): { title?: string; summary?: string; status?: string; sections: string[] } {
  const fm = parseFrontMatter(text);
  const headings = renderSmd(text).headings;
  const title = typeof fm.data.title === 'string' ? fm.data.title : headings.find((h) => h.level === 1)?.text;
  const top = Math.min(...headings.map((h) => h.level).filter((l) => l > 1), 6);
  return {
    title,
    summary: typeof fm.data.summary === 'string' ? fm.data.summary : undefined,
    status: typeof fm.data.status === 'string' ? fm.data.status : undefined,
    sections: headings.filter((h) => h.level === top).slice(0, maxSections).map((h) => h.text),
  };
}

/** The code a ```lang file="…" lines="…"``` fence embeds, for hover previews. */
export interface EmbedPreview {
  file: string;
  lang: string;
  lines?: [number, number];
  code?: string;
  truncated: boolean;
  /** Why the code can't be shown: the file is missing, outside the workspace, or the range is out of bounds. */
  problem?: string;
}

/** For a code fence opening line with `file="…"`, the embedded code (at most `maxLines` lines). */
export function embedPreview(line: string, readFile: ((path: string) => string | undefined) | undefined, maxLines = 30): EmbedPreview | undefined {
  const open = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!open) return undefined;
  const info = parseFenceInfo(open[2]);
  if (!info.file) return undefined;
  const preview: EmbedPreview = { file: info.file, lang: info.lang, lines: info.lines, truncated: false };
  const source = readFile?.(info.file);
  if (source === undefined) return { ...preview, problem: `Cannot read ${info.file} (missing, or outside the workspace).` };
  const slice = sliceLines(source, info.lines);
  if (slice.outOfRange) return { ...preview, problem: `${info.file} has fewer lines than ${info.linesRaw}.` };
  const code = slice.text.replace(/\n$/, '').split('\n');
  return { ...preview, code: code.slice(0, maxLines).join('\n'), truncated: code.length > maxLines };
}

/** Does `name` contain the characters of `query` in order (case-insensitive)? Symbol search uses it. */
export function fuzzyMatch(query: string, name: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const n = name.toLowerCase();
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length;
}
