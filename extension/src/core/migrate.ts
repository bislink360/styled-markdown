import type { Token } from 'markdown-it';
import { escapeQuoted, findAttrsEnd, isFlagItem, itemValue, lexAttrItems, parseAttrs, type Attrs } from './attrs';
import { CONTAINER_OPEN, isKnownContainer, parseContainerInfo } from './containers';
import { attrValueFix, frontMatterValueFix } from './fixes';
import { parseFrontMatter, type FrontMatter } from './frontmatter';
import { FRONTMATTER_SCHEMA } from './frontmatterSchema';
import { EN } from './i18n';
import { codeLines, inlineMathLines, literalLines, mathOnLine, type InlineMathLines } from './parse';
import { createMarkdownIt, HEADING_ATTRS, type Env } from './render';
import { CONTAINERS, INLINE_DIRECTIVES } from './spec';
import { readSpec } from './specVersion';
import { AGENT_PRIORITY_REMOVED } from './v2Hints';
import { applyFixes, validateSmd, type Diagnostic, type Fix } from './validate';
import { findVariables, variableText } from './variables';

/**
 * The plan of `smd migrate --to 2`: what a document needs so that it means the same under spec v2 (`smd: 2`) as it
 * does today. Each step rewrites a few lines, or is a note when nothing is rewritten. 1.10 only reports the plan
 * (`--dry-run`); Styled Markdown 2.0 writes it.
 *
 * Internal: not exported from the npm package, since the plan's shape may still change before 2.0 makes it write.
 * The steps reuse the validator's quick fixes (the spec v2 hints) and `applyFixes`, as `smd validate --fix` does.
 */

/** What a step rewrites, in the order the steps run. */
export type MigrationKind =
  | 'closer' | 'duplicate-attrs' | 'title-text' | 'agent-priority' | 'math-delimiters' | 'heading-braces' | 'attr-escapes' | 'unknown-directive'
  | 'include-section' | 'value-case' | 'typography' | 'fuzzy-link' | 'variable-spelling' | 'version';

export interface MigrationStep {
  kind: MigrationKind;
  /** The RFC proposal it follows: "3", "7b", or "versioning" for the rules of the `smd` key. */
  proposal: string;
  /**
   * `v1`: the document renders the same with v1 rules after the step. `v2`: the step keeps what the document means
   * when it is read with v2 rules, and v1 rendering may change (an escape, a value's case, a link, the typography key).
   */
  keeps: 'v1' | 'v2';
  /** Zero-based first and last lines of the original document; an insertion has the line it goes before. */
  line: number;
  endLine: number;
  /** The lines as they are before the step (after the earlier steps), and after it, joined with "\n". */
  before: string;
  after: string;
  reason: string;
  /** Only reported: the step rewrites nothing. */
  note?: true;
}

export interface MigrationOptions {
  /** Add `typography: true` where the typographer changes text today, to keep curly quotes and dashes (proposal 8). */
  keepTypography?: boolean;
  /** Write fuzzy-linked bare domains (`example.com`) as `<https://example.com>`, which stay links (proposal 8). */
  linkDomains?: boolean;
  /** Quote front matter values that are shown differently from how they are written (`version: 2.10`, proposal 10). */
  quoteVariables?: boolean;
  /** Read a file relative to the document, for `:::include section=` (proposal 9). Without it, includes are left alone. */
  readFile?: (relativePath: string) => string | undefined;
  /** Plan even a document that already says `smd: 2` (tests, and to check that a migrated document needs nothing more). */
  force?: boolean;
}

export interface MigrationPlan {
  /** The spec version the document declares: its `smd` value, 1 when it has none or one that counts as 1 today. */
  from: number;
  steps: MigrationStep[];
  /** The document with every step applied. */
  result: string;
}

const KINDS: Record<MigrationKind, { proposal: string; keeps: 'v1' | 'v2'; reason: string }> = {
  closer: {
    proposal: '3', keeps: 'v1',
    reason: 'Spec v2 pairs a closing fence with the innermost open container that has as many colons (proposal 3). It is written with its container\'s colon count, as smd fmt writes it; v1 reads the colon count as cosmetic.',
  },
  'duplicate-attrs': {
    proposal: '4', keeps: 'v1',
    reason: 'Styled Markdown 2.0 reports a key, an id or a class given twice as an error in every document (proposal 4). Each is kept once, with the value v1 uses (the last), where it first appears.',
  },
  'title-text': {
    proposal: '4', keeps: 'v1',
    reason: 'Styled Markdown 2.0 reports a container titled both by title="…" and by text as an error in every document (proposal 4). The text, which v1 does not show, is removed.',
  },
  'agent-priority': {
    proposal: '12', keeps: 'v1',
    reason: 'Styled Markdown 2.0 removed "priority" on ":::agent", which no tool read (proposal 12), so it is an unknown attribute in every document. It is removed; nothing renders differently.',
  },
  'math-delimiters': {
    proposal: '2', keeps: 'v1',
    reason: 'Spec v2 opens and closes display math only on a line that is just "$$" (proposal 2). The delimiters move onto their own lines; the math, and how v1 reads it, stay the same.',
  },
  'heading-braces': {
    proposal: '5', keeps: 'v1',
    reason: 'Spec v2 reads an empty "{}" or a bare "{word}" after a heading as heading text (proposal 5). It is removed, which is how v1 shows the heading.',
  },
  'attr-escapes': {
    proposal: '6', keeps: 'v2',
    reason: 'Spec v2 reads "\\\\" in a quoted attribute value as one backslash, and a value can no longer end in a single backslash (proposal 6). The value is written with the escapes v2 needs to read it as v1 does ("\\\\\\\\server" for \\\\server, "C:\\docs\\\\" for C:\\docs\\); v1 reads those as more backslashes.',
  },
  'unknown-directive': {
    proposal: '7b', keeps: 'v2',
    reason: 'Spec v2 reads any ":name[…]" or ":name{…}" as a directive, its name in any case, and shows only its content (proposals 7b and 11). A name outside the vocabulary, or not in lower case, is text today, so its colon is escaped to keep it text; v1 shows "\\:" as ":".',
  },
  'include-section': {
    proposal: '9', keeps: 'v1',
    reason: 'Spec v2 matches section= only to a heading\'s id or its whole text (proposal 9). It is rewritten to the id of the heading it includes today.',
  },
  'value-case': {
    proposal: '11', keeps: 'v2',
    reason: 'Enumerated values match in any case (proposal 11). They are written in the vocabulary\'s case, as spec v2 documents write them.',
  },
  typography: {
    proposal: '8', keeps: 'v2',
    reason: 'Spec v2 turns the typographer off unless the front matter sets "typography: true" (proposal 8).',
  },
  'fuzzy-link': {
    proposal: '8', keeps: 'v2',
    reason: 'Spec v2 links only GFM autolink literals (http://, https://, www. and e-mail addresses), so a bare domain is no longer a link (proposal 8).',
  },
  'variable-spelling': {
    proposal: '10', keeps: 'v2',
    reason: 'Spec v2 shows a front matter value as it is written in the YAML (proposal 10); v1 shows the value YAML reads.',
  },
  version: {
    proposal: 'versioning', keeps: 'v1',
    reason: 'The "smd" key selects the spec version; "smd: 2" selects the v2 rules (RFC versioning rules). Tools before 2.0 warn and keep reading the document with v1 rules.',
  },
};

/** Every kind, in the order the steps run. */
export const KIND_ORDER = Object.keys(KINDS) as MigrationKind[];

const FUZZY_LINK: MigrationKind = 'fuzzy-link';
const VARIABLE_SPELLING: MigrationKind = 'variable-spelling';
const VERSION: MigrationKind = 'version';

/** The RFC proposal, which meaning a kind of step keeps, and why it is needed. */
export function migrationKind(kind: MigrationKind): { proposal: string; keeps: 'v1' | 'v2'; reason: string } {
  return KINDS[kind];
}

/** Rounds of fixes per step, as `smd validate --fix` does: one fix can make another possible. */
const FIX_PASSES = 5;
const TARGET = 2;
const SMD_KEY = 'smd';

/** The document being migrated: its lines now, and for each the line of the original document it comes from. */
interface Work {
  lines: string[];
  origin: number[];
  eol: string;
  steps: MigrationStep[];
  options: MigrationOptions;
}

const textOf = (w: Work) => w.lines.join(w.eol);
const splitLines = (text: string) => text.split(/\r?\n/);

/** The plan that migrates `text` to spec v2. Pure: nothing is read but through `options.readFile`. */
export function migrationPlan(text: string, options: MigrationOptions = {}): MigrationPlan {
  const fm = parseFrontMatter(text);
  const from = declaredVersion(fm);
  const lines = splitLines(text);
  const w: Work = { lines, origin: lines.map((_, i) => i), eol: text.includes('\r\n') ? '\r\n' : '\n', steps: [], options };
  if (from >= TARGET && !options.force) {
    if (from > TARGET) note(w, versionLine(lines, fm), VERSION, `This document declares smd: ${from}, newer than spec v2: there is nothing to migrate to.`);
    return { from, steps: w.steps, result: text };
  }
  fixStep(w, 'container/colons', 'closer');
  fixStep(w, 'attrs/duplicate', 'duplicate-attrs');
  fixStep(w, 'container/title-conflict', 'title-text');
  fixStep(w, 'attrs/unknown', 'agent-priority', (d) => d.message === AGENT_PRIORITY_REMOVED);
  mathStep(w);
  if (from < TARGET) headingAgentStep(w);
  fixStep(w, 'heading/attrs-text', 'heading-braces');
  // A document that already says smd: 2 (with force) is read with the v2 rules: its escapes and directives are meant.
  if (from < TARGET) {
    attrEscapeStep(w);
    unknownDirectiveStep(w);
  }
  if (options.readFile) fixStep(w, 'include/section-match', 'include-section');
  valueCaseStep(w);
  typographyStep(w);
  fuzzyLinkStep(w);
  variableStep(w);
  versionStep(w);
  // In the order the steps run, and by line within each (math is split bottom-up).
  w.steps.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.line - b.line);
  return { from, steps: w.steps, result: textOf(w) };
}

/**
 * The version a document declares, as every tool reads it (readSpec): 1 without a key or with a value that isn't a
 * whole number (`true`, `[2]`), else the whole number written, a newer one included.
 */
function declaredVersion(fm: FrontMatter): number {
  return fm.error ? 1 : readSpec(fm.data.smd).declared ?? 1;
}

// ---------------------------------------------------------------------------
// Recording steps
// ---------------------------------------------------------------------------

/** The original line of the current line `at`; past the end, the line after the original's last. */
function originOf(w: Work, at: number): number {
  return w.origin[at] ?? (w.origin.at(-1) ?? -1) + 1;
}

/** Replace `count` lines from `at` with `next`, as one step of `kind`. */
function change(w: Work, at: number, count: number, next: string[], kind: MigrationKind, reason = KINDS[kind].reason): void {
  const line = originOf(w, at);
  const endLine = count ? originOf(w, at + count - 1) : line;
  const { proposal, keeps } = KINDS[kind];
  w.steps.push({ kind, proposal, keeps, line, endLine, before: w.lines.slice(at, at + count).join('\n'), after: next.join('\n'), reason });
  w.lines.splice(at, count, ...next);
  w.origin.splice(at, count, ...next.map(() => line));
}

/** A step that rewrites nothing, about current line `at`. */
function note(w: Work, at: number, kind: MigrationKind, reason: string, endAt = at): void {
  const { proposal, keeps } = KINDS[kind];
  const text = w.lines.slice(at, endAt + 1).join('\n');
  w.steps.push({ kind, proposal, keeps, line: originOf(w, at), endLine: originOf(w, endAt), before: text, after: text, reason, note: true });
}

/** Each line that differs in `next` (which has as many lines) as a step; otherwise the changed run as one step. */
function recordLines(w: Work, next: string[], kind: MigrationKind): void {
  if (next.length !== w.lines.length) {
    let start = 0;
    while (start < next.length && next[start] === w.lines[start]) start++;
    let end = 0;
    while (end < next.length - start && next.at(-1 - end) === w.lines.at(-1 - end)) end++;
    change(w, start, w.lines.length - start - end, next.slice(start, next.length - end), kind);
    return;
  }
  next.forEach((line, i) => {
    if (line !== w.lines[i]) change(w, i, 1, [line], kind);
  });
}

/** Apply fixes to the current text and record the lines they change. */
function applyLineFixes(w: Work, fixes: Fix[], kind: MigrationKind): void {
  if (!fixes.length) return;
  const diagnostics: Diagnostic[] = fixes.map((fix) => ({ line: fix.line, column: fix.column, endColumn: fix.endColumn, severity: 'hint', code: kind, message: '', fix }));
  recordLines(w, splitLines(applyFixes(textOf(w), diagnostics).text), kind);
}

// ---------------------------------------------------------------------------
// Steps from the validator's spec v2 hints: closers, duplicates, title text, heading braces, include sections
// ---------------------------------------------------------------------------

/**
 * Suppression comments are for reports, not for meaning: the hints a document silences still change how spec v2
 * reads it. The comments are disabled with a same-length edit, so every column stays where it is.
 */
const unsuppressed = (text: string) => text.replaceAll('smd-disable', 'smd-xisable').replaceAll('smd-enable', 'smd-xnable');

/** Apply the fixes of the diagnostic `code` (those `which` picks) until none is left, and note the ones that have no fix. */
function fixStep(w: Work, code: string, kind: MigrationKind, which: (d: Diagnostic) => boolean = () => true): void {
  const options = { readFile: kind === 'include-section' ? w.options.readFile : undefined };
  let text = textOf(w);
  let manual: Diagnostic[] = [];
  for (let pass = 0; pass < FIX_PASSES; pass++) {
    const found = validateSmd(unsuppressed(text), options).filter((d) => d.code === code && which(d));
    if (pass === 0) manual = found.filter((d) => !d.fix);
    const fixed = applyFixes(text, found);
    if (!fixed.applied) break;
    text = fixed.text;
  }
  recordLines(w, splitLines(text), kind);
  for (const d of manual) note(w, d.line, kind, `Not rewritten: ${d.message}`);
}

// ---------------------------------------------------------------------------
// $$ delimiters (proposal 2)
// ---------------------------------------------------------------------------

/** The block tokens of the body as rendering parses it, with the line the body starts on. */
function bodyTokens(text: string, typographer = true): { tokens: Token[]; md: ReturnType<typeof createMarkdownIt>; env: Env; fm: FrontMatter } {
  const fm = parseFrontMatter(text);
  const md = createMarkdownIt();
  if (!typographer) md.set({ typographer: false });
  const env: Env = {
    lineOffset: fm.bodyStartLine, headings: [], slugs: new Map(), source: text, smdVariables: fm.data, messages: EN,
    options: { allowHtml: true, agentBlocks: 'collapsed', readFile: undefined, today: '2000-01-01' },
  };
  // As renderSmd: markdown-it reads a lone \r as a line break, the line scanners don't.
  return { tokens: md.parse(fm.body.replaceAll(/\r(?!\n)/g, ' '), env), md, env, fm };
}

/** Multi-line display math whose opening or closing `$$` line has math on it: the delimiter goes on a line of its own. */
function mathStep(w: Work): void {
  const { tokens, fm } = bodyTokens(textOf(w));
  const blocks = tokens
    .filter((t) => t.type === 'smd_math_block' && t.map && t.map[1] - t.map[0] > 1)
    .map((t) => [t.map![0] + fm.bodyStartLine, t.map![1] - 1 + fm.bodyStartLine]);
  // Bottom-up, so the lines of the blocks above stay where they are.
  for (const [open, close] of blocks.reverse()) splitDelimiters(w, open, close);
}

/** Math whose last line ends with `$$$$`, or whose first line's math ends with `$$`, would change if split: left alone. */
function splitDelimiters(w: Work, open: number, close: number): void {
  const first = w.lines[open];
  const at = first.indexOf('$$');
  if (at < 0) return;
  const prefix = first.slice(0, at);
  // A list marker before the `$$` becomes spaces on the lines after it, which keeps them in the list item.
  const indent = prefix.replaceAll(/\d+[.)]|[-*+]/g, (m) => ' '.repeat(m.length));
  const rest = first.slice(at + 2);
  const head = rest.trim() && !rest.trimEnd().endsWith('$$') ? [`${prefix}$$`, indent + rest.trimStart()] : [first];
  const last = w.lines[close];
  const math = last.trimEnd().slice(0, -2);
  const tail = math.replace(/^[\s>]*/, '') && !math.trimEnd().endsWith('$$') ? [math.trimEnd(), `${indent}$$`] : [last];
  if (head.length === 1 && tail.length === 1) return;
  change(w, open, close - open + 1, [...head, ...w.lines.slice(open + 1, close), ...tail], 'math-delimiters');
}

// ---------------------------------------------------------------------------
// Unknown inline directives (proposal 7b)
// ---------------------------------------------------------------------------

/** Lines of raw HTML blocks, where nothing is Markdown. */
function htmlLines(tokens: Token[], bodyStart: number): Set<number> {
  const lines = new Set<number>();
  for (const t of tokens) {
    if (t.type !== 'html_block' || !t.map) continue;
    for (let l = t.map[0]; l < t.map[1]; l++) lines.add(l + bodyStart);
  }
  return lines;
}

/** `line` with [start, end) spans overwritten by NUL characters, so nothing there matches. */
function blank(line: string, spans: Iterable<readonly [number, number]>): string {
  let out = line;
  for (const [start, end] of spans) out = out.slice(0, start) + '\0'.repeat(end - start) + out.slice(end);
  return out;
}

const spansOf = (line: string, re: RegExp): Array<[number, number]> => [...line.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);

const CODE_SPAN = /(`+)[\s\S]*?\1/g;
const TAG = /<[^<>\n]*>/g;
const DESTINATION = /\]\([^()\n]*\)/g;
const BRACES = /\{[^{}\n]*\}/g;

/** The line with what is not text blanked out: code spans and inline math, and with `all`, tags, link destinations and attribute lists. */
function textOnly(line: string, math: ReadonlyArray<[number, number]>, all: boolean): string {
  const masked = blank(line, math);
  const spans = [...spansOf(masked, CODE_SPAN), ...(all ? [...spansOf(masked, TAG), ...spansOf(masked, DESTINATION), ...spansOf(masked, BRACES)] : [])];
  return blank(masked, spans);
}

/** Whether the vocabulary defines an inline directive name as written (an own property, as isKnownContainer). */
const isKnownDirective = (name: string): boolean => Object.hasOwn(INLINE_DIRECTIVES, name);

/** `:name[` that is text today: the name is not a known directive as written, and a `]` closes it later on the line. */
const DIRECTIVE_START = /(?<=^|[\s([{>*_~"'-]):([A-Za-z][A-Za-z0-9-]*)\[/g;
/** `:name{` (its attribute list blanked out by textOnly): spec v2 reads it as a directive when the list is one. */
const DIRECTIVE_BRACES = /(?<=^|[\s([{>*_~"'-]):([A-Za-z][A-Za-z0-9-]*)(?=\0)/g;

/** Whether a spec v2 attribute list starts at `open` in `raw`. */
function v2ListAt(raw: string, open: number): boolean {
  const close = raw[open] === '{' ? findAttrsEnd(raw, open, TARGET) : -1;
  return close >= 0 && parseAttrs(raw.slice(open + 1, close), TARGET) !== null;
}

/**
 * The columns of the `:` of each `:name[…]` and `:name{…}` that v1 reads as text and v2 as a directive. Content may
 * run over a line break, as link text may: `continued` says whether a `]` comes on the lines after this one.
 */
function unknownDirectiveColumns(text: string, raw: string, continued: () => boolean): number[] {
  const closes = (from: number) => text.includes(']', from) || continued();
  const brackets = [...text.matchAll(DIRECTIVE_START)].filter((m) => !isKnownDirective(m[1]) && closes(m.index + m[0].length));
  const braces = [...text.matchAll(DIRECTIVE_BRACES)].filter((m) => !isKnownDirective(m[1]) && v2ListAt(raw, m.index + m[0].length));
  return [...brackets, ...braces].map((m) => m.index).sort((a, b) => a - b);
}

/** Body lines outside code, math and raw HTML, with what is code or math on them. */
function* textLines(w: Work): Generator<{ i: number; raw: string; math: ReadonlyArray<[number, number]> }> {
  const text = textOf(w);
  const { tokens, fm } = bodyTokens(text);
  const literal = literalLines(text);
  const html = htmlLines(tokens, fm.bodyStartLine);
  let multi: InlineMathLines | undefined;
  for (let i = fm.bodyStartLine; i < w.lines.length; i++) {
    if (literal.has(i) || html.has(i)) continue;
    const raw = w.lines[i];
    yield { i, raw, math: raw.includes('$') ? mathOnLine(multi ??= inlineMathLines(text), i, raw) : [] };
  }
}

/** Whether a `]` comes on one of the lines from `from` up to the next blank line (the rest of the paragraph). */
function closesInParagraph(lines: readonly string[], from: number): boolean {
  for (let l = from; l < lines.length && lines[l].trim(); l++) if (lines[l].includes(']')) return true;
  return false;
}

function unknownDirectiveStep(w: Work): void {
  const edits: Array<{ i: number; next: string }> = [];
  for (const { i, raw, math } of textLines(w)) {
    if (!raw.includes(':')) continue;
    const columns = unknownDirectiveColumns(textOnly(raw, math, true), raw, () => closesInParagraph(w.lines, i + 1));
    if (!columns.length) continue;
    let next = raw;
    for (const c of columns.reverse()) next = `${next.slice(0, c)}\\${next.slice(c)}`;
    edits.push({ i, next });
  }
  for (const { i, next } of edits) change(w, i, 1, [next], 'unknown-directive');
}

// ---------------------------------------------------------------------------
// `{agent}` after a heading (proposal 5)
// ---------------------------------------------------------------------------

/**
 * A bare `agent` in a heading's attribute list, which v1 reads as `agent=true` (rendered as `data-agent="true"`), is
 * written `agent=true`, so the list stays attributes in spec v2 and renders the same. The validator's fix for the
 * other bare words (heading/attrs-text) runs after it.
 */
function headingAgentStep(w: Work): void {
  const edits: Array<{ i: number; next: string }> = [];
  for (const { i, raw } of textLines(w)) {
    const m = /^\s{0,3}#{1,6}\s/.test(raw) ? HEADING_ATTRS.exec(raw) : null;
    const items = m ? lexAttrItems(m[1], 1) : null;
    if (!m || !items?.some(({ match }) => isFlagItem(match) && match[3] === 'agent')) continue;
    const open = m.index + m[0].indexOf('{') + 1;
    const last = items.at(-1)!;
    const inner = items.map(({ match }) => (isFlagItem(match) && match[3] === 'agent' ? match[0].replace('agent', 'agent=true') : match[0])).join('');
    edits.push({ i, next: `${raw.slice(0, open)}${inner}${raw.slice(open + last.pos + last.match[0].length)}` });
  }
  for (const { i, next } of edits) change(w, i, 1, [next], 'heading-braces');
}

// ---------------------------------------------------------------------------
// Backslashes in quoted attribute values (proposal 6)
// ---------------------------------------------------------------------------

/** A known directive's name (as v1 reads it) right before an attribute list. */
const KNOWN_DIRECTIVE_BEFORE = /(?:^|[\s([{>*_~"'-]):([a-z][a-z0-9-]*)(?:\[[^\]\n]*\])?$/;

/**
 * Where v1 reads an attribute list on a line (the columns of its `{`): after a container's name, at the end of a
 * heading, and inline after a styled span's `]` or a known directive. `masked` is the line with code and math blanked.
 */
function listStarts(raw: string, masked: string): number[] {
  const starts = new Set<number>();
  const open = CONTAINER_OPEN.exec(raw);
  if (open && raw[raw.length - open[4].length] === '{') starts.add(raw.length - open[4].length);
  const heading = /^\s{0,3}#{1,6}\s/.test(raw) ? HEADING_ATTRS.exec(raw) : null;
  if (heading) starts.add(heading.index + heading[0].indexOf('{'));
  for (let p = masked.indexOf('{'); p !== -1; p = masked.indexOf('{', p + 1)) {
    const before = masked.slice(0, p);
    const directive = KNOWN_DIRECTIVE_BEFORE.exec(before);
    if (before.endsWith(']') || (directive && isKnownDirective(directive[1]))) starts.add(p);
  }
  return [...starts].sort((a, b) => a - b);
}

const sameAttrs = (a: Attrs | null, b: Attrs | null) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

/** A quoted item written so that spec v2 reads the value v1 reads; other items as they are. */
function requoted(m: RegExpExecArray): string {
  const { value, quote } = itemValue(m, 1);
  if (!quote || value === undefined) return m[0];
  const written = `${quote}${quote === '"' ? m[4] : m[5]}${quote}`;
  const at = m[0].lastIndexOf(written);
  return `${m[0].slice(0, at)}${quote}${escapeQuoted(value, quote)}${quote}${m[0].slice(at + written.length)}`;
}

/**
 * The inside of the attribute list that opens at `open`, rewritten so that spec v2 reads the values v1 reads, when the
 * two readings differ (`\\` in a quoted value, or a value that ends in a single backslash); undefined when they don't,
 * or when no rewrite reads the same.
 */
function v2List(raw: string, open: number): { close: number; inner: string } | undefined {
  const close = findAttrsEnd(raw, open, 1);
  const inner = close < 0 ? '' : raw.slice(open + 1, close);
  const v1 = close < 0 ? null : parseAttrs(inner, 1);
  if (!v1 || (findAttrsEnd(raw, open, TARGET) === close && sameAttrs(v1, parseAttrs(inner, TARGET)))) return undefined;
  const items = lexAttrItems(inner, 1) ?? [];
  const last = items.at(-1);
  const rewritten = items.map(({ match }) => requoted(match)).join('') + inner.slice(last ? last.pos + last.match[0].length : 0);
  return sameAttrs(v1, parseAttrs(rewritten, TARGET)) ? { close, inner: rewritten } : undefined;
}

function attrEscapeStep(w: Work): void {
  const edits: Array<{ i: number; next: string }> = [];
  for (const { i, raw, math } of textLines(w)) {
    if (!raw.includes('\\') || !raw.includes('{')) continue;
    let next = raw;
    for (const open of listStarts(raw, textOnly(raw, math, false)).reverse()) {
      const list = v2List(next, open);
      if (list) next = `${next.slice(0, open + 1)}${list.inner}${next.slice(list.close)}`;
    }
    if (next !== raw) edits.push({ i, next });
  }
  for (const { i, next } of edits) change(w, i, 1, [next], 'attr-escapes');
}

// ---------------------------------------------------------------------------
// Enumerated values in the vocabulary's case (proposal 11)
// ---------------------------------------------------------------------------

/** The allowed value `value` is in another case, when it isn't written that way already. */
function canonical(value: string | undefined, allowed: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  const found = allowed.find((a) => a.toLowerCase() === lower);
  return found === value ? undefined : found;
}

function containerCaseFixes(i: number, raw: string): Fix[] {
  const open = CONTAINER_OPEN.exec(raw);
  const info = open && parseContainerInfo(open[3] + open[4]);
  const spec = info && isKnownContainer(info.name) ? CONTAINERS[info.name] : undefined;
  if (!open || !info || !spec?.values || info.attrsError) return [];
  const nameEnd = raw.indexOf(open[3], open[1].length + open[2].length) + open[3].length;
  return Object.entries(spec.values).flatMap(([key, allowed]) => {
    const value = info.attrs.values[key];
    const fix = attrValueFix(i, raw, nameEnd, raw.length, key, value ?? '', canonical(value, allowed));
    return fix ? [fix] : [];
  });
}

const DIRECTIVE = /(^|[\s([{>*_~"'-]):([a-z][a-z0-9-]*)(\[[^\]\n]*\])?(\{[^{}\n]*\})?/g;

function directiveCaseFixes(i: number, text: string): Fix[] {
  const fixes: Fix[] = [];
  for (const m of text.matchAll(DIRECTIVE)) {
    const spec = isKnownDirective(m[2]) ? INLINE_DIRECTIVES[m[2]] : undefined;
    if (!spec) continue;
    const col = m.index + m[1].length;
    const end = col + m[0].length - m[1].length;
    const attrs = m[4] ? parseAttrs(m[4].slice(1, -1)) : null;
    for (const [key, allowed] of Object.entries(spec.values ?? {})) {
      const value = attrs?.values[key];
      const fix = attrValueFix(i, text, col, end, key, value ?? '', canonical(value, allowed));
      if (fix) fixes.push(fix);
    }
  }
  return fixes;
}

/** The line of a top-level front matter key (`key:` at the start of a line), or -1. */
function keyLine(lines: string[], fm: FrontMatter, key: string): number {
  for (let i = 1; i < fm.bodyStartLine - 1; i++) {
    if (lines[i].startsWith(key) && /^\s*:/.test(lines[i].slice(key.length))) return i;
  }
  return -1;
}

function frontMatterCaseFixes(lines: string[], fm: FrontMatter): Fix[] {
  if (!fm.present || fm.error) return [];
  return Object.entries(FRONTMATTER_SCHEMA.properties).flatMap(([key, prop]) => {
    const value = fm.data[key];
    if (!prop.enum || typeof value !== 'string') return [];
    const line = keyLine(lines, fm, key);
    const fix = line > 0 ? frontMatterValueFix(lines, line, key, value, canonical(value, prop.enum.map(String))) : undefined;
    return fix ? [fix] : [];
  });
}

function valueCaseStep(w: Work): void {
  const fixes = frontMatterCaseFixes(w.lines, parseFrontMatter(textOf(w)));
  for (const { i, raw, math } of textLines(w)) {
    fixes.push(...containerCaseFixes(i, raw));
    if (raw.includes(':')) fixes.push(...directiveCaseFixes(i, textOnly(raw, math, false)));
  }
  applyLineFixes(w, fixes, 'value-case');
}

// ---------------------------------------------------------------------------
// Typography (proposal 8)
// ---------------------------------------------------------------------------

/** What the typographer writes, by kind: the names for one and for several, and the characters. */
const TYPOGRAPHY: ReadonlyArray<[string, string, RegExp]> = [
  ['quote', 'quotes', /[‘’“”]/g],
  ['dash', 'dashes', /[–—]/g],
  ['ellipsis', 'ellipses', /…/g],
  ['symbol', 'symbols', /[©®™±§]/g],
];

/** Typographic characters per line: in the body's text, in container titles and in the front matter title and summary. */
function typographyByLine(text: string, typographer: boolean): Map<number, number[]> {
  const { tokens, md, env, fm } = bodyTokens(text, typographer);
  const counts = new Map<number, number[]>();
  const add = (line: number, s: string) => {
    const now = counts.get(line) ?? TYPOGRAPHY.map(() => 0);
    TYPOGRAPHY.forEach(([, , re], k) => { now[k] += s.match(re)?.length ?? 0; });
    counts.set(line, now);
  };
  const inline = (s: string, line: number) => {
    for (const t of md.parseInline(s, { ...env, headings: [], slugs: new Map() })) addText(t.children ?? [], line, add);
  };
  for (const key of ['title', 'summary']) {
    const value = fm.data[key];
    if (typeof value === 'string') inline(value, Math.max(0, keyLine(splitLines(text), fm, key)));
  }
  let line = fm.bodyStartLine;
  for (const t of tokens) {
    if (t.map) line = t.map[0] + fm.bodyStartLine;
    const title = (t.meta as { title?: unknown } | null)?.title;
    if (t.type === 'container_smd_open' && typeof title === 'string') inline(title, line);
    if (t.children) addText(t.children, line, add);
  }
  return counts;
}

function addText(tokens: Token[], line: number, add: (line: number, s: string) => void): void {
  for (const t of tokens) {
    if (t.type === 'text') add(line, t.content);
    if (t.children) addText(t.children, line, add);
  }
}

/** Where the typographer changes text today: per kind of change, and the lines. */
function typographyPlaces(text: string): { total: number; kinds: number[]; lines: number[] } {
  const on = typographyByLine(text, true);
  const off = typographyByLine(text, false);
  const kinds = TYPOGRAPHY.map(() => 0);
  const lines: number[] = [];
  for (const [line, counts] of on) {
    const plain = off.get(line) ?? [];
    const here = counts.map((n, k) => Math.max(0, n - (plain[k] ?? 0)));
    here.forEach((n, k) => { kinds[k] += n; });
    if (here.some((n) => n > 0)) lines.push(line);
  }
  return { total: kinds.reduce((a, b) => a + b, 0), kinds, lines: lines.sort((a, b) => a - b) };
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function typographyStep(w: Work): void {
  const text = textOf(w);
  const fm = parseFrontMatter(text);
  if (fm.error || fm.data.typography !== undefined) return;
  const places = typographyPlaces(text);
  if (!places.total) return;
  const what = TYPOGRAPHY.flatMap(([one, many], k) => (places.kinds[k] ? [counted(places.kinds[k], one, many)] : [])).join(', ');
  const shown = places.lines.slice(0, 10).map((l) => originOf(w, l) + 1).join(', ');
  const more = places.lines.length > 10 ? ', …' : '';
  const today = `The typographer changes ${counted(places.total, 'place', 'places')} today (${what}), on line(s) ${shown}${more}.`;
  if (w.options.keepTypography) {
    addFrontMatterKey(w, 'typography: true', 'typography', `${KINDS.typography.reason} ${today} "typography: true" keeps them as they look today.`);
    return;
  }
  note(w, places.lines[0], 'typography', `${KINDS.typography.reason} ${today} Run with --keep-typography to add "typography: true" and keep them.`, places.lines.at(-1));
}

/** Add a line at the end of the front matter, or a front matter with it before the first line. */
function addFrontMatterKey(w: Work, line: string, kind: MigrationKind, reason: string): void {
  const fm = parseFrontMatter(textOf(w));
  if (fm.present) {
    change(w, fm.bodyStartLine - 1, 0, [line], kind, reason);
    return;
  }
  // `smd fmt` writes a blank line after the front matter.
  const blankAfter = w.lines[0]?.trim() ? [''] : [];
  change(w, 0, 0, ['---', line, '---', ...blankAfter], kind, reason);
}

// ---------------------------------------------------------------------------
// Fuzzy links (proposal 8)
// ---------------------------------------------------------------------------

/** Links that GFM makes from text too: a scheme, `www.`, or an e-mail address. */
const GFM_AUTOLINK = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)|@/i;

interface FuzzyLink { label: string; first: number; last: number }

/** Bare domains linkify links today, with the lines of the text they are in. */
function fuzzyLinks(text: string): FuzzyLink[] {
  const { tokens, fm } = bodyTokens(text);
  const found: FuzzyLink[] = [];
  let range: [number, number] = [fm.bodyStartLine, fm.bodyStartLine];
  for (const t of tokens) {
    if (t.map) range = [t.map[0] + fm.bodyStartLine, t.map[1] - 1 + fm.bodyStartLine];
    const children = t.children ?? [];
    children.forEach((c, k) => {
      const label = children[k + 1]?.content ?? '';
      if (c.type === 'link_open' && c.markup === 'linkify' && label && !GFM_AUTOLINK.test(label)) found.push({ label, first: range[0], last: range[1] });
    });
  }
  return found;
}

const DOMAIN_EDGE = /[\w.@/:-]/;

/** Where `label` is on lines [first, last], at or after `from` (a line and column), as text and not in code. */
function locate(w: Work, link: FuzzyLink, from: { line: number; column: number }): { line: number; column: number } | undefined {
  for (let i = Math.max(link.first, from.line); i <= link.last && i < w.lines.length; i++) {
    const text = textOnly(w.lines[i], [], false);
    let at = text.indexOf(link.label, i === from.line ? from.column : 0);
    while (at >= 0) {
      const before = text[at - 1] ?? ' ';
      const after = text[at + link.label.length] ?? ' ';
      if (!DOMAIN_EDGE.test(before) && !/[\w@/-]/.test(after)) return { line: i, column: at };
      at = text.indexOf(link.label, at + 1);
    }
  }
  return undefined;
}

type DomainEdits = Map<number, Array<{ column: number; label: string }>>;

/** The source place of each fuzzy link, by line; a link this tool can't place becomes a note. */
function placeFuzzyLinks(w: Work): DomainEdits {
  const edits: DomainEdits = new Map();
  let from = { line: 0, column: 0 };
  for (const link of fuzzyLinks(textOf(w))) {
    const at = locate(w, link, from);
    if (!at) {
      note(w, link.first, FUZZY_LINK, `${KINDS[FUZZY_LINK].reason} "${link.label}" is linked today, from text this tool can't rewrite.`);
      continue;
    }
    from = { line: at.line, column: at.column + link.label.length };
    edits.set(at.line, [...(edits.get(at.line) ?? []), { column: at.column, label: link.label }]);
  }
  return edits;
}

const several = (n: number, one: string, many: string) => (n > 1 ? many : one);

function fuzzyLinkStep(w: Work): void {
  for (const [line, links] of placeFuzzyLinks(w)) {
    const labels = links.map((l) => `"${l.label}"`).join(', ');
    const are = several(links.length, 'is', 'are');
    if (!w.options.linkDomains) {
      note(w, line, FUZZY_LINK, `${KINDS[FUZZY_LINK].reason} ${labels} ${are} linked today. Run with --link-domains to write ${several(links.length, 'it', 'them')} as <https://…>.`);
      continue;
    }
    let next = w.lines[line];
    for (const l of [...links].reverse()) next = `${next.slice(0, l.column)}<https://${l.label}>${next.slice(l.column + l.label.length)}`;
    change(w, line, 1, [next], FUZZY_LINK, `${KINDS[FUZZY_LINK].reason} ${labels} ${are} written as an autolink, which stays a link.`);
  }
}

// ---------------------------------------------------------------------------
// Variables (proposal 10)
// ---------------------------------------------------------------------------

/** Front matter keys the page header shows as text: `v{version}` and `Updated {updated}`. */
const HEADER_KEYS = ['version', 'updated'];

/** A plain scalar as written after `key:`, up to a comment; undefined for quoted, block or empty values. */
function writtenScalar(rest: string): string | undefined {
  const comment = rest.search(/\s#/);
  const text = (comment < 0 ? rest : rest.slice(0, comment)).trim();
  return text && !/^["'[{|>&*!]/.test(text) ? text : undefined;
}

function variableStep(w: Work): void {
  const text = textOf(w);
  const fm = parseFrontMatter(text);
  if (!fm.present || fm.error) return;
  const code = codeLines(text);
  const shown = new Set([...HEADER_KEYS, ...findVariables(w.lines, fm.bodyStartLine, (l) => code.has(l)).map((v) => v.name)]);
  for (let i = 1; i < fm.bodyStartLine - 1; i++) {
    const m = /^([A-Za-z_][\w.-]*)[ \t]*:/.exec(w.lines[i]);
    const value = m && Object.hasOwn(fm.data, m[1]) ? fm.data[m[1]] : undefined;
    if (!m || !shown.has(m[1]) || (typeof value !== 'number' && typeof value !== 'boolean')) continue;
    const written = writtenScalar(w.lines[i].slice(m[0].length));
    const display = variableText(value);
    if (written === undefined || written === display) continue;
    const today = `"${m[1]}: ${written}" is shown as "${display}" today and as "${written}" in spec v2.`;
    if (!w.options.quoteVariables) {
      note(w, i, VARIABLE_SPELLING, `${KINDS[VARIABLE_SPELLING].reason} ${today} Run with --quote-variables to quote it, so every version shows "${written}".`);
      continue;
    }
    const column = w.lines[i].indexOf(written, m[0].length);
    const next = `${w.lines[i].slice(0, column)}"${written}"${w.lines[i].slice(column + written.length)}`;
    change(w, i, 1, [next], VARIABLE_SPELLING, `${KINDS[VARIABLE_SPELLING].reason} ${today} Quoted, it is shown as "${written}" by every version.`);
  }
}

// ---------------------------------------------------------------------------
// The smd key (versioning rules)
// ---------------------------------------------------------------------------

/** The line of the `smd` key, else the front matter's first line (0). */
function versionLine(lines: string[], fm: FrontMatter): number {
  return Math.max(0, keyLine(lines, fm, SMD_KEY));
}

function versionStep(w: Work): void {
  const fm = parseFrontMatter(textOf(w));
  if (fm.error) {
    note(w, fm.error.line, VERSION, `Not rewritten: the front matter does not parse (${fm.error.message}). Fix it, then add "smd: ${TARGET}".`);
    return;
  }
  if (fm.data.smd === undefined) {
    if (fm.present) change(w, 1, 0, [`smd: ${TARGET}`], VERSION);
    else addFrontMatterKey(w, `smd: ${TARGET}`, VERSION, KINDS.version.reason);
    return;
  }
  if (readSpec(fm.data.smd).declared === TARGET) return;
  const line = keyLine(w.lines, fm, SMD_KEY);
  const raw = w.lines[line] ?? '';
  const colon = raw.indexOf(':') + 1;
  // An indented line after it continues the value (YAML reads `1` and the next line as one string).
  const continued = line + 1 < fm.bodyStartLine - 1 && /^\s/.test(w.lines[line + 1]);
  const value = line > 0 && !continued ? lineValue(raw.slice(colon)) : undefined;
  if (value === undefined) {
    note(w, Math.max(0, line), VERSION, `Not rewritten: "smd" is not written as a value on its own line. Set it to "smd: ${TARGET}".`);
    return;
  }
  const column = raw.indexOf(value, colon);
  change(w, line, 1, [`${raw.slice(0, column)}${TARGET}${raw.slice(column + value.length)}`], VERSION);
}

/**
 * The value after `key:` on its line as written (`1`, `"1"`, `true`, `[1]`), up to a comment; not a block scalar or one
 * on later lines. Only YAML's spaces and tabs are trimmed: other white space, such as a byte order mark, is part of
 * the value, so it is replaced with the rest of it.
 */
function lineValue(rest: string): string | undefined {
  const comment = rest.search(/\s#/);
  const text = yamlTrim(comment < 0 ? rest : rest.slice(0, comment));
  return text && !/^[|>]/.test(text) ? text : undefined;
}

const isYamlSpace = (c: string | undefined) => c === ' ' || c === '\t';

/** `s` without the spaces and tabs around it. */
function yamlTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isYamlSpace(s[start])) start++;
  while (end > start && isYamlSpace(s[end - 1])) end--;
  return s.slice(start, end);
}
