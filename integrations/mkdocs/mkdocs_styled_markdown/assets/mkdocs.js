// Styled Markdown in MkDocs: smd blocks follow the theme's light or dark mode, not the system's.
// The mkdocs theme sets <html data-bs-theme="dark">, Material <body data-md-color-scheme="slate">;
// other themes are light. Loaded before runtime.js, which reads data-smd-theme-pref.
(function () {
  var html = document.documentElement;
  function themeMode() {
    var body = document.body;
    var dark = html.dataset.bsTheme === 'dark' ||
      (body && body.dataset.mdColorScheme === 'slate');
    return dark ? 'dark' : 'light';
  }
  function sync() {
    var mode = themeMode();
    if (html.dataset.smdThemePref === mode) return;
    html.dataset.smdThemePref = mode;
    // The runtime re-applies the theme (and redraws diagrams) when the body's classes change.
    if (document.body) document.body.classList.toggle('smd-theme-sync');
  }
  sync();

  // smd has highlighted its code already. Themes that run highlight.js on every <pre><code> after the page
  // loads (the mkdocs theme) would redo it with their colors, so mark smd's code blocks as not for them.
  document.querySelectorAll('.smd-code pre > code').forEach(function (code) {
    code.className = 'nohighlight';
  });
  var observer = new MutationObserver(sync);
  observer.observe(html, { attributes: true, attributeFilter: ['data-bs-theme'] });
  if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['data-md-color-scheme'] });
})();
