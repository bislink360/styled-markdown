import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  exportPdf, lightTheme, loadPdfEngine, PDF_BEFORE_PRINT, PDF_READY_CHECK, PdfError, pdfOptions, pdfPath, printPdf,
  type PdfBrowser, type PdfEngine, type PdfPage,
} from '../src/pdf';

// ---- Stand-ins for Playwright and Puppeteer: launch → newPage → goto → waitForFunction → evaluate → pdf ----

interface Fake { calls: unknown[][]; browser: PdfBrowser; launch: () => Promise<PdfBrowser> }

function fakeBrowser(options: { readyFails?: boolean; pdfFails?: boolean } = {}): Fake {
  const calls: unknown[][] = [];
  const page: PdfPage = {
    goto: async (...args) => { calls.push(['goto', ...args]); },
    waitForFunction: async (...args) => {
      calls.push(['waitForFunction', ...args]);
      if (options.readyFails) throw new Error('Timeout 60000ms exceeded.');
    },
    evaluate: async (expression) => { calls.push(['evaluate', expression]); },
    pdf: async (pdfOptions) => {
      calls.push(['pdf', pdfOptions]);
      if (options.pdfFails) throw new Error('Printing failed');
      return new TextEncoder().encode('%PDF-1.7 fake');
    },
  };
  const browser: PdfBrowser = {
    newPage: async () => { calls.push(['newPage']); return page; },
    close: async () => { calls.push(['close']); },
  };
  return { calls, browser, launch: async () => { calls.push(['launch']); return browser; } };
}

const playwrightLike = (fake: Fake) => ({ chromium: { launch: fake.launch }, firefox: {} });
const puppeteerLike = (fake: Fake) => ({ launch: fake.launch });
const loader = (modules: Record<string, unknown>) => (name: string) => modules[name];

const OPTIONS = { format: 'A4', landscape: false, timeout: 60_000 };

test('loadPdfEngine prefers Playwright, then @playwright/test, then Puppeteer', () => {
  const fake = fakeBrowser();
  assert.equal(loadPdfEngine({ load: loader({ playwright: playwrightLike(fake), puppeteer: puppeteerLike(fake) }) }).name, 'playwright');
  assert.equal(loadPdfEngine({ load: loader({ '@playwright/test': playwrightLike(fake), puppeteer: puppeteerLike(fake) }) }).name, '@playwright/test');
  assert.equal(loadPdfEngine({ load: loader({ puppeteer: puppeteerLike(fake) }) }).name, 'puppeteer');
  // Puppeteer's ES module default export, and a package that isn't a usable browser library.
  assert.equal(loadPdfEngine({ load: loader({ playwright: {}, puppeteer: { default: puppeteerLike(fake) } }) }).name, 'puppeteer');
});

test('loadPdfEngine without a browser package says how to install one or print from the browser', () => {
  assert.throws(() => loadPdfEngine({ load: () => undefined }), (e: Error) => e instanceof PdfError
    && /needs a headless browser from Playwright or Puppeteer/.test(e.message)
    && /npm install --save-dev playwright && npx playwright install chromium/.test(e.message)
    && /npm install --save-dev puppeteer/.test(e.message)
    && /smd render <file\.smd> -o page\.html[^]*Print → Save as PDF/.test(e.message));
  // Resolving from a folder without node_modules finds nothing either (when no package is installed above it).
  const local = (() => { try { loadPdfEngine(); return true; } catch { return false; } })();
  if (!local) assert.throws(() => loadPdfEngine({ paths: [__dirname] }), PdfError);
});

test('printPdf with Playwright waits for the page runtime, expands blocks, prints and closes the browser', async () => {
  const fake = fakeBrowser();
  const engine = loadPdfEngine({ load: loader({ playwright: playwrightLike(fake) }) });
  const pdf = await printPdf(engine, 'file:///docs/page.html', { ...OPTIONS, format: 'Letter', landscape: true }, assert.fail);
  assert.equal(new TextDecoder().decode(pdf), '%PDF-1.7 fake');
  assert.deepEqual(fake.calls, [
    ['launch'],
    ['newPage'],
    ['goto', 'file:///docs/page.html', { waitUntil: 'load', timeout: 60_000 }],
    ['waitForFunction', PDF_READY_CHECK, undefined, { timeout: 60_000 }],
    ['evaluate', PDF_BEFORE_PRINT],
    ['pdf', { format: 'Letter', landscape: true, printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } }],
    ['close'],
  ]);
});

test('printPdf with Puppeteer passes waitForFunction options in Puppeteer\'s position', async () => {
  const fake = fakeBrowser();
  const engine = loadPdfEngine({ load: loader({ puppeteer: puppeteerLike(fake) }) });
  await printPdf(engine, 'file:///page.html', OPTIONS, assert.fail);
  assert.deepEqual(fake.calls.find((c) => c[0] === 'waitForFunction'), ['waitForFunction', PDF_READY_CHECK, { timeout: 60_000 }]);
});

test('printPdf prints anyway when diagrams never finish, and always closes the browser', async () => {
  const slow = fakeBrowser({ readyFails: true });
  const warnings: string[] = [];
  await printPdf(loadPdfEngine({ load: loader({ playwright: playwrightLike(slow) }) }), 'file:///p.html', OPTIONS, (m) => warnings.push(m));
  assert.deepEqual(warnings, ['Diagrams had not finished rendering after 60 s; printing the page as it is.']);
  assert.ok(slow.calls.some((c) => c[0] === 'pdf'));

  const broken = fakeBrowser({ pdfFails: true });
  await assert.rejects(printPdf(loadPdfEngine({ load: loader({ playwright: playwrightLike(broken) }) }), 'file:///p.html', OPTIONS, assert.fail), /Printing failed/);
  assert.deepEqual(broken.calls.at(-1), ['close']);
});

test('printPdf reports a browser that will not start as a PdfError', async () => {
  const engine: PdfEngine = {
    name: 'playwright',
    launch: async () => { throw new Error("Executable doesn't exist. Please run: npx playwright install"); },
    waitFor: async () => undefined,
  };
  await assert.rejects(printPdf(engine, 'file:///p.html', OPTIONS, assert.fail),
    (e: Error) => e instanceof PdfError && /^playwright could not start its browser: Executable doesn't exist/.test(e.message));
});

test('pdfOptions, pdfPath and lightTheme', () => {
  assert.deepEqual(pdfOptions(undefined, false), { format: 'A4', landscape: false, timeout: 60_000 });
  assert.equal(pdfOptions('letter', true).format, 'Letter');
  assert.throws(() => pdfOptions('A3', false), (e: Error) => e instanceof PdfError && e.message === '--format needs one of: A4, Letter.');
  assert.equal(pdfPath(join('docs', 'plan.smd')), join('docs', 'plan.pdf'));
  assert.equal(lightTheme('<html lang="en" data-smd-theme-pref="dark">\n<p data-smd-theme-pref="dark">'),
    '<html lang="en" data-smd-theme-pref="light">\n<p data-smd-theme-pref="dark">');
});

test('exportPdf prints the page from beside the document and removes it afterwards', async () => {
  const dir = mkdtempSync(join(__dirname, '.pdf-'));
  try {
    const source = join(dir, 'plan.smd');
    writeFileSync(source, '# Plan\n');
    const fake = fakeBrowser();
    const engine = loadPdfEngine({ load: loader({ playwright: playwrightLike(fake) }) });
    let printed = '';
    const page = fake.browser.newPage;
    fake.browser.newPage = async () => {
      const p = await page();
      const goto = p.goto;
      p.goto = async (url, options) => {
        printed = readFileSync(new URL(url), 'utf8');
        return goto(url, options);
      };
      return p;
    };
    await exportPdf(source, '<html lang="en" data-smd-theme-pref="dark"><p>Plan</p>', join(dir, 'out.pdf'), OPTIONS, { engine, warn: assert.fail });
    assert.equal(printed, '<html lang="en" data-smd-theme-pref="light"><p>Plan</p>');
    assert.match(String((fake.calls.find((c) => c[0] === 'goto') ?? [])[1]), /^file:\/\/\/.*\/\.plan\.smd\.\d+\.print\.html$/);
    assert.equal(readFileSync(join(dir, 'out.pdf'), 'utf8'), '%PDF-1.7 fake');
    assert.deepEqual(readdirSync(dir).sort((a, b) => a.localeCompare(b)), ['out.pdf', 'plan.smd']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The page runtime and stylesheet ----

const runtime = readFileSync(join(__dirname, '..', 'media', 'runtime.js'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'media', 'smd.css'), 'utf8');

/** Just enough DOM for the runtime to start in a page without diagrams. */
function fakePage(details: Array<{ open: boolean }>) {
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Array<() => void>>();
  const on = (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const html = { getAttribute: (n: string) => attrs.get(n) ?? null, setAttribute: (n: string, v: string) => attrs.set(n, v) };
  const document = {
    documentElement: html,
    body: { classList: { contains: () => false } },
    fonts: { ready: Promise.resolve() },
    addEventListener: on,
    querySelectorAll: (selector: string) => (selector === 'details:not([open])' ? details.filter((d) => !d.open) : []),
  };
  const window = { addEventListener: on };
  class MutationObserver { observe(): void { /* no theme changes in this test */ } }
  const fire = (type: string) => (listeners.get(type) ?? []).forEach((fn) => fn());
  return { attrs, fire, context: { document, window, MutationObserver, getComputedStyle: () => ({}) } };
}

test('runtime: data-smd-ready once rendering is done, and closed <details> open while printing', async () => {
  const details = [{ open: false }, { open: true }];
  const page = fakePage(details);
  vm.runInNewContext(runtime, page.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.attrs.get('data-smd-ready'), 'true');
  page.fire('beforeprint');
  assert.deepEqual(details.map((d) => d.open), [true, true]);
  page.fire('afterprint');
  assert.deepEqual(details.map((d) => d.open), [false, true]);
});

test('print stylesheet: @page margins, light palette, stacked tabs, hidden agent blocks, page breaks', () => {
  const print = css.slice(css.indexOf('@media print'));
  assert.match(css, /@page \{ margin: 16mm 14mm; \}/);
  assert.match(print, /:root, :root\[data-smd-theme="dark"\] \{\s+--smd-bg: #ffffff;/);
  assert.match(print, /\.smd-copy, \.smd-tabbar, \.smd-agent, \.smd-u-no-print \{ display: none !important; \}/);
  assert.match(print, /\.smd-tabs\.smd-js \.smd-tab:not\(\.smd-active\), \.smd-tabs\.smd-js \.smd-tab-label \{ display: block; \}/);
  assert.match(print, /\.smd-code pre \{ white-space: pre-wrap;/);
  assert.match(print, /break-after: avoid/);
  assert.match(print, /\.smd-callout, \.smd-card,[^{]*\{ break-inside: avoid;/);
  assert.match(print, /\.smd-u-page-break \{ break-before: page;/);
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
const example = join(__dirname, '..', '..', 'examples', 'checkout-redesign.smd');
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('CLI: smd render includes the print stylesheet and readiness signal; smd pdf without a browser exits 2',
  { skip: !existsSync(cli) && 'run npm run build first' }, () => {
    const page = run(['render', example]);
    assert.equal(page.status, 0);
    assert.match(page.stdout, /@media print \{/);
    assert.match(page.stdout, /\.smd-u-page-break \{ break-before: page;/);
    assert.match(page.stdout, /data-smd-ready/);

    const badFormat = run(['pdf', example, '--format', 'A3']);
    assert.equal(badFormat.status, 2);
    assert.match(badFormat.stderr, /--format needs one of: A4, Letter\./);

    let installed = true;
    try { loadPdfEngine(); } catch { installed = false; }
    if (!installed) {
      const missing = run(['pdf', example, '-o', join(__dirname, 'never.pdf')]);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /smd pdf needs a headless browser from Playwright or Puppeteer/);
      assert.equal(existsSync(join(__dirname, 'never.pdf')), false);
    }
    assert.match(run(['--help']).stdout, /smd pdf <file\.smd> \[-o out\.pdf\] \[--format A4\|Letter\] \[--landscape\]/);
  });
