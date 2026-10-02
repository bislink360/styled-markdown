import { SMD_CSS, SMD_RUNTIME_JS, SMD_SITE_CSS, SMD_SITE_JS } from './assets';
import { escapeHtml } from './attrs';
import { renderSmd, type Heading } from './render';
import { dashboardHtml } from './siteDashboard';
import { linker as makeLinker, PAGE_SOURCE, pageOutput, rewriteLinks, siteBacklinks, type Linker } from './siteLinks';
import { breadcrumbsHtml, folderTitle, navOrder, navTree, pagerHtml, sidebarHtml, type NavFolder, type SitePage } from './siteNav';
import { searchDoc, searchIndexScript } from './siteSearch';
import { STATUS_VALUES } from './spec';

/**
 * A static documentation site from .smd documents (`smd build`), as a list of files to write: one page per
 * document in the same folder structure, a home page, a dashboard, a search index and shared assets in `_smd/`.
 * Pure: the caller reads the documents and writes the files.
 */

/** A document to publish; `path` is relative to the source folder with `/` separators. */
export interface SiteSource { path: string; text: string }

export interface SiteAssets { css: string; runtimeJs: string; siteCss: string; siteJs: string }

export interface SiteOptions {
  /** Site title (default: the home document's title, else `Documentation`). */
  title?: string;
  /** Deployment path such as `/docs/` or `https://example.com/docs/`: links become absolute. Default: relative links. */
  base?: string;
  /** YYYY-MM-DD for due dates and overdue tasks; defaults to the current date. */
  today?: string;
  /** The file reader for a document's code embeds (```lang file="…"```). */
  readFile?: (source: string) => ((relativePath: string) => string | undefined) | undefined;
  /** Stylesheets and scripts to write to `_smd/` (default: the bundled ones). */
  assets?: Partial<SiteAssets>;
}

/** A file of the site: `path` relative to the site folder. */
export interface SiteFile { path: string; content: string }

export interface SiteBuild {
  files: SiteFile[];
  /** Local files the pages link to that are not documents (images, downloads), relative to the source folder, to copy. */
  assets: string[];
  pages: SitePage[];
  /** Documents left out because another document has the same page path (e.g. `a.md` next to `a.smd`). */
  skipped: string[];
}

/** Shared assets live here; a source folder with this name is left out. */
export const ASSET_DIR = '_smd';
export const SEARCH_INDEX = `${ASSET_DIR}/search-index.js`;

/** Root documents that become the home page, most preferred first. */
const HOME_NAMES = ['index.smd', 'index.md', 'index.markdown', 'readme.smd', 'readme.md', 'readme.markdown'];

interface BuiltPage extends SitePage {
  text: string;
  headings: Heading[];
  html: string;
  theme: string;
}

interface Site {
  title: string;
  home: SitePage;
  dashboard: SitePage;
  tree: NavFolder;
  order: SitePage[];
  linker: Linker;
  assets: SiteAssets;
}

/** Build the site: every document rendered, linked and wrapped in the site's navigation. */
export function buildSite(sources: SiteSource[], options: SiteOptions = {}): SiteBuild {
  const { chosen, skipped } = chooseSources(sources);
  const linker = makeLinker(options.base);
  const homePath = homeOf(chosen);
  const homeSource = chosen.find((s) => s.path === homePath);
  const outputs = new Map(chosen.map((s) => [s.path, s === homeSource ? 'index.html' : pageOutput(s.path)]));
  const assets = new Set<string>();
  const pages = chosen.map((s) => buildPage(s, outputs, linker, options, assets));
  const homePage = pages.find((p) => p.source === homeSource?.path);
  const title = options.title?.trim() || homePage?.title || 'Documentation';
  const taken = new Set(pages.map((p) => p.output));
  const dashboard: SitePage = { source: '', output: taken.has('dashboard.html') ? 'smd-dashboard.html' : 'dashboard.html', title: 'Dashboard' };
  const home: SitePage = homePage ?? { source: '', output: 'index.html', title };
  const tree = navTree(pages, homePage);
  const site: Site = { title, home, dashboard, tree, order: navOrder(tree, home), linker, assets: { ...defaultAssets(), ...options.assets } };
  const backlinks = siteBacklinks(chosen);
  const bySource = new Map(pages.map((p) => [p.source, p]));
  const files: SiteFile[] = pages.map((p) => ({ path: p.output, content: pageShell(site, p, p.html, backlinksHtml(p, backlinks, bySource, linker), p.theme) }));
  if (!homePage) files.push({ path: home.output, content: pageShell(site, home, homeIndexHtml(site), '') });
  const dashboardBody = dashboardHtml(pages, { linker, output: dashboard.output, today: options.today });
  files.push({ path: dashboard.output, content: pageShell(site, dashboard, dashboardBody, '') }, ...assetFiles(site, pages, options.today));
  return { files, assets: [...assets].sort(compareText), pages: site.order, skipped };
}

function defaultAssets(): SiteAssets {
  return { css: SMD_CSS, runtimeJs: SMD_RUNTIME_JS, siteCss: SMD_SITE_CSS, siteJs: SMD_SITE_JS };
}

/** One document per page path (`.smd` wins over `.md`), in path order; documents under `_smd/` are left out. */
function chooseSources(sources: SiteSource[]): { chosen: SiteSource[]; skipped: string[] } {
  const ordered = [...sources].filter((s) => PAGE_SOURCE.test(s.path))
    .sort((a, b) => Number(!a.path.endsWith('.smd')) - Number(!b.path.endsWith('.smd')) || compareText(a.path, b.path));
  const byOutput = new Map<string, SiteSource>();
  const skipped: string[] = [];
  for (const source of ordered) {
    const output = pageOutput(source.path).toLowerCase();
    if (byOutput.has(output) || source.path.startsWith(`${ASSET_DIR}/`)) skipped.push(source.path);
    else byOutput.set(output, source);
  }
  return { chosen: [...byOutput.values()].sort((a, b) => compareText(a.path, b.path)), skipped: skipped.sort(compareText) };
}

/** The root document that becomes the home page: `index`, else `README` (`.smd` before `.md`). */
function homeOf(sources: SiteSource[]): string | undefined {
  for (const name of HOME_NAMES) {
    const found = sources.find((s) => s.path.toLowerCase() === name);
    if (found) return found.path;
  }
  return undefined;
}

function buildPage(source: SiteSource, outputs: Map<string, string>, linker: Linker, options: SiteOptions, assets: Set<string>): BuiltPage {
  const output = outputs.get(source.path)!;
  const result = renderSmd(source.text, { readFile: options.readFile?.(source.path), today: options.today });
  const rewritten = rewriteLinks(result.html, source.path, output, { pages: outputs, linker });
  rewritten.assets.forEach((a) => assets.add(a));
  const data = result.frontMatter;
  return {
    source: source.path,
    output,
    title: pageTitle(data, result.headings, source.path),
    summary: typeof data.summary === 'string' ? data.summary : null,
    status: typeof data.status === 'string' ? data.status.toLowerCase() : null,
    text: source.text,
    headings: result.headings,
    html: rewritten.html,
    theme: ['light', 'dark'].includes(String(data.theme)) ? String(data.theme) : 'auto',
  };
}

/** Front matter `title`, else the first `#` heading, else the file name. */
function pageTitle(data: Record<string, unknown>, headings: Heading[], path: string): string {
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim();
  const h1 = headings.find((h) => h.level === 1);
  return h1?.text ?? path.slice(path.lastIndexOf('/') + 1).replace(PAGE_SOURCE, '');
}

function backlinksHtml(page: BuiltPage, backlinks: Map<string, string[]>, bySource: Map<string, BuiltPage>, linker: Linker): string {
  const from = (backlinks.get(page.source) ?? []).map((s) => bySource.get(s)).filter((p): p is BuiltPage => p !== undefined);
  if (!from.length) return '';
  const items = from
    .sort((a, b) => compareText(a.title.toLowerCase(), b.title.toLowerCase()) || compareText(a.source, b.source))
    .map((p) => `<li><a href="${escapeHtml(linker.href(page.output, p.output))}">${escapeHtml(p.title)}</a></li>`);
  return `<aside class="smd-site-backlinks" aria-label="Linked from"><h2>Linked from</h2><ul>${items.join('')}</ul></aside>`;
}

/** The generated home page when there is no index or README: every document by folder, with summary and status. */
function homeIndexHtml(site: Site): string {
  const count = site.order.filter((p) => p.source).length;
  const dashboard = `<a href="${escapeHtml(site.linker.href(site.home.output, site.dashboard.output))}">Dashboard</a>`;
  return `<article class="smd-doc smd-site-home"><h1 id="top">${escapeHtml(site.title)}</h1>`
    + `<p class="smd-site-lead">${count} document(s) · ${dashboard}</p>${folderIndex(site, site.tree, 2)}</article>`;
}

function folderIndex(site: Site, folder: NavFolder, level: number): string {
  const pages = [...(folder.index ? [folder.index] : []), ...folder.pages];
  const list = pages.length ? `<ul class="smd-site-index">${pages.map((p) => indexItem(site, p)).join('')}</ul>` : '';
  const heading = Math.min(level, 4);
  const sub = folder.folders.map((f) => `<h${heading}>${escapeHtml(folderTitle(f))}</h${heading}>${folderIndex(site, f, level + 1)}`);
  return list + sub.join('');
}

function indexItem(site: Site, page: SitePage): string {
  const status = page.status ? statusBadge(page.status) : '';
  const summary = page.summary ? `<div class="smd-site-summary">${escapeHtml(page.summary)}</div>` : '';
  return `<li><a href="${escapeHtml(site.linker.href(site.home.output, page.output))}">${escapeHtml(page.title)}</a>${status}${summary}</li>`;
}

function statusBadge(status: string): string {
  const known = STATUS_VALUES.includes(status) ? status : 'unknown';
  return ` <span class="smd-doc-status smd-doc-status-${known}">${escapeHtml(status)}</span>`;
}

/** The search index and the shared stylesheets and scripts. */
function assetFiles(site: Site, pages: BuiltPage[], today?: string): SiteFile[] {
  const docs = pages.map((p) => searchDoc(p, { today }));
  return [
    { path: `${ASSET_DIR}/smd.css`, content: site.assets.css },
    { path: `${ASSET_DIR}/site.css`, content: site.assets.siteCss },
    { path: `${ASSET_DIR}/runtime.js`, content: site.assets.runtimeJs },
    { path: `${ASSET_DIR}/site.js`, content: site.assets.siteJs },
    { path: SEARCH_INDEX, content: searchIndexScript({ v: 1, docs }) },
  ];
}

/** A page of the site: header with search, sidebar, breadcrumbs, the content, backlinks and previous/next. */
function pageShell(site: Site, page: SitePage, body: string, backlinks: string, theme = 'auto'): string {
  const href = (to: string) => escapeHtml(site.linker.href(page.output, to));
  const root = escapeHtml(site.linker.href(page.output, 'index.html').replace(/index\.html$/, ''));
  const title = page === site.home ? site.title : `${page.title} · ${site.title}`;
  const katex = body.includes('class="katex') ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">\n' : '';
  const mermaid = body.includes('class="smd-mermaid"') ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n' : '';
  return `<!DOCTYPE html>
<html lang="en" data-smd-theme-pref="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Styled Markdown">
<title>${escapeHtml(title)}</title>
${katex}<link rel="stylesheet" href="${href(`${ASSET_DIR}/smd.css`)}">
<link rel="stylesheet" href="${href(`${ASSET_DIR}/site.css`)}">
</head>
<body class="smd-body smd-site" data-smd-root="${root}">
<a class="smd-site-skip" href="#smd-root">Skip to content</a>
<header class="smd-site-bar">
<button type="button" class="smd-site-menu" aria-controls="smd-site-nav" aria-expanded="false"><span aria-hidden="true">☰</span><span class="smd-site-sr">Menu</span></button>
<a class="smd-site-title" href="${href(site.home.output)}">${escapeHtml(site.title)}</a>
<div class="smd-site-search" role="search"><input type="search" id="smd-site-q" placeholder="Search" aria-label="Search the documentation" autocomplete="off" spellcheck="false"><div id="smd-site-results" class="smd-site-results" hidden></div></div>
<a class="smd-site-dash" href="${href(site.dashboard.output)}">Dashboard</a>
</header>
<div class="smd-site-layout">
<nav id="smd-site-nav" class="smd-site-nav" aria-label="Documents">${sidebarHtml(site.tree, page.output, site.linker)}</nav>
<div class="smd-site-content">
${breadcrumbsHtml(site.tree, page, site.home, site.linker)}
<main id="smd-root" tabindex="-1">${body}</main>
${backlinks}${pagerHtml(site.order, page, site.linker)}
</div>
</div>
${mermaid}<script src="${href(`${ASSET_DIR}/runtime.js`)}"></script>
<script src="${href(`${ASSET_DIR}/site.js`)}"></script>
</body>
</html>
`;
}

/** Byte-order comparison, so the order doesn't depend on the locale. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
