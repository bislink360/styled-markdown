import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { buildSite, renderSmd, renderStandaloneHtml } from '../src/core';
import { riskRegisterHtml } from '../src/core/riskHtml';
import { riskRegister } from '../src/core/risks';

// Accessibility of rendered HTML: names, roles and states (WCAG 2.2 AA, WAI-ARIA tabs). Contrast is in contrast.test.ts.

const TODAY = '2026-09-26';
const render = (src: string) => renderSmd(src, { today: TODAY }).html;
const media = (name: string) => readFileSync(join(__dirname, '..', 'media', name), 'utf8');

// ---------------------------------------------------------------------------
// Rendered HTML
// ---------------------------------------------------------------------------

test('a11y: progress bars have a role, a value and a name', () => {
  assert.match(render(':progress[40]'), /role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40"/);
  assert.match(render(':progress[60]{label="3 of 5 <done>"}'), /role="progressbar" aria-label="3 of 5 &lt;done&gt;"/);
});

test('a11y: a status dot repeats its text in colour, so it is hidden; without text the colour name is its name', () => {
  assert.match(render(':status[On track]{color=green}'), /<span class="smd-status-dot" style="background:var\(--smd-green\)" aria-hidden="true"><\/span>On track/);
  assert.match(render(':status[]{color=red}'), /<span class="smd-status-dot" style="background:var\(--smd-red\)" role="img" aria-label="red"><\/span>/);
});

test('a11y: overdue and due soon are words as well as colours', () => {
  const html = render(':due[2026-09-20] :due[2026-09-30] :due[2026-12-01]');
  assert.match(html, /📅 2026-09-20<span class="smd-due-note"> · overdue<\/span>/);
  assert.match(html, /📅 2026-09-30<span class="smd-due-note smd-sr-only"> \(due soon\)<\/span>/);
  assert.match(html, /📅 2026-12-01<\/span>/);
  // Done tasks are not overdue: the stylesheet hides the note there.
  assert.match(media('smd.css'), /\.smd-task-done \.smd-due-note \{ display: none; \}/);
});

test('a11y: metric trends are spoken, not only coloured', () => {
  const html = render(':metric[9]{label=Errors delta=-2 good=down} :metric[1]{label=x delta=0 trend=flat}');
  assert.match(html, /smd-metric-good"><span aria-hidden="true">▼<\/span> -2<span class="smd-sr-only"> \(down, good\)<\/span>/);
  assert.match(html, /smd-metric-flat"><span aria-hidden="true">■<\/span> 0<span class="smd-sr-only"> \(flat\)<\/span>/);
});

test('a11y: a callout with its own title still says its type to screen readers', () => {
  assert.match(render(':::warning Mind the gap\nx\n:::'), /aria-hidden="true">⚠<\/span><span><span class="smd-sr-only">Warning: <\/span>Mind the gap<\/span>/);
  assert.match(render(':::tip\nx\n:::'), /aria-hidden="true">💡<\/span><span>Tip<\/span>/);
  const collapsible = render(':::danger{collapsible} Do not\nx\n:::');
  assert.match(collapsible, /<details class="smd-callout smd-callout-danger" data-line="0"><summary class="smd-callout-title">/);
  assert.match(collapsible, /<span class="smd-sr-only">Danger: <\/span>Do not/);
});

test('a11y: collapsibles are native <details>/<summary> with a label', () => {
  assert.match(render(':::details More\nx\n:::'), /<details class="smd-details" data-line="0"><summary>More<\/summary>/);
  assert.match(render(':::details\nx\n:::'), /<summary>Details<\/summary>/);
  assert.match(render(':::agent Setup\nx\n:::'), /<details class="smd-agent" data-line="0"><summary class="smd-agent-title"><span class="smd-agent-icon" aria-hidden="true">🤖<\/span><span>For agents: Setup<\/span><\/summary>/);
  // Markers are decoration with empty alternative text.
  assert.match(media('smd.css'), /summary::after \{ content: "▸"; content: "▸" \/ "";/);
  assert.match(media('site.css'), /summary::before \{ content: "▸"; content: "▸" \/ "";/);
});

test('a11y: task checkboxes are named by the task text, directives included', () => {
  const html = render('- [ ] Ship **it** & `v2` :priority[P1] :due[2026-09-20]\n  next line\n- [x] ![logo](x.png) done');
  assert.match(html, /<input type="checkbox" class="smd-task-box" data-task-line="0" aria-label="Ship it &amp; v2 P1 📅 2026-09-20 · overdue next line">/);
  assert.match(html, /data-task-line="2" checked aria-label="logo done">/);
  assert.match(render('- [x] Shipped :due[2026-09-20]'), /checked aria-label="Shipped 📅 2026-09-20">/, 'a done task is not overdue');
  assert.match(render('- [ ] <span></span>'), /data-task-line="0"><span><\/span>/, 'no empty name');
});

test('a11y: table header cells have scope; the contents is a named navigation landmark', () => {
  const html = render('| a | b |\n|:-|-:|\n| 1 | 2 |');
  assert.match(html, /<th style="text-align:left" scope="col">a<\/th>/);
  assert.match(html, /<th style="text-align:right" scope="col">b<\/th>/);
  assert.match(renderSmd('---\ntoc: true\n---\n## A\n## B\n').html, /<nav class="smd-toc" aria-label="Contents">/);
  const register = riskRegisterHtml(riskRegister([{ path: 'a.smd', text: ':::risk{impact=high likelihood=low} R\nx\n:::\n' }]));
  assert.doesNotMatch(register, /<th>/, 'risk matrix and register headers have scope');
  assert.match(register, /<th scope="row">Critical<\/th>/);
});

test('a11y: pages declare their language and have a main landmark', () => {
  const page = renderStandaloneHtml('# T\n', '', '');
  assert.match(page, /<html lang="en" /);
  assert.match(page, /<main id="smd-root">/);
});

test('a11y: site pages have a skip link to a focusable main, landmarks and named navigation', () => {
  const build = buildSite([{ path: 'index.smd', text: '# Home\n' }, { path: 'guide/a.smd', text: '# A\n- [ ] x :due[2026-09-20]\n' }], { today: TODAY });
  const page = build.files.find((f) => f.path === 'guide/a.html')!.content;
  assert.match(page, /<html lang="en" /);
  assert.match(page, /<a class="smd-site-skip" href="#smd-root">Skip to content<\/a>/);
  assert.match(page, /<header class="smd-site-bar">/);
  assert.match(page, /<button type="button" class="smd-site-menu" aria-controls="smd-site-nav" aria-expanded="false"><span aria-hidden="true">☰<\/span><span class="smd-site-sr">Menu<\/span><\/button>/);
  assert.match(page, /<div class="smd-site-search" role="search"><input type="search" id="smd-site-q" placeholder="Search" aria-label="Search the documentation"/);
  assert.match(page, /<nav id="smd-site-nav" class="smd-site-nav" aria-label="Documents">/);
  assert.match(page, /<nav class="smd-site-crumbs" aria-label="Breadcrumb">/);
  assert.match(page, /<main id="smd-root" tabindex="-1">/);
  const dashboard = build.files.find((f) => f.path === 'dashboard.html')!.content;
  assert.match(dashboard, /<span class="smd-due smd-due-overdue">2026-09-20<span class="smd-due-note"> · overdue<\/span><\/span>/);
});

test('a11y: focus is visible everywhere, the copy button shows on focus, and motion can be reduced', () => {
  const css = media('smd.css');
  const site = media('site.css');
  assert.match(css, /\.smd-doc :focus-visible \{ outline: 2px solid var\(--smd-focus\); outline-offset: 2px; \}/);
  assert.match(css, /\.smd-code:hover \.smd-copy, \.smd-code:focus-within \.smd-copy \{ opacity: 1; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(site, /\.smd-site :focus-visible \{ outline: 2px solid var\(--smd-focus\)/);
  assert.doesNotMatch(site, /outline: none; \}\n\.smd-site-result-title/, 'search results keep a focus ring');
  assert.match(site, /\.smd-site-result:focus \{ outline: 2px solid var\(--smd-focus\)/);
});

// ---------------------------------------------------------------------------
// Tabs (runtime): WAI-ARIA tabs pattern, driven through a small stand-in for the DOM
// ---------------------------------------------------------------------------

const { tabKeyTarget, buildTabs } = createRequire(__filename)(join(__dirname, '..', 'media', 'runtime.js'));

type Listener = (e: FakeEvent) => void;
interface FakeEvent { key?: string; target?: FakeElement; prevented?: boolean; preventDefault(): void }

class FakeElement {
  id = '';
  type = '';
  className = '';
  textContent = '';
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, Listener[]>();
  readonly classList = {
    add: (c: string) => this.classes.add(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on: boolean) => {
      if (on) this.classes.add(c);
      else this.classes.delete(c);
    },
  };

  constructor(private readonly doc: FakeDocument) {}

  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  appendChild(child: FakeElement): void { this.children.push(child); }
  insertBefore(child: FakeElement, before: FakeElement | null): void {
    const at = before ? this.children.indexOf(before) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
  }
  get firstChild(): FakeElement | null { return this.children[0] ?? null; }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatch(type: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const event: FakeEvent = { target: this, ...init, preventDefault() { event.prevented = true; } };
    (this.listeners.get(type) ?? []).forEach((l) => l(event));
    return event;
  }
  focus(): void { this.doc.activeElement = this; }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  private readonly elements: FakeElement[] = [];
  createElement(): FakeElement {
    const el = new FakeElement(this);
    this.elements.push(el);
    return el;
  }
  getElementById(id: string): FakeElement | null { return this.elements.find((e) => e.id === id) ?? null; }
}

function tabGroup(doc: FakeDocument, titles: Array<string | null>) {
  const tabs = doc.createElement();
  const panes = titles.map((title) => {
    const pane = doc.createElement();
    pane.className = 'smd-tab';
    if (title !== null) pane.setAttribute('data-title', title);
    tabs.appendChild(pane);
    return pane;
  });
  const chosen: number[] = [];
  const select = buildTabs(doc, tabs, panes, (i: number) => chosen.push(i));
  const bar = tabs.firstChild!;
  return { tabs, panes, bar, buttons: bar.children, select, chosen };
}

test('a11y tabs: arrow keys wrap, Home and End jump, other keys are left alone', () => {
  assert.equal(tabKeyTarget('ArrowRight', 0, 3), 1);
  assert.equal(tabKeyTarget('ArrowRight', 2, 3), 0);
  assert.equal(tabKeyTarget('ArrowLeft', 0, 3), 2);
  assert.equal(tabKeyTarget('Home', 2, 3), 0);
  assert.equal(tabKeyTarget('End', 0, 3), 2);
  assert.equal(tabKeyTarget('Enter', 1, 3), -1);
  assert.equal(tabKeyTarget('ArrowDown', 1, 3), -1);
});

test('a11y tabs: a tablist of tabs that control labelled tab panels, with unique ids across groups', () => {
  const doc = new FakeDocument();
  const first = tabGroup(doc, ['npm', 'pnpm']);
  const second = tabGroup(doc, ['npm', null]);
  assert.equal(first.bar.className, 'smd-tabbar');
  assert.equal(first.bar.getAttribute('role'), 'tablist');
  assert.ok(first.tabs.classList.contains('smd-js'));
  const ids = [...first.panes, ...second.panes].map((p) => p.id);
  assert.deepEqual(ids, ['smd-tab-1', 'smd-tab-2', 'smd-tab-3', 'smd-tab-4']);
  for (const { panes, buttons } of [first, second]) {
    buttons.forEach((btn, i) => {
      assert.equal(btn.type, 'button');
      assert.equal(btn.getAttribute('role'), 'tab');
      assert.equal(btn.id, `${panes[i].id}-tab`);
      assert.equal(btn.getAttribute('aria-controls'), panes[i].id);
      assert.equal(panes[i].getAttribute('role'), 'tabpanel');
      assert.equal(panes[i].getAttribute('aria-labelledby'), btn.id);
      assert.equal(panes[i].getAttribute('tabindex'), '0');
    });
  }
  assert.deepEqual(second.buttons.map((b) => b.textContent), ['npm', 'Tab 2']);
  // A pane with an author's {#id} keeps it.
  const own = new FakeDocument();
  const pane = own.createElement();
  pane.id = 'install';
  const tabs = own.createElement();
  buildTabs(own, tabs, [pane], () => undefined);
  assert.equal(tabs.firstChild!.children[0].getAttribute('aria-controls'), 'install');
});

test('a11y tabs: selection sets aria-selected, a roving tabindex and the visible pane', () => {
  const doc = new FakeDocument();
  const { panes, buttons, select, chosen } = tabGroup(doc, ['a', 'b', 'c']);
  select(1);
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-selected')), ['false', 'true', 'false']);
  assert.deepEqual(buttons.map((b) => b.getAttribute('tabindex')), ['-1', '0', '-1']);
  assert.deepEqual(panes.map((p) => p.classList.contains('smd-active')), [false, true, false]);
  assert.equal(doc.activeElement, null, 'restoring a saved tab does not move focus');
  assert.deepEqual(chosen, [], 'nor does it count as the reader choosing');
  buttons[2].dispatch('click');
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-selected')), ['false', 'false', 'true']);
  assert.deepEqual(chosen, [2]);
});

test('a11y tabs: keyboard moves focus and selection along the tab list', () => {
  const doc = new FakeDocument();
  const { bar, panes, buttons, select, chosen } = tabGroup(doc, ['a', 'b', 'c']);
  select(0);
  const key = (k: string, from: number) => bar.dispatch('keydown', { key: k, target: buttons[from] });
  assert.ok(key('ArrowRight', 0).prevented);
  assert.equal(doc.activeElement, buttons[1]);
  assert.deepEqual(buttons.map((b) => b.getAttribute('tabindex')), ['-1', '0', '-1']);
  assert.ok(panes[1].classList.contains('smd-active'));
  key('End', 1);
  assert.equal(doc.activeElement, buttons[2]);
  key('ArrowRight', 2);
  assert.equal(doc.activeElement, buttons[0], 'wraps around');
  key('ArrowLeft', 0);
  key('Home', 2);
  assert.deepEqual(chosen, [1, 2, 0, 2, 0]);
  assert.equal(key('Tab', 0).prevented, undefined, 'Tab leaves the tab list');
  assert.equal(bar.dispatch('keydown', { key: 'ArrowRight', target: bar }).prevented, undefined, 'only keys on a tab count');
});

test('a11y tabs: rendered panes read without scripts and stack when printed', () => {
  const html = render(':::tabs\n:::tab npm\nnpm i\n:::\n:::tab pnpm\npnpm add\n:::\n:::');
  assert.match(html, /<section class="smd-tab" data-line="1" data-title="npm"><div class="smd-tab-label">npm<\/div>/);
  assert.doesNotMatch(html, /role="tab/, 'roles come with the tab bar, from the runtime');
  assert.match(media('smd.css'), /\.smd-tabs\.smd-js \.smd-tab:not\(\.smd-active\), \.smd-tabs\.smd-js \.smd-tab-label \{ display: block; \}/);
});
