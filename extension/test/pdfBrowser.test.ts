import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { loadPdfEngine, PdfError, printPdf } from '../src/pdf';
import { browserArgs, browserEngine, Connection, findInstalledBrowsers, inches, printOptions } from '../src/pdfBrowser';

// ---- Finding an installed browser ----

const only = (...files: string[]) => (file: string) => files.includes(file);

test('findInstalledBrowsers on Windows: Chrome, Edge, Chromium, Brave under Program Files and the user\'s app data', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
  const chrome = 'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const brave = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  // Environment variable names are matched in any case, as Windows does.
  assert.deepEqual(findInstalledBrowsers({ env, platform: 'win32', isFile: only(brave, edge, chrome) }), [
    { name: 'Google Chrome', path: chrome },
    { name: 'Microsoft Edge', path: edge },
    { name: 'Brave', path: brave },
  ]);
  assert.deepEqual(findInstalledBrowsers({ env, platform: 'win32', isFile: () => false }), []);
  // The same folder twice (PROGRAMFILES set like PROGRAMFILES(X86)) lists a browser once.
  const twice = { PROGRAMFILES: 'C:\\Program Files (x86)', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' };
  assert.deepEqual(findInstalledBrowsers({ env: twice, platform: 'win32', isFile: only(edge) }), [{ name: 'Microsoft Edge', path: edge }]);
});

test('findInstalledBrowsers on macOS (/Applications, ~/Applications) and Linux (the PATH)', () => {
  const mine = '/Users/a/Applications/Chromium.app/Contents/MacOS/Chromium';
  const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  assert.deepEqual(findInstalledBrowsers({ env: { HOME: '/Users/a' }, platform: 'darwin', isFile: only(mine, edge) }), [
    { name: 'Microsoft Edge', path: edge },
    { name: 'Chromium', path: mine },
  ]);
  assert.deepEqual(findInstalledBrowsers({ env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux', isFile: only('/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable') }), [
    { name: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
    { name: 'Chromium', path: '/usr/bin/chromium-browser' },
  ]);
});

test('loadPdfEngine: --browser, then SMD_BROWSER, then Playwright or Puppeteer, then an installed browser', () => {
  const packages = { playwright: { chromium: { launch: async () => assert.fail() } } };
  const installed = () => [{ name: 'Google Chrome', path: '/usr/bin/google-chrome' }];
  const isFile = only('/opt/edge', '/opt/brave');
  assert.equal(loadPdfEngine({ browser: '/opt/edge', env: { SMD_BROWSER: '/opt/brave' }, isFile, load: (n) => packages[n as 'playwright'], findBrowsers: installed }).name, '/opt/edge');
  assert.equal(loadPdfEngine({ env: { SMD_BROWSER: '/opt/brave' }, isFile, load: (n) => packages[n as 'playwright'], findBrowsers: installed }).name, '/opt/brave');
  assert.equal(loadPdfEngine({ env: {}, isFile, load: (n) => packages[n as 'playwright'], findBrowsers: installed }).name, 'playwright');
  assert.equal(loadPdfEngine({ env: {}, isFile, load: () => undefined, findBrowsers: installed }).name, 'Google Chrome');
  assert.throws(() => loadPdfEngine({ browser: '/opt/none', env: {}, isFile }),
    (e: Error) => e instanceof PdfError && e.message === 'No browser was found at /opt/none (from --browser).');
  assert.throws(() => loadPdfEngine({ env: { SMD_BROWSER: '/opt/none' }, isFile }),
    (e: Error) => e instanceof PdfError && e.message === 'No browser was found at /opt/none (from SMD_BROWSER).');
});

// ---- Launching and printing ----

test('browserArgs: headless on a DevTools pipe with a throwaway profile; no sandbox only as root', () => {
  const args = browserArgs('/tmp/profile', false);
  for (const arg of ['--headless=new', '--remote-debugging-pipe', '--user-data-dir=/tmp/profile', '--no-first-run']) assert.ok(args.includes(arg), arg);
  assert.equal(args.at(-1), 'about:blank');
  assert.ok(!args.includes('--no-sandbox'));
  assert.ok(browserArgs('/tmp/profile', true).includes('--no-sandbox'));
});

test('printOptions: the paper size and margins of Playwright\'s options in inches', () => {
  assert.deepEqual(printOptions({ format: 'A4', landscape: false, printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } }), {
    landscape: false, printBackground: true, paperWidth: 8.27, paperHeight: 11.69,
    marginTop: 0.63, marginBottom: 0.63, marginLeft: 0.551, marginRight: 0.551,
    displayHeaderFooter: false, preferCSSPageSize: false,
  });
  const letter = printOptions({ format: 'Letter', landscape: true });
  assert.equal(letter.paperWidth, 8.5);
  assert.equal(letter.landscape, true);
  assert.equal(letter.marginTop, 0);
  assert.deepEqual([inches('1in'), inches('2.54cm'), inches('96px'), inches('auto'), inches(undefined)], [1, 1, 1, 0, 0]);
});

test('Connection: NUL-separated JSON commands, replies (also split across chunks), errors and events', async () => {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const sent: string[] = [];
  toBrowser.on('data', (chunk: Buffer) => sent.push(chunk.toString('utf8')));
  const connection = new Connection(toBrowser, fromBrowser);

  const version = connection.send('Browser.getVersion');
  const navigate = connection.send('Page.navigate', { url: 'file:///a.html' }, 'S1');
  const loaded = connection.waitForEvent('Page.loadEventFired', 'S1');
  await new Promise(setImmediate);
  assert.deepEqual(sent.join('').split('\0').filter(Boolean).map((m) => JSON.parse(m)), [
    { id: 1, method: 'Browser.getVersion', params: {} },
    { id: 2, method: 'Page.navigate', params: { url: 'file:///a.html' }, sessionId: 'S1' },
  ]);

  // One reply split in the middle of a multi-byte character, then an error and an event in one chunk.
  const reply = Buffer.from(`${JSON.stringify({ id: 1, result: { product: 'Chrome/140 — headless' } })}\0`);
  fromBrowser.write(reply.subarray(0, reply.indexOf(0xe2) + 1));
  fromBrowser.write(reply.subarray(reply.indexOf(0xe2) + 1));
  fromBrowser.write(`${JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'OTHER', params: {} })}\0`
    + `${JSON.stringify({ id: 2, error: { message: 'Cannot navigate to invalid URL' } })}\0`
    + `${JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'S1', params: {} })}\0`);
  assert.deepEqual(await version, { product: 'Chrome/140 — headless' });
  await assert.rejects(navigate, /^Error: Page\.navigate: Cannot navigate to invalid URL$/);
  await loaded;

  const pending = connection.send('Page.printToPDF');
  connection.dispose(new Error('the browser exited (code 1)'));
  await assert.rejects(pending, /Page\.printToPDF: the browser exited \(code 1\)/);
  await assert.rejects(connection.send('Browser.close'), /the browser exited/);
});

test('browserEngine tries each installed browser in turn and names every one that would not start', async () => {
  const missing = join(__dirname, 'no-such-browser');
  const engine = browserEngine([{ name: 'First', path: `${missing}-1` }, { name: 'Second', path: `${missing}-2` }]);
  assert.equal(engine.name, 'First, Second');
  await assert.rejects(printPdf(engine, 'about:blank', { format: 'A4', landscape: false, timeout: 1000 }, assert.fail), (e: Error) =>
    e instanceof PdfError && /^First, Second could not start its browser: none of them would start:\n {2}First \(.*-1\): .*\n {2}Second \(.*-2\): /.test(e.message));
});

// ---- A real browser, when one is installed (Chrome on GitHub's runners) ----

const cli = join(__dirname, '..', 'dist', 'cli.js');
const browsers = findInstalledBrowsers();

test('CLI: smd export --to pdf prints with an installed browser', {
  skip: (!existsSync(cli) && 'run npm run build first') || (!browsers.length && 'no Chrome, Edge, Chromium or Brave installed'),
  timeout: 120_000,
}, () => {
  const dir = mkdtempSync(join(__dirname, '.pdf-browser-'));
  try {
    const source = join(dir, 'plan.smd');
    // No diagrams, so the test needs no network (Mermaid loads from a CDN).
    writeFileSync(source, '---\ntitle: Plan\n---\n# Plan\n\n:::note Printed\nWith an **installed** browser.\n:::\n\n:::details More\nHidden until printed.\n:::\n');
    const out = join(dir, 'plan.pdf');
    // An empty SMD_BROWSER, and no Playwright or Puppeteer in a temporary working folder, leave the installed browser.
    const result = spawnSync(process.execPath, [cli, 'export', source, '--to', 'pdf', '-o', out], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, SMD_BROWSER: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /^Wrote .*plan\.pdf \(printed with .+\)\n$/);
    const pdf = readFileSync(out);
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(pdf.toString('latin1'), /\/Type\s*\/Page\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
