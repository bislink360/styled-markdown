import { findAttrsEnd, lexAttrItems } from './attrs';
import { isKnownContainer, type ContainerInfo } from './containers';
import { LATEST_SPEC, readSpec } from './specVersion';
import type { Fix, Severity } from './validate';

/**
 * What spec v2 (Styled Markdown 2.0) rejects or reads differently. The 1.10 notices are hints (an info where noted);
 * since 2.0, duplicate attributes and conflicting container titles are errors in every document (RFC proposal 4),
 * rendered as v1 resolves them, `priority` on `:::agent` is an unknown attribute (proposal 12), and the spec version
 * check (checkSmdVersion) reports warnings. Each fix keeps how the document renders now.
 */

type Push = (line: number, column: number, endColumn: number, severity: Severity, code: string, message: string, fix?: Fix) => void;

const V2 = 'spec v2 (smd: 2)';
const HINT: Severity = 'hint';
const ERROR: Severity = 'error';

/** The message of `priority` on `:::agent` (an `attrs/unknown` warning since 2.0), which `smd migrate` looks for. */
export const AGENT_PRIORITY_REMOVED = 'Unknown attribute "priority" on ":::agent". It was removed in Styled Markdown 2.0, since no tool read it. Remove it.';

// ---------------------------------------------------------------------------
// Attribute list items
// ---------------------------------------------------------------------------

interface AttrItem {
  /** What a repeat of it is: `#` for every id, `.name` for a class, the key for the others. */
  slot: string;
  /** How a message names it: `#id`, `.name` or the key. */
  label: string;
  /** A bare word without a value (`{ok}`). */
  flag: boolean;
  /** Where its text starts and ends in the list, spaces around it included. */
  start: number;
  end: number;
}

/** The items of the inside of `{…}` as parseAttrs reads them, or null when it is not a well-formed attribute list. */
function attrItems(src: string): AttrItem[] | null {
  return lexAttrItems(src)?.map(({ match, pos }) => itemOf(match, pos)) ?? null;
}

function itemOf(m: RegExpExecArray, start: number): AttrItem {
  const end = start + m[0].length;
  if (m[1] === '#') return { slot: '#', label: '#id', flag: false, start, end };
  if (m[1] === '.') return { slot: `.${m[2]}`, label: `.${m[2]}`, flag: false, start, end };
  const flag = m[4] === undefined && m[5] === undefined && m[6] === undefined;
  return { slot: m[3], label: m[3], flag, start, end };
}

/** The list written with only `kept` of its items, one space apart. */
const without = (src: string, kept: AttrItem[]) => kept.map((it) => src.slice(it.start, it.end).trim()).join(' ');

const quoted = (labels: string[]) => labels.map((l) => `"${l}"`).join(', ');

// ---------------------------------------------------------------------------
// attrs/duplicate
// ---------------------------------------------------------------------------

/**
 * A key, an id or a class given more than once in the attribute list between `open` (`{`) and `close` (`}`) on a line.
 * The last one wins when rendered (a repeated class is added twice). The fix writes each once, with the value that is
 * used, where it first appears (as smd fmt does), so the attributes render in the same order. `text` is the line as
 * checked (inline code blanked out); the fix is offered only where it is the line as written.
 */
export function checkDuplicateAttrs(line: number, raw: string, open: number, close: number, push: Push, text = raw): void {
  const src = text.slice(open + 1, close);
  const items = attrItems(src);
  if (!items) return;
  const last = new Map<string, AttrItem>();
  for (const it of items) last.set(it.slot, it);
  const repeated = items.filter((it) => last.get(it.slot) !== it);
  if (!repeated.length) return;
  const labels = [...new Set(repeated.map((it) => it.label))];
  const kept = [...last.values()];
  const written = raw.slice(open, close + 1) === text.slice(open, close + 1);
  push(line, open, close + 1, ERROR, 'attrs/duplicate',
    `${quoted(labels)} ${labels.length > 1 ? 'are' : 'is'} given more than once in this attribute list. The last one is used, but an attribute may be given only once. Remove the earlier ones.`,
    written ? { line, column: open + 1, endColumn: close, replacement: without(src, kept), title: 'Remove the earlier duplicates' } : undefined);
}

/** Inline attribute lists on a line: `[text]{…}`, `:name[…]{…}` and `:name{…}`. */
const SPAN_ATTRS = /\]\{[^{}\n]*\}/g;
const DIRECTIVE_ATTRS = /(?:^|[\s([{>*_~"'-]):[a-z][a-z0-9-]*(\{[^{}\n]*\})/g;

/** Duplicates in the inline attribute lists of a line; `text` has its inline code blanked out. */
export function checkInlineAttrLists(raw: string, text: string, line: number, push: Push): void {
  for (const m of text.matchAll(SPAN_ATTRS)) checkDuplicateAttrs(line, raw, m.index + 1, m.index + m[0].length - 1, push, text);
  for (const m of text.matchAll(DIRECTIVE_ATTRS)) {
    const close = m.index + m[0].length - 1;
    checkDuplicateAttrs(line, raw, close + 1 - m[1].length, close, push, text);
  }
}

// ---------------------------------------------------------------------------
// Containers: container/colons, container/title-conflict, priority on :::agent
// ---------------------------------------------------------------------------

/** The container a closing fence closes: its name, colon count and opening line. */
export interface OpenContainer { name: string; len: number; line: number }

/** A closing fence whose colon count differs from its container's, which spec v2 pairs by count. */
export function checkCloser(line: number, indent: number, colons: number, open: OpenContainer, push: Push): void {
  if (colons === open.len) return;
  const fence = ':'.repeat(open.len);
  push(line, indent, indent + colons, HINT, 'container/colons',
    `This closing fence has ${colons} colons and closes "${fence}${open.name}" on line ${open.line + 1}, which has ${open.len}. A closing fence closes the innermost open container today; in ${V2} it closes the innermost one opened with as many colons, so this one would close another container or be reported. Write it with ${open.len} colons, as smd fmt does.`,
    { line, column: indent, endColumn: indent + colons, replacement: fence, title: `Change to "${fence}"` });
}

/** The attribute list of a container's opening line, which starts at `nameEnd`. */
export function checkContainerHints(info: ContainerInfo, line: number, raw: string, nameEnd: number, push: Push): void {
  const close = raw[nameEnd] === '{' ? findAttrsEnd(raw, nameEnd) : -1;
  if (close < 0 || info.attrsError) return;
  checkDuplicateAttrs(line, raw, nameEnd, close, push);
  if (!isKnownContainer(info.name)) return;
  if (info.attrs.values.title !== undefined) titleConflict(line, raw, close, info.attrs.values.title, push);
}

/**
 * `:::note{title="A"} B`: the title attribute wins and the text is not shown. An HTML comment after the attributes
 * (`<!-- smd-disable-line … -->`) is not title text, and the fix is offered only on a line without one.
 */
function titleConflict(line: number, raw: string, close: number, title: string, push: Push): void {
  const rest = raw.slice(close + 1);
  if (!rest.replaceAll(/<!--.*?-->/g, '').trim()) return;
  const text = rest.trim();
  const column = close + 1 + rest.indexOf(text);
  push(line, column, column + text.length, ERROR, 'container/title-conflict',
    `This title text is not shown: title="${title}" in the attributes wins. A container is titled either by title="…" or by text after its attributes, not both. Remove the text, or move it into title="…".`,
    rest.includes('<!--') ? undefined : { line, column: close + 1, endColumn: raw.length, replacement: '', title: 'Remove the title text that is not shown' });
}

/**
 * `:::agent{priority=…}`, deprecated in 1.10 and removed in 2.0 (RFC proposal 12): an unknown attribute, as any other,
 * on the attribute itself, with a fix that removes it (and the braces when nothing is left). The attribute list starts
 * at `open`. False when the list can't be read, so the caller reports it as it reports other unknown attributes.
 */
export function removedAgentPriority(line: number, raw: string, open: number, push: Push): boolean {
  const close = raw[open] === '{' ? findAttrsEnd(raw, open) : -1;
  const src = close < 0 ? '' : raw.slice(open + 1, close);
  const items = attrItems(src);
  const at = items?.find((it) => it.slot === 'priority');
  if (close < 0 || !items || !at) return false;
  const column = open + 1 + at.start + (src.slice(at.start).length - src.slice(at.start).trimStart().length);
  const kept = items.filter((it) => it.slot !== 'priority');
  const fix: Fix = kept.length
    ? { line, column: open + 1, endColumn: close, replacement: without(src, kept), title: 'Remove "priority"' }
    : { line, column: open, endColumn: close + 1, replacement: '', title: 'Remove "priority"' };
  push(line, column, column + 'priority'.length, 'warning', 'attrs/unknown',
    AGENT_PRIORITY_REMOVED, fix);
  return true;
}

// ---------------------------------------------------------------------------
// Headings: attrs/duplicate, heading/attrs-text
// ---------------------------------------------------------------------------

/**
 * The attribute list ending a heading: `start` is where the spaces before its `{` begin, `open` and `close` its braces.
 * Spec v2 reads a list as attributes only when it has items and each is `#id`, `.class` or `key=value`; otherwise it
 * is heading text. The fix removes the braces or the bare words, which is how the heading renders today.
 */
export function checkHeadingHints(line: number, raw: string, start: number, open: number, close: number, push: Push): void {
  checkDuplicateAttrs(line, raw, open, close, push);
  const src = raw.slice(open + 1, close);
  const items = attrItems(src);
  if (!items) return;
  const flags = items.filter((it) => it.flag);
  if (items.length && !flags.length) return;
  const list = raw.slice(open, close + 1);
  const words = flags.map((it) => it.label);
  const today = words.length ? `an attribute list, and ${quoted(words)} ${words.length > 1 ? 'are' : 'is'} dropped` : 'an empty attribute list and dropped';
  push(line, open, close + 1, HINT, 'heading/attrs-text',
    `"${list}" after a heading is read as ${today} today. In ${V2} a list that is empty or has a bare word is part of the heading text, which then shows the braces and gets another id. Remove ${words.length ? quoted(words) : 'the braces'} to keep how the heading renders today.`,
    headingTextFix({ line, raw, start, open, close }, items));
}

/** Remove a heading's bare words, or its whole list when nothing else is in it. */
function headingTextFix(at: { line: number; raw: string; start: number; open: number; close: number }, items: AttrItem[]): Fix | undefined {
  const { line, raw, start, open, close } = at;
  const words = items.filter((it) => it.flag).map((it) => it.label);
  // `agent` alone is `agent=true`, which rendering writes out; removing it would change the heading.
  if (words.includes('agent')) return undefined;
  const kept = items.filter((it) => !it.flag);
  if (!kept.length) return { line, column: start, endColumn: raw.length, replacement: '', title: `Remove "${raw.slice(open, close + 1)}"` };
  return { line, column: open + 1, endColumn: close, replacement: without(raw.slice(open + 1, close), kept), title: `Remove ${quoted(words)}` };
}

// ---------------------------------------------------------------------------
// Front matter: frontmatter/version
// ---------------------------------------------------------------------------

const DIGITS = /^\d+$/;
const VERSION_CODE = 'frontmatter/version';

/** The value of a `smd: value` front matter line as written: up to a `#` comment, quotes kept. */
function writtenValue(raw: string): { column: number; text: string } | undefined {
  const m = /^smd\s*:[ \t]*/.exec(raw);
  if (!m) return undefined;
  const rest = raw.slice(m[0].length);
  const comment = rest.search(/\s#/);
  const text = (comment < 0 ? rest : rest.slice(0, comment)).trimEnd();
  return text ? { column: m[0].length, text } : undefined;
}

/** What kind of value `smd` has, for messages: a boolean, a list, a decimal, a string that isn't a number…; undefined for a version. */
function versionKind(value: unknown, written: string | undefined): string | undefined {
  if (typeof value === 'boolean') return 'a boolean';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'number') return numberKind(value, written);
  if (typeof value === 'string') return DIGITS.test(value) ? numberKind(Number(value), undefined) : 'a string that is not a whole number';
  return 'not a number';
}

/** A number that isn't a version (zero, negative, not a number), or one written as a decimal (`2.0`, which reads as 2). */
function numberKind(n: number, written: string | undefined): string | undefined {
  if (Number.isNaN(n) || n < 1) return 'not a positive number';
  return Number.isInteger(n) && (written === undefined || DIGITS.test(written)) ? undefined : 'a decimal';
}

/**
 * The `smd` front matter value on `line` (0 when its line wasn't found), read as every tool reads it (readSpec in
 * specVersion.ts). A version this tool knows, as a whole number or a string of digits, passes. Anything else is a
 * warning (an info before 2.0): a newer version, read with the newest rules this tool has; a value that isn't a
 * whole number (`true`, `[2]`, `1.5`, `"v2"`, `0`), read as version 1, with a fix to `smd: 1` that keeps how it
 * reads; and a whole number written as a decimal (`2.0`), read as that number, with a fix to it.
 */
export function checkSmdVersion(value: unknown, line: number, lines: string[], push: Push): void {
  const end = lines[line]?.length ?? 3;
  const reading = readSpec(value);
  if (reading.status === 'newer') {
    push(line, 0, end, 'warning', VERSION_CODE,
      `Styled Markdown version ${reading.declared} is newer than this tool knows, so it reads the document with the version ${LATEST_SPEC} rules. Update Styled Markdown, or write "smd: ${LATEST_SPEC}".`);
    return;
  }
  const written = writtenValue(line > 0 ? lines[line] : '');
  const kind = versionKind(value, written?.text);
  if (!kind) return;
  const version = reading.version;
  const other = version === 1 ? ', or "smd: 2" for the spec v2 rules (smd migrate --to 2 writes it)' : '';
  push(line, 0, end, 'warning', VERSION_CODE,
    `"smd: ${written?.text ?? String(value)}" is ${kind}, but the spec version is a whole number: this tool reads the document with the version ${version} rules. Write "smd: ${version}"${other}.`,
    written && { line, column: written.column, endColumn: written.column + written.text.length, replacement: String(version), title: `Change to "smd: ${version}"` });
}
