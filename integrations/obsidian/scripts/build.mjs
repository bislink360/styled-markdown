// Builds the Obsidian plugin: main.js (src/main.ts with the Styled Markdown engine, bundled by esbuild) and
// styles.css (made from the extension's smd.css), next to manifest.json.
//
//   node scripts/build.mjs [--out <dir>]
//
// --out writes main.js, styles.css and a copy of manifest.json to <dir> instead: the folder to put in a vault's
// .obsidian/plugins/ (the release zips it). The plugin uses the extension's toolchain and engine, so run `npm ci`
// in extension/ first; the `obsidian` package in this folder is only the API typings (Obsidian provides the module).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { obsidianCss } from './styles.mjs';

export const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = resolve(pluginRoot, '../../extension');

/** Modules Obsidian provides at runtime. */
export const EXTERNAL = ['obsidian', 'electron', '@codemirror/*', '@lezer/*'];

/** The plugin's manifest.json. */
export function readManifest() {
  return JSON.parse(readFileSync(join(pluginRoot, 'manifest.json'), 'utf8'));
}

/** esbuild options for main.js. */
export function buildOptions(outfile = join(pluginRoot, 'main.js')) {
  const { version } = readManifest();
  return {
    entryPoints: [join(pluginRoot, 'src', 'main.ts')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    // Obsidian's mobile apps run on the system web view, so leave room for older ones.
    target: 'es2018',
    external: EXTERNAL,
    minify: true,
    sourcemap: false,
    logLevel: 'warning',
    banner: { js: `/* Styled Markdown for Obsidian ${version} (MIT). Source: https://github.com/bislink360/styled-markdown/tree/main/integrations/obsidian */` },
    loader: { '.md': 'text', '.smd': 'text' },
    define: { __SMD_PKG_VERSION__: JSON.stringify(version) },
  };
}

/** The extension's esbuild. */
export function loadEsbuild() {
  try {
    return createRequire(join(extensionRoot, 'package.json'))('esbuild');
  } catch {
    throw new Error('esbuild not found: run `npm ci` in extension/ first (the plugin is built with its toolchain).');
  }
}

/** styles.css for the plugin. */
export function pluginCss() {
  return obsidianCss(readFileSync(join(extensionRoot, 'media', 'smd.css'), 'utf8'));
}

/** Build into `outDir` (the plugin folder by default); returns the files written. */
export async function build(outDir = pluginRoot) {
  mkdirSync(outDir, { recursive: true });
  const main = join(outDir, 'main.js');
  await loadEsbuild().build(buildOptions(main));
  const styles = join(outDir, 'styles.css');
  writeFileSync(styles, pluginCss());
  const manifest = join(outDir, 'manifest.json');
  if (resolve(outDir) !== resolve(pluginRoot)) copyFileSync(join(pluginRoot, 'manifest.json'), manifest);
  return [main, styles, manifest];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out');
  const outDir = at >= 0 ? resolve(process.argv[at + 1] ?? '') : pluginRoot;
  // No top-level await: the tests import this module.
  build(outDir).then(
    (files) => files.forEach((file) => console.log(file)),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    },
  );
}
