import yaml from 'js-yaml';
import { parseFrontMatter } from './frontmatter';
import { frontMatterProperty, frontMatterValues } from './frontmatterSchema';
import type { LineEdit } from './sourceEdit';

/**
 * The front matter of a document, edited one key at a time for the block editor's form. A change replaces only that
 * key's value on its line (or its list item lines), keeps comments, key order and quoting, and adds a new key at the
 * end, before the closing `---`. YAML the line-based approach can't edit safely (anchors, aliases or tags, flow
 * mappings, block scalars, values over several lines, keys it can't read) is refused, and the editor falls back to
 * the raw YAML. Every edit is checked by parsing the result: the key must hold what was asked and every other key
 * what it held. Browser-safe; not part of the npm API.
 */

/** Why the front matter, or one key of it, can't be edited from a form. */
export interface FrontMatterRefusal {
  refused: string;
}

export type ValueStyle = 'plain' | 'double' | 'single' | 'flow' | 'block' | 'empty';

/** A scalar's place on a line: [start, end) and how it is quoted. */
interface Span {
  start: number;
  end: number;
  style: 'plain' | 'double' | 'single';
}

/** A top-level key and the lines its value takes. */
export interface FrontMatterEntry {
  key: string;
  /** The key's line, in the block's lines (the opening `---` is line 0). */
  line: number;
  /** After its value's last line. */
  end: number;
  style: ValueStyle;
  /** The value on the key line: a scalar, or a flow list `[…]` (with style 'flow'). */
  span?: { start: number; end: number };
  /** A scalar's quoting; a block list's items. */
  quote?: Span['style'];
  items?: { line: number; span: Span }[];
  /** Why this key's value can't be edited here. */
  refused?: string;
}

export interface FrontMatterBlock {
  entries: FrontMatterEntry[];
  /** The line of the closing `---` (or `...`). */
  close: number;
}

/** A value the form sets: text, a list, or null to remove the key. */
export type FrontMatterValue = string | readonly string[] | null;

const KEY_LINE = /^([A-Za-z_][\w-]*)[ \t]*:(?=[ \t]|$)/;
const ITEM_LINE = /^([ \t]*)-[ \t]+(\S.*)$/;
const NODE_PROPERTY = /^[&*!]/;
const BLANK = /^[ \t]*$/;
const COMMENT = /^[ \t]*#/;
const INDENTED = /^[ \t]/;
const FLOW_MAPPING = 'a flow mapping ({…})';
const SEVERAL_LINES = 'a value over several lines';
const NOT_SAFE = 'The front matter uses YAML the form can\'t edit safely';

const refuse = (refused: string): FrontMatterRefusal => ({ refused });
export const isFrontMatterRefusal = (v: unknown): v is FrontMatterRefusal => typeof v === 'object' && v !== null && 'refused' in v;

/** Where a quoted scalar that starts at `from` ends (after its closing quote), or -1 when it doesn't end on the line. */
function quotedEnd(line: string, from: number): number {
  const q = line[from];
  for (let i = from + 1; i < line.length; i++) {
    if (q === '"' && line[i] === '\\') i++;
    else if (line[i] === q && q === '\'' && line[i + 1] === '\'') i++;
    else if (line[i] === q) return i + 1;
  }
  return -1;
}

/** The rest of a line after a value: nothing, or spaces and a comment. */
const onlyComment = (rest: string) => BLANK.test(rest) || /^[ \t]+#/.test(rest);

/** A scalar that starts at `from` (a non-space character), or why it can't be edited. */
function scalarAt(line: string, from: number): Span | FrontMatterRefusal {
  const c = line[from];
  if (c === '"' || c === '\'') {
    const end = quotedEnd(line, from);
    if (end < 0 || !onlyComment(line.slice(end))) return refuse(SEVERAL_LINES);
    return { start: from, end, style: c === '"' ? 'double' : 'single' };
  }
  if (c === '|' || c === '>') return refuse('a block scalar (| or >)');
  if (c === '{') return refuse(FLOW_MAPPING);
  // A plain scalar runs to a comment (` #`) or the end of the line, trailing spaces left out.
  const comment = line.slice(from).search(/[ \t]#/);
  const text = comment < 0 ? line.slice(from) : line.slice(from, from + comment);
  return { start: from, end: from + text.trimEnd().length, style: 'plain' };
}

/** A flow list `[a, "b"]` that starts at `from`: its span, or why it can't be edited (nesting, several lines). */
function flowAt(line: string, from: number): { start: number; end: number } | FrontMatterRefusal {
  for (let i = from + 1; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === '\'') {
      const end = quotedEnd(line, i);
      if (end < 0) return refuse(SEVERAL_LINES);
      i = end - 1;
    } else if (c === '[' || c === '{') {
      return refuse('a nested list or mapping');
    } else if (c === ']') {
      return onlyComment(line.slice(i + 1)) ? { start: from, end: i + 1 } : refuse(SEVERAL_LINES);
    }
  }
  return refuse(SEVERAL_LINES);
}

/** The items of a flow list's inside, split on commas outside quotes, trimmed. */
function flowItems(inside: string): string[] {
  const items: string[] = [];
  let start = 0;
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i];
    if (c === '"' || c === '\'') i = Math.max(i, quotedEnd(inside, i) - 1);
    else if (c === ',') {
      items.push(inside.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = inside.slice(start).trim();
  if (last !== '' || items.length) items.push(last);
  return items;
}

/** The value after `key:` on its line, as an entry's style and span. */
function keyValue(entry: FrontMatterEntry, line: string, from: number): void {
  const at = from + (line.slice(from).length - line.slice(from).trimStart().length);
  if (at >= line.length || line[at] === '#') {
    entry.style = 'empty';
    entry.span = { start: from, end: from };
    return;
  }
  const value = line[at] === '[' ? flowAt(line, at) : scalarAt(line, at);
  if (isFrontMatterRefusal(value)) {
    entry.refused = value.refused;
    return;
  }
  entry.span = { start: value.start, end: value.end };
  if (line[at] === '[') entry.style = 'flow';
  else {
    entry.style = 'plain';
    entry.quote = (value as Span).style;
  }
}

/** A block list's item lines after an empty `key:`: each one `- scalar` at one indentation. */
function blockItems(entry: FrontMatterEntry, lines: readonly string[]): void {
  const items: { line: number; span: Span }[] = [];
  let indent: string | undefined;
  for (let i = entry.line + 1; i < entry.end; i++) {
    const m = ITEM_LINE.exec(lines[i]);
    if (!m || (indent !== undefined && m[1] !== indent) || m[2].startsWith('[')) {
      entry.refused = SEVERAL_LINES;
      return;
    }
    indent = m[1];
    const span = scalarAt(lines[i], lines[i].length - m[2].length);
    if (isFrontMatterRefusal(span)) {
      entry.refused = span.refused;
      return;
    }
    items.push({ line: i, span });
  }
  entry.style = 'block';
  entry.items = items;
}

/** Where a key's value ends: after the lines under it (indented, or `- ` items), up to the next key, comment or blank line. */
function valueEnd(lines: readonly string[], from: number, close: number): number {
  let end = from + 1;
  while (end < close && !BLANK.test(lines[end]) && !COMMENT.test(lines[end]) && (INDENTED.test(lines[end]) || lines[end].startsWith('-'))) end++;
  return end;
}

/** Anchors (`&a`), aliases (`*a`) and tags (`!x`) start a node: after `key: `, `- `, `[` or `,`. */
function hasNodeProperty(line: string): boolean {
  const m = KEY_LINE.exec(line);
  const value = (m ? line.slice(m[0].length) : line.replace(/^[ \t]*-?/, '')).trim();
  if (NODE_PROPERTY.test(value)) return true;
  if (!value.startsWith('[')) return false;
  const close = value.lastIndexOf(']');
  return flowItems(value.slice(1, close < 0 ? value.length : close)).some((item) => NODE_PROPERTY.test(item));
}

/** Check a line of the front matter: a key, a blank line, a comment, or a line of the value above it. */
function lineProblem(line: string): string | undefined {
  if (BLANK.test(line) || COMMENT.test(line)) return undefined;
  if (hasNodeProperty(line)) return 'anchors, aliases or tags';
  return KEY_LINE.test(line) || INDENTED.test(line) || line.startsWith('-') ? undefined : 'a key the form can\'t read';
}

/**
 * Read the front matter block (its lines, the opening `---` first) key by key. Refused as a whole when it isn't
 * closed or doesn't parse, or when it uses anchors, aliases or tags, keys the form can't read, or the same key twice.
 */
export function readFrontMatterBlock(lines: readonly string[]): FrontMatterBlock | FrontMatterRefusal {
  const close = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === '---' || l.trimEnd() === '...'));
  if (lines[0]?.trimEnd() !== '---' || close < 0) return refuse('The front matter is not closed with "---".');
  const parsed = parseFrontMatter(`${lines.slice(0, close + 1).join('\n')}\n`);
  if (parsed.error) return refuse('The front matter is not valid YAML: edit it as text.');
  const entries: FrontMatterEntry[] = [];
  for (let i = 1; i < close; i++) {
    const problem = lineProblem(lines[i]);
    if (problem) return refuse(`${NOT_SAFE} (${problem}): edit it as text.`);
    const m = KEY_LINE.exec(lines[i]);
    if (!m) continue;
    if (entries.some((e) => e.key === m[1])) return refuse(`${NOT_SAFE} ("${m[1]}" is set twice): edit it as text.`);
    entries.push(readEntry(lines, i, m, close));
  }
  return { entries, close };
}

/** A key and its value: on its line, or (after an empty `key:`) a block list on the lines under it. */
function readEntry(lines: readonly string[], line: number, m: RegExpExecArray, close: number): FrontMatterEntry {
  const entry: FrontMatterEntry = { key: m[1], line, end: valueEnd(lines, line, close), style: 'empty' };
  keyValue(entry, lines[line], m[0].length);
  if (entry.refused || entry.end === line + 1) return entry;
  if (entry.style === 'empty') blockItems(entry, lines);
  else entry.refused = SEVERAL_LINES;
  return entry;
}

// ---------------------------------------------------------------------------
// Writing values
// ---------------------------------------------------------------------------

/** The types of value a known key takes, from the schema (strings, unless it says numbers or booleans), `anyOf` included. */
function valueTypes(key: string): Set<string> {
  const prop = frontMatterProperty(key);
  const type = prop?.type ?? prop?.anyOf?.flatMap((a) => a.type ?? []);
  const types = new Set(Array.isArray(type) ? type : [type ?? 'string']);
  if (!types.size) types.add('string');
  if (types.has('integer')) types.add('number');
  return types;
}

/** What YAML reads `text` as, in a mapping value or a flow list. */
function loads(text: string, flow: boolean): unknown {
  try {
    const data = yaml.load(flow ? `[${text}]` : `k: ${text}`, { schema: yaml.CORE_SCHEMA }) as unknown;
    return flow ? (data as unknown[])[0] : (data as Record<string, unknown>).k;
  } catch {
    return undefined;
  }
}

/** Written without quotes, `text` reads back as itself (as a string, or as a number or boolean the key takes). */
function plainReads(text: string, types: ReadonlySet<string>, flow: boolean): boolean {
  if (text === '' || text !== text.trim()) return false;
  const value = loads(text, flow);
  if (typeof value === 'string') return value === text && types.has('string');
  return (typeof value === 'number' || typeof value === 'boolean') && types.has(typeof value) && String(value) === text;
}

const STRINGS: ReadonlySet<string> = new Set(['string']);

/**
 * A scalar as YAML text, in the quoting it had: single or double quotes, or plain when that reads back as the text
 * (else double quotes, which JSON's escapes are valid in). A key that takes no strings (a number, a boolean) gets
 * its value plain; the check after the edit refuses what doesn't read back.
 */
export function yamlText(text: string, quote: Span['style'], types: ReadonlySet<string> = STRINGS, flow = false): string {
  if (!types.has('string')) return text;
  if (quote === 'single') return `'${text.replaceAll('\'', '\'\'')}'`;
  if (quote === 'double') return JSON.stringify(text);
  return plainReads(text, types, flow) ? text : JSON.stringify(text);
}

/** A flow list's items as YAML, `[a, "b c"]`: an item that was there keeps its text as written. */
function flowList(items: readonly string[], written: readonly string[] = []): string {
  const used = new Set<number>();
  const text = items.map((item) => {
    const i = written.findIndex((w, n) => !used.has(n) && scalarValue(w, true) === item);
    if (i < 0) return yamlText(item, 'plain', STRINGS, true);
    used.add(i);
    return written[i];
  });
  return `[${text.join(', ')}]`;
}

/** The lines the key's entry has after a change (its own lines only), or null to remove them. */
function entryLines(entry: FrontMatterEntry, lines: readonly string[], value: FrontMatterValue): string[] | null {
  if (value === null) return null;
  const line = lines[entry.line];
  const types = valueTypes(entry.key);
  if (typeof value === 'string') {
    if (entry.style !== 'plain' && entry.style !== 'empty') return [`${line.slice(0, KEY_LINE.exec(line)![0].length)} ${yamlText(value, 'plain', types)}`];
    return [spliceSpan(line, entry, yamlText(value, entry.quote ?? 'plain', types))];
  }
  if (entry.style === 'block') return [line, ...blockLines(entry, lines, value)];
  if (entry.style === 'plain') return [spliceSpan(line, entry, yamlText(value.join(', '), entry.quote ?? 'plain', types))];
  if (entry.style === 'flow') return [spliceSpan(line, entry, flowList(value, flowItems(line.slice(entry.span!.start + 1, entry.span!.end - 1))))];
  return [spliceSpan(line, entry, flowList(value))];
}

/** The key line with its value's span replaced (an empty value: written after the colon, before any comment). */
function spliceSpan(line: string, entry: FrontMatterEntry, text: string): string {
  const span = entry.span!;
  if (entry.style !== 'empty') return line.slice(0, span.start) + text + line.slice(span.end);
  return `${line.slice(0, span.start)} ${text}${line.slice(span.end).trimEnd() === '' ? '' : line.slice(span.end)}`;
}

/** A block list's item lines for new items: an unchanged item keeps its line as written; new ones follow the first's style. */
function blockLines(entry: FrontMatterEntry, lines: readonly string[], value: readonly string[]): string[] {
  const items = entry.items ?? [];
  const first = items[0];
  const prefix = first ? lines[first.line].slice(0, first.span.start) : '  - ';
  const quote = first?.span.style ?? 'plain';
  const used = new Set<number>();
  return value.map((item) => {
    const i = items.findIndex((it, n) => !used.has(n) && scalarValue(lines[it.line].slice(it.span.start, it.span.end)) === item);
    if (i < 0) return `${prefix}${yamlText(item, quote)}`;
    used.add(i);
    return lines[items[i].line];
  });
}

/** What a scalar's text reads as, as a string. */
function scalarValue(text: string, flow = false): string {
  const value = loads(text, flow);
  return value === undefined || value === null ? '' : String(value);
}

/** Lines [start, end) replaced, without the lines at either end that stay the same. */
function trimmedEdit(lines: readonly string[], start: number, end: number, next: readonly string[]): LineEdit | null {
  let head = 0;
  while (head < next.length && start + head < end && lines[start + head] === next[head]) head++;
  let tail = 0;
  while (tail < next.length - head && end - tail > start + head && lines[end - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const edit = { start: start + head, end: end - tail, lines: next.slice(head, next.length - tail) };
  return edit.start === edit.end && !edit.lines.length ? null : edit;
}

/**
 * Set a key of the front matter (its block's lines, the opening `---` first) to a value, or remove it (null): the
 * line edits, against those lines (none when nothing changes), or why the form can't make the change. A new key
 * goes at the end, before the closing `---`; a new list is written `[a, b]`.
 */
export function setFrontMatterValue(lines: readonly string[], key: string, value: FrontMatterValue): LineEdit[] | FrontMatterRefusal {
  const block = readFrontMatterBlock(lines);
  if (isFrontMatterRefusal(block)) return block;
  const entry = block.entries.find((e) => e.key === key);
  if (entry?.refused) return refuse(`"${key}" is written as ${entry.refused}: edit it as text.`);
  let edit: LineEdit | null;
  if (entry) {
    edit = trimmedEdit(lines, entry.line, entry.end, entryLines(entry, lines, value) ?? []);
  } else if (value === null) {
    edit = null;
  } else {
    const text = typeof value === 'string' ? yamlText(value, 'plain', valueTypes(key)) : flowList(value);
    edit = { start: block.close, end: block.close, lines: [`${key}: ${text}`] };
  }
  const edits = edit ? [edit] : [];
  return readsAsAsked(lines, block.close, edits, key, value) ? edits : refuse(`"${key}" can't be written that way here: edit the front matter as text.`);
}

/** After the edits, the front matter parses, the key holds the value (or is gone) and every other key is as it was. */
function readsAsAsked(lines: readonly string[], close: number, edits: readonly LineEdit[], key: string, value: FrontMatterValue): boolean {
  const data = (l: readonly string[]) => parseFrontMatter(`${l.join('\n')}\n`);
  const before = data(lines.slice(0, close + 1));
  const next = [...lines.slice(0, close + 1)];
  for (const e of [...edits].sort((a, b) => b.start - a.start)) next.splice(e.start, e.end - e.start, ...e.lines);
  const after = data(next);
  if (after.error || before.error) return false;
  const others = new Set([...Object.keys(before.data), ...Object.keys(after.data)].filter((k) => k !== key));
  for (const k of others) if (JSON.stringify(before.data[k]) !== JSON.stringify(after.data[k])) return false;
  return holds(after.data, key, value);
}

function holds(data: Record<string, unknown>, key: string, value: FrontMatterValue): boolean {
  if (value === null) return !Object.hasOwn(data, key);
  const actual = data[key];
  if (typeof value !== 'string') {
    const list = Array.isArray(actual) ? actual : typeof actual === 'string' && actual.split(',').map((s) => s.trim());
    return Array.isArray(list) && list.length === value.length && list.every((v, i) => (typeof v === 'string' || typeof v === 'number') && String(v) === value[i]);
  }
  // Text that reads back as itself, as the type the key takes (`toc: maybe` is text, not a boolean).
  return valueTypes(key).has(typeof actual) && String(actual) === value;
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export type FrontMatterFieldKind = 'text' | 'select' | 'date' | 'list';

/** A known key as a form field: its value now ('' when unset; a list's items joined with ", "). */
export interface FrontMatterField {
  name: string;
  kind: FrontMatterFieldKind;
  value: string;
  options?: string[];
  /** Why the form can't change it (edit the front matter as text). */
  refused?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIST_KEYS = new Set(['owners', 'tags', 'related']);
const DATE_KEYS = new Set(['updated', 'created']);
/** The known keys, in the form's order. */
export const FRONT_MATTER_FIELDS = ['title', 'summary', 'status', 'owners', 'audience', 'tags', 'version', 'updated', 'created', 'theme', 'accent', 'toc', 'related', 'lang', 'typography', 'smd'];

/** A value as the form shows it. */
function shown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return typeof value === 'object' ? '' : String(value);
}

const isMapping = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A select when the key has choices, else a text field. */
function choiceField(key: string, text: string): FrontMatterField {
  const choices = frontMatterValues(key);
  if (!choices.length) return { name: key, kind: 'text', value: text };
  // A value that is not one of the choices stays one, so the list shows what is written.
  const extra = text && !choices.includes(text) ? [text] : [];
  return { name: key, kind: 'select', value: text, options: ['', ...choices, ...extra] };
}

function field(key: string, value: unknown, entry: FrontMatterEntry | undefined): FrontMatterField {
  const text = shown(value);
  const refused = entry?.refused ?? (isMapping(value) ? 'a mapping' : undefined);
  let f: FrontMatterField;
  if (LIST_KEYS.has(key)) {
    const items = Array.isArray(value) ? value.map(String) : [];
    f = { name: key, kind: 'list', value: text };
    if (items.some((i) => i.includes(','))) f.refused = 'an item with a comma';
  } else if (DATE_KEYS.has(key) && (text === '' || ISO_DATE.test(text))) {
    f = { name: key, kind: 'date', value: text };
  } else {
    f = choiceField(key, text);
  }
  if (refused) f.refused = refused;
  return f;
}

/** The front matter as form fields (every known key, set or not), or why only its text can be edited. */
export function frontMatterFields(lines: readonly string[]): FrontMatterField[] | FrontMatterRefusal {
  const block = readFrontMatterBlock(lines);
  if (isFrontMatterRefusal(block)) return block;
  const { data } = parseFrontMatter(`${lines.slice(0, block.close + 1).join('\n')}\n`);
  return FRONT_MATTER_FIELDS.map((key) => field(key, data[key], block.entries.find((e) => e.key === key)));
}
