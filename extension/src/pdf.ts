import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireOptional, searchPaths } from './optionalPackage';

/**
 * `smd pdf`: print a rendered page to PDF with the headless Chromium of Playwright or Puppeteer, when the
 * user has installed one. smd doesn't bundle a browser; the packages are resolved at run time like
 * js-tiktoken (see optionalPackage.ts). Diagrams render in the page, so they print as vector SVG.
 */
export const PDF_FORMATS = ['A4', 'Letter'];

export interface PdfOptions {
  /** Paper size, one of PDF_FORMATS. */
  format: string;
  landscape: boolean;
  /** Milliseconds to wait for the page to load, and again for diagrams to render. */
  timeout: number;
}

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfError';
  }
}

/** True once the page runtime has rendered diagrams and loaded fonts (it sets data-smd-ready). */
export const PDF_READY_CHECK = "document.documentElement.getAttribute('data-smd-ready') === 'true'";

/** Headless printing doesn't fire beforeprint, on which the runtime expands collapsed blocks. */
export const PDF_BEFORE_PRINT = "window.dispatchEvent(new Event('beforeprint'))";

/** The same as the print stylesheet's @page margins, for browsers that don't apply those. */
const MARGIN = { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' };

const DEFAULT_TIMEOUT = 60_000;

/** The parts of a Playwright or Puppeteer page that printing uses. */
export interface PdfPage {
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  waitForFunction(expression: string, ...rest: unknown[]): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  pdf(options: Record<string, unknown>): Promise<Uint8Array>;
}

export interface PdfBrowser {
  newPage(): Promise<PdfPage>;
  close(): Promise<void>;
}

/** A browser package behind one interface: Playwright and Puppeteer differ in launching and waitForFunction. */
export interface PdfEngine {
  /** The package it came from. */
  name: string;
  launch(): Promise<PdfBrowser>;
  waitFor(page: PdfPage, expression: string, timeout: number): Promise<unknown>;
}

interface Launcher { launch(): Promise<PdfBrowser> }

/** Tried in this order; the first one installed wins. */
const PACKAGES: Array<{ name: string; adapt: (lib: unknown, name: string) => PdfEngine | undefined }> = [
  { name: 'playwright', adapt: playwrightEngine },
  { name: '@playwright/test', adapt: playwrightEngine },
  { name: 'puppeteer', adapt: puppeteerEngine },
];

export const PDF_MISSING_BROWSER = 'smd pdf needs a headless browser from Playwright or Puppeteer, which smd does not bundle. '
  + 'Install one in your project or globally, then run the command again:\n'
  + '  npm install --save-dev playwright && npx playwright install chromium\n'
  + '  npm install --save-dev puppeteer\n'
  + 'Or print without one: smd render <file.smd> -o page.html, open the page in a browser and choose '
  + 'Print → Save as PDF (the page has a print stylesheet).';

export interface LoadPdfEngineOptions {
  /** Folders to resolve the packages from, instead of the working directory, smd's folder and the global folders. */
  paths?: string[];
  /** Load a package by name, or return undefined when it isn't installed (replaces resolving from `paths`). */
  load?: (name: string) => unknown;
}

/** The first installed browser package. Throws a PdfError with install hints when there is none. */
export function loadPdfEngine(options: LoadPdfEngineOptions = {}): PdfEngine {
  const load = options.load ?? ((name: string) => requireOptional(name, options.paths ?? searchPaths()));
  for (const candidate of PACKAGES) {
    const engine = candidate.adapt(load(candidate.name), candidate.name);
    if (engine) return engine;
  }
  throw new PdfError(PDF_MISSING_BROWSER);
}

/** Playwright: `chromium.launch()`, and `waitForFunction(fn, arg, options)`. */
function playwrightEngine(lib: unknown, name: string): PdfEngine | undefined {
  const chromium = (lib as { chromium?: Partial<Launcher> } | undefined)?.chromium;
  if (!isLauncher(chromium)) return undefined;
  return {
    name,
    launch: () => chromium.launch(),
    waitFor: (page, expression, timeout) => page.waitForFunction(expression, undefined, { timeout }),
  };
}

/** Puppeteer: `launch()` on the module (or its default export), and `waitForFunction(fn, options)`. */
function puppeteerEngine(lib: unknown, name: string): PdfEngine | undefined {
  const mod = lib as (Partial<Launcher> & { default?: Partial<Launcher> }) | undefined;
  const puppeteer = isLauncher(mod) ? mod : mod?.default;
  if (!isLauncher(puppeteer)) return undefined;
  return {
    name,
    launch: () => puppeteer.launch(),
    waitFor: (page, expression, timeout) => page.waitForFunction(expression, { timeout }),
  };
}

function isLauncher(value: Partial<Launcher> | undefined): value is Launcher {
  return typeof value?.launch === 'function';
}

/** Options from `--format` (A4 or Letter, any case; default A4) and `--landscape`. Throws a PdfError on an unknown format. */
export function pdfOptions(format: string | undefined, landscape: boolean): PdfOptions {
  const match = PDF_FORMATS.find((f) => f.toLowerCase() === (format ?? 'A4').toLowerCase());
  if (!match) throw new PdfError(`--format needs one of: ${PDF_FORMATS.join(', ')}.`);
  return { format: match, landscape, timeout: DEFAULT_TIMEOUT };
}

/** The default output: the document's path with a .pdf extension. */
export function pdfPath(file: string): string {
  return path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.pdf');
}

/** Print the page at `url` to PDF: wait for the runtime to finish, expand collapsed blocks, print. */
export async function printPdf(engine: PdfEngine, url: string, options: PdfOptions, warn: (message: string) => void): Promise<Uint8Array> {
  const browser = await launch(engine);
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: options.timeout });
    try {
      await engine.waitFor(page, PDF_READY_CHECK, options.timeout);
    } catch {
      warn(`Diagrams had not finished rendering after ${options.timeout / 1000} s; printing the page as it is.`);
    }
    await page.evaluate(PDF_BEFORE_PRINT);
    return await page.pdf({ format: options.format, landscape: options.landscape, printBackground: true, margin: MARGIN });
  } finally {
    await browser.close();
  }
}

async function launch(engine: PdfEngine): Promise<PdfBrowser> {
  try {
    return await engine.launch();
  } catch (err) {
    throw new PdfError(`${engine.name} could not start its browser: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write the rendered page beside the document (so relative images and links resolve, and #anchor links stay
 * within the page), print it, write the PDF to `out` and remove the page again.
 */
export async function exportPdf(
  source: string, html: string, out: string, options: PdfOptions, io: { engine: PdfEngine; warn: (message: string) => void },
): Promise<void> {
  const page = path.join(path.dirname(path.resolve(source)), `.${path.basename(source)}.${process.pid}.print.html`);
  fs.writeFileSync(page, lightTheme(html));
  try {
    const pdf = await printPdf(io.engine, pathToFileURL(page).href, options, io.warn);
    fs.writeFileSync(out, pdf);
  } finally {
    fs.rmSync(page, { force: true });
  }
}

/** PDFs use the light theme, so diagrams (themed when they render) match the print stylesheet's palette. */
export function lightTheme(html: string): string {
  return html.replace(/<html lang="([^"]*)" data-smd-theme-pref="[a-z]+"/, '<html lang="$1" data-smd-theme-pref="light"');
}
