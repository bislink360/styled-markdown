import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo } from './containers';
import { HEADING_ATTRS } from './markdownItRules';

/**
 * Changelogs: `:::changelog` blocks whose headings are release entries, written `## 1.2.0 — 2026-03-01`
 * (or Keep a Changelog's `## [1.2.0] - 2026-03-01`), newest first, each followed by its notes. The renderer
 * (markdownItChangelog.ts) works on markdown-it tokens; the validator and the agent view use the line scanner
 * here. Both split headings with `splitEntry`, so they agree on the version and the date.
 */

/** A release entry heading's text: the version (Markdown as written) and the date after it, if any. */
export interface EntryParts {
  version: string;
  /** The text after the separator, as written; it should be a YYYY-MM-DD date. */
  date?: string;
  /** Where the separator before the date starts in the text. */
  dateStart?: number;
}

/** ` — `, ` – `, ` - `, ` -- ` or ` --- ` between the version and the date. */
const SEPARATOR = /\s(?:[—–]|-{1,3})\s/gu;

/** A year-first date in final parentheses: `v1.2.0 (2026-03-01)`. Other parentheses (`(beta)`) belong to the version. */
const PAREN_DATE = /\s\((\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\)$/;

/**
 * `1.2.0 — 2026-03-01`, `[1.2.0] - 2026-03-01` and `v1.2.0 (2026-03-01)` → version and date. The date is what
 * follows the last separator (or a date in final parentheses); a heading without one is all version (`Unreleased`).
 */
export function splitEntry(text: string): EntryParts {
  const suffix = dateSuffix(text);
  const version = suffix ? text.slice(0, suffix.at).trim() : '';
  return suffix && version ? { version, date: suffix.date, dateStart: suffix.at } : { version: text.trim() };
}

/** The date at the end of some text and where its separator starts; the text before it may be empty. */
export function dateSuffix(text: string): { at: number; date: string } | undefined {
  const trimmed = text.trimEnd();
  const dash = [...trimmed.matchAll(SEPARATOR)].at(-1);
  const date = dash ? trimmed.slice(dash.index + dash[0].length).trim() : '';
  if (dash && date) return { at: dash.index, date };
  const paren = PAREN_DATE.exec(trimmed);
  return paren ? { at: paren.index, date: paren[1] } : undefined;
}

/** A YYYY-MM-DD date that exists in the calendar. */
export function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The version as plain text: `[1.2.0](…)` and `[1.2.0]` (Keep a Changelog's links) → `1.2.0`. */
export function versionLabel(version: string): string {
  const link = /^\[([^\]]+)\](?:\([^)]*\)|\[[^\]]*\])?$/.exec(version.trim());
  return link ? link[1].trim() : version.trim();
}

/** A comparable version number: `1.2.0-beta.1` → parts [1, 2, 0], pre-release ['beta', '1']. */
export interface Version {
  parts: number[];
  pre: string[];
}

/** The first version number in an entry's version text, without a leading `v`; undefined for `Unreleased`. */
export function parseVersion(text: string): Version | undefined {
  const m = /(?:^|[^\w.])v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(versionLabel(text));
  if (!m) return undefined;
  return { parts: m[1].split('.').map(Number), pre: m[2] ? m[2].split('.') : [] };
}

/** Semantic version order: numbers part by part (missing parts are 0), then a pre-release before its release. */
export function compareVersions(a: Version, b: Version): number {
  const length = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < length; i++) {
    const diff = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  return comparePre(a.pre, b.pre);
}

function comparePre(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = compareIdentifier(a[i], b[i]);
    if (diff) return diff;
  }
  return Math.sign(a.length - b.length);
}

/** Numeric identifiers compare as numbers and before alphanumeric ones, which compare as text. */
function compareIdentifier(a: string, b: string): number {
  const [x, y] = [/^\d+$/.test(a), /^\d+$/.test(b)];
  if (x && y) return Math.sign(Number(a) - Number(b));
  if (x !== y) return x ? -1 : 1;
  return a.localeCompare(b, 'en');
}

/** The key two entries of one release share: the version number (`1.2` and `v1.2.0` are one), or the text without one. */
export function versionKey(version: string): string {
  const v = parseVersion(version);
  if (!v) return versionLabel(version).toLowerCase();
  const parts = [...v.parts];
  while (parts.length > 1 && parts.at(-1) === 0) parts.pop();
  return [parts.join('.'), ...v.pre].join('-');
}

// ---------------------------------------------------------------------------
// Source scanner
// ---------------------------------------------------------------------------

/** A release entry: a heading directly inside a `:::changelog`, at the level of its first such heading. */
export interface ChangelogEntry extends EntryParts {
  /** Zero-based line of the heading. */
  line: number;
  level: number;
  /** Zero-based column where the heading text starts. */
  column: number;
}

export interface ChangelogBlock {
  /** Zero-based line of the `:::changelog` opening line. */
  line: number;
  entries: ChangelogEntry[];
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(\s{0,3}(#{1,6})\s+)(.*?)\s*#*\s*$/;

/** Every `:::changelog` from line `from` on, with its entries; nested changelogs are blocks of their own. */
export function findChangelogs(lines: string[], from = 0): ChangelogBlock[] {
  if (!lines.some((l) => /^\s{0,3}:{3,}\s*changelog\b/i.test(l))) return [];
  const scanner = new ChangelogScanner();
  for (let i = from; i < lines.length; i++) scanner.line(lines[i], i);
  return scanner.finish();
}

/** The entry headings of a document by line, for the agent view. */
export function changelogEntries(lines: string[], from = 0): Map<number, ChangelogEntry> {
  return new Map(findChangelogs(lines, from).flatMap((b) => b.entries.map((e) => [e.line, e] as const)));
}

interface OpenBlock { name: string; block?: ChangelogBlock; headings: ChangelogEntry[] }

/** Follows code fences and container nesting line by line, and collects the headings directly inside changelogs. */
class ChangelogScanner {
  private readonly blocks: ChangelogBlock[] = [];
  private readonly stack: OpenBlock[] = [];
  private fence: string | null = null;

  line(line: string, i: number): void {
    if (this.inFence(line)) return;
    const open = CONTAINER_OPEN.exec(line);
    if (open) {
      const name = parseContainerInfo(open[3] + open[4])?.name ?? '';
      this.stack.push({ name, headings: [], ...(name === 'changelog' ? { block: { line: i, entries: [] } } : {}) });
      return;
    }
    if (CONTAINER_CLOSE.test(line)) {
      const closed = this.stack.pop();
      if (closed) this.end(closed);
      return;
    }
    const top = this.stack.at(-1);
    const heading = top?.block ? HEADING.exec(line) : null;
    if (top && heading) top.headings.push(entryOf(heading, i));
  }

  finish(): ChangelogBlock[] {
    while (this.stack.length) this.end(this.stack.pop()!);
    return this.blocks.sort((a, b) => a.line - b.line);
  }

  private inFence(line: string): boolean {
    const mark = FENCE.exec(line);
    if (this.fence) {
      if (mark && mark[1][0] === this.fence[0] && mark[1].length >= this.fence.length && line.trim() === mark[1]) this.fence = null;
      return true;
    }
    if (mark) this.fence = mark[1];
    return !!mark;
  }

  /** Entries are the headings at the highest level used directly inside the block; deeper ones are their sections. */
  private end(open: OpenBlock): void {
    if (!open.block) return;
    const level = Math.min(...open.headings.map((h) => h.level));
    open.block.entries = open.headings.filter((h) => h.level === level);
    this.blocks.push(open.block);
  }
}

function entryOf(heading: RegExpExecArray, line: number): ChangelogEntry {
  const text = heading[3].replace(HEADING_ATTRS, '');
  return { ...splitEntry(text), line, level: heading[2].length, column: heading[1].length };
}
