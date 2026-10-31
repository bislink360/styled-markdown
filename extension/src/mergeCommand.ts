import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blockMerge, isMergeDoubt } from './core/blockMerge';
import { fail } from './cliIo';

/**
 * `smd merge`, a block-aware Git merge driver (docs/COLLABORATION-RFC.smd, D1). Git runs it as
 * `smd merge %O %A %B %L %P`, and it writes the merge to %A. It runs Git's own line merge (`git merge-file`) first and
 * keeps that result byte for byte whenever it is clean; only when Git leaves conflicts does it merge by blocks
 * (core/blockMerge.ts), and when that is in doubt it keeps Git's conflicts. `--install` sets the driver up in a
 * repository's local Git config and its .gitattributes.
 */

export interface MergeArgs { flags: ReadonlySet<string>; values: ReadonlyMap<string, string[]> }

export const MERGE_USAGE = 'Usage: smd merge <ancestor> <current> <other> [<marker-size>] [<path>], or smd merge --install [--dir <repo>]';

export const MERGE_HELP = `Merging with Git:
  smd merge <ancestor> <current> <other> [<marker-size>] [<path>]
      A block-aware Git merge driver; Git runs it as: smd merge %O %A %B %L %P. It runs git merge-file
      and keeps Git's result byte for byte whenever that is clean. Only where Git leaves conflicts does it
      merge by blocks: a block, list item, table row or front matter key only one side changed comes from
      that side as written, and an "updated:" date changed on both sides takes the later date. Lines
      neither side changed stay as they were; nothing is reformatted (run smd fmt yourself if a merged
      table needs realigning). Writes the result to <current>. Exit code 0 when merged, 1 when conflicts
      are left (each inside one block, or Git's own when the block merge is in doubt), 2 on errors.
  smd merge --install [--dir <repo>] [--command "<cmd>"]
      Set the driver up in a repository (default: the current folder's): merge.smd in its local Git
      config, never the global one, and "*.smd merge=smd" in .gitattributes (commit that file; each clone
      runs --install once). The driver runs this CLI file with node, or --command (e.g. smd when it is on
      PATH). Safe to run again. --uninstall removes both.
`;

const NAME = 'Styled Markdown block merge';
const ATTRIBUTE = '*.smd merge=smd';
const LABELS = { ours: 'ours', base: 'base', theirs: 'theirs' };
const DEFAULT_MARKER_SIZE = 7;

export function runMerge(positional: string[], args: MergeArgs): number {
  const dir = args.values.get('--dir')?.[0] ?? '.';
  if (args.flags.has('--install')) return install(dir, args.values.get('--command')?.[0]);
  if (args.flags.has('--uninstall')) return uninstall(dir);
  const [ancestor, current, other, size, file] = positional;
  if (!ancestor || !current || !other) return fail(MERGE_USAGE);
  const markerSize = size === undefined || size === '' ? DEFAULT_MARKER_SIZE : Number(size);
  if (!Number.isInteger(markerSize) || markerSize < 1) return fail(`The marker size must be a whole number, not "${size}".\n${MERGE_USAGE}`);
  return mergeDriver({ ancestor, current, other, markerSize, file: file ?? current });
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

interface DriverFiles { ancestor: string; current: string; other: string; markerSize: number; file: string }

/** Git's line merge of the three files: its exit status (0 clean, else the number of conflicts) and output. */
export interface GitMerge { status: number; stdout: Buffer }

/** What to write to the current file, and the exit code. */
export interface MergeOutcome {
  output: Buffer;
  code: 0 | 1;
  /** Git's result was kept, with its conflicts. */
  kept?: boolean;
  note?: string;
}

export interface ResolveOptions { markerSize?: number; diff3?: boolean }

function run(args: string[], cwd?: string): { status: number | null; stdout: Buffer } {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }); // NOSONAR(typescript:S4036): the merge driver runs the user's own git, found on PATH like smd diff --since
  return { status: r.error ? null : r.status, stdout: r.stdout ?? Buffer.alloc(0) };
}

/** `git merge-file -p` of the three files (labels and marker size as the block merge writes them), or undefined on error. */
export function gitMergeFile(ancestor: string, current: string, other: string, options: ResolveOptions & { style?: string } = {}): GitMerge | undefined {
  const args = ['merge-file', '-p', `--marker-size=${options.markerSize ?? DEFAULT_MARKER_SIZE}`, '-L', LABELS.ours, '-L', LABELS.base, '-L', LABELS.theirs];
  if (options.style) args.push(`--${options.style}`);
  const r = run([...args, current, ancestor, other]);
  // Negative on error (255 or more as an exit code), else the number of conflicts (at most 127).
  if (r.status === null || r.status > 127) return undefined;
  return { status: r.status, stdout: r.stdout };
}

/** Text of a file's bytes when they are UTF-8 (a byte order mark kept), else undefined. */
function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The merge to write: Git's result when it is clean, else the block merge of the three versions, else (not UTF-8,
 * or the block merge in doubt) Git's result with its conflicts.
 */
export function resolveMerge(git: GitMerge, ancestor: Buffer, current: Buffer, other: Buffer, options: ResolveOptions = {}): MergeOutcome {
  if (git.status === 0) return { output: git.stdout, code: 0 };
  const [base, ours, theirs] = [ancestor, current, other].map(utf8);
  if (base === undefined || ours === undefined || theirs === undefined) return { output: git.stdout, code: 1, kept: true, note: 'a version is not UTF-8 text' };
  const result = blockMerge(base, ours, theirs, { markerSize: options.markerSize, diff3: options.diff3, labels: LABELS });
  if (isMergeDoubt(result)) return { output: git.stdout, code: 1, kept: true, note: result.doubt };
  return { output: Buffer.from(result.text, 'utf8'), code: result.conflicts ? 1 : 0, note: result.conflicts ? `${result.conflicts} conflict(s) left, each inside one block` : undefined };
}

/** Git's merge.conflictStyle, when it shows the ancestor too (diff3 or zdiff3). */
function conflictStyle(): string | undefined {
  const style = run(['config', '--get', 'merge.conflictStyle']).stdout.toString('utf8').trim().toLowerCase();
  return style === 'diff3' || style === 'zdiff3' ? style : undefined;
}

function mergeDriver(f: DriverFiles): number {
  const style = conflictStyle();
  const git = gitMergeFile(f.ancestor, f.current, f.other, { markerSize: f.markerSize, style });
  if (!git) {
    console.error(`smd merge: git merge-file could not merge ${f.file}; ${f.current} is left as it was.`);
    return 2;
  }
  let outcome: MergeOutcome;
  try {
    outcome = resolveMerge(git, fs.readFileSync(f.ancestor), fs.readFileSync(f.current), fs.readFileSync(f.other), { markerSize: f.markerSize, diff3: !!style });
  } catch (e) {
    console.error(`smd merge: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  fs.writeFileSync(f.current, outcome.output);
  if (git.status && !outcome.code) console.error(`smd merge: merged ${f.file} block by block.`);
  else if (outcome.kept) console.error(`smd merge: kept Git's conflicts in ${f.file} (${outcome.note}).`);
  else if (outcome.note) console.error(`smd merge: ${f.file}: ${outcome.note}.`);
  return outcome.code;
}

// ---------------------------------------------------------------------------
// --install and --uninstall
// ---------------------------------------------------------------------------

/**
 * The command Git runs: this CLI file with `node` from PATH, by its real path (an npm link or symlink resolved), so it
 * works from the skills bundle, an npm install or a checkout. Forward slashes and double quotes suit the shell Git runs
 * drivers with, on Windows too.
 */
export function driverCommand(script = process.argv[1] ?? ''): string {
  let file = path.resolve(script);
  try {
    file = fs.realpathSync(file);
  } catch {
    // Keep the resolved path.
  }
  return `node "${file.replaceAll('\\', '/').replaceAll(/["$`]/g, '\\$&')}"`;
}

function repositoryTop(dir: string): string | undefined {
  const r = run(['rev-parse', '--show-toplevel'], dir);
  return r.status === 0 ? r.stdout.toString('utf8').trim() : undefined;
}

const hasAttribute = (line: string) => {
  const [pattern, ...attributes] = line.trim().split(/\s+/);
  return pattern === '*.smd' && attributes.includes('merge=smd');
};

/** Add the attribute line to .gitattributes unless a line already says it, in the file's own line breaks. */
function addAttribute(file: string): boolean {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.split(/\r?\n/).some(hasAttribute)) return false;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const sep = text === '' || text.endsWith('\n') ? '' : eol;
  fs.writeFileSync(file, `${text}${sep}${ATTRIBUTE}${eol}`);
  return true;
}

function install(dir: string, command?: string): number {
  const top = repositoryTop(dir);
  if (!top) return fail(`smd merge --install: ${path.resolve(dir)} is not in a Git repository.`);
  const driver = `${command ?? driverCommand()} merge %O %A %B %L %P`;
  for (const [key, value] of [['merge.smd.name', NAME], ['merge.smd.driver', driver]]) {
    if (run(['config', '--local', key, value], top).status !== 0) return fail(`smd merge --install: git config --local ${key} failed in ${top}.`);
  }
  console.log(`Set merge.smd in ${top}'s local Git config (not the global one):`);
  console.log(`  driver = ${driver}`);
  const attributes = path.join(top, '.gitattributes');
  console.log(addAttribute(attributes) ? `Added "${ATTRIBUTE}" to ${attributes}: commit it, and run smd merge --install in each clone.` : `${attributes} already has "${ATTRIBUTE}".`);
  return 0;
}

function uninstall(dir: string): number {
  const top = repositoryTop(dir);
  if (!top) return fail(`smd merge --uninstall: ${path.resolve(dir)} is not in a Git repository.`);
  const removed = run(['config', '--local', '--remove-section', 'merge.smd'], top).status === 0;
  console.log(removed ? `Removed merge.smd from ${top}'s local Git config.` : `${top}'s local Git config has no merge.smd.`);
  const attributes = path.join(top, '.gitattributes');
  const text = fs.existsSync(attributes) ? fs.readFileSync(attributes, 'utf8') : '';
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const kept = lines.filter((l) => l.trim() !== ATTRIBUTE);
  if (kept.length === lines.length) return 0;
  fs.writeFileSync(attributes, kept.join(''));
  console.log(`Removed "${ATTRIBUTE}" from ${attributes}.`);
  return 0;
}
