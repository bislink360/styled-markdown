import { escapeHtml } from './attrs';
import { EN, type Messages } from './i18n';
import { dirOf, type Linker } from './siteLinks';

/**
 * Navigation of a static site (`smd build`): the folder tree in the sidebar, breadcrumbs and previous/next
 * links. Folders and documents are ordered by title; a folder's `index` or `README` document is its overview page.
 */

/** A page of the site: a document, or a generated page (home index, dashboard) with an empty `source`. */
export interface SitePage {
  /** Source path relative to the source folder, `/`-separated; empty for generated pages. */
  source: string;
  /** Output path relative to the site folder, e.g. `guide/setup.html`. */
  output: string;
  title: string;
  summary?: string | null;
  status?: string | null;
}

export interface NavFolder {
  /** Folder name, e.g. `guide`; empty for the root. */
  name: string;
  /** The folder's `index`/`README` document, shown as the folder's link. */
  index?: SitePage;
  pages: SitePage[];
  folders: NavFolder[];
}

/** Overview pages of a folder, most preferred first. */
const INDEX_NAMES = ['index', 'readme'];

/** The folder label: its overview page's title, else its name. */
export const folderTitle = (folder: NavFolder): string => folder.index?.title ?? folder.name;

/** The folder tree of the documents (the home page is not in it), each level ordered by title. */
export function navTree(pages: SitePage[], home?: SitePage): NavFolder {
  const root: NavFolder = { name: '', pages: [], folders: [] };
  const docs = pages.filter((p) => p !== home && p.source);
  for (const page of [...docs].sort((a, b) => indexRank(a) - indexRank(b) || compareText(a.source, b.source))) {
    const folder = folderFor(root, dirOf(page.source));
    if (folder !== root && !folder.index && indexRank(page) < INDEX_NAMES.length * 2) folder.index = page;
    else folder.pages.push(page);
  }
  sortFolder(root);
  return root;
}

/** 0 for `index.smd`, 1 for `index.md`, 2 for `README.smd`…; large for other documents. */
function indexRank(page: SitePage): number {
  const file = page.source.slice(page.source.lastIndexOf('/') + 1).toLowerCase();
  const dot = file.lastIndexOf('.');
  const name = INDEX_NAMES.indexOf(file.slice(0, dot));
  return name < 0 ? Number.MAX_SAFE_INTEGER : name * 2 + (file.endsWith('.smd') ? 0 : 1);
}

function folderFor(root: NavFolder, dir: string): NavFolder {
  let folder = root;
  for (const name of dir ? dir.split('/') : []) {
    let child = folder.folders.find((f) => f.name === name);
    if (!child) {
      child = { name, pages: [], folders: [] };
      folder.folders.push(child);
    }
    folder = child;
  }
  return folder;
}

function sortFolder(folder: NavFolder): void {
  folder.pages.sort((a, b) => compareTitle(a.title, b.title) || compareText(a.source, b.source));
  folder.folders.sort((a, b) => compareTitle(folderTitle(a), folderTitle(b)) || compareText(a.name, b.name));
  folder.folders.forEach(sortFolder);
}

/** Case-insensitive, then byte order, so the order doesn't depend on the locale. */
function compareTitle(a: string, b: string): number {
  return compareText(a.toLowerCase(), b.toLowerCase()) || compareText(a, b);
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Reading order for previous/next: the home page, then each folder's overview, documents and subfolders. */
export function navOrder(tree: NavFolder, home?: SitePage): SitePage[] {
  const walk = (folder: NavFolder): SitePage[] => [
    ...(folder.index ? [folder.index] : []),
    ...folder.pages,
    ...folder.folders.flatMap(walk),
  ];
  return [...(home ? [home] : []), ...walk(tree)];
}

/** The sidebar: the tree as nested lists; folders on the way to the current page are open. */
export function sidebarHtml(tree: NavFolder, current: string, linker: Linker): string {
  return `<ul class="smd-site-tree">${folderItems(tree, current, linker)}</ul>`;
}

function folderItems(folder: NavFolder, current: string, linker: Linker): string {
  const pages = folder.pages.map((p) => `<li>${pageLink(p, current, linker)}</li>`);
  const folders = folder.folders.map((f) => {
    const open = contains(f, current) ? ' open' : '';
    const label = f.index ? pageLink(f.index, current, linker) : `<span>${escapeHtml(f.name)}</span>`;
    return `<li class="smd-site-folder"><details${open}><summary>${label}</summary>`
      + `<ul>${folderItems(f, current, linker)}</ul></details></li>`;
  });
  return [...pages, ...folders].join('');
}

function pageLink(page: SitePage, current: string, linker: Linker): string {
  const here = page.output === current ? ' aria-current="page"' : '';
  return `<a href="${escapeHtml(linker.href(current, page.output))}"${here}>${escapeHtml(page.title)}</a>`;
}

function contains(folder: NavFolder, output: string): boolean {
  return folder.index?.output === output || folder.pages.some((p) => p.output === output) || folder.folders.some((f) => contains(f, output));
}

/** Home › folders › page. A folder links to its overview page when it has one. */
export function breadcrumbsHtml(tree: NavFolder, page: SitePage, home: SitePage, linker: Linker, m: Messages = EN): string {
  if (page.output === home.output) return '';
  const crumbs = [`<a href="${escapeHtml(linker.href(page.output, home.output))}">${escapeHtml(home.title)}</a>`];
  let folder = tree;
  for (const name of page.source ? dirOf(page.source).split('/').filter(Boolean) : []) {
    const next = folder.folders.find((f) => f.name === name);
    if (!next || next.index === page) break;
    folder = next;
    crumbs.push(folder.index ? `<a href="${escapeHtml(linker.href(page.output, folder.index.output))}">${escapeHtml(folderTitle(folder))}</a>` : `<span>${escapeHtml(folder.name)}</span>`);
  }
  crumbs.push(`<span aria-current="page">${escapeHtml(page.title)}</span>`);
  return `<nav class="smd-site-crumbs" aria-label="${escapeHtml(m['site.breadcrumb'])}">${crumbs.join('<span class="smd-site-sep" aria-hidden="true">›</span>')}</nav>`;
}

/** Links to the previous and next page in reading order. */
export function pagerHtml(order: SitePage[], page: SitePage, linker: Linker, m: Messages = EN): string {
  const i = order.findIndex((p) => p.output === page.output);
  if (i < 0) return '';
  const link = (target: SitePage | undefined, rel: 'prev' | 'next', label: string) => (target
    ? `<a class="smd-site-${rel}" rel="${rel}" href="${escapeHtml(linker.href(page.output, target.output))}"><span>${label}</span>${escapeHtml(target.title)}</a>`
    : '<span></span>');
  return `<nav class="smd-site-pager" aria-label="${escapeHtml(m['site.pager'])}">`
    + `${link(order[i - 1], 'prev', m['site.previous'])}${link(order[i + 1], 'next', m['site.next'])}</nav>`;
}
