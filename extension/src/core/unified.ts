import { parseFrontMatter } from './frontmatter';
import { renderParsed, type ParsedDocument, type RenderOptions, type RenderResult } from './render';

/*
 * remark and rehype plugins for unified pipelines (Astro, Docusaurus, MDX, plain unified).
 * Both render the file's whole source with renderSmd and put the HTML into the tree as one
 * node, so every .smd construct renders exactly as `smd render` does. unified, mdast, hast and
 * vfile are described structurally below: nothing is imported from them at runtime.
 */

/** The parts of a unified VFile the plugins read (`value`, `path`, `data`) and write (`data.smd`). */
export interface SmdVFile {
  value?: unknown;
  path?: string;
  /** `any`, not `unknown`: vfile's `Data` is an interface, and only `any` index signatures accept interfaces. */
  data?: Record<string, any>;
}

/** A node of an mdast or hast tree. */
export interface SmdNode {
  type: string;
  value?: string;
}

/** The root of an mdast or hast tree. */
export interface SmdTree {
  type: string;
  children?: SmdNode[];
}

export interface SmdPluginOptions extends Omit<RenderOptions, 'readFile'> {
  /** Render only files whose path matches, e.g. `/\.smd$/`. Default: every file. */
  test?: RegExp | ((path: string) => boolean);
  /** Render the title/status/owners header from front matter. Default true; false when the site layout shows the title. */
  header?: boolean;
  /**
   * Front matter the host already removed from the source. Default: Astro's
   * `file.data.astro.frontmatter`, then `file.data.matter` (vfile-matter), then `file.data.frontmatter`.
   * Only used when the source itself has no front matter.
   */
  frontMatter?: (file: SmdVFile) => Record<string, unknown> | undefined;
  /** Read a file relative to the document, for ```lang file="…"` embeds and `:::include`; `file.path` is the document. */
  readFile?: (relativePath: string, file: SmdVFile) => string | undefined;
}

/** What the plugins leave in `file.data.smd` for the host (e.g. its own table of contents). */
export interface SmdFileData {
  frontMatter: Record<string, unknown>;
  headings: RenderResult['headings'];
}

/** Nodes kept when the tree is replaced: front matter nodes and MDX import/export statements. */
const KEPT_NODES = new Set(['yaml', 'toml', 'mdxjsEsm']);

/** remark plugin: replaces the mdast with one `html` node (raw HTML must be allowed downstream). */
export function remarkSmd(options: SmdPluginOptions = {}) {
  return (tree: SmdTree, file: SmdVFile): void => replaceTree(tree, file, options, 'html');
}

/** rehype plugin: replaces the hast with one `raw` node (for pipelines configured only with rehype plugins). */
export function rehypeSmd(options: SmdPluginOptions = {}) {
  return (tree: SmdTree, file: SmdVFile): void => replaceTree(tree, file, options, 'raw');
}

function replaceTree(tree: SmdTree, file: SmdVFile, options: SmdPluginOptions, type: 'html' | 'raw'): void {
  const result = renderSmdFile(file, options);
  if (!result) return;
  const kept = (tree.children ?? []).filter((node) => KEPT_NODES.has(node.type));
  tree.children = [...kept, { type, value: result.html }];
}

/** Render a unified file as .smd; undefined when `options.test` leaves it out. */
export function renderSmdFile(file: SmdVFile, options: SmdPluginOptions = {}): RenderResult | undefined {
  if (!pathMatches(file.path, options.test)) return undefined;
  const source = fileText(file.value);
  const own = parseFrontMatter(source);
  const doc: ParsedDocument = own.present ? own : { data: hostFrontMatter(file, options), body: source, bodyStartLine: 0 };
  const result = renderParsed(source, doc, renderOptions(file, options), options.header ?? true);
  const smd: SmdFileData = { frontMatter: result.frontMatter, headings: result.headings };
  if (file.data) file.data.smd = smd;
  else file.data = { smd };
  return result;
}

function pathMatches(path: string | undefined, test: SmdPluginOptions['test']): boolean {
  if (!test) return true;
  if (!path) return false;
  if (typeof test === 'function') return test(path);
  test.lastIndex = 0;
  return test.test(path);
}

function fileText(value: unknown): string {
  if (typeof value === 'string') return value;
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : '';
}

function renderOptions(file: SmdVFile, options: SmdPluginOptions): RenderOptions {
  const { allowHtml, agentBlocks, today, readFile } = options;
  return { allowHtml, agentBlocks, today, readFile: readFile && ((path: string) => readFile(path, file)) };
}

function hostFrontMatter(file: SmdVFile, options: SmdPluginOptions): Record<string, unknown> {
  const found: unknown = options.frontMatter ? options.frontMatter(file) : knownFrontMatter(file.data ?? {});
  return isRecord(found) ? plainDates(found) : {};
}

/** Where hosts leave front matter they parsed: Astro, vfile-matter, then a plain `frontmatter` key. */
function knownFrontMatter(data: Record<string, unknown>): unknown {
  const astro = data.astro;
  return (isRecord(astro) ? astro.frontmatter : undefined) ?? data.matter ?? data.frontmatter;
}

/** YAML parsers that create Date objects (Astro's does): show `updated` as YYYY-MM-DD, as smd's own parser keeps it. */
function plainDates(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) out[key] = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
