import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { smdToDocx, type DocxWriterOptions } from './core/docxWriter';
import { unzipEntry } from './core/zip';

/**
 * `smd docx` and Export to Word (.docx), with one of two engines:
 *
 * - **Pandoc**, when the user has installed it: the "pandoc" profile of the document (smdToPandocHtml) converted
 *   by Pandoc, found at `--pandoc <path>` (or the editors' setting), the SMD_PANDOC environment variable, or on
 *   the PATH. smd doesn't bundle it. Its Word files have native equations.
 * - **the built-in writer** (core/docxWriter.ts, since 2.4.0), when Pandoc isn't there: nothing to install.
 *
 * chooseDocxEngine picks one; `--engine builtin|pandoc` asks for one.
 */

export const PANDOC_INSTALL_URL = 'https://pandoc.org/installing.html';

/** Pandoc can't be used as asked: it is missing, or an option points at nothing. The CLI exits 2. */
export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxError';
  }
}

export const DOCX_MISSING_PANDOC = 'smd docx --engine pandoc needs Pandoc (3.0 or later), which smd does not bundle. '
  + `Install it from ${PANDOC_INSTALL_URL} (for example winget install JohnMacFarlane.Pandoc, brew install pandoc or `
  + 'apt install pandoc), then run the command again. If it is installed but not on your PATH, pass '
  + '--pandoc <path> or set SMD_PANDOC.\n'
  + 'Or leave out --engine pandoc to write the .docx with smd\'s built-in writer, or convert the document yourself: '
  + 'smd docx <file.smd> --html-only -o page.html, then run pandoc page.html -f html -t docx -o page.docx in the '
  + 'document\'s folder.';

/** The engines of `--engine`. */
export const DOCX_ENGINES = ['builtin', 'pandoc'] as const;

/** The engine that writes the .docx: the built-in writer, or Pandoc at a path. */
export type DocxEngine = { name: 'builtin' } | { name: 'pandoc'; pandoc: string };

export interface FindPandocOptions {
  /** A path given by the user (`--pandoc`, or the editor setting); it must exist. */
  explicit?: string;
  /** Default: process.env (SMD_PANDOC, PATH, PATHEXT). */
  env?: NodeJS.ProcessEnv;
  /** Default: process.platform. */
  platform?: NodeJS.Platform;
  /** Default: a file exists at the path. */
  isFile?: (file: string) => boolean;
}

/** The Pandoc to run: `explicit`, else SMD_PANDOC, else the first `pandoc` on the PATH. Throws a DocxError without one. */
export function findPandoc(options: FindPandocOptions = {}): string {
  const found = configuredPandoc(options) ?? pandocOnPath(options);
  if (!found) throw new DocxError(DOCX_MISSING_PANDOC);
  return found;
}

/** `explicit`, else SMD_PANDOC; undefined when neither is set. Throws a DocxError when the one set doesn't exist. */
function configuredPandoc(options: FindPandocOptions): string | undefined {
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? fileExists;
  for (const [given, source] of [[options.explicit, '--pandoc'], [env.SMD_PANDOC, 'SMD_PANDOC']] as const) {
    if (!given) continue;
    if (!isFile(given)) throw new DocxError(`Pandoc was not found at ${given} (from ${source}). ${PANDOC_INSTALL_URL}`);
    return given;
  }
  return undefined;
}

/** The first `pandoc` on the PATH, else undefined. */
function pandocOnPath(options: FindPandocOptions): string | undefined {
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? fileExists;
  const platform = options.platform ?? process.platform;
  // Only an executable: Node can't start Windows .cmd and .bat files without a shell.
  const name = platform === 'win32' ? 'pandoc.exe' : 'pandoc';
  // The searched platform's own rules, not the host's (they differ in tests and when paths come from elsewhere).
  const { delimiter, join } = platform === 'win32' ? path.win32 : path.posix;
  return (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, name)).find(isFile);
}

export interface ChooseDocxEngineOptions extends FindPandocOptions {
  /** `--engine` (or the editors' setting): `builtin`, `pandoc`, or undefined (or `auto`) to choose. */
  engine?: string;
}

/**
 * The engine to write a .docx with. `--engine` decides when given (`pandoc` without Pandoc is a DocxError).
 * Otherwise Pandoc when it is set (`--pandoc`, SMD_PANDOC; a path that doesn't exist is a DocxError) or on the
 * PATH, so a .docx comes out as it did before 2.4.0; else the built-in writer.
 */
export function chooseDocxEngine(options: ChooseDocxEngineOptions = {}): DocxEngine {
  const engine = options.engine?.trim().toLowerCase() || 'auto';
  if (engine === 'builtin') return { name: 'builtin' };
  if (engine === 'pandoc') return { name: 'pandoc', pandoc: findPandoc(options) };
  if (engine !== 'auto') throw new DocxError(`--engine must be ${DOCX_ENGINES.join(' or ')}, not "${options.engine}".`);
  const pandoc = configuredPandoc(options) ?? pandocOnPath(options);
  return pandoc ? { name: 'pandoc', pandoc } : { name: 'builtin' };
}

export interface BuiltinDocxOptions extends Pick<DocxWriterOptions, 'readFile' | 'lang' | 'agentBlocks'> {
  /** The .docx to write. */
  out: string;
  /** The document's folder: images are read relative to it, as Pandoc's --resource-path finds them. */
  resourcePath: string;
  /** A .docx whose styles to use (a Pandoc reference document works: the style names are Pandoc's). */
  referenceDoc?: string;
}

/**
 * Write a .docx with the built-in writer. Returns its warnings (images it could not embed); throws a DocxError
 * when the reference document is missing or not a .docx.
 */
export function exportBuiltinDocx(text: string, options: BuiltinDocxOptions): string[] {
  const styles = options.referenceDoc ? referenceStyles(options.referenceDoc) : undefined;
  const result = smdToDocx(text, {
    readFile: options.readFile,
    lang: options.lang,
    agentBlocks: options.agentBlocks,
    styles,
    readBinary: (rel) => readImage(options.resourcePath, rel),
    deflate: (data) => deflateRawSync(data),
  });
  fs.writeFileSync(options.out, result.data);
  return result.warnings;
}

function readImage(dir: string, rel: string): Uint8Array | undefined {
  try {
    return fs.readFileSync(path.resolve(dir, rel));
  } catch {
    return undefined;
  }
}

/** The `word/styles.xml` of a .docx. Throws a DocxError when the file is missing, isn't a .docx or has no styles. */
export function referenceStyles(file: string): string {
  if (!fileExists(file)) throw new DocxError(`Reference document not found: ${file}`);
  let styles: Uint8Array | undefined;
  try {
    styles = unzipEntry(fs.readFileSync(file), 'word/styles.xml', (data) => inflateRawSync(data));
  } catch (err) {
    throw new DocxError(`Reference document ${file} is not a .docx: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!styles) throw new DocxError(`Reference document ${file} has no styles (word/styles.xml).`);
  return new TextDecoder().decode(styles);
}

function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export interface DocxOptions {
  /** The .docx to write. */
  out: string;
  /** Where Pandoc finds the document's images: its folder. */
  resourcePath: string;
  /** A .docx whose styles (fonts, headings, captions, quotes) Pandoc uses. */
  referenceDoc?: string;
}

/** Pandoc's arguments: HTML on stdin to a .docx. */
export function pandocArgs(options: DocxOptions): string[] {
  const args = ['--from', 'html', '--to', 'docx', '--output', options.out, '--resource-path', options.resourcePath];
  if (options.referenceDoc) args.push('--reference-doc', options.referenceDoc);
  return args;
}

/** The default output: the document's path with a .docx extension. */
export function docxPath(file: string): string {
  return path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.docx');
}

/** Starts a process; child_process.spawn, or a stand-in in tests. */
export type Spawn = typeof spawn;

/**
 * Convert the Pandoc HTML to a .docx. Resolves with Pandoc's warnings (images it could not find, say); rejects
 * with a DocxError when the reference document is missing, and an Error when Pandoc fails or can't start.
 */
export async function exportDocx(pandoc: string, html: string, options: DocxOptions, run: Spawn = spawn): Promise<string> {
  if (options.referenceDoc && !fileExists(options.referenceDoc)) throw new DocxError(`Reference document not found: ${options.referenceDoc}`);
  return new Promise((resolve, reject) => {
    const child = run(pandoc, pandocArgs(options), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => reject(new Error(`Could not run Pandoc (${pandoc}): ${err.message}`)));
    child.on('close', (code) => {
      const output = stderr.trim();
      if (code === 0) resolve(output);
      else reject(new Error(output ? `Pandoc exited with code ${code}:\n${output}` : `Pandoc exited with code ${code}.`));
    });
    // Pandoc closing its input early (it failed) is reported by 'close'.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(html, 'utf8');
  });
}
