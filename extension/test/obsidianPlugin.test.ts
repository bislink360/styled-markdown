// The Obsidian plugin (integrations/obsidian) as it ships: main.js is built with the release build's options, then
// run against a small mock of the `obsidian` module and a fake DOM, without the app.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTERNAL, buildOptions, loadEsbuild, readManifest } from '../../integrations/obsidian/scripts/build.mjs';

const pluginDir = join(__dirname, '../../integrations/obsidian');

// ---------------------------------------------------------------------------
// A fake DOM: just what the plugin's DOM code uses
// ---------------------------------------------------------------------------

class FakeNode {
  parent: FakeElement | null = null;
  get parentElement(): FakeElement | null {
    return this.parent;
  }
  get ownerDocument(): FakeDocument {
    return fakeDocument;
  }
  replaceWith(...nodes: FakeNode[]): void {
    const parent = this.parent;
    if (!parent) return;
    const at = parent.childNodes.indexOf(this);
    const added = nodes.flatMap(flatten);
    for (const node of added) node.parent = parent;
    parent.childNodes.splice(at, 1, ...added);
    this.parent = null;
  }
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super();
  }
  get textContent(): string {
    return this.data;
  }
}

class FakeElement extends FakeNode {
  childNodes: FakeNode[] = [];
  readonly classes = new Set<string>();
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  constructor(public tagName: string) {
    super();
  }
  readonly classList = {
    add: (...names: string[]) => names.forEach((n) => this.classes.add(n)),
    remove: (...names: string[]) => names.forEach((n) => this.classes.delete(n)),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
  };
  get className(): string {
    return [...this.classes].join(' ');
  }
  set className(value: string) {
    this.classes.clear();
    value.split(/\s+/).filter(Boolean).forEach((n) => this.classes.add(n));
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  get textContent(): string {
    return this.childNodes.map((n) => (n as FakeText | FakeElement).textContent).join('');
  }
  append(...nodes: FakeNode[]): void {
    for (const node of nodes.flatMap(flatten)) {
      node.parent = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.childNodes = [];
    this.append(...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
  /** Tag names and `.class` names only, which is all the plugin asks for. */
  closest(selectors: string): FakeElement | null {
    const list = selectors.split(',').map((s) => s.trim());
    for (let el: FakeElement | null = this; el; el = el.parent) {
      const current = el;
      if (list.some((s) => (s.startsWith('.') ? current.classes.has(s.slice(1)) : current.tagName === s))) return el;
    }
    return null;
  }
}

class FakeFragment extends FakeElement {
  constructor() {
    super('#fragment');
  }
}

function flatten(node: FakeNode): FakeNode[] {
  return node instanceof FakeFragment ? node.childNodes : [node];
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
  createDocumentFragment(): FakeFragment {
    return new FakeFragment();
  }
  createTextNode(data: string): FakeText {
    return new FakeText(data);
  }
  createTreeWalker(root: FakeElement) {
    const texts: FakeText[] = [];
    const visit = (el: FakeElement) => el.childNodes.forEach((n) => (n instanceof FakeText ? texts.push(n) : visit(n as FakeElement)));
    visit(root);
    let i = 0;
    return { nextNode: () => texts[i++] ?? null };
  }
}

const fakeDocument = new FakeDocument();

/** An element with text, as Obsidian's reading view would have rendered a section. */
function section(tag: string, text: string): FakeElement {
  const el = fakeDocument.createElement('div');
  const inner = fakeDocument.createElement(tag);
  inner.append(fakeDocument.createTextNode(text));
  el.append(inner);
  return el;
}

/** The sanitized HTML strings under an element (the mock sanitizer leaves them as `data-html`). */
function sanitizedHtml(el: FakeElement): string[] {
  const out: string[] = [];
  const visit = (node: FakeElement) => {
    if (node.tagName === 'sanitized') out.push(node.dataset.html);
    node.children.forEach(visit);
  };
  visit(el);
  return out;
}

// ---------------------------------------------------------------------------
// A mock of the `obsidian` module
// ---------------------------------------------------------------------------

interface Calls {
  extensions: Array<[string[], string]>;
  codeBlocks: Map<string, (source: string, el: FakeElement, ctx: unknown) => void>;
  postProcessors: Array<(el: FakeElement, ctx: unknown) => void>;
  settingTabs: number;
  sanitized: string[];
  rerenders: Array<boolean | undefined>;
  saved: unknown;
}

function obsidianMock(calls: Calls, saved: unknown) {
  class Component {
    addChild(): void {}
  }
  class MarkdownRenderChild extends Component {
    constructor(public containerEl: FakeElement) {
      super();
    }
  }
  class MarkdownView {
    file = { path: 'note.md' };
    previewMode = { rerender: (full?: boolean) => calls.rerenders.push(full) };
  }
  class Plugin extends Component {
    constructor(public app: unknown, public manifest: unknown) {
      super();
    }
    loadData = async () => saved;
    saveData = async (data: unknown) => {
      calls.saved = data;
    };
    registerExtensions(extensions: string[], view: string): void {
      calls.extensions.push([extensions, view]);
    }
    registerMarkdownCodeBlockProcessor(lang: string, handler: Calls['codeBlocks'] extends Map<string, infer H> ? H : never): void {
      calls.codeBlocks.set(lang, handler);
    }
    registerMarkdownPostProcessor(processor: Calls['postProcessors'][number]): void {
      calls.postProcessors.push(processor);
    }
    addSettingTab(): void {
      calls.settingTabs++;
    }
  }
  class PluginSettingTab {}
  class Setting {}
  const sanitizeHTMLToDom = (html: string) => {
    calls.sanitized.push(html);
    const fragment = new FakeFragment();
    const el = new FakeElement('sanitized');
    el.dataset.html = html;
    fragment.append(el);
    return fragment;
  };
  return {
    Component, MarkdownRenderChild, MarkdownView, Plugin, PluginSettingTab, Setting, sanitizeHTMLToDom,
    MarkdownRenderer: { render: async () => undefined },
    renderMath: () => new FakeElement('mjx-container'),
    finishRenderMath: async () => undefined,
    MarkdownViewClass: MarkdownView,
  };
}

let mainJs = '';

before(async () => {
  const result = await loadEsbuild().build({ ...buildOptions(join(pluginDir, 'main.js')), write: false });
  mainJs = result.outputFiles[0].text;
});

/** Load main.js as Obsidian would (CommonJS, `require('obsidian')`), and run its onload. */
async function loadPlugin(saved: unknown = {}) {
  const calls: Calls = { extensions: [], codeBlocks: new Map(), postProcessors: [], settingTabs: 0, sanitized: [], rerenders: [], saved: undefined };
  const obsidian = obsidianMock(calls, saved);
  const module = { exports: {} as { default: new (app: unknown, manifest: unknown) => { onload(): Promise<void> } } };
  const requireObsidian = (id: string) => {
    if (id !== 'obsidian') throw new Error(`main.js requires ${id}`);
    return obsidian;
  };
  const fakeWindow = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) };
  new Function('module', 'exports', 'require', 'window', 'NodeFilter', mainJs)(module, module.exports, requireObsidian, fakeWindow, { SHOW_TEXT: 4 });
  const view = new obsidian.MarkdownViewClass();
  const app = { workspace: { getLeavesOfType: (type: string) => (type === 'markdown' ? [{ view }] : []) } };
  const plugin = new module.exports.default(app, readManifest());
  await plugin.onload();
  return { plugin, calls };
}

/** A post-processor context for a section of `text`. */
function context(text: string, lineStart: number, lineEnd: number) {
  return {
    sourcePath: 'note.md',
    frontmatter: null,
    addChild: () => undefined,
    getSectionInfo: () => ({ text, lineStart, lineEnd }),
  };
}

const NOTE = [
  ':::note Setup', //            0
  'First paragraph.', //         1
  '', //                         2
  'Second paragraph.', //        3
  ':::', //                      4
  '', //                         5
  'Ship :badge[Beta] today.', // 6
].join('\n');

// ---------------------------------------------------------------------------

test('the bundle needs nothing at runtime but the obsidian module', () => {
  const required = new Set([...mainJs.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]));
  assert.deepEqual([...required], ['obsidian']);
  assert.ok(EXTERNAL.includes('obsidian'));
  assert.match(mainJs, new RegExp(`^/\\* Styled Markdown for Obsidian ${readManifest().version.replaceAll('.', '\\.')} `));
});

test('manifest.json and versions.json are what Obsidian expects, at the release version', () => {
  const manifest = readManifest();
  const versions = JSON.parse(readFileSync(join(pluginDir, 'versions.json'), 'utf8'));
  const extension = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
  assert.equal(manifest.id, 'styled-markdown');
  assert.equal(manifest.version, extension.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
  assert.match(manifest.minAppVersion, /^\d+\.\d+\.\d+$/);
  assert.doesNotMatch(`${manifest.id} ${manifest.name}`, /obsidian/i);
  assert.ok(manifest.description.length <= 250 && manifest.description.endsWith('.'));
});

test('onload registers .smd files, the ```smd block, the post-processor and the settings tab', async () => {
  const { calls } = await loadPlugin();
  assert.deepEqual(calls.extensions, [[['smd'], 'markdown']]);
  assert.deepEqual([...calls.codeBlocks.keys()], ['smd']);
  assert.equal(calls.postProcessors.length, 1);
  assert.equal(calls.settingTabs, 1);
  const off = await loadPlugin({ smdFiles: false });
  assert.deepEqual(off.calls.extensions, []);
});

test('a container is drawn by the section it starts in; the sections inside it are hidden', async () => {
  const { calls } = await loadPlugin();
  const [process] = calls.postProcessors;
  const first = section('p', ':::note Setup\nFirst paragraph.');
  process(first, context(NOTE, 0, 1));
  const [html] = sanitizedHtml(first);
  assert.match(html, /class="smd-callout smd-callout-note"/);
  assert.match(html, /Second paragraph\./);
  assert.equal(first.children[0].className, 'smd-obsidian');

  const second = section('p', 'Second paragraph.\n:::');
  process(second, context(NOTE, 3, 4));
  assert.equal(second.childNodes.length, 0);
  assert.ok(second.classList.contains('smd-obsidian-hidden'));
});

test('inline directives are rendered inside Obsidian text nodes, through the sanitizer', async () => {
  const { calls } = await loadPlugin();
  const el = section('p', 'Ship :badge[Beta] today.');
  calls.postProcessors[0](el, context(NOTE, 6, 6));
  const p = el.children[0];
  assert.equal((p.childNodes[0] as FakeText).data, 'Ship ');
  assert.equal((p.childNodes[1] as FakeElement).dataset.html, '<span class="smd-badge">Beta</span>');
  assert.equal((p.childNodes[2] as FakeText).data, ' today.');
  // Code is left alone.
  const code = section('code', ':badge[Beta]');
  calls.postProcessors[0](code, context(NOTE, 6, 6));
  assert.equal(code.textContent, ':badge[Beta]');
});

test('raw HTML from a note only reaches the sanitizer escaped', async () => {
  const { calls } = await loadPlugin();
  const note = ':::note\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n:::';
  calls.postProcessors[0](section('p', note), context(note, 0, 3));
  assert.equal(calls.sanitized.length, 1);
  assert.doesNotMatch(calls.sanitized[0], /<script|<img/);
  assert.match(calls.sanitized[0], /&lt;script&gt;/);
});

test('an edit inside a container that re-renders only a later section renders the view again', async () => {
  const { calls } = await loadPlugin();
  const [process] = calls.postProcessors;
  process(section('p', ''), context(NOTE, 0, 1));
  process(section('p', ''), context(NOTE, 3, 4));
  const edited = NOTE.replace('Second paragraph.', 'Second paragraph, edited.');
  process(section('p', ''), context(edited, 3, 4));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls.rerenders, [true]);
});

test('with containers off, container sections keep Obsidian rendering; ```smd blocks still render', async () => {
  const { calls } = await loadPlugin({ containers: false });
  const el = section('p', ':::note Setup\nFirst paragraph.');
  calls.postProcessors[0](el, context(NOTE, 0, 1));
  assert.equal(el.textContent, ':::note Setup\nFirst paragraph.');
  const block = new FakeElement('div');
  calls.codeBlocks.get('smd')?.(':::tip\nFenced.\n:::', block, context('', 0, 0));
  assert.match(sanitizedHtml(block)[0], /class="smd-callout smd-callout-tip"/);
});
