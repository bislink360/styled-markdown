import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo } from './containers';
import { findFootnotes } from './footnotes';
import { parseFrontMatter } from './frontmatter';
import { slugify } from './sections';

/**
 * Glossaries: `:::glossary` blocks whose list items are `**Term**: definition`, and the uses of those terms
 * in the text. The renderer (markdownItGlossary.ts) works on markdown-it tokens; the validator, the agent
 * view and the editors use the line scanner here. Both read entries with `parseEntry` and find terms with
 * `termMatcher`, so they agree on what is a term and where it is used.
 */

/** A glossary entry's term and the Markdown of its definition. */
export interface EntryText {
  term: string;
  definition: string;
}

/**
 * `**Term**: definition` or `**Term:** definition`, the start of a glossary list item. The term is bold
 * text without line breaks or surrounding spaces; the definition may be empty.
 */
export function parseEntry(text: string): EntryText | undefined {
  if (!text.startsWith('**')) return undefined;
  const close = text.indexOf('**', 2);
  if (close < 0) return undefined;
  let term = text.slice(2, close);
  let definition = text.slice(close + 2).trimStart();
  if (term.endsWith(':')) term = term.slice(0, -1);
  else if (definition.startsWith(':')) definition = definition.slice(1);
  else return undefined;
  if (!term || term !== term.trim() || term.includes('\n')) return undefined;
  return { term, definition: definition.trim() };
}

/** An abbreviation has capitals and no lower-case letters (`API`, `SLO`, `P99`); it only matches as written. */
export function isAbbreviation(term: string): boolean {
  return /\p{Lu}/u.test(term) && !/\p{Ll}/u.test(term);
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The key a term is looked up by: abbreviations as written, other terms with a lower-case first letter. */
export function termKey(term: string): string {
  return isAbbreviation(term) ? term : lowerFirst(term);
}

/** The id of a term's `<dt>`: `term-` and the term's slug. */
export function termId(term: string): string {
  return `term-${slugify(term) || 'entry'}`;
}

/** One use of a defined term in a run of text. */
export interface TermMatch<T> {
  /** UTF-16 offset in the text. */
  index: number;
  /** The text as written (its first letter may differ in case from the definition). */
  text: string;
  entry: T;
}

/** Finds the uses of a set of terms in text. */
export interface TermMatcher<T> {
  find(text: string): Array<TermMatch<T>>;
}

const escapeRegExp = (s: string) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** A term as a pattern: abbreviations exactly, other terms with either case of their first letter. */
function termPattern(term: string): string {
  const first = term.charAt(0);
  const rest = escapeRegExp(term.slice(1));
  if (isAbbreviation(term) || first.toLowerCase() === first.toUpperCase()) return escapeRegExp(term);
  return `(?:${escapeRegExp(first.toLowerCase())}|${escapeRegExp(first.toUpperCase())})${rest}`;
}

/** URLs and e-mail-like words, whose letters are never terms. */
const URLS = /(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|\bmailto:)[^\s<>]*|[^\s<>@]+@[^\s<>@]+/gi;

const blank = (m: string) => ' '.repeat(m.length);

/**
 * A matcher for the terms of `entries` (the first entry of a term wins). A use is a whole word: no letter,
 * digit or `_` on either side, no `.`, `/`, `@`, `#` or `-` just before it, and no `.`, `/`, `@` or `-`
 * followed by a letter or digit just after it (so `API.md`, `/api` and `API-first` are not uses). Longer
 * terms win over shorter ones they contain. Undefined when there are no terms.
 */
export function termMatcher<T extends { term: string }>(entries: Iterable<T>): TermMatcher<T> | undefined {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    const key = termKey(entry.term);
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  if (!byKey.size) return undefined;
  const terms = [...byKey.values()].map((e) => e.term).sort((a, b) => b.length - a.length || a.localeCompare(b));
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}_./@#-])(?:${terms.map(termPattern).join('|')})(?![\p{L}\p{N}_]|[./@-][\p{L}\p{N}])`, 'gu',
  );
  return {
    find(text) {
      const found: Array<TermMatch<T>> = [];
      for (const m of text.replaceAll(URLS, blank).matchAll(pattern)) {
        const entry = byKey.get(m[0]) ?? byKey.get(lowerFirst(m[0]));
        if (entry) found.push({ index: m.index, text: m[0], entry });
      }
      return found;
    },
  };
}

// ---------------------------------------------------------------------------
// Line scanner
// ---------------------------------------------------------------------------

/** A defined term. Positions are zero-based; the columns span the term inside `**…**`. */
export interface GlossaryEntry extends EntryText {
  /** The id of its `<dt>`; references link to it. */
  id: string;
  line: number;
  column: number;
  endColumn: number;
}

/** A list item in a glossary that is not `**Term**: definition`, or has no definition. */
export interface GlossaryProblem {
  kind: 'not-entry' | 'empty';
  line: number;
  column: number;
  endColumn: number;
}

/** A document's glossaries. */
export interface Glossary {
  /** Every entry in document order, duplicates included. */
  entries: GlossaryEntry[];
  problems: GlossaryProblem[];
  /** The lines of each `:::glossary` block, fences included: [first, last]. */
  blocks: Array<[number, number]>;
}

interface Item {
  line: number;
  column: number;
  text: string;
  /** Lines can still continue its first paragraph. */
  open: boolean;
}

/** The scan of one `:::glossary` block: its direct list, item by item. */
interface BlockScan {
  start: number;
  items: Item[];
  /** The previous line was blank. */
  blank: boolean;
}

const ITEM = /^( {0,3})[-*+][ \t]+(\S.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Every `:::glossary` block of a document and the entries of its lists, from `from` (the first body line) on. */
export function findGlossary(lines: string[], from = 0): Glossary {
  const scanner = new GlossaryScanner();
  for (let i = from; i < lines.length; i++) scanner.line(lines[i], i);
  return scanner.finish(lines.length - 1);
}

/** Follows code fences and container nesting line by line, and scans the lines directly inside glossaries. */
class GlossaryScanner {
  readonly glossary: Glossary = { entries: [], problems: [], blocks: [] };
  /** Names of the open containers, innermost last. */
  private readonly stack: string[] = [];
  private fence: string | null = null;
  /** The outermost open glossary. */
  private scan: BlockScan | null = null;

  line(line: string, i: number): void {
    if (this.inFence(line) || this.container(line, i)) return;
    if (this.scan && this.stack.at(-1) === 'glossary') scanLine(this.scan, line, i, this.glossary);
  }

  finish(last: number): Glossary {
    if (this.scan) this.endBlock(last);
    return this.glossary;
  }

  /** Lines of code fences. A fence indented under an item is part of it; any other fence ends the list. */
  private inFence(line: string): boolean {
    const mark = FENCE.exec(line);
    if (this.fence) {
      if (mark && closesFence(line, mark[1], this.fence)) this.fence = null;
      return true;
    }
    if (!mark) return false;
    this.fence = mark[1];
    const underItem = !!this.scan?.items.length && /^\s{2,}/.test(line);
    if (this.scan && !underItem) endList(this.scan, this.glossary);
    return true;
  }

  /** Container fences: any of them ends a list; a glossary's own fences start and end it. */
  private container(line: string, i: number): boolean {
    const open = CONTAINER_OPEN.exec(line);
    const close = !open && CONTAINER_CLOSE.test(line) && this.stack.length > 0;
    if (!open && !close) return false;
    if (this.scan) endList(this.scan, this.glossary);
    if (open) {
      const name = parseContainerInfo(open[3] + open[4])?.name ?? '';
      if (!this.scan && name === 'glossary') this.scan = { start: i, items: [], blank: false };
      this.stack.push(name);
    } else {
      this.stack.pop();
      if (this.scan && !this.stack.includes('glossary')) this.endBlock(i);
    }
    return true;
  }

  private endBlock(last: number): void {
    endList(this.scan!, this.glossary);
    this.glossary.blocks.push([this.scan!.start, last]);
    this.scan = null;
  }
}

function closesFence(line: string, mark: string, fence: string): boolean {
  return mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark;
}

/** One line directly inside a glossary: a new item, a continuation of one, or the end of the list. */
function scanLine(scan: BlockScan, line: string, i: number, glossary: Glossary): void {
  const item = ITEM.exec(line);
  const current = scan.items.at(-1);
  if (item) {
    scan.items.push({ line: i, column: item[1].length + line.slice(item[1].length).indexOf(item[2]), text: item[2], open: true });
  } else if (!line.trim()) {
    if (current) current.open = false;
  } else if (current?.open && !/^\s{0,3}#{1,6}(\s|$)/.test(line)) {
    current.text += `\n${line.trim()}`;
  } else if (!(current && scan.blank && /^\s{2,}\S/.test(line))) {
    // Indented after a blank line: more of the item. Anything else ends the list.
    endList(scan, glossary);
  }
  scan.blank = !line.trim();
}

/**
 * A list becomes a definition list, and defines its terms, only when every item is an entry, as in
 * rendering; otherwise each item that is not an entry is a problem.
 */
function endList(scan: BlockScan, glossary: Glossary): void {
  const items = scan.items;
  scan.items = [];
  scan.blank = false;
  const parsed = items.map((item) => ({ item, entry: parseEntry(item.text) }));
  if (parsed.every((p) => p.entry)) {
    for (const { item, entry } of parsed) addEntry(item, entry!, glossary);
    return;
  }
  for (const { item, entry } of parsed) {
    if (!entry) glossary.problems.push({ kind: 'not-entry', line: item.line, column: item.column, endColumn: item.column + item.text.split('\n')[0].length });
  }
}

function addEntry(item: Item, entry: EntryText, glossary: Glossary): void {
  const column = item.column + 2;
  const endColumn = column + entry.term.length;
  glossary.entries.push({ ...entry, id: termId(entry.term), line: item.line, column, endColumn });
  if (!entry.definition) glossary.problems.push({ kind: 'empty', line: item.line, column: column - 2, endColumn: endColumn + 2 });
}

/** The first entry of each term (each `<dt>` id), as rendering uses them. */
export function firstEntries(entries: GlossaryEntry[]): GlossaryEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

/** A use of a defined term in the text. Positions are zero-based. */
export interface TermUse {
  entry: GlossaryEntry;
  line: number;
  column: number;
  endColumn: number;
}

/**
 * Inline syntax whose text is never a use of a term: code spans, links and images, autolinks and HTML tags,
 * attribute lists, inline directives and math. Each is blanked out, keeping columns.
 */
const MASKS = [
  /(`+)[\s\S]*?\1/g,
  /!?\[[^\]\n]*\]\([^)\n]*\)/g,
  /\[[^\]\n]*\]\[[^\]\n]*\]/g,
  /<[^>\n]*>/g,
  /\{[^{}\n]*\}/g,
  /(?:^|(?<=[\s([{>*_~"'-])):[a-z][a-z0-9-]*\[[^\]\n]*\]/g,
  /\$[^$\n]+\$/g,
];

function maskLine(line: string): string {
  return MASKS.reduce((text, mask) => text.replaceAll(mask, blank), line);
}

/** What the line scanner skips besides glossaries: code fences, display math and HTML comments. */
interface SkipState {
  fence: string | null;
  math: boolean;
  comment: boolean;
}

/** Whether a line is outside the text where terms are used; follows fences, `$$` math and `<!-- … -->`. */
function skipped(line: string, state: SkipState): boolean {
  if (state.fence) {
    const mark = FENCE.exec(line);
    if (mark && closesFence(line, mark[1], state.fence)) state.fence = null;
    return true;
  }
  if (state.comment) {
    state.comment = !line.includes('-->');
    return true;
  }
  if (state.math) {
    state.math = !line.trimEnd().endsWith('$$');
    return true;
  }
  return startsSkip(line, state);
}

function startsSkip(line: string, state: SkipState): boolean {
  const mark = FENCE.exec(line);
  if (mark) {
    state.fence = mark[1];
    return true;
  }
  const trimmed = line.trim();
  if (trimmed.startsWith('$$')) {
    state.math = !(trimmed.length > 4 && trimmed.endsWith('$$'));
    return true;
  }
  if (trimmed.startsWith('<!--')) {
    state.comment = !trimmed.includes('-->');
    return true;
  }
  // Headings (their ids stay as they are), container fences and titles.
  return /^\s{0,3}#{1,6}(\s|$)/.test(line) || CONTAINER_OPEN.test(line) || CONTAINER_CLOSE.test(line);
}

/**
 * Every use of a defined term outside glossaries, footnote definitions, code, math, comments, headings,
 * container lines, links, URLs and attribute values, from `from` (the first body line) on.
 */
export function findTermUses(lines: string[], from: number, glossary: Glossary): TermUse[] {
  const matcher = termMatcher(firstEntries(glossary.entries));
  if (!matcher) return [];
  // Footnote definitions render in the footnotes section, where terms are not marked.
  const footnotes = findFootnotes(lines.join('\n')).definitions.map((d): [number, number] => [d.line, d.endLine]);
  const blocks = [...glossary.blocks, ...footnotes];
  const notText = (i: number) => blocks.some(([start, end]) => i >= start && i <= end);
  const state: SkipState = { fence: null, math: false, comment: false };
  const uses: TermUse[] = [];
  for (let i = from; i < lines.length; i++) {
    if (notText(i) || skipped(lines[i], state)) continue;
    for (const m of matcher.find(maskLine(lines[i]))) {
      uses.push({ entry: m.entry, line: i, column: m.index, endColumn: m.index + m.text.length });
    }
  }
  return uses;
}

/** The defined term at a zero-based line and UTF-16 column (a use, or the term in its entry); undefined when there is none. */
export function termAt(text: string, line: number, column: number): TermUse | undefined {
  const lines = text.split(/\r?\n/);
  const from = parseFrontMatter(text).bodyStartLine;
  const glossary = findGlossary(lines, from);
  if (!glossary.entries.length) return undefined;
  const entry = glossary.entries.find((e) => e.line === line && column >= e.column && column <= e.endColumn);
  if (entry) return { entry, line, column: entry.column, endColumn: entry.endColumn };
  return findTermUses(lines, from, glossary).find((u) => u.line === line && column >= u.column && column <= u.endColumn);
}

/** Hover text for the defined term at a zero-based line and UTF-16 column, with the span it describes. */
export function termHover(text: string, line: number, column: number): { markdown: string; start: number; end: number } | undefined {
  const use = termAt(text, line, column);
  if (!use) return undefined;
  const { term, definition } = use.entry;
  return {
    markdown: `**${term}** — ${definition || '*(no definition)*'}\n\nGlossary, line ${use.entry.line + 1}`,
    start: use.column,
    end: use.endColumn,
  };
}
