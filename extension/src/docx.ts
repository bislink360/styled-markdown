import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `smd docx` and Export to Word (.docx): the "pandoc" profile of a document (smdToPandocHtml) converted by
 * Pandoc, when the user has installed it. smd doesn't bundle Pandoc, as it doesn't bundle a browser for PDF:
 * it is found at `--pandoc <path>` (or the `smd.export.pandocPath` setting), the SMD_PANDOC environment
 * variable, or on the PATH.
 */

export const PANDOC_INSTALL_URL = 'https://pandoc.org/installing.html';

/** Pandoc can't be used as asked: it is missing, or an option points at nothing. The CLI exits 2. */
export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxError';
  }
}

export const DOCX_MISSING_PANDOC = 'smd docx needs Pandoc (3.0 or later), which smd does not bundle. Install it from '
  + `${PANDOC_INSTALL_URL} (for example winget install JohnMacFarlane.Pandoc, brew install pandoc or `
  + 'apt install pandoc), then run the command again. If it is installed but not on your PATH, pass '
  + '--pandoc <path> or set SMD_PANDOC.\n'
  + 'Or convert the document yourself: smd docx <file.smd> --html-only -o page.html, then run '
  + 'pandoc page.html -f html -t docx -o page.docx in the document\'s folder.';

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
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? fileExists;
  for (const [given, source] of [[options.explicit, '--pandoc'], [env.SMD_PANDOC, 'SMD_PANDOC']] as const) {
    if (!given) continue;
    if (!isFile(given)) throw new DocxError(`Pandoc was not found at ${given} (from ${source}). ${PANDOC_INSTALL_URL}`);
    return given;
  }
  const platform = options.platform ?? process.platform;
  // Only an executable: Node can't start Windows .cmd and .bat files without a shell.
  const name = platform === 'win32' ? 'pandoc.exe' : 'pandoc';
  // The searched platform's own rules, not the host's (they differ in tests and when paths come from elsewhere).
  const { delimiter, join } = platform === 'win32' ? path.win32 : path.posix;
  const found = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, name)).find(isFile);
  if (!found) throw new DocxError(DOCX_MISSING_PANDOC);
  return found;
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
