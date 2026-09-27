/* Styled Markdown runtime — used by the VS Code preview and by exported HTML. */
(function () {
  'use strict';

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const html = document.documentElement;
  const svgCache = new Map();
  const tabState = new Map();
  let diagramSeq = 0;

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
  function initTabs(scope) {
    scope.querySelectorAll('.smd-tabs').forEach((tabs, groupIndex) => {
      if (tabs.classList.contains('smd-js')) return;
      const panes = Array.from(tabs.children).filter((el) => el.classList.contains('smd-tab'));
      if (!panes.length) return;
      const bar = document.createElement('div');
      bar.className = 'smd-tabbar';
      bar.setAttribute('role', 'tablist');
      const select = (i) => {
        tabState.set(groupIndex, i);
        panes.forEach((p, j) => p.classList.toggle('smd-active', i === j));
        bar.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
      };
      panes.forEach((pane, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'tab');
        btn.textContent = pane.getAttribute('data-title') || 'Tab ' + (i + 1);
        btn.addEventListener('click', () => select(i));
        bar.appendChild(btn);
      });
      tabs.insertBefore(bar, tabs.firstChild);
      tabs.classList.add('smd-js');
      select(Math.min(tabState.get(groupIndex) || 0, panes.length - 1));
    });
  }

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

  async function renderDiagrams(scope) {
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
    for (const host of hosts) {
      const pre = host.querySelector('pre.smd-mermaid');
      const src = pre ? pre.textContent : host.getAttribute('data-src');
      if (!src) continue;
      host.setAttribute('data-src', src);
      const key = theme + '\u0000' + src;
      if (svgCache.has(key)) {
        host.innerHTML = svgCache.get(key);
        continue;
      }
      const id = 'smd-mermaid-' + ++diagramSeq;
      try {
        const { svg } = await mermaid.render(id, src);
        svgCache.set(key, svg);
        if (svgCache.size > 100) svgCache.delete(svgCache.keys().next().value);
        host.innerHTML = svg;
      } catch (err) {
        const stray = document.getElementById('d' + id);
        if (stray) stray.remove();
        host.innerHTML =
          '<pre class="smd-mermaid">' + escapeHtml(src) + '</pre>' +
          '<span class="smd-error">Diagram error: ' + escapeHtml((err && err.message) || err) + '</span>';
      }
    }
  }

  function rerenderDiagrams() {
    document.querySelectorAll('.smd-diagram[data-src]').forEach((host) => {
      host.innerHTML = '<pre class="smd-mermaid">' + escapeHtml(host.getAttribute('data-src')) + '</pre>';
    });
    renderDiagrams(document);
  }

  async function hydrate(scope) {
    applyTheme();
    initTabs(scope);
    addCopyButtons(scope);
    await renderDiagrams(scope);
    if (vscode) {
      // Lets the extension (and its tests) know what actually rendered.
      vscode.postMessage({
        type: 'rendered',
        diagrams: document.querySelectorAll('.smd-diagram svg').length,
        errors: document.querySelectorAll('.smd-error').length,
        math: document.querySelectorAll('.katex').length,
        tabs: document.querySelectorAll('.smd-tabs.smd-js').length,
        theme: html.getAttribute('data-smd-theme'),
      });
    }
  }

  // ---- Editor integration (VS Code only) -----------------------------------
  function lineOf(el) {
    const node = el && el.closest ? el.closest('[data-line]') : null;
    return node ? Number(node.getAttribute('data-line')) : null;
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
      root.innerHTML = msg.html;
      hydrate(root);
      window.scrollTo({ top: y });
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

  hydrate(document);
})();
