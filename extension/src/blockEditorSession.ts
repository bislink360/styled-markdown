// The Block Editor's host side, without the `vscode` module: the messages between the editor page and the
// extension, how each is checked, the table of blocks the page was given, the log of line edits that brings an old
// block range up to date, and the edit each request makes. The provider (blockEditor.ts) wires it to a TextDocument;
// the unit tests drive it with a fake document.
//
// The guarantee: lines the user did not edit never change. The page never sends ranges, only block keys and the
// text it was given; the host finds the block's lines in the document as it is now, checks they still hold that
// text, and changes only those lines (or inserts whole lines between blocks).
import { containerHeader, lexAttrs, removeContainerAttr, setContainerAttr, setContainerTitle } from './core/attrEdit';
import type { BlockRender, Segment } from './core/blocks';
import { parseFrontMatter } from './core/frontmatter';
import { FRONT_MATTER_FIELDS, frontMatterFields, isFrontMatterRefusal, setFrontMatterValue } from './core/frontMatterEdit';
import { editInline, scanInline, SPAN, type InlineChange, type InlineItem, type RenderedInline } from './core/inlineEdit';
import { applyLineEdits, deleteBlock, insertBlock, lineEditToTextEdit, minimalEdit, moveBlock, splitLines, type LineEdit, type LineRange, type TextEdit } from './core/sourceEdit';
import { CONTAINERS, INLINE_DIRECTIVES, NAMED_COLORS, PRIORITY_VALUES, type ContainerSpec, type InlineDirectiveSpec } from './core/spec';
import {
  TABLE_ALIGNS, alignTable, cellTexts, deleteColumn, deleteRow, insertColumn, insertRow, isRefusal, readTable, sameShape, setAlign, setCell, tableShape,
  type TableAlign, type TableCellRef, type TableEdit, type TableRefusal, type TableSource,
} from './core/tableEdit';
import type { BlockTemplate } from './core/templates';
import { substituteLine, type Variables } from './core/variables';

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** Where a template goes when it isn't put after a block. */
export type InsertPosition = 'start' | 'end';
export type MoveDirection = 'up' | 'down';

/** What the editor page asks for. Anything else it sends is ignored. */
export type EditorMessage =
  | { type: 'ready' }
  | { type: 'edit'; key: string; baseVersion: number; oldText: string; newText: string; editId: string }
  | { type: 'insert'; template: string; atKey?: string; position?: InsertPosition; editId?: string }
  | { type: 'delete'; key: string; editId?: string }
  | { type: 'move'; key: string; direction: MoveDirection; editId?: string }
  | { type: 'setAttr'; key: string; name: string; value: string | true | null; editId?: string }
  | { type: 'setTitle'; key: string; title: string; editId?: string }
  | SetInlineMessage
  | TableMessage
  | { type: 'addFrontMatter'; editId?: string }
  | SetFrontMatterMessage
  | { type: 'getFixes'; key: string; requestId: number }
  | ApplyFixMessage
  | { type: 'toggleTask'; line: number }
  | { type: 'openLink'; href: string }
  | { type: 'revealLine'; line: number }
  | { type: 'flushed'; requestId: number };

/**
 * Change one inline directive or styled span of a top-level block: the `index`th the block's HTML numbers
 * (`data-smd-inline`), which the page believes is a `name` (a directive's name, or 'span'). `content` replaces the
 * text in its brackets; `attrs` sets (a value) or removes (null) attributes.
 */
export interface SetInlineMessage {
  type: 'setInline';
  key: string;
  index: number;
  name: string;
  content?: string;
  attrs?: Record<string, string | null>;
  editId?: string;
}

/**
 * A change to a table block in the grid. Rows count from the header (0); the delimiter row is not one. `at` is where
 * a new row or column goes (a row: 1 to the row count; a column: 0 to the column count), or the row or column to
 * delete or align.
 */
export type TableMessage =
  | { type: 'tableCell'; key: string; row: number; col: number; text: string; editId?: string }
  | { type: 'tableRow'; key: string; op: 'insert' | 'delete'; at: number; editId?: string }
  | { type: 'tableCol'; key: string; op: 'insert' | 'delete' | 'align'; at: number; align?: TableAlign; editId?: string }
  | { type: 'tableAlign'; key: string; editId?: string };

/**
 * Set a known front matter key (FRONT_MATTER_FIELDS) of the front matter block `key`: a text, a list's items, or
 * null to remove the key.
 */
export interface SetFrontMatterMessage {
  type: 'setFrontMatter';
  key: string;
  name: string;
  value: string | string[] | null;
  editId?: string;
}

/**
 * Apply the `index`th quick fix the host listed for a block (`fixes`) at document `version`. The page names the fix,
 * never its edits. `confirm`: the user agreed that it also changes lines outside the block, or other files.
 */
export interface ApplyFixMessage {
  type: 'applyFix';
  key: string;
  index: number;
  version: number;
  confirm?: true;
  editId?: string;
}

/** The messages the session itself answers; the provider runs the others (toggleTask, openLink, revealLine). */
export type SessionMessage = Exclude<EditorMessage, { type: 'toggleTask' | 'openLink' | 'revealLine' }>;

/** Problems reported on a block's lines. */
export interface BlockProblems {
  count: number;
  severity: DiagnosticSeverity;
  /** "Line 4: message", at most MAX_PROBLEM_MESSAGES of them. */
  messages: string[];
}

/** A form control: 'list' is a text field of items separated by commas (front matter lists). */
export type FormFieldKind = 'title' | 'select' | 'flag' | 'text' | 'color' | 'date' | 'list';

/** One control of a container's header form. */
export interface FormField {
  /** The attribute key; 'title' for the title, which setTitle edits. */
  name: string;
  kind: FormFieldKind;
  label: string;
  /** The value written now ('' when there is none; 'true' for a flag that is set). */
  value: string;
  /** Choices of a select or color field ('' first: not set). */
  options?: string[];
  /** Why the form can't change this field (its text must be edited instead). */
  refused?: string;
}

/** A container's header as a form: its title and the attributes its kind takes. */
export interface ContainerForm {
  name: string;
  fields: FormField[];
}

/**
 * An inline directive or styled span of a block, by the number its HTML gives it (`data-smd-inline`). With
 * `fields`, the page edits it in a small form (setInline); without, only the block's source can change it.
 */
export interface InlineView {
  index: number;
  /** The directive's name, or 'span'. */
  name: string;
  /** What it is, in words: "Badge", "Due date", "Styled text". */
  label: string;
  /** Its text as written, shortened: the content, or the span's text. */
  text: string;
  /** The form's controls: 'content' for the text in its brackets, else attribute keys. */
  fields?: FormField[];
}

/** A block, or a gap between blocks, as the page shows it. */
export interface BlockView {
  key: string;
  kind: 'block' | 'gap';
  /** The block kind (paragraph, heading, list, container…); 'gap' for a gap. */
  type: string;
  container?: string;
  /** Zero-based document lines [start, end). */
  start: number;
  end: number;
  /** The block's own lines, joined with \n. */
  source: string;
  /** A gap of blank lines only: not shown, but a place to insert. */
  blank?: boolean;
  /** Rendered HTML (top-level blocks only; children are found in their container's HTML by data-line). */
  html?: string;
  children?: BlockView[];
  form?: ContainerForm;
  problems?: BlockProblems;
  /** A top-level block's inline directives and styled spans, by number (left out when it has none). */
  inline?: InlineView[];
  /** A table block, as the grid edits it (top-level blocks and children). */
  table?: TableView;
}

/** A table for the grid: its cells and alignments, or why only its source can change it. */
export interface TableView {
  /** Every cell's text as written (an escaped pipe stays `\|`), the header row first. */
  rows?: string[][];
  aligns?: TableAlign[];
  refused?: string;
}

export interface FrontMatterView {
  key: string;
  start: number;
  end: number;
  source: string;
  problems?: BlockProblems;
  /** The known keys as form fields (setFrontMatter); left out when only the YAML can be edited, and `formRefused` says why. */
  fields?: FormField[];
  formRefused?: string;
}

/** A template the insert menu offers. */
export interface TemplateView {
  name: string;
  description?: string;
}

export interface RenderMessage {
  type: 'render';
  /** The document version everything here belongs to. */
  version: number;
  /** renderSmd's frame: the `<article …>` tag, the title header, the contents and the footnotes. */
  open: string;
  header: string;
  toc: string;
  tail: string;
  themePref: string;
  frontMatter: FrontMatterView | null;
  /** Top-level blocks and gaps, in order. */
  blocks: BlockView[];
  /** Keys the page edited that now name another block: old key → new key. */
  renamed: Record<string, string>;
  /** Where the blocks the page edited are now, for those whose lines are no longer one block. */
  pins: Record<string, LineRange>;
  templates: TemplateView[];
}

/** After an edit: the block to focus once the render of `version` arrives, optionally in edit mode. */
export interface FocusRequest {
  line: number;
  edit?: boolean;
  /** Text to select in the editor, as offsets into the block's source. */
  select?: { from: number; to: number };
  /** The inline item of the block to focus (its data-smd-inline number). */
  inline?: number;
  /** The table block's cell to focus in the grid. */
  cell?: TableCellRef;
}

/**
 * Where a quick fix changes the document: only the block's own lines, lines outside it too, or other files as
 * well (or it creates, renames or deletes files).
 */
export type FixScope = 'block' | 'lines' | 'files';

/** A quick fix as the page lists it: its title and what it changes. */
export interface FixView {
  title: string;
  scope: FixScope;
}

/** The quick fixes of a block at a document version; `error` says why there are none to offer. */
export interface FixesMessage {
  type: 'fixes';
  requestId: number;
  key: string;
  version: number;
  fixes: FixView[];
  error?: string;
}

export type HostMessage =
  | RenderMessage
  | FixesMessage
  /** A fix that changes more than the block: the page asks the user, then sends applyFix again with `confirm`. */
  | { type: 'confirmFix'; editId?: string; key: string; index: number; version: number; text: string }
  | { type: 'ack'; editId: string; version: number; focus?: FocusRequest }
  | { type: 'conflict'; editId: string; key: string; currentText: string | null }
  /** `fallback`: the key of a block to edit in its source instead (an inline item the form can't change). */
  | { type: 'notice'; editId?: string; text: string; fallback?: string }
  | { type: 'flush'; requestId: number };

// ---------------------------------------------------------------------------
// Message validation (as readPosition in previewSync.ts: anything malformed is ignored)
// ---------------------------------------------------------------------------

/** The longest text an edit may carry (characters). */
export const MAX_TEXT = 4_000_000;
const KEY = /^[0-9a-z]{1,16}#\d{1,9}$/;
const ID = /^[\w-]{1,64}$/;
const ATTR_NAME = /^[A-Za-z_][\w-]{0,63}$/;
const MAX_VALUE = 2000;

type Raw = Record<string, unknown>;
type Reader = (m: Raw) => EditorMessage | undefined;

const isKey = (v: unknown): v is string => typeof v === 'string' && KEY.test(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isText = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max;
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
/** An optional editId: absent, or a valid id. */
const optionalId = (v: unknown): boolean => v === undefined || isId(v);
const withId = (message: EditorMessage, editId: unknown): EditorMessage => (isId(editId) ? ({ ...message, editId } as EditorMessage) : message);

function readValue(v: unknown): string | true | null | undefined {
  if (v === null || v === true) return v;
  return isText(v, MAX_VALUE) ? v : undefined;
}

function readInsert(m: Raw): EditorMessage | undefined {
  if (!isText(m.template, 200) || !optionalId(m.editId)) return undefined;
  if (m.atKey !== undefined) return isKey(m.atKey) ? withId({ type: 'insert', template: m.template, atKey: m.atKey }, m.editId) : undefined;
  if (m.position === 'start' || m.position === 'end') return withId({ type: 'insert', template: m.template, position: m.position }, m.editId);
  return undefined;
}

function readSetAttr(m: Raw): EditorMessage | undefined {
  const value = readValue(m.value);
  if (!isKey(m.key) || typeof m.name !== 'string' || !ATTR_NAME.test(m.name) || value === undefined || !optionalId(m.editId)) return undefined;
  return withId({ type: 'setAttr', key: m.key, name: m.name, value }, m.editId);
}

/** The most inline items a block may number, and attributes one setInline may change. */
const MAX_INLINE = 10_000;
const MAX_INLINE_ATTRS = 16;
const INLINE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** `attrs` of setInline: a plain object of attribute names to a value or null; undefined when it is not one. */
function readInlineAttrs(v: unknown): Record<string, string | null> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const entries = Object.entries(v);
  if (entries.length > MAX_INLINE_ATTRS) return undefined;
  const valid = entries.every(([name, value]) => ATTR_NAME.test(name) && (value === null || isText(value, MAX_VALUE)));
  // fromEntries defines own properties, so a "__proto__" key stays a key.
  return valid ? Object.fromEntries(entries as [string, string | null][]) : undefined;
}

function readSetInline(m: Raw): EditorMessage | undefined {
  if (!isKey(m.key) || !isCount(m.index) || m.index > MAX_INLINE || typeof m.name !== 'string' || !INLINE_NAME.test(m.name) || !optionalId(m.editId)) {
    return undefined;
  }
  const message: SetInlineMessage = { type: 'setInline', key: m.key, index: m.index, name: m.name };
  if (m.content !== undefined) {
    if (!isText(m.content, MAX_VALUE)) return undefined;
    message.content = m.content;
  }
  if (m.attrs !== undefined) {
    const attrs = readInlineAttrs(m.attrs);
    if (!attrs) return undefined;
    message.attrs = attrs;
  }
  return withId(message, m.editId);
}

/** The highest row or column number a table message may name, and the longest text a cell may get. */
const MAX_TABLE_INDEX = 100_000;
const MAX_CELL = 10_000;
const isIndex = (v: unknown): v is number => isCount(v) && v <= MAX_TABLE_INDEX;

function readTableCell(m: Raw): EditorMessage | undefined {
  if (!isKey(m.key) || !isIndex(m.row) || !isIndex(m.col) || !isText(m.text, MAX_CELL) || !optionalId(m.editId)) return undefined;
  return withId({ type: 'tableCell', key: m.key, row: m.row, col: m.col, text: m.text }, m.editId);
}

function readTableRow(m: Raw): EditorMessage | undefined {
  if (!isKey(m.key) || (m.op !== 'insert' && m.op !== 'delete') || !isIndex(m.at) || !optionalId(m.editId)) return undefined;
  return withId({ type: 'tableRow', key: m.key, op: m.op, at: m.at }, m.editId);
}

function readTableCol(m: Raw): EditorMessage | undefined {
  if (!isKey(m.key) || (m.op !== 'insert' && m.op !== 'delete' && m.op !== 'align') || !isIndex(m.at) || !optionalId(m.editId)) return undefined;
  if (m.op !== 'align') return m.align === undefined ? withId({ type: 'tableCol', key: m.key, op: m.op, at: m.at }, m.editId) : undefined;
  const align = TABLE_ALIGNS.find((a) => a === m.align);
  return align ? withId({ type: 'tableCol', key: m.key, op: 'align', at: m.at, align }, m.editId) : undefined;
}

/** The most items a front matter list may get from the form. */
const MAX_LIST_ITEMS = 200;
/** A single-line value: no line breaks. */
const isLine = (v: unknown): v is string => isText(v, MAX_VALUE) && !/[\r\n]/.test(v);

function readSetFrontMatter(m: Raw): EditorMessage | undefined {
  if (!isKey(m.key) || typeof m.name !== 'string' || !FRONT_MATTER_FIELDS.includes(m.name) || !optionalId(m.editId)) return undefined;
  const list = Array.isArray(m.value) && m.value.length <= MAX_LIST_ITEMS && m.value.every((item) => isLine(item) && item.trim() !== '');
  if (m.value !== null && !isLine(m.value) && !list) return undefined;
  const value = list ? [...(m.value as string[])] : (m.value as string | null);
  return withId({ type: 'setFrontMatter', key: m.key, name: m.name, value }, m.editId);
}

/** The most quick fixes the host lists for a block. */
export const MAX_FIXES = 50;

function readApplyFix(m: Raw): EditorMessage | undefined {
  if (!isKey(m.key) || !isCount(m.index) || m.index >= MAX_FIXES || !isCount(m.version) || !optionalId(m.editId)) return undefined;
  if (m.confirm !== undefined && m.confirm !== true) return undefined;
  const message: ApplyFixMessage = { type: 'applyFix', key: m.key, index: m.index, version: m.version };
  if (m.confirm) message.confirm = true;
  return withId(message, m.editId);
}

const READERS: Readonly<Record<string, Reader>> = {
  ready: () => ({ type: 'ready' }),
  edit: (m) =>
    isKey(m.key) && isCount(m.baseVersion) && isText(m.oldText) && isText(m.newText) && isId(m.editId)
      ? { type: 'edit', key: m.key, baseVersion: m.baseVersion, oldText: m.oldText, newText: m.newText, editId: m.editId }
      : undefined,
  insert: readInsert,
  delete: (m) => (isKey(m.key) && optionalId(m.editId) ? withId({ type: 'delete', key: m.key }, m.editId) : undefined),
  move: (m) =>
    isKey(m.key) && (m.direction === 'up' || m.direction === 'down') && optionalId(m.editId)
      ? withId({ type: 'move', key: m.key, direction: m.direction }, m.editId)
      : undefined,
  setAttr: readSetAttr,
  setTitle: (m) =>
    isKey(m.key) && isText(m.title, MAX_VALUE) && optionalId(m.editId) ? withId({ type: 'setTitle', key: m.key, title: m.title }, m.editId) : undefined,
  setInline: readSetInline,
  tableCell: readTableCell,
  tableRow: readTableRow,
  tableCol: readTableCol,
  tableAlign: (m) => (isKey(m.key) && optionalId(m.editId) ? withId({ type: 'tableAlign', key: m.key }, m.editId) : undefined),
  addFrontMatter: (m) => (optionalId(m.editId) ? withId({ type: 'addFrontMatter' }, m.editId) : undefined),
  setFrontMatter: readSetFrontMatter,
  getFixes: (m) => (isKey(m.key) && isCount(m.requestId) ? { type: 'getFixes', key: m.key, requestId: m.requestId } : undefined),
  applyFix: readApplyFix,
  toggleTask: (m) => (isCount(m.line) ? { type: 'toggleTask', line: m.line } : undefined),
  openLink: (m) => (isText(m.href, 4096) && m.href !== '' ? { type: 'openLink', href: m.href } : undefined),
  revealLine: (m) => (isCount(m.line) ? { type: 'revealLine', line: m.line } : undefined),
  flushed: (m) => (isCount(m.requestId) ? { type: 'flushed', requestId: m.requestId } : undefined),
};

/** A message from the editor page, or undefined when it is not one (wrong type, missing or malformed fields). */
export function readEditorMessage(raw: unknown): EditorMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Raw;
  if (typeof m.type !== 'string' || !Object.hasOwn(READERS, m.type)) return undefined;
  return READERS[m.type](m);
}

// ---------------------------------------------------------------------------
// The log of text changes, and line ranges brought up to date through it
// ---------------------------------------------------------------------------

/** A change to the document as VS Code reports it: a range of the text before, replaced by `text`. */
export interface TextChange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
}

/** How many changes the log keeps; ranges older than what it holds can't be brought up to date. */
export const MAX_LOG = 1000;

const lineBreaks = (text: string) => text.split('\n').length - 1;

/**
 * Where the start of line `line` is after a change. `after` decides an insertion right at that point: a block's
 * first line moves down past lines inserted before it (true), its end stays before lines added after it (false).
 */
export function mapBoundary(line: number, c: TextChange, after: boolean): number {
  if (startsAfter(c, line)) return line;
  const breaks = lineBreaks(c.text);
  if (isInsertionAt(c, line)) return after ? line + breaks : line;
  if (endsBefore(c, line)) return line + breaks - (c.endLine - c.startLine);
  // Inside the replaced text: the block was changed there, which the text check will see.
  return after ? c.startLine : c.startLine + breaks + 1;
}

/** The change starts after the start of `line`. */
function startsAfter(c: TextChange, line: number): boolean {
  return c.startLine > line || (c.startLine === line && c.startCharacter > 0);
}

/** Text inserted (nothing replaced) right at the start of `line`. */
function isInsertionAt(c: TextChange, line: number): boolean {
  return c.startLine === line && c.endLine === line && c.startCharacter === 0 && c.endCharacter === 0;
}

/** The change ends at or before the start of `line`. */
function endsBefore(c: TextChange, line: number): boolean {
  return c.endLine < line || (c.endLine === line && c.endCharacter === 0);
}

/** Every text change since a version, so a line range from that version can be found in the document now. */
export class EditLog {
  private entries: { version: number; changes: TextChange[] }[] = [];
  /** The log holds every change made after this version. */
  private since: number;

  constructor(version: number) {
    this.since = version;
  }

  /** Remember the changes that produced document version `version`. */
  record(version: number, changes: readonly TextChange[]): void {
    this.entries.push({ version, changes: changes.slice() });
    if (this.entries.length > MAX_LOG) {
      const dropped = this.entries.splice(0, this.entries.length - MAX_LOG / 2);
      this.since = dropped.at(-1)!.version;
    }
  }

  /** A line range of version `from` in version `to`'s lines; undefined when the log no longer reaches back to `from`. */
  mapRange(range: LineRange, from: number, to: number): LineRange | undefined {
    if (from < this.since || from > to) return undefined;
    let { start, end } = range;
    for (const entry of this.entries) {
      if (entry.version <= from || entry.version > to) continue;
      for (const c of entry.changes) {
        start = mapBoundary(start, c, true);
        end = mapBoundary(end, c, false);
      }
    }
    return { start, end: Math.max(start, end) };
  }
}

// ---------------------------------------------------------------------------
// The document, as the session sees it
// ---------------------------------------------------------------------------

/** The document the session edits (a TextDocument in VS Code, a string in the tests). */
export interface DocumentPort {
  getText(): string;
  readonly version: number;
  /** The document's line ending; new lines get it. */
  readonly eol: '\n' | '\r\n';
  /** Apply edits, given as offsets into getText() and not overlapping, as one undoable change. */
  applyEdits(edits: readonly TextEdit[]): PromiseLike<boolean> | boolean;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** A problem VS Code reports on a line. */
export interface LineDiagnostic {
  line: number;
  message: string;
  severity: DiagnosticSeverity;
}

export interface SessionOptions {
  /** Render the document block by block (renderBlocks with the preview's options). */
  render(text: string): BlockRender;
  /** Segment the document (segmentSmd with the same options); render(text).segments when left out. */
  segment?(text: string): Segment[];
  templates: readonly BlockTemplate[];
  post(message: HostMessage): void;
  /** The problems on the document now. */
  diagnostics?(): readonly LineDiagnostic[];
  /** `data-smd-theme-pref` for the page, from the render's front matter. */
  themePref?(frontMatter: Record<string, unknown>): string;
  /** The title a new front matter gets (the file name). */
  title?: string;
  /** The inline directives and styled spans of a block's lines (scanInline with the render's allowHtml). */
  scan?(lines: readonly string[]): InlineItem[];
  /** A table block's lines read for the grid (readTable with the render's allowHtml). */
  table?(lines: readonly string[]): TableSource | TableRefusal;
  /** The quick fixes VS Code has for the problems on lines [start, end): code actions of kind quickfix with an edit. */
  quickFixes?(range: LineRange): PromiseLike<readonly QuickFix[]>;
}

/** A position in the document: a zero-based line and a UTF-16 column. */
export interface DocPosition {
  line: number;
  character: number;
}

/** A quick fix as a provider made it. The session checks where it writes; `apply` writes its whole edit as made. */
export interface QuickFix {
  title: string;
  /** The ranges its text edits replace in this document. */
  edits: readonly { start: DocPosition; end: DocPosition }[];
  /** It also changes other files, or creates, renames or deletes files. */
  elsewhere: boolean;
  /** The lines of the problems it fixes (empty when the provider didn't say). */
  diagnostics: readonly number[];
  /** Apply its WorkspaceEdit exactly as the provider made it; false when that fails. */
  apply(): PromiseLike<boolean> | boolean;
}

/** Where a fix writes, against a block's lines [start, end): inside them only, other lines too, or other files. */
export function fixScope(fix: Pick<QuickFix, 'edits' | 'elsewhere'>, range: LineRange): FixScope {
  if (fix.elsewhere) return 'files';
  // An edit that reaches the start of the line after the block changes that line's place: it is outside.
  return fix.edits.every((e) => e.start.line >= range.start && e.end.line < range.end) ? 'block' : 'lines';
}

/** What the integration test (smd._blockEditorStatus) reads. */
export interface BlockEditorStatus {
  version: number;
  /** Top-level blocks (not gaps, not the front matter) in the last render. */
  blocks: number;
  keys: string[];
  lastAck: string | null;
  renders: number;
}

/** Where a block was, in the lines of `version`, and the text it had. */
interface Entry extends LineRange {
  version: number;
  text: string;
}

/** A block found in the document now: its lines, the document's text and lines. */
interface Found {
  range: LineRange;
  text: string;
  lines: string[];
}

export const MAX_PROBLEM_MESSAGES = 10;
const MAX_PINS = 32;
const CONTAINER = 'container';
const BLOCK = 'block';
const GAP = 'gap';
const FRONT_MATTER = 'frontmatter';
const NOT_APPLIED = 'The edit could not be applied.';
const TITLE = 'title';
const FLAGS = new Set(['collapsible', 'open']);
const COLOR_KEYS = ['color', 'bg', 'border'];
const COLOR_ATTRS = new Set(['accent', ...COLOR_KEYS]);
const LABELS: Readonly<Record<string, string>> = { color: 'Text color', bg: 'Background', border: 'Border', accent: 'Accent color', title: 'Title' };
const FRONT_MATTER_LABELS: Readonly<Record<string, string>> = {
  toc: 'Table of contents', smd: 'Styled Markdown version', lang: 'Language', related: 'Related documents', accent: 'Accent color',
};
const SEVERITY_RANK:Readonly<Record<DiagnosticSeverity, number>> = { error: 0, warning: 1, info: 2 };
const NOT_FOUND = 'That block is no longer in the document.';
const TABLE = 'table';
const TABLE_SOURCE = 'Edit the table\'s source instead.';
const NO_FIXES = 'Quick fixes are not available here.';
const FIXES_STALE = 'The document changed since the fixes were listed: choose the fix again.';
/** How many blocks' quick fixes are kept. */
const MAX_FIX_CACHE = 16;

const lf = (text: string) => text.replaceAll('\r\n', '\n');
const isBlankText = (text: string) => text.trim() === '';

/** Offsets of the text of lines [start, end): from the first line's start to the last line's end, line break excluded. */
export function lineSpan(text: string, range: LineRange): { from: number; to: number } | undefined {
  const starts = [0];
  const ends: number[] = [];
  const re = /\r?\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    ends.push(m.index);
    starts.push(m.index + m[0].length);
  }
  ends.push(text.length);
  if (range.start < 0 || range.end <= range.start || range.end > starts.length) return undefined;
  return { from: starts[range.start], to: ends[range.end - 1] };
}

function newer(a: Entry | undefined, b: Entry | undefined): Entry | undefined {
  if (!a || !b) return a ?? b;
  return b.version > a.version ? b : a;
}

/** A label for an attribute key. */
function fieldLabel(key: string): string {
  return LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function attrField(key: string, spec: ContainerSpec, values: ReadonlyMap<string, string>): FormField {
  const value = values.get(key) ?? '';
  const choices = spec.values?.[key];
  if (choices) return { name: key, kind: 'select', label: fieldLabel(key), value, options: ['', ...choices] };
  if (FLAGS.has(key)) return { name: key, kind: 'flag', label: fieldLabel(key), value: values.has(key) ? 'true' : '' };
  if (COLOR_ATTRS.has(key)) return colorField(key, value);
  return { name: key, kind: 'text', label: fieldLabel(key), value };
}

function colorField(key: string, value: string): FormField {
  const named: readonly string[] = NAMED_COLORS;
  const options = ['', ...named, ...(value && !named.includes(value) ? [value] : [])];
  return { name: key, kind: 'color', label: fieldLabel(key), value, options };
}

/**
 * The header form of a container's opening line: its title, its kind's attributes (CONTAINERS[name].attrs, with
 * .values as choices) and the color keys. Undefined for an unknown kind or an attribute list that doesn't parse,
 * which only the source can fix.
 */
export function containerForm(line: string, name: string | undefined): ContainerForm | undefined {
  const spec = name ? CONTAINERS[name.toLowerCase()] : undefined;
  const header = containerHeader(line);
  // An attribute list that is never closed: only the source can fix it.
  if (!spec || !header || !name || (!header.attrs && line[header.name.end] === '{')) return undefined;
  const items = header.attrs ? lexAttrs(line.slice(header.attrs.start + 1, header.attrs.end - 1)) : [];
  if (!items) return undefined;
  const values = new Map<string, string>();
  for (const item of items) if (item.kind === 'key') values.set(item.name, item.value ?? 'true');
  const fields: FormField[] = [];
  if (spec.title || spec.attrs?.includes(TITLE)) {
    fields.push({ name: TITLE, kind: 'title', label: fieldLabel(TITLE), value: values.get(TITLE) ?? line.slice(header.title.start, header.title.end) });
  }
  for (const key of spec.attrs ?? []) if (key !== TITLE && !COLOR_KEYS.includes(key)) fields.push(attrField(key, spec, values));
  for (const key of COLOR_KEYS) fields.push(colorField(key, values.get(key) ?? ''));
  return { name: name.toLowerCase(), fields };
}

// ---------------------------------------------------------------------------
// Inline directives and styled spans
// ---------------------------------------------------------------------------

/** The field of an inline form for the text in the brackets. */
export const CONTENT_FIELD = 'content';
const INLINE_LABELS: Readonly<Record<string, string>> = {
  badge: 'Badge', kbd: 'Keys', progress: 'Progress bar', mention: 'Mention', status: 'Status', priority: 'Priority', due: 'Due date',
  metric: 'Metric', [SPAN]: 'Styled text',
};
const CONTENT_LABELS: Readonly<Record<string, string>> = {
  badge: 'Text', kbd: 'Keys', progress: 'Value', mention: 'Who', status: 'Label', priority: 'Priority', due: 'Date', metric: 'Value',
};
const INLINE_ATTR_LABELS: Readonly<Record<string, string>> = {
  color: 'Color', bg: 'Background', border: 'Border', value: 'Value', label: 'Label', delta: 'Change', trend: 'Trend', good: 'Good direction',
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INLINE_TEXT = 60;

/** Choices, '' first when the value may be left unset, and the value written now when it is not one of them. */
function choicesWith(choices: readonly string[], value: string, unset: boolean): string[] {
  return [...(unset ? [''] : []), ...choices, ...(value && !choices.includes(value) ? [value] : [])];
}

function contentField(item: InlineItem): FormField {
  const value = item.content ?? '';
  const label = CONTENT_LABELS[item.name] ?? 'Text';
  if (item.name === 'priority') return { name: CONTENT_FIELD, kind: 'select', label, value, options: choicesWith(PRIORITY_VALUES, value, false) };
  // A native date input, unless the date is written some other way (a `{{variable}}`) the input can't show.
  if (item.name === 'due' && (value === '' || ISO_DATE.test(value))) return { name: CONTENT_FIELD, kind: 'date', label, value };
  return { name: CONTENT_FIELD, kind: 'text', label, value };
}

function inlineAttrField(key: string, spec: InlineDirectiveSpec, values: Readonly<Record<string, string>>): FormField {
  const value = values[key] ?? '';
  const label = INLINE_ATTR_LABELS[key] ?? fieldLabel(key);
  const choices = spec.values?.[key];
  if (choices) return { name: key, kind: 'select', label, value, options: choicesWith(choices, value, true) };
  if (key === 'color') return { ...colorField(key, value), label };
  return { name: key, kind: 'text', label, value };
}

/**
 * The form of an inline item: a styled span's color, background and border; a directive's content (a select for
 * :priority, a date for :due) and its attributes (INLINE_DIRECTIVES[name].attrs, with .values as choices). Undefined
 * for an item that is not on one line, which only the source can change.
 */
export function inlineFields(item: InlineItem): FormField[] | undefined {
  if (!item.at) return undefined;
  if (item.kind === SPAN) return COLOR_KEYS.map((key) => ({ ...colorField(key, item.values[key] ?? ''), label: INLINE_ATTR_LABELS[key] }));
  const spec = INLINE_DIRECTIVES[item.name];
  if (!spec) return undefined;
  const content = item.at.content ? [contentField(item)] : [];
  return [...content, ...spec.attrs.map((key) => inlineAttrField(key, spec, item.values))];
}

const sameValues = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.hasOwn(b, k) && a[k] === b[k]);

/** A scanned item and a rendered one are the same directive: name, values and (front matter variables replaced) content. */
function sameItem(item: InlineItem, rendered: RenderedInline, variables: Variables): boolean {
  if (item.kind !== rendered.kind || item.name !== rendered.name || !sameValues(item.values, rendered.values)) return false;
  if (item.kind === SPAN) return true;
  const raw = item.content ?? '';
  return raw === rendered.content || substituteLine(raw, variables) === rendered.content;
}

/**
 * Whether a block's items as scanned in its source are the ones its HTML numbers, one for one. When they are not,
 * the numbers can't be trusted for any of them, and none is edited through a form.
 */
export function inlineAgree(items: readonly InlineItem[], rendered: readonly RenderedInline[], variables: Variables): boolean {
  return items.length === rendered.length && items.every((item, i) => sameItem(item, rendered[i], variables));
}

/** What an item is after a change: its values with the change's set or removed, and its new content. */
function changedItem(item: InlineItem, change: InlineChange): Pick<InlineItem, 'name' | 'content' | 'values'> {
  const attrs = change.attrs ?? {};
  const kept = Object.entries(item.values).filter(([key]) => !Object.hasOwn(attrs, key));
  const set = Object.entries(attrs).filter((entry): entry is [string, string] => entry[1] !== null);
  return { name: item.name, content: change.content ?? item.content, values: Object.fromEntries([...kept, ...set]) };
}

/** After the edit, the block holds the same items, the one changed as asked and every other as it was. */
function changedAsAsked(before: readonly InlineItem[], after: readonly InlineItem[], index: number, change: InlineChange): boolean {
  return after.length === before.length && after.every((a, i) => {
    const b = i === index ? changedItem(before[i], change) : before[i];
    return a.kind === before[i].kind && a.name === b.name && a.content === b.content && sameValues(a.values, b.values);
  });
}

/** The change only touches what the item's form offers. */
function offered(m: SetInlineMessage, fields: readonly FormField[]): boolean {
  const names = new Set(fields.map((f) => f.name));
  if (m.content !== undefined && !names.has(CONTENT_FIELD)) return false;
  return Object.keys(m.attrs ?? {}).every((key) => key !== CONTENT_FIELD && names.has(key));
}

function inlineView(index: number, rendered: RenderedInline, item: InlineItem | undefined, agree: boolean): InlineView {
  const text = item?.content ?? rendered.content;
  const view: InlineView = {
    index,
    name: rendered.name,
    label: INLINE_LABELS[rendered.name] ?? fieldLabel(rendered.name),
    text: text.length > MAX_INLINE_TEXT ? `${text.slice(0, MAX_INLINE_TEXT - 1)}…` : text,
  };
  const fields = agree && item ? inlineFields(item) : undefined;
  if (fields?.length) view.fields = fields;
  return view;
}

/** A list of problems as a block shows them: how many, the worst severity, and the first messages. */
function problemsOf(inside: readonly LineDiagnostic[] | undefined): BlockProblems | undefined {
  if (!inside?.length) return undefined;
  const severity = inside.reduce<DiagnosticSeverity>((worst, d) => (SEVERITY_RANK[d.severity] < SEVERITY_RANK[worst] ? d.severity : worst), 'info');
  const messages = inside.slice(0, MAX_PROBLEM_MESSAGES).map((d) => `Line ${d.line + 1}: ${d.message}`);
  return { count: inside.length, severity, messages };
}

/**
 * The innermost segment a line belongs to, as the page shows segments: a top-level segment (the front matter, a
 * block or a gap), then, inside a container, the child block that holds it. A line of a container that no child
 * block holds (its fences, a gap inside it) belongs to the container.
 */
export function innermostSegment(segments: readonly Segment[], line: number): Segment | undefined {
  const holder = segments.find((s) => s.start <= line && line < s.end);
  if (!holder?.children) return holder;
  return innermostSegment(holder.children.filter((c) => c.kind === BLOCK), line) ?? holder;
}

/** The problems of each segment, by key. */
type Problems = ReadonlyMap<string, readonly LineDiagnostic[]>;

/** Each diagnostic with the innermost segment its line is in, by that segment's key. */
export function problemOwners(segments: readonly Segment[], diagnostics: readonly LineDiagnostic[]): Map<string, LineDiagnostic[]> {
  const owners = new Map<string, LineDiagnostic[]>();
  for (const d of diagnostics) {
    const owner = innermostSegment(segments, d.line);
    if (!owner) continue;
    const list = owners.get(owner.key);
    if (list) list.push(d);
    else owners.set(owner.key, [d]);
  }
  return owners;
}

/** Every segment of a tree, depth first. */
function allSegments(segments: readonly Segment[]): Segment[] {
  return segments.flatMap((s) => [s, ...allSegments(s.children ?? [])]);
}

/** The sibling list that has a segment with exactly these lines, and its index there. */
function findSiblings(segments: readonly Segment[], range: LineRange): { siblings: readonly Segment[]; index: number } | undefined {
  const index = segments.findIndex((s) => s.start === range.start && s.end === range.end);
  if (index >= 0) return { siblings: segments, index };
  const parent = segments.find((s) => s.children && s.start <= range.start && range.end <= s.end);
  return parent ? findSiblings(parent.children!, range) : undefined;
}

/** Where a block moves to: before the block above it, or after the block below it (gaps are skipped). */
function moveTarget(siblings: readonly Segment[], index: number, direction: MoveDirection): number | undefined {
  if (direction === 'up') {
    for (let i = index - 1; i >= 0; i--) if (siblings[i].kind === BLOCK) return siblings[i].start;
    return undefined;
  }
  for (let i = index + 1; i < siblings.length; i++) if (siblings[i].kind === BLOCK) return siblings[i].end;
  return undefined;
}

/** A YAML scalar for a title: plain when that is safe, else double-quoted as JSON (which YAML reads). */
export function yamlScalar(text: string): string {
  return /^[A-Za-z0-9][\w .,()/-]*$/.test(text) && !text.endsWith(' ') ? text : JSON.stringify(text);
}

/** The line a template goes before at the end of the document: before the empty line after its last line break. */
function endLine(lines: readonly string[]): number {
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

/** Where each line of a text starts (lines split on \r?\n, as splitLines splits them). */
function lineStarts(text: string): number[] {
  const starts = [0];
  const re = /\r?\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) starts.push(m.index + m[0].length);
  return starts;
}

/** The edit a grid message asks of a table, or why it can't be made. */
function tableChange(table: TableSource, lines: readonly string[], m: TableMessage): TableEdit | TableRefusal {
  switch (m.type) {
    case 'tableCell':
      return setCell(table, lines, m.row, m.col, m.text);
    case 'tableRow':
      return m.op === 'insert' ? insertRow(table, lines, m.at) : deleteRow(table, m.at);
    case 'tableCol':
      if (m.op === 'insert') return insertColumn(table, lines, m.at);
      return m.op === 'delete' ? deleteColumn(table, lines, m.at) : setAlign(table, lines, m.at, m.align ?? 'none');
    default:
      return alignTable(table, lines);
  }
}

/** One session per Block Editor panel. */
export class BlockEditorSession {
  private readonly log: EditLog;
  /** Every segment of the last render, by key. */
  private known = new Map<string, Entry>();
  /** Blocks the page edited, where they are after its edit: kept until other pins push them out. */
  private readonly pins = new Map<string, Entry>();
  private queue: Promise<void> = Promise.resolve();
  private lastAck: string | null = null;
  private last: { version: number; keys: string[]; blocks: number } | null = null;
  private renders = 0;
  private requests = 0;
  /** The inline items each top-level block's HTML numbered in the last render, by key. */
  private inlineRendered: { version: number; items: Map<string, readonly RenderedInline[]> } = { version: -1, items: new Map() };
  /** The document version the session's last edit made. */
  private applied = 0;
  /** The quick fixes last listed for each block, and the document version they belong to. */
  private readonly fixCache = new Map<string, { version: number; range: LineRange; fixes: readonly QuickFix[] }>();
  private readonly waiting = new Map<number, () => void>();

  constructor(
    private readonly doc: DocumentPort,
    private readonly options: SessionOptions,
  ) {
    this.log = new EditLog(doc.version);
  }

  /** The document changed (any editor): remember how, so older block ranges can be brought up to date. */
  recordChange(version: number, changes: readonly TextChange[]): void {
    this.log.record(version, changes);
  }

  /** Handle a message from the page, after the ones before it (each edit sees the document the last one left). */
  handle(message: SessionMessage): Promise<void> {
    const next = this.queue.then(() => this.process(message));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Render the document as it is now and send it to the page. */
  update(): void {
    this.options.post(this.render());
  }

  /**
   * Ask the page to write its draft into the document (before a save): resolves once the page has answered and
   * its edit is applied, or after `timeout` ms.
   */
  flush(timeout = 1000): Promise<void> {
    const requestId = ++this.requests;
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve();
      };
      const timer = setTimeout(done, timeout);
      this.waiting.set(requestId, done);
      this.options.post({ type: 'flush', requestId });
    });
  }

  status(): BlockEditorStatus {
    const last = this.last ?? { version: this.doc.version, keys: [], blocks: 0 };
    return { version: last.version, blocks: last.blocks, keys: last.keys.slice(), lastAck: this.lastAck, renders: this.renders };
  }

  /** The render message for the document as it is now; also what later requests are checked against. */
  render(): RenderMessage {
    const text = this.doc.getText();
    const version = this.doc.version;
    const result = this.options.render(text);
    const lines = splitLines(text);
    const owners = problemOwners(result.segments, this.options.diagnostics?.() ?? []);
    this.known = new Map();
    for (const s of allSegments(result.segments)) {
      this.known.set(s.key, { start: s.start, end: s.end, version, text: lines.slice(s.start, s.end).join('\n') });
    }
    const html = new Map(result.blocks.map((b) => [b.key, b.html]));
    const inline = new Map(result.blocks.map((b) => [b.key, b.inline]));
    this.inlineRendered = { version, items: new Map() };
    const view = (s: Segment): BlockView => {
      const v = this.blockView(s, lines, html, owners);
      const items = this.inlineViews(s.key, lines.slice(s.start, s.end), inline.get(s.key), result.frontMatter);
      if (items) v.inline = items;
      return v;
    };
    const first = result.segments[0];
    const frontMatter = first?.kind === FRONT_MATTER ? this.frontMatterView(first, lines, owners) : null;
    const message: RenderMessage = {
      type: 'render',
      version,
      open: result.open,
      header: result.header,
      toc: result.toc,
      tail: result.tail,
      themePref: this.options.themePref?.(result.frontMatter) ?? 'auto',
      frontMatter,
      blocks: result.segments.filter((s) => s.kind !== FRONT_MATTER).map(view),
      ...this.pinned(result.segments, version),
      templates: this.options.templates.map((t) => (t.description ? { name: t.name, description: t.description } : { name: t.name })),
    };
    const keys = result.segments.filter((s) => s.kind === BLOCK).map((s) => s.key);
    this.last = { version, keys, blocks: keys.length };
    this.renders++;
    return message;
  }

  /** A top-level block's inline items, by number; each has a form when the source and the HTML agree on every one. */
  private inlineViews(key: string, lines: readonly string[], rendered: readonly RenderedInline[] | undefined, variables: Variables): InlineView[] | undefined {
    if (!rendered?.length) return undefined;
    this.inlineRendered.items.set(key, rendered);
    const items = this.scan(lines);
    const agree = inlineAgree(items, rendered, variables);
    return rendered.map((r, i) => inlineView(i, r, items[i], agree));
  }

  private scan(lines: readonly string[]): InlineItem[] {
    return this.options.scan?.(lines) ?? scanInline(lines);
  }

  private frontMatterView(s: Segment, lines: readonly string[], owners: Problems): FrontMatterView {
    const own = lines.slice(s.start, s.end);
    const fields = frontMatterFields(own);
    const view: FrontMatterView = { key: s.key, start: s.start, end: s.end, source: own.join('\n') };
    if (isFrontMatterRefusal(fields)) view.formRefused = fields.refused;
    else view.fields = fields.map((f): FormField => ({ ...f, label: FRONT_MATTER_LABELS[f.name] ?? fieldLabel(f.name) }));
    const problems = problemsOf(owners.get(s.key));
    if (problems) view.problems = problems;
    return view;
  }

  private blockView(s: Segment, lines: readonly string[], html: ReadonlyMap<string, string> | undefined, owners: Problems): BlockView {
    const source = lines.slice(s.start, s.end).join('\n');
    const isBlock = s.kind === BLOCK;
    const type = isBlock ? s.type ?? 'paragraph' : GAP;
    const view: BlockView = { key: s.key, kind: isBlock ? BLOCK : GAP, type, start: s.start, end: s.end, source };
    if (!isBlock && isBlankText(source)) view.blank = true;
    if (s.container) view.container = s.container;
    if (html && isBlock) view.html = html.get(s.key) ?? '';
    if (s.children) view.children = this.childViews(s.children, lines, owners);
    const form = s.type === CONTAINER ? containerForm(lines[s.start], s.container) : undefined;
    if (form) view.form = form;
    if (isBlock && s.type === TABLE) view.table = this.tableView(lines.slice(s.start, s.end));
    const problems = problemsOf(owners.get(s.key));
    if (problems) view.problems = problems;
    return view;
  }

  /** A container's children: its blocks and the gaps that hold more than blank lines. */
  private childViews(children: readonly Segment[], lines: readonly string[], owners: Problems): BlockView[] {
    return children
      .filter((c) => c.kind === BLOCK || !isBlankText(lines.slice(c.start, c.end).join('\n')))
      .map((c) => this.blockView(c, lines, undefined, owners));
  }

  /** Where the blocks the page edited are now: a new key when their lines are one block again, else their lines. */
  private pinned(segments: readonly Segment[], version: number): Pick<RenderMessage, 'renamed' | 'pins'> {
    const renamed: Record<string, string> = {};
    const pins: Record<string, LineRange> = {};
    const all = allSegments(segments);
    for (const [key, entry] of this.pins) {
      const range = this.log.mapRange(entry, entry.version, version);
      // A key in this render names the block the page is given now.
      if (!range || this.known.has(key)) {
        this.pins.delete(key);
        continue;
      }
      this.pins.set(key, { ...range, version, text: entry.text });
      const same = all.find((s) => s.start === range.start && s.end === range.end && s.kind !== FRONT_MATTER);
      if (same && same.key !== key) renamed[key] = same.key;
      if (!same) pins[key] = range;
    }
    return { renamed, pins };
  }

  private async process(message: SessionMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.update();
        return;
      case 'flushed':
        this.waiting.get(message.requestId)?.();
        return;
      case 'edit':
        return this.edit(message);
      case 'insert':
        return this.insert(message);
      case 'delete':
        return this.remove(message.key, message.editId);
      case 'move':
        return this.move(message.key, message.direction, message.editId);
      case 'setAttr':
      case 'setTitle':
        return this.editHeader(message);
      case 'setInline':
        return this.setInline(message);
      case 'tableCell':
      case 'tableRow':
      case 'tableCol':
      case 'tableAlign':
        return this.editTable(message);
      case 'addFrontMatter':
        return this.addFrontMatter(message.editId);
      case 'setFrontMatter':
        return this.setFrontMatter(message);
      case 'getFixes':
        return this.getFixes(message.key, message.requestId);
      case 'applyFix':
        return this.applyFix(message);
    }
  }

  /** The lines a key names in the document now, or undefined when they can't be found any more. */
  private locate(key: string): LineRange | undefined {
    const entry = newer(this.pins.get(key), this.known.get(key));
    return entry && this.log.mapRange(entry, entry.version, this.doc.version);
  }

  /** The block a key names, if it still holds the text it had when the page got it; else a conflict is sent. */
  private found(key: string, editId: string | undefined): Found | undefined {
    const result = this.lookup(key);
    if (!result.found) this.conflict(editId, key, result.current);
    return result.found;
  }

  /** The block a key names, if it still holds the text it had when the page got it; else the text on its lines now. */
  private lookup(key: string): { found?: Found; current: string | null } {
    const text = this.doc.getText();
    const lines = splitLines(text);
    const entry = newer(this.pins.get(key), this.known.get(key));
    const range = entry && this.log.mapRange(entry, entry.version, this.doc.version);
    const inside = range !== undefined && range.end > range.start && range.end <= lines.length;
    const current = inside ? lines.slice(range.start, range.end).join('\n') : undefined;
    if (!range || current === undefined || current !== entry?.text) return { current: current ?? null };
    return { found: { range, text, lines }, current };
  }

  private async edit(m: Extract<EditorMessage, { type: 'edit' }>): Promise<void> {
    const text = this.doc.getText();
    const range = m.baseVersion <= this.doc.version ? this.locate(m.key) : undefined;
    const span = range && lineSpan(text, range);
    if (!range || !span) return this.conflict(m.editId, m.key, null);
    const current = text.slice(span.from, span.to);
    if (lf(current) !== lf(m.oldText)) return this.conflict(m.editId, m.key, lf(current));
    // As a textarea reads it: \r\n and a lone \r are line breaks.
    const newText = m.newText.replaceAll(/\r\n?/g, '\n');
    const change = minimalEdit(current, newText.replaceAll('\n', this.doc.eol));
    if (change && !(await this.apply([{ from: span.from + change.from, to: span.from + change.to, insert: change.insert }]))) {
      return this.notice(m.editId, NOT_APPLIED);
    }
    this.pin(m.key, { start: range.start, end: range.start + lineBreaks(newText) + 1, version: this.version(), text: newText });
    this.ack(m.editId);
  }

  private async insert(m: Extract<EditorMessage, { type: 'insert' }>): Promise<void> {
    const template = this.options.templates.find((t) => t.name === m.template);
    if (!template) return this.notice(m.editId, `There is no template "${m.template}".`);
    let at: number;
    let text = this.doc.getText();
    let lines = splitLines(text);
    if (m.atKey) {
      const found = this.found(m.atKey, m.editId);
      if (!found) return;
      ({ text, lines } = found);
      at = found.range.end;
    } else {
      at = m.position === 'start' ? parseFrontMatter(text).bodyStartLine : endLine(lines);
    }
    const { edit, line } = insertBlock(lines, at, template.text);
    if (await this.applyLines(text, [edit], m.editId)) this.ack(m.editId, { line, edit: true, select: template.select });
  }

  private async remove(key: string, editId: string | undefined): Promise<void> {
    const found = this.found(key, editId);
    if (!found) return;
    const edit = deleteBlock(found.lines, found.range);
    this.pins.delete(key);
    if (await this.applyLines(found.text, [edit], editId)) this.ack(editId, { line: edit.start });
  }

  private async move(key: string, direction: MoveDirection, editId: string | undefined): Promise<void> {
    const found = this.found(key, editId);
    if (!found) return;
    const segments = this.options.segment?.(found.text) ?? this.options.render(found.text).segments;
    const place = findSiblings(segments, found.range);
    if (place?.siblings[place.index].kind !== BLOCK) return this.notice(editId, 'Only blocks can be moved.');
    const target = moveTarget(place.siblings, place.index, direction);
    const moved = target === undefined ? null : moveBlock(found.lines, found.range, target);
    if (!moved) return this.notice(editId, direction === 'up' ? 'The block is already at the top.' : 'The block is already at the bottom.');
    if (!(await this.applyLines(found.text, moved.edits, editId))) return;
    // The same block, on other lines: a second move before the next render still finds it.
    const size = found.range.end - found.range.start;
    this.pin(key, { start: moved.line, end: moved.line + size, version: this.version(), text: found.lines.slice(found.range.start, found.range.end).join('\n') });
    this.ack(editId, { line: moved.line });
  }

  private async editHeader(m: Extract<EditorMessage, { type: 'setAttr' | 'setTitle' }>): Promise<void> {
    const found = this.found(m.key, m.editId);
    if (!found) return;
    const line = found.lines[found.range.start];
    let next: string | null;
    if (m.type === 'setTitle') next = setContainerTitle(line, m.title);
    else next = m.value === null ? removeContainerAttr(line, m.name) : setContainerAttr(line, m.name, m.value);
    if (next === null) return this.notice(m.editId, m.type === 'setTitle' ? 'That title cannot be written here.' : `"${m.name}" cannot be set to that value.`);
    const span = lineSpan(found.text, { start: found.range.start, end: found.range.start + 1 })!;
    const change = minimalEdit(line, next);
    if (change && !(await this.apply([{ from: span.from + change.from, to: span.from + change.to, insert: change.insert }]))) {
      return this.notice(m.editId, NOT_APPLIED);
    }
    // The next change from the same form, before the next render, still finds the block.
    const text = [next, ...found.lines.slice(found.range.start + 1, found.range.end)].join('\n');
    this.pin(m.key, { ...found.range, version: this.version(), text });
    this.ack(m.editId, { line: found.range.start });
  }

  /**
   * Change one inline item of a block, if the block still holds the text the page was given, its source and its
   * HTML agree on every item (so number `index` is the same item in both), the item is the one the page named and
   * the change is one its form offers. Only that item's own text changes, on its one line; afterwards the block
   * must hold the same items with only that one changed as asked. Anything else: the page is told to edit the
   * block's source instead.
   */
  private async setInline(m: SetInlineMessage): Promise<void> {
    const found = this.found(m.key, m.editId);
    if (!found) return;
    const { range } = found;
    const lines = found.lines.slice(range.start, range.end);
    const items = this.scan(lines);
    const item = this.inlineItem(m, found, items);
    if (!item) return this.fallback(m, 'This item can\'t be edited here: edit the block\'s source instead.');
    if (!offered(m, inlineFields(item) ?? [])) return this.notice(m.editId, `The form of this ${(INLINE_LABELS[item.name] ?? item.name).toLowerCase()} has no such field.`);
    const change: InlineChange = { ...(m.content === undefined ? {} : { content: m.content }), ...(m.attrs ? { attrs: m.attrs } : {}) };
    const at = item.at!.line;
    const next = editInline(lines[at], item, change) ?? lines[at];
    const after = [...lines.slice(0, at), next, ...lines.slice(at + 1)];
    if (!changedAsAsked(items, this.scan(after), m.index, change)) {
      return this.fallback(m, 'That value can\'t be written here: edit the block\'s source instead.');
    }
    const span = lineSpan(found.text, { start: range.start + at, end: range.start + at + 1 })!;
    const edit = minimalEdit(lines[at], next);
    if (edit && !(await this.apply([{ from: span.from + edit.from, to: span.from + edit.to, insert: edit.insert }]))) {
      return this.notice(m.editId, NOT_APPLIED);
    }
    // The next change from the same form, before the next render, still finds the block.
    this.pin(m.key, { ...range, version: this.version(), text: after.join('\n') });
    this.ack(m.editId, { line: range.start, inline: m.index });
  }

  /** The item a setInline names, when the block's source and HTML agree on every item and it has a form; else undefined. */
  private inlineItem(m: SetInlineMessage, found: Found, items: readonly InlineItem[]): InlineItem | undefined {
    const item = items[m.index];
    if (item?.name !== m.name || !inlineFields(item)) return undefined;
    const rendered = this.renderedInline(m.key, found);
    return rendered && inlineAgree(items, rendered, parseFrontMatter(found.text).data) ? item : undefined;
  }

  /** What the HTML numbers in a block now: from the last render when the document is as it was then, else rendered again. */
  private renderedInline(key: string, found: Found): readonly RenderedInline[] | undefined {
    const known = this.known.get(key);
    const unchanged = this.inlineRendered.version === this.doc.version && known?.start === found.range.start && known.end === found.range.end;
    if (unchanged) return this.inlineRendered.items.get(key);
    const block = this.options.render(found.text).blocks.find((b) => b.start === found.range.start && b.end === found.range.end);
    return block?.inline;
  }

  /** Refuse an inline or table change, and have the page open the block's source instead. */
  private fallback(m: { key: string; editId?: string }, text: string): void {
    this.options.post(m.editId === undefined ? { type: 'notice', text, fallback: m.key } : { type: 'notice', editId: m.editId, text, fallback: m.key });
  }

  private readTable(lines: readonly string[]): TableSource | TableRefusal {
    return this.options.table?.(lines) ?? readTable(lines);
  }

  /** A table block for the grid: its cells as written, or why its source is the only way to change it. */
  private tableView(lines: readonly string[]): TableView {
    const table = this.readTable(lines);
    return isRefusal(table) ? { refused: table.refused } : { rows: cellTexts(table, lines), aligns: [...table.aligns] };
  }

  /**
   * Change a table block from the grid, if the block still holds the text the page was given and its source reads
   * as a table the renderer agrees with. Only the cell changes (a row: its one line; a column: on each line, the
   * cell and its pipe; Align table: what `smd fmt` would change). Afterwards the block must read as a table that
   * holds exactly what was asked for, else nothing is written and the page is told to edit the table's source.
   */
  private async editTable(m: TableMessage): Promise<void> {
    const found = this.found(m.key, m.editId);
    if (!found) return;
    const { range } = found;
    const lines = found.lines.slice(range.start, range.end);
    const table = this.readTable(lines);
    if (isRefusal(table)) return this.fallback(m, `${table.refused} ${TABLE_SOURCE}`);
    const change = tableChange(table, lines, m);
    if (isRefusal(change)) return this.notice(m.editId, change.refused);
    const after = applyLineEdits(lines, change.edits);
    const check = this.readTable(after);
    const aligning = m.type === 'tableAlign';
    if (isRefusal(check) || !sameShape(tableShape(check), change.expect, aligning)) {
      if (aligning) return this.notice(m.editId, 'The table can\'t be aligned without changing what its cells hold.');
      return this.fallback(m, `That change can't be written in this table. ${TABLE_SOURCE}`);
    }
    const edits = this.blockTextEdits(found, change.edits);
    if (edits.length && !(await this.apply(edits))) return this.notice(m.editId, NOT_APPLIED);
    if (aligning && !edits.length) this.notice(m.editId, 'The table is already aligned.');
    // The next change from the grid, before the next render, still finds the block.
    this.pin(m.key, { start: range.start, end: range.start + after.length, version: this.version(), text: after.join('\n') });
    this.ack(m.editId, { line: range.start, cell: change.focus });
  }

  /** A table's line edits (against its own lines) as text edits: a line replaced by another, by its smallest splice. */
  private blockTextEdits(found: Found, edits: readonly LineEdit[]): TextEdit[] {
    const base = found.range.start;
    const starts = lineStarts(found.text);
    return edits.flatMap((e): TextEdit[] => {
      const line = base + e.start;
      if (e.end - e.start !== 1 || e.lines.length !== 1) return [lineEditToTextEdit(found.text, { start: line, end: base + e.end, lines: e.lines }, this.doc.eol)];
      const change = minimalEdit(found.lines[line], e.lines[0]);
      return change ? [{ from: starts[line] + change.from, to: starts[line] + change.to, insert: change.insert }] : [];
    });
  }

  /**
   * Set one known key of the front matter from its form, if the block still holds the text the page was given and
   * is the front matter. Only that key's value changes (its line, or its list item lines); a new key goes before the
   * closing `---`. YAML the form can't edit safely, or a value that wouldn't read back as asked, is refused, and the
   * page opens the front matter's text instead.
   */
  private async setFrontMatter(m: SetFrontMatterMessage): Promise<void> {
    const found = this.found(m.key, m.editId);
    if (!found) return;
    const { range } = found;
    if (range.start !== 0 || parseFrontMatter(found.text).bodyStartLine !== range.end) return this.notice(m.editId, 'That block is not the front matter.');
    const lines = found.lines.slice(range.start, range.end);
    const value = Array.isArray(m.value) && !m.value.length ? null : m.value;
    const edits = setFrontMatterValue(lines, m.name, value);
    if (isFrontMatterRefusal(edits)) return this.fallback(m, edits.refused);
    const after = applyLineEdits(lines, edits);
    const textEdits = this.blockTextEdits(found, edits);
    if (textEdits.length && !(await this.apply(textEdits))) return this.notice(m.editId, NOT_APPLIED);
    // The next change from the same form, before the next render, still finds the block. Focus stays in the form.
    this.pin(m.key, { start: range.start, end: range.start + after.length, version: this.version(), text: after.join('\n') });
    this.ack(m.editId);
  }

  /**
   * List the quick fixes for a block's problems: VS Code's code actions of kind quickfix that carry an edit (the
   * provider filters them), less those that fix a problem of a block inside it. They are kept, by block and document
   * version, for applyFix; the page only gets their titles and what they change.
   */
  private async getFixes(key: string, requestId: number): Promise<void> {
    const version = this.doc.version;
    const reply = (fixes: FixView[], error?: string) =>
      this.options.post(error === undefined ? { type: 'fixes', requestId, key, version, fixes } : { type: 'fixes', requestId, key, version, fixes, error });
    const { found } = this.lookup(key);
    if (!found) return reply([], NOT_FOUND);
    if (!this.options.quickFixes) return reply([], NO_FIXES);
    const all = await this.options.quickFixes(found.range);
    // The fixes' ranges are only good for the document they were made for.
    if (this.doc.version !== version) return reply([], FIXES_STALE);
    const fixes = this.ownFixes(all, found).slice(0, MAX_FIXES);
    this.fixCache.delete(key);
    this.fixCache.set(key, { version, range: found.range, fixes });
    if (this.fixCache.size > MAX_FIX_CACHE) this.fixCache.delete(this.fixCache.keys().next().value!);
    reply(fixes.map((f) => ({ title: f.title.slice(0, MAX_VALUE), scope: fixScope(f, found.range) })));
  }

  /** The fixes for the block's own problems: not those of a block inside it, which that block lists. */
  private ownFixes(fixes: readonly QuickFix[], found: Found): QuickFix[] {
    const segments = this.options.segment?.(found.text) ?? this.options.render(found.text).segments;
    const owned = (line: number) => {
      const owner = innermostSegment(segments, line);
      return owner?.start === found.range.start && owner.end === found.range.end;
    };
    return fixes.filter((f) => f.diagnostics.every(owned));
  }

  /**
   * Apply a listed quick fix, as its provider made it, if the document is still the version it was listed for and
   * the block still holds its text. A fix that writes outside the block's lines, or to other files, is applied only
   * once the page confirms it.
   */
  private async applyFix(m: ApplyFixMessage): Promise<void> {
    const cached = this.fixCache.get(m.key);
    const fix = cached?.fixes[m.index];
    if (!cached || !fix || cached.version !== m.version || this.doc.version !== m.version) return this.notice(m.editId, FIXES_STALE);
    const found = this.found(m.key, m.editId);
    if (!found) return;
    const scope = fixScope(fix, found.range);
    if (scope !== 'block' && !m.confirm) {
      const text = scope === 'files' ? 'This fix also changes other files.' : 'This fix also changes lines outside this block.';
      const confirm = { type: 'confirmFix' as const, key: m.key, index: m.index, version: m.version, text };
      this.options.post(m.editId === undefined ? confirm : { ...confirm, editId: m.editId });
      return;
    }
    this.fixCache.delete(m.key);
    if (!(await this.applyWith(() => fix.apply()))) return this.notice(m.editId, NOT_APPLIED);
    this.ack(m.editId, { line: found.range.start });
  }

  private async addFrontMatter(editId: string | undefined): Promise<void> {
    const text = this.doc.getText();
    if (parseFrontMatter(text).present) return this.notice(editId, 'The document already has front matter.');
    const block = ['---', `title: ${yamlScalar(this.options.title || 'Untitled')}`, '---'].join('\n');
    const { edit } = insertBlock(splitLines(text), 0, block);
    if (await this.applyLines(text, [edit], editId)) this.ack(editId, { line: 0, edit: true, select: { from: 11, to: block.length - 4 } });
  }

  /** Apply line edits (against `text`) in the document's line ending; false (and a notice) when that fails. */
  private async applyLines(text: string, edits: readonly LineEdit[], editId: string | undefined): Promise<boolean> {
    const ok = await this.apply(edits.map((e) => lineEditToTextEdit(text, e, this.doc.eol)));
    if (!ok) this.notice(editId, NOT_APPLIED);
    return ok;
  }

  private apply(edits: readonly TextEdit[]): Promise<boolean> {
    return this.applyWith(() => this.doc.applyEdits(edits));
  }

  /** Make a change to the document (our edits, or a quick fix's), and remember the version it made. */
  private async applyWith(write: () => PromiseLike<boolean> | boolean): Promise<boolean> {
    const before = this.doc.version;
    const ok = (await write()) !== false;
    // The version our edit made, also if the document reports the change only after the edit resolves.
    this.applied = ok ? Math.max(this.doc.version, before + 1) : this.doc.version;
    return ok;
  }

  /** The document version as of the last thing this session did. */
  private version(): number {
    return Math.max(this.doc.version, this.applied);
  }

  private pin(key: string, entry: Entry): void {
    this.pins.delete(key);
    this.pins.set(key, entry);
    if (this.pins.size > MAX_PINS) this.pins.delete(this.pins.keys().next().value!);
  }

  private ack(editId: string | undefined, focus?: FocusRequest): void {
    if (editId === undefined) return;
    this.lastAck = editId;
    this.options.post(focus ? { type: 'ack', editId, version: this.version(), focus } : { type: 'ack', editId, version: this.version() });
  }

  private conflict(editId: string | undefined, key: string, currentText: string | null): void {
    if (editId === undefined) {
      this.options.post({ type: 'notice', text: NOT_FOUND });
      return;
    }
    this.options.post({ type: 'conflict', editId, key, currentText });
  }

  private notice(editId: string | undefined, text: string): void {
    this.options.post(editId === undefined ? { type: 'notice', text } : { type: 'notice', editId, text });
  }
}
