// The preview keeps its place (the source line at the top of the viewport) when its webview is torn down
// and reloaded. These tests run the real extension side (src/preview.ts, against a small fake of the `vscode`
// module) and the real page (media/runtime.js, in a fake DOM) through every order in which the webview can go
// away and come back, the document can change and the debounced refresh can fire, without VS Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { MAX_EDITS, PreviewSync, readPosition } from '../src/previewSync';

const runtimePath = join(__dirname, '..', 'media', 'runtime.js');
const runtime = new vm.Script(readFileSync(runtimePath, 'utf8'), { filename: runtimePath });
const { mapAnchor, newerPlace } = createRequire(__filename)(runtimePath);

// ---------------------------------------------------------------------------
// The pure parts
// ---------------------------------------------------------------------------

test('mapAnchor applies the edits made after the version an anchor was measured in', () => {
  const sync = { since: 3, edits: [[4, 0, 0, 2], [6, 10, 12, 0], [7, 0, 0, 1]] };
  const at = (line: number) => ({ line, offset: 5 });
  assert.deepEqual(mapAnchor(at(20), 3, 7, sync), at(21), 'all three: +2, -2, +1');
  assert.deepEqual(mapAnchor(at(20), 4, 7, sync), at(19), 'the anchor already includes the edit of version 4');
  assert.deepEqual(mapAnchor(at(20), 3, 5, sync), at(22), 'the page only shows version 5');
  assert.deepEqual(mapAnchor(at(20), 7, 7, sync), at(20), 'nothing happened since');
  assert.deepEqual(mapAnchor(at(20), 9, 7, sync), at(20), 'an anchor newer than the page waits for its render');
  assert.deepEqual(mapAnchor(at(20), 2, 7, sync), at(20), 'older than the edits known: left as it is, not half mapped');
  assert.deepEqual(mapAnchor(at(20), undefined, 7, sync), at(20));
  assert.deepEqual(mapAnchor(at(20), 3, 7, undefined), at(20), 'no versions, as in the playground');
  assert.equal(mapAnchor(null, 3, 7, sync), null, 'the top of the page stays the top');
});

test('newerPlace prefers the place saved in the later version, and the page\'s own on a tie', () => {
  const mine = { anchor: { line: 4, offset: 0 }, version: 5 };
  const host = { anchor: { line: 9, offset: 0 }, version: 5 };
  assert.equal(newerPlace(mine, host), mine);
  assert.equal(newerPlace(mine, { ...host, version: 6 }).version, 6);
  assert.equal(newerPlace(null, host), host);
  assert.equal(newerPlace(mine, undefined), mine);
  assert.equal(newerPlace(null, undefined), null);
});

test('PreviewSync keeps line edits until the page has saved a place that includes them', () => {
  const sync = new PreviewSync(1);
  sync.record(2, [{ startLine: 0, endLine: 0, text: 'a\n\n' }]);
  sync.record(3, [{ startLine: 5, endLine: 5, text: 'x' }]); // within a line: moves nothing
  sync.record(4, [{ startLine: 3, endLine: 6, text: '' }]);
  assert.deepEqual(sync.snapshot(4), { version: 4, since: 1, edits: [[2, 0, 0, 2], [4, 3, 6, 0]], position: undefined });
  // Sending them does not drop them: the message may never arrive.
  assert.equal(sync.snapshot(4).edits.length, 2);

  const place = { anchor: { line: 10, offset: 3 }, version: 2 };
  sync.confirm(place);
  assert.deepEqual(sync.snapshot(4), { version: 4, since: 2, edits: [[4, 3, 6, 0]], position: place });
  // A place from before the known edits (a page reloaded from an old copy) doesn't bring them back.
  sync.confirm({ anchor: null, version: 1 });
  assert.deepEqual(sync.snapshot(4), { version: 4, since: 2, edits: [[4, 3, 6, 0]], position: { anchor: null, version: 1 } });
});

test('PreviewSync gives up on mapping, not on restoring, after too many edits', () => {
  const sync = new PreviewSync(0);
  for (let v = 1; v <= MAX_EDITS + 1; v++) sync.record(v, [{ startLine: 0, endLine: 0, text: '\n' }]);
  assert.deepEqual(sync.snapshot(MAX_EDITS + 1), { version: MAX_EDITS + 1, since: MAX_EDITS + 1, edits: [], position: undefined });
  sync.record(MAX_EDITS + 2, [{ startLine: 0, endLine: 0, text: '\n' }]);
  const snapshot = sync.snapshot(MAX_EDITS + 2);
  assert.deepEqual(snapshot.edits, [[MAX_EDITS + 2, 0, 0, 1]]);
  // The page leaves a place from before `since` alone instead of applying only the last edit to it.
  assert.deepEqual(mapAnchor({ line: 7, offset: 0 }, 5, MAX_EDITS + 2, snapshot), { line: 7, offset: 0 });
  assert.deepEqual(mapAnchor({ line: 7, offset: 0 }, MAX_EDITS + 1, MAX_EDITS + 2, snapshot), { line: 8, offset: 0 });
});

test('readPosition accepts what the page sends and nothing else', () => {
  assert.deepEqual(readPosition({ type: 'position', anchor: { line: 3, offset: 1.5 }, version: 4 }), { anchor: { line: 3, offset: 1.5 }, version: 4 });
  assert.deepEqual(readPosition({ anchor: null, version: 4 }), { anchor: null, version: 4 });
  assert.equal(readPosition({ anchor: { line: 3, offset: 0 } }), undefined);
  assert.equal(readPosition({ anchor: { line: '3', offset: 0 }, version: 4 }), undefined);
  assert.equal(readPosition({ anchor: 7, version: 4 }), undefined);
  assert.equal(readPosition({ anchor: { line: -1, offset: 0 }, version: 4 }), undefined);
});

// ---------------------------------------------------------------------------
// A fake of the `vscode` module: just what src/preview.ts uses
// ---------------------------------------------------------------------------

type Fn<T> = (e: T) => unknown;
interface Emitter<T> { on(fn: Fn<T>): { dispose(): void }; fire(e: T): void }
function emitter<T>(): Emitter<T> {
  const fns: Array<Fn<T>> = [];
  return {
    on: (fn) => { fns.push(fn); return { dispose: () => undefined }; },
    fire: (e) => fns.forEach((fn) => fn(e)),
  };
}

interface FakeUri { scheme: string; fsPath: string; toString(): string }
const uri = (fsPath: string): FakeUri => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath.replaceAll('\\', '/')}` });

/** The world of one scenario: its document, its webview and what the fake `vscode` module hands out. */
let world: World;

const fakeVscode = {
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  Uri: { file: uri, joinPath: (base: FakeUri, ...parts: string[]) => uri(join(base.fsPath, ...parts)) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback }),
    onDidChangeTextDocument: (fn: Fn<unknown>) => world.documentChanged.on(fn),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    onDidSaveTextDocument: () => ({ dispose: () => undefined }),
  },
  window: {
    onDidChangeTextEditorVisibleRanges: () => ({ dispose: () => undefined }),
    createWebviewPanel: () => world.webview.panel,
  },
};

// src/preview.ts imports `vscode`, which only exists inside VS Code: hand it the fake while it loads.
type Loader = (request: string, ...rest: unknown[]) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? fakeVscode : realLoad.call(this, request, ...rest);
};
const { PreviewManager } = createRequire(__filename)('../src/preview') as typeof import('../src/preview');
loader._load = realLoad;

// ---------------------------------------------------------------------------
// A fake page: the DOM media/runtime.js needs, with one line of source every LINE pixels
// ---------------------------------------------------------------------------

const LINE = 20;
const VIEWPORT = 600;
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const unescapeHtml = (s: string) => s.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

class FakePage {
  scrollY = 0;
  rootHtml = '';
  private lines: number[] = [];
  private readonly listeners = new Map<string, Array<Fn<unknown>>>();

  constructor(private readonly webview: Webview, html: string, public hasLayout: boolean) {
    const main = /<main id="smd-root"([^>]*)>([\s\S]*)<\/main>/.exec(html);
    assert.ok(main, 'the page has a root');
    const attrs = new Map(Array.from(main[1].matchAll(/ ([\w-]+)="([^"]*)"/g), (m) => [m[1], unescapeHtml(m[2])]));
    this.setRoot(main[2]);
    const page = this;
    const htmlAttrs = new Map<string, string>();
    const root = {
      dataset: Object.fromEntries(Array.from(attrs, ([name, value]) => [name.replace(/^data-/, '').replaceAll(/-(\w)/g, (_, c: string) => c.toUpperCase()), value])),
      getAttribute: (name: string) => attrs.get(name) ?? null,
      querySelectorAll: () => [],
      get innerHTML() { return page.rootHtml; },
      set innerHTML(value: string) { page.setRoot(value); },
    };
    const lineElement = (line: number) => ({
      getAttribute: () => String(line),
      getClientRects: () => (page.hasLayout ? [{}] : []),
      getBoundingClientRect: () => ({ top: (page.hasLayout ? line * LINE : 0) - page.scrollY }),
    });
    const document = {
      documentElement: { getAttribute: (n: string) => htmlAttrs.get(n) ?? null, setAttribute: (n: string, v: string) => { htmlAttrs.set(n, String(v)); } },
      body: { classList: { contains: () => false } },
      getElementById: (id: string) => (id === 'smd-root' ? root : null),
      addEventListener: () => undefined,
      querySelectorAll: (selector: string) => (selector === '#smd-root [data-line]' ? page.lines.map(lineElement) : []),
    };
    const window = {
      get scrollY() { return page.scrollY; },
      get innerWidth() { return page.hasLayout ? 800 : 0; },
      get innerHeight() { return page.hasLayout ? VIEWPORT : 0; },
      scrollTo: (to: { top: number }) => page.scrollTo(to.top),
      addEventListener: (type: string, fn: Fn<unknown>) => { page.listeners.set(type, [...(page.listeners.get(type) ?? []), fn]); },
    };
    class MutationObserver { observe(): void { /* the theme doesn't change here */ } }
    const api = {
      getState: () => clone(webview.state),
      setState: (state: unknown) => webview.fromPage(page, { state: clone(state) }),
      postMessage: (message: unknown) => webview.fromPage(page, { message: clone(message) }),
    };
    runtime.runInContext(vm.createContext({
      window, document, MutationObserver, acquireVsCodeApi: () => api,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
    }));
  }

  private setRoot(html: string): void {
    this.rootHtml = html;
    this.lines = Array.from(html.matchAll(/ data-line="(\d+)"/g), (m) => Number(m[1]));
    this.scrollTo(this.scrollY);
  }

  /** As a browser does it: nowhere to go without layout, clamped to the document, and a scroll event when it moved. */
  scrollTo(top: number): void {
    if (!this.hasLayout) return;
    const y = Math.min(Math.max(Number.isFinite(top) ? top : 0, 0), (Math.max(0, ...this.lines) + 1) * LINE);
    if (y === this.scrollY) return;
    this.scrollY = y;
    this.fire('scroll');
  }

  fire(type: string, event?: unknown): void {
    (this.listeners.get(type) ?? []).forEach((fn) => fn(event));
  }

  /** The frame is displayed at last: it gets its size, and the page a layout. */
  display(): void {
    this.hasLayout = true;
    this.fire('resize');
  }

  /** The source line at the top of the viewport and how far into it the viewport starts. */
  top(): { line: number; offset: number } {
    const line = Math.max(...this.lines.filter((l) => l * LINE <= this.scrollY + 1));
    return { line, offset: this.scrollY - line * LINE };
  }
}

// ---------------------------------------------------------------------------
// A fake webview panel, as VS Code runs one that does not keep its context when hidden
// ---------------------------------------------------------------------------

/** Loading: the webview exists, but the page's script has not run yet, so nothing is listening. */
type Loaded = FakePage | 'loading' | null;

class Webview {
  html = '';
  /** What the page saved with setState(): kept by VS Code while there is no page. */
  state: unknown;
  page: Loaded = null;
  /** Whether a frame is displayed (so has layout) when its page loads. */
  displayed = true;
  /** In "late" mode a message to the page arrives one step after it was sent: lost if the page is gone by then. */
  late = false;
  /** Set while a page that was loaded reloads because its HTML was replaced. */
  private reloading = false;
  private toPage: Array<{ to: Loaded; message: unknown }> = [];
  private inFlight: Array<{ to: Loaded; message: unknown }> = [];
  private fromPages: Array<{ from: FakePage; state?: unknown; message?: unknown }> = [];
  private readonly received = emitter<unknown>();
  private readonly viewState = emitter<unknown>();
  readonly panel: Record<string, unknown>;

  constructor() {
    const webview = this;
    this.panel = {
      visible: true,
      webview: {
        cspSource: 'vscode-resource:',
        asWebviewUri: (u: FakeUri) => `vscode-resource:${u.fsPath.replaceAll('\\', '/')}`,
        get html() { return webview.html; },
        // Setting the HTML of a webview that exists reloads it; a hidden one only remembers it.
        set html(value: string) { webview.replaceHtml(value); },
        postMessage: (message: unknown) => {
          if (webview.page) webview.toPage.push({ to: webview.page, message: clone(message) });
          return Promise.resolve(!!webview.page);
        },
        onDidReceiveMessage: (fn: Fn<unknown>) => webview.received.on(fn),
      },
      onDidChangeViewState: (fn: Fn<unknown>) => webview.viewState.on(fn),
      onDidDispose: () => ({ dispose: () => undefined }),
      reveal: () => undefined,
      dispose: () => undefined,
    };
  }

  get live(): FakePage {
    assert.ok(this.page instanceof FakePage, 'the page is loaded');
    return this.page;
  }

  /** The workbench creates the webview. Its page loads from the HTML set last, a little later. */
  create(): void { this.page = 'loading'; }
  /** The page's script runs: it finds the state VS Code kept, and listens from now on. */
  load(): void {
    this.reloading = false;
    this.page = new FakePage(this, this.html, this.displayed);
  }
  /** The workbench tears the webview down. */
  destroy(): void {
    this.reloading = false;
    this.page = null;
  }
  private replaceHtml(html: string): void {
    this.html = html;
    if (!(this.page instanceof FakePage)) return;
    this.page = 'loading';
    this.reloading = true;
  }
  /** The extension host hears that the panel was hidden or shown: after the fact, on its own schedule. */
  tell(visible: boolean): void {
    this.panel.visible = visible;
    this.viewState.fire({ webviewPanel: this.panel });
  }

  fromPage(from: FakePage, sent: { state?: unknown; message?: unknown }): void {
    this.fromPages.push({ from, ...sent });
  }

  /** Deliver what is in flight. A message for a page that is gone, reloading or not listening yet is lost. */
  deliver(): void {
    if (this.reloading) this.load();
    const due = this.late ? this.inFlight.splice(0) : this.toPage.splice(0);
    while (due.length || this.fromPages.length) {
      for (const { to, message } of due.splice(0)) {
        if (to instanceof FakePage && to === this.page) to.fire('message', { data: message });
      }
      for (const sent of this.fromPages.splice(0)) {
        if (sent.from !== this.page) continue;
        if ('state' in sent) this.state = sent.state;
        else this.received.fire(sent.message);
      }
      if (this.reloading) this.load();
      if (!this.late) due.push(...this.toPage.splice(0));
    }
  }

  /** A step of a scenario is over: in "late" mode, what was sent to the page during it arrives after the next one. */
  endStep(): void {
    if (this.late) this.inFlight.push(...this.toPage.splice(0));
  }

  /** No more steps: everything still in flight arrives, in the order it was sent. */
  catchUp(): void {
    this.late = false;
    this.toPage.unshift(...this.inFlight.splice(0));
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const PARAGRAPHS = 60;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class World {
  readonly documentChanged = emitter<unknown>();
  readonly webview = new Webview();
  readonly document = {
    uri: uri(join(__dirname, 'restore.smd')),
    fileName: join(__dirname, 'restore.smd'),
    version: 1,
    text: `# Title\n\n${Array.from({ length: PARAGRAPHS }, (_, i) => `Paragraph ${i}.\n`).join('\n')}`,
    getText(): string { return this.text; },
  };
  private readonly manager: InstanceType<typeof PreviewManager>;

  constructor() {
    world = this;
    this.manager = new PreviewManager({ extensionUri: uri(join(__dirname, '..')) } as never);
    this.manager.show(this.document as never, true);
  }

  /** Open the preview and scroll it, as a reader would, to `offset` pixels into the paragraph. */
  static async reading(paragraph: number, offset: number): Promise<World> {
    const w = new World();
    w.webview.load();
    await w.settle();
    w.webview.live.scrollTo(w.lineOf(paragraph) * LINE + offset);
    await w.settle();
    assert.deepEqual(w.reads(), { paragraph, offset }, 'the reader is where the test put them');
    return w;
  }

  lineOf(paragraph: number): number {
    return this.document.text.split('\n').indexOf(`Paragraph ${paragraph}.`);
  }

  /** Insert `text` before the first line, as typing or pasting above the visible part does. */
  insertAtTop(text: string): void {
    this.document.text = text + this.document.text;
    this.document.version++;
    const at = { line: 0, character: 0 };
    this.documentChanged.fire({ document: this.document, contentChanges: [{ range: { start: at, end: at }, text }] });
  }

  status() {
    return this.manager.status(this.document.uri.toString());
  }

  /** Let everything in flight arrive and every timer (debounces of 150 and 200 ms) run. */
  async settle(): Promise<void> {
    this.webview.catchUp();
    for (let round = 0; round < 4; round++) {
      this.webview.deliver();
      await flush();
      this.webview.deliver();
      timers.tick(250);
    }
    this.webview.deliver();
  }

  /** Which paragraph is at the top of the page, by its text in the document the page shows, and how far in. */
  reads(): { paragraph: number; offset: number; stale?: string } {
    const { line, offset } = this.webview.live.top();
    const text = this.document.text.split('\n')[line] ?? '';
    const shown = this.webview.live.rootHtml.includes(`data-line="${line}">${text}<`);
    return { paragraph: Number(/^Paragraph (\d+)\.$/.exec(text)?.[1] ?? -1), offset, ...(shown ? {} : { stale: `line ${line} is not "${text}" on the page` }) };
  }
}

let timers: { tick(ms: number): void };

/** What can happen between "the reader looks at paragraph 20" and "the preview is back". */
const STEPS: Record<string, (w: World) => void> = {
  'webview torn down': (w) => w.webview.destroy(),
  'host told hidden': (w) => w.webview.tell(false),
  'two lines inserted at the top': (w) => w.insertAtTop('More.\n\n'),
  'debounce fires': () => timers.tick(200),
  'webview created': (w) => w.webview.create(),
  'page loads': (w) => w.webview.load(),
  'host told visible': (w) => w.webview.tell(true),
};
/** [earlier, later]: the only orders that are certain. */
const ORDER = [
  ['webview torn down', 'webview created'],
  ['webview created', 'page loads'],
  ['host told hidden', 'host told visible'],
  ['two lines inserted at the top', 'debounce fires'],
];

function orderings(steps: string[]): string[][] {
  if (steps.length <= 1) return [steps];
  const allowed = (first: string) => !ORDER.some(([earlier, later]) => later === first && steps.includes(earlier));
  return steps.filter(allowed).flatMap((first) => orderings(steps.filter((s) => s !== first)).map((rest) => [first, ...rest]));
}

async function run(steps: string[], late: boolean): Promise<World> {
  const w = await World.reading(20, 7);
  w.webview.late = late;
  for (const step of steps) {
    STEPS[step](w);
    w.webview.deliver();
    await flush();
    w.webview.deliver();
    w.webview.endStep();
  }
  await w.settle();
  return w;
}

test('a hidden preview comes back at the same content in every order of hide, edit, debounce and show', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  timers = t.mock.timers;
  const all = orderings(Object.keys(STEPS));
  assert.equal(all.length, 210);
  for (const steps of all) {
    for (const late of [false, true]) {
      const w = await run(steps, late);
      const how = `${steps.join(' → ')}${late ? ' (messages to the page arrive a step late)' : ''}`;
      assert.match(w.webview.live.rootHtml, /More\./, `the page shows the edit: ${how}`);
      assert.deepEqual(w.reads(), { paragraph: 20, offset: 7 }, how);
      assert.equal(w.status()?.top, w.lineOf(20), `the extension knows where the page is: ${how}`);
    }
  }
});

test('a hidden preview comes back where it was when nothing changed meanwhile', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  timers = t.mock.timers;
  const quiet = ['webview torn down', 'host told hidden', 'webview created', 'page loads', 'host told visible'];
  for (const steps of orderings(quiet)) {
    const w = await run(steps, false);
    assert.deepEqual(w.reads(), { paragraph: 20, offset: 7 }, steps.join(' → '));
  }
  // At the very top it stays at the top.
  const w = await World.reading(20, 7);
  w.webview.live.scrollTo(0);
  await w.settle();
  for (const step of quiet) STEPS[step](w);
  await w.settle();
  assert.equal(w.webview.live.scrollY, 0);
});

test('edits are applied once, however often the page reloads and whether or not it saved its place in between', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  timers = t.mock.timers;
  const w = await World.reading(20, 7);
  const hide = () => { w.webview.destroy(); w.webview.tell(false); };
  const show = () => { w.webview.create(); w.webview.load(); w.webview.tell(true); };
  hide();
  w.insertAtTop('More.\n\n');
  timers.tick(200);
  show();
  // Hidden again at once: the page had no time to save its place in the new numbering.
  w.webview.deliver();
  hide();
  show();
  await w.settle();
  assert.deepEqual(w.reads(), { paragraph: 20, offset: 7 }, 'not two more lines down');
  // And again after it did save, with another edit while visible and one while hidden.
  w.insertAtTop('Even more.\n\n');
  await w.settle();
  hide();
  w.insertAtTop('\n');
  show();
  hide();
  show();
  await w.settle();
  assert.deepEqual(w.reads(), { paragraph: 20, offset: 7 });
  assert.equal(w.status()?.top, w.lineOf(20));
});

test('a page that comes back without its state gets its place from the extension', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  timers = t.mock.timers;
  const w = await World.reading(20, 7);
  w.webview.destroy();
  w.webview.tell(false);
  w.insertAtTop('More.\n\n');
  timers.tick(200);
  w.webview.state = undefined;
  w.webview.create();
  w.webview.load();
  w.webview.tell(true);
  await w.settle();
  assert.deepEqual(w.reads(), { paragraph: 20, offset: 7 });
  assert.equal(w.status()?.restore, 'host');
});

test('a page that loads before its frame is displayed goes to its place once it has a layout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  timers = t.mock.timers;
  const w = await World.reading(20, 7);
  w.webview.destroy();
  w.webview.tell(false);
  w.insertAtTop('More.\n\n');
  timers.tick(200);
  w.webview.displayed = false;
  w.webview.create();
  w.webview.load();
  w.webview.tell(true);
  await w.settle();
  // Nothing to scroll in yet. The page says so, and does not save the top as its place.
  assert.equal(w.webview.live.scrollY, 0);
  assert.deepEqual({ top: w.status()?.top, restore: w.status()?.restore }, { top: 0, restore: 'waiting' });
  assert.deepEqual((w.webview.state as { anchor: unknown }).anchor, { line: w.lineOf(20) - 2, offset: 7 }, 'the saved place is untouched');

  // An edit arrives meanwhile: the place that is waiting moves with it, not the top of the page.
  w.insertAtTop('Still hidden.\n\n');
  await w.settle();
  assert.equal(w.webview.live.scrollY, 0);

  w.webview.live.display();
  await w.settle();
  assert.deepEqual(w.reads(), { paragraph: 20, offset: 7 });
  assert.equal(w.status()?.top, w.lineOf(20), 'and the extension hears where the page went');
});

test('a page reloaded from an older copy of the document keeps its place exactly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  timers = t.mock.timers;
  const w = await World.reading(20, 7);
  // Edits while visible reach the page as messages; the HTML the webview reloads from is still the first one.
  w.insertAtTop('More.\n\n');
  await w.settle();
  w.insertAtTop('Even more.\n\n\n');
  await w.settle();
  assert.deepEqual(w.reads(), { paragraph: 20, offset: 7 });
  // Moved to another editor group: VS Code reloads the webview without hiding the panel.
  w.webview.destroy();
  w.webview.create();
  w.webview.load();
  await w.settle();
  assert.deepEqual(w.reads(), { paragraph: 20, offset: 7 });
});
