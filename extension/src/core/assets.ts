import { pageHtml, renderStandaloneHtml, type RenderOptions } from './render';
import { riskRegisterHtml } from './riskHtml';
import type { RiskRegister } from './risks';

// Injected at build time (see scripts/build.mjs) so the library and CLI can render full
// pages without shipping or locating separate files. Empty when running from source.
declare const __SMD_CSS__: string | undefined;
declare const __SMD_RUNTIME__: string | undefined;
declare const __SMD_SITE_CSS__: string | undefined;
declare const __SMD_SITE_JS__: string | undefined;

/** The Styled Markdown stylesheet (light/dark themes, all components). */
export const SMD_CSS: string = typeof __SMD_CSS__ === 'string' ? __SMD_CSS__ : '';

/** Client runtime for rendered pages: tabs, Mermaid diagrams, copy buttons, theme switching. */
export const SMD_RUNTIME_JS: string = typeof __SMD_RUNTIME__ === 'string' ? __SMD_RUNTIME__ : '';

/** Layout of a static site (`smd build`): sidebar, breadcrumbs, search box, dashboard. Used with SMD_CSS. */
export const SMD_SITE_CSS: string = typeof __SMD_SITE_CSS__ === 'string' ? __SMD_SITE_CSS__ : '';

/** Script of a static site: the collapsible sidebar and the search box (no innerHTML with document text). */
export const SMD_SITE_JS: string = typeof __SMD_SITE_JS__ === 'string' ? __SMD_SITE_JS__ : '';

/**
 * Render an .smd document to a complete, self-contained HTML page with the default
 * stylesheet and runtime. Mermaid and KaTeX styles load from a CDN.
 */
export function renderPage(text: string, options: RenderOptions = {}): string {
  return renderStandaloneHtml(text, SMD_CSS, SMD_RUNTIME_JS, options);
}

/**
 * A risk register (from `riskRegister`) as a complete, self-contained HTML page: an impact × likelihood
 * matrix whose cells link to the register table below it. Follows the reader's light/dark theme.
 */
export function renderRiskPage(register: RiskRegister, options: { title?: string; theme?: 'light' | 'dark' | 'auto' } = {}): string {
  const title = options.title ?? 'Risk register';
  const body = riskRegisterHtml(register, title);
  return pageHtml({ title, theme: options.theme ?? 'auto', body, css: SMD_CSS, runtimeJs: SMD_RUNTIME_JS, cdn: false });
}
