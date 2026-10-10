// Builds the web playground (../playground) into dist/playground: a static app that opens from any static host
// or from file://. Run with `npm run build:playground`; `--out <dir>` writes it somewhere else.
//
//   index.html, app.css          the page (copied from playground/, with the CSP written in)
//   app.js                       the editor and the engine, with the preview frame's assets embedded: smd.css,
//                                KaTeX's stylesheet with its fonts as data: URLs, the page runtime, the link handler
//   vendor/mermaid-source.js     Mermaid's source as a string, loaded only for documents with diagrams
//   vendor/*.LICENSE             licenses of the bundled KaTeX and Mermaid
//
// The preview frame inlines its scripts (a sandboxed frame can't load files from file://), so their SHA-256
// hashes go into the CSP; a script whose text changes without a rebuild simply doesn't run.
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSP_PLACEHOLDER, appCsp } from '../../playground/src/csp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const playground = join(root, '..', 'playground');
const katex = join(root, 'node_modules', 'katex');
const mermaid = join(root, 'node_modules', 'mermaid');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'browser',
  // Classic scripts, not modules: module scripts don't load from file://.
  format: 'iife',
  target: ['es2022'],
  loader: { '.smd': 'text', '.md': 'text' },
  legalComments: 'none',
  logLevel: 'warning',
};

/** Base64 SHA-256 of a script's text, as a CSP hash source wants it. */
export function scriptHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

/** KaTeX's stylesheet with each font as a woff2 data: URL (every browser the playground supports reads woff2). */
export function katexCssInline() {
  const css = readFileSync(join(katex, 'dist', 'katex.min.css'), 'utf8');
  const inlined = css.replaceAll(
    /url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)(?:,url\(fonts\/[\w.-]+\) format\("\w+"\))*/g,
    (_, name) => {
      const data = readFileSync(join(katex, 'dist', 'fonts', `${name}.woff2`)).toString('base64');
      return `url(data:font/woff2;base64,${data}) format("woff2")`;
    },
  );
  if (inlined.includes('url(fonts/')) throw new Error('katex.min.css has a font reference the playground build does not inline');
  return inlined;
}

function assertInlinable(name, text, closer) {
  if (text.toLowerCase().includes(closer)) throw new Error(`${name} contains "${closer}" and can't be inlined in the preview frame`);
}

/** The preview frame's assets, the hashes of its inline scripts and the CSP that allows them. */
export async function playgroundAssets() {
  const links = (await esbuild.build({ ...common, entryPoints: [join(playground, 'src', 'previewLinks.ts')], write: false, minify: true }))
    .outputFiles[0].text;
  const runtime = readFileSync(join(root, 'media', 'runtime.js'), 'utf8');
  const mermaidJs = readFileSync(join(mermaid, 'dist', 'mermaid.min.js'), 'utf8');
  const css = `${readFileSync(join(root, 'media', 'smd.css'), 'utf8')}\n${katexCssInline()}`;
  for (const [name, text] of [['runtime.js', runtime], ['the link handler', links], ['mermaid.min.js', mermaidJs]]) {
    assertInlinable(name, text, '</script');
  }
  assertInlinable('the preview stylesheet', css, '</style');
  const hashes = [runtime, links, mermaidJs].map(scriptHash);
  return { frame: { css, runtime, links }, mermaid: mermaidJs, hashes, csp: appCsp(hashes) };
}

/**
 * esbuild options for app.js, with the frame's assets embedded.
 * @returns {import('esbuild').BuildOptions}
 */
export function appBundleOptions(outfile, frame, { minify = true } = {}) {
  return {
    ...common,
    entryPoints: [join(playground, 'src', 'main.ts')],
    outfile,
    minify,
    define: { __PLAYGROUND_FRAME__: JSON.stringify(frame) },
  };
}

/** index.html with the CSP written in. */
export function indexHtml(csp) {
  const template = readFileSync(join(playground, 'index.html'), 'utf8');
  if (!template.includes(CSP_PLACEHOLDER)) throw new Error(`playground/index.html has no ${CSP_PLACEHOLDER}`);
  return template.replace(CSP_PLACEHOLDER, csp);
}

export async function buildPlayground(outdir = join(root, 'dist', 'playground')) {
  const assets = await playgroundAssets();
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(join(outdir, 'vendor'), { recursive: true });
  await esbuild.build(appBundleOptions(join(outdir, 'app.js'), assets.frame));
  writeFileSync(join(outdir, 'index.html'), indexHtml(assets.csp));
  cpSync(join(playground, 'app.css'), join(outdir, 'app.css'));
  // Read by the app and inlined into the frame byte for byte, so the CSP hash of mermaid.min.js matches.
  writeFileSync(join(outdir, 'vendor', 'mermaid-source.js'), `globalThis.SMD_PLAYGROUND_MERMAID = ${JSON.stringify(assets.mermaid)};\n`);
  cpSync(join(mermaid, 'LICENSE'), join(outdir, 'vendor', 'mermaid.LICENSE'));
  cpSync(join(katex, 'LICENSE'), join(outdir, 'vendor', 'katex.LICENSE'));
  return outdir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // A promise chain rather than top-level await, so the tests (CommonJS under tsx) can import this file.
  const at = process.argv.indexOf('--out');
  buildPlayground(at > 0 ? resolve(process.argv[at + 1]) : undefined).then(
    (outdir) => console.log(`Playground built in ${outdir}. Open index.html in a browser.`),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
