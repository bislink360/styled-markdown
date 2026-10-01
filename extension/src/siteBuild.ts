import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSite, type SiteBuild, type SiteSource } from './core/site';
import { readerFor } from './workspace';

/**
 * `smd build`: reads the documents of a folder, builds the static site (core/site.ts) and writes it. Writing is
 * careful: the output folder must not be inside the sources (or contain them), an existing folder is only written
 * to when it is empty or a previous build, and `--clean` only deletes the files a previous build recorded in its marker.
 */

/** Written into every build: the files it wrote, so `--clean` deletes exactly those and nothing else. */
export const SITE_MARKER = '.smd-site.json';
const MARKER_FORMAT = 'smd-site';

export interface BuildOptions {
  dir: string;
  out: string;
  title?: string;
  base?: string;
  today?: string;
  /** Also publish `.md` and `.markdown` files. */
  md: boolean;
  /** Delete the files of the previous build first. */
  clean: boolean;
  generator: string;
}

export interface BuildIo { err: (text: string) => void }

/** The build, or a message and exit code 2 on a usage problem. */
export function runBuild(options: BuildOptions, io: BuildIo): number {
  const dir = path.resolve(options.dir);
  const out = path.resolve(options.out);
  const problem = sourceProblem(dir) ?? outProblem(dir, out);
  if (problem) return usage(io, problem);
  const previous = previousBuild(out);
  if (typeof previous === 'string') return usage(io, previous);
  const sources = collectSources(dir, options.md);
  if (!sources.length) return usage(io, `No ${options.md ? '.smd or .md' : '.smd'} files found in ${options.dir}.`);
  if (options.clean && previous) removeFiles(out, previous);
  const site = buildSite(sources, {
    title: options.title, base: options.base, today: options.today, readFile: (source) => readerFor(path.join(dir, source)),
  });
  const written = writeSite(out, site);
  const copied = copyAssets(dir, out, site.assets);
  const built = new Set([...written, ...copied]);
  // Files of earlier builds that this one didn't write stay in the marker, so a later --clean still removes them.
  const stale = options.clean ? [] : (previous ?? []).filter((f) => !built.has(f));
  writeMarker(out, options.generator, [...built, ...stale]);
  report(io, options, site, { copied: copied.length, stale });
  return 0;
}

function writeMarker(out: string, generator: string, files: string[]): void {
  const sorted = [...files].sort((a, b) => a.localeCompare(b, 'en'));
  fs.writeFileSync(path.join(out, SITE_MARKER), JSON.stringify({ format: MARKER_FORMAT, generator, files: sorted }, null, 2) + '\n');
}

function usage(io: BuildIo, message: string): number {
  io.err(message);
  return 2;
}

function sourceProblem(dir: string): string | undefined {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return `build needs a folder of documents: ${dir} is not one.`;
  return undefined;
}

/** Whether `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The output folder can't be the source folder, be inside it, or contain it. */
export function outProblem(dir: string, out: string): string | undefined {
  if (isInside(dir, out)) return `--out ${out} is inside the source folder ${dir}: choose a folder outside it, e.g. --out ../site.`;
  if (isInside(out, dir)) return `--out ${out} contains the source folder ${dir}: choose a separate folder, e.g. --out site.`;
  return undefined;
}

/**
 * What is already in the output folder: undefined when it is missing or empty, the files of a previous build
 * (from its marker), or a message when it holds anything else, so nothing of the user's is overwritten.
 */
export function previousBuild(out: string): string[] | string | undefined {
  if (!fs.existsSync(out)) return undefined;
  if (!fs.statSync(out).isDirectory()) return `--out ${out} is a file, not a folder.`;
  if (!fs.readdirSync(out).length) return undefined;
  const marker = readMarker(path.join(out, SITE_MARKER));
  if (marker) return marker;
  return `--out ${out} is not empty and is not a previous smd build (no ${SITE_MARKER}). Choose an empty or new folder; smd build never overwrites other files.`;
}

function readMarker(file: string): string[] | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { format?: unknown; files?: unknown };
    if (data.format !== MARKER_FORMAT || !Array.isArray(data.files)) return undefined;
    return data.files.filter((f): f is string => typeof f === 'string');
  } catch {
    return undefined;
  }
}

/** `--clean`: delete the files the previous build wrote (only inside the output folder), then folders left empty. */
export function removeFiles(out: string, files: string[]): void {
  const dirs = new Set<string>();
  for (const rel of [...files, SITE_MARKER]) {
    const file = path.resolve(out, rel);
    if (file === out || !isInside(out, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    fs.unlinkSync(file);
    for (let d = path.dirname(file); d !== out && isInside(out, d); d = path.dirname(d)) dirs.add(d);
  }
  // Deepest first, so a folder is checked after its subfolders.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    if (fs.existsSync(d) && !fs.readdirSync(d).length) fs.rmdirSync(d);
  }
}

/** Documents under `dir` (paths relative to it, `/`-separated), skipping node_modules and dot folders. */
export function collectSources(dir: string, md: boolean): SiteSource[] {
  const pattern = md ? /\.(?:smd|md|markdown)$/i : /\.smd$/i;
  const sources: SiteSource[] = [];
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && pattern.test(entry.name)) sources.push({ path: toSitePath(dir, full), text: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  return sources;
}

function toSitePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function writeSite(out: string, site: SiteBuild): string[] {
  const written: string[] = [];
  for (const file of site.files) {
    const target = path.resolve(out, file.path);
    if (!isInside(out, target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
    written.push(file.path);
  }
  return written;
}

/** Copy the local files pages link to (images, downloads) that exist inside the source folder; dot files are never copied. */
function copyAssets(dir: string, out: string, assets: string[]): string[] {
  const realDir = fs.realpathSync(dir);
  const copied: string[] = [];
  for (const asset of assets) {
    if (asset.split('/').some((part) => part.startsWith('.') || part === 'node_modules') || asset === SITE_MARKER) continue;
    const source = path.resolve(dir, asset);
    const target = path.resolve(out, asset);
    if (!isInside(dir, source) || !isInside(out, target) || !fs.existsSync(source)) continue;
    if (!fs.statSync(source).isFile() || !isInside(realDir, fs.realpathSync(source))) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    copied.push(asset);
  }
  return copied;
}

function report(io: BuildIo, options: BuildOptions, site: SiteBuild, files: { copied: number; stale: string[] }): void {
  const pages = site.pages.filter((p) => p.source).length;
  for (const s of site.skipped) io.err(`[smd] skipped ${s}: another document has the same page path.`);
  const missing = site.assets.length - files.copied;
  const notFound = missing ? `; ${missing} linked file(s) not found or outside the folder` : '';
  io.err(`[smd] Built ${pages} page(s), a dashboard and a search index into ${options.out}; copied ${files.copied} linked file(s)${notFound}.`);
  if (files.stale.length) io.err(`[smd] ${files.stale.length} file(s) of the previous build are no longer part of the site; --clean removes them.`);
}
