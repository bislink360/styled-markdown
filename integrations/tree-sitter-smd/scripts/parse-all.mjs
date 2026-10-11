// Parses every .smd file in the repository (examples, docs, the compatibility corpus, the skill
// templates and the playground) with this grammar, as written and with CRLF line endings, and
// fails when any tree has ERROR or MISSING nodes. Needs `npm ci` here (for tree-sitter-cli) and a
// C compiler.
//
//   node scripts/parse-all.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const grammarDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(grammarDir, '..', '..');
const cli = join(grammarDir, 'node_modules', 'tree-sitter-cli', 'cli.js');
const SOURCE_DIRS = ['examples', 'docs', 'extension/test/compat/corpus', 'skills', 'playground'];
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

function findSmdFiles(dir, found) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) findSmdFiles(path, found);
    else if (entry.isFile() && entry.name.endsWith('.smd')) found.push(path);
  }
  return found;
}

/** Parse the files and return the ones whose trees have errors. */
function filesWithErrors(files, workDir) {
  const list = join(workDir, 'paths.txt');
  writeFileSync(list, files.join('\n') + '\n');
  const result = spawnSync(process.execPath, [cli, 'parse', '--quiet', '--json-summary', '--paths', list], {
    cwd: grammarDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  // Files with errors also get a plain-text line before the JSON summary.
  const json = result.stdout.search(/\{\s*"parse_summaries"/);
  let summary;
  try {
    summary = JSON.parse(result.stdout.slice(json));
  } catch {
    throw new Error(`tree-sitter parse did not run (exit ${result.status}):\n${result.stderr}`);
  }
  return summary.parse_summaries.filter((s) => s.successful !== true).map((s) => s.file);
}

function main() {
  if (!existsSync(cli)) {
    console.error('tree-sitter-cli is not installed: run `npm ci` in integrations/tree-sitter-smd.');
    return 2;
  }
  const files = SOURCE_DIRS.flatMap((dir) => findSmdFiles(join(repoRoot, dir), []));
  if (!files.length) {
    console.error('No .smd files found.');
    return 1;
  }
  const workDir = mkdtempSync(join(tmpdir(), 'smd-tree-sitter-'));
  try {
    // The same files with Windows line endings, which the grammar must parse the same way.
    const crlf = files.map((file, i) => {
      const copy = join(workDir, `${i}-crlf.smd`);
      writeFileSync(copy, readFileSync(file, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
      return copy;
    });
    const failed = filesWithErrors([...files, ...crlf], workDir).map((file) => {
      const i = crlf.findIndex((copy) => copy.replaceAll('\\', '/') === file.replaceAll('\\', '/'));
      return i === -1 ? relative(repoRoot, file) : `${relative(repoRoot, files[i])} (with CRLF line endings)`;
    });
    if (failed.length) {
      console.error(`Parse errors in ${failed.length} file(s):\n  ${failed.join('\n  ')}`);
      console.error('Run `npx tree-sitter parse <file>` in integrations/tree-sitter-smd to see the ERROR nodes.');
      return 1;
    }
    console.log(`Parsed ${files.length} .smd files (and their CRLF copies) without errors.`);
    return 0;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

process.exitCode = main();
