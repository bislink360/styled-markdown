import { CONTAINER_CLOSE, CONTAINER_OPEN } from './containers';
import { CALLOUT_TYPES } from './spec';

/** Replace lines [startLine, endLine] (inclusive, zero-based) with `lines`. */
export interface LineEdit {
  startLine: number;
  endLine: number;
  lines: string[];
}

/** An open container around a line. Columns locate the name on the opening line. */
export interface ContainerAt {
  name: string;
  openLine: number;
  closeLine: number;
  nameColumn: number;
}

/** Scan containers outside code fences. Unclosed containers end at the last line. */
function containers(lines: string[]): ContainerAt[] {
  const found: ContainerAt[] = [];
  const stack: ContainerAt[] = [];
  let fence: { char: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (mark && mark[1][0] === fence.char && mark[1].length >= fence.len && !raw.slice(mark[0].length).trim()) fence = null;
      continue;
    }
    if (mark) { fence = { char: mark[1][0], len: mark[1].length }; continue; }
    if (CONTAINER_CLOSE.test(raw)) {
      const c = stack.pop();
      if (c) { c.closeLine = i; found.push(c); }
      continue;
    }
    const open = CONTAINER_OPEN.exec(raw);
    if (open) stack.push({ name: open[3].toLowerCase(), openLine: i, closeLine: lines.length - 1, nameColumn: raw.indexOf(open[3], open[1].length + open[2].length) });
  }
  return [...found, ...stack];
}

/** The innermost container whose fences enclose `line` (including the fence lines themselves). */
export function containerAt(text: string, line: number): ContainerAt | undefined {
  return containers(text.split(/\r?\n/))
    .filter((c) => c.openLine <= line && line <= c.closeLine)
    .sort((a, b) => b.openLine - a.openLine)[0];
}

/**
 * Wrap lines [startLine, endLine] in `:::name`. Returns undefined when the lines cut through a code
 * fence or a container, since wrapping them would change the document's structure. The new fence
 * gets one colon more than the fences inside it, so the outer container stands out.
 */
export function wrapLines(text: string, startLine: number, endLine: number, name: string): LineEdit | undefined {
  const lines = text.split(/\r?\n/);
  const selected = lines.slice(startLine, endLine + 1);
  if (!selected.some((l) => l.trim())) return undefined;
  if (!isBalanced(selected)) return undefined;
  const inner = Math.max(2, ...selected.map((l) => /^\s{0,3}(:{3,})/.exec(l)?.[1].length ?? 0));
  const colons = ':'.repeat(inner + 1);
  const indent = /^\s*/.exec(selected.find((l) => l.trim())!)![0];
  if (indent.replace(/\t/g, '    ').length > 3) return undefined; // the fence would read as indented code
  return { startLine, endLine, lines: [`${indent}${colons}${name}`, ...selected, `${indent}${colons}`] };
}

/** Do these lines open and close every code fence and container they contain? */
function isBalanced(lines: string[]): boolean {
  let fence: { char: string; len: number } | null = null;
  let depth = 0;
  for (const raw of lines) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (mark && mark[1][0] === fence.char && mark[1].length >= fence.len && !raw.slice(mark[0].length).trim()) fence = null;
      continue;
    }
    if (mark) { fence = { char: mark[1][0], len: mark[1].length }; continue; }
    if (CONTAINER_CLOSE.test(raw)) { if (--depth < 0) return false; continue; }
    if (CONTAINER_OPEN.test(raw)) depth++;
  }
  return !fence && depth === 0;
}

// ---------------------------------------------------------------------------
// Blockquote callouts → :::callout
// ---------------------------------------------------------------------------

/** The same mapping as `smd from-md` for GitHub alerts, plus common bold labels. */
const ALERTS: Record<string, string> = { NOTE: 'note', TIP: 'tip', IMPORTANT: 'info', WARNING: 'warning', CAUTION: 'danger' };
const LABELS: Record<string, string> = {
  note: 'note', info: 'info', important: 'info', tip: 'tip', hint: 'tip', success: 'success', done: 'success',
  warning: 'warning', caution: 'danger', danger: 'danger', question: 'question',
};

/**
 * A blockquote around `line` that reads as a callout, either a GitHub alert (`> [!WARNING]`) or a
 * bold label (`> **Warning:** text`), converted to a `:::callout`. Nested quotes keep their extra `>`.
 */
export function blockquoteToCallout(text: string, line: number): { type: string; edit: LineEdit } | undefined {
  const lines = text.split(/\r?\n/);
  const quoted = (i: number) => /^\s{0,3}>/.test(lines[i] ?? '');
  if (!quoted(line)) return undefined;
  let start = line;
  while (start > 0 && quoted(start - 1)) start--;
  let end = line;
  while (end + 1 < lines.length && quoted(end + 1)) end++;

  const body = lines.slice(start, end + 1).map((l) => l.replace(/^\s{0,3}>\s?/, ''));
  let type: string | undefined;
  let first = body[0];
  const alert = /^\[!(\w+)\]\s*$/.exec(first);
  if (alert) {
    type = ALERTS[alert[1].toUpperCase()];
    first = '';
  } else {
    const label = /^(?:\*\*|__)(\w+)(?::(?:\*\*|__)|(?:\*\*|__):)\s*/.exec(first);
    if (label) {
      type = LABELS[label[1].toLowerCase()];
      first = first.slice(label[0].length);
    }
  }
  if (!type) return undefined;
  const content = first.trim() ? [first, ...body.slice(1)] : body.slice(1);
  while (content.length && !content[0].trim()) content.shift();
  while (content.length && !content[content.length - 1].trim()) content.pop();
  return { type, edit: { startLine: start, endLine: end, lines: [`:::${type}`, ...content, ':::'] } };
}

/** Callout types a callout container can be converted to. */
export const isCallout = (name: string): boolean => (CALLOUT_TYPES as readonly string[]).includes(name);
