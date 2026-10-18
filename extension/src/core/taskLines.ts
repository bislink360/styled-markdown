import { displayMathOpener } from './containers';
import { parseFrontMatter } from './frontmatter';
import { renderedTaskLines } from './parse';
import { withoutHeadingAttrs } from './sections';
import { specVersion, type SpecVersion } from './specVersion';

/**
 * The lines of a document that tasks are read from: headings (each task belongs to the one above it) and
 * task items. Every count of tasks (`smd tasks`, outlines, the agent view's token budget) reads them here,
 * so they all agree.
 */
export type TaskScanLine =
  | { kind: 'heading'; line: number; text: string }
  | { kind: 'task'; line: number; mark: string; body: string };

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+\{[^{}]*\})?\s*#*\s*$/;
/** A heading with its trailing braces, for spec v2, where only an attribute list is left out (see withoutHeadingAttrs). */
const HEADING_V2 = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
/** A task-shaped line: the number of an ordered item, the mark and the text. */
const TASK = /^\s*(?:[-*+]|(\d+)[.)])\s+\[([ xX])\]\s+(.*)$/;
/** Four columns of indentation, or a tab: a task-shaped line there may be code or continue a paragraph. */
const INDENTED = /^(?:\s{4}|\s*\t)/;
/**
 * A line after which a bullet item (indented less than four columns) starts a list item as written: a heading, a list
 * item, a fence or a container fence. Nothing on it is a paragraph that the item could continue.
 */
const ENDS_TEXT = /^\s{0,3}(?:#{1,6}(?:\s|$)|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|:{3,}|`{3,}|~{3,})/;
const BLANK = /^\s*$/;

/**
 * Whether each line, read in order, may be held by raw HTML or display math: a comment, a `<pre>`-like or a `$$` block
 * up to its end, any other HTML block up to a blank line. Lines it holds are asked of the parse, so a line it holds
 * wrongly only costs a parse.
 */
function rawBlocks(spec: () => SpecVersion): (line: string) => boolean {
  let end: RegExp | null = null;
  return (line) => {
    if (end) {
      if (end.test(line)) end = null;
      return true;
    }
    end = rawBlockEnd(line, spec);
    return end !== null;
  };
}

/** A line that may close display math in spec v2: only `$$` once its indentation and quote markers are left out. */
const V2_MATH_END = /^[\s>]*\$\$\s*$/;

/**
 * What ends the raw HTML or display math a line opens (see rawBlocks), or null when it opens none. `spec` gives the
 * document's version, asked only for a `$$` line.
 */
function rawBlockEnd(line: string, spec: () => SpecVersion): RegExp | null {
  const text = line.replace(/^[\s>]*/, '');
  if (text.startsWith('<!--')) return text.includes('-->', 4) ? null : /-->/;
  if (/^<(?:pre|script|style|textarea)\b/i.test(text)) return /<\/(?:pre|script|style|textarea)>/i;
  if (text.startsWith('$$')) return mathBlockEnd(text, spec());
  return text.startsWith('<') ? BLANK : null;
}

/** What ends the display math a line starting with `$$` opens (spec v2: a line that is only `$$`), or null for none. */
function mathBlockEnd(text: string, spec: SpecVersion): RegExp | null {
  if (spec === 1) return text.length > 2 && text.trimEnd().endsWith('$$') ? null : /\$\$\s*$/;
  return displayMathOpener(text, spec) === 'block' ? V2_MATH_END : null;
}

/**
 * Is a task-shaped line one that only the parse can tell is a task? It may be code or continue a paragraph when it
 * is indented four columns, when it follows text an item could continue, or when it is an ordered item other than 1
 * after any text (which can't interrupt a paragraph); and it may be raw HTML or math.
 */
function needsParse(line: string, previous: string | undefined, number: string | undefined, inRaw: boolean): boolean {
  if (inRaw || INDENTED.test(line)) return true;
  if (previous === undefined || !previous.trim()) return false;
  return (number !== undefined && Number.parseInt(number, 10) !== 1) || !ENDS_TEXT.test(previous);
}

/** The open code fence after a line, and whether the line is part of a fence (its opener, body or closer). */
function fenceStep(line: string, fence: string | null): { fence: string | null; inFence: boolean } {
  const f = FENCE.exec(line);
  if (fence) return { fence: f && f[1][0] === fence[0] && f[1].length >= fence.length ? null : fence, inFence: true };
  return f ? { fence: f[1], inFence: true } : { fence: null, inFence: false };
}

/**
 * The headings and tasks (`- [ ] …`, `1. [x] …`) of a document in order, from the first body line on (after the
 * front matter when `from` is left out). A task is a line that rendering shows with a checkbox: code holds none, and
 * a task-shaped line that continues a paragraph is text. The parse is only asked about lines whose shape leaves that
 * open (see needsParse), so most documents parse nothing here.
 */
export function scanTasks(text: string, from = parseFrontMatter(text).bodyStartLine, spec?: SpecVersion): TaskScanLine[] {
  const lines = text.split(/\r?\n/);
  const found: TaskScanLine[] = [];
  let fence: string | null = null;
  let rendered: ReadonlySet<number> | undefined;
  const isTask = (i: number) => (rendered ??= renderedTaskLines(text)).has(i);
  // The version, when the caller does not give it, from the text on the first ask.
  let known = spec;
  const version = () => (known ??= specVersion(text));
  const inRaw = rawBlocks(version);
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    const step = fenceStep(line, fence);
    fence = step.fence;
    if (step.inFence) continue;
    const raw = inRaw(line);
    const heading = headingText(line, version());
    if (heading !== undefined) { found.push({ kind: 'heading', line: i, text: heading }); continue; }
    const m = TASK.exec(line);
    // A task's text can't be empty, as in rendering.
    if (!m?.[3].trim()) continue;
    if (!needsParse(line, i > from ? lines[i - 1] : undefined, m[1], raw) || isTask(i)) found.push({ kind: 'task', line: i, mark: m[2], body: m[3] });
  }
  return found;
}

/**
 * A heading line's text without its trailing attribute list: in spec v1 any trailing `{…}`, in spec v2 only an
 * attribute list (`## Returns {ok}` is "Returns {ok}"). Undefined for a line that is not a heading.
 */
function headingText(line: string, spec: SpecVersion): string | undefined {
  if (spec < 2) return HEADING.exec(line)?.[1];
  const h = HEADING_V2.exec(line);
  return h ? withoutHeadingAttrs(h[1], spec) : undefined;
}

/** The zero-based lines of a document's open tasks: the ones `extractTasks` (and so `smd tasks`) lists as open. */
export function openTaskLines(text: string): number[] {
  return scanTasks(text).flatMap((l) => (l.kind === 'task' && l.mark === ' ' ? [l.line] : []));
}
