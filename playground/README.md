# Styled Markdown playground

A static web page for trying `.smd` without installing anything: edit on the left; the **Preview**, **Agent view** (with its token estimate), **Diagnostics** and **Markdown** export update on the right as you type. **Copy link** puts the whole document in the link, so a document can be shared without a server.

It runs the same engine as the extension and the CLI (`extension/src/core`), entirely in the browser. Nothing is uploaded and there is no backend.

## Build and open

```bash
cd extension
npm ci
npm run build:playground
```

This writes `extension/dist/playground/`. Open `index.html` from there directly (`file://`), or serve the folder with any static server. To put it somewhere else: `node scripts/build-playground.mjs --out <dir>`.

| File | What it is |
|---|---|
| `index.html`, `app.css` | The page, with its Content Security Policy written in by the build |
| `app.js` | The editor and the engine, with the preview's stylesheet (KaTeX fonts inlined), page runtime and link handler embedded |
| `vendor/mermaid-source.js` | Mermaid (3.5 MB), loaded only when a document has a diagram |
| `vendor/*.LICENSE` | Licenses of the bundled KaTeX and Mermaid |

Hosting it (for example on GitHub Pages) is a separate maintainer decision and is not set up in this repository. Each GitHub Release attaches the built folder as `styled-markdown-playground.zip`.

## Sharing by link

**Copy link** compresses the document (UTF-8, deflate-raw through the browser's `CompressionStream`) and appends it as base64url after `#smd=`. The part of a URL after `#` is never sent to a server, so a shared document goes only where the link goes. Links longer than 8 KB get a warning, because chat apps and mail clients may cut them off. Opening a link loads its document; once you edit it, the link is dropped from the address bar so a reload opens your draft. The draft is kept in this browser's `localStorage` when storage is available.

Source: `src/codec.ts`.

## Threat model

A shared link carries a document written by someone else, and `.smd` allows raw HTML. The playground treats every document as untrusted.

**What must not happen:** a document runs script in the playground page; reads or changes its storage (the draft, the theme) or DOM; navigates the page or opens windows on its own; sends the document or anything about the reader to a server; or hangs the tab.

**How it is prevented:**

1. **The rendered document lives only in a sandboxed frame.** The preview is an `<iframe srcdoc>` with `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` and without `allow-same-origin`. The frame therefore has an opaque origin: its scripts can't read the parent's DOM, `localStorage` or cookies (the browser throws `SecurityError`), and without `allow-top-navigation`, `allow-forms`, `allow-modals` or `allow-downloads` it can't navigate the page, submit forms, show dialogs or start downloads.
2. **Only known scripts run, even inside the frame.** `allow-scripts` is there for the page runtime (tabs, copy buttons, Mermaid). A `srcdoc` frame inherits the page's Content Security Policy, whose `script-src` is `'self'` plus the SHA-256 hashes of exactly three inline scripts: the runtime, the link handler and Mermaid. A document's own `<script>`, `on…=` attributes and `javascript:` URLs match none of them and are blocked. There is no `'unsafe-inline'` or `'unsafe-eval'` for scripts.
3. **No network.** `default-src 'none'`: nothing may connect (`fetch`, WebSocket), images are limited to the app's files and `data:` URLs (so a document can't load a tracking pixel and learn who opened the link), fonts to the app and `data:`, and frames, `<base>` and form targets are blocked.
4. **The page never turns document text into markup.** The agent view, diagnostics and Markdown export are set with `textContent`; a test checks that `main.ts` uses no HTML sinks (`innerHTML`, `document.write`, `eval` and similar). The page listens to no messages from the frame.
5. **Links can't take over the preview.** `http`, `https` and `mailto` links open in a new tab (`rel="noopener noreferrer"`); other links (relative files, `javascript:`, `data:`) do nothing. If the frame does navigate away, it is rebuilt on the next edit.
6. **No file access.** The playground has no file reader, so `:::include` blocks and `file="…"` code embeds show their fallback notes and read nothing.
7. **Bounded decoding.** A link's document is decompressed to at most 2 MB, so a small crafted link can't expand into gigabytes; damaged or foreign fragments show a message instead of failing.

**Accepted risks:**

- `allow-popups-to-escape-sandbox` lets a clicked link open a normal page in a new tab, as any link on the web does. It needs a click.
- `style-src 'unsafe-inline'` is needed for the stylesheet, the renderer's `style="…"` attributes and Mermaid's SVG. A document can restyle its own preview, nothing else; CSS can't load remote resources under this policy.
- A sandboxed frame can't write to the clipboard in every browser, so a code block's copy button may not work in the preview. The page's own **Copy link** and **Copy Markdown** buttons are not affected.
- Remote images in a document don't show in the playground (they do in the extension and in exported HTML). That is the price of no tracking pixels.
- Whoever hosts the playground serves its scripts; the CSP's `'self'` trusts that origin. Host it on an origin that serves nothing else, if possible.

Tests: `extension/test/playground.test.ts` (sandbox flags, CSP, hashes matching the inlined scripts, no HTML sinks, link handling, the codec's limits).

## Layout

| Path | Role |
|---|---|
| `index.html`, `app.css` | The page |
| `starter.smd` | The example document shown on first visit |
| `src/main.ts` | DOM wiring only: editor, tabs, buttons |
| `src/panes.ts` | `renderPanes(text)`: preview HTML, agent view, diagnostics, Markdown |
| `src/codec.ts` | Share-by-URL encoding |
| `src/frame.ts`, `src/csp.mjs` | The sandboxed preview frame and the CSP |
| `src/previewLinks.ts` | Link handling inside the frame |
| `src/editor.ts`, `src/storage.ts` | Tab indentation, offsets and line numbers; guarded `localStorage` |
