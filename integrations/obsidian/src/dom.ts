/**
 * DOM work on reading view: hiding sections, putting inline directives into Obsidian's text nodes, and bringing the
 * engine's HTML to life (tabs, math, diagrams). Obsidian's API comes in as callbacks, so this file needs only the DOM.
 */

/** A piece of a text node: text to keep, or the engine's HTML for an inline directive. */
export type Segment = { text: string; html?: undefined } | { html: string; text?: undefined };

export const HIDDEN_CLASS = 'smd-obsidian-hidden';
export const ROOT_CLASS = 'smd-obsidian';
const MATH_SELECTOR = '.smd-obsidian-math';
const ROLE = 'role';
/** Text that is code, math, already the engine's, or the note's properties is left alone. */
const SKIP_TEXT = 'code, pre, kbd, .math, mjx-container, .smd-obsidian, .frontmatter, .metadata-container';

/** Obsidian's reading view hooks, as callbacks. */
export interface Host {
  /** HTML (the engine's) as a sanitized fragment: Obsidian's `sanitizeHTMLToDom`. */
  toDom(html: string): DocumentFragment;
  /** TeX as an element: Obsidian's `renderMath` (MathJax). */
  math?(tex: string, display: boolean): HTMLElement;
  /** Render a Mermaid diagram into `el` (Obsidian's own Mermaid, through its Markdown renderer). */
  diagram?(code: string, el: HTMLElement): void;
}

/** Hide a section whose lines another section renders. */
export function hideSection(el: HTMLElement): void {
  el.replaceChildren();
  el.classList.add(HIDDEN_CLASS);
}

/** Replace a section's content with the engine's HTML; returns the new root (`.smd-obsidian`). */
export function showRendered(el: HTMLElement, html: string, host: Host): { root: HTMLElement; math: number } {
  const root = el.ownerDocument.createElement('div');
  root.className = ROOT_CLASS;
  root.append(host.toDom(html));
  el.classList.remove(HIDDEN_CLASS);
  el.replaceChildren(root);
  return { root, math: hydrate(root, host) };
}

/** Tabs, read-only task boxes, math and diagrams in rendered HTML; returns how many formulas were rendered. */
export function hydrate(root: HTMLElement, host: Host): number {
  for (const group of Array.from(root.querySelectorAll<HTMLElement>('.smd-tabs'))) buildTabs(group);
  // A box here can't change the note (Obsidian toggles only the task lists it renders), so it doesn't pretend to.
  for (const box of Array.from(root.querySelectorAll<HTMLInputElement>('input.smd-task-box'))) box.disabled = true;
  if (host.diagram) renderDiagrams(root, host.diagram);
  return host.math ? renderMath(root, host.math) : 0;
}

function renderDiagrams(root: HTMLElement, diagram: NonNullable<Host['diagram']>): void {
  for (const pre of Array.from(root.querySelectorAll<HTMLElement>('.smd-diagram > pre.smd-mermaid'))) {
    const host = pre.parentElement;
    if (!host) continue;
    const code = pre.textContent ?? '';
    host.replaceChildren();
    diagram(code, host);
  }
}

function renderMath(root: HTMLElement, math: NonNullable<Host['math']>): number {
  let count = 0;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(MATH_SELECTOR))) {
    const tex = el.dataset.tex;
    if (tex === undefined) continue;
    const rendered = math(tex, el.dataset.display === 'true');
    if (el.dataset.display === 'true') el.replaceChildren(rendered);
    else el.replaceWith(rendered);
    count++;
  }
  return count;
}

/** Put the engine's rendering of inline directives into the text nodes under `root`; returns how many nodes changed. */
export function replaceInlineSyntax(root: HTMLElement, segmentsOf: (text: string) => Segment[] | null, host: Pick<Host, 'toDom'>): number {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (mayHaveSyntax(text.data) && !text.parentElement?.closest(SKIP_TEXT)) nodes.push(text);
  }
  let changed = 0;
  for (const node of nodes) {
    const segments = segmentsOf(node.data);
    if (!segments) continue;
    const fragment = doc.createDocumentFragment();
    for (const segment of segments) fragment.append(segment.html === undefined ? doc.createTextNode(segment.text) : host.toDom(segment.html));
    node.replaceWith(fragment);
    changed++;
  }
  return changed;
}

/** A cheap test before the real scan: a directive needs `:` and a span `]{`. */
export function mayHaveSyntax(text: string): boolean {
  return (text.includes(':') && (text.includes('[') || text.includes('{'))) || text.includes(']{');
}

/** A fenced code block whose fence is longer than any backtick run in the code. */
export function fenced(lang: string, code: string): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${code.replace(/\n$/, '')}\n${fence}`;
}

// ---------------------------------------------------------------------------
// Tabs (the page runtime does this in the preview and exported HTML)
// ---------------------------------------------------------------------------

let tabIds = 0;

/** A tab bar in front of a `:::tabs` group's panes, with ARIA roles and arrow-key navigation. */
export function buildTabs(group: HTMLElement): void {
  if (group.classList.contains('smd-js')) return;
  const panes = Array.from(group.children).filter((c): c is HTMLElement => c.classList.contains('smd-tab'));
  if (!panes.length) return;
  const doc = group.ownerDocument;
  const bar = doc.createElement('div');
  bar.className = 'smd-tabbar';
  bar.setAttribute(ROLE, 'tablist');
  const buttons = panes.map((pane, i) => tabButton(doc, pane, i));
  const select = (index: number, focus: boolean) => {
    panes.forEach((pane, j) => pane.classList.toggle('smd-active', j === index));
    buttons.forEach((button, j) => {
      button.setAttribute('aria-selected', String(j === index));
      button.tabIndex = j === index ? 0 : -1;
    });
    if (focus) buttons[index].focus();
  };
  buttons.forEach((button, i) => {
    button.addEventListener('click', () => select(i, false));
    bar.append(button);
  });
  bar.addEventListener('keydown', (e) => {
    const to = tabKeyTarget(e.key, buttons.indexOf(e.target as HTMLButtonElement), buttons.length);
    if (to < 0) return;
    e.preventDefault();
    select(to, true);
  });
  group.insertBefore(bar, group.firstChild);
  group.classList.add('smd-js');
  select(0, false);
}

function tabButton(doc: Document, pane: HTMLElement, index: number): HTMLButtonElement {
  tabIds++;
  pane.id ||= `smd-obsidian-tab-${tabIds}`;
  const button = doc.createElement('button');
  button.type = 'button';
  button.id = `${pane.id}-tab`;
  button.setAttribute(ROLE, 'tab');
  button.setAttribute('aria-controls', pane.id);
  button.textContent = pane.dataset.title || `Tab ${index + 1}`;
  pane.setAttribute(ROLE, 'tabpanel');
  pane.setAttribute('aria-labelledby', button.id);
  pane.tabIndex = 0;
  return button;
}

/** The tab a key moves to from tab `from` of `count` (arrows wrap, Home, End), or -1 for other keys. */
export function tabKeyTarget(key: string, from: number, count: number): number {
  if (from < 0 || count <= 0) return -1;
  switch (key) {
    case 'ArrowRight':
      return (from + 1) % count;
    case 'ArrowLeft':
      return (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return -1;
  }
}
