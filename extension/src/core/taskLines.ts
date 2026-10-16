import { parseFrontMatter } from './frontmatter';
import { renderedTaskLines } from './parse';

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
function rawBlocks(): (line: string) => boolean {
  let end: RegExp | null = null;
  return (line) => {
    if (end) {
      if (end.test(line)) end = null;
      return true;
    }
    end = rawBlockEnd(line);
    return end !== null;
  };
}

/** What ends the raw HTML or display math a line opens (see rawBlocks), or null when it opens none. */
function rawBlockEnd(line: string): RegExp | null {
  const text = line.replace(/^[\s>]*/, '');
  if (text.startsWith('<!--')) return text.includes('-->', 4) ? null : /-->/;
  if (/^<(?:pre|script|style|textarea)\b/i.test(text)) return /<\/(?:pre|script|style|textarea)>/i;
  if (text.startsWith('$$')) return text.length > 2 && text.trimEnd().endsWith('$$') ? null : /\$\$\s*$/;
  return text.startsWith('<') ? BLANK : null;
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

/**
 * The headings and tasks (`- [ ] …`, `1. [x] …`) of a document in order, from the first body line on (after the
 * front matter when `from` is left out). A task is a line that rendering shows with a checkbox: code holds none, and
 * a task-shaped line that continues a paragraph is text. The parse is only asked about lines whose shape leaves that
 * open (see needsParse), so most documents parse nothing here.
 */
export function scanTasks(text: string, from = parseFrontMatter(text).bodyStartLine): TaskScanLine[] {
  const lines = text.split(/\r?\n/);
  const found: TaskScanLine[] = [];
  let fence: string | null = null;
  let rendered: ReadonlySet<number> | undefined;
  const isTask = (i: number) => (rendered ??= renderedTaskLines(text)).has(i);
  const inRaw = rawBlocks();
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const raw = inRaw(line);
    const h = HEADING.exec(line);
    if (h) { found.push({ kind: 'heading', line: i, text: h[1] }); continue; }
    const m = TASK.exec(line);
    // A task's text can't be empty, as in rendering.
    if (!m?.[3].trim()) continue;
    if (!needsParse(line, i > from ? lines[i - 1] : undefined, m[1], raw) || isTask(i)) found.push({ kind: 'task', line: i, mark: m[2], body: m[3] });
  }
  return found;
}

/** The zero-based lines of a document's open tasks: the ones `extractTasks` (and so `smd tasks`) lists as open. */
export function openTaskLines(text: string): number[] {
  return scanTasks(text).flatMap((l) => (l.kind === 'task' && l.mark === ' ' ? [l.line] : []));
}
