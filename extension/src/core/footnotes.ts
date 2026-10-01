import { parseFrontMatter } from './frontmatter';

/**
 * Footnotes as written in the source (GFM): `[^label]` references and `[^label]: text` definitions,
 * whose indented lines (4 spaces) continue them. For validation, the agent view, hover and completion;
 * rendering is in markdownItRules.ts. Labels match case-insensitively. Code fences and inline code are
 * skipped, and `[^x](url)` and `[^x]{attrs}` are a link and a styled span, not references.
 */
export interface FootnoteDefinition {
  /** Normalized label (case-folded), as references match it. */
  label: string;
  /** The label as written. */
  raw: string;
  /** Zero-based first and last line, continuation lines included. */
  line: number;
  endLine: number;
  /** Columns of the label as written on the first line. */
  column: number;
  endColumn: number;
}

/** A `[^label]` reference; the columns span the whole `[^label]`. */
export interface FootnoteReference {
  label: string;
  raw: string;
  line: number;
  column: number;
  endColumn: number;
}

export interface DocumentFootnotes {
  /** In document order, duplicates included (the first definition of a label wins). */
  definitions: FootnoteDefinition[];
  references: FootnoteReference[];
}

// Also inside block quotes: `> [^1]: …`.
const DEFINITION = /^((?:\s{0,3}>)*\s{0,3})\[\^([^\]\s]+)\]:/;
const REFERENCE = /\[\^([^\]\s]+)\]/g;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** Labels match case-insensitively, folded as markdown-it folds link labels. */
export const normalizeFootnoteLabel = (label: string): string => label.toLowerCase().toUpperCase();

export function findFootnotes(text: string): DocumentFootnotes {
  const lines = text.split(/\r?\n/);
  const definitions: FootnoteDefinition[] = [];
  const references: FootnoteReference[] = [];
  let fence: string | null = null;
  for (let i = parseFrontMatter(text).bodyStartLine; i < lines.length; i++) {
    const mark = FENCE.exec(lines[i]);
    if (fence) {
      if (mark && closesFence(lines[i], mark[1], fence)) fence = null;
      continue;
    }
    if (mark) { fence = mark[1]; continue; }
    const line = maskCodeSpans(lines[i]);
    const def = DEFINITION.exec(line);
    if (def) {
      const column = def[1].length + 2;
      definitions.push({
        label: normalizeFootnoteLabel(def[2]), raw: def[2], line: i, endLine: definitionEnd(lines, i), column, endColumn: column + def[2].length,
      });
    }
    references.push(...referencesIn(line, i, def ? def[0].length : 0));
  }
  return { definitions, references };
}

/** References on one line (code spans masked), from column `from` on. */
function referencesIn(line: string, at: number, from: number): FootnoteReference[] {
  const found: FootnoteReference[] = [];
  REFERENCE.lastIndex = from;
  for (let m = REFERENCE.exec(line); m; m = REFERENCE.exec(line)) {
    const end = m.index + m[0].length;
    // `[^x](url)` is a link, `[^x]{…}` a styled span and `![^x]…` an image.
    if (line[end] === '(' || line[end] === '{' || line[m.index - 1] === '!') continue;
    found.push({ label: normalizeFootnoteLabel(m[1]), raw: m[1], line: at, column: m.index, endColumn: end });
  }
  return found;
}

function closesFence(line: string, mark: string, fence: string): boolean {
  return mark[0] === fence[0] && mark.length >= fence.length && !line.trim().slice(mark.length).trim();
}

/** A line that starts another block, so it ends a definition instead of continuing its text. */
const BLOCK_START = [
  /^\s{0,3}#{1,6}(\s|$)/, /^\s{0,3}>/, /^\s{0,3}(`{3,}|~{3,})/, /^\s{0,3}:{3,}/, /^\s{0,3}\$\$/, /^\s{0,3}([-*+]|1[.)])\s/, DEFINITION,
];

/**
 * The last line of the definition starting on `start`: indented lines continue it, blank lines may
 * separate its paragraphs, and an unindented line right after its text continues that text (lazily).
 */
function definitionEnd(lines: string[], start: number): number {
  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indented = /^( {4}|\t)/.test(line);
    const lazy = i === last + 1 && !BLOCK_START.some((re) => re.test(line));
    if (!indented && !lazy) break;
    last = i;
  }
  return last;
}

/** The line with inline code spans blanked out (same length), so their contents are never read as syntax. */
export function maskCodeSpans(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') { out += line[i++]; continue; }
    const run = runEnd(line, i);
    const close = closingRun(line, run, run - i);
    if (close < 0) { out += line.slice(i, run); i = run; continue; }
    out += ' '.repeat(close - i);
    i = close;
  }
  return out;
}

const runEnd = (line: string, i: number): number => {
  let j = i;
  while (line[j] === '`') j++;
  return j;
};

/** The end of the next run of exactly `length` backticks from `from`, or -1. */
function closingRun(line: string, from: number, length: number): number {
  for (let i = line.indexOf('`', from); i >= 0; i = line.indexOf('`', i)) {
    const end = runEnd(line, i);
    if (end - i === length) return end;
    i = end;
  }
  return -1;
}

/** The definition a `[^label]` under the cursor refers to, for hover and go to definition. */
export function footnoteAt(text: string, line: number, character: number): { definition: FootnoteDefinition; start: number; end: number } | undefined {
  const { definitions, references } = findFootnotes(text);
  const ref = references.find((r) => r.line === line && character >= r.column && character <= r.endColumn);
  const definition = ref && definitions.find((d) => d.label === ref.label);
  return definition && ref ? { definition, start: ref.column, end: ref.endColumn } : undefined;
}

/** A definition's text as Markdown: without the `[^label]:` marker and the continuation indent. */
export function footnoteText(text: string, definition: FootnoteDefinition): string {
  const lines = text.split(/\r?\n/).slice(definition.line, definition.endLine + 1);
  lines[0] = lines[0].slice(definition.endColumn + 2).trimStart();
  return lines.map((l, i) => (i ? l.replace(/^( {4}|\t)/, '') : l)).join('\n').trim();
}

/** The labels of a document's footnotes as first written, for completion. */
export function footnoteLabels(text: string): string[] {
  const labels = new Map<string, string>();
  for (const d of findFootnotes(text).definitions) if (!labels.has(d.label)) labels.set(d.label, d.raw);
  return [...labels.values()];
}

/** The label typed after `[^` before the cursor, or undefined when the cursor is not in one. */
export function footnoteLabelPrefix(prefix: string): string | undefined {
  const masked = maskCodeSpans(prefix);
  const open = masked.lastIndexOf('[^');
  const typed = open < 0 ? '' : masked.slice(open + 2);
  // A backtick left after masking opens inline code that the cursor is still in.
  const inCode = masked.slice(0, open).includes('`');
  return open >= 0 && !inCode && /^[^\]\s[]*$/.test(typed) ? typed : undefined;
}
