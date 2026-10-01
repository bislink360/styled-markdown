// Builds the `styled-markdown` npm package into ../npm/dist:
//   index.cjs / index.mjs  the library (engine only, browser-safe, zero runtime dependencies)
//   remark.* / rehype.*    the remark and rehype plugins (import the library bundle)
//   cli.js                 the `smd` command (same bundle as the extension's CLI)
//   language-server.js     the `smd-language-server` command: `smd lsp` under its own name, for editors
//   types/                 TypeScript declarations (emitted by tsc -p tsconfig.npm.json)
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '..', 'npm', 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  entryPoints: [join(root, 'src', 'core', 'index.ts')],
  bundle: true,
  minify: true,
  sourcemap: false,
  target: 'es2020',
  legalComments: 'none',
  define: {
    __SMD_CSS__: JSON.stringify(readFileSync(join(root, 'media', 'smd.css'), 'utf8')),
    __SMD_RUNTIME__: JSON.stringify(readFileSync(join(root, 'media', 'runtime.js'), 'utf8')),
  },
  logLevel: 'info',
};

await esbuild.build({ ...common, platform: 'node', format: 'cjs', outfile: join(out, 'index.cjs') });
await esbuild.build({ ...common, platform: 'neutral', mainFields: ['module', 'main'], format: 'esm', outfile: join(out, 'index.mjs') });

// styled-markdown/remark and styled-markdown/rehype: thin entries that import the main bundle.
const useMainBundle = (file) => ({
  name: 'use-main-bundle',
  setup(build) {
    build.onResolve({ filter: /^\.\/index$/ }, () => ({ path: `./${file}`, external: true }));
  },
});
for (const name of ['remark', 'rehype']) {
  const entry = { entryPoints: [join(root, 'src', 'core', `${name}.ts`)], bundle: true, target: 'es2020', logLevel: 'info' };
  await esbuild.build({ ...entry, platform: 'node', format: 'cjs', outfile: join(out, `${name}.cjs`), plugins: [useMainBundle('index.cjs')] });
  await esbuild.build({ ...entry, platform: 'neutral', format: 'esm', outfile: join(out, `${name}.mjs`), plugins: [useMainBundle('index.mjs')] });
}

// Stylesheet for users who render fragments with renderSmd().
copyFileSync(join(root, 'media', 'smd.css'), join(out, 'smd.css'));

// JSON Schema for front matter, for YAML tooling and pipelines that check document metadata.
copyFileSync(join(root, 'schemas', 'smd-frontmatter.schema.json'), join(out, 'frontmatter.schema.json'));

// The CLI is built by scripts/build.mjs; ship the identical file.
copyFileSync(join(root, 'dist', 'cli.js'), join(out, 'cli.js'));
// `smd-language-server` for editors that launch a server by name: runs the CLI as `smd lsp`.
writeFileSync(join(out, 'language-server.js'), [
  '#!/usr/bin/env node',
  '// smd-language-server: the same as `smd lsp` (the Styled Markdown language server over stdio).',
  "process.argv.splice(2, 0, 'lsp');",
  "require('./cli.js');",
  '',
].join('\n'));
// Mermaid's parser, loaded by the CLI on demand for mermaid/syntax diagnostics.
copyFileSync(join(root, 'dist', 'mermaid-parse.js'), join(out, 'mermaid-parse.js'));
