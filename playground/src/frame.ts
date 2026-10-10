/**
 * The sandboxed preview frame. Shared links carry untrusted documents, and a document may hold raw HTML, so the
 * preview never touches the playground's own DOM: it is an `<iframe srcdoc>` whose sandbox has no
 * `allow-same-origin`, which gives it an opaque origin of its own. See playground/README.md for the threat model.
 *
 * A frame with an opaque origin can't load the app's files from file:// (and fonts not even over http, without
 * CORS headers), so the frame is self-contained: its stylesheet (with KaTeX's fonts as data: URLs), the page
 * runtime, the link handler and, for documents with diagrams, Mermaid are inlined. The inline scripts run because
 * the CSP lists their hashes (csp.mjs); nothing else inline can.
 */
import type { PreviewPane } from './panes';

/**
 * Scripts run so the page runtime can build tabs, copy buttons and Mermaid diagrams, but the opaque origin keeps
 * them away from the app's DOM, localStorage and cookies. Popups are allowed only so a clicked link can open in a
 * new tab (previewLinks.ts adds target="_blank" to http, https and mailto links); they escape the sandbox so the
 * linked site works normally. Not allowed: same-origin, top navigation, forms, modals, downloads, pointer lock.
 */
export const PREVIEW_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

/** What the frame is built from, embedded in app.js at build time (see scripts/build-playground.mjs). */
export interface FrameAssets {
  /** smd.css and KaTeX's stylesheet with its fonts inlined. */
  css: string;
  /** The page runtime (media/runtime.js). */
  runtime: string;
  /** The link handler (previewLinks.ts, bundled). */
  links: string;
  /** mermaid.min.js, once loaded; the frame shows diagram source until then. */
  mermaid?: string;
}

/** The app's theme setting: follow the system, or a fixed theme. */
export type ThemeSetting = 'auto' | 'light' | 'dark';

/** The preview's theme: a fixed app setting wins, else the document's own `theme`, else the system's. */
export function previewTheme(setting: ThemeSetting, preview: Pick<PreviewPane, 'theme'>): ThemeSetting {
  if (setting !== 'auto') return setting;
  return preview.theme ?? 'auto';
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/**
 * An inline script. Its text must stay byte-for-byte what the build hashed, so it is not escaped; the build
 * checks that none of the inlined files contains `</script`.
 */
function inlineScript(text: string): string {
  return `<script>${text}</script>\n`;
}

/**
 * The frame's whole document. Mermaid (large) is inlined only for documents with diagrams. `parentOrigin` is the
 * playground page's origin (`"null"` from file://): the frame takes its update port only from there.
 */
export function previewDocument(preview: PreviewPane, theme: ThemeSetting, assets: FrameAssets, parentOrigin = 'null'): string {
  const mermaid = preview.mermaid && assets.mermaid ? inlineScript(assets.mermaid) : '';
  return `<!DOCTYPE html>
<html lang="${escapeAttr(preview.lang)}" data-smd-theme-pref="${theme}" data-smd-parent-origin="${escapeAttr(parentOrigin)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${assets.css}
</style>
</head>
<body class="smd-body">
<main id="smd-root">${preview.html}</main>
${mermaid}${inlineScript(assets.runtime)}${inlineScript(assets.links)}</body>
</html>
`;
}

/** The runtime's update message: swaps the rendered HTML in place, keeping the scroll position. */
export function updateMessage(preview: PreviewPane, theme: ThemeSetting): { type: 'update'; html: string; themePref: ThemeSetting } {
  return { type: 'update', html: preview.html, themePref: theme };
}

/** What a built frame was built with. */
export interface FrameState {
  lang: string;
  /** Mermaid is inlined. */
  mermaid: boolean;
}

/**
 * True when the frame must be rebuilt rather than updated in place: there is none yet, the document's language
 * changed (it is on `<html lang>`), or the document has diagrams and Mermaid is available but not in the frame.
 * Mermaid stays once inlined.
 */
export function needsRebuild(built: FrameState | undefined, preview: PreviewPane, mermaidAvailable: boolean): boolean {
  if (!built) return true;
  return built.lang !== preview.lang || (preview.mermaid && mermaidAvailable && !built.mermaid);
}
