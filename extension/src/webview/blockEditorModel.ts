// The Block Editor page's logic that needs no DOM: labels, which blocks to keep, the order to put them in, keys.
// The page (blockEditor.ts) does the DOM work; the unit tests import this module directly. Types only from the
// session module: nothing of the .smd engine reaches the page.
import type { BlockProblems, BlockView, FormField, InlineView, RenderMessage } from '../blockEditorSession';

export interface LineRange {
  start: number;
  end: number;
}

/** A block kind as people say it. */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  paragraph: 'Paragraph',
  heading: 'Heading',
  fence: 'Code block',
  code: 'Indented code',
  table: 'Table',
  list: 'List',
  blockquote: 'Quote',
  math: 'Math',
  html: 'HTML',
  hr: 'Divider',
  gap: 'Unrendered lines',
  frontmatter: 'Front matter',
};

/** What a block is, in words: "Paragraph", "Warning container", "Code block". */
export function blockName(view: Pick<BlockView, 'type' | 'container'>): string {
  if (view.type === 'container') {
    const name = view.container ?? 'container';
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} container`;
  }
  return TYPE_NAMES[view.type] ?? `${view.type.charAt(0).toUpperCase()}${view.type.slice(1)}`;
}

/** "lines 3–5" (one-based, as editors number them), or "line 3". */
export function linesLabel(range: LineRange): string {
  const first = range.start + 1;
  const last = Math.max(first, range.end);
  return first === last ? `line ${first}` : `lines ${first}–${last}`;
}

/** "Paragraph, lines 3–5". */
export function blockLabel(view: Pick<BlockView, 'type' | 'container' | 'start' | 'end'>): string {
  return `${blockName(view)}, ${linesLabel(view)}`;
}

/** The label of the textarea that edits a block: "Edit source of paragraph, lines 3–5". */
export function editLabel(view: Pick<BlockView, 'type' | 'container' | 'start' | 'end'>): string {
  const name = blockName(view);
  return `Edit source of ${name.charAt(0).toLowerCase()}${name.slice(1)}, ${linesLabel(view)}`;
}

/** "1 problem", "3 problems". */
export function problemsLabel(problems: BlockProblems | undefined): string {
  if (!problems?.count) return '';
  return `${problems.count} ${problems.count === 1 ? 'problem' : 'problems'}`;
}

/** Rendered HTML without its source line numbers, to tell whether a block that only moved looks the same. */
export function withoutLines(html: string): string {
  return html.replaceAll(/ data-(?:task-)?line="\d*"/g, '');
}

/** A data-line or data-task-line value moved by `delta` lines (values that are not numbers are left alone). */
export function shiftLine(value: string, delta: number): string {
  return /^\d+$/.test(value) ? String(Number.parseInt(value, 10) + delta) : value;
}

/** A marker for the block being edited, which keeps its place and is never replaced. */
export const FROZEN = '\u0000frozen';

const overlaps = (a: LineRange, b: LineRange) => a.start < b.end && b.start < a.end;

/**
 * The top-level blocks to show, by key, in order. The block being edited (`frozen`: the lines it covers now)
 * stands in for every block on its lines, at the first of them, or where its lines would be when none is left.
 */
export function desiredOrder(blocks: readonly Pick<BlockView, 'key' | 'start' | 'end'>[], frozen: LineRange | null): string[] {
  const order: string[] = [];
  let placed = !frozen;
  for (const b of blocks) {
    if (frozen && overlaps(b, frozen)) {
      if (!placed) order.push(FROZEN);
      placed = true;
      continue;
    }
    if (!placed && frozen && b.start >= frozen.end) {
      order.push(FROZEN);
      placed = true;
    }
    order.push(b.key);
  }
  if (!placed) order.push(FROZEN);
  return order;
}

/**
 * The insertBefore calls that turn `current` into `desired` (both lists of distinct ids; ids of `current` not in
 * `desired` are removed first). Inserts and removals move nothing else, so focus and state stay where they are;
 * only a block that changed places is moved. `before` null means at the end.
 */
export function orderMoves(current: readonly string[], desired: readonly string[]): { id: string; before: string | null }[] {
  const wanted = new Set(desired);
  const now = current.filter((id) => wanted.has(id));
  const moves: { id: string; before: string | null }[] = [];
  desired.forEach((id, i) => {
    if (now[i] === id) return;
    const from = now.indexOf(id);
    if (from >= 0) now.splice(from, 1);
    moves.push({ id, before: now[i] ?? null });
    now.splice(i, 0, id);
  });
  return moves;
}

/** Where the arrow keys, Home and End move in a list of `count` items from `index`; -1 for other keys. */
export function listKeyTarget(key: string, index: number, count: number, wrap = false): number {
  if (count === 0) return -1;
  switch (key) {
    case 'ArrowDown':
      if (index + 1 < count) return index + 1;
      return wrap ? 0 : index;
    case 'ArrowUp':
      if (index > 0) return index - 1;
      return wrap ? count - 1 : index;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return -1;
  }
}

/** The toolbar's arrow keys (left and right, wrapping), Home and End; -1 for other keys. */
export function toolbarKeyTarget(key: string, index: number, count: number): number {
  if (key === 'ArrowRight') return listKeyTarget('ArrowDown', index, count, true);
  if (key === 'ArrowLeft') return listKeyTarget('ArrowUp', index, count, true);
  return key === 'Home' || key === 'End' ? listKeyTarget(key, index, count) : -1;
}

/** The next name after `from` (wrapping) that starts with `char`, ignoring case; -1 when none does. */
export function typeAhead(names: readonly string[], char: string, from: number): number {
  const c = char.toLowerCase();
  for (let step = 1; step <= names.length; step++) {
    const i = (from + step) % names.length;
    if (names[i].toLowerCase().startsWith(c)) return i;
  }
  return -1;
}

/** The item to focus for a line: the one starting on it, else the first starting after it, else the last. */
export function itemForLine(starts: readonly number[], line: number): number {
  const exact = starts.indexOf(line);
  if (exact >= 0) return exact;
  const after = starts.findIndex((s) => s > line);
  return after >= 0 ? after : starts.length - 1;
}

/** Keys that undo or redo: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y (as VS Code's webview host reads them). */
export function isUndoRedo(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  if (!e.ctrlKey && !e.metaKey) return false;
  return e.code === 'KeyZ' || e.code === 'KeyY' || ['z', 'y'].includes(e.key.toLowerCase());
}

/** What a form control asks for: setTitle, or setAttr with a value (null removes the attribute, true writes a flag). */
export type FormRequest = { type: 'setTitle'; title: string } | { type: 'setAttr'; name: string; value: string | true | null };

export function formRequest(field: Pick<FormField, 'name' | 'kind'>, value: string | boolean): FormRequest {
  if (field.kind === 'title') return { type: 'setTitle', title: String(value).trim() };
  if (field.kind === 'flag') return { type: 'setAttr', name: field.name, value: value ? true : null };
  const text = String(value).trim();
  return { type: 'setAttr', name: field.name, value: text === '' ? null : text };
}

/** The field of an inline form for the text in the brackets (CONTENT_FIELD in the session). */
const CONTENT = 'content';

/** What an inline form asks for: new content, attributes to set or remove (null). */
export interface InlineRequest {
  content?: string;
  attrs?: Record<string, string | null>;
}

/**
 * The setInline fields for an inline form's values (by field name): only what changed, trimmed; an emptied
 * attribute is removed. Null when nothing changed.
 */
export function inlineRequest(fields: readonly Pick<FormField, 'name' | 'value'>[], values: Readonly<Record<string, string>>): InlineRequest | null {
  const request: InlineRequest = {};
  const attrs: Record<string, string | null> = {};
  for (const field of fields) {
    const value = (values[field.name] ?? field.value).trim();
    if (value === field.value) continue;
    if (field.name === CONTENT) request.content = value;
    else attrs[field.name] = value === '' ? null : value;
  }
  if (Object.keys(attrs).length) request.attrs = attrs;
  return request.content === undefined && !request.attrs ? null : request;
}

/** How an inline item is named to a screen reader: 'Badge "Shipped", press Enter to edit'. */
export function inlineItemLabel(view: Pick<InlineView, 'label' | 'text'>): string {
  return view.text ? `${view.label} "${view.text}", press Enter to edit` : `${view.label}, press Enter to edit`;
}

/** What is announced when an inline form is applied: 'Badge: Text "Done", Color green.' */
export function inlineAnnouncement(view: Pick<InlineView, 'label' | 'fields'>, request: InlineRequest): string {
  const label = (name: string) => view.fields?.find((f) => f.name === name)?.label ?? name;
  const parts: string[] = [];
  if (request.content !== undefined) parts.push(`${label(CONTENT)} "${request.content}"`);
  for (const [name, value] of Object.entries(request.attrs ?? {})) parts.push(value === null ? `${label(name)} removed` : `${label(name)} ${value}`);
  return `${view.label}: ${parts.join(', ')}.`;
}

/** A block of the render (top-level or child, at any depth) by key. */
export function findView(blocks: readonly BlockView[], key: string): BlockView | undefined {
  for (const b of blocks) {
    if (b.key === key) return b;
    const child = b.children && findView(b.children, key);
    if (child) return child;
  }
  return undefined;
}

/** The first block (top-level or child, at any depth) that starts on a line. */
function viewAt(blocks: readonly BlockView[], line: number): BlockView | undefined {
  for (const b of blocks) {
    if (b.kind === 'block' && b.start === line) return b;
    const child = b.children && b.start <= line && line < b.end ? viewAt(b.children, line) : undefined;
    if (child) return child;
  }
  return undefined;
}

/**
 * Where the block being edited is in a new render: its key may have been renamed (its lines are one block again,
 * under a new key) or pinned (they are not), or it is still there under its key. A key the extension no longer
 * knows (the block changed in another editor before the page edited it) goes to the block on its first line.
 */
export function followEdit(render: Pick<RenderMessage, 'blocks' | 'renamed' | 'pins'>, key: string, range: LineRange): { key: string; range: LineRange } {
  const next = render.renamed[key] ?? key;
  const view = findView(render.blocks, next);
  if (view) return { key: next, range: { start: view.start, end: view.end } };
  const pin = render.pins[key];
  if (pin) return { key: next, range: { start: pin.start, end: pin.end } };
  const at = viewAt(render.blocks, range.start);
  return at ? { key: at.key, range: { start: at.start, end: at.end } } : { key: next, range };
}

/** The top-level block that holds a range (a child being edited is frozen with its whole container). */
export function topRange(blocks: readonly Pick<BlockView, 'start' | 'end'>[], range: LineRange): LineRange {
  const holder = blocks.find((b) => b.start <= range.start && range.end <= b.end);
  return holder ? { start: holder.start, end: holder.end } : range;
}

/** The number of rows a textarea needs for a text (at least 2, at most 40). */
export function textareaRows(text: string): number {
  return Math.min(40, Math.max(2, text.split('\n').length + 1));
}
