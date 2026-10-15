// The HTML page a Styled Markdown webview loads: a strict Content Security Policy with a fresh nonce, the
// stylesheets, the body and the scripts. Shared by the preview and the Block Editor. No `vscode` import: callers
// pass the webview's CSP source and URLs as strings, so the unit tests can check what comes out.
import { randomBytes } from 'node:crypto';
import { escapeHtml } from './core/attrs';

/** What goes into a webview page. */
export interface WebviewShellOptions {
  /** The webview's `cspSource`: where its stylesheets, images and fonts may come from. */
  cspSource: string;
  /** For the CSP and every script; a fresh one when left out. Pass one only to test. */
  nonce?: string;
  /** `<html lang>`. */
  lang: string;
  /** More attributes on `<html>` after `lang`, such as `data-smd-theme-pref`. */
  htmlAttributes?: Record<string, string>;
  /** `<base href>`, against which the document's relative links and images resolve. */
  baseHref?: string;
  /** Stylesheet URLs, in order. */
  styles: readonly string[];
  /** `class` of `<body>`. */
  bodyClass: string;
  /**
   * `data-smd-mode` on `<body>`, which media/runtime.js reads: left out for the preview (its default), or
   * `block-editor`, where the runtime leaves the preview's scroll and editor wiring out.
   */
  mode?: string;
  /** More attributes on `<body>`, after `class` and `data-smd-mode`. */
  bodyAttributes?: Record<string, string>;
  /** The body's content (trusted HTML), before the scripts. */
  body: string;
  /** Script URLs, in the order they run; each carries the nonce. */
  scripts: readonly string[];
}

/** A nonce for one page load. CSP nonces must be unguessable. */
export function webviewNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * The page's Content Security Policy: nothing by default; images, styles and fonts from the webview's own
 * resources (images also over https and as data:); scripts only with the nonce; no form submits anywhere.
 */
export function webviewCsp(cspSource: string, nonce: string): string {
  return [
    `default-src 'none'`,
    `img-src ${cspSource} https: data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    `form-action 'none'`,
  ].join('; ');
}

const ATTRIBUTE_NAME = /^[a-z][a-z0-9-]*$/i;

/** ` name="value"` for each attribute, values escaped. */
function attributes(attrs: Record<string, string | undefined>): string {
  return Object.entries(attrs)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => {
      if (!ATTRIBUTE_NAME.test(name)) throw new Error(`Not an attribute name: ${name}`);
      return ` ${name}="${escapeHtml(value)}"`;
    })
    .join('');
}

/** The whole page. */
export function webviewShell(options: WebviewShellOptions): string {
  const nonce = options.nonce ?? webviewNonce();
  const html = attributes({ lang: options.lang, ...options.htmlAttributes });
  const body = attributes({ class: options.bodyClass, 'data-smd-mode': options.mode, ...options.bodyAttributes });
  const base = options.baseHref === undefined ? '' : `<base href="${escapeHtml(options.baseHref)}">\n`;
  const styles = options.styles.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">\n`).join('');
  const scripts = options.scripts.map((src) => `<script nonce="${nonce}" src="${escapeHtml(src)}"></script>\n`).join('');
  return `<!DOCTYPE html>
<html${html}>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${webviewCsp(options.cspSource, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
${base}${styles}</head>
<body${body}>
${options.body}
${scripts}</body>
</html>`;
}
