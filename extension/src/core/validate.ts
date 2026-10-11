import katex from 'katex';
import { applyRuleSettings, applySuppressions, type RuleSettings } from './rules';
import { attrsToStyle, isStyleKey, parseAttrs, resolveColor, type AttrProblem, type Attrs } from './attrs';
import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo } from './containers';
import { parseFrontMatter } from './frontmatter';
import { dueState, HEADING_ATTRS, type Heading } from './render';
import { findFootnotes, type FootnoteDefinition, type FootnoteReference } from './footnotes';
import { anchorIds, findLinks, isDocumentPath, splitTarget } from './links';
import { checkIncludes, documentIds, includedFigureIds, includedTermIds } from './includeCheck';
import { parseFenceInfo, sliceLines } from './fence';
import { figureTargets, findRefs, type Figure, type FigureRef } from './figures';
import { compareVersions, findChangelogs, isIsoDate, parseVersion, versionKey, versionLabel, type ChangelogEntry, type Version } from './changelog';
import { findQuotes, quoteCite, type QuoteBlock } from './quote';
import { findGlossary, findTermUses, type GlossaryEntry, type GlossaryProblem } from './glossary';
import { parseSmd } from './parse';
import { sectionsOf, type Section } from './sections';
import { outsideCode } from './include';
import { findVariables, lookupVariable, substituteLine, variableNames, type Variables, type VariableUse } from './variables';
import { suggest } from './util';
import {
  attrKeyFix, attrValueFix, booleanValue, closeAtEndFix, frontMatterValueFix, normalizeDate, replaceOnceFix, uniqueSuggestion,
} from './fixes';
import {
  ALIGN_VALUES, FONT_VALUES, NAMED_COLORS, PRIORITY_VALUES, SIZE_VALUES, STYLE_KEYS, WEIGHT_VALUES,
  CONTAINERS, INLINE_DIRECTIVES, MERMAID_TYPES, SMD_VERSION, type InlineDirectiveSpec,
} from './spec';
import { FRONTMATTER_SCHEMA, frontMatterProperty } from './frontmatterSchema';
import { languageTag, matchLanguage, SUPPORTED_LANGUAGES } from './i18n';

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export interface Diagnostic {
  /** Zero-based line. */
  line: number;
  /** Zero-based start column. */
  column: number;
  /** Zero-based end column (exclusive). */
  endColumn: number;
  severity: Severity;
  /** Stable rule id, e.g. "container/unknown". Useful for agents and CI filters. */
  code: string;
  message: string;
  /** A machine-applicable fix: replace [column, endColumn) on `line` with `replacement`. */
  fix?: Fix;
}

export interface Fix {
  line: number;
  column: number;
  endColumn: number;
  replacement: string;
  title: string;
}

export interface ValidateOptions {
  /** Return true when a path (relative to the document) exists. Omit to skip link checks. */
  fileExists?: (relativePath: string) => boolean;
  /** Read a file relative to the document, for checking `file="…" lines="…"` embeds and `:::include` blocks. */
  readFile?: (relativePath: string) => string | undefined;
  /** "Today" as YYYY-MM-DD for overdue and stale checks. Defaults to the current date. */
  today?: string;
  /**
   * Report `frontmatter/stale` when `updated` is more than this many days before today and the
   * status is not archived or deprecated. Default 180; 0 turns the check off.
   */
  staleAfterDays?: number;
  /**
   * Rule settings, e.g. from `smd.config.json`: `{ "link/missing-file": "off", "frontmatter/*": "hint" }`.
   * Inline `<!-- smd-disable… -->` comments are always honored.
   */
  rules?: RuleSettings;
}

export function validateSmd(text: string, options: ValidateOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = text.split(/\r?\n/);
  const push: Push = (line, column, endColumn, severity, code, message, fix) =>
    diagnostics.push({ line, column, endColumn: Math.max(endColumn, column + 1), severity, code, message, ...(fix ? { fix } : {}) });
  const wholeLine = (line: number, severity: Severity, code: string, message: string) =>
    push(line, 0, lines[line]?.length ?? 1, severity, code, message);

  // --- Front matter -------------------------------------------------------
  const fm = parseFrontMatter(text);
  if (fm.error) wholeLine(fm.error.line, 'error', 'frontmatter/invalid', fm.error.message);
  if (fm.present && !fm.error) checkFrontMatter(fm.data, lines, fm.bodyStartLine, push, options);

  // --- Body ---------------------------------------------------------------
  interface Open { name: string; len: number; line: number }
  const stack: Open[] = [];
  let fence: { char: string; len: number; lang: string; info: string; line: number; content: string[] } | null = null;
  let mathStart = -1;
  let mathLines: string[] = [];
  let firstH1: { text: string; line: number } | null = null;

  for (let i = fm.bodyStartLine; i < lines.length; i++) {
    const raw = lines[i];

    // Fenced code: nothing inside is SMD syntax, except we check diagrams and math.
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence.char === '`' ? '`' : '~'}{${fence.len},}\\s*$`);
      if (close.test(raw)) {
        checkFence(fence.lang, fence.content, fence.line, push, wholeLine);
        checkEmbed(fence.info, fence.content, fence.line, lines[fence.line], push, options);
        fence = null;
      } else {
        fence.content.push(raw);
      }
      continue;
    }
    const fenceOpen = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/.exec(raw);
    if (fenceOpen) {
      fence = { char: fenceOpen[2][0], len: fenceOpen[2].length, lang: fenceOpen[3].toLowerCase(), info: raw.slice(fenceOpen[1].length + fenceOpen[2].length), line: i, content: [] };
      continue;
    }

    // Display math $$ … $$
    if (mathStart >= 0) {
      if (raw.trimEnd().endsWith('$$')) {
        mathLines.push(raw.trimEnd().slice(0, -2));
        checkMath(mathLines.join('\n'), mathStart, wholeLine);
        mathStart = -1;
        mathLines = [];
      } else {
        mathLines.push(raw);
      }
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith('$$')) {
      const rest = trimmed.slice(2);
      if (rest.endsWith('$$') && rest.length > 2) checkMath(rest.slice(0, -2), i, wholeLine);
      else { mathStart = i; mathLines = [rest]; }
      continue;
    }

    // Containers
    const close = CONTAINER_CLOSE.exec(raw);
    if (close) {
      // A bare ::: always closes the innermost open container.
      if (!stack.pop()) {
        wholeLine(i, 'warning', 'container/stray-close', `Closing "${close[2]}" has no matching opening container.`);
      }
      continue;
    }
    const open = CONTAINER_OPEN.exec(raw);
    if (open) {
      const len = open[2].length;
      const col = open[1].length;
      const info = parseContainerInfo(open[3] + open[4]);
      if (info) {
        const parent = stack[stack.length - 1];
        const nameStart = raw.indexOf(open[3], col + len);
        const nameEnd = nameStart + info.name.length;
        checkContainer(info, i, nameStart, nameEnd, parent?.name, push, raw);
        stack.push({ name: info.name, len, line: i });
      }
      continue;
    }

    // Headings
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h1 && !firstH1) firstH1 = { text: h1[1].replace(HEADING_ATTRS, ''), line: i };
    if (/^\s{0,3}#{1,6}\s/.test(raw)) checkHeadingAttrs(raw, i, push);

    // Open tasks that are past their due date
    const openTask = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s/.test(raw);
    const due = openTask ? /:due\[(\d{4}-\d{2}-\d{2})\]/.exec(raw) : null;
    if (due && dueState(due[1], options.today) === 'overdue') {
      push(i, due.index, due.index + due[0].length, 'info', 'task/overdue', `Open task is overdue (due ${due[1]}).`);
    }

    checkInline(raw, i, push, fm.data);
  }

  if (fence) {
    push(fence.line, 0, lines[fence.line].length, 'error', 'fence/unclosed', `Code block opened here is never closed with ${fence.char.repeat(fence.len)}.`,
      closeAtEndFix(lines, fence.line, fence.char.repeat(fence.len)));
  }
  if (mathStart >= 0) wholeLine(mathStart, 'error', 'math/unclosed', 'Display math "$$" is never closed.');
  for (const o of stack) {
    push(o.line, 0, lines[o.line].length, 'error', 'container/unclosed', `":::${o.name}" is never closed. Add a line with ${':'.repeat(o.len)} after its content.`,
      containerCloseFix(lines, o.line, o.len, fence, mathStart));
  }

  if (firstH1 && typeof fm.data.title === 'string' && firstH1.text.trim() === fm.data.title.trim()) {
    wholeLine(firstH1.line, 'hint', 'frontmatter/duplicate-title',
      'The front matter title is already rendered as the document heading; this "# heading" duplicates it.');
  }

  checkLinks(text, push, options);
  checkIncludes(text, (line, column, endColumn, code, message) => push(line, column, endColumn, 'warning', code, message), options);
  checkFigures(text, lines, fm.bodyStartLine, push, () => includedFigureIds(text, options.readFile));
  checkFootnotes(text, push);
  // Release headings and glossary terms are read with their `{{name}}` values in, as they render.
  const expanded = lines.map((l) => substituteLine(l, fm.data));
  const terms = checkGlossary({ lines, expanded }, fm.bodyStartLine, push, () => includedTermIds(text, options.readFile));
  checkTermIds(terms, text, lines, fm.bodyStartLine, push);
  for (const block of findChangelogs(expanded, fm.bodyStartLine)) checkChangelog(block.entries, lines, push);
  for (const quote of findQuotes(lines, fm.bodyStartLine)) checkQuote(quote, lines[quote.line], push);
  checkVariables(lines, fm.bodyStartLine, fm.data, push);
  checkAgentInSkipped(text, lines, fm.bodyStartLine, push);

  let result = applySuppressions(text, diagnostics);
  if (options.rules) result = applyRuleSettings(result, options.rules);
  return result.sort((a, b) => a.line - b.line || a.column - b.column);
}

type Push = (line: number, column: number, endColumn: number, severity: Severity, code: string, message: string, fix?: Fix) => void;
type WholeLine = (line: number, severity: Severity, code: string, message: string) => void;
type MarkKey = (key: string, severity: Severity, code: string, message: string, fix?: FrontMatterFix) => void;

/** A front matter key outside the schema, with a rename to the close standard key when there is one. */
function unknownKey(key: string, l: number, lines: string[], push: Push): void {
  const hint = suggest(key, Object.keys(FRONTMATTER_SCHEMA.properties));
  // Only offer the rename where the key is written as-is; never rewrite the `---` line.
  const found = l > 0;
  push(l, 0, found ? key.length : lines[0].length, 'hint', 'frontmatter/unknown-key',
    `"${key}" is not a standard front matter key${hint ? ` — did you mean "${hint}"?` : '.'} It is kept as custom metadata.`,
    hint && found ? { line: l, column: 0, endColumn: key.length, replacement: hint, title: `Change to "${hint}"` } : undefined);
}

/** Status values whose documents are not expected to be kept up to date. */
const RETIRED_STATUS = ['archived', 'deprecated'];

/** Front matter checks, driven by FRONTMATTER_SCHEMA. Keys outside the schema are custom metadata. */
function checkFrontMatter(
  data: Record<string, unknown>, lines: string[], end: number, push: Push, options: ValidateOptions,
): void {
  // The line that starts with `key:`, or 0 (the opening `---`) when YAML wrote it differently,
  // e.g. `"quoted":` or `[a]:`. Keys are escaped, since any text can be a YAML key.
  const keyLine = (key: string) => {
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
    for (let i = 1; i < end; i++) if (re.test(lines[i])) return i;
    return 0;
  };
  const markKey: MarkKey = (key, severity, code, message, fix) => {
    const l = keyLine(key);
    push(l, 0, lines[l]?.length ?? key.length, severity, code, message, fix?.(lines, l, key, String(data[key])));
  };

  if (data.smd === undefined) {
    push(0, 0, 3, 'info', 'frontmatter/version', `Add "smd: ${SMD_VERSION}" to the front matter so tools know which Styled Markdown version this file targets.`,
      { line: 1, column: 0, endColumn: 0, replacement: `smd: ${SMD_VERSION}\n`, title: `Add "smd: ${SMD_VERSION}"` });
  } else if (Number(data.smd) !== SMD_VERSION) {
    markKey('smd', 'warning', 'frontmatter/version', `Unsupported Styled Markdown version "${data.smd}". This tool supports version ${SMD_VERSION}.`);
  }

  // Custom keys the body shows with `{{key}}` are meant: no unknown-key hint for them.
  const shown = new Set(findVariables(lines, end).map((v) => v.name.split('.')[0]));
  for (const [key, value] of Object.entries(data)) {
    const prop = frontMatterProperty(key);
    if (!prop) {
      if (!shown.has(key)) unknownKey(key, keyLine(key), lines, push);
      continue;
    }
    if (key === 'smd' || key === 'lang' || value === undefined || value === null) continue;
    if (key === 'accent') {
      if (!resolveColor(String(value))) markKey(key, 'error', 'frontmatter/accent', `Invalid accent color "${value}".`, fixColorValue);
    } else if (prop.enum) {
      // Status is matched case-insensitively, as it always has been.
      const v = key === 'status' ? String(value).toLowerCase() : String(value);
      if (!prop.enum.map(String).includes(v)) {
        const code = key === 'status' ? 'frontmatter/status' : key === 'audience' ? 'frontmatter/audience' : 'frontmatter/value';
        markKey(key, 'warning', code, `Unknown ${key} "${value}". Use one of: ${prop.enum.join(', ')}.`, fixEnumValue(prop.enum.map(String)));
      }
    } else if (prop.anyOf?.some((a) => a.type === 'array')) {
      if (!Array.isArray(value) && typeof value !== 'string') markKey(key, 'warning', 'frontmatter/type', `"${key}" should be a list, e.g. ${key}: [a, b].`);
    } else if (prop.type === 'boolean') {
      if (typeof value !== 'boolean') markKey(key, 'warning', 'frontmatter/type', `"${key}" should be true or false.`, fixBooleanValue);
    } else if (prop.format === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}/.test(String(value))) markKey(key, 'warning', 'frontmatter/date', `"${key}" should be a date like 2026-09-26.`, fixDateValue);
    } else if (typeof value === 'object') {
      markKey(key, 'warning', 'frontmatter/type', `"${key}" should be a single value, not a list or a mapping.`);
    }
  }

  checkLanguage(data.lang, markKey);

  // Stale documents: `updated` long ago on a document that is still live.
  const staleAfter = options.staleAfterDays ?? 180;
  const updated = typeof data.updated === 'string' ? data.updated.slice(0, 10) : '';
  if (staleAfter > 0 && /^\d{4}-\d{2}-\d{2}$/.test(updated) && !RETIRED_STATUS.includes(String(data.status ?? '').toLowerCase())) {
    const today = options.today ?? new Date().toISOString().slice(0, 10);
    const days = Math.floor((Date.parse(today) - Date.parse(updated)) / 86_400_000);
    if (days > staleAfter) {
      markKey('updated', 'info', 'frontmatter/stale',
        `Last updated ${days} days ago (more than ${staleAfter}). Review the document and bump "updated", or set "status: archived".`);
    }
  }
}

/** `lang`: a language tag the renderer has labels for. Anything else is only information: labels render in English. */
function checkLanguage(value: unknown, markKey: MarkKey): void {
  if (value === undefined || value === null) return;
  const supported = `Supported: ${SUPPORTED_LANGUAGES.join(', ')}.`;
  const tag = languageTag(value);
  if (!tag) {
    markKey('lang', 'info', 'frontmatter/lang', `"lang" should be a language tag such as de or pt-BR; labels render in English. ${supported}`);
  } else if (!matchLanguage(tag)) {
    markKey('lang', 'info', 'frontmatter/lang', `No labels for language "${tag}" yet; they render in English. ${supported}`);
  }
}

/**
 * Close an unclosed container at the end of the document, unless a code block or `$$` math is still open there:
 * it would swallow the closing line, so that one is fixed first.
 */
function containerCloseFix(lines: string[], line: number, len: number, fence: object | null, mathStart: number): Fix | undefined {
  return fence || mathStart >= 0 ? undefined : closeAtEndFix(lines, line, ':'.repeat(len));
}

/** Builds the fix for a front matter value on line `line`, if one is unambiguous. */
type FrontMatterFix = (lines: string[], line: number, key: string, value: string) => Fix | undefined;

const fixEnumValue = (allowed: string[]): FrontMatterFix => (lines, line, key, value) =>
  frontMatterValueFix(lines, line, key, value, uniqueSuggestion(value, allowed));

const fixColorValue: FrontMatterFix = (lines, line, key, value) => frontMatterValueFix(lines, line, key, value, namedColor(value));

const fixDateValue: FrontMatterFix = (lines, line, key, value) => frontMatterValueFix(lines, line, key, value, normalizeDate(value));

/** `toc: "true"` or `toc: yes` → `toc: true` (unquoted). */
const fixBooleanValue: FrontMatterFix = (lines, line, key, value) =>
  frontMatterValueFix(lines, line, key, value, booleanValue(value), true);

/** The named color a misspelled color word meant, e.g. "bleu" or "Blue" → "blue". Never for #hex or rgb(). */
function namedColor(value: string): string | undefined {
  return /^[a-z]+$/i.test(value) ? uniqueSuggestion(value, NAMED_COLORS) : undefined;
}

/** Values of the single-word style keys, for fixing typos such as {weight=bld}. */
const STYLE_CHOICES: Record<string, readonly string[]> = {
  size: Object.keys(SIZE_VALUES), weight: Object.keys(WEIGHT_VALUES), font: Object.keys(FONT_VALUES), align: ALIGN_VALUES,
};
const COLOR_KEYS = new Set(['color', 'bg', 'border']);

/** Fix a misspelled style value in the attribute list in `text[start, end)`. `style` takes several words and is left alone. */
function styleFix(line: number, text: string, start: number, end: number, problem: AttrProblem): Fix | undefined {
  const { key = '', value = '' } = problem;
  const choices = STYLE_CHOICES[key] ?? [];
  const replacement = COLOR_KEYS.has(key) ? namedColor(value) : uniqueSuggestion(value, choices);
  return attrValueFix(line, text, start, end, key, value, replacement);
}

/** Replace a directive's `[content]`, e.g. :priority[hgh] → :priority[high]. */
function contentFix(line: number, text: string, col: number, name: string, content: string, replacement: string | undefined): Fix | undefined {
  const start = col + 1 + name.length;
  return replaceOnceFix(line, text, start, text.indexOf(']', start) + 1, content, replacement);
}

/** A due date written year-first with other separators or without zero padding, when that makes it valid. */
function dueDate(content: string): string | undefined {
  const date = normalizeDate(content);
  return date && dueState(date) !== 'invalid' ? date : undefined;
}

/**
 * Enumerated container attributes whose invalid values are reported under their own rule. `:::figure{kind}`
 * is a warning: before 1.6 such a document only had a `container/unknown` warning and passed validation.
 */
const ENUM_VALUE_RULES = new Map<string, { severity: Severity; code: string }>([
  ['figure.kind', { severity: 'warning', code: 'figure/kind' }],
]);

/** The rule for an invalid value of an enumerated container attribute: `attrs/value` (error) unless listed above. */
function enumValueRule(container: string, key: string): { severity: Severity; code: string } {
  return ENUM_VALUE_RULES.get(`${container}.${key}`) ?? { severity: 'error', code: 'attrs/value' };
}

function checkContainer(
  info: NonNullable<ReturnType<typeof parseContainerInfo>>,
  line: number, nameStart: number, nameEnd: number, parent: string | undefined, push: Push, raw: string,
): void {
  const spec = CONTAINERS[info.name];
  if (!spec) {
    const hint = suggest(info.name, Object.keys(CONTAINERS));
    push(line, nameStart, nameEnd, 'warning', 'container/unknown',
      `Unknown container ":::${info.name}"${hint ? ` — did you mean ":::${hint}"?` : '.'} It will render as a plain box.`,
      hint ? { line, column: nameStart, endColumn: nameEnd, replacement: hint, title: `Change to ":::${hint}"` } : undefined);
    return;
  }
  if (info.attrsError) push(line, nameEnd, nameEnd + 1, 'error', 'attrs/syntax', info.attrsError);
  if (spec.parent && parent !== spec.parent) {
    push(line, nameStart, nameEnd, 'warning', 'container/parent',
      `":::${info.name}" should be placed directly inside "::::${spec.parent}".`);
  }
  const allowed = new Set([...(spec.attrs ?? []), 'title']);
  const keys = Object.keys(info.attrs.values);
  for (const key of keys) {
    if (!allowed.has(key) && !isStyleKey(key)) {
      push(line, nameStart, nameEnd, 'warning', 'attrs/unknown', `Unknown attribute "${key}" on ":::${info.name}".`,
        attrKeyFix(line, raw, nameEnd, raw.length, key, [...allowed, ...Object.keys(STYLE_KEYS)], keys));
    }
  }
  for (const p of attrsToStyle(info.attrs, true).problems) {
    push(line, nameStart, nameEnd, p.severity, 'attrs/value', p.message, styleFix(line, raw, nameEnd, raw.length, p));
  }
  for (const [key, allowed] of Object.entries(spec.values ?? {})) {
    const v = info.attrs.values[key];
    if (v !== undefined && !allowed.some((a) => a.toLowerCase() === v.toLowerCase())) {
      const hint = suggest(v, allowed);
      const rule = enumValueRule(info.name, key);
      push(line, nameStart, nameEnd, rule.severity, rule.code, `Invalid ${key} "${v}" on ":::${info.name}"${hint ? ` — did you mean "${hint}"?` : '.'} Use one of: ${allowed.join(', ')}.`,
        attrValueFix(line, raw, nameEnd, raw.length, key, v, uniqueSuggestion(v, allowed)));
    }
  }
  for (const key of spec.required ?? []) {
    if (info.attrs.values[key] === undefined) {
      const example = info.name === 'api' ? ':::api{method=GET path="/v1/items"}' : `{${key}=…}`;
      push(line, nameStart, nameEnd, 'error', 'attrs/required', `":::${info.name}" needs a ${key} attribute, e.g. ${example}.`);
    }
  }
  if (info.attrs.values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(info.attrs.values.date)) {
    push(line, nameStart, nameEnd, 'warning', 'attrs/value', '"date" should look like 2026-09-26.',
      attrValueFix(line, raw, nameEnd, raw.length, 'date', info.attrs.values.date, normalizeDate(info.attrs.values.date)));
  }
  const width = info.attrs.values.width;
  if (info.name === 'column' && width && !/^\d+(\.\d+)?%?$/.test(width)) {
    push(line, nameStart, nameEnd, 'error', 'attrs/value', `Invalid column width "${width}". Use a percentage (30%) or a ratio (2).`);
  }
  if (info.name === 'card' && info.attrs.values.accent && !resolveColor(info.attrs.values.accent)) {
    push(line, nameStart, nameEnd, 'error', 'attrs/value', `Invalid accent color "${info.attrs.values.accent}".`,
      attrValueFix(line, raw, nameEnd, raw.length, 'accent', info.attrs.values.accent, namedColor(info.attrs.values.accent)));
  }
}

function checkInline(raw: string, line: number, push: Push, variables: Variables): void {
  // Blank out inline code so its contents are never treated as syntax.
  const text = raw.replace(/(`+)([\s\S]*?)\1/g, (m) => ' '.repeat(m.length));

  const at: InlineAt = { line, text, push };

  // :directive[content]{attrs}
  const directiveSpans: Array<[number, number]> = [];
  for (const m of text.matchAll(/(^|[\s([{>*_~"'-]):([a-z][a-z0-9-]*)(\[[^\]\n]*\])?(\{[^{}\n]*\})?/g)) {
    if (!m[3] && !m[4]) continue;
    const col = m.index! + m[1].length;
    const end = col + m[0].length - m[1].length;
    directiveSpans.push([col, end]);
    checkDirective(at, { name: m[2], col, end, content: m[3], attrList: m[4] }, variables);
  }
  checkStyledSpans(at, directiveSpans);
}

/** Where an inline check reports: the line, its text with inline code blanked out, and the push. */
interface InlineAt { line: number; text: string; push: Push }

/** One `:name[content]{attrs}` on the line: `content` and `attrList` keep their brackets. */
interface DirectiveUse { name: string; col: number; end: number; content?: string; attrList?: string }

function checkDirective(at: InlineAt, d: DirectiveUse, variables: Variables): void {
  const { line, push } = at;
  const spec = INLINE_DIRECTIVES[d.name];
  if (!spec) { unknownDirective(at, d); return; }
  if (spec.content && !d.content) push(line, d.col, d.end, 'error', 'directive/content', `":${d.name}" needs content in brackets, e.g. ${spec.example}.`);
  const attrs = d.attrList ? parseAttrs(d.attrList.slice(1, -1)) : null;
  if (d.attrList && !attrs) { push(line, d.col, d.end, 'error', 'attrs/syntax', 'Malformed attribute list.'); return; }
  // Checked with front matter variables replaced: :due[{{deadline}}] is the date in "deadline".
  const content = substituteLine(d.content?.slice(1, -1) ?? '', variables).trim();
  checkDirectiveContent(at, d, content, attrs);
  if (attrs) checkDirectiveAttrs(at, d, spec, attrs);
}

/** Only flag names that look intentional, e.g. ":badg[..]" — not "see:[link]". */
function unknownDirective({ line, push }: InlineAt, { name, col, end }: DirectiveUse): void {
  const hint = suggest(name, Object.keys(INLINE_DIRECTIVES));
  if (!hint) return;
  push(line, col, end, 'warning', 'directive/unknown', `Unknown inline directive ":${name}" — did you mean ":${hint}"?`,
    { line, column: col + 1, endColumn: col + 1 + name.length, replacement: hint, title: `Change to ":${hint}"` });
}

function checkDirectiveContent({ line, text, push }: InlineAt, { name, col, end }: DirectiveUse, content: string, attrs: Attrs | null): void {
  if (name === 'priority' && content && !PRIORITY_VALUES.some((v) => v.toLowerCase() === content.toLowerCase())) {
    push(line, col, end, 'warning', 'attrs/value', `Unknown priority "${content}". Use one of: ${PRIORITY_VALUES.join(', ')}.`,
      contentFix(line, text, col, name, content, uniqueSuggestion(content, PRIORITY_VALUES)));
  }
  if (name === 'due' && content && dueState(content) === 'invalid') {
    push(line, col, end, 'error', 'attrs/value', `Due date "${content}" should look like 2026-10-15.`, contentFix(line, text, col, name, content, dueDate(content)));
  }
  if (name === 'metric' && !attrs?.values.label) {
    push(line, col, end, 'warning', 'attrs/required', `":metric" should have a label, e.g. :metric[${content || '42%'}]{label="Activation"}.`);
  }
}

function checkDirectiveAttrs(at: InlineAt, d: DirectiveUse, spec: InlineDirectiveSpec, attrs: Attrs): void {
  const keys = Object.keys(attrs.values);
  for (const [key, value] of Object.entries(attrs.values)) checkDirectiveAttr(at, d, spec, { key, value, keys });
}

/** One attribute of a directive: an allowed value, an accepted key, a color, a progress value. */
function checkDirectiveAttr(
  { line, text, push }: InlineAt, { name, col, end }: DirectiveUse, spec: InlineDirectiveSpec, { key, value, keys }: { key: string; value: string; keys: string[] },
): void {
  const allowed = spec.values?.[key];
  if (allowed && !allowed.includes(value)) {
    push(line, col, end, 'error', 'attrs/value', `Invalid ${key} "${value}" for ":${name}". Use one of: ${allowed.join(', ')}.`,
      attrValueFix(line, text, col, end, key, value, uniqueSuggestion(value, allowed)));
  } else if (!spec.attrs.includes(key)) {
    push(line, col, end, 'warning', 'attrs/unknown', `":${name}" does not take "${key}". Accepted: ${spec.attrs.join(', ') || 'none'}.`,
      attrKeyFix(line, text, col, end, key, spec.attrs, keys));
  } else if (key === 'color' && !resolveColor(value)) {
    push(line, col, end, 'error', 'attrs/value', `Invalid color "${value}".`, attrValueFix(line, text, col, end, key, value, namedColor(value)));
  } else if (key === 'value') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100) push(line, col, end, 'error', 'attrs/value', `Progress value must be a number from 0 to 100, got "${value}".`);
  }
}

/** `[text]{attrs}` styled spans; the attribute lists that belong to directives are skipped. */
function checkStyledSpans({ line, text, push }: InlineAt, directiveSpans: Array<[number, number]>): void {
  for (const m of text.matchAll(/\]\{([^{}\n]*)\}/g)) {
    const col = m.index! + 1;
    const end = col + m[0].length - 1;
    if (directiveSpans.some(([s, e]) => col > s && col < e)) continue;
    const attrs = parseAttrs(m[1]);
    if (!attrs) { push(line, col, end, 'error', 'attrs/syntax', 'Malformed attribute list. Expected {key=value key2="value 2" .class}.'); continue; }
    const keys = Object.keys(attrs.values);
    for (const key of keys) {
      if (!isStyleKey(key)) {
        push(line, col, end, 'warning', 'attrs/unknown', `Unknown style attribute "${key}". Known: color, bg, border, size, weight, font, style.`,
          attrKeyFix(line, text, col, end, key, Object.keys(STYLE_KEYS), keys));
      }
    }
    for (const p of attrsToStyle(attrs).problems) push(line, col, end, p.severity, 'attrs/value', p.message, styleFix(line, text, col, end, p));
  }
}

/**
 * Links, images, reference definitions, HTML href/src and `related:` entries must resolve: `#anchor` to an
 * id in this document, relative paths to existing files and `file.smd#anchor` to an id in that file.
 * File checks run only when `fileExists` is given; anchors in other files also need `readFile`.
 */
function checkLinks(text: string, push: Push, options: ValidateOptions): void {
  const { links, references, definitions } = findLinks(text);
  let ownIds: Set<string> | undefined;
  const otherIds = new Map<string, Set<string> | undefined>();
  const idsIn = (path: string): Set<string> | undefined => {
    if (!otherIds.has(path)) {
      const other = options.readFile?.(path);
      otherIds.set(path, other === undefined ? undefined : anchorIds(other));
    }
    return otherIds.get(path);
  };

  // `:::include` files have their own checks (includeCheck.ts).
  for (const link of links.filter((l) => l.kind !== 'include')) {
    const parts = splitTarget(link.target);
    if (!parts) continue;
    const { line, column } = link;
    const end = column + link.target.length;
    if (!parts.path) {
      if (!parts.anchor) continue;
      ownIds ??= documentIds(text, options.readFile);
      if (!ownIds.has(parts.anchor)) {
        missingAnchor(parts.anchor, ownIds, 'in this document', link.target, line, column, end, push);
      }
      continue;
    }
    if (!options.fileExists) continue;
    if (!options.fileExists(parts.path)) {
      const where = link.kind === 'related' ? ' (listed in "related")' : '';
      push(line, column, end, 'warning', 'link/missing-file', `"${parts.path}" does not exist${where}.`);
      continue;
    }
    if (parts.anchor && isDocumentPath(parts.path)) {
      const ids = idsIn(parts.path);
      if (ids && !ids.has(parts.anchor)) {
        missingAnchor(parts.anchor, ids, `in "${parts.path}"`, link.target, line, column, end, push);
      }
    }
  }

  for (const ref of references) {
    if (!definitions.has(ref.label)) {
      push(ref.line, ref.column, ref.endColumn, 'warning', 'link/undefined-reference',
        `No definition for the reference "[${ref.label}]". Add a line like "[${ref.label}]: https://…" or use an inline link.`);
    }
  }
}

/**
 * Footnotes: every `[^label]` needs a definition, and each definition a reference and a label of its own.
 * Without any definition in the document, `[^x]` is as likely plain text (a regex class such as `[^a-z]`),
 * so an undefined reference is only `info` then.
 */
function checkFootnotes(text: string, push: Push): void {
  const { definitions, references } = findFootnotes(text);
  const defined = new Map<string, FootnoteDefinition>();
  for (const d of definitions) {
    const first = defined.get(d.label);
    if (first) {
      push(d.line, d.column, d.endColumn, 'warning', 'footnote/duplicate',
        `Footnote "[^${d.raw}]" is already defined on line ${first.line + 1}; this definition is ignored.`);
    } else {
      defined.set(d.label, d);
    }
  }
  const labels = [...defined.values()].map((d) => d.raw);
  for (const r of references) {
    if (!defined.has(r.label)) undefinedFootnote(r, labels, push);
  }
  const used = new Set(references.map((r) => r.label));
  for (const d of defined.values()) {
    if (!used.has(d.label)) {
      push(d.line, d.column, d.endColumn, 'info', 'footnote/unused', `Footnote "[^${d.raw}]" is never referenced, so it is not shown.`);
    }
  }
}

function undefinedFootnote(ref: FootnoteReference, labels: string[], push: Push): void {
  const hint = uniqueSuggestion(ref.raw, labels);
  const column = ref.column + 2;
  push(ref.line, ref.column, ref.endColumn, labels.length ? 'warning' : 'info', 'footnote/undefined',
    `No definition for the footnote "[^${ref.raw}]"${hint ? ` — did you mean "[^${hint}]"?` : '.'} Add a line like "[^${ref.raw}]: …"; until then it shows as plain text.`,
    hint ? { line: ref.line, column, endColumn: column + ref.raw.length, replacement: hint, title: `Change to "[^${hint}]"` } : undefined);
}

function missingAnchor(
  anchor: string, ids: Set<string>, where: string, target: string,
  line: number, column: number, end: number, push: Push,
): void {
  const hint = suggest(anchor, [...ids]);
  const fixed = hint ? target.slice(0, target.indexOf('#') + 1) + hint : undefined;
  push(line, column, end, 'warning', 'link/missing-anchor',
    `No heading or element with id "${anchor}" ${where}${hint ? ` — did you mean "#${hint}"?` : '.'}`,
    fixed ? { line, column, endColumn: end, replacement: fixed, title: `Change to "${fixed}"` } : undefined);
}

/** Figure ids are unique, and every `:ref[id]` names a figure of this document. */
/** Figure ids and `:ref[id]` references; `included` lists the ids of figures brought in by `:::include`. */
function checkFigures(text: string, lines: string[], bodyStart: number, push: Push, included: () => Set<string>): void {
  const figures = parseSmd(text).figures;
  const targets = figureTargets(figures);
  for (const f of figures) {
    const first = f.id ? targets.get(f.id) : undefined;
    if (first && first !== f) duplicateFigure(f, first, lines[f.line], push);
  }
  let fromIncludes: Set<string> | undefined;
  for (const ref of findRefs(lines, bodyStart)) {
    if (targets.has(ref.id)) continue;
    fromIncludes ??= included();
    if (!fromIncludes.has(ref.id)) unknownRef(ref, [...targets.keys(), ...fromIncludes], push);
  }
}

/**
 * `{{name}}` in the body names a front matter key with a text value. Undefined names are only `info`: until
 * 1.6, `{{…}}` was plain text (templates, Handlebars or Jinja examples), so it must not start failing checks.
 */
function checkVariables(lines: string[], bodyStart: number, data: Variables, push: Push): void {
  const uses = findVariables(lines, bodyStart);
  if (!uses.length) return;
  const names = [...new Set([...Object.keys(data), ...variableNames(data).map((v) => v.name)])];
  for (const use of uses) {
    const value = lookupVariable(data, use.name);
    if (value.kind === 'undefined') undefinedVariable(use, lines[use.line], names, push);
    else if (value.kind === 'not-text') {
      push(use.line, use.column, use.endColumn, 'warning', 'variable/not-text',
        `"${use.name}" in the front matter is a mapping or has no value, so {{${use.name}}} is shown as written. Use a key with a text, number or list value${nestedHint(data, use.name)}.`);
    }
  }
}

/** ", e.g. {{owner.name}}" when the name is a mapping with text values. */
function nestedHint(data: Variables, name: string): string {
  const nested = variableNames(data).find((v) => v.name.startsWith(`${name}.`));
  return nested ? `, e.g. {{${nested.name}}}` : '';
}

function undefinedVariable(use: VariableUse, raw: string, names: string[], push: Push): void {
  const hint = suggest(use.name, names);
  const start = raw.indexOf(use.name, use.column);
  push(use.line, use.column, use.endColumn, 'info', 'variable/undefined',
    `"${use.name}" is not defined in the front matter, so {{${use.name}}} is shown as written${hint ? ` — did you mean "${hint}"?` : '.'} Add "${use.name}: …" to the front matter, or write \\{{${use.name}}} to keep the braces.`,
    hint ? { line: use.line, column: start, endColumn: start + use.name.length, replacement: hint, title: `Change to "{{${hint}}}"` } : undefined);
}

function duplicateFigure(figure: Figure, first: Figure, raw: string, push: Push): void {
  const at = raw.indexOf(`#${figure.id}`);
  const [column, end] = at < 0 ? [0, raw.length] : [at, at + figure.id!.length + 1];
  push(figure.line, column, end, 'warning', 'figure/duplicate-id',
    `The figure on line ${first.line + 1} already has the id "${figure.id}"; :ref[${figure.id}] refers to that one. Give this figure its own id.`);
}

function unknownRef(ref: FigureRef, ids: string[], push: Push): void {
  const hint = ref.id ? suggest(ref.id, ids) : undefined;
  const start = ref.column + ':ref['.length;
  push(ref.line, ref.column, ref.endColumn, 'warning', 'figure/unknown-ref',
    `No figure with id "${ref.id}" in this document${hint ? ` — did you mean "${hint}"?` : '.'} Give a :::figure that id with {#${ref.id || 'fig-id'}}.`,
    hint ? { line: ref.line, column: start, endColumn: ref.endColumn - 1, replacement: hint, title: `Change to ":ref[${hint}]"` } : undefined);
}

/**
 * Glossary entries are `**Term**: definition` items, each term is defined once, and each is used in the text;
 * `included` gives the terms used in included text (rendering it only when a term is not used otherwise). A use in
 * a `{{name}}` value counts, as rendering marks it: uses are found in the lines as written and with the values in.
 */
function checkGlossary(text: { lines: string[]; expanded: string[] }, bodyStart: number, push: Push, included: () => Set<string>): GlossaryEntry[] {
  const { lines, expanded } = text;
  const glossary = findGlossary(lines, bodyStart);
  for (const problem of glossary.problems) glossaryProblem(problem, push);
  const first = new Map<string, GlossaryEntry>();
  for (const entry of glossary.entries) {
    const earlier = first.get(entry.id);
    if (earlier) {
      push(entry.line, entry.column, entry.endColumn, 'warning', 'glossary/duplicate',
        `"${entry.term}" is already defined on line ${earlier.line + 1}; its uses link to that definition. Remove or merge this entry.`);
    } else {
      first.set(entry.id, entry);
    }
  }
  if (!first.size) return [];
  const used = new Set(findTermUses(lines, bodyStart, glossary).map((u) => u.entry.id));
  if (expanded.some((l, i) => l !== lines[i])) {
    for (const use of findTermUses(expanded, bodyStart, glossary)) used.add(use.entry.id);
  }
  const unused = [...first.values()].filter((e) => !used.has(e.id));
  const usedInIncludes = unused.length ? included() : new Set<string>();
  for (const entry of unused) {
    if (!usedInIncludes.has(entry.id)) {
      push(entry.line, entry.column, entry.endColumn, 'info', 'glossary/unused', `"${entry.term}" is defined in the glossary but never used in the text.`);
    }
  }
  return [...first.values()];
}

/** Where an id is given to something other than a glossary term: the zero-based line, and what has it. */
interface IdOwner { line: number; what: 'heading' | 'element' }

/**
 * A term's definition has the id `term-{slug}`. When a heading or another element has the same id, links to it and
 * the term's uses may go to the wrong one. Ids never change silently (inbound links keep working), so this warns
 * instead: the author gives the other element its own `{#id}` or renames one of them.
 */
function checkTermIds(terms: GlossaryEntry[], text: string, lines: string[], bodyStart: number, push: Push): void {
  if (!terms.length) return;
  const owners = termLikeIds(parseSmd(text).headings, lines, bodyStart);
  for (const entry of terms) {
    const owner = owners.get(entry.id);
    if (!owner) continue;
    push(entry.line, entry.column, entry.endColumn, 'warning', 'glossary/duplicate-id',
      `The definition of "${entry.term}" gets the id "${entry.id}", which the ${owner.what} on line ${owner.line + 1} also has, so links to #${entry.id} and the uses of "${entry.term}" may lead there. Give the ${owner.what} its own id with {#…}, or rename one of them.`);
  }
}

/** Ids starting with `term-` that headings, attribute lists or raw HTML give, outside code, with their first owner. */
function termLikeIds(headings: Heading[], lines: string[], bodyStart: number): Map<string, IdOwner> {
  const owners = new Map<string, IdOwner>();
  const add = (id: string, owner: IdOwner) => {
    if (id.startsWith('term-') && !owners.has(id)) owners.set(id, owner);
  };
  for (const h of headings) add(h.slug, { line: h.line, what: 'heading' });
  for (const [i, fence] of outsideCode(lines, bodyStart, lines.length - 1)) {
    if (fence || !lines[i].includes('term-')) continue;
    for (const id of explicitIds(lines[i])) add(id, { line: i, what: 'element' });
  }
  return owners;
}

/** The ids a line gives in attribute lists (`{#id}`) and raw HTML (`id="…"`), outside inline code. */
function explicitIds(raw: string): string[] {
  const line = raw.replaceAll(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length));
  const fromAttrs = [...line.matchAll(/\{([^{}]*)\}/g)].flatMap((m) => [...m[1].matchAll(/(?:^|\s)#([^\s{}]+)/g)].map((id) => id[1]));
  const fromHtml = line.includes('<') ? [...line.matchAll(/\s(?:id|name)=["']([^"']+)["']/g)].map((m) => m[1]) : [];
  return [...fromAttrs, ...fromHtml];
}

/**
 * `:::agent` instructions inside a section whose heading has `{agent=skip}`: the agent view leaves the whole section
 * out, so agents never read them. A warning only; rendering is not affected.
 */
function checkAgentInSkipped(text: string, lines: string[], bodyStart: number, push: Push): void {
  const skipped = sectionsOf(parseSmd(text).headings, lines.length).filter((s) => s.heading.agent === 'skip');
  if (!skipped.length) return;
  for (const [i, fence] of outsideCode(lines, bodyStart, lines.length - 1)) {
    const section = fence ? undefined : skippedSection(lines[i], i, skipped);
    if (section) agentInSkipped(lines[i], i, section, push);
  }
}

/** The outermost skipped section that the `:::agent` opening on `line` is in, if it opens one. */
function skippedSection(raw: string, line: number, skipped: Section[]): Section | undefined {
  const open = CONTAINER_OPEN.exec(raw);
  if (!open || parseContainerInfo(open[3] + open[4])?.name !== 'agent') return undefined;
  return skipped.find((s) => line > s.start && line <= s.end);
}

function agentInSkipped(raw: string, line: number, section: Section, push: Push): void {
  const column = raw.indexOf('agent');
  push(line, column, column + 'agent'.length, 'warning', 'container/agent-in-skip',
    `This :::agent block is in the section "${section.heading.text}" (line ${section.start + 1}), whose heading has {agent=skip}, so agent views leave it out and agents never read these instructions. Move the block out of that section, or remove agent=skip from the heading.`);
}

function glossaryProblem(problem: GlossaryProblem, push: Push): void {
  const message = problem.kind === 'empty'
    ? 'This glossary entry has no definition; write it after the colon.'
    : 'Glossary entries are list items written "**Term**: definition". This item is not one, so its list renders as a plain list and defines no terms.';
  push(problem.line, problem.column, problem.endColumn, 'warning', 'glossary/entry', message);
}

/** A changelog's entries: dates are YYYY-MM-DD, versions run newest first, and each version appears once. */
function checkChangelog(entries: ChangelogEntry[], lines: string[], push: Push): void {
  const seen = new Map<string, ChangelogEntry>();
  let previous: { entry: ChangelogEntry; version: Version } | undefined;
  for (const entry of entries) {
    if (entry.date !== undefined && !isIsoDate(entry.date)) changelogDate(entry, lines[entry.line], push);
    const key = versionKey(entry.version);
    const first = seen.get(key);
    if (first) {
      push(entry.line, entry.column, lines[entry.line].length, 'warning', 'changelog/duplicate',
        `Version ${versionLabel(entry.version)} is already listed on line ${first.line + 1}. Merge the two entries.`);
      continue;
    }
    seen.set(key, entry);
    const version = parseVersion(entry.version);
    if (!version) continue;
    if (previous && compareVersions(version, previous.version) > 0) {
      push(entry.line, entry.column, lines[entry.line].length, 'warning', 'changelog/order',
        `Version ${versionLabel(entry.version)} is newer than ${versionLabel(previous.entry.version)} on line ${previous.entry.line + 1}. List releases newest first.`);
    }
    previous = { entry, version };
  }
}

function changelogDate(entry: ChangelogEntry, raw: string, push: Push): void {
  const date = entry.date!;
  const message = `"${date}" is not a date like 2026-03-01; release headings are written "## 1.2.0 — 2026-03-01".`;
  const column = raw.lastIndexOf(date);
  // A date from a {{name}} value is not in the line: mark the heading, with no fix to the text.
  if (column < 0) { push(entry.line, entry.column, raw.length, 'warning', 'changelog/date', message); return; }
  const fixed = normalizeDate(date);
  const valid = fixed && isIsoDate(fixed) ? fixed : undefined;
  push(entry.line, column, column + date.length, 'warning', 'changelog/date', message,
    valid ? { line: entry.line, column, endColumn: column + date.length, replacement: valid, title: `Change to "${valid}"` } : undefined);
}

/** A quote has text, says who said it, and cites only http(s) or relative URLs. */
function checkQuote(quote: QuoteBlock, raw: string, push: Push): void {
  const name = raw.indexOf('quote');
  const [column, end] = [name, name + 'quote'.length];
  const { author, cite } = quote.info.attrs.values;
  if (quote.empty) push(quote.line, column, end, 'warning', 'quote/empty', 'This quote has no text; write the quotation between ":::quote" and ":::".');
  if (!author?.trim()) {
    push(quote.line, column, end, 'warning', 'quote/author', 'Say who is quoted with author="…" (and source="…" for where), e.g. :::quote{author="Ada Lovelace"}.');
  }
  if (cite !== undefined && !quoteCite(cite)) {
    push(quote.line, column, end, 'warning', 'quote/cite', `cite="${cite}" is left out: it must be an http(s) or relative URL without spaces.`);
  }
}

function checkFence(lang: string, content: string[], line: number, push: Push, wholeLine: WholeLine): void {
  if (lang === 'mermaid') {
    let inConfig = false;
    for (const [offset, l] of content.entries()) {
      const t = l.trim();
      if (t === '---') { inConfig = !inConfig; continue; }
      if (inConfig || !t || t.startsWith('%%')) continue;
      const kind = t.split(/[\s;:]/)[0];
      if (!MERMAID_TYPES.includes(kind)) {
        const hint = suggest(kind, MERMAID_TYPES);
        const at = line + 1 + offset;
        const col = l.indexOf(kind);
        push(at, col, col + kind.length, 'error', 'mermaid/type', `Unknown Mermaid diagram type "${kind}"${hint ? ` — did you mean "${hint}"?` : '.'}`,
          hint ? { line: at, column: col, endColumn: col + kind.length, replacement: hint, title: `Change to "${hint}"` } : undefined);
      }
      return;
    }
    wholeLine(line, 'warning', 'mermaid/empty', 'Empty Mermaid diagram.');
  } else if (lang === 'math' || lang === 'latex' || lang === 'katex') {
    checkMath(content.join('\n'), line, wholeLine);
  }
}

/** KaTeX results by formula, so re-validating after an edit only checks formulas that changed. */
const mathResults = new Map<string, string | null>();

function checkMath(tex: string, line: number, wholeLine: WholeLine): void {
  let error = mathResults.get(tex);
  if (error === undefined) {
    try {
      katex.renderToString(tex, { displayMode: true, throwOnError: true });
      error = null;
    } catch (e) {
      error = (e as Error).message.replace(/^KaTeX parse error:\s*/, '');
    }
    if (mathResults.size >= 1000) mathResults.clear();
    mathResults.set(tex, error);
  }
  if (error !== null) wholeLine(line, 'error', 'math/syntax', `Math error: ${error}`);
}

function checkHeadingAttrs(raw: string, line: number, push: Push): void {
  const m = HEADING_ATTRS.exec(raw);
  if (!m) return;
  const col = m.index + m[0].indexOf('{');
  const end = col + m[1].length + 2;
  const attrs = parseAttrs(m[1]);
  if (!attrs) { push(line, col, end, 'error', 'attrs/syntax', 'Malformed heading attribute list. Expected {#id .class agent=skip}.'); return; }
  const keys = Object.keys(attrs.values);
  for (const [key, value] of Object.entries(attrs.values)) {
    if (key !== 'agent') {
      push(line, col, end, 'warning', 'attrs/unknown', `Unknown heading attribute "${key}". Headings accept #id, .class and agent=skip.`,
        attrKeyFix(line, raw, col, end, key, ['agent'], keys));
    } else if (value !== 'skip') {
      push(line, col, end, 'error', 'attrs/value', `agent="${value}" is not supported on headings — use agent=skip to hide the section from agent views.`,
        attrValueFix(line, raw, col, end, key, value, uniqueSuggestion(value, ['skip'])));
    }
  }
}

function checkEmbed(info: string, content: string[], line: number, raw: string, push: Push, options: ValidateOptions): void {
  const fence = parseFenceInfo(info);
  const at = (s: string): [number, number] => { const c = raw.indexOf(s); return c < 0 ? [0, raw.length] : [c, c + s.length]; };
  for (const problem of fence.problems) push(line, 0, raw.length, 'error', 'fence/range', problem);
  if (fence.lines && !fence.file) push(line, ...at('lines='), 'warning', 'fence/lines-without-file', '"lines" only applies together with file="…".');
  if (!fence.file) return;
  const [c0, c1] = at(fence.file);
  if (content.some((l) => l.trim())) {
    push(line, c0, c1, 'warning', 'fence/embed-body', 'This code block embeds a file, so its own content is ignored. Leave the block empty.');
  }
  if (options.readFile) {
    const text = options.readFile(fence.file);
    if (text === undefined) {
      push(line, c0, c1, 'error', 'fence/embed-missing', `Cannot embed "${fence.file}": the file does not exist or is outside the workspace.`);
    } else if (fence.lines && sliceLines(text, fence.lines).outOfRange) {
      const total = text.replace(/\n$/, '').split(/\r?\n/).length;
      push(line, ...at(fence.linesRaw ?? 'lines='), 'error', 'fence/range', `lines="${fence.linesRaw}" is outside "${fence.file}", which has ${total} lines.`);
    }
  } else if (options.fileExists && !options.fileExists(fence.file)) {
    push(line, c0, c1, 'error', 'fence/embed-missing', `Cannot embed "${fence.file}": the file does not exist.`);
  }
}

/**
 * Apply every diagnostic fix to the text (bottom-up, skipping overlaps). Returns the new text and the count applied.
 * Adjacent edits all apply. Insertions at one point are written in diagnostic order reversed, so closings added
 * at the end of the document close the innermost (latest opened) block first.
 */
export function applyFixes(text: string, diagnostics: Diagnostic[]): { text: string; applied: number } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const fixes = diagnostics
    .flatMap((d) => (d.fix ? [{ at: d, fix: d.fix }] : []))
    .sort(bottomUp)
    .map((f) => f.fix);
  let applied = 0;
  let last: Fix | undefined;
  for (const f of fixes) {
    if (last && last.line === f.line && f.endColumn > last.column) continue; // overlapping
    const l = lines[f.line] ?? '';
    const replaced = l.slice(0, f.column) + f.replacement + l.slice(f.endColumn);
    lines.splice(f.line, 1, ...replaced.split('\n'));
    applied++;
    last = f;
  }
  return { text: lines.join(eol), applied };
}

/** Last fix first; a replacement before an insertion at its start; tied insertions in diagnostic order. */
function bottomUp(a: { at: Diagnostic; fix: Fix }, b: { at: Diagnostic; fix: Fix }): number {
  return b.fix.line - a.fix.line || b.fix.column - a.fix.column || b.fix.endColumn - a.fix.endColumn
    || a.at.line - b.at.line || a.at.column - b.at.column;
}
