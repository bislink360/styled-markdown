import { parseFrontMatter } from './frontmatter';
import { codeLines } from './parse';

/**
 * The lines of a document that tasks are read from: headings (each task belongs to the one above it) and
 * task items. Every count of tasks (`smd tasks`, outlines, the agent view's token budget) reads them here,
 * so they all agree.
 */
export type TaskScanLine =
  | { kind: 'heading'; line: number; text: string }
  | { kind: 'task'; line: number; mark: string; body: string };

/**
 * Is a line of a document code, as markdown-it reads it (see ParseResult.code)? Fenced code is skipped before
 * this is asked; an indented code block starts with four columns or a tab, so only such lines need the parse.
 */
function codeLineCheck(text: string): (index: number, line: string) => boolean {
  let code: Set<number> | undefined;
  return (index, line) => {
    if (!/^(?:\s{4}|\s*\t)/.test(line)) return false;
    code ??= codeLines(text);
    return code.has(index);
  };
}

/**
 * The headings and tasks (`- [ ] …`, `1. [x] …`) of a document in order, from the first body line on (after the
 * front matter when `from` is left out). Fenced and indented code holds neither: a task-shaped line there is code.
 */
export function scanTasks(text: string, from = parseFrontMatter(text).bodyStartLine): TaskScanLine[] {
  const lines = text.split(/\r?\n/);
  const found: TaskScanLine[] = [];
  let fence: string | null = null;
  const inCode = codeLineCheck(text);
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const h = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+\{[^{}]*\})?\s*#*\s*$/.exec(line);
    if (h) { found.push({ kind: 'heading', line: i, text: h[1] }); continue; }
    const m = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/.exec(line);
    // A line of an indented code block is code, not a task, as in rendering.
    if (m && !inCode(i, line)) found.push({ kind: 'task', line: i, mark: m[1], body: m[2] });
  }
  return found;
}

/** The zero-based lines of a document's open tasks: the ones `extractTasks` (and so `smd tasks`) lists as open. */
export function openTaskLines(text: string): number[] {
  return scanTasks(text).flatMap((l) => (l.kind === 'task' && l.mark === ' ' ? [l.line] : []));
}
