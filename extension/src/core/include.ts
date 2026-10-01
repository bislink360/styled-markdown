import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo, type ContainerInfo } from './containers';
import { parseFenceInfo } from './fence';
import { parseFrontMatter } from './frontmatter';
import { findSection, sectionsOf, slugify } from './sections';
import type { Heading } from './render';

/**
 * Transclusion: `:::include{file="shared/terms.smd" section="Pricing" level=3}` … `:::` stands for the body of
 * another document, or one section of it (its heading and subsections). The block's own body is fallback text
 * for places that can't include, such as older renderers.
 *
 * What every host shares: resolving paths, choosing the lines, following nested includes without cycles, and
 * the limits. Files are only read through the host's sandboxed reader (the one code embeds use), by a path
 * relative to the root document; a nested include's path is relative to the file it is written in.
 */

/** Includes nest at most `depth` deep; one document reads at most `count` includes and `chars` characters through them. */
export const INCLUDE_LIMITS = { depth: 8, count: 200, chars: 2_000_000 };

export interface IncludeRequest {
  file: string;
  section?: string;
  /** The heading level the included top heading becomes (1–6); other headings move with it. */
  level?: number;
}

export const isHeadingLevel = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 6;

/** A heading level moved by `shift`, kept within 1–6. */
export const shiftedLevel = (level: number, shift: number): number => Math.min(6, Math.max(1, level + shift));

/** What an `:::include` block's attributes ask for, or undefined without `file`. */
export function includeRequest(values: Record<string, string>): IncludeRequest | undefined {
  const file = values.file?.trim();
  if (!file) return undefined;
  const section = values.section?.trim();
  const level = Number(values.level);
  return { file, ...(section ? { section } : {}), ...(isHeadingLevel(level) ? { level } : {}) };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const isAbsolute = (p: string) => /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(p);

/** `a/./b/../c` → `a/c`, with forward slashes. Leading `..` segments stay. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return (/^[\\/]/.test(p) ? '/' : '') + out.join('/');
}

/** The folder of a root-relative path (`''` for a file next to the root document). */
export const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** `file`, written in a document in folder `dir`, as a path relative to the root document. */
export function includePath(dir: string, file: string): string {
  if (isAbsolute(file)) return file;
  return normalizePath(dir ? `${dir}/${file}` : file);
}

/** A link target written in a document included from folder `dir`, relative to the root document. Anchors and URLs stay. */
export function rebaseUrl(url: string, dir: string): string {
  if (!dir || !url || url.startsWith('#') || isAbsolute(url)) return url;
  const cut = url.search(/[?#]/);
  const path = cut < 0 ? url : url.slice(0, cut);
  const folder = path.endsWith('/') ? '/' : '';
  return includePath(dir, path) + folder + (cut < 0 ? '' : url.slice(cut));
}

/** `shared/terms.smd § Pricing` */
export const includeLabel = (path: string, section?: string): string => (section ? `${path} § ${section}` : path);

/** A link to the included file (and the section's likely anchor), for placeholders. None for a URL or a drive path. */
export function includeHref(path: string, section?: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
  return encodeURI(path) + (section ? `#${slugify(section)}` : '');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Where includes are resolved: the document being read, and the includes it is inside. */
export interface IncludeScope {
  /** The folder of the document being read, relative to the root document (`''` for the root itself). */
  dir: string;
  /** The included documents being read, outermost first, relative to the root document. */
  chain: string[];
  /** How many levels enclosing includes already move headings. */
  shift: number;
  /** The root document's text with `\n` line endings, so including it is caught as a cycle. */
  root?: string;
  /** What the whole document has included so far (shared by every scope of one document). */
  read: { count: number; chars: number };
}

const lf = (text: string) => text.replaceAll(/\r\n?/g, '\n');

export function rootScope(root?: string): IncludeScope {
  return { dir: '', chain: [], shift: 0, ...(root === undefined ? {} : { root: lf(root) }), read: { count: 0, chars: 0 } };
}

/** The scope of the document a loaded include reads. */
export function innerScope(scope: IncludeScope, include: LoadedInclude): IncludeScope {
  return { ...scope, dir: dirOf(include.path), chain: [...scope.chain, include.path], shift: include.shift };
}

export interface LoadedInclude {
  /** Relative to the root document. */
  path: string;
  request: IncludeRequest;
  /** Every line of the included file. */
  lines: string[];
  /** Zero-based first and last included line: the body after the front matter, or the section. */
  start: number;
  end: number;
  /** How many levels included headings move, enclosing includes' moves included. */
  shift: number;
}

export type IncludeProblem = 'unavailable' | 'missing-file' | 'missing-section' | 'cycle' | 'depth' | 'too-large';

export interface IncludeFailure {
  problem: IncludeProblem;
  path: string;
  request: IncludeRequest;
  /** For a cycle: the documents included, the repeated one last. */
  chain?: string[];
}

export type IncludeResult = { ok: true; include: LoadedInclude } | ({ ok: false } & IncludeFailure);

export interface IncludeSource {
  /** The host's sandboxed reader, by a path relative to the root document. Without one nothing is included. */
  readFile?: (relativePath: string) => string | undefined;
  /** The headings of a whole document, lines zero-based (as parseSmd finds them). */
  headings: (text: string) => Heading[];
}

/** Read what an include asks for, unless that would loop, nest too deep or read too much. */
export function loadInclude(request: IncludeRequest, scope: IncludeScope, source: IncludeSource): IncludeResult {
  const path = includePath(scope.dir, request.file);
  const fail = (problem: IncludeProblem, chain?: string[]): IncludeResult =>
    ({ ok: false, problem, path, request, ...(chain ? { chain } : {}) });
  if (!source.readFile) return fail('unavailable');
  if (scope.chain.includes(path)) return fail('cycle', [...scope.chain, path]);
  if (scope.chain.length >= INCLUDE_LIMITS.depth) return fail('depth');
  const text = source.readFile(path);
  if (text === undefined) return fail('missing-file');
  if (scope.root !== undefined && lf(text) === scope.root) return fail('cycle', [...scope.chain, path]);
  if (text.length > INCLUDE_LIMITS.chars) return fail('too-large');
  const lines = text.split(/\r?\n/);
  const range = includedRange(text, lines.length, request, source);
  if (!range) return fail('missing-section');
  if (!counted(scope.read, lines, range)) return fail('too-large');
  const own = request.level && range.top ? request.level - range.top : 0;
  return { ok: true, include: { path, request, lines, start: range.start, end: range.end, shift: scope.shift + own } };
}

interface LineRange { start: number; end: number; top?: number }

/** The included lines, and the level of their top heading when `level` needs it. */
function includedRange(text: string, lineCount: number, request: IncludeRequest, source: IncludeSource): LineRange | undefined {
  const body = { start: parseFrontMatter(text).bodyStartLine, end: lineCount - 1 };
  if (!request.section && !request.level) return body;
  const headings = source.headings(text);
  if (!request.section) return { ...body, top: headings.length ? Math.min(...headings.map((h) => h.level)) : undefined };
  const hit = findSection(sectionsOf(headings, lineCount), request.section);
  return hit && { start: hit.start, end: hit.end, top: hit.heading.level };
}

/** Count an include against the document's limits; false when it goes over them. */
function counted(read: IncludeScope['read'], lines: string[], range: LineRange): boolean {
  let chars = 0;
  for (let i = range.start; i <= range.end; i++) chars += lines[i].length + 1;
  read.count++;
  read.chars += chars;
  return read.count <= INCLUDE_LIMITS.count && read.chars <= INCLUDE_LIMITS.chars;
}

/** `a.smd → b.smd → a.smd`, or `this document → b.smd → a.smd` when the loop leads back to the root document. */
export function cycleText(chain: string[]): string {
  const last = chain[chain.length - 1];
  return (chain.indexOf(last) < chain.length - 1 ? chain : ['this document', ...chain]).join(' → ');
}

/** What went wrong, in a few words, for placeholders and agent-view pointers. */
export function includeProblemText(failure: IncludeFailure): string {
  switch (failure.problem) {
    case 'unavailable': return 'Include not available here';
    case 'missing-file': return 'Cannot read the file';
    case 'missing-section': return `No section "${failure.request.section}" in the file`;
    case 'cycle': return `Include cycle (${cycleText(failure.chain ?? [failure.path])})`;
    case 'depth': return `Includes nested more than ${INCLUDE_LIMITS.depth} deep`;
    default: return 'Too much included content';
  }
}

// ---------------------------------------------------------------------------
// Finding includes in text
// ---------------------------------------------------------------------------

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

function closesFence(line: string, fence: string): boolean {
  const m = FENCE.exec(line);
  return !!m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim();
}

/** The lines in [from, to] outside fenced code: their index, and whether the line opens a code fence. */
export function* outsideCode(lines: string[], from: number, to: number): Generator<[line: number, fence: boolean]> {
  let fence: string | null = null;
  for (let i = from; i <= to && i < lines.length; i++) {
    if (fence) {
      if (closesFence(lines[i], fence)) fence = null;
      continue;
    }
    const mark = FENCE.exec(lines[i]);
    if (mark) fence = mark[1];
    yield [i, !!mark];
  }
}

/** Indexes of the lines in [from, to] outside fenced code (fence lines themselves are left out too). */
function* outsideFences(lines: string[], from: number, to: number): Generator<number> {
  for (const [i, fence] of outsideCode(lines, from, to)) if (!fence) yield i;
}

/** ```ts file="code.ts" in a document included from folder `dir` embeds the file next to that document. */
export function rebaseFenceFile(info: string, dir: string): string {
  const file = dir ? parseFenceInfo(info).file : undefined;
  if (!file) return info;
  return info.replace(/\bfile=(?:"[^"]*"|'[^']*'|[^\s{}]+)/, () => `file="${includePath(dir, file)}"`);
}

export interface IncludeBlock { line: number; info: ContainerInfo }

/** Every `:::include` opening line in lines [from, to], outside code. */
export function findIncludes(lines: string[], from = 0, to = lines.length - 1): IncludeBlock[] {
  const found: IncludeBlock[] = [];
  for (const i of outsideFences(lines, from, to)) {
    const open = CONTAINER_OPEN.exec(lines[i]);
    const info = open ? parseContainerInfo(open[3] + open[4]) : null;
    if (info?.name === 'include') found.push({ line: i, info });
  }
  return found;
}

/** The line of the `:::` closing the container opened on line `open`, or the last line when it is never closed. */
export function containerEnd(lines: string[], open: number): number {
  let depth = 0;
  for (const i of outsideFences(lines, open + 1, lines.length - 1)) {
    if (CONTAINER_OPEN.test(lines[i])) depth++;
    else if (CONTAINER_CLOSE.test(lines[i]) && depth-- === 0) return i;
  }
  return lines.length - 1;
}
