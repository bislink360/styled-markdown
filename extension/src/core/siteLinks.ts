import { escapeHtml } from './attrs';
import { findLinks, splitTarget } from './links';

/**
 * Paths and links of a static site (`smd build`). Every path here is relative to the source folder (for
 * documents) or the site folder (for pages), with `/` separators and no leading `./`, so the logic is the
 * same on every platform and in the browser.
 */

/** Source files rendered as pages: `.smd` always, `.md` and `.markdown` when the build includes them. */
export const PAGE_SOURCE = /\.(?:smd|md|markdown)$/i;

/** `guide/setup.smd` → `guide/setup.html`. */
export function pageOutput(source: string): string {
  return source.replace(PAGE_SOURCE, '.html');
}

/** The folder part of a path: `a/b/c.html` → `a/b`, `c.html` → ``. */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** Resolve a relative path against a folder; undefined when it climbs above the root. */
export function joinPath(dir: string, relative: string): string | undefined {
  const parts = dir ? dir.split('/') : [];
  for (const part of relative.split('/')) {
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else if (part && part !== '.') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** The relative URL path from the page `from` to the site file `to`, e.g. `guide/a.html` → `api/b.html` is `../api/b.html`. */
export function relativeHref(from: string, to: string): string {
  const fromDirs = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let common = 0;
  while (common < fromDirs.length && common < toParts.length - 1 && fromDirs[common] === toParts[common]) common++;
  return [...fromDirs.slice(common).map(() => '..'), ...toParts.slice(common)].map(encodeURIComponent).join('/');
}

/** Where links point: relative between pages (works from file://), or absolute under `base` (e.g. `/docs/`). */
export interface Linker {
  /** The href of the site file `to` from the page `from`. */
  href(from: string, to: string): string;
}

export function linker(base?: string): Linker {
  if (base === undefined) return { href: relativeHref };
  const root = normalizeBase(base);
  return { href: (_from, to) => root + to.split('/').map(encodeURIComponent).join('/') };
}

/** `docs` → `/docs/`, `https://x.dev/docs` → `https://x.dev/docs/`, `/` stays `/`. */
export function normalizeBase(base: string): string {
  const trimmed = base.trim();
  const withSlash = trimmed.endsWith('/') ? trimmed : trimmed + '/';
  return /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(withSlash) ? withSlash : '/' + withSlash;
}

/** A document's pages by source path, so links between documents can be followed. */
export interface LinkContext {
  /** Source path → page output path, for every document in the site. */
  pages: Map<string, string>;
  linker: Linker;
}

export interface RewriteResult {
  html: string;
  /** Local files (source-relative paths) the page links to that are not documents: images and downloads to copy. */
  assets: string[];
}

// `href="…"` and `src="…"` as the renderer writes them (always double-quoted; text content escapes its quotes).
const URL_ATTR = /(\s(?:href|src)=")([^"]*)"/g;

/**
 * Rewrite the links of a rendered page: links to other documents (`other.smd#anchor`, `.md` too) point at their
 * pages, local files are collected to copy (and made absolute under a base), external links and `#anchors` stay.
 */
export function rewriteLinks(html: string, source: string, page: string, context: LinkContext): RewriteResult {
  const assets = new Set<string>();
  const out = html.replace(URL_ATTR, (match: string, attr: string, value: string) => {
    const target = resolveLink(unescapeAttr(value), source, page, context, assets);
    return target === undefined ? match : `${attr}${escapeHtml(target)}"`;
  });
  return { html: out, assets: [...assets] };
}

/** The new URL of one link, or undefined to keep it. Collects the local files it points at. */
function resolveLink(url: string, source: string, page: string, context: LinkContext, assets: Set<string>): string | undefined {
  const local = localTarget(url, source);
  if (!local) return undefined;
  const output = context.pages.get(local.path);
  if (output !== undefined) return context.linker.href(page, output) + local.suffix;
  // A .smd file that isn't a page is outside the site or missing: leave the link as written.
  if (/\.smd$/i.test(local.path)) return undefined;
  assets.add(local.path);
  return context.linker.href(page, local.path) + local.suffix;
}

/** A relative link resolved against its document: the source-relative path and the `?query#fragment` kept as written. */
export function localTarget(url: string, source: string): { path: string; suffix: string } | undefined {
  if (!url || url.startsWith('#') || url.startsWith('/')) return undefined;
  const split = splitTarget(url);
  // A folder link (`guide/`) is left to the web server.
  if (!split?.path || split.path.endsWith('/')) return undefined;
  const path = joinPath(dirOf(source), split.path);
  if (!path) return undefined;
  const cut = url.search(/[?#]/);
  return { path, suffix: cut < 0 ? '' : url.slice(cut) };
}

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** For each document, the documents linking to it (by source path, each listed once, never itself). */
export function siteBacklinks(documents: Array<{ path: string; text: string }>): Map<string, string[]> {
  const known = new Set(documents.map((d) => d.path));
  const backlinks = new Map<string, Set<string>>();
  for (const doc of documents) {
    for (const link of findLinks(doc.text).links) {
      const target = localTarget(link.target, doc.path)?.path;
      if (target === undefined || target === doc.path || !known.has(target)) continue;
      const from = backlinks.get(target) ?? new Set<string>();
      from.add(doc.path);
      backlinks.set(target, from);
    }
  }
  return new Map([...backlinks].map(([target, from]) => [target, [...from]]));
}
