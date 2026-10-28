import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { PdfBrowser, PdfEngine, PdfPage } from './pdf';

/**
 * PDF printing with a Chromium-based browser that is already installed (Chrome, Edge, Chromium or Brave), so
 * `smd export --to pdf` and the editors' Export to PDF work without Playwright or Puppeteer. The browser runs
 * headless and is driven over the DevTools protocol on a pipe (`--remote-debugging-pipe`: fd 3 to the
 * browser, fd 4 back, NUL-separated JSON), which needs nothing beyond Node itself.
 */

export interface InstalledBrowser {
  /** A name for messages: "Google Chrome", "Microsoft Edge", or the path when it was given. */
  name: string;
  /** The executable. */
  path: string;
}

export interface FindBrowserOptions {
  /** Default: process.env (PROGRAMFILES, LOCALAPPDATA, HOME, PATH). */
  env?: NodeJS.ProcessEnv;
  /** Default: process.platform. */
  platform?: NodeJS.Platform;
  /** Default: a file exists at the path. */
  isFile?: (file: string) => boolean;
}

/** Windows: [name, install folder below Program Files or the user's local app data]. */
const WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ['Google Chrome', 'Google\\Chrome\\Application\\chrome.exe'],
  ['Microsoft Edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['Chromium', 'Chromium\\Application\\chrome.exe'],
  ['Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
];
const WINDOWS_ROOTS = ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'];

/** macOS: [name, executable inside /Applications or ~/Applications]. */
const MAC: ReadonlyArray<readonly [string, string]> = [
  ['Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Microsoft Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['Chromium', 'Chromium.app/Contents/MacOS/Chromium'],
  ['Brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
];

/** Linux and other Unix systems: [name, command on the PATH]. */
const UNIX: ReadonlyArray<readonly [string, string]> = [
  ['Google Chrome', 'google-chrome'],
  ['Google Chrome', 'google-chrome-stable'],
  ['Chromium', 'chromium'],
  ['Chromium', 'chromium-browser'],
  ['Microsoft Edge', 'microsoft-edge'],
  ['Microsoft Edge', 'microsoft-edge-stable'],
  ['Brave', 'brave-browser'],
];

/** The installed Chromium-based browsers, in the order Chrome, Edge, Chromium, Brave (empty when there are none). */
export function findInstalledBrowsers(options: FindBrowserOptions = {}): InstalledBrowser[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? fileExists;
  const seen = new Set<string>();
  return candidates(env, platform).filter((c) => {
    const key = platform === 'win32' ? c.path.toLowerCase() : c.path;
    if (seen.has(key) || !isFile(c.path)) return false;
    seen.add(key);
    return true;
  });
}

function candidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): InstalledBrowser[] {
  if (platform === 'win32') {
    const roots = WINDOWS_ROOTS.map((name) => envValue(env, name)).filter((root): root is string => Boolean(root));
    return WINDOWS.flatMap(([name, file]) => roots.map((root) => ({ name, path: path.win32.join(root, file) })));
  }
  if (platform === 'darwin') {
    const folders = ['/Applications', ...(env.HOME ? [path.posix.join(env.HOME, 'Applications')] : [])];
    return MAC.flatMap(([name, file]) => folders.map((folder) => ({ name, path: path.posix.join(folder, file) })));
  }
  const dirs = (env.PATH ?? '').split(':').filter(Boolean);
  return UNIX.flatMap(([name, command]) => dirs.map((dir) => ({ name, path: path.posix.join(dir, command) })));
}

/** Environment variables are case-insensitive on Windows, but a plain object from a test or a host isn't. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

export function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Paper sizes in inches (DevTools takes inches), for the formats of PDF_FORMATS. */
const PAPER: Record<string, { width: number; height: number }> = {
  A4: { width: 8.27, height: 11.69 },
  Letter: { width: 8.5, height: 11 },
};

/** How long the browser may take to start and answer, and to close. */
const START_TIMEOUT = 30_000;
const CLOSE_TIMEOUT = 5_000;

/**
 * The PDF engine for installed browsers: the same launch → newPage → goto → wait → print steps as Playwright's.
 * It starts the first browser that will run headless, trying the next one when a browser won't start (an
 * update waiting to be applied can make one exit at once), and takes that browser's name.
 */
export function browserEngine(browsers: InstalledBrowser[]): PdfEngine {
  const engine: PdfEngine = {
    name: browsers.map((b) => b.name).join(', ') || 'browser',
    launch: async () => {
      const failures: string[] = [];
      for (const browser of browsers) {
        try {
          const started = await launchBrowser(browser.path);
          engine.name = browser.name;
          return started;
        } catch (err) {
          failures.push(`${browser.name} (${browser.path}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length > 1) throw new Error(`none of them would start:\n  ${failures.join('\n  ')}`);
      throw new Error(failures[0] ?? 'no browser was given');
    },
    waitFor: (page, expression, timeout) => page.waitForFunction(expression, { timeout }),
  };
  return engine;
}

/** The command-line switches: headless, a throwaway profile, nothing that phones home or opens windows. */
export function browserArgs(profile: string, root = isRoot()): string[] {
  return [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--mute-audio', '--hide-scrollbars',
    // Chromium refuses to run as root with its sandbox (containers, CI images).
    ...(root ? ['--no-sandbox'] : []),
    'about:blank',
  ];
}

function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

async function launchBrowser(executable: string): Promise<PdfBrowser> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-pdf-'));
  let child: ChildProcess;
  try {
    child = spawn(executable, browserArgs(profile), { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    removeProfile(profile);
    throw err;
  }
  const connection = new Connection(child.stdio[3] as Writable, child.stdio[4] as Readable);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      connection.dispose(new Error(`the browser exited (${signal ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      resolve();
    });
    child.once('error', (err) => {
      connection.dispose(err);
      resolve();
    });
  });
  const close = async () => {
    await withTimeout(connection.send('Browser.close'), CLOSE_TIMEOUT, 'Browser.close').catch(() => undefined);
    await withTimeout(exited, CLOSE_TIMEOUT, 'exit').catch(() => child.kill());
    removeProfile(profile);
  };
  try {
    await withTimeout(connection.send('Browser.getVersion'), START_TIMEOUT, 'starting the browser');
  } catch (err) {
    await close();
    throw err;
  }
  return { newPage: () => openPage(connection), close };
}

function removeProfile(profile: string): void {
  // The browser can hold files in its profile for a moment after it exits (Windows).
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // A leftover folder in the temp directory is harmless.
  }
}

async function openPage(connection: Connection): Promise<PdfPage> {
  const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
  const send = (method: string, params: Record<string, unknown> = {}) => connection.send(method, params, sessionId);
  await send('Page.enable');
  return {
    async goto(url, { timeout }) {
      const loaded = connection.waitForEvent('Page.loadEventFired', sessionId);
      const result = await send('Page.navigate', { url }) as { errorText?: string };
      if (result.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`);
      await withTimeout(loaded, timeout, `loading ${url}`);
    },
    async waitForFunction(expression, ...rest) {
      const timeout = (rest[0] as { timeout?: number } | undefined)?.timeout ?? 30_000;
      const deadline = Date.now() + timeout;
      for (;;) {
        if (await evaluate(send, expression)) return true;
        if (Date.now() >= deadline) throw new Error(`Timeout ${timeout}ms exceeded.`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    evaluate: (expression) => evaluate(send, expression),
    async pdf(options) {
      const result = await send('Page.printToPDF', printOptions(options)) as { data: string };
      return Buffer.from(result.data, 'base64');
    },
  };
}

async function evaluate(send: (method: string, params?: Record<string, unknown>) => Promise<unknown>, expression: string): Promise<unknown> {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed');
  }
  return result.result?.value;
}

/** Playwright-style print options ({ format, landscape, printBackground, margin: { top: '16mm' … } }) as DevTools' Page.printToPDF parameters. */
export function printOptions(options: Record<string, unknown>): Record<string, unknown> {
  const paper = PAPER[String(options.format)] ?? PAPER.A4;
  const margin = (options.margin ?? {}) as Record<string, string | undefined>;
  return {
    landscape: Boolean(options.landscape),
    printBackground: Boolean(options.printBackground),
    paperWidth: paper.width,
    paperHeight: paper.height,
    marginTop: inches(margin.top),
    marginBottom: inches(margin.bottom),
    marginLeft: inches(margin.left),
    marginRight: inches(margin.right),
    displayHeaderFooter: false,
    preferCSSPageSize: false,
  };
}

/** '16mm' (or cm, in, px) in inches; 0 for anything else. */
export function inches(length: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?)(mm|cm|in|px)$/.exec(length ?? '');
  if (!m) return 0;
  const value = Number(m[1]);
  const perInch: Record<string, number> = { mm: 25.4, cm: 2.54, in: 1, px: 96 };
  return Math.round((value / perInch[m[2]]) * 1000) / 1000;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000} s ${what}.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface Pending { resolve: (value: unknown) => void; reject: (err: Error) => void; method: string }

/** One DevTools connection over the pipe: numbered commands with replies, and events. */
export class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters: Array<{ method: string; sessionId?: string; resolve: () => void }> = [];
  private buffer = Buffer.alloc(0);
  private closed: Error | undefined;

  constructor(private readonly output: Writable, input: Readable) {
    input.on('data', (chunk: Buffer) => this.receive(chunk));
    // A write after the browser has gone fails; the exit handler reports why.
    output.on('error', () => undefined);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.output.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  /** Resolves on the next event of this method (for this session). */
  waitForEvent(method: string, sessionId?: string): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve) => this.waiters.push({ method, sessionId, resolve }));
  }

  /** Fails every command still waiting for a reply. */
  dispose(reason: Error): void {
    this.closed ??= reason;
    for (const [, p] of this.pending) p.reject(new Error(`${p.method}: ${reason.message}`));
    this.pending.clear();
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(0)) >= 0) {
      const text = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      if (text) this.dispatch(JSON.parse(text) as Message);
    }
  }

  private dispatch(message: Message): void {
    if (message.id !== undefined) {
      const p = this.pending.get(message.id);
      if (!p) return;
      this.pending.delete(message.id);
      if (message.error) p.reject(new Error(`${p.method}: ${message.error.message}`));
      else p.resolve(message.result ?? {});
      return;
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.method === message.method && (w.sessionId === undefined || w.sessionId === message.sessionId)) {
        this.waiters.splice(i, 1);
        w.resolve();
      }
    }
  }
}

interface Message {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: unknown;
  error?: { message: string };
}
