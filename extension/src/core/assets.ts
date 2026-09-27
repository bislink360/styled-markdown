import { renderStandaloneHtml, type RenderOptions } from './render';

// Injected at build time (see scripts/build.mjs) so the library and CLI can render full
// pages without shipping or locating separate files. Empty when running from source.
declare const __SMD_CSS__: string | undefined;
declare const __SMD_RUNTIME__: string | undefined;

/** The Styled Markdown stylesheet (light/dark themes, all components). */
export const SMD_CSS: string = typeof __SMD_CSS__ === 'string' ? __SMD_CSS__ : '';

/** Client runtime for rendered pages: tabs, Mermaid diagrams, copy buttons, theme switching. */
export const SMD_RUNTIME_JS: string = typeof __SMD_RUNTIME__ === 'string' ? __SMD_RUNTIME__ : '';

/**
 * Render an .smd document to a complete, self-contained HTML page with the default
 * stylesheet and runtime. Mermaid and KaTeX styles load from a CDN.
 */
export function renderPage(text: string, options: RenderOptions = {}): string {
  return renderStandaloneHtml(text, SMD_CSS, SMD_RUNTIME_JS, options);
}
