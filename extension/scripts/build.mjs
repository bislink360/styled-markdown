// Bundles the extension and CLI with esbuild and copies browser vendor files into media/vendor.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

// Vendor assets loaded by the preview webview.
const vendor = join(root, 'media', 'vendor');
mkdirSync(join(vendor, 'katex'), { recursive: true });
cpSync(join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'), join(vendor, 'mermaid.min.js'));
cpSync(join(root, 'node_modules', 'katex', 'dist', 'katex.min.css'), join(vendor, 'katex', 'katex.min.css'));
cpSync(join(root, 'node_modules', 'katex', 'dist', 'fonts'), join(vendor, 'katex', 'fonts'), { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  loader: { '.md': 'text', '.smd': 'text' },
  define: {
    __SMD_CSS__: JSON.stringify(readFileSync(join(root, 'media', 'smd.css'), 'utf8')),
    __SMD_RUNTIME__: JSON.stringify(readFileSync(join(root, 'media', 'runtime.js'), 'utf8')),
  },
  minify: !watch,
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: [join(root, 'src', 'extension.ts')], outfile: join(root, 'dist', 'extension.js'), external: ['vscode'] },
  { ...common, entryPoints: [join(root, 'src', 'cli.ts')], outfile: join(root, 'dist', 'cli.js'), banner: { js: '#!/usr/bin/env node' } },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}

// Keep the repository's skills self-contained: each skill ships the bundled CLI.
if (!watch) {
  for (const skill of ['styled-markdown-reader', 'styled-markdown-writer']) {
    const dir = join(root, '..', 'skills', skill, 'scripts');
    mkdirSync(dir, { recursive: true });
    cpSync(join(root, 'dist', 'cli.js'), join(dir, 'smd.cjs'));
  }
}
