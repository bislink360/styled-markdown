/* Styled Markdown in VS Code's built-in Markdown preview (.md files): theme colors and Mermaid diagrams. */
(function () {
  'use strict';

  const script = document.currentScript;
  // Mermaid (~3 MB) is only loaded for documents with diagrams; a script added with this
  // script's nonce passes the preview's Content Security Policy.
  const nonce = script ? script.nonce : '';
  const mermaidUrl = script ? new URL('vendor/mermaid.min.js', script.src).href : '';
  let mermaidLoad;
  let diagramSeq = 0;

  function isDark() {
    const c = document.body.classList;
    if (c.contains('vscode-high-contrast-light') || c.contains('vscode-light')) return false;
    return c.contains('vscode-dark') || c.contains('vscode-high-contrast');
  }

  /** smd.css switches its palette on this attribute, as in the .smd preview. */
  function applyTheme() {
    const theme = isDark() ? 'dark' : 'light';
    if (document.documentElement.getAttribute('data-smd-theme') === theme) return false;
    document.documentElement.setAttribute('data-smd-theme', theme);
    return true;
  }

  function loadMermaid() {
    if (typeof mermaid !== 'undefined') return Promise.resolve(true);
    if (!mermaidUrl) return Promise.resolve(false);
    mermaidLoad = mermaidLoad || new Promise((resolve) => {
      const tag = document.createElement('script');
      tag.src = mermaidUrl;
      if (nonce) tag.nonce = nonce;
      tag.onload = () => resolve(true);
      tag.onerror = () => resolve(false);
      document.head.appendChild(tag);
    });
    return mermaidLoad;
  }

  function showError(host, src, message) {
    host.textContent = '';
    const pre = document.createElement('pre');
    pre.className = 'smd-mermaid';
    pre.textContent = src;
    const error = document.createElement('div');
    error.className = 'smd-error';
    error.textContent = 'Mermaid: ' + message;
    host.append(pre, error);
  }

  /** Render `.smd-diagram` blocks; `all` re-renders drawn ones too (after a theme change). */
  async function renderDiagrams(all) {
    const hosts = Array.from(document.querySelectorAll('.smd-diagram'))
      .filter((h) => all ? h.hasAttribute('data-src') || h.querySelector('pre.smd-mermaid') : h.querySelector('pre.smd-mermaid'));
    if (!hosts.length || !(await loadMermaid())) return;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default' });
    for (const host of hosts) {
      const pre = host.querySelector('pre.smd-mermaid');
      const src = host.getAttribute('data-src') || (pre ? pre.textContent : '');
      host.setAttribute('data-src', src);
      try {
        const { svg } = await mermaid.render('smd-md-mermaid-' + ++diagramSeq, src);
        host.innerHTML = svg;
      } catch (e) {
        showError(host, src, e && e.message ? e.message : String(e));
      }
    }
  }

  function update() {
    applyTheme();
    renderDiagrams(false);
  }

  function start() {
    update();
    // VS Code changes the body's theme classes when the color theme changes.
    new MutationObserver(() => { if (applyTheme()) renderDiagrams(true); })
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  window.addEventListener('vscode.markdown.updateContent', update);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
