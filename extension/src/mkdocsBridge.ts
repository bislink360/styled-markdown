import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadRuleConfig, type LoadedConfig } from './config';
import { SMD_CSS, SMD_RUNTIME_JS } from './core/assets';
import { parseFrontMatter } from './core/frontmatter';
import { renderParsed, type Heading } from './core/render';
import { relativeHref, rewriteLinks, type LinkContext } from './core/siteLinks';
import { validateSmd, type Diagnostic } from './core/validate';
import { isInside } from './siteBuild';
import { readerFor } from './workspace';

/**
 * The renderer behind the MkDocs plugin (integrations/mkdocs). The plugin starts one `node bridge.cjs` per build
 * and talks to it in JSON lines: one request object per stdin line, one response per stdout line, in order.
 *
 *   → {"id": 1, "method": "hello"}
 *   ← {"id": 1, "result": {"protocol": 1, "version": "1.7.0", "node": "20.11.0"}}
 *
 * Methods:
 * - `hello`: protocol and package version, and the Node version.
 * - `assets`: `css` (smd.css with its code colors limited to .smd code frames, so the theme's own code
 *   highlighting stays) and `runtimeJs` (tabs, diagrams, copy buttons, theme switching).
 * - `site`: `{docsDir, pages, lang?, today?}`, the docs folder and every page's source path (relative to it,
 *   with `/`) mapped to its URL (relative to the site root, as MkDocs builds it: `guide/setup/`). Call it once
 *   per build, before `render`.
 * - `render`: `{path, text?, header?, validate?}` renders one page: `html` with links between pages pointing
 *   at their URLs, `title` (front matter `title`, else the first `#` heading, else null), `headings` for the
 *   table of contents, `lang`, and with `validate` the document's `diagnostics` (1-based line and column).
 *   `text` defaults to the file; `header: false` leaves out the front matter header (for `.md` pages).
 *
 * Errors are `{"id": …, "error": {"message": "…"}}`; the bridge keeps serving after them.
 */

declare const __SMD_PKG_VERSION__: string | undefined;

export const BRIDGE_PROTOCOL = 1;

export interface BridgeResponse {
  id: unknown;
  result?: unknown;
  error?: { message: string };
}

export interface BridgeDiagnostic {
  line: number;
  column: number;
  severity: Diagnostic['severity'];
  code: string;
  message: string;
}

export interface BridgeRender {
  html: string;
  title: string | null;
  headings: Array<Pick<Heading, 'level' | 'text' | 'slug'>>;
  lang: string;
  diagnostics?: BridgeDiagnostic[];
}

interface SiteContext {
  docsDir: string;
  links: LinkContext;
  lang?: string;
  today?: string;
}

/** A request the bridge can't serve; its message goes back to the plugin. */
class RequestError extends Error {}

/** smd.css for a host page: the `.hljs` code colors only inside .smd code frames (as for VS Code's Markdown preview). */
export function scopeCodeColors(css: string): string {
  return css.replace(/^(\.hljs[^{]*)\{/gm, (_, selectors: string) => selectors.split(',').map((s) => '.smd-code ' + s.trim()).join(', ') + ' {');
}

/** A page URL as the plugin sends it, relative to the site root without a leading `./` (the home page is ``). */
function siteUrl(url: string): string {
  return url.replace(/^\.\//, '');
}

export class MkdocsBridge {
  private site?: SiteContext;
  private readonly configs = new Map<string, LoadedConfig>();

  /** One request line → one response (never throws). */
  handleLine(line: string): BridgeResponse {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      return { id: null, error: { message: 'Not valid JSON.' } };
    }
    return this.handle(request);
  }

  handle(request: unknown): BridgeResponse {
    const { id = null, method, params } = isObject(request) ? request : {};
    try {
      return { id, result: this.call(method, isObject(params) ? params : {}) };
    } catch (e) {
      const message = e instanceof RequestError ? e.message : `Internal error: ${(e as Error).message ?? String(e)}`;
      return { id, error: { message } };
    }
  }

  private call(method: unknown, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'hello':
        return { protocol: BRIDGE_PROTOCOL, version: typeof __SMD_PKG_VERSION__ === 'string' ? __SMD_PKG_VERSION__ : '0.0.0-dev', node: process.versions.node };
      case 'assets':
        return { css: scopeCodeColors(SMD_CSS), runtimeJs: SMD_RUNTIME_JS };
      case 'site':
        return this.setSite(params);
      case 'render':
        return this.render(params);
      default:
        throw new RequestError(`Unknown method: ${String(method)}.`);
    }
  }

  private setSite(params: Record<string, unknown>): { pages: number } {
    const docsDir = requireString(params, 'docsDir');
    const pages = isObject(params.pages) ? params.pages : {};
    const map = new Map<string, string>();
    for (const [source, url] of Object.entries(pages)) {
      if (typeof url === 'string') map.set(source, siteUrl(url));
    }
    this.site = {
      docsDir: path.resolve(docsDir),
      links: { pages: map, linker: { href: (from, to) => relativeHref(from, to) || './' } },
      lang: optionalString(params, 'lang'),
      today: optionalString(params, 'today'),
    };
    this.configs.clear();
    return { pages: map.size };
  }

  private render(params: Record<string, unknown>): BridgeRender {
    const site = this.site;
    if (!site) throw new RequestError('Call "site" before "render".');
    const source = requireString(params, 'path').replace(/\\/g, '/');
    const file = path.resolve(site.docsDir, source);
    if (!isInside(site.docsDir, file)) throw new RequestError(`${source} is outside the docs folder.`);
    const text = typeof params.text === 'string' ? params.text : readText(file, source);
    const readFile = readerFor(file, [site.docsDir]);
    const fm = parseFrontMatter(text);
    const result = renderParsed(text, fm, { readFile, today: site.today, lang: site.lang }, params.header !== false);
    const page = site.links.pages.get(source) ?? source;
    const html = rewriteLinks(result.html, source, page, site.links).html;
    const rendered: BridgeRender = {
      html,
      title: titleOf(result.frontMatter, result.headings),
      headings: result.headings.map(({ level, text: headingText, slug }) => ({ level, text: headingText, slug })),
      lang: result.lang ?? 'en',
    };
    if (params.validate === true) rendered.diagnostics = this.diagnostics(text, file, site);
    return rendered;
  }

  /** The document's problems, with the rules of its nearest `smd.config.json`/`.smdrc` (as `smd validate` reads them). */
  private diagnostics(text: string, file: string, site: SiteContext): BridgeDiagnostic[] {
    const dir = path.dirname(file);
    const fileExists = (relative: string) => {
      const target = path.resolve(dir, relative);
      return isInside(site.docsDir, target) && fs.existsSync(target);
    };
    const rules = loadRuleConfig(file, this.configs).rules;
    return validateSmd(text, { fileExists, readFile: readerFor(file, [site.docsDir]), today: site.today, rules })
      .sort((a, b) => a.line - b.line || a.column - b.column)
      .map((d) => ({ line: d.line + 1, column: d.column + 1, severity: d.severity, code: d.code, message: d.message }));
  }
}

/** Front matter `title`, else the first `#` heading, else null (the host picks its own fallback). */
function titleOf(data: Record<string, unknown>, headings: Heading[]): string | null {
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim();
  return headings.find((h) => h.level === 1)?.text ?? null;
}

function readText(file: string, source: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new RequestError(`Cannot read ${source}.`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || !value) throw new RequestError(`"${name}" must be a non-empty string.`);
  return value;
}

function optionalString(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' && value ? value : undefined;
}

/** Serve JSON lines from `input` until it ends: each line is answered, in order, by one `write` call. */
export function serveBridge(bridge: MkdocsBridge, input: NodeJS.ReadableStream, write: (line: string) => void): Promise<void> {
  let buffer = '';
  const flush = (all: boolean) => {
    const lines = buffer.split('\n');
    buffer = all ? '' : lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) write(JSON.stringify(bridge.handleLine(line.trim())) + '\n');
    }
  };
  return new Promise((resolve) => {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      flush(false);
    });
    input.on('end', () => {
      flush(true);
      resolve();
    });
  });
}
