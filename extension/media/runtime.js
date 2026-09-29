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

  if (typeof document === 'undefined') {
    if (typeof module === 'object' && module.exports) {
      module.exports = { mapLine, pickAnchor, findLine, stableKeys, lruCache, diagramKey };
    }
    return;
  }

  // ---- Page state ----------------------------------------------------------

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const html = document.documentElement;
  const svgCache = lruCache(100);
  let diagramSeq = 0;
  let reusedDiagrams = 0;
  // UI state kept across re-renders (and, in VS Code, across the panel being hidden):
  // active tab per tab group and user-toggled <details>, keyed by content, not position.
  const saved = (vscode && vscode.getState()) || {};
  const ui = { tabs: saved.tabs || {}, open: saved.open || {} };
  let anchor = saved.anchor || null;
  let saveTimer;

  function saveState() {
    if (!vscode) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => vscode.setState({ anchor, tabs: ui.tabs, open: ui.open }), 100);
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

  function initTabs(scope) {
    const groups = Array.from(scope.querySelectorAll('.smd-tabs'));
    const keys = stableKeys(groups.map((g) => 'tabs:' + panesOf(g).map((p) => p.getAttribute('data-title') || '').join('\u0001')));
    ui.tabs = Object.fromEntries(keys.filter((k) => k in ui.tabs).map((k) => [k, ui.tabs[k]]));
    groups.forEach((tabs, groupIndex) => {
      if (tabs.classList.contains('smd-js')) return;
      const panes = panesOf(tabs);
      if (!panes.length) return;
      const key = keys[groupIndex];
      const bar = document.createElement('div');
      bar.className = 'smd-tabbar';
      bar.setAttribute('role', 'tablist');
      const select = (i, user) => {
        if (user) { ui.tabs[key] = i; saveState(); }
        panes.forEach((p, j) => p.classList.toggle('smd-active', i === j));
        bar.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
      };
      panes.forEach((pane, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'tab');
        btn.textContent = pane.getAttribute('data-title') || 'Tab ' + (i + 1);
        btn.addEventListener('click', () => select(i, true));
        bar.appendChild(btn);
      });
      tabs.insertBefore(bar, tabs.firstChild);
      tabs.classList.add('smd-js');
      select(Math.min(ui.tabs[key] || 0, panes.length - 1));
    });
  }

  // ---- Open/closed <details> (collapsible callouts, details, agent blocks) --
  function initDetails(scope) {
    const all = Array.from(scope.querySelectorAll('details'));
    const keys = stableKeys(all.map((d) => {
      const summary = d.querySelector(':scope > summary');
      return 'details:' + (summary ? summary.textContent.trim() : '');
    }));
    const live = {};
    all.forEach((d, i) => {
      const key = keys[i];
      d.setAttribute('data-smd-key', key);
      d.setAttribute('data-smd-default', d.open ? 'open' : 'closed');
      // A user toggle wins only while the source default it overrode is unchanged.
      const state = ui.open[key];
      if (state && state[0] === d.open) {
        d.open = state[1];
        live[key] = state;
      }
    });
    ui.open = live;
  }

  document.addEventListener('toggle', (e) => {
    const d = e.target;
    const key = d && d.getAttribute && d.getAttribute('data-smd-key');
    if (!key) return;
    const dflt = d.getAttribute('data-smd-default') === 'open';
    if (d.open === dflt) delete ui.open[key];
    else ui.open[key] = [dflt, d.open];
    saveState();
  }, true);

  // ---- Copy buttons -------------------------------------------------------
  function addCopyButtons(scope) {
    scope.querySelectorAll('.smd-code').forEach((block) => {
      if (block.querySelector('.smd-copy')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'smd-copy';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        const code = block.querySelector('code');
        if (!code || !navigator.clipboard) return;
        navigator.clipboard.writeText(code.textContent || '').then(() => {
          btn.textContent = 'Copied';
          setTimeout(() => (btn.textContent = 'Copy'), 1200);
        });
      });
      block.appendChild(btn);
    });
  }

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
      hosts.forEach((h) => h.setAttribute('title', 'Mermaid is not loaded — showing diagram source.'));
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
          '<span class="smd-error">Diagram error: ' + escapeHtml((err && err.message) || err) + '</span>';
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
    await renderDiagrams(scope, heights);
    if (vscode) {
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

  function restoreAnchor(a) {
    if (!a) return;
    const items = lineItems();
    const { index, exact } = findLine(items, a.line);
    if (index >= 0) window.scrollTo({ top: items[index].top + (exact ? a.offset : 0) });
  }

  /** Restore now, and again once diagrams have rendered unless the user scrolled meanwhile. */
  function keepAnchor(a, rendering) {
    const gen = ++generation;
    restoreAnchor(a);
    const y = window.scrollY;
    rendering.then(() => {
      if (a && gen === generation && window.scrollY === y) restoreAnchor(a);
    });
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
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (vscode) {
      e.preventDefault();
      vscode.postMessage({ type: 'openLink', href });
    }
  });

  document.addEventListener('dblclick', (e) => {
    const line = lineOf(e.target);
    if (vscode && line !== null) vscode.postMessage({ type: 'revealLine', line });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'update') {
      html.setAttribute('data-smd-theme-pref', msg.themePref || 'auto');
      const root = document.getElementById('smd-root');
      const y = window.scrollY;
      const before = captureAnchor();
      const a = before && { line: mapLine(before.line, msg.edits), offset: before.offset };
      const heights = diagramHeights();
      root.innerHTML = msg.html;
      const rendering = hydrate(root, heights);
      if (a) keepAnchor(a, rendering);
      else window.scrollTo({ top: y });
      anchor = captureAnchor();
      saveState();
    } else if (msg.type === 'scrollToLine') {
      scrollToLine(msg.line);
    }
  });

  // Follow VS Code / OS theme changes.
  new MutationObserver(() => { if (applyTheme()) rerenderDiagrams(); })
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (applyTheme()) rerenderDiagrams(); });
  }

  const rendering = hydrate(document);
  if (vscode) {
    // Coming back after the panel was hidden: restore the saved position, adjusted for edits
    // made while it was away (the extension embeds those in the page).
    const root = document.getElementById('smd-root');
    let edits = [];
    try { edits = JSON.parse((root && root.getAttribute('data-smd-edits')) || '[]'); } catch { /* ignore */ }
    if (anchor) keepAnchor({ line: mapLine(anchor.line, edits), offset: anchor.offset }, rendering);
    let scrollTimer;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => { anchor = captureAnchor(); saveState(); }, 150);
    }, { passive: true });
    vscode.postMessage({ type: 'ready' });
  }
})();
