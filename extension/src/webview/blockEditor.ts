// The Block Editor page (Styled Markdown Block Editor (Preview)). It shows the blocks the extension rendered, lets
// the user edit one block's source at a time, and sends requests by block key; the extension decides what changes
// in the document (see blockEditorSession.ts). Runs after media/runtime.js, whose window.smdRuntime gives the page's
// one VS Code handle, hydrate(scope), announce() and saved state.
//
// The document's rendered HTML goes into the page as in the preview. The editor's own controls (toolbar, menus,
// forms, the source editor, notices, problem badges) live in closed shadow roots and are built with createElement
// and textContent only.
import type {
  BlockProblems, BlockView, FixesMessage, FixView, FocusRequest, FormField, FrontMatterView, HostMessage, InlineView, RenderMessage, TableView,
} from '../blockEditorSession';
import {
  FROZEN, blockLabel, cellLabel, cellSource, clampCell, desiredOrder, editLabel, findView, followEdit, formRequest, gridActionEnabled,
  gridAnnouncement, gridKeyTarget, gridLabel, gridRequest, inlineAnnouncement, inlineItemLabel, inlineRequest, isUndoRedo, itemAnnouncement,
  itemForLine, listKeyTarget, mergeProblems, fixLabel, fixesAnnouncement, orderMoves, problemsLabel, refreshedValue, shiftLine, textareaRows, toolbarKeyTarget, topRange, typeAhead, withoutLines,
  type GridAction, type GridCell, type GridRequest, type GridSize, type LineRange,
} from './blockEditorModel';

interface Runtime {
  mode: string;
  vscode: { postMessage(message: unknown): void } | null;
  hydrate(scope?: Element): Promise<void>;
  announce(text: string): void;
  appState(): unknown;
  saveAppState(value: unknown): void;
}

/** What the page keeps across being hidden (VS Code reloads it when it is shown again). */
interface SavedState {
  current?: string | null;
  line?: number;
  editing?: { key: string; start: number; end: number; original: string; committed: string; draft: string; from: number; to: number } | null;
}

/** The block being edited: its source in a textarea, what the extension has of it, and the edits on their way. */
interface Editing {
  key: string;
  /** The element whose rendering the editor replaces: a top-level block, the front matter or a child. */
  item: HTMLElement;
  /** The top-level block (or the front matter) it is in, which keeps its place until editing ends. */
  top: HTMLElement;
  host: HTMLElement;
  root: ShadowRoot;
  textarea: HTMLTextAreaElement;
  notice: HTMLElement;
  range: LineRange;
  /** The source when editing began (Escape goes back to it). */
  original: string;
  /** The source the extension has, as far as the page knows. */
  committed: string;
  /** Edits sent and not answered yet. */
  pending: Set<string>;
  /** The document version of the last answered edit. */
  acked: number;
  conflict: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** A table block edited cell by cell: the grid that stands in for its rendering, and what the extension has of it. */
interface Grid {
  key: string;
  /** The table's element, hidden behind the grid, and the top-level block it is in (which keeps its place). */
  item: HTMLElement;
  top: HTMLElement;
  host: HTMLElement;
  root: ShadowRoot;
  range: LineRange;
  /** Every cell's text as the extension has it, as far as the page knows. */
  rows: string[][];
  aligns: string[];
  table: HTMLTableElement;
  inputs: HTMLInputElement[][];
  tools: Record<GridAction, HTMLButtonElement>;
  align: HTMLSelectElement;
  /** The cell focus was last in, and its text when focus came to it (Escape goes back to that). */
  cell: GridCell;
  entry: string;
  /** A row or column change on its way: the grid waits, read-only, for the render that has it. */
  busy: { editId: string; version?: number } | null;
  /** Something was written from the grid (the table is rendered again when the grid closes). */
  changed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** An item's controls: the shadow host and the problem badge. */
interface Chrome {
  host: HTMLElement;
  badge: HTMLButtonElement;
}

type ItemView = Pick<BlockView, 'key' | 'type' | 'container' | 'start' | 'end' | 'source' | 'problems' | 'form' | 'children' | 'inline' | 'table'>;
type Action = 'insert' | 'edit' | 'grid' | 'props' | 'problems' | 'up' | 'down' | 'del' | 'reveal' | 'fm';

const AUTOSAVE_DELAY = 800;
const DIV = 'div';
const KEYDOWN = 'keydown';
const ARROW_UP = 'ArrowUp';
const ARROW_DOWN = 'ArrowDown';
const ESCAPE = 'Escape';
const TRUE = 'true';
const FALSE = 'false';
const NOTICE_TIME = 8000;
const ITEM = 'smd-ed-item';
const CHILD = 'smd-ed-child';
const HIDDEN = 'smd-ed-hidden';
const CONTENT = 'smd-ed-content';
const RAW = 'smd-ed-raw';
const EDITOR = 'smd-ed-editor';
const GRID_HOST = 'smd-ed-grid-host';
const CHROME = 'smd-ed-chrome';
const CHROME_CHILD = 'smd-ed-chrome-child';
/** Child elements that can't hold the editor's controls (they go right before them). */
const OUTSIDE_CHROME = new Set(['TABLE', 'DETAILS', 'HR', 'IMG', 'PRE']);
const ARIA_EXPANDED = 'aria-expanded';
const ARIA_DISABLED = 'aria-disabled';
const ARIA_LABEL = 'aria-label';
const TABINDEX = 'tabindex';
const INTERACTIVE = 'a[href], button, input, select, textarea, summary, label, [role="tab"], audio, video, iframe, [contenteditable], .smd-ed-editor, .smd-ed-grid-host';
/** The alignments a grid column can have, as the alignment list shows them. */
const ALIGN_CHOICES: readonly (readonly [string, string])[] = [['none', 'Default'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']];
/** An inline directive or styled span the extension numbered (renderBlocks' inlineIndex). */
const INLINE = '[data-smd-inline]';
/** The input type of a form field that is not a select. */
const INPUT_TYPES: Readonly<Partial<Record<FormField['kind'], string>>> = { flag: 'checkbox', date: 'date' };

const runtime = (globalThis as { smdRuntime?: Runtime }).smdRuntime;
if (typeof document !== 'undefined' && runtime?.mode === 'block-editor') start(runtime);

function start(rt: Runtime): void {
  const post = (message: unknown) => rt.vscode?.postMessage(message);
  const rootEl = document.getElementById('smd-root')!;
  const toolbarHost = document.getElementById('smd-ed-toolbar')!;

  // ---- Building elements ------------------------------------------------------
  type Options = { className?: string; text?: string; attrs?: Record<string, string> };
  function h<K extends keyof HTMLElementTagNameMap>(tag: K, options: Options = {}, children: (Node | null)[] = []): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
    for (const child of children) if (child) node.append(child);
    return node;
  }

  /** A closed shadow root with the editor's stylesheet. */
  function chromeRoot(host: HTMLElement): ShadowRoot {
    const root = host.attachShadow({ mode: 'closed' });
    const css = document.body.dataset.smdEdCss;
    if (css) root.append(h('link', { attrs: { rel: 'stylesheet', href: css } }));
    return root;
  }

  function button(text: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
    const b = h('button', { text, attrs: { type: 'button', ...attrs } });
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- State --------------------------------------------------------------------
  let model: RenderMessage | null = null;
  let openTag = '';
  /** Top-level block elements by key (the block being edited is not here: its key may be out of date). */
  let nodes = new Map<string, HTMLElement>();
  const viewOf = new WeakMap<HTMLElement, ItemView>();
  /** What a top-level element shows: its HTML without line numbers, or its raw source. */
  const signature = new WeakMap<HTMLElement, string>();
  const nodeIds = new WeakMap<HTMLElement, string>();
  const shown = new WeakMap<HTMLElement, string>();
  const chromes = new WeakMap<HTMLElement, Chrome>();
  /** The problems an item's badge shows: its own, and those of children not found in its HTML. */
  const shownProblems = new WeakMap<HTMLElement, BlockProblems | undefined>();
  let fmNode: HTMLElement | null = null;
  let currentKey: string | null = null;
  let currentLine = 0;
  let editing: Editing | null = null;
  let grid: Grid | null = null;
  /** Row and column changes sent from the grid and not answered yet, and cell edits, by editId. */
  const gridOps = new Map<string, GridRequest>();
  const cellEdits = new Map<string, { cell: GridCell; previous: string }>();
  /** The block being edited, in its source or in the grid: it keeps its place and its rendering until that ends. */
  const held = (): Pick<Grid, 'key' | 'item' | 'top' | 'range'> | null => editing ?? grid;
  let pendingFocus: { version: number; focus: FocusRequest } | null = null;
  /** Drafts of edits sent as editing ended, in case one of them comes back as a conflict. */
  const closedDrafts = new Map<string, { key: string; range: LineRange; draft: string; original: string }>();
  let acked = 0;
  let sequence = 0;
  let restored = false;
  const nextId = () => `e${Date.now().toString(36)}${(++sequence).toString(36)}`;
  const nodeId = (node: HTMLElement) => {
    let id = nodeIds.get(node);
    if (!id) {
      id = `n${++sequence}`;
      nodeIds.set(node, id);
    }
    return id;
  };

  // ---- The document's frame -----------------------------------------------------
  const head = h(DIV, { className: 'smd-ed-head' });
  const headerHolder = h(DIV, { className: 'smd-ed-header' });
  const tocHolder = h(DIV, { className: 'smd-ed-toc' });
  const blocksEl = h(DIV, { className: 'smd-ed-blocks' });
  const tailHolder = h(DIV, { className: 'smd-ed-tail' });
  head.append(headerHolder, tocHolder);

  /** Set rendered document HTML (trusted, from the extension's renderer, as in the preview) when it changed. */
  function setHtml(holder: HTMLElement, html: string): void {
    if (shown.get(holder) === html) return;
    shown.set(holder, html);
    holder.innerHTML = html;
  }

  function ensureArticle(open: string): void {
    if (open === openTag) return;
    openTag = open;
    const template = document.createElement('template');
    template.innerHTML = `${open}</article>`;
    const article = (template.content.firstElementChild as HTMLElement | null) ?? h('article', { className: 'smd-doc' });
    article.append(head, blocksEl, tailHolder);
    rootEl.replaceChildren(article);
  }

  // ---- Items: blocks, children, the front matter and gaps with content ------------
  const itemsAll = () => Array.from(rootEl.querySelectorAll<HTMLElement>(`.${ITEM}`));
  const visible = (el: HTMLElement) => el.getClientRects().length > 0;
  const items = () => itemsAll().filter(visible);
  const startOf = (el: HTMLElement) => Number(el.dataset.smdEdStart ?? 0);

  function markItem(el: HTMLElement, view: ItemView): void {
    el.classList.add(ITEM);
    el.dataset.smdEdKey = view.key;
    el.dataset.smdEdStart = String(view.start);
    el.dataset.smdEdEnd = String(view.end);
    if (el.dataset.smdEdKey !== currentKey) el.setAttribute(TABINDEX, '-1');
    viewOf.set(el, view);
  }

  /**
   * The editor's controls on an item (in a shadow root): its problem badge, which opens the list of problems and
   * quick fixes. A top-level block holds them; a child gets them as its first element (or right before it, where
   * an element can't hold them), so they show and hide with it, as a tab or a closed details hides its content.
   */
  function chromeFor(el: HTMLElement, child: boolean): Chrome {
    const known = chromes.get(el);
    if (known?.host.isConnected) return known;
    const host = h(DIV, { className: child ? `${CHROME} ${CHROME_CHILD}` : CHROME });
    const badge = h('button', { className: 'badge', attrs: { type: 'button', [TABINDEX]: '-1', 'aria-hidden': TRUE } });
    badge.addEventListener('click', (event) => {
      event.stopPropagation();
      setCurrent(el, false);
      openProblems(el);
    });
    chromeRoot(host).append(h(DIV, { className: child ? 'chrome child' : 'chrome' }, [badge]));
    const chrome: Chrome = { host, badge };
    chromes.set(el, chrome);
    if (!child) el.prepend(host);
    else if (OUTSIDE_CHROME.has(el.tagName) || el.parentElement?.classList.contains('smd-table-wrap')) el.before(host);
    else el.prepend(host);
    return chrome;
  }

  /** Show an item's problem count (the messages are in the badge's tooltip, the item's label and the problems list). */
  function updateChrome(el: HTMLElement, problems: BlockProblems | undefined, child: boolean): void {
    shownProblems.set(el, problems);
    const chrome = problems || chromes.has(el) ? chromeFor(el, child) : undefined;
    if (!chrome) return;
    chrome.badge.hidden = !problems;
    if (!problems) return;
    chrome.badge.textContent = `⚠ ${problems.count}`;
    chrome.badge.className = `badge ${problems.severity}`;
    chrome.badge.title = `${problems.messages.join('\n')}\n\nClick, or press Ctrl+. on the block, for quick fixes.`;
  }

  function decorateTop(node: HTMLElement, view: ItemView, lost?: BlockProblems): void {
    markItem(node, view);
    node.setAttribute('role', 'group');
    node.setAttribute('aria-roledescription', 'block');
    const shown = mergeProblems(view.problems, lost);
    const problems = problemsLabel(shown);
    node.setAttribute(ARIA_LABEL, problems ? `${blockLabel(view)}, ${problems}` : blockLabel(view));
    if (shown) node.setAttribute('aria-description', shown.messages.join('; '));
    else node.removeAttribute('aria-description');
    updateChrome(node, shown, false);
  }

  /**
   * Mark a container's children (found in its HTML by their first line) as items of their own, each with its problem
   * badge. Returns the problems of children that are not in the HTML, which their container shows instead.
   */
  function annotateChildren(scope: HTMLElement, children: readonly BlockView[] | undefined): BlockProblems | undefined {
    let lost: BlockProblems | undefined;
    for (const child of children ?? []) {
      if (child.kind !== 'block') continue;
      const el = scope.querySelector<HTMLElement>(`[data-line="${child.start}"]`);
      if (el && !el.classList.contains(ITEM)) {
        markItem(el, child);
        el.classList.add(CHILD);
        updateChrome(el, mergeProblems(child.problems, annotateChildren(el, child.children)), true);
      } else {
        lost = mergeProblems(lost, child.problems, annotateChildren(el ?? scope, child.children));
      }
    }
    return lost;
  }

  function clearChildren(node: HTMLElement): void {
    node.querySelectorAll<HTMLElement>(`.${CHROME_CHILD}`).forEach((host) => host.remove());
    node.querySelectorAll<HTMLElement>(`.${CHILD}`).forEach((el) => {
      el.classList.remove(ITEM, CHILD);
      delete el.dataset.smdEdKey;
      chromes.delete(el);
      shownProblems.delete(el);
    });
  }

  /** Move the source line numbers inside an element that kept its rendering but moved in the document. */
  function shiftLines(node: HTMLElement, delta: number): void {
    if (!delta) return;
    node.querySelectorAll<HTMLElement>('[data-line], [data-task-line]').forEach((el) => {
      for (const name of ['data-line', 'data-task-line']) {
        const value = el.getAttribute(name);
        if (value !== null) el.setAttribute(name, shiftLine(value, delta));
      }
    });
  }

  const fresh = new Set<HTMLElement>();

  function createTop(view: BlockView): HTMLElement {
    const node = h(DIV, { className: 'smd-ed-block' });
    const content = h(DIV, { className: CONTENT });
    if (view.kind === 'gap') {
      node.classList.add('smd-ed-chip');
      content.append(h('pre', { className: RAW, text: view.source }));
    } else {
      content.innerHTML = view.html ?? '';
    }
    node.append(content);
    decorateTop(node, view, annotateChildren(content, view.children));
    fresh.add(node);
    return node;
  }

  const signatureOf = (view: BlockView) => (view.kind === 'gap' ? `raw:${view.source}` : withoutLines(view.html ?? ''));

  function blankGap(view: BlockView, old: HTMLElement | undefined): HTMLElement {
    const node = old?.classList.contains('smd-ed-gap') ? old : h(DIV, { className: 'smd-ed-gap', attrs: { 'aria-hidden': TRUE } });
    node.dataset.smdEdGap = view.key;
    node.dataset.smdEdStart = String(view.start);
    return node;
  }

  /** The element for a top-level block: the one shown now when it looks the same, else a new one. */
  function nodeFor(view: BlockView): HTMLElement {
    const known = nodes.get(view.key);
    const old = known === held()?.top ? undefined : known;
    if (view.blank) return blankGap(view, old);
    const sig = signatureOf(view);
    if (old && signature.get(old) === sig && old.classList.contains(ITEM)) {
      const content = old.querySelector<HTMLElement>(`:scope > .${CONTENT}`) ?? old;
      shiftLines(content, view.start - startOf(old));
      clearChildren(content);
      decorateTop(old, view, annotateChildren(content, view.children));
      return old;
    }
    const node = createTop(view);
    signature.set(node, sig);
    return node;
  }

  /** The block being edited keeps its place and its rendering; only its line numbers follow the document. */
  function keepFrozen(node: HTMLElement, range: LineRange, next: Map<string, HTMLElement>): HTMLElement {
    const content = node.querySelector<HTMLElement>(`:scope > .${CONTENT}`) ?? node;
    shiftLines(content, range.start - startOf(node));
    node.dataset.smdEdStart = String(range.start);
    node.dataset.smdEdEnd = String(range.end);
    if (node.dataset.smdEdKey) next.set(node.dataset.smdEdKey, node);
    return node;
  }

  function reconcile(msg: RenderMessage): void {
    const hold = held();
    const frozenNode = hold && hold.top !== fmNode ? hold.top : null;
    const frozen = frozenNode && hold ? topRange(msg.blocks, hold.range) : null;
    const byKey = new Map(msg.blocks.map((b) => [b.key, b]));
    const order = desiredOrder(msg.blocks, frozen);
    const next = new Map<string, HTMLElement>();
    const desired = order.map((key) => {
      if (key === FROZEN) return keepFrozen(frozenNode!, frozen!, next);
      const node = nodeFor(byKey.get(key)!);
      next.set(key, node);
      return node;
    });
    placeBlocks(desired);
    nodes = next;
    fresh.forEach((node) => {
      if (node.isConnected) void rt.hydrate(node);
    });
    fresh.clear();
  }

  /** Put the top-level elements in order, moving as few as possible (focus and state stay where they are). */
  function placeBlocks(desired: readonly HTMLElement[]): void {
    const keep = new Set(desired);
    (Array.from(blocksEl.children) as HTMLElement[]).filter((child) => !keep.has(child)).forEach((child) => child.remove());
    const current = (Array.from(blocksEl.children) as HTMLElement[]).map(nodeId);
    const byId = new Map(desired.map((n) => [nodeId(n), n]));
    for (const move of orderMoves(current, desired.map(nodeId))) {
      const before = move.before === null ? null : byId.get(move.before) ?? null;
      blocksEl.insertBefore(byId.get(move.id)!, before);
    }
  }

  function renderFrontMatter(fm: FrontMatterView | null): void {
    if (editing && editing.top === fmNode) return;
    if (!fm) {
      fmNode?.remove();
      fmNode = null;
      return;
    }
    const view: ItemView = { key: fm.key, type: 'frontmatter', start: fm.start, end: fm.end, source: fm.source, problems: fm.problems };
    if (fmNode && signature.get(fmNode) === fm.source) {
      decorateTop(fmNode, view);
      return;
    }
    const node = h(DIV, { className: 'smd-ed-block smd-ed-fm' }, [h(DIV, { className: CONTENT }, [h('pre', { className: RAW, text: fm.source })])]);
    decorateTop(node, view);
    signature.set(node, fm.source);
    if (fmNode) fmNode.replaceWith(node);
    else headerHolder.after(node);
    fmNode = node;
  }

  // ---- Focus: one item is in the tab order, the arrow keys move between them -------
  function setCurrent(el: HTMLElement, focus: boolean): void {
    rootEl.querySelectorAll<HTMLElement>(`.${ITEM}[tabindex="0"]`).forEach((other) => {
      if (other !== el) other.setAttribute(TABINDEX, '-1');
    });
    el.setAttribute(TABINDEX, '0');
    currentKey = el.dataset.smdEdKey ?? null;
    currentLine = startOf(el);
    if (focus) el.focus();
    updateToolbar();
    saveState();
  }

  /** After a render: the current item is the one with the current key, else the one on the current line. */
  function ensureCurrent(focus: boolean): void {
    const hold = held();
    if (hold) {
      // The block being edited stays current (its own element is hidden behind the editor or the grid).
      currentKey = hold.key;
      currentLine = hold.range.start;
      updateToolbar();
      return;
    }
    const list = items();
    if (!list.length) {
      currentKey = null;
      updateToolbar();
      return;
    }
    const item = list.find((i) => i.dataset.smdEdKey === currentKey) ?? list[itemForLine(list.map(startOf), currentLine)];
    setCurrent(item, focus);
  }

  const currentItem = (): HTMLElement | undefined => held()?.item ?? itemsAll().find((i) => i.dataset.smdEdKey === currentKey);
  /** The current block; while one is edited, that one, with its key and lines as they are now. */
  const currentView = (): ItemView | undefined => {
    const hold = held();
    if (hold) {
      const view = viewOf.get(hold.item);
      return view && { ...view, key: hold.key, start: hold.range.start, end: hold.range.end };
    }
    const item = currentItem();
    return item && viewOf.get(item);
  };

  function applyPendingFocus(): void {
    if (!pendingFocus || !model || model.version < pendingFocus.version) return;
    const { focus } = pendingFocus;
    pendingFocus = null;
    const list = itemsAll();
    if (!list.length) return;
    if (focus.cell) {
      focusGridCell(focus.line, focus.cell);
      return;
    }
    const item = list[itemForLine(list.map(startOf), focus.line)];
    setCurrent(item, true);
    if (focus.edit) startEdit(item, { select: focus.select });
    // After an inline form: focus goes back to the item it changed.
    if (focus.inline !== undefined) item.querySelector<HTMLElement>(`[data-smd-inline="${focus.inline}"]`)?.focus();
  }

  // ---- Editing a block's source ----------------------------------------------------
  function editorFor(view: ItemView): { host: HTMLElement; root: ShadowRoot; textarea: HTMLTextAreaElement; notice: HTMLElement } {
    const host = h(DIV, { className: EDITOR });
    const root = chromeRoot(host);
    const label = h('label', { className: 'label', text: editLabel(view), attrs: { for: 'source' } });
    const textarea = h('textarea', { className: 'source', attrs: { id: 'source', spellcheck: FALSE, autocapitalize: 'off', autocomplete: 'off', 'aria-describedby': 'hint' } });
    const hint = h('p', { className: 'hint', text: 'Ctrl+Enter: done. Escape: cancel. Your text is written to the document as you pause.', attrs: { id: 'hint' } });
    const notice = h(DIV, { className: 'notice', attrs: { role: 'alert' } });
    notice.hidden = true;
    root.append(h(DIV, { className: 'editor' }, [label, textarea, hint, notice]));
    return { host, root, textarea, notice };
  }

  interface StartOptions {
    select?: { from: number; to: number };
    restore?: NonNullable<SavedState['editing']>;
  }

  /** The element to edit once any other edit has ended (which may render its block, and this one, again). */
  function editTarget(target: HTMLElement): HTMLElement | undefined {
    if (!editing && !grid) return target;
    const key = target.dataset.smdEdKey;
    finishEdit(false);
    closeGrid(false);
    return target.isConnected ? target : itemsAll().find((i) => i.dataset.smdEdKey === key);
  }

  function startEdit(target: HTMLElement, options: StartOptions = {}): void {
    if (editing?.item === target) return;
    const item = editTarget(target);
    const view = item && viewOf.get(item);
    if (item && view) openEditor(item, view, options);
  }

  function openEditor(item: HTMLElement, view: ItemView, options: StartOptions): void {
    const top = (item.closest('.smd-ed-block') as HTMLElement | null) ?? item;
    const saved = options.restore;
    const e: Editing = {
      key: view.key, item, top, ...editorFor(view), range: { start: view.start, end: view.end },
      original: saved?.original ?? view.source, committed: saved?.committed ?? view.source, pending: new Set(), acked: 0, conflict: false,
    };
    // The editor takes the place of the block's rendering, which stays in the page, hidden.
    if (item === top) {
      item.querySelector<HTMLElement>(`:scope > .${CONTENT}`)?.setAttribute('hidden', '');
      item.append(e.host);
    } else {
      item.classList.add(HIDDEN);
      item.after(e.host);
    }
    editing = e;
    e.textarea.value = saved?.draft ?? view.source;
    e.textarea.rows = textareaRows(e.textarea.value);
    wireEditor(e);
    e.textarea.focus();
    const select = saved ? { from: saved.from, to: saved.to } : options.select;
    if (select) e.textarea.setSelectionRange(select.from, select.to);
    updateToolbar();
    saveState();
  }

  function wireEditor(e: Editing): void {
    e.textarea.addEventListener('input', () => {
      e.textarea.rows = textareaRows(e.textarea.value);
      clearTimeout(e.timer);
      e.timer = setTimeout(() => commit(e), AUTOSAVE_DELAY);
      saveState();
    });
    e.textarea.addEventListener(KEYDOWN, (event) => onEditorKey(e, event));
    e.textarea.addEventListener('blur', () => {
      commit(e);
      // Focus left the editor for another part of the page: editing ends. Leaving the window keeps it open.
      setTimeout(() => {
        if (editing === e && !e.root.activeElement && document.hasFocus()) finishEdit(false);
      }, 0);
    });
  }

  function onEditorKey(e: Editing, event: KeyboardEvent): void {
    if (isUndoRedo(event)) {
      // The textarea's own undo. Stopped here, VS Code never sees the key (it would undo the document instead).
      event.stopPropagation();
      return;
    }
    const handled = editorAction(e, event);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function editorAction(e: Editing, event: KeyboardEvent): boolean {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      finishEdit(true);
      return true;
    }
    if (event.key === ESCAPE) {
      cancelEdit(e);
      return true;
    }
    if (event.altKey && (event.key === ARROW_UP || event.key === ARROW_DOWN)) {
      finishEdit(true);
      move(event.key === ARROW_UP ? 'up' : 'down');
      return true;
    }
    return false;
  }

  /** Send the draft when it differs from what the extension has. */
  function commit(e: Editing): void {
    clearTimeout(e.timer);
    e.timer = undefined;
    const draft = e.textarea.value;
    if (e.conflict || draft === e.committed || !model) return;
    const editId = nextId();
    post({ type: 'edit', key: e.key, baseVersion: model.version, oldText: e.committed, newText: draft, editId });
    e.pending.add(editId);
    e.committed = draft;
    saveState();
  }

  /** End editing, keeping what was written. */
  function finishEdit(refocus: boolean): void {
    const e = editing;
    if (!e) return;
    commit(e);
    closeEditor(e, refocus);
  }

  /** Escape: the block goes back to how it was when editing began. */
  function cancelEdit(e: Editing): void {
    clearTimeout(e.timer);
    e.textarea.value = e.original;
    if (e.committed !== e.original && !e.conflict) commit(e);
    closeEditor(e, true);
  }

  function closeEditor(e: Editing, refocus: boolean): void {
    editing = null;
    clearTimeout(e.timer);
    e.host.remove();
    for (const id of e.pending) closedDrafts.set(id, { key: e.key, range: e.range, draft: e.committed, original: e.original });
    const changed = e.committed !== e.original;
    const content = e.item === e.top ? e.item.querySelector<HTMLElement>(`:scope > .${CONTENT}`) : null;
    content?.removeAttribute('hidden');
    e.item.classList.remove(HIDDEN);
    currentKey = e.key;
    currentLine = e.range.start;
    // The block is rendered again: now, when the last render has every edit made here; else from the next one, and
    // until it comes, what was written shows as text.
    const settled = isSettled(e, changed);
    if (changed) signature.set(e.top, '');
    if (changed && !settled) showWritten(e, content);
    if (settled && model) renderAll(model);
    updateToolbar();
    saveState();
    if (refocus) ensureCurrent(true);
  }

  function isSettled(e: Editing, changed: boolean): boolean {
    if (!model) return false;
    return !changed || (e.pending.size === 0 && model.version >= e.acked);
  }

  function showWritten(e: Editing, content: HTMLElement | null): void {
    const written = h('pre', { className: `${RAW} smd-ed-pending`, text: e.committed });
    if (content) content.replaceChildren(written);
    else e.item.replaceWith(written);
  }

  function showConflict(e: Editing, currentText: string | null): void {
    e.conflict = true;
    e.pending.clear();
    clearTimeout(e.timer);
    const gone = currentText === null;
    const text = gone
      ? 'This block was removed or rewritten in another editor. Your text is kept here.'
      : 'This block was changed in another editor. Your text is kept here.';
    const resolved = () => {
      // From now on Escape goes back to the other editor's version, not over it.
      e.original = currentText ?? e.original;
      e.conflict = false;
      e.notice.hidden = true;
      e.notice.replaceChildren();
      e.textarea.focus();
    };
    const actions = gone
      ? [
        button('Copy my text', () => void navigator.clipboard?.writeText(e.textarea.value)),
        button('Discard my text', () => closeEditor(e, true)),
      ]
      : [
        button('Keep my version', () => {
          e.committed = currentText;
          resolved();
          commit(e);
        }),
        button('Use the other version', () => {
          e.committed = currentText;
          e.textarea.value = currentText;
          e.textarea.rows = textareaRows(currentText);
          resolved();
        }),
      ];
    e.notice.replaceChildren(h('p', { text }), h(DIV, { className: 'actions' }, actions));
    e.notice.hidden = false;
    rt.announce(text);
  }

  // ---- Messages from the extension -----------------------------------------------
  function renderAll(msg: RenderMessage): void {
    ensureArticle(msg.open);
    setHtml(headerHolder, msg.header);
    setHtml(tocHolder, msg.toc);
    renderFrontMatter(msg.frontMatter);
    reconcile(msg);
    setHtml(tailHolder, msg.tail);
    ensureCurrent(false);
  }

  function onRender(msg: RenderMessage): void {
    model = msg;
    document.documentElement.dataset.smdThemePref = msg.themePref;
    if (editing) {
      const followed = followEdit(msg, editing.key, editing.range);
      editing.key = followed.key;
      editing.range = followed.range;
    }
    if (grid) {
      const followed = followEdit(msg, grid.key, grid.range);
      grid.key = followed.key;
      grid.range = followed.range;
    }
    const active = document.activeElement;
    const hadFocus = !active || active === document.body || rootEl.contains(active);
    renderAll(msg);
    refreshGrid(msg);
    // A block that had focus and was rendered again: focus goes to the block now in its place.
    if (hadFocus && !editing && !grid && !rootEl.contains(document.activeElement)) currentItem()?.focus();
    if (!restored) restore();
    applyPendingFocus();
    openPending();
  }

  function onAck(editId: string, version: number, focus: FocusRequest | undefined): void {
    acked = Math.max(acked, version);
    fixApplied(editId);
    closedDrafts.delete(editId);
    cellEdits.delete(editId);
    if (editing?.pending.delete(editId)) editing.acked = Math.max(editing.acked, version);
    const request = gridOps.get(editId);
    gridOps.delete(editId);
    if (request) gridAcked(editId, version, request);
    // A cell's own edit moves no focus (the user may be in another cell by now); a row or column change does.
    const wanted = focus?.cell ? gridFocus(request, focus) : focus;
    if (wanted) pendingFocus = { version, focus: wanted };
    applyPendingFocus();
  }

  function onConflict(editId: string, currentText: string | null): void {
    const cell = cellEdits.has(editId);
    if (gridRefused(editId)) {
      showNotice(cell
        ? 'This table was changed in another editor. What you typed is kept in its cell: press Enter to write it.'
        : 'This table was changed in another editor. Try again.');
      return;
    }
    if (editing?.pending.has(editId)) {
      showConflict(editing, currentText);
      return;
    }
    const closed = closedDrafts.get(editId);
    closedDrafts.delete(editId);
    if (!closed) {
      showNotice('That block changed in another editor. Try again.');
      return;
    }
    // An edit sent as editing ended didn't apply: open the block again with the text that was written.
    const list = itemsAll();
    const item = list.find((i) => i.dataset.smdEdKey === closed.key) ?? (list.length ? list[itemForLine(list.map(startOf), closed.range.start)] : undefined);
    if (!item) {
      showNotice('Your last edit could not be applied: the block was changed in another editor.');
      return;
    }
    startEdit(item, { restore: { key: closed.key, ...closed.range, original: closed.original, committed: closed.draft, draft: closed.draft, from: 0, to: 0 } });
    if (editing) showConflict(editing, currentText);
  }

  function onFlush(requestId: number): void {
    if (editing) commit(editing);
    if (grid) commitCell(grid, grid.cell);
    post({ type: 'flushed', requestId });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    // VS Code's webview host forwards the extension's messages from this page's own origin
    // (contentWindow.postMessage(message, window.origin)); anything else is not ours.
    if (event.origin !== window.origin) return;
    const msg = event.data as HostMessage | null;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'render':
        onRender(msg);
        break;
      case 'ack':
        onAck(msg.editId, msg.version, msg.focus);
        break;
      case 'conflict':
        onConflict(msg.editId, msg.currentText);
        break;
      case 'notice':
        showNotice(msg.text);
        if (msg.editId) {
          gridRefused(msg.editId);
          fixRefused(msg.editId);
        }
        if (msg.fallback) editSourceOf(msg.fallback);
        break;
      case 'flush':
        onFlush(msg.requestId);
        break;
      case 'fixes':
        onFixes(msg);
        break;
      case 'confirmFix':
        onConfirmFix(msg.editId, msg.index, msg.text);
        break;
    }
  });

  // ---- Saved state ---------------------------------------------------------------
  function saveState(): void {
    const e = editing;
    const state: SavedState = {
      current: currentKey,
      line: currentLine,
      editing: e && {
        key: e.key, start: e.range.start, end: e.range.end, original: e.original, committed: e.committed,
        draft: e.textarea.value, from: e.textarea.selectionStart, to: e.textarea.selectionEnd,
      },
    };
    rt.saveAppState(state);
  }

  /** The page came back (it was hidden): the same block current, the same draft open. */
  function restore(): void {
    restored = true;
    const saved = rt.appState() as SavedState | undefined;
    if (!saved || typeof saved !== 'object') return;
    currentKey = typeof saved.current === 'string' ? saved.current : currentKey;
    currentLine = typeof saved.line === 'number' ? saved.line : currentLine;
    ensureCurrent(false);
    const draft = saved.editing;
    if (!draft) return;
    const list = itemsAll();
    const item = list.find((i) => i.dataset.smdEdKey === draft.key) ?? list[itemForLine(list.map(startOf), draft.start)];
    if (item) startEdit(item, { restore: draft });
  }

  // ---- Keyboard and mouse on the blocks --------------------------------------------
  rootEl.addEventListener(KEYDOWN, (event) => {
    const item = event.target as HTMLElement;
    if (item.dataset?.smdInline !== undefined && ['Enter', ' ', 'F2'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      activateInline(item);
      return;
    }
    if (!item.classList?.contains(ITEM)) return;
    if (blockKey(item, event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  function blockKey(item: HTMLElement, event: KeyboardEvent): boolean {
    if (event.altKey && (event.key === ARROW_UP || event.key === ARROW_DOWN)) {
      move(event.key === ARROW_UP ? 'up' : 'down');
      return true;
    }
    if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey) || event.key === 'F2') {
      openByKey(item, event.key);
      return true;
    }
    if (event.key === '.' && (event.ctrlKey || event.metaKey) && !event.altKey) {
      openProblems(item);
      return true;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    const list = items();
    const to = listKeyTarget(event.key, list.indexOf(item), list.length);
    if (to < 0) return false;
    setCurrent(list[to], true);
    if (list[to].classList.contains(CHILD)) rt.announce(itemAnnouncement(viewOf.get(list[to])!, shownProblems.get(list[to])));
    return true;
  }

  rootEl.addEventListener('focusin', (event) => {
    const item = event.target as HTMLElement;
    if (item.classList?.contains(ITEM) && item.dataset.smdEdKey !== currentKey) setCurrent(item, false);
  });

  rootEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest || target.closest(INTERACTIVE)) return;
    if (String(globalThis.getSelection?.() ?? '') !== '') return;
    const inline = target.closest<HTMLElement>(INLINE);
    if (inline && rootEl.contains(inline) && !inline.closest(`.${EDITOR}, .${HIDDEN}`)) {
      activateInline(inline);
      return;
    }
    const item = target.closest<HTMLElement>(`.${ITEM}`);
    if (item && editing?.item !== item) {
      setCurrent(item, false);
      openItem(item, renderedCell(item, target));
    }
  });

  /** Open a block to edit it: a table that the grid can edit in the grid at `cell`, anything else in its source. */
  function openItem(item: HTMLElement, cell: GridCell | undefined): void {
    if (cell && viewOf.get(item)?.table?.rows) openGrid(item, cell);
    else startEdit(item);
  }

  /** Enter opens a table in the grid (at its first cell); F2, and Enter on anything else, the block's source. */
  function openByKey(item: HTMLElement, key: string): void {
    openItem(item, key === 'Enter' ? { row: 0, col: 0 } : undefined);
  }

  /** The cell of a rendered table a click landed in (row 0: the header row). */
  function renderedCell(item: HTMLElement, target: HTMLElement): GridCell | undefined {
    const cell = target.closest<HTMLTableCellElement>('td, th');
    const row = cell?.parentElement;
    if (!cell || !(row instanceof HTMLTableRowElement) || !item.contains(cell)) return undefined;
    return { row: row.rowIndex, col: cell.cellIndex };
  }

  document.addEventListener(KEYDOWN, (event) => {
    if (event.key === '/' && (event.ctrlKey || event.metaKey) && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      openMenu(currentItem() ?? null);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (editing) commit(editing);
    if (grid) commitCell(grid, grid.cell);
  });

  // ---- Requests ----------------------------------------------------------------------
  function move(direction: 'up' | 'down'): void {
    // Right after editing, the block's element may still carry its old key; currentKey has the new one.
    const key = currentView()?.key ?? currentKey;
    if (key) post({ type: 'move', key, direction, editId: nextId() });
  }

  function act(action: Action): void {
    switch (action) {
      case 'insert':
        openMenu(null);
        return;
      case 'fm':
        post({ type: 'addFrontMatter', editId: nextId() });
        return;
      case 'props':
        toggleProps();
        return;
      case 'problems': {
        const item = currentItem();
        if (item) openProblems(item);
        return;
      }
      default:
        blockAction(action);
    }
  }

  /** An action on the current block. */
  function blockAction(action: 'edit' | 'grid' | 'up' | 'down' | 'del' | 'reveal'): void {
    const view = currentView();
    if (!view) return;
    if (action === 'grid') {
      const item = currentItem();
      if (item && view.table?.rows) openGrid(item);
      return;
    }
    if (editing) finishEdit(false);
    closeGrid(false);
    if (action === 'edit') {
      const item = currentItem();
      if (item) startEdit(item);
    } else if (action === 'up' || action === 'down') {
      move(action);
    } else if (action === 'del') {
      post({ type: 'delete', key: view.key, editId: nextId() });
      rt.announce('Block deleted. Ctrl+Z undoes it.');
    } else {
      post({ type: 'revealLine', line: view.start });
    }
  }

  function insert(name: string): void {
    const view = currentView();
    if (editing) finishEdit(false);
    post(view ? { type: 'insert', template: name, atKey: view.key, editId: nextId() } : { type: 'insert', template: name, position: 'end', editId: nextId() });
  }

  // ---- The toolbar -----------------------------------------------------------------------
  const barRoot = chromeRoot(toolbarHost);
  const buttons: Record<Action, HTMLButtonElement> = {
    insert: button('Insert…', () => act('insert'), { title: 'Insert a block after this one (Ctrl+/)', 'aria-haspopup': 'menu', [ARIA_EXPANDED]: FALSE, 'aria-controls': 'menu' }),
    edit: button('Edit', () => act('edit'), { title: 'Edit the source of this block (Enter, or F2 on a table)' }),
    grid: button('Edit as grid', () => act('grid'), { title: 'Edit this table cell by cell (Enter)' }),
    props: button('Properties', () => act('props'), { title: 'Title and attributes of this container', [ARIA_EXPANDED]: FALSE, 'aria-controls': 'props' }),
    problems: button('Problems…', () => act('problems'), { title: 'This block\'s problems and their quick fixes (Ctrl+.)', 'aria-haspopup': 'dialog' }),
    up: button('Move up', () => act('up'), { title: 'Move this block up (Alt+Up)' }),
    down: button('Move down', () => act('down'), { title: 'Move this block down (Alt+Down)' }),
    del: button('Delete', () => act('del'), { title: 'Delete this block (Ctrl+Z undoes it)' }),
    reveal: button('Edit in text editor', () => act('reveal'), { title: 'Show this block in the text editor' }),
    fm: button('Add front matter', () => act('fm'), { title: 'Add a front matter block with a title' }),
  };
  const toolbar = h(DIV, { className: 'toolbar', attrs: { role: 'toolbar', [ARIA_LABEL]: 'Block editor' } }, Object.values(buttons));
  const status = h('span', { className: 'status', attrs: { id: 'status' } });
  const noticeEl = h(DIV, { className: 'bar-notice', attrs: { role: 'status' } });
  const menu = h(DIV, { className: 'menu', attrs: { id: 'menu', role: 'menu', [ARIA_LABEL]: 'Insert block' } });
  const props = h(DIV, { className: 'props', attrs: { id: 'props', role: 'group' } });
  menu.hidden = true;
  props.hidden = true;
  toolbar.setAttribute('aria-describedby', 'status');
  barRoot.append(h(DIV, { className: 'bar' }, [toolbar, status]), noticeEl, menu, props);
  let barIndex = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  const barButtons = () => Object.values(buttons).filter((b) => !b.hidden);

  function rovingBar(): void {
    const list = barButtons();
    barIndex = Math.min(barIndex, list.length - 1);
    list.forEach((b, i) => b.setAttribute(TABINDEX, i === barIndex ? '0' : '-1'));
  }

  toolbar.addEventListener(KEYDOWN, (event) => {
    const list = barButtons();
    const to = toolbarKeyTarget(event.key, list.indexOf(event.target as HTMLButtonElement), list.length);
    if (to < 0) return;
    event.preventDefault();
    barIndex = to;
    rovingBar();
    list[to].focus();
  });

  toolbar.addEventListener('click', (event) => {
    const b = event.target as HTMLButtonElement;
    if (b.getAttribute(ARIA_DISABLED) === TRUE) event.stopImmediatePropagation();
  }, true);

  function setDisabled(b: HTMLButtonElement, disabled: boolean): void {
    if (disabled) b.setAttribute(ARIA_DISABLED, TRUE);
    else b.removeAttribute(ARIA_DISABLED);
  }

  function updateToolbar(): void {
    const view = currentView();
    status.textContent = view ? blockLabel(view) : 'No block selected';
    for (const action of ['edit', 'up', 'down', 'del', 'reveal'] as const) setDisabled(buttons[action], !view);
    setDisabled(buttons.props, !view?.form);
    const item = currentItem();
    setDisabled(buttons.problems, !item || !shownProblems.get(item));
    updateGridButton(view?.table);
    buttons.fm.hidden = !model || model.frontMatter !== null;
    rovingBar();
    if (!props.hidden) fillProps();
    updateInlineStops();
  }

  /** "Edit as grid": shown for a table, unavailable (with the reason) when only its source can change it, or while it is open. */
  function updateGridButton(table: TableView | undefined): void {
    buttons.grid.hidden = !table;
    setDisabled(buttons.grid, !table?.rows || grid !== null);
    buttons.grid.title = table?.refused ? `${table.refused} Edit the table's source instead.` : 'Edit this table cell by cell (Enter)';
  }

  function showNotice(text: string): void {
    noticeEl.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (noticeEl.textContent = ''), NOTICE_TIME);
  }

  // ---- The insert menu (Ctrl+/) -----------------------------------------------------------
  let menuReturn: HTMLElement | null = null;

  function openMenu(returnTo: HTMLElement | null): void {
    if (!model?.templates.length) return;
    menuReturn = returnTo;
    const entries = model.templates.map((t) => {
      const item = button(t.name, () => {
        closeMenu(false);
        insert(t.name);
      }, { role: 'menuitem', [TABINDEX]: '-1' });
      if (t.description) item.title = t.description;
      return item;
    });
    menu.replaceChildren(...entries);
    menu.hidden = false;
    buttons.insert.setAttribute(ARIA_EXPANDED, TRUE);
    entries[0].focus();
  }

  function closeMenu(refocus: boolean): void {
    if (menu.hidden) return;
    menu.hidden = true;
    buttons.insert.setAttribute(ARIA_EXPANDED, FALSE);
    if (refocus) (menuReturn ?? buttons.insert).focus();
  }

  menu.addEventListener(KEYDOWN, (event) => {
    const entries = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const index = entries.indexOf(event.target as HTMLButtonElement);
    if (event.key === ESCAPE || event.key === 'Tab') {
      if (event.key === ESCAPE) event.preventDefault();
      closeMenu(event.key === ESCAPE);
      return;
    }
    let to = listKeyTarget(event.key, index, entries.length, true);
    if (to < 0 && event.key.length === 1 && !event.ctrlKey && !event.metaKey) to = typeAhead(entries.map((b) => b.textContent ?? ''), event.key, index);
    if (to < 0) return;
    event.preventDefault();
    entries[to].focus();
  });

  menu.addEventListener('focusout', (event) => {
    if (!menu.contains(event.relatedTarget as Node | null)) setTimeout(() => {
      if (!menu.contains(barRoot.activeElement)) closeMenu(false);
    }, 0);
  });

  // ---- The properties form of a container ------------------------------------------------
  function toggleProps(): void {
    if (props.hidden) {
      props.hidden = false;
      buttons.props.setAttribute(ARIA_EXPANDED, TRUE);
      fillProps();
      props.querySelector<HTMLElement>('input, select')?.focus();
    } else {
      closeProps(true);
    }
  }

  function closeProps(refocus: boolean): void {
    props.hidden = true;
    buttons.props.setAttribute(ARIA_EXPANDED, FALSE);
    if (refocus) buttons.props.focus();
  }

  function fieldControl(field: FormField, id: string): HTMLInputElement | HTMLSelectElement {
    if (field.kind === 'select' || field.kind === 'color') {
      const select = h('select', { attrs: { id } });
      for (const option of field.options ?? ['']) select.append(h('option', { text: option || '(not set)', attrs: { value: option } }));
      select.value = field.value;
      return select;
    }
    const input = h('input', { attrs: { id, type: INPUT_TYPES[field.kind] ?? 'text' } });
    if (field.kind === 'flag') input.checked = field.value === TRUE;
    else input.value = field.value;
    return input;
  }

  function fieldRow(key: string, field: FormField): HTMLElement {
    const id = `field-${field.name}`;
    const control = fieldControl(field, id);
    control.addEventListener('change', () => {
      const value = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value;
      post({ ...formRequest(field, value), key, editId: nextId() });
    });
    const label = h('label', { text: field.label, attrs: { for: id } });
    return h(DIV, { className: `field ${field.kind}`, attrs: { 'data-field': field.name } }, field.kind === 'flag' ? [control, label] : [label, control]);
  }

  /** Fill the form for the current container; the control with focus keeps it. */
  function fillProps(): void {
    const view = currentView();
    const form = view?.form;
    const focused = (barRoot.activeElement as HTMLElement | null)?.closest<HTMLElement>('.field')?.dataset.field;
    if (!view || !form) {
      props.replaceChildren(h('p', { text: 'The current block is not a container: it has no properties.' }));
      return;
    }
    props.setAttribute(ARIA_LABEL, `Properties of ${blockLabel(view)}`);
    const rows = form.fields.map((f) => fieldRow(view.key, f));
    props.replaceChildren(h('p', { className: 'props-title', text: `:::${form.name}` }), ...rows, button('Done', () => closeProps(true)));
    if (focused) props.querySelector<HTMLElement>(`[data-field="${focused}"] input, [data-field="${focused}"] select`)?.focus();
  }

  props.addEventListener(KEYDOWN, (event) => {
    // In a text field, Ctrl+Z is the field's own undo, as in the source editor.
    if (isUndoRedo(event) && (event.target as HTMLInputElement).type === 'text') {
      event.stopPropagation();
      return;
    }
    if (event.key === ESCAPE) {
      event.preventDefault();
      closeProps(false);
      currentItem()?.focus();
    }
  });

  // ---- Tables: the grid -----------------------------------------------------------------------------------
  // A table the extension can edit cell by cell (BlockView.table.rows) opens in a grid of labelled text fields, in
  // place of its rendering: Enter on the table, a click in one of its cells, or "Edit as grid". Each cell is written
  // on its own (tableCell) when the user pauses, leaves it or presses Enter; rows and columns change from the grid's
  // toolbar (tableRow, tableCol, tableAlign), one change at a time: the grid waits for the render that has it.
  const cellOfInput = new WeakMap<HTMLInputElement, GridCell>();
  let pendingOpen: { line: number; cell?: GridCell } | null = null;

  const gridSize = (g: Grid): GridSize => ({ rows: g.rows.length, cols: g.rows[0]?.length ?? 0 });
  /** Every edit sent has been answered and rendered: the views the page has are the document's. */
  const settled = () => model !== null && model.version >= acked && closedDrafts.size === 0 && cellEdits.size === 0 && gridOps.size === 0;

  /** Open the block on a line once every edit sent is rendered: in the grid at `cell`, else in its source. */
  function openWhenSettled(line: number, cell?: GridCell): void {
    pendingOpen = cell ? { line, cell } : { line };
    openPending();
  }

  function openPending(): void {
    if (!pendingOpen || !settled()) return;
    const { line, cell } = pendingOpen;
    pendingOpen = null;
    const list = itemsAll();
    if (!list.length) return;
    const item = list[itemForLine(list.map(startOf), line)];
    setCurrent(item, false);
    if (cell) openGrid(item, cell);
    else startEdit(item);
  }

  function openGrid(target: HTMLElement, cell: GridCell = { row: 0, col: 0 }): void {
    if (grid?.item === target) {
      focusCell(grid, clampCell(cell, gridSize(grid)));
      return;
    }
    const item = editTarget(target);
    const view = item && viewOf.get(item);
    const table = view?.table;
    if (!item || !view || !table?.rows || !table.aligns) {
      if (table?.refused) showNotice(`${table.refused} Edit the table's source instead.`);
      return;
    }
    // An edit of this table may not be rendered yet: then the grid opens on the table as it is once it is.
    if (!settled()) {
      openWhenSettled(view.start, cell);
      return;
    }
    const top = (item.closest('.smd-ed-block') as HTMLElement | null) ?? item;
    const rows = table.rows.map((r) => [...r]);
    const g: Grid = {
      key: view.key, item, top, range: { start: view.start, end: view.end }, rows, aligns: [...table.aligns], inputs: [],
      cell: clampCell(cell, { rows: rows.length, cols: rows[0].length }), entry: '', busy: null, changed: false, ...gridChrome(view),
    };
    // The grid takes the place of the table's rendering, which stays in the page, hidden.
    if (item === top) {
      item.querySelector<HTMLElement>(`:scope > .${CONTENT}`)?.setAttribute('hidden', '');
      item.append(g.host);
    } else {
      item.classList.add(HIDDEN);
      item.after(g.host);
    }
    grid = g;
    fillGrid(g);
    wireGrid(g);
    focusCell(g, g.cell);
    updateToolbar();
  }

  function gridChrome(view: ItemView): Pick<Grid, 'host' | 'root' | 'table' | 'tools' | 'align'> {
    const host = h(DIV, { className: GRID_HOST });
    const root = chromeRoot(host);
    const label = h('p', { className: 'label', text: gridLabel(view), attrs: { id: 'grid-label' } });
    const tools: Record<GridAction, HTMLButtonElement> = {
      rowAbove: button('Row above', () => gridAction('rowAbove'), { title: 'Add a row above this one' }),
      rowBelow: button('Row below', () => gridAction('rowBelow'), { title: 'Add a row below this one' }),
      delRow: button('Delete row', () => gridAction('delRow'), { title: 'Delete this row' }),
      colLeft: button('Column left', () => gridAction('colLeft'), { title: 'Add a column left of this one' }),
      colRight: button('Column right', () => gridAction('colRight'), { title: 'Add a column right of this one' }),
      delCol: button('Delete column', () => gridAction('delCol'), { title: 'Delete this column' }),
      alignTable: button('Align table', () => gridAction('alignTable'), { title: 'Pad the columns so they line up, as smd fmt does' }),
    };
    const align = h('select', { attrs: { [ARIA_LABEL]: 'Column alignment' } });
    for (const [value, text] of ALIGN_CHOICES) align.append(h('option', { text, attrs: { value } }));
    align.addEventListener('change', () => {
      if (grid) sendGridOp(grid, { type: 'tableCol', op: 'align', at: grid.cell.col, align: align.value });
    });
    const buttons = Object.values(tools);
    const bar = h(DIV, { className: 'toolbar', attrs: { role: 'toolbar', [ARIA_LABEL]: 'Table rows and columns' } }, [
      ...buttons, align, button('Edit source', () => gridToSource(), { title: 'Edit the table\'s Markdown source (F2)' }), button('Done', () => closeGrid(true)),
    ]);
    const table = h('table', { className: 'grid', attrs: { role: 'grid', 'aria-labelledby': 'grid-label' } });
    const hint = h('p', {
      className: 'hint',
      text: 'Arrow keys, Tab: move between cells. Enter: write the cell and go down. Escape: undo the cell, or close the grid.',
    });
    root.append(h(DIV, { className: 'grid-editor' }, [label, bar, h(DIV, { className: 'grid-scroll' }, [table]), hint]));
    return { host, root, table, tools, align };
  }

  /** The grid's rows of labelled cell fields, from what the extension has. */
  function fillGrid(g: Grid): void {
    const head = h('thead');
    const body = h('tbody');
    const size = gridSize(g);
    g.inputs = g.rows.map((cells, row) => {
      const tr = h('tr');
      const inputs = cells.map((text, col) => {
        const input = h('input', { attrs: { type: 'text', spellcheck: FALSE, autocomplete: 'off' } });
        input.value = text;
        cellOfInput.set(input, { row, col });
        tr.append(row === 0 ? h('th', { attrs: { scope: 'col' } }, [input]) : h('td', {}, [input]));
        return input;
      });
      (row === 0 ? head : body).append(tr);
      return inputs;
    });
    g.table.replaceChildren(head, body);
    labelCells(g);
    g.table.setAttribute('aria-rowcount', String(size.rows));
    g.table.setAttribute('aria-colcount', String(size.cols));
  }

  /** Each field's label (its column's header and its row) and its column's alignment. */
  function labelCells(g: Grid): void {
    g.inputs.forEach((inputs, row) => inputs.forEach((input, col) => {
      input.setAttribute(ARIA_LABEL, cellLabel(g.rows[0], { row, col }, g.rows.length));
      input.className = `align-${g.aligns[col] ?? 'none'}`;
    }));
  }

  function wireGrid(g: Grid): void {
    g.table.addEventListener('focusin', (event) => {
      const input = event.target as HTMLInputElement;
      const cell = cellOfInput.get(input);
      if (!cell) return;
      g.cell = cell;
      g.entry = input.value;
      updateGridTools(g);
    });
    g.table.addEventListener('focusout', (event) => {
      const cell = cellOfInput.get(event.target as HTMLInputElement);
      if (cell) commitCell(g, cell);
    });
    g.table.addEventListener('input', (event) => {
      const cell = cellOfInput.get(event.target as HTMLInputElement);
      if (!cell) return;
      clearTimeout(g.timer);
      g.timer = setTimeout(() => commitCell(g, cell), AUTOSAVE_DELAY);
    });
    g.table.addEventListener(KEYDOWN, (event) => onGridKey(g, event));
    g.root.addEventListener(KEYDOWN, (event) => gridChromeKey(event as KeyboardEvent));
    const bar = g.tools.rowAbove.parentElement!;
    bar.addEventListener(KEYDOWN, (event) => gridBarKey(g, event));
    g.root.addEventListener('focusout', () => {
      // Focus left the grid for another part of the page: the grid closes. Leaving the window keeps it open.
      setTimeout(() => {
        if (grid === g && !g.root.activeElement && document.hasFocus()) closeGrid(false);
      }, 0);
    });
  }

  /**
   * Keys anywhere in the grid: Ctrl+Z in a cell is the field's own undo; F2 opens the source; Ctrl+Enter (done), and
   * Escape outside a cell, close the grid.
   */
  function gridChromeKey(event: KeyboardEvent): void {
    const inCell = cellOfInput.has(event.target as HTMLInputElement);
    if (isUndoRedo(event)) {
      if (inCell) event.stopPropagation();
      return;
    }
    const source = event.key === 'F2';
    const done = (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) || (event.key === ESCAPE && !inCell);
    if (!source && !done) return;
    event.preventDefault();
    event.stopPropagation();
    if (source) gridToSource();
    else closeGrid(true);
  }

  /** The grid toolbar's buttons: one tab stop, arrow keys between them (the alignment list is a stop of its own). */
  function gridBarKey(g: Grid, event: KeyboardEvent): void {
    const list = Object.values(g.tools);
    const index = list.indexOf(event.target as HTMLButtonElement);
    const to = index < 0 ? -1 : toolbarKeyTarget(event.key, index, list.length);
    if (to < 0) return;
    event.preventDefault();
    list.forEach((b, i) => b.setAttribute(TABINDEX, i === to ? '0' : '-1'));
    list[to].focus();
  }

  function onGridKey(g: Grid, event: KeyboardEvent): void {
    const input = event.target as HTMLInputElement;
    const cell = cellOfInput.get(input);
    if (!cell || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === ESCAPE) {
      event.preventDefault();
      event.stopPropagation();
      escapeCell(g, input, cell);
      return;
    }
    const length = input.value.length;
    const caret = {
      atStart: input.selectionStart === 0 && input.selectionEnd === 0,
      atEnd: input.selectionStart === length && input.selectionEnd === length,
    };
    const to = gridKeyTarget(event.key, cell, gridSize(g), caret, event.shiftKey);
    if (event.key === 'Enter') commitCell(g, cell);
    else if (!to) return;
    event.preventDefault();
    event.stopPropagation();
    if (to) focusCell(g, to);
  }

  /** Escape: the cell goes back to its text when focus came to it; when it has that text, the grid closes. */
  function escapeCell(g: Grid, input: HTMLInputElement, cell: GridCell): void {
    if (input.value === g.entry) {
      closeGrid(true);
      return;
    }
    input.value = g.entry;
    commitCell(g, cell);
    rt.announce('Cell restored.');
  }

  function focusCell(g: Grid, cell: GridCell): void {
    const input = g.inputs[cell.row]?.[cell.col];
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function focusGridCell(line: number, cell: GridCell): void {
    if (grid && grid.range.start === line) {
      focusCell(grid, clampCell(cell, gridSize(grid)));
      return;
    }
    const list = itemsAll();
    const item = list[itemForLine(list.map(startOf), line)];
    if (item) openGrid(item, cell);
  }

  /** Send a cell's text when it differs from what the extension has. */
  function commitCell(g: Grid, cell: GridCell): void {
    clearTimeout(g.timer);
    g.timer = undefined;
    const input = g.inputs[cell.row]?.[cell.col];
    // A grid that was closed writes nothing (removing it blurs its field), nor does one waiting for a change.
    if (!input || g.busy || grid !== g) return;
    const text = cellSource(input.value);
    const previous = g.rows[cell.row][cell.col];
    if (text === previous) return;
    const editId = nextId();
    cellEdits.set(editId, { cell, previous });
    g.rows[cell.row][cell.col] = text;
    g.changed = true;
    post({ type: 'tableCell', key: g.key, row: cell.row, col: cell.col, text: input.value, editId });
  }

  function gridAction(action: GridAction): void {
    const g = grid;
    if (!g || !gridActionEnabled(action, g.cell, gridSize(g))) return;
    sendGridOp(g, gridRequest(action, g.cell));
  }

  /** Send a row or column change: the cell's text first; then the grid waits, read-only, until it is rendered. */
  function sendGridOp(g: Grid, request: GridRequest): void {
    if (g.busy) return;
    commitCell(g, g.cell);
    const editId = nextId();
    g.busy = { editId };
    g.changed = true;
    gridOps.set(editId, request);
    setGridBusy(g, true);
    post({ ...request, key: g.key, editId });
  }

  function setGridBusy(g: Grid, busy: boolean): void {
    g.table.setAttribute('aria-busy', busy ? TRUE : FALSE);
    g.inputs.flat().forEach((input) => (input.readOnly = busy));
    updateGridTools(g);
  }

  /** The grid toolbar for the cell focus is in: what it can do there, and the column's alignment. */
  function updateGridTools(g: Grid): void {
    const size = gridSize(g);
    for (const [action, b] of Object.entries(g.tools) as [GridAction, HTMLButtonElement][]) {
      setDisabled(b, g.busy !== null || !gridActionEnabled(action, g.cell, size));
    }
    g.align.disabled = g.busy !== null;
    g.align.value = g.aligns[g.cell.col] ?? 'none';
    g.align.setAttribute(ARIA_LABEL, `Alignment of column ${g.cell.col + 1}`);
    const list = Object.values(g.tools);
    if (!list.some((b) => b.getAttribute(TABINDEX) === '0')) list.forEach((b, i) => b.setAttribute(TABINDEX, i === 0 ? '0' : '-1'));
  }

  /** A row or column change was made: once the render that has it comes, the grid shows it. */
  function gridAcked(editId: string, version: number, request: GridRequest): void {
    rt.announce(gridAnnouncement(request));
    if (grid?.busy?.editId !== editId) return;
    grid.busy.version = version;
    if (model && model.version >= version) refreshGrid(model);
  }

  /** Where focus goes after a grid change: the cell the extension names (a row change keeps the column). */
  function gridFocus(request: GridRequest | undefined, focus: FocusRequest): FocusRequest | undefined {
    if (!request || !grid || !focus.cell) return undefined;
    return request.type === 'tableRow' ? { ...focus, cell: { row: focus.cell.row, col: grid.cell.col } } : focus;
  }

  /**
   * A grid edit that was not made (a conflict, or a notice): the grid stops waiting, and a cell keeps what was typed
   * in it, not written. True when the edit came from the grid.
   */
  function gridRefused(editId: string): boolean {
    const cellEdit = cellEdits.get(editId);
    const op = gridOps.delete(editId);
    cellEdits.delete(editId);
    if (grid && cellEdit && grid.rows[cellEdit.cell.row]?.[cellEdit.cell.col] !== undefined) {
      grid.rows[cellEdit.cell.row][cellEdit.cell.col] = cellEdit.previous;
    }
    if (grid?.busy?.editId === editId) {
      grid.busy = null;
      setGridBusy(grid, false);
    }
    return cellEdit !== undefined || op;
  }

  /** A render while the grid is open: the cells follow the document, except what the user typed and has not written. */
  function refreshGrid(msg: RenderMessage): void {
    const g = grid;
    if (!g || (g.busy && (g.busy.version === undefined || msg.version < g.busy.version))) return;
    const table = findView(msg.blocks, g.key)?.table;
    if (!table?.rows || !table.aligns) {
      closeGrid(g.root.activeElement !== null, false);
      showNotice(table?.refused ?? 'This table can no longer be edited as a grid.');
      return;
    }
    g.busy = null;
    const sameSize = table.rows.length === g.rows.length && table.rows[0].length === g.rows[0].length;
    if (sameSize) updateCells(g, table.rows);
    g.rows = table.rows.map((r) => [...r]);
    g.aligns = [...table.aligns];
    if (sameSize) labelCells(g);
    else rebuildGrid(g);
    setGridBusy(g, false);
  }

  /** The table has other rows or columns now: new fields, and focus on the same cell (or the nearest) if it was in the grid. */
  function rebuildGrid(g: Grid): void {
    const focused = g.root.activeElement !== null;
    fillGrid(g);
    g.cell = clampCell(g.cell, gridSize(g));
    if (focused) focusCell(g, g.cell);
  }

  function updateCells(g: Grid, rows: readonly string[][]): void {
    const active = g.root.activeElement;
    rows.forEach((cells, row) => cells.forEach((next, col) => {
      const input = g.inputs[row][col];
      const value = refreshedValue(input.value, g.rows[row][col], next, input === active);
      if (value === input.value) return;
      input.value = value;
      if (input === active) g.entry = value;
    }));
  }

  function gridToSource(): void {
    const g = grid;
    if (!g) return;
    const line = g.range.start;
    closeGrid(false);
    openWhenSettled(line);
  }

  /** Leave the grid: the table is shown rendered again (from the next render when something was written). */
  function closeGrid(refocus: boolean, commit = true): void {
    const g = grid;
    if (!g) return;
    if (commit) commitCell(g, g.cell);
    grid = null;
    clearTimeout(g.timer);
    g.host.remove();
    const content = g.item === g.top ? g.item.querySelector<HTMLElement>(`:scope > .${CONTENT}`) : null;
    content?.removeAttribute('hidden');
    g.item.classList.remove(HIDDEN);
    currentKey = g.key;
    currentLine = g.range.start;
    if (g.changed) signature.set(g.top, '');
    if (model) renderAll(model);
    updateToolbar();
    saveState();
    if (refocus) ensureCurrent(true);
  }

  // ---- Inline items: a small form for one directive or styled span -------------------------------
  // The editable items of the current block are tab stops right after it, so Tab from the block goes through them.
  // Clicking one, or Enter on it, opens its form; an item the form can't change opens the block's source instead.
  let inlineStops: HTMLElement[] = [];
  const INLINE_STOP_ATTRS = ['role', 'aria-haspopup', ARIA_LABEL, TABINDEX];

  /** The top-level block an inline element is in, its key, and what the extension says of the element. */
  function inlineOf(el: HTMLElement): { key: string; view: InlineView } | undefined {
    const top = el.closest<HTMLElement>('.smd-ed-block');
    const key = top?.dataset.smdEdKey;
    const view = top ? viewOf.get(top)?.inline?.[Number(el.dataset.smdInline)] : undefined;
    return key && view ? { key, view } : undefined;
  }

  function updateInlineStops(): void {
    for (const el of inlineStops) INLINE_STOP_ATTRS.forEach((name) => el.removeAttribute(name));
    const item = held() ? undefined : currentItem();
    inlineStops = item ? Array.from(item.querySelectorAll<HTMLElement>(INLINE)).filter((el) => inlineOf(el)?.view.fields) : [];
    for (const el of inlineStops) {
      el.setAttribute('role', 'button');
      el.setAttribute('aria-haspopup', 'dialog');
      el.setAttribute(ARIA_LABEL, inlineItemLabel(inlineOf(el)!.view));
      el.setAttribute(TABINDEX, '0');
    }
  }

  function activateInline(el: HTMLElement): void {
    const found = inlineOf(el);
    const item = el.closest<HTMLElement>(`.${ITEM}`);
    if (!found?.view.fields) {
      if (found) showNotice(`${found.view.label}: edit the block's source to change it.`);
      if (item) {
        setCurrent(item, false);
        startEdit(item);
      }
      return;
    }
    if (editing) finishEdit(false);
    // Ending the edit may have shown the block again as text: then there is no item to edit any more.
    if (!el.isConnected) return;
    if (item && item.dataset.smdEdKey !== currentKey) setCurrent(item, false);
    openInline(el, found.key, found.view);
  }

  function editSourceOf(key: string): void {
    if (grid?.key === key) {
      // A grid edit was refused: the table's source opens once what the grid did write is rendered.
      const line = grid.range.start;
      closeGrid(false, false);
      openWhenSettled(line);
      return;
    }
    const item = itemsAll().find((i) => i.dataset.smdEdKey === key);
    if (!item) return;
    setCurrent(item, false);
    startEdit(item);
  }

  const popHost = h(DIV, { className: 'smd-ed-pop-host' });
  const popRoot = chromeRoot(popHost);
  const pop = h(DIV, { className: 'pop', attrs: { role: 'dialog', 'aria-labelledby': 'pop-title' } });
  popRoot.append(pop);
  popHost.hidden = true;
  document.body.append(popHost);
  let popTarget: { el: HTMLElement; key: string; view: InlineView; controls: Map<string, HTMLInputElement | HTMLSelectElement> } | null = null;

  function openInline(el: HTMLElement, key: string, view: InlineView): void {
    closeProblems(false);
    const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
    const rows = (view.fields ?? []).map((field) => {
      const id = `inline-${field.name}`;
      const control = fieldControl(field, id);
      controls.set(field.name, control);
      return h(DIV, { className: `field ${field.kind}` }, [h('label', { text: field.label, attrs: { for: id } }), control]);
    });
    const title = h('p', { className: 'pop-title', text: view.text ? `${view.label}: ${view.text}` : view.label, attrs: { id: 'pop-title' } });
    const hint = h('p', { className: 'hint', text: 'Enter: apply. Escape: cancel.' });
    const actions = h(DIV, { className: 'actions' }, [button('Apply', applyInline), button('Cancel', () => closeInline(true))]);
    pop.replaceChildren(title, ...rows, hint, actions);
    popTarget = { el, key, view, controls };
    popHost.hidden = false;
    const rect = el.getBoundingClientRect();
    popHost.style.top = `${rect.bottom + window.scrollY + 4}px`;
    popHost.style.left = `${Math.max(0, rect.left + window.scrollX)}px`;
    rows[0]?.querySelector<HTMLElement>('input, select')?.focus();
  }

  function applyInline(): void {
    const target = popTarget;
    if (!target) return;
    const values = Object.fromEntries([...target.controls].map(([name, control]) => [name, control.value]));
    const request = inlineRequest(target.view.fields ?? [], values);
    closeInline(true);
    if (!request) return;
    post({ type: 'setInline', key: target.key, index: target.view.index, name: target.view.name, ...request, editId: nextId() });
    rt.announce(inlineAnnouncement(target.view, request));
  }

  function closeInline(refocus: boolean): void {
    const target = popTarget;
    if (!target) return;
    popTarget = null;
    popHost.hidden = true;
    pop.replaceChildren();
    if (!refocus) return;
    const el = target.el.isConnected ? target.el : nodes.get(target.key)?.querySelector<HTMLElement>(`[data-smd-inline="${target.view.index}"]`);
    (el ?? currentItem())?.focus();
  }

  pop.addEventListener(KEYDOWN, (event) => {
    // In a text field, Ctrl+Z is the field's own undo, as in the source editor.
    if (isUndoRedo(event) && (event.target as HTMLInputElement).type === 'text') {
      event.stopPropagation();
      return;
    }
    const escape = event.key === ESCAPE;
    // Enter applies an inline form, except on a button, which Enter presses.
    const enter = event.key === 'Enter' && popTarget !== null && !(event.target instanceof HTMLButtonElement);
    if (!escape && !enter) return;
    event.preventDefault();
    event.stopPropagation();
    if (escape) closePop(true);
    else applyInline();
  });

  pop.addEventListener('focusout', (event) => {
    if (!pop.contains(event.relatedTarget as Node | null)) setTimeout(() => {
      if (!pop.contains(popRoot.activeElement)) closePop(false);
    }, 0);
  });

  /** Close the inline form or the problems list. */
  function closePop(refocus: boolean): void {
    closeInline(refocus);
    closeProblems(refocus);
  }

  function placePop(el: HTMLElement): void {
    popHost.hidden = false;
    const rect = el.getBoundingClientRect();
    popHost.style.top = `${rect.top + window.scrollY + Math.min(rect.height, 24) + 4}px`;
    popHost.style.left = `${Math.max(0, rect.left + window.scrollX)}px`;
  }

  // ---- Problems: the list of a block's problems, and their quick fixes ----------------------------------------
  // The badge on a block (or Ctrl+. on it, or Problems… in the toolbar) opens a list of its problems and asks the
  // extension for their quick fixes. The page shows their titles and sends the one chosen by number (applyFix); the
  // extension keeps the fixes themselves, and asks first when one changes more than the block.
  let problemsTarget: {
    item: HTMLElement; key: string; requestId: number; fixes: HTMLElement; version?: number; list?: FixView[]; editId?: string;
  } | null = null;
  let fixRequests = 0;

  function openProblems(item: HTMLElement): void {
    const view = viewOf.get(item);
    const problems = shownProblems.get(item);
    if (!view || !problems) {
      showNotice('This block has no problems.');
      return;
    }
    // Whatever was typed is written first, so the fixes are for the block as it is.
    if (editing) finishEdit(false);
    closePop(false);
    const title = h('p', { className: 'pop-title', text: `Problems: ${blockLabel(view)}`, attrs: { id: 'pop-title' } });
    const list = h('ul', { className: 'problems' }, problems.messages.map((m) => h('li', { text: m })));
    const more = problems.count > problems.messages.length ? h('p', { className: 'hint', text: `And ${problems.count - problems.messages.length} more.` }) : null;
    const fixes = h(DIV, { className: 'fixes', attrs: { role: 'group', [ARIA_LABEL]: 'Quick fixes', 'aria-live': 'polite' } }, [
      h('p', { className: 'hint', text: 'Looking for quick fixes…' }),
    ]);
    const actions = h(DIV, { className: 'actions' }, [
      button('Edit source', () => {
        closeProblems(false);
        startEdit(item);
      }),
      button('Close', () => closeProblems(true)),
    ]);
    pop.replaceChildren(title, list, ...(more ? [more] : []), fixes, actions);
    const requestId = ++fixRequests;
    problemsTarget = { item, key: view.key, requestId, fixes };
    placePop(item);
    actions.querySelector('button')?.focus();
    rt.announce(`${problemsLabel(problems)}: ${problems.messages.join('. ')}`);
    post({ type: 'getFixes', key: view.key, requestId });
  }

  /** The quick fixes arrived: one button each, or why there are none. */
  function onFixes(msg: FixesMessage): void {
    const target = problemsTarget;
    if (target?.requestId !== msg.requestId) return;
    target.version = msg.version;
    target.list = msg.fixes;
    if (!msg.fixes.length) {
      target.fixes.replaceChildren(h('p', { className: 'hint', text: msg.error ?? 'No quick fixes for these problems.' }));
      return;
    }
    const buttons = msg.fixes.map((fix, index) => button(fixLabel(fix), () => applyFix(index, false), { title: fix.title }));
    target.fixes.replaceChildren(h('p', { className: 'fixes-title', text: 'Quick fixes' }), h(DIV, { className: 'fix-list' }, buttons));
    rt.announce(fixesAnnouncement(msg.fixes));
  }

  function applyFix(index: number, confirm: boolean): void {
    const target = problemsTarget;
    if (!target || target.version === undefined) return;
    target.editId = nextId();
    post({ type: 'applyFix', key: target.key, index, version: target.version, ...(confirm ? { confirm: true } : {}), editId: target.editId });
  }

  /** The extension asks before a fix that changes more than the block: Apply or Cancel, in the list. */
  function onConfirmFix(editId: string | undefined, index: number, text: string): void {
    const target = problemsTarget;
    if (!target || target.editId !== editId) return;
    const title = target.list?.[index]?.title ?? 'This fix';
    const apply = button('Apply anyway', () => applyFix(index, true));
    const cancel = button('Cancel', () => closeProblems(true));
    target.fixes.replaceChildren(h('p', { className: 'confirm', text: `${title}: ${text} Apply it?` }), h(DIV, { className: 'actions' }, [apply, cancel]));
    apply.focus();
    rt.announce(`${text} Apply it?`);
  }

  /** A fix was not applied (the document changed since it was listed): the list asks for the fixes again. */
  function fixRefused(editId: string): void {
    const target = problemsTarget;
    if (!target || target.editId !== editId) return;
    target.editId = undefined;
    target.version = undefined;
    target.requestId = ++fixRequests;
    target.fixes.replaceChildren(h('p', { className: 'hint', text: 'Looking for quick fixes…' }));
    post({ type: 'getFixes', key: target.key, requestId: target.requestId });
  }

  /** A fix was applied: the list closes, and focus goes back to the block once it is rendered again. */
  function fixApplied(editId: string): boolean {
    const target = problemsTarget;
    if (!target || target.editId !== editId) return false;
    closeProblems(false);
    rt.announce('Quick fix applied. Ctrl+Z undoes it.');
    return true;
  }

  function closeProblems(refocus: boolean): void {
    const target = problemsTarget;
    if (!target) return;
    problemsTarget = null;
    popHost.hidden = true;
    pop.replaceChildren();
    if (!refocus) return;
    const item = target.item.isConnected ? target.item : itemsAll().find((i) => i.dataset.smdEdKey === target.key);
    (item ?? currentItem())?.focus();
  }

  updateToolbar();
  post({ type: 'ready' });
}
