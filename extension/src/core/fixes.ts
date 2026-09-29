import { suggest } from './util';
import type { Fix } from './validate';

/**
 * Builders for machine-applicable fixes. Each returns a fix only when the repair is unambiguous
 * (one clear candidate, text found exactly where expected) and changes the text; otherwise undefined,
 * so callers can pass the result straight to `push`. An undefined `replacement` means "no candidate".
 */

/** The one candidate a word most likely meant: a case-insensitive match, or a unique closest `suggest` hit. */
export function uniqueSuggestion(word: string, candidates: readonly string[]): string | undefined {
  const lower = word.toLowerCase();
  const unique = [...new Set(candidates)];
  const exact = unique.filter((c) => c.toLowerCase() === lower);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const hint = suggest(word, unique);
  if (!hint) return undefined;
  // `suggest` keeps the first of several equally close candidates; a tie is ambiguous.
  const tied = unique.filter((c) => c !== hint && suggest(word, [c, hint]) === c);
  return tied.length ? undefined : hint;
}

/** `2026/9/5`, `2026.09.05` or `2026-9-5` as `2026-09-05`. Only year-first dates, never a guess at day/month order. */
export function normalizeDate(value: string): string | undefined {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value.trim());
  if (!m) return undefined;
  const [month, day] = [Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

const BOOLEANS: Record<string, string> = { true: 'true', yes: 'true', on: 'true', false: 'false', no: 'false', off: 'false' };

/** `"true"`, `yes`, `off`… as a YAML boolean. */
export const booleanValue = (value: string): string | undefined => BOOLEANS[value.trim().toLowerCase()];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace the value of `key: value` on a front matter line, keeping its quotes unless `unquote`.
 * Only for single-line scalars written exactly as parsed.
 */
export function frontMatterValueFix(
  lines: string[], line: number, key: string, value: string, replacement: string | undefined, unquote = false,
): Fix | undefined {
  const raw = lines[line] ?? '';
  const m = new RegExp(`^(${escapeRe(key)}\\s*:\\s*)(["']?)(.*?)\\2\\s*(?:#.*)?$`).exec(raw);
  if (replacement === undefined || line === 0 || !m || m[3] !== value) return undefined;
  const quote = unquote ? '' : m[2];
  if (quote + replacement === m[2] + value) return undefined;
  const column = m[1].length;
  const endColumn = column + m[2].length * 2 + value.length;
  return { line, column, endColumn, replacement: quote + replacement + quote, title: `Change to "${replacement}"` };
}

/**
 * Replace the value of `key=value` inside the attribute list found in `text[start, end)`. Quoted values keep
 * their quotes. Only offered when the key appears once there.
 */
export function attrValueFix(
  line: number, text: string, start: number, end: number, key: string, value: string, replacement: string | undefined,
): Fix | undefined {
  if (replacement === undefined || replacement === value) return undefined;
  const at = findAttr(text, start, end, key);
  if (at < 0) return undefined;
  const m = /^\s*=\s*(["']?)/.exec(text.slice(at + key.length, end));
  const column = at + key.length + (m?.[0].length ?? 0);
  if (!m || text.slice(column, column + value.length) !== value) return undefined;
  return { line, column, endColumn: column + value.length, replacement, title: `Change to "${replacement}"` };
}

/**
 * Rename an unknown attribute key to its unique close match, unless that key is already set
 * (the rename would then override a value).
 */
export function attrKeyFix(
  line: number, text: string, start: number, end: number, key: string, candidates: readonly string[], present: readonly string[],
): Fix | undefined {
  const hint = uniqueSuggestion(key, candidates);
  const at = hint && !present.includes(hint) ? findAttr(text, start, end, key) : -1;
  if (!hint || at < 0) return undefined;
  return { line, column: at, endColumn: at + key.length, replacement: hint, title: `Change to "${hint}"` };
}

/** Column of `key` as an attribute name inside `{…}` in `text[start, end)`, or -1 when absent or repeated. */
function findAttr(text: string, start: number, end: number, key: string): number {
  const open = text.indexOf('{', start);
  if (open < 0 || open >= end) return -1;
  const re = new RegExp(`(?<=[{\\s])${escapeRe(key)}(?=\\s*=|[\\s}])`, 'g');
  const found = [...text.slice(open, end).matchAll(re)];
  return found.length === 1 ? open + found[0].index : -1;
}

/**
 * Replace `word` where it appears exactly once in `text[start, end)`, e.g. a directive's `[content]`.
 */
export function replaceOnceFix(
  line: number, text: string, start: number, end: number, word: string, replacement: string | undefined,
): Fix | undefined {
  if (replacement === undefined || replacement === word || !word) return undefined;
  const segment = text.slice(start, end);
  const at = segment.indexOf(word);
  if (at < 0 || segment.includes(word, at + 1)) return undefined;
  return { line, column: start + at, endColumn: start + at + word.length, replacement, title: `Change to "${replacement}"` };
}

/**
 * Add a closing line (`:::`, a code fence) at the end of the document, where the renderer already ends
 * the unclosed block. Only for blocks opened without indentation: an indented one may belong to a list,
 * which ends it earlier. Several closings at the end are ordered by `applyFixes`, innermost first.
 */
export function closeAtEndFix(lines: string[], openLine: number, closing: string): Fix | undefined {
  if (/^\s/.test(lines[openLine] ?? '')) return undefined;
  const last = lines.length - 1;
  const text = lines[last];
  const title = `Add "${closing}" at the end of the document`;
  // With a trailing newline the last line is empty: write the closing there and keep the newline.
  if (text === '') return { line: last, column: 0, endColumn: 0, replacement: `${closing}\n`, title };
  return { line: last, column: text.length, endColumn: text.length, replacement: `\n${closing}`, title };
}
