/* Styled Markdown runtime — used by the VS Code preview and by exported HTML. */
(function () {
  'use strict';

  // ---- Pure helpers (unit-tested in Node via module.exports) ---------------

  /**
   * Map a 0-based source line through edits made since it was measured.
   * Each edit is [startLine, endLine, insertedLineBreaks], in the order they were applied.
   */
  function mapLine(line, edits) {
    for (const [start, end, breaks] of edits || []) {
      if (line > end) line += breaks - (end - start);
      else if (line > start) line = Math.min(line, start + breaks);
    }
    return line;
  }

  /**
   * Bring an anchor ({ line, offset }) measured in document version `from` to version `to`.
   * `sync.edits` are [version, startLine, endLine, insertedLineBreaks], each with the document version it
   * produced, and hold every line edit made after version `sync.since`. An anchor from before that, or one
   * newer than `to`, comes back as it is.
   */
  function mapAnchor(anchor, from, to, sync) {
    if (!anchor) return null;
    const known = !!sync && typeof from === 'number' && from >= sync.since;
    if (!known) return anchor;
    const edits = (sync.edits || []).filter((e) => e[0] > from && e[0] <= to).map((e) => e.slice(1));
    return { line: mapLine(anchor.line, edits), offset: anchor.offset };
  }

  /** The more recent of two saved places ({ anchor, version }); the first one when they are as recent. */
  function newerPlace(a, b) {
    if (!a || !b) return a || b || null;
    return b.version > a.version ? b : a;
  }

  /**
   * Which element anchors the viewport: the last one (document order) starting at or above
   * `viewTop`. `items` are [{ line, top }]; returns { line, offset } or null at the very top.
   */
  function pickAnchor(items, viewTop) {
    let best = null;
    for (const it of items) if (it.top <= viewTop + 1) best = it;
    if (!best) return null;
    const first = items.find((it) => it.line === best.line);
    return { line: best.line, offset: Math.max(0, viewTop - first.top) };
  }

  /** Index of the element to restore `line` to: first exact match, else the closest line above. */
  function findLine(items, line) {
    const exact = items.findIndex((it) => it.line === line);
    if (exact >= 0) return { index: exact, exact: true };
    let index = -1;
    items.forEach((it, i) => { if (it.line <= line && (index < 0 || it.line >= items[index].line)) index = i; });
    return { index, exact: false };
  }

  /** Stable keys from content signatures: the n-th element with the same signature gets `sig#n`. */
  function stableKeys(signatures) {
    const seen = new Map();
    return signatures.map((sig) => {
      const n = seen.get(sig) || 0;
      seen.set(sig, n + 1);
      return sig + '#' + n;
    });
  }

  /**
   * Saved UI state (key → value) brought over to the elements whose keys are now `keys` (document order); state of
   * keys no longer in the page is dropped. `previous[i]` is the key element i had when it was hydrated, if it is
   * left alone this time (outside the scope being hydrated), else null. An element left alone takes its own state
   * along when its key moved; the others pick up what was saved under their key, unless an element left alone had it.
   */
  function carryState(state, keys, previous) {
    const taken = new Set(previous.filter((k) => k !== null));
    const next = {};
    keys.forEach((key, i) => {
      let from = previous[i];
      if (from === null && !taken.has(key)) from = key;
      if (from !== null && from in state) next[key] = state[from];
    });
    return next;
  }

  /** Small LRU map for rendered diagrams, keyed by theme + source. */
  function lruCache(max) {
    const map = new Map();
    return {
      get(key) {
        if (!map.has(key)) return undefined;
        const v = map.get(key);
        map.delete(key);
        map.set(key, v);
        return v;
      },
      set(key, value) {
        map.delete(key);
        map.set(key, value);
        if (map.size > max) map.delete(map.keys().next().value);
      },
      get size() { return map.size; },
    };
  }

  const diagramKey = (theme, src) => theme + '\u0000' + src;

  // ---- Tabs (WAI-ARIA tabs pattern) ------------------------------------------
  // Built through the `doc` passed in, so tests can drive them with a small stand-in for the DOM.

  /** The tab a key moves focus to from `index` of `count`: arrows wrap, Home and End jump; -1 for other keys. */
  function tabKeyTarget(key, index, count) {
    if (key === 'ArrowRight') return (index + 1) % count;
    if (key === 'ArrowLeft') return (index - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return -1;
  }

  /** An id not used in the document yet (panes rendered by older versions have none). */
  /**
   * A label in the document's language: from the nearest data-smd-labels (JSON the renderer adds to documents with
   * a non-English `lang`), else the English text given.
   */
  function uiLabel(el, key, english) {
    const host = el && el.closest ? el.closest('[data-smd-labels]') : null;
    if (!host) return english;
    try {
      const text = JSON.parse(host.getAttribute('data-smd-labels'))[key];
      return typeof text === 'string' && text ? text : english;
    } catch {
      return english;
    }
  }

  function freshId(doc, prefix) {
    let n = 1;
    while (doc.getElementById(prefix + n)) n++;
    return prefix + n;
  }

  /** The tab button for a pane, which becomes the tab panel it controls. */
  function tabFor(doc, pane, i) {
    if (!pane.id) pane.id = freshId(doc, 'smd-tab-');
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.id = pane.id + '-tab';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', pane.id);
    btn.textContent = pane.getAttribute('data-title') || 'Tab ' + (i + 1);
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', btn.id);
    pane.setAttribute('tabindex', '0');
    return btn;
  }

  /**
   * Put a tab bar in front of a group's panes: role=tablist of role=tab buttons with aria-selected and a roving
   * tabindex; arrow keys, Home and End move between them. Returns select(index, focus); `onChoose` hears the reader's choices.
   */
  function buildTabs(doc, tabs, panes, onChoose) {
    const bar = doc.createElement('div');
    bar.className = 'smd-tabbar';
    bar.setAttribute('role', 'tablist');
    const buttons = panes.map((pane, i) => tabFor(doc, pane, i));
    const select = (index, focus) => {
      panes.forEach((p, j) => p.classList.toggle('smd-active', index === j));
      buttons.forEach((b, j) => {
        b.setAttribute('aria-selected', String(index === j));
        b.setAttribute('tabindex', index === j ? '0' : '-1');
      });
      if (focus) buttons[index].focus();
    };
    const choose = (index, focus) => {
      select(index, focus);
      onChoose(index);
    };
    buttons.forEach((btn, i) => {
      btn.addEventListener('click', () => choose(i, false));
      bar.appendChild(btn);
    });
    bar.addEventListener('keydown', (e) => {
      const from = buttons.indexOf(e.target);
      const to = from < 0 ? -1 : tabKeyTarget(e.key, from, buttons.length);
      if (to < 0) return;
      e.preventDefault();
      choose(to, true);
    });
    tabs.insertBefore(bar, tabs.firstChild);
    tabs.classList.add('smd-js');
    return select;
  }

  if (typeof document === 'undefined') {
    if (typeof module === 'object' && module.exports) {
      module.exports = { mapLine, mapAnchor, newerPlace, pickAnchor, findLine, stableKeys, carryState, lruCache, diagramKey, tabKeyTarget, buildTabs, uiLabel };
    }
    return;
  }

  // ---- Page state ----------------------------------------------------------

  // acquireVsCodeApi() works once per page: the page's other scripts get this handle from window.smdRuntime.
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  // What the page is, from <body data-smd-mode>: the preview (the default, also exported HTML, sites and the
  // playground) or the Block Editor. Only the preview follows the editor's scrolling, keeps its scroll place and
  // reveals source lines on double-click.
  const mode = document.body?.dataset?.smdMode || 'preview';
  const isPreview = mode === 'preview';
  const html = document.documentElement;
  const svgCache = lruCache(100);
  let diagramSeq = 0;
  let reusedDiagrams = 0;
  // UI state kept across re-renders (and, in VS Code, across the panel being hidden):
  // active tab per tab group and user-toggled <details>, keyed by content, not position.
  const saved = (vscode && vscode.getState()) || {};
  const ui = { tabs: saved.tabs || {}, open: saved.open || {} };
  // State the page's other scripts keep with the runtime's (setState() replaces the whole state).
  let appState = saved.app;
  // Where the page is: the anchor at the top of the viewport (null at the very top) and the document
  // version its line number belongs to. See "Scroll anchoring" below.
  let place = typeof saved.version === 'number' ? { anchor: saved.anchor || null, version: saved.version } : null;
  // Document version this page shows; the extension sends it with every render.
  let pageVersion = 0;
  // A place the page could not show yet: it has no layout (its frame isn't displayed or sized yet), or it
  // shows an older version of the document than the place was saved in.
  let intent = null;
  // How the page found its place when it loaded (reported to the extension's tests).
  let restoredFrom = 'none';

  const withApp = (state) => (appState === undefined ? state : { ...state, app: appState });

  function saveState() {
    if (!vscode) return;
    if (!isPreview) {
      vscode.setState(withApp({ tabs: ui.tabs, open: ui.open }));
      return;
    }
    const at = place || { anchor: null, version: pageVersion };
    vscode.setState(withApp({ anchor: at.anchor, version: at.version, tabs: ui.tabs, open: ui.open }));
    // The extension keeps a copy for a page that comes back without its state, and drops the edits this place includes.
    vscode.postMessage({ type: 'position', anchor: at.anchor, version: at.version });
  }

  function currentTheme() {
    const pref = html.getAttribute('data-smd-theme-pref') || 'auto';
    if (pref === 'light' || pref === 'dark') return pref;
    const b = document.body.classList;
    if (b.contains('vscode-high-contrast-light') || b.contains('vscode-light')) return 'light';
    if (b.contains('vscode-dark') || b.contains('vscode-high-contrast')) return 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const theme = currentTheme();
    const changed = html.getAttribute('data-smd-theme') !== theme;
    html.setAttribute('data-smd-theme', theme);
    return changed;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---- Tabs ---------------------------------------------------------------
  const panesOf = (tabs) => Array.from(tabs.children).filter((el) => el.classList.contains('smd-tab'));
  // Hydrating a scope (the whole page, or one block in the Block Editor) builds what is inside it. Keys are
  // counted over the whole page, so an element's key can move when one before it changes; saved state of the
  // elements outside the scope moves with them (carryState).
  const inScope = (scope, el) => scope === document || scope.contains(el);
  /** The key each tab group had when it was last keyed. */
  const tabKeys = new WeakMap();

  function initTabs(scope) {
    const groups = Array.from(document.querySelectorAll('.smd-tabs'));
    const keys = stableKeys(groups.map((g) => 'tabs:' + panesOf(g).map((p) => p.getAttribute('data-title') || '').join('\u0001')));
    ui.tabs = carryState(ui.tabs, keys, groups.map((g) => (inScope(scope, g) ? null : tabKeys.get(g) ?? null)));
    groups.forEach((tabs, groupIndex) => {
      tabKeys.set(tabs, keys[groupIndex]);
      if (!inScope(scope, tabs) || tabs.classList.contains('smd-js')) return;
      const panes = panesOf(tabs);
      if (!panes.length) return;
      const select = buildTabs(document, tabs, panes, (i) => {
        ui.tabs[tabKeys.get(tabs)] = i;
        saveState();
        refreshScrollers();
      });
      select(Math.min(ui.tabs[keys[groupIndex]] || 0, panes.length - 1));
    });
  }

  // ---- Open/closed <details> (collapsible callouts, details, agent blocks) --
  const DETAILS_KEY = 'data-smd-key';

  /** A <details> being hydrated: remember its source default, and reopen or close it as the reader left it. */
  function restoreDetails(d, key, state, live) {
    d.setAttribute(DETAILS_KEY, key);
    d.setAttribute('data-smd-default', d.open ? 'open' : 'closed');
    // A user toggle wins only while the source default it overrode is unchanged.
    if (state && state[0] === d.open) {
      d.open = state[1];
      live[key] = state;
    }
  }

  function initDetails(scope) {
    const all = Array.from(document.querySelectorAll('details'));
    const keys = stableKeys(all.map((d) => {
      const summary = d.querySelector(':scope > summary');
      return 'details:' + (summary ? summary.textContent.trim() : '');
    }));
    const outside = all.map((d) => !inScope(scope, d));
    const carried = carryState(ui.open, keys, all.map((d, i) => (outside[i] ? d.getAttribute(DETAILS_KEY) : null)));
    const live = {};
    all.forEach((d, i) => {
      const key = keys[i];
      if (!outside[i]) {
        restoreDetails(d, key, carried[key], live);
        return;
      }
      // Left as it is, under its new key if it has been hydrated before.
      if (d.hasAttribute(DETAILS_KEY)) d.setAttribute(DETAILS_KEY, key);
      if (carried[key]) live[key] = carried[key];
    });
    ui.open = live;
  }

  document.addEventListener('toggle', (e) => {
    const d = e.target;
    const key = d && d.getAttribute && d.getAttribute(DETAILS_KEY);
    if (!key) return;
    const dflt = d.getAttribute('data-smd-default') === 'open';
    if (d.open === dflt) delete ui.open[key];
    else ui.open[key] = [dflt, d.open];
    saveState();
    refreshScrollers();
  }, true);

  // ---- Copy buttons -------------------------------------------------------
  let liveRegion = null;

  /** Tell screen readers something without moving focus (a polite live region, created before it is needed). */
  function announce(text) {
    if (!liveRegion) return;
    liveRegion.textContent = '';
    setTimeout(() => { liveRegion.textContent = text; }, 50);
  }

  function ensureLiveRegion() {
    if (liveRegion) return;
    liveRegion = document.createElement('div');
    liveRegion.className = 'smd-sr-only';
    liveRegion.setAttribute('role', 'status');
    document.body.appendChild(liveRegion);
  }

  function addCopyButtons(scope) {
    const blocks = scope.querySelectorAll('.smd-code');
    if (blocks.length) ensureLiveRegion();
    blocks.forEach((block) => {
      if (block.querySelector('.smd-copy')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'smd-copy';
      const copy = uiLabel(block, 'copy', 'Copy');
      btn.textContent = copy;
      btn.setAttribute('aria-label', uiLabel(block, 'copyCode', 'Copy code'));
      btn.addEventListener('click', () => {
        const code = block.querySelector('code');
        if (!code || !navigator.clipboard) return;
        navigator.clipboard.writeText(code.textContent || '').then(() => {
          btn.textContent = uiLabel(block, 'copied', 'Copied');
          announce(uiLabel(block, 'codeCopied', 'Code copied'));
          setTimeout(() => (btn.textContent = copy), 1200);
        });
      });
      block.appendChild(btn);
    });
  }

  // ---- Keyboard access to wide blocks -------------------------------------
  // Code, tables, diagrams and math wider than the page scroll sideways; a keyboard can scroll them once focused.
  const SCROLLERS = '.smd-code pre, .smd-table-wrap, .smd-diagram, .smd-math-block, .smd-risk-matrix-wrap';
  let scrollersTimer;

  function refreshScrollers() {
    clearTimeout(scrollersTimer);
    scrollersTimer = setTimeout(() => {
      document.querySelectorAll(SCROLLERS).forEach((el) => {
        if (el.scrollWidth > el.clientWidth + 1) el.setAttribute('tabindex', '0');
        else if (el.getAttribute('tabindex') === '0') el.removeAttribute('tabindex');
      });
    }, 100);
  }
  window.addEventListener('resize', refreshScrollers);

  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---- Mermaid diagrams ---------------------------------------------------
  function cssVar(name) {
    return getComputedStyle(html).getPropertyValue(name).trim();
  }

  /** Blend two #rrggbb colors; t = weight of `a`. */
  function mix(a, b, t) {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return a;
    const [x, y] = [p(a), p(b)];
    return '#' + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('');
  }

  /** Derive Mermaid colors from the document palette so diagrams match the page and theme. */
  function mermaidTheme(dark) {
    const bg = cssVar('--smd-bg');
    const fg = cssVar('--smd-fg');
    const muted = cssVar('--smd-fg-muted');
    const border = cssVar('--smd-border');
    const surface = cssVar('--smd-surface');
    const c = (n) => cssVar('--smd-' + n);
    const soft = (n) => mix(c(n), surface, dark ? 0.28 : 0.16);
    const pies = ['indigo', 'teal', 'amber', 'pink', 'blue', 'green', 'orange', 'purple', 'cyan', 'red', 'yellow', 'gray'];
    const vars = {
      darkMode: dark,
      background: surface,
      fontFamily: getComputedStyle(document.body).fontFamily,
      fontSize: '14px',
      primaryColor: soft('indigo'),
      primaryBorderColor: c('indigo'),
      primaryTextColor: fg,
      secondaryColor: soft('teal'),
      secondaryBorderColor: c('teal'),
      secondaryTextColor: fg,
      tertiaryColor: soft('amber'),
      tertiaryBorderColor: c('amber'),
      tertiaryTextColor: fg,
      lineColor: muted,
      textColor: fg,
      mainBkg: soft('indigo'),
      nodeBorder: c('indigo'),
      clusterBkg: bg,
      clusterBorder: border,
      edgeLabelBackground: surface,
      titleColor: fg,
      actorBkg: soft('indigo'),
      actorBorder: c('indigo'),
      actorTextColor: fg,
      actorLineColor: muted,
      signalColor: fg,
      signalTextColor: fg,
      labelBoxBkgColor: soft('teal'),
      labelBoxBorderColor: c('teal'),
      labelTextColor: fg,
      noteBkgColor: soft('amber'),
      noteBorderColor: c('amber'),
      noteTextColor: fg,
      pieStrokeColor: surface,
      pieStrokeWidth: '2px',
      pieOuterStrokeColor: border,
      pieOuterStrokeWidth: '1px',
      pieTitleTextColor: fg,
      pieSectionTextColor: dark ? bg : '#ffffff',
      pieLegendTextColor: fg,
      pieOpacity: '0.9',
    };
    pies.forEach((n, i) => { vars['pie' + (i + 1)] = c(n); });
    pies.forEach((n, i) => { vars['cScale' + i] = soft(n); });
    return vars;
  }

  /** `heights`: previous height of the diagram at each position, held while a changed one renders. */
  async function renderDiagrams(scope, heights) {
    const hosts = Array.from(scope.querySelectorAll('.smd-diagram'));
    if (!hosts.length) return;
    if (typeof mermaid === 'undefined') {
      hosts.forEach((h) => h.setAttribute('title', uiLabel(h, 'mermaidMissing', 'Mermaid is not loaded — showing diagram source.')));
      return;
    }
    const theme = currentTheme();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: mermaidTheme(theme === 'dark'),
    });
    // Unchanged diagrams reuse their SVG synchronously, so they never flash back to source.
    const pending = [];
    reusedDiagrams = 0;
    hosts.forEach((host, i) => {
      const pre = host.querySelector('pre.smd-mermaid');
      const src = pre ? pre.textContent : host.getAttribute('data-src');
      if (!src) return;
      host.setAttribute('data-src', src);
      const key = diagramKey(theme, src);
      const svg = svgCache.get(key);
      if (svg !== undefined) {
        host.innerHTML = svg;
        reusedDiagrams++;
        return;
      }
      if (heights && heights[i]) {
        // Hold the space the diagram at this position took, so the page doesn't jump while it renders.
        host.classList.add('smd-diagram-pending');
        host.style.height = heights[i] + 'px';
      }
      pending.push({ host, src, key });
    });
    for (const { host, src, key } of pending) {
      const id = 'smd-mermaid-' + ++diagramSeq;
      try {
        const { svg } = await mermaid.render(id, src);
        svgCache.set(key, svg);
        host.innerHTML = svg;
      } catch (err) {
        const stray = document.getElementById('d' + id);
        if (stray) stray.remove();
        host.innerHTML =
          '<pre class="smd-mermaid">' + escapeHtml(src) + '</pre>' +
          '<span class="smd-error">' + escapeHtml(uiLabel(host, 'diagramError', 'Diagram error')) + ': ' + escapeHtml((err && err.message) || err) + '</span>';
      }
      host.classList.remove('smd-diagram-pending');
      host.style.height = '';
    }
  }

  const diagramHeights = () => Array.from(document.querySelectorAll('.smd-diagram')).map((h) => h.getBoundingClientRect().height);

  function rerenderDiagrams() {
    const a = captureAnchor();
    const heights = diagramHeights();
    document.querySelectorAll('.smd-diagram[data-src]').forEach((host) => {
      host.innerHTML = '<pre class="smd-mermaid">' + escapeHtml(host.getAttribute('data-src')) + '</pre>';
    });
    keepAnchor(a, renderDiagrams(document, heights));
  }

  /** Synchronous work (tabs, details, cached diagrams) is done when this returns; the promise settles after new diagrams render. */
  async function hydrate(scope, heights) {
    applyTheme();
    initTabs(scope);
    initDetails(scope);
    addCopyButtons(scope);
    refreshScrollers();
    await renderDiagrams(scope, heights);
    refreshScrollers();
    if (vscode && isPreview) {
      // Lets the extension (and its tests) know what actually rendered.
      vscode.postMessage({
        type: 'rendered',
        diagrams: document.querySelectorAll('.smd-diagram svg').length,
        errors: document.querySelectorAll('.smd-error').length,
        math: document.querySelectorAll('.katex').length,
        tabs: document.querySelectorAll('.smd-tabs.smd-js').length,
        theme: html.getAttribute('data-smd-theme'),
        reused: reusedDiagrams,
        top: (captureAnchor() || { line: 0 }).line,
        restore: intent ? 'waiting' : restoredFrom,
      });
    }
  }

  // ---- Editor integration (VS Code only) -----------------------------------
  function lineOf(el) {
    const node = el && el.closest ? el.closest('[data-line]') : null;
    return node ? Number(node.getAttribute('data-line')) : null;
  }

  // ---- Scroll anchoring ---------------------------------------------------
  // The preview remembers which source line is at the top of the viewport (plus the offset into
  // that element) rather than a pixel position, so re-renders and edits above don't move it.
  //
  // In VS Code the page is torn down while its panel is hidden and loads again when it is shown, and a
  // render sent to it meanwhile is lost. So a line number is kept with the document version it belongs to
  // (`place`), the extension sends every line edit with the version it produced, and mapAnchor() applies
  // the edits made after the place's version: the same result whichever of them the page saw before.
  let generation = 0;

  function lineItems() {
    const items = [];
    document.querySelectorAll('#smd-root [data-line]').forEach((el) => {
      if (!el.getClientRects().length) return; // hidden tab pane or closed details
      items.push({ line: Number(el.getAttribute('data-line')), top: el.getBoundingClientRect().top + window.scrollY });
    });
    return items;
  }

  function captureAnchor() {
    return window.scrollY > 0 ? pickAnchor(lineItems(), window.scrollY) : null;
  }

  /**
   * False when there is nothing to scroll in yet: a page loads without layout while its frame isn't displayed,
   * and with a layout that won't last while the frame has no size.
   */
  function restoreAnchor(a) {
    if (!a) return true;
    const items = window.innerWidth > 0 && window.innerHeight > 0 ? lineItems() : [];
    if (!items.length) return false;
    const { index, exact } = findLine(items, a.line);
    if (index >= 0) window.scrollTo({ top: items[index].top + (exact ? a.offset : 0) });
    return true;
  }

  /**
   * Restore now, and again once diagrams have rendered unless the user scrolled meanwhile.
   * Returns what the first restoreAnchor() did.
   */
  function keepAnchor(a, rendering) {
    const gen = ++generation;
    const shown = restoreAnchor(a);
    const y = window.scrollY;
    rendering.then(() => {
      if (a && gen === generation && window.scrollY === y) restoreAnchor(a);
    });
    return shown;
  }

  /** Show the place that is still waiting, if the page can by now; then save it, which also tells the extension. */
  function settle() {
    // A place newer than the document shown waits for the render of that version, which is on its way.
    if (!intent || intent.version > pageVersion || !restoreAnchor(intent.anchor)) return;
    intent = null;
    place = { anchor: captureAnchor(), version: pageVersion };
    saveState();
  }

  /** The rendered document changed (a message from the extension, or from the playground's editor). */
  function applyUpdate(msg) {
    html.setAttribute('data-smd-theme-pref', msg.themePref || 'auto');
    const root = document.getElementById('smd-root');
    const y = window.scrollY;
    const version = typeof msg.version === 'number' ? msg.version : pageVersion;
    // A place that is still waiting counts, not what the viewport shows meanwhile.
    const from = intent || { anchor: captureAnchor(), version: pageVersion };
    const a = mapAnchor(from.anchor, from.version, version, msg);
    const heights = diagramHeights();
    root.innerHTML = msg.html;
    pageVersion = version;
    const rendering = hydrate(root, heights);
    const shown = keepAnchor(a, rendering);
    if (!a) window.scrollTo({ top: y });
    intent = (shown || !vscode) ? null : { anchor: a, version };
    place = { anchor: intent ? a : captureAnchor(), version };
    saveState();
  }

  /** What the extension embedded in the page: the document version, the line edits it knows and the last place it heard of. */
  function embeddedSync() {
    const root = document.getElementById('smd-root');
    try {
      const sync = JSON.parse((root && root.dataset.smdSync) || 'null');
      if (sync && typeof sync.version === 'number') return sync;
    } catch { /* fall through */ }
    return { version: 0 };
  }

  /**
   * Coming back after the panel was hidden (the page is new, its state is not): go to the saved place,
   * brought up to date with the edits made since it was saved.
   */
  function restorePlace(rendering) {
    const sync = embeddedSync();
    pageVersion = sync.version;
    const mine = place;
    place = newerPlace(mine, sync.position);
    if (!place) return;
    restoredFrom = place === mine ? 'state' : 'host';
    const a = mapAnchor(place.anchor, place.version, pageVersion, sync);
    const shown = keepAnchor(a, rendering);
    if (place.version > pageVersion) intent = place;
    else if (!shown) intent = { anchor: a, version: pageVersion };
  }

  function scrollToLine(line) {
    let best = null;
    document.querySelectorAll('#smd-root [data-line]').forEach((el) => {
      const l = Number(el.getAttribute('data-line'));
      if (l <= line && (!best || l >= Number(best.getAttribute('data-line')))) best = el;
    });
    if (best) window.scrollTo({ top: best.getBoundingClientRect().top + window.scrollY - 12 });
    else if (line <= 0) window.scrollTo({ top: 0 });
  }

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (target.classList && target.classList.contains('smd-task-box')) {
      if (vscode) {
        vscode.postMessage({ type: 'toggleTask', line: Number(target.getAttribute('data-task-line')) });
      }
      return;
    }
    const a = target.closest && target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      e.preventDefault();
      const el = document.getElementById(decodeURIComponent(href.slice(1)));
      if (!el) return;
      el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      // Move focus too, as following the link would, so Tab continues from the target.
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
      return;
    }
    if (vscode) {
      e.preventDefault();
      vscode.postMessage({ type: 'openLink', href });
    }
  });

  document.addEventListener('dblclick', (e) => {
    const line = lineOf(e.target);
    if (vscode && isPreview && line !== null) vscode.postMessage({ type: 'revealLine', line });
  });

  // Renders and scroll sync from the extension (or the playground's editor). The Block Editor has its own messages.
  if (isPreview) {
    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === 'update') {
        applyUpdate(msg);
      } else if (msg.type === 'scrollToLine') {
        scrollToLine(msg.line);
      }
    });
  }

  // Follow VS Code / OS theme changes.
  new MutationObserver(() => { if (applyTheme()) rerenderDiagrams(); })
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (applyTheme()) rerenderDiagrams(); });
  }

  // ---- Printing -------------------------------------------------------------
  // Closed <details> can't be opened on paper, so open them for printing and close them again after.
  // `smd pdf` dispatches beforeprint itself, because headless printing doesn't.
  let openedForPrint = [];
  window.addEventListener('beforeprint', () => {
    openedForPrint = Array.from(document.querySelectorAll('details:not([open])'));
    openedForPrint.forEach((d) => { d.open = true; });
  });
  window.addEventListener('afterprint', () => {
    openedForPrint.forEach((d) => { d.open = false; });
    openedForPrint = [];
  });

  // ---- For the page's other scripts (the Block Editor's) ----------------------
  window.smdRuntime = Object.freeze({
    /** 'preview' or 'block-editor', from <body data-smd-mode>. */
    mode,
    /** The page's one acquireVsCodeApi() handle; null outside VS Code. */
    vscode,
    /**
     * Build tabs, details state, copy buttons and diagrams inside `scope` (an element just rendered; the whole page
     * when left out). Other elements keep their state. Resolves once its diagrams have rendered.
     */
    hydrate: (scope) => hydrate(scope || document),
    /** Tell screen readers something without moving focus. */
    announce: (text) => {
      ensureLiveRegion();
      announce(text);
    },
    /** What the page's other scripts saved with saveAppState(), kept across the panel being hidden. */
    appState: () => appState,
    /** Save state of the page's other scripts with the runtime's own (use this rather than vscode.setState()). */
    saveAppState: (value) => {
      appState = value;
      saveState();
    },
  });

  const rendering = hydrate(document);
  // data-smd-ready: diagrams rendered and fonts loaded, so the page can be printed (smd pdf waits for it).
  Promise.all([rendering, document.fonts ? document.fonts.ready : null])
    .catch(() => undefined)
    .finally(() => html.setAttribute('data-smd-ready', 'true'));
  // Coming back where the reader was, and keeping the extension posted.
  if (vscode && isPreview) {
    restorePlace(rendering);
    // A page that loaded before its frame was displayed gets its size, and with it a layout, later.
    window.addEventListener('resize', settle);
    if (typeof ResizeObserver === 'function') new ResizeObserver(settle).observe(html);
    let scrollTimer;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        // While a place is waiting, the viewport is not where the reader left it: don't save that instead.
        if (intent) {
          settle();
          return;
        }
        place = { anchor: captureAnchor(), version: pageVersion };
        saveState();
      }, 150);
    }, { passive: true });
    vscode.postMessage({ type: 'ready' });
  }
})();
