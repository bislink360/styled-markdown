import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';

// The page runtime (media/runtime.js) as the Block Editor uses it: one handle, a mode, and hydrate(scope) for one
// block at a time, which must leave the tab and <details> state of the rest of the page alone.

const runtimePath = join(__dirname, '..', 'media', 'runtime.js');
const source = readFileSync(runtimePath, 'utf8');
const { carryState } = createRequire(__filename)(runtimePath);

// ---------------------------------------------------------------------------
// The pure part (exported when there is no DOM)
// ---------------------------------------------------------------------------

test('carryState keeps the state of keys still in the page and drops the rest, as the preview did', () => {
  assert.deepEqual(carryState({ 'a#0': 1, 'gone#0': 2 }, ['a#0', 'b#0'], [null, null]), { 'a#0': 1 });
  assert.deepEqual(carryState({}, ['a#0'], [null]), {});
});

test('carryState lets an element outside the scope take its state to its new key', () => {
  // An identical group appeared in a block above: the one left alone went from #0 to #1 and keeps its state; the
  // new one, now #0, does not inherit it.
  assert.deepEqual(carryState({ 'tabs:a#0': 2 }, ['tabs:a#0', 'tabs:a#1'], [null, 'tabs:a#0']), { 'tabs:a#1': 2 });
  // A block above lost one: #1 becomes #0, and the state of the old #0 is gone with it.
  assert.deepEqual(carryState({ 'd#0': 'removed', 'd#1': 'kept' }, ['d#0'], ['d#1']), { 'd#0': 'kept' });
  // Left alone and not moved; being hydrated, an element picks up what was saved under its key.
  assert.deepEqual(carryState({ 'x#0': [false, true], 'y#0': [true, false] }, ['x#0', 'y#0'], ['x#0', null]), { 'x#0': [false, true], 'y#0': [true, false] });
});

// ---------------------------------------------------------------------------
// A small DOM for the runtime
// ---------------------------------------------------------------------------

interface FakeEvent { target: FakeEl; key?: string; preventDefault(): void }
type Listener = (e: FakeEvent) => void;

const SIMPLE = /^([a-z]+)?(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/;

class FakeEl {
  id = '';
  type = '';
  textContent = '';
  open = false;
  parent: FakeEl | null = null;
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, Listener[]>();
  readonly classList = {
    add: (c: string) => { this.classes.add(c); },
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on: boolean) => { if (on) this.classes.add(c); else this.classes.delete(c); },
  };

  constructor(readonly tag: string, className = '') { this.className = className; }

  get className(): string { return [...this.classes].join(' '); }
  set className(value: string) {
    this.classes.clear();
    value.split(' ').filter(Boolean).forEach((c) => this.classes.add(c));
  }
  setAttribute(name: string, value: string): void { this.attrs.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  appendChild(child: FakeEl): FakeEl { return this.insertBefore(child, null); }
  insertBefore(child: FakeEl, before: FakeEl | null): FakeEl {
    const at = before ? this.children.indexOf(before) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
    child.parent = this;
    return child;
  }
  append(...children: FakeEl[]): this {
    children.forEach((c) => this.appendChild(c));
    return this;
  }
  replaceChildren(...children: FakeEl[]): void {
    this.children.splice(0).forEach((c) => { c.parent = null; });
    this.append(...children);
  }
  get firstChild(): FakeEl | null { return this.children[0] ?? null; }
  contains(el: FakeEl | null): boolean {
    for (let node = el; node; node = node.parent) if (node === this) return true;
    return false;
  }
  /** Simple selectors only (`tag.class[attr]`); anything else matches nothing. */
  matches(selector: string): boolean {
    const m = SIMPLE.exec(selector);
    if (!m) return false;
    const [, tag, cls, attr] = m;
    return (!tag || this.tag === tag) && (!cls || this.classes.has(cls)) && (!attr || this.attrs.has(attr));
  }
  closest(selector: string): FakeEl | null {
    for (let node: FakeEl | null = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
  descendants(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelectorAll(selector: string): FakeEl[] {
    const parts = selector.split(',').map((s) => s.trim());
    return this.descendants().filter((el) => parts.some((p) => el.matches(p)));
  }
  querySelector(selector: string): FakeEl | null {
    if (selector === ':scope > summary') return this.children.find((c) => c.tag === 'summary') ?? null;
    return this.querySelectorAll(selector)[0] ?? null;
  }
  addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  dispatch(type: string, init: Partial<FakeEvent> = {}): void {
    const event: FakeEvent = { target: this, ...init, preventDefault: () => undefined };
    (this.listeners.get(type) ?? []).forEach((fn) => fn(event));
  }
  focus(): void { /* focus is not checked here */ }
}

interface Message { type: string; [key: string]: unknown }
interface Runtime {
  mode: string;
  vscode: unknown;
  hydrate(scope?: FakeEl): Promise<void>;
  announce(text: string): void;
  appState(): unknown;
  saveAppState(value: unknown): void;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Load the runtime in a page whose body holds `content`, as VS Code would with the state it kept. */
function page(content: FakeEl[], mode?: string, state?: unknown) {
  const html = new FakeEl('html');
  const body = html.appendChild(new FakeEl('body')).append(...content);
  if (mode) body.dataset.smdMode = mode;
  const listeners = new Map<string, Listener[]>();
  const windowListeners = new Map<string, unknown[]>();
  const document = {
    documentElement: html,
    body,
    createElement: (tag: string) => new FakeEl(tag),
    getElementById: (id: string) => html.descendants().find((el) => el.id === id) ?? null,
    querySelectorAll: (selector: string) => html.querySelectorAll(selector),
    addEventListener: (type: string, fn: Listener) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
  };
  const window: Record<string, unknown> = {
    scrollY: 0,
    innerWidth: 800,
    innerHeight: 600,
    scrollTo: () => undefined,
    addEventListener: (type: string, fn: unknown) => { windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]); },
  };
  const posted: Message[] = [];
  const states: unknown[] = [];
  let acquired = 0;
  const api = {
    getState: () => state,
    setState: (s: unknown) => { states.push(JSON.parse(JSON.stringify(s))); },
    postMessage: (m: Message) => { posted.push(JSON.parse(JSON.stringify(m))); },
  };
  class MutationObserver { observe(): void { /* the theme doesn't change here */ } }
  vm.runInNewContext(source, {
    window, document, MutationObserver, setTimeout, clearTimeout,
    acquireVsCodeApi: () => { acquired++; return api; },
  });
  return {
    api, body, posted, states, windowListeners,
    acquired: () => acquired,
    runtime: window.smdRuntime as Runtime,
    /** A DOM event reaching the document's listeners (the runtime listens there for clicks and toggles). */
    fire: (type: string, target: FakeEl) => (listeners.get(type) ?? []).forEach((fn) => fn({ target, preventDefault: () => undefined })),
    /** The reader opens or closes a <details>. */
    toggle(d: FakeEl, open: boolean) {
      d.open = open;
      this.fire('toggle', d);
    },
  };
}

function tabGroup(...titles: string[]): FakeEl {
  const tabs = new FakeEl('div', 'smd-tabs');
  for (const title of titles) {
    const pane = tabs.appendChild(new FakeEl('section', 'smd-tab'));
    pane.setAttribute('data-title', title);
  }
  return tabs;
}

function details(summary: string): FakeEl {
  const d = new FakeEl('details');
  d.appendChild(new FakeEl('summary')).textContent = summary;
  return d;
}

const block = (...children: FakeEl[]) => new FakeEl('div', 'block').append(...children);
const tabButtons = (tabs: FakeEl) => tabs.children[0].children;
const selectedTab = (tabs: FakeEl) => tabButtons(tabs).findIndex((b) => b.getAttribute('aria-selected') === 'true');
const NPM = 'tabs:npm\u0001pnpm';

// ---------------------------------------------------------------------------
// hydrate(scope)
// ---------------------------------------------------------------------------

test('hydrating one block keeps the tab and details state of the others', async () => {
  const a = block(tabGroup('npm', 'pnpm'), details('Why'));
  const b = block(tabGroup('npm', 'pnpm'), details('Why'));
  const p = page([a, b], 'block-editor');
  const [tabsB, detailsB] = b.children;
  tabButtons(tabsB)[1].dispatch('click');
  p.toggle(detailsB, true);
  p.toggle(a.children[1], true);
  assert.deepEqual(p.states.at(-1), {
    tabs: { [`${NPM}#1`]: 1 },
    open: { 'details:Why#0': [false, true], 'details:Why#1': [false, true] },
  });

  // Block A is rendered again after an edit and hydrated on its own.
  const tabsA = tabGroup('npm', 'pnpm');
  const detailsA = details('Why');
  a.replaceChildren(tabsA, detailsA);
  await p.runtime.hydrate(a);
  assert.equal(detailsA.open, true, 'block A comes back as the reader left it');
  assert.equal(selectedTab(tabsA), 0);
  assert.equal(selectedTab(tabsB), 1, 'block B is untouched');
  assert.equal(detailsB.open, true);

  // The next save still holds block B's state.
  tabButtons(tabsA)[1].dispatch('click');
  assert.deepEqual(p.states.at(-1), {
    tabs: { [`${NPM}#0`]: 1, [`${NPM}#1`]: 1 },
    open: { 'details:Why#0': [false, true], 'details:Why#1': [false, true] },
  });
});

test('state outside the scope follows its element when the keys move', async () => {
  const a = block(details('Why'));
  const b = block(details('Why'), tabGroup('npm', 'pnpm'));
  const p = page([a, b], 'block-editor');
  const [detailsB, tabsB] = b.children;
  p.toggle(detailsB, true);
  tabButtons(tabsB)[1].dispatch('click');
  assert.deepEqual(p.states.at(-1), { tabs: { [`${NPM}#0`]: 1 }, open: { 'details:Why#1': [false, true] } });

  // Block A now has two "Why" details, so block B's becomes the third (#2).
  const first = details('Why');
  const second = details('Why');
  a.replaceChildren(first, second);
  await p.runtime.hydrate(a);
  assert.deepEqual([first.open, second.open], [false, false], 'the new one at #1 does not take block B\'s state');
  assert.equal(detailsB.getAttribute('data-smd-key'), 'details:Why#2');
  assert.equal(detailsB.open, true);
  tabButtons(tabsB)[0].dispatch('click');
  assert.deepEqual(p.states.at(-1), { tabs: { [`${NPM}#0`]: 0 }, open: { 'details:Why#2': [false, true] } });
  // Closing it again clears its state under the new key.
  p.toggle(detailsB, false);
  assert.deepEqual(p.states.at(-1), { tabs: { [`${NPM}#0`]: 0 }, open: {} });

  // Hydrating the whole page drops the state of what is gone, as before.
  b.replaceChildren();
  await p.runtime.hydrate();
  p.toggle(first, true);
  assert.deepEqual(p.states.at(-1), { tabs: {}, open: { 'details:Why#0': [false, true] } });
});

test('a reloaded Block Editor page restores tabs and details and keeps the app state with the runtime\'s', async () => {
  const tabs = tabGroup('npm', 'pnpm');
  const d = details('Why');
  const saved = { tabs: { [`${NPM}#0`]: 1 }, open: { 'details:Why#0': [false, true] }, app: { drafts: ['x'] } };
  const p = page([block(tabs, d)], 'block-editor', saved);
  assert.equal(selectedTab(tabs), 1);
  assert.equal(d.open, true);
  assert.deepEqual(p.runtime.appState(), { drafts: ['x'] });
  p.runtime.saveAppState({ drafts: [] });
  assert.deepEqual(p.states.at(-1), { tabs: { [`${NPM}#0`]: 1 }, open: { 'details:Why#0': [false, true] }, app: { drafts: [] } });
  tabButtons(tabs)[0].dispatch('click');
  assert.deepEqual(p.states.at(-1), { tabs: { [`${NPM}#0`]: 0 }, open: { 'details:Why#0': [false, true] }, app: { drafts: [] } }, 'the app state stays');
  await flush();
  assert.equal(p.posted.some((m) => m.type === 'position'), false, 'no scroll place in the Block Editor');
});

// ---------------------------------------------------------------------------
// Mode and handle
// ---------------------------------------------------------------------------

function lineAndTask() {
  const line = new FakeEl('p');
  line.setAttribute('data-line', '3');
  const box = new FakeEl('input', 'smd-task-box');
  box.setAttribute('data-task-line', '5');
  return { line, box };
}

test('the Block Editor mode leaves out the preview\'s scroll, reveal and render wiring', async () => {
  const { line, box } = lineAndTask();
  const p = page([line, box], 'block-editor');
  assert.equal(p.runtime.mode, 'block-editor');
  assert.equal(p.acquired(), 1, 'acquireVsCodeApi() is called once');
  assert.equal(p.runtime.vscode, p.api, 'and its handle is shared');
  assert.ok(Object.isFrozen(p.runtime));
  await flush();
  p.fire('dblclick', line);
  p.fire('click', box);
  assert.deepEqual(p.posted, [{ type: 'toggleTask', line: 5 }], 'no ready, rendered, position or revealLine');
  assert.equal(p.windowListeners.get('message'), undefined, 'no renders or scroll sync from the extension');
  assert.equal(p.windowListeners.get('scroll'), undefined);
  assert.equal(p.windowListeners.get('resize')?.length, 1, 'only the wide-block check, not the scroll restore');
});

test('without data-smd-mode the page is the preview, wired as before', async () => {
  const { line, box } = lineAndTask();
  const tabs = tabGroup('npm', 'pnpm');
  const p = page([line, box, tabs]);
  assert.equal(p.runtime.mode, 'preview');
  assert.equal(p.acquired(), 1);
  await flush();
  p.fire('dblclick', line);
  p.fire('click', box);
  tabButtons(tabs)[1].dispatch('click');
  const types = p.posted.map((m) => m.type);
  for (const type of ['ready', 'rendered', 'revealLine', 'toggleTask', 'position']) assert.ok(types.includes(type), type);
  assert.deepEqual(p.states.at(-1), { anchor: null, version: 0, tabs: { [`${NPM}#0`]: 1 }, open: {} }, 'the preview\'s state, unchanged');
  for (const type of ['message', 'scroll']) assert.equal(p.windowListeners.get(type)?.length, 1, type);
});

test('announce() works before any copy button made a live region', async () => {
  const p = page([], 'block-editor');
  p.runtime.announce('Block moved');
  const region = p.body.children.find((el) => el.getAttribute('role') === 'status');
  assert.ok(region, 'a polite status region');
  assert.equal(region.className, 'smd-sr-only');
  await wait(80);
  assert.equal(region.textContent, 'Block moved');
});
