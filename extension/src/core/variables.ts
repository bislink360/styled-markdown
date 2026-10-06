/**
 * Front matter variables: `{{version}}` in the text of a document stands for the value of its front
 * matter key `version`, and `{{owner.name}}` for a key of a nested mapping. Only keys the front matter
 * defines are replaced; any other `{{…}}` stays as written, so templates and Handlebars or Jinja
 * examples in prose render as before. `\{{version}}` keeps the braces. Code, math, raw HTML, link
 * destinations and attribute lists are never substituted.
 *
 * The markdown-it rule (markdownItRules.ts) substitutes while rendering; the functions here do the same
 * on plain lines for the agent view, `smd to-md`, the validator and the editors.
 */
import { parseFrontMatter } from './frontmatter';

/** A document's front matter, as parsed. */
export type Variables = Readonly<Record<string, unknown>>;

/** A variable name: a front matter key, or a dotted path into nested mappings and lists (`owner.name`, `links.0`). */
const NAME = String.raw`[A-Za-z_][\w-]*(?:\.[\w-]+)*`;
const VARIABLE_AT = new RegExp(String.raw`^\{\{[ \t]*(${NAME})[ \t]*\}\}`);

/** A `{{name}}` on a line. Columns are zero-based; `endColumn` is exclusive. */
export interface VariableRef {
  name: string;
  column: number;
  endColumn: number;
}

/** What a name stands for: text, nothing (not a front matter key), or a value that is not text (a mapping, an empty key). */
export type VariableValue = { kind: 'text'; text: string } | { kind: 'undefined' } | { kind: 'not-text' };

const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const isScalar = (v: unknown): v is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof v);

/**
 * The text a front matter value is shown as: strings (on one line), numbers and booleans as written by
 * YAML, lists of those joined with ", ". Mappings and empty values have none.
 */
export function variableText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.replaceAll(/\s*\n\s*/g, ' ');
  if (isScalar(value)) return String(value);
  if (Array.isArray(value) && value.every(isScalar)) return value.map((v) => variableText(v)).join(', ');
  return undefined;
}

/** The value at a name: the key itself when the front matter has it (dots included), else the dotted path. */
function valueAt(variables: Variables, name: string): { found: boolean; value?: unknown } {
  if (hasOwn(variables, name)) return { found: true, value: variables[name] };
  let current: unknown = variables;
  for (const part of name.split('.')) {
    if (current === null || typeof current !== 'object' || !hasOwn(current, part)) return { found: false };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

export function lookupVariable(variables: Variables | undefined, name: string): VariableValue {
  const at = variables ? valueAt(variables, name) : { found: false };
  if (!at.found) return { kind: 'undefined' };
  const text = variableText(at.value);
  return text === undefined ? { kind: 'not-text' } : { kind: 'text', text };
}

/** Is the character at `at` escaped by an odd run of backslashes? */
function escaped(text: string, at: number): boolean {
  let n = 0;
  while (at - n > 0 && text[at - n - 1] === '\\') n++;
  return n % 2 === 1;
}

/**
 * The `{{name}}` that starts at `at` (and ends by `end`), if one does: not escaped (`\{{`) and not part
 * of a triple-brace `{{{name}}}`.
 */
export function variableAt(text: string, at: number, end = text.length): VariableRef | undefined {
  if (text[at - 1] === '{' || escaped(text, at)) return undefined;
  const m = VARIABLE_AT.exec(text.slice(at, end));
  if (!m) return undefined;
  const endColumn = at + m[0].length;
  return text[endColumn] === '}' ? undefined : { name: m[1], column: at, endColumn };
}

/**
 * Spans of a line where `{{…}}` is not text: link destinations `](…)`, attribute lists after `]` or a
 * directive name, HTML tags, comments and autolinks, and `$inline math$`.
 */
const LITERAL = new RegExp([
  String.raw`\]\([^)\n]*\)`,
  String.raw`[\]\w]\{(?:[^{}\n]|\{\{[^{}\n]*\}\})*\}`, // NOSONAR(typescript:S5852): one line of text
  String.raw`<!--.*?-->`,
  String.raw`<\/?[A-Za-z][^<>\n]*>`,
  String.raw`\$(?=[^\s$])[^$\n]*?[^\s\\]\$(?!\d)`, // NOSONAR(typescript:S5852): one line of text
].join('|'), 'g');

/** Every `{{name}}` in a line's text (code spans already removed or blanked), outside literal spans. */
export function variablesIn(text: string): VariableRef[] {
  if (!text.includes('{{')) return [];
  const literal = [...text.matchAll(LITERAL)].map((m) => [m.index, m.index + m[0].length]);
  const found: VariableRef[] = [];
  for (let at = text.indexOf('{{'); at >= 0; at = text.indexOf('{{', at + 1)) {
    if (literal.some(([start, end]) => at >= start && at < end)) continue;
    const ref = variableAt(text, at);
    if (!ref) continue;
    found.push(ref);
    at = ref.endColumn - 1;
  }
  return found;
}

/** Replace the defined variables in text that has no code spans; everything else stays as written. */
export function substituteVariables(text: string, variables: Variables | undefined): string {
  if (!variables) return text;
  let out = '';
  let last = 0;
  for (const ref of variablesIn(text)) {
    const value = lookupVariable(variables, ref.name);
    if (value.kind !== 'text') continue;
    out += text.slice(last, ref.column) + value.text;
    last = ref.endColumn;
  }
  return out + text.slice(last);
}

const CODE_SPAN = /(`+[^`]*`+)/;

/** A line with its inline code blanked out, so columns stay put and code is never read as syntax. */
const blankCode = (line: string) => line.replaceAll(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length));

/** A line whose text is never substituted: a reference definition (`[label]: url`) or `$$ display math`. */
const LITERAL_LINE = /^\s{0,3}(?:\[[^\]]+\]:|\$\$)/;

/** substituteVariables on a line, leaving its code spans, reference definitions and display math untouched. */
export function substituteLine(line: string, variables: Variables | undefined): string {
  if (!variables || !line.includes('{{') || LITERAL_LINE.test(line)) return line;
  return line.split(CODE_SPAN).map((part, i) => (i % 2 === 1 ? part : substituteVariables(part, variables))).join('');
}

/** A `{{name}}` in a document. `line` is zero-based. */
export interface VariableUse extends VariableRef {
  line: number;
}

/** What a line of the body is inside of. */
type Block = { kind: 'fence'; mark: string } | { kind: 'math' } | { kind: 'comment' } | null;

/** The block that continues after `line` once inside `block`, or null when the line closes it. */
function stillInside(block: NonNullable<Block>, line: string): Block {
  if (block.kind === 'fence') {
    const mark = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
    return mark?.[0] === block.mark[0] && mark.length >= block.mark.length ? null : block;
  }
  if (block.kind === 'math') return line.trimEnd().endsWith('$$') ? null : block;
  return line.includes('-->') ? null : block;
}

/** The block a line outside any block opens: a code fence, `$$` math or an HTML comment that runs on. */
function opens(line: string): Block {
  const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  if (fence) return { kind: 'fence', mark: fence[1] };
  const math = line.trim();
  if (math.startsWith('$$') && !(math.length > 3 && math.endsWith('$$'))) return { kind: 'math' };
  const comment = line.lastIndexOf('<!--');
  return comment >= 0 && !line.includes('-->', comment) ? { kind: 'comment' } : null;
}

/**
 * Every `{{name}}` in the body of a document, from line `from` (the first body line) on: outside code
 * fences, `$$` math, HTML comments and reference definitions, and outside inline code.
 */
export function findVariables(lines: string[], from = 0): VariableUse[] {
  const uses: VariableUse[] = [];
  let block: Block = null;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (block) { block = stillInside(block, line); continue; }
    block = opens(line);
    if (block?.kind === 'fence' || block?.kind === 'math' || LITERAL_LINE.test(line)) continue;
    // A comment that runs on to later lines hides the rest of this one.
    const visible = block ? line.slice(0, line.lastIndexOf('<!--')) : line;
    for (const ref of variablesIn(blankCode(visible))) uses.push({ ...ref, line: i });
  }
  return uses;
}

/** A name a document can use, with the text it stands for. */
export interface VariableName {
  name: string;
  text: string;
}

/** Every name with a text value, nested keys as dotted paths (`owner.name`), in front matter order. */
export function variableNames(variables: Variables, prefix = '', depth = 0): VariableName[] {
  const names: VariableName[] = [];
  for (const [key, value] of Object.entries(variables)) {
    const text = variableText(value);
    if (text !== undefined) names.push({ name: prefix + key, text });
    else if (value && typeof value === 'object' && !Array.isArray(value) && depth < 3) {
      names.push(...variableNames(value as Variables, `${prefix}${key}.`, depth + 1));
    }
  }
  return names;
}

/** The column where the name being typed after `{{` starts, e.g. in `Version {{ver`; undefined elsewhere. */
function nameStart(prefix: string): number | undefined {
  const m = /\{\{[ \t]*([\w.-]*)$/.exec(prefix);
  if (!m || prefix[m.index - 1] === '{' || escaped(prefix, m.index)) return undefined;
  return prefix.length - m[1].length;
}

/** Is `line` inside a code fence, `$$` math or an HTML comment that starts on an earlier body line? */
function insideBlock(lines: string[], from: number, line: number): boolean {
  let block: Block = null;
  for (let i = from; i < line; i++) block = block ? stillInside(block, lines[i]) : opens(lines[i]);
  return block !== null;
}

/** Completing a variable name: where the typed name starts, whether `}}` must be added, and the names. */
export interface VariableCompletion {
  from: number;
  /** No `}}` follows the cursor, so the completion should close the braces. */
  close: boolean;
  names: VariableName[];
}

/** Front matter names to offer after `{{` at a zero-based line and column of a document's body text. */
export function variableCompletion(text: string, line: number, column: number): VariableCompletion | undefined {
  const lines = text.split(/\r?\n/);
  const lineText = lines[line] ?? '';
  const from = nameStart(lineText.slice(0, column));
  if (from === undefined) return undefined;
  const fm = parseFrontMatter(text);
  if (line < fm.bodyStartLine || insideBlock(lines, fm.bodyStartLine, line)) return undefined;
  const close = !/^[\w.-]*[ \t]*\}\}/.test(lineText.slice(column));
  return { from, close, names: variableNames(fm.data) };
}

/** Markdown describing the `{{name}}` at a zero-based line and column of a document, and its span on that line. */
export function variableHover(text: string, line: number, column: number): { markdown: string; start: number; end: number } | undefined {
  const fm = parseFrontMatter(text);
  const lines = text.split(/\r?\n/);
  if (line < fm.bodyStartLine || !lines[line]?.includes('{{')) return undefined;
  const ref = findVariables(lines.slice(0, line + 1), fm.bodyStartLine).find((r) => r.line === line && column >= r.column && column <= r.endColumn);
  if (!ref) return undefined;
  return { markdown: `**{{${ref.name}}}** — ${valueDescription(lookupVariable(fm.data, ref.name))}`, start: ref.column, end: ref.endColumn };
}

function valueDescription(value: VariableValue): string {
  if (value.kind === 'text') return `front matter value: ${codeSpan(value.text)}`;
  if (value.kind === 'undefined') return 'not defined in the front matter, so it is shown as written.';
  return 'the front matter value is not text (a mapping or an empty value), so it is shown as written.';
}

/** A Markdown code span that shows `s` exactly. */
function codeSpan(s: string): string {
  if (!s) return '(empty)';
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** The front matter of a document given as lines, reading only the front matter lines. */
export function documentVariables(lines: readonly string[]): Variables {
  if (lines[0]?.trimEnd() !== '---') return {};
  const end = lines.findIndex((l, i) => i > 0 && ['---', '...'].includes(l.trimEnd()));
  return end < 0 ? {} : parseFrontMatter(lines.slice(0, end + 1).join('\n')).data;
}
