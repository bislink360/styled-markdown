// The Block Editor page (Styled Markdown Block Editor (Preview)). It shows the blocks the extension rendered, lets
// the user edit one block's source at a time, and sends requests by block key; the extension decides what changes
// in the document (see blockEditorSession.ts). Runs after media/runtime.js, whose window.smdRuntime gives the page's
// one VS Code handle, hydrate(scope), announce() and saved state.
//
// The document's rendered HTML goes into the page as in the preview. The editor's own controls (toolbar, menus,
// forms, the source editor, notices, problem badges) live in closed shadow roots and are built with createElement
// and textContent only.
import type { BlockView, FocusRequest, FormField, FrontMatterView, HostMessage, RenderMessage } from '../blockEditorSession';
import {
  FROZEN, blockLabel, desiredOrder, editLabel, findView, followEdit, formRequest, isUndoRedo, itemForLine, listKeyTarget, orderMoves,
  problemsLabel, shiftLine, textareaRows, toolbarKeyTarget, topRange, typeAhead, withoutLines, type LineRange,
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

type ItemView = Pick<BlockView, 'key' | 'type' | 'container' | 'start' | 'end' | 'source' | 'problems' | 'form' | 'children'>;
type Action = 'insert' | 'edit' | 'props' | 'up' | 'down' | 'del' | 'reveal' | 'fm';

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
const ARIA_EXPANDED = 'aria-expanded';
const ARIA_DISABLED = 'aria-disabled';
const ARIA_LABEL = 'aria-label';
const TABINDEX = 'tabindex';
const INTERACTIVE = 'a[href], button, input, select, textarea, summary, label, [role="tab"], audio, video, iframe, [contenteditable], .smd-ed-editor';

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
  const badges = new WeakMap<HTMLElement, { host: HTMLElement; span: HTMLElement }>();
  let fmNode: HTMLElement | null = null;
  let currentKey: string | null = null;
  let currentLine = 0;
  let editing: Editing | null = null;
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

  /** The problem count badge of a top-level block (in a shadow root; its text is also in the block's label). */
  function updateBadge(node: HTMLElement, view: ItemView): void {
    let badge = badges.get(node);
    if (!view.problems) {
      if (badge) badge.host.hidden = true;
      return;
    }
    if (!badge) {
      const host = h(DIV, { className: 'smd-ed-badge-host' });
      const span = h('span', { className: 'badge', attrs: { 'aria-hidden': TRUE } });
      chromeRoot(host).append(span);
      badge = { host, span };
      badges.set(node, badge);
      node.prepend(host);
    }
    badge.host.hidden = false;
    badge.span.textContent = `⚠ ${view.problems.count}`;
    badge.span.className = `badge ${view.problems.severity}`;
    badge.span.title = view.problems.messages.join('\n');
  }

  function decorateTop(node: HTMLElement, view: ItemView): void {
    markItem(node, view);
    node.setAttribute('role', 'group');
    node.setAttribute('aria-roledescription', 'block');
    const problems = problemsLabel(view.problems);
    node.setAttribute(ARIA_LABEL, problems ? `${blockLabel(view)}, ${problems}` : blockLabel(view));
    if (view.problems) node.setAttribute('aria-description', view.problems.messages.join('; '));
    else node.removeAttribute('aria-description');
    updateBadge(node, view);
  }

  /** Mark a container's children (found in its HTML by their first line) as items of their own. */
  function annotateChildren(scope: HTMLElement, children: readonly BlockView[] | undefined): void {
    for (const child of children ?? []) {
      if (child.kind !== 'block') continue;
      const el = scope.querySelector<HTMLElement>(`[data-line="${child.start}"]`);
      if (el && !el.classList.contains(ITEM)) {
        markItem(el, child);
        el.classList.add(CHILD);
      }
      annotateChildren(el ?? scope, child.children);
    }
  }

  function clearChildren(node: HTMLElement): void {
    node.querySelectorAll<HTMLElement>(`.${CHILD}`).forEach((el) => {
      el.classList.remove(ITEM, CHILD);
      delete el.dataset.smdEdKey;
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
    decorateTop(node, view);
    annotateChildren(content, view.children);
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
    const old = known === editing?.top ? undefined : known;
    if (view.blank) return blankGap(view, old);
    const sig = signatureOf(view);
    if (old && signature.get(old) === sig && old.classList.contains(ITEM)) {
      const content = old.querySelector<HTMLElement>(`:scope > .${CONTENT}`) ?? old;
      shiftLines(content, view.start - startOf(old));
      clearChildren(content);
      decorateTop(old, view);
      annotateChildren(content, view.children);
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
    const frozenNode = editing && editing.top !== fmNode ? editing.top : null;
    const frozen = frozenNode && editing ? topRange(msg.blocks, editing.range) : null;
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
    if (editing) {
      // The block being edited stays current (its own element is hidden behind the editor).
      currentKey = editing.key;
      currentLine = editing.range.start;
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

  const currentItem = (): HTMLElement | undefined => editing?.item ?? itemsAll().find((i) => i.dataset.smdEdKey === currentKey);
  /** The current block; while one is edited, that one, with its key and lines as they are now. */
  const currentView = (): ItemView | undefined => {
    if (editing) {
      const view = viewOf.get(editing.item);
      return view && { ...view, key: editing.key, start: editing.range.start, end: editing.range.end };
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
    const item = list[itemForLine(list.map(startOf), focus.line)];
    setCurrent(item, true);
    if (focus.edit) startEdit(item, { select: focus.select });
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
    if (!editing) return target;
    const key = target.dataset.smdEdKey;
    finishEdit(false);
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
    document.documentElement.setAttribute('data-smd-theme-pref', msg.themePref);
    if (editing) {
      const followed = followEdit(msg, editing.key, editing.range);
      editing.key = followed.key;
      editing.range = followed.range;
    }
    const active = document.activeElement;
    const hadFocus = !active || active === document.body || rootEl.contains(active);
    renderAll(msg);
    // A block that had focus and was rendered again: focus goes to the block now in its place.
    if (hadFocus && !editing && !rootEl.contains(document.activeElement)) currentItem()?.focus();
    if (!restored) restore();
    applyPendingFocus();
  }

  function onAck(editId: string, version: number, focus: FocusRequest | undefined): void {
    acked = Math.max(acked, version);
    closedDrafts.delete(editId);
    if (editing?.pending.delete(editId)) editing.acked = Math.max(editing.acked, version);
    if (focus) pendingFocus = { version, focus };
    applyPendingFocus();
  }

  function onConflict(editId: string, currentText: string | null): void {
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
    post({ type: 'flushed', requestId });
  }

  window.addEventListener('message', (event: MessageEvent) => {
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
        break;
      case 'flush':
        onFlush(msg.requestId);
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
      startEdit(item);
      return true;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    const list = items();
    const to = listKeyTarget(event.key, list.indexOf(item), list.length);
    if (to < 0) return false;
    setCurrent(list[to], true);
    if (list[to].classList.contains(CHILD)) rt.announce(blockLabel(viewOf.get(list[to])!));
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
    const item = target.closest<HTMLElement>(`.${ITEM}`);
    if (item && editing?.item !== item) {
      setCurrent(item, false);
      startEdit(item);
    }
  });

  document.addEventListener(KEYDOWN, (event) => {
    if (event.key === '/' && (event.ctrlKey || event.metaKey) && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      openMenu(currentItem() ?? null);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && editing) commit(editing);
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
      default:
        blockAction(action);
    }
  }

  /** An action on the current block. */
  function blockAction(action: 'edit' | 'up' | 'down' | 'del' | 'reveal'): void {
    const view = currentView();
    if (!view) return;
    if (editing) finishEdit(false);
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
    edit: button('Edit', () => act('edit'), { title: 'Edit the source of this block (Enter)' }),
    props: button('Properties', () => act('props'), { title: 'Title and attributes of this container', [ARIA_EXPANDED]: FALSE, 'aria-controls': 'props' }),
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
    buttons.fm.hidden = !model || model.frontMatter !== null;
    rovingBar();
    if (!props.hidden) fillProps();
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
    const input = h('input', { attrs: { id, type: field.kind === 'flag' ? 'checkbox' : 'text' } });
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
    const focused = (barRoot.activeElement as HTMLElement | null)?.closest('.field')?.getAttribute('data-field');
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

  updateToolbar();
  post({ type: 'ready' });
}
