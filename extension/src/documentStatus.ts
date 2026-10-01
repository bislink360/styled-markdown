import { parseFrontMatter, STATUS_VALUES } from './core';

/**
 * The document status workflow (front matter `status`) without VS Code dependencies, so it can be
 * unit tested: what the status bar shows, the order of the status picker, and the front matter edit.
 */

// ---------------------------------------------------------------------------
// Reading the status
// ---------------------------------------------------------------------------

export type DocumentStatus =
  /** One of `STATUS_VALUES` (lowercased, as the validator compares them). */
  | { kind: 'known'; status: string }
  /** A value the spec doesn't allow, as written. */
  | { kind: 'unknown'; value: string }
  /** No front matter, no `status` key, or an empty value. */
  | { kind: 'missing' }
  /** Front matter that can't be read (unclosed or invalid YAML): the status can't be changed until it's fixed. */
  | { kind: 'error'; message: string };

export function documentStatus(text: string): DocumentStatus {
  const fm = parseFrontMatter(text);
  if (fm.error) return { kind: 'error', message: fm.error.message };
  const value = fm.data.status;
  if (value === undefined || value === null || value === '') return { kind: 'missing' };
  const status = String(value).toLowerCase();
  return STATUS_VALUES.includes(status) ? { kind: 'known', status } : { kind: 'unknown', value: String(value) };
}

/** What each status tells readers, people and agents alike (see docs/AGENTS.md). */
export const STATUS_MEANINGS: Record<string, string> = {
  draft: 'Work in progress: tentative, expect changes.',
  review: 'Ready for review: still tentative until approved.',
  approved: 'Authoritative: people and agents can rely on it.',
  deprecated: 'No longer recommended: kept as history.',
  archived: 'No longer maintained: history only.',
};

/** Codicons for the status bar and the picker. */
export const STATUS_ICONS: Record<string, string> = {
  draft: 'edit',
  review: 'eye',
  approved: 'verified',
  deprecated: 'warning',
  archived: 'archive',
};

/** The usual next step: draft → review → approved, and later deprecated → archived. */
export const NEXT_STATUS: Record<string, string> = {
  draft: 'review',
  review: 'approved',
  approved: 'deprecated',
  deprecated: 'archived',
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface StatusBarText {
  text: string;
  tooltip: string;
  /** Show the item with the warning background: the value isn't allowed or the front matter is broken. */
  warning: boolean;
}

export function statusBarText(state: DocumentStatus): StatusBarText {
  switch (state.kind) {
    case 'known':
      return { text: `$(${STATUS_ICONS[state.status]}) ${capitalize(state.status)}`, tooltip: `Document status: ${state.status} — click to change`, warning: false };
    case 'unknown':
      return {
        text: `$(warning) ${state.value}`,
        tooltip: `Document status "${state.value}" is not one of ${STATUS_VALUES.join(', ')} — click to change`,
        warning: true,
      };
    case 'missing':
      return { text: '$(circle-large-outline) No status', tooltip: 'This document has no status — click to set one', warning: false };
    default:
      return { text: '$(error) Status', tooltip: `${state.message} Fix the front matter to change the status.`, warning: true };
  }
}

export interface StatusChoice {
  status: string;
  current: boolean;
  next: boolean;
}

/** Every status for the picker: the next step first, then the others in spec order. */
export function statusChoices(current: string | undefined): StatusChoice[] {
  const next = nextStatus(current);
  const ordered = next ? [next, ...STATUS_VALUES.filter((s) => s !== next)] : [...STATUS_VALUES];
  return ordered.map((status) => ({ status, current: status === current, next: status === next }));
}

/** The suggested next status: `draft` for a document without a (valid) status, none after `archived`. */
export function nextStatus(current: string | undefined): string | undefined {
  if (!current || !STATUS_VALUES.includes(current)) return 'draft';
  return NEXT_STATUS[current];
}

export const isStatus = (value: unknown): value is string => typeof value === 'string' && STATUS_VALUES.includes(value);

// ---------------------------------------------------------------------------
// Editing the front matter
// ---------------------------------------------------------------------------

/** Replace characters [start, end) of a zero-based line with `text` (an insertion when start = end). */
export interface TextEdit {
  line: number;
  start: number;
  end: number;
  text: string;
}

export interface StatusEditOptions {
  /** Today as YYYY-MM-DD: set as `updated` when the front matter has that key. Omit to leave `updated` alone. */
  today?: string;
  /** Line ending for inserted lines; defaults to the document's (CRLF if it has any, else LF). */
  eol?: string;
}

export type StatusEditResult =
  | { ok: true; edits: TextEdit[] }
  | { ok: false; reason: string };

/**
 * The edits that set the front matter `status`. Only that value (and `updated`) changes: quotes,
 * comments, key order and line endings stay as they are.
 *
 * - `status:` present: its value is replaced, keeping its quotes and any trailing comment.
 * - `status:` missing: a line is inserted after `summary:`, else after `title:`, else at the end of the front matter.
 * - No front matter: a minimal one (`smd: 1`, `status: …`) is added at the top.
 * - `updated:` present and `today` given: its value becomes `today`.
 *
 * Front matter that can't be read (unclosed, invalid YAML) is refused, and so is any edit whose result
 * wouldn't parse back to the same front matter with just those values changed. No edits (and no new
 * `updated` date) when the status is already the one asked for.
 */
export function setStatusEdits(text: string, status: string, options: StatusEditOptions = {}): StatusEditResult {
  const eol = options.eol ?? (text.includes('\r\n') ? '\r\n' : '\n');
  const fm = parseFrontMatter(text);
  if (fm.error) return { ok: false, reason: `${fm.error.message} Fix the front matter first.` };
  if (!fm.present) return { ok: true, edits: [newFrontMatter(text, status, eol)] };
  if (fm.data.status === status) return { ok: true, edits: [] };
  const lines = text.split(/\r?\n/);
  const end = fm.bodyStartLine - 1;
  const updated = options.today ? valueEdit(lines, end, 'updated', options.today) : undefined;
  for (const statusEdit of statusEditCandidates(lines, end, status, eol)) {
    const edits = [statusEdit, updated].filter((e): e is TextEdit => !!e).sort((a, b) => a.line - b.line);
    if (keepsFrontMatter(text, edits, fm.data, status, options.today)) return { ok: true, edits };
  }
  return { ok: false, reason: 'The status line could not be changed safely. Edit the front matter by hand.' };
}

/** `---`, `smd: 1`, `status: …`, `---` at the top, and a blank line before the body. */
function newFrontMatter(text: string, status: string, eol: string): TextEdit {
  const blank = text.split(/\r?\n/, 1)[0].trim() ? eol : '';
  return { line: 0, start: 0, end: 0, text: ['---', 'smd: 1', `status: ${status}`, '---', ''].join(eol) + blank };
}

/** Where `status` can go, best first: replace its value, or a new line after summary, title or the last key. */
function statusEditCandidates(lines: string[], end: number, status: string, eol: string): TextEdit[] {
  const replace = valueEdit(lines, end, 'status', status);
  if (replace) return [replace];
  const after = ['summary', 'title']
    .map((key) => keyLine(lines, end, key))
    .filter((line): line is number => line !== undefined)
    .map((line) => entryEnd(lines, line, end));
  return [...after, end - 1].map((line) => ({ line: line + 1, start: 0, end: 0, text: `status: ${status}${eol}` }));
}

/** The zero-based line of a top-level `key:` inside the front matter (lines 1 to end - 1). */
function keyLine(lines: string[], end: number, key: string): number | undefined {
  for (let i = 1; i < end; i++) {
    const rest = lines[i].startsWith(key) ? lines[i].slice(key.length).trimStart() : '';
    if (rest.startsWith(':')) return i;
  }
  return undefined;
}

/** The last line of the entry starting at `line`: continuation lines are indented. */
function entryEnd(lines: string[], line: number, end: number): number {
  let last = line;
  while (last + 1 < end && /^[ \t]/.test(lines[last + 1])) last++;
  return last;
}

/** Replace the value of a top-level `key: value` line, keeping its quotes and comment. */
function valueEdit(lines: string[], end: number, key: string, value: string): TextEdit | undefined {
  const line = keyLine(lines, end, key);
  if (line === undefined) return undefined;
  const span = valueSpan(lines[line]);
  return { line, start: span.start, end: span.end, text: span.needsSpace ? ` ${value}` : value };
}

/** The value after the first `:` of a line: inside its quotes, or up to a ` #` comment and trailing spaces. */
export function valueSpan(line: string): { start: number; end: number; needsSpace: boolean } {
  const colon = line.indexOf(':') + 1;
  const start = colon + (line.slice(colon).length - line.slice(colon).trimStart().length);
  const quote = line.charAt(start);
  if (quote === '"' || quote === "'") {
    const close = line.indexOf(quote, start + 1);
    if (close > start) return { start: start + 1, end: close, needsSpace: false };
  }
  const comment = commentStart(line, start);
  const end = start + line.slice(start, comment).trimEnd().length;
  return { start, end, needsSpace: start === colon };
}

/** Where a YAML comment starts: a `#` at the value's start or after whitespace (`a#b` is a value). */
function commentStart(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '#' && (i === from || /\s/.test(line[i - 1]))) return i;
  }
  return line.length;
}

/** Whether the edited front matter parses with `status` (and `updated`) set and every other key unchanged. */
function keepsFrontMatter(text: string, edits: TextEdit[], before: Record<string, unknown>, status: string, today?: string): boolean {
  const after = parseFrontMatter(applyTextEdits(text, edits));
  if (after.error || after.data.status !== status) return false;
  if (today && 'updated' in before && after.data.updated !== today) return false;
  const rest = (data: Record<string, unknown>) => JSON.stringify({ ...data, status: undefined, updated: undefined });
  return rest(after.data) === rest(before);
}

/** Apply non-overlapping edits to `text` (as VS Code would). */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const starts = [0];
  for (const m of text.matchAll(/\r?\n/g)) starts.push((m.index ?? 0) + m[0].length);
  const offset = (line: number, ch: number) => (starts[line] ?? text.length) + ch;
  let result = text;
  for (const e of [...edits].sort((a, b) => b.line - a.line || b.start - a.start)) {
    result = result.slice(0, offset(e.line, e.start)) + e.text + result.slice(offset(e.line, e.end));
  }
  return result;
}
