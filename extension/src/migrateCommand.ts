import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { migrationPlan, type MigrationOptions, type MigrationPlan } from './core/migrate';
import { checkMigration } from './core/migrateCheck';
import { migrationNotes, migrationReport, migrationSummary, planCounts } from './migrateReport';
import { fail } from './cliIo';
import { collect, read, readerFor } from './workspace';

/**
 * `smd migrate <files|dirs...> --to 2`: migrate documents to spec v2 (SPEC.md §10.1), report the plan (`--dry-run`),
 * or only say whether anything needs migrating (`--check`, for CI).
 *
 * Writing is careful: only `.smd` files, only files whose plan changes something, never a file that a symbolic link
 * leads to outside the paths given, and each file written whole or not at all (a temporary file in the same folder,
 * renamed over it). After writing, each file is read back and checked (`--no-verify` skips it): nothing left to
 * migrate, and spec v2 renders it as v1 rendered the original, or the plan says why not.
 */

export interface MigrateArgs { flags: ReadonlySet<string>; values: ReadonlyMap<string, string[]> }

const OPTIONS = '[--dry-run | --check] [--json] [--no-verify] [--keep-typography] [--link-domains] [--quote-variables]';
export const MIGRATE_USAGE = `Usage: smd migrate <files|dirs...> --to 2 ${OPTIONS}`;
const MIGRATE_FLAGS = new Set(['--dry-run', '--check', '--json', '--no-verify', '--keep-typography', '--link-domains', '--quote-variables']);

export const MIGRATE_HELP = `  smd migrate <files|dirs...> --to 2 ${OPTIONS}
      Migrate documents to spec v2 (smd: 2) so each keeps its meaning: closing fences, duplicate attributes,
      title text, $$ delimiters, heading braces, attribute escapes, unknown :name[…] escaped, include
      sections, value case, and smd: 2. Unlike fmt, it changes meaning, so it is its own command.
      Writes only .smd files with something to change, each whole or not at all, never through a symbolic
      link that leads outside the paths given. Prints each file it writes, then the notes the plan leaves
      to you (typography, links in the title or summary, values shown as written …). A file that already
      says smd: 2 has nothing to migrate.
      Then reads each file back and checks that nothing is left to migrate and that spec v2 renders it as
      v1 rendered the original, apart from what the notes and v2-meaning steps say; a difference is a
      warning (--no-verify skips the check).
      Exit code 0 when done or nothing needs migrating, 1 when a file could not be written (or a link
      leads outside the paths given), 2 on a usage error.
      --dry-run          report the plan and write nothing: per file, each step with its lines and a
                         short diff. Exit code 1 when something needs migrating
      --check            write nothing; list the files that need migrating and exit 1 if there are any (CI)
      --json             with --dry-run or --check, the plan: per file, each step's kind, lines (0-based),
                         before, after and reason, and the migrated text
      --keep-typography  add "typography: true" where the typographer changes text, to keep curly quotes
                         and dashes (v2 turns it off); without it, a note counts the places
      --link-domains     write bare domains linked today (example.com) as [example.com](http://example.com)
      --quote-variables  quote front matter values shown differently from how they are written (2.10)
`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface Planned { file: string; plan: MigrationPlan }

export function runMigrate(targets: string[], args: MigrateArgs): number {
  const to = args.values.get('--to')?.[0];
  if (to !== '2') {
    const problem = to === undefined ? 'migrate needs --to 2.' : `Cannot migrate to "${to}": the only target is spec v2 (--to 2).`;
    return fail(`${problem}\n${MIGRATE_USAGE}`);
  }
  const unknown = [...args.flags].find((f) => !MIGRATE_FLAGS.has(f));
  if (unknown) return fail(`Unknown option "${unknown}" for migrate.\n${MIGRATE_USAGE}`);
  const dryRun = args.flags.has('--dry-run');
  const check = args.flags.has('--check');
  if (args.flags.has('--json') && !dryRun && !check) return fail(`--json reports the plan: use it with --dry-run or --check.\n${MIGRATE_USAGE}`);
  const files = targets.flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const options: MigrationOptions = {
    keepTypography: args.flags.has('--keep-typography'), linkDomains: args.flags.has('--link-domains'), quoteVariables: args.flags.has('--quote-variables'),
  };
  if (!dryRun && !check) return writeMigrations(targets, files, options, !args.flags.has('--no-verify'));
  const plans = files.map((file) => ({ file, plan: migrationPlan(read(file), { ...options, readFile: readerFor(file) }) }));
  if (args.flags.has('--json')) printJson(plans);
  else if (dryRun) process.stdout.write(plans.map(({ file, plan }) => migrationReport(file, plan)).join('\n') + migrationSummary(plans.map((p) => p.plan)));
  else printCheck(plans);
  return plans.some(({ plan }) => planCounts(plan).changes > 0) ? 1 : 0;
}

function printJson(plans: Planned[]): void {
  const counts = plans.map(({ plan }) => planCounts(plan));
  const json = {
    files: plans.map(({ file, plan }) => ({ file, from: plan.from, steps: plan.steps, result: plan.result })),
    changes: counts.reduce((n, c) => n + c.changes, 0),
    notes: counts.reduce((n, c) => n + c.notes, 0),
  };
  process.stdout.write(JSON.stringify(json, null, 2) + '\n');
}

/** `--check`: one line per file that needs migrating, as `smd fmt --check` lists unformatted files. */
function printCheck(plans: Planned[]): void {
  const need = plans.filter(({ plan }) => planCounts(plan).changes > 0);
  for (const { file, plan } of need) console.log(`${file}: needs migrating to spec v2 (${plural(planCounts(plan).changes, 'change')})`);
  const next = need.length ? '\nRun smd migrate --to 2 to migrate them (--dry-run shows the plan).' : '';
  console.log(`\n${plural(plans.length, 'file')} checked: ${need.length} to migrate to spec v2.${next}`);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** What writing a file needs from `fs`, so a test can make a step fail. */
export interface AtomicWriteIo {
  openSync: typeof fs.openSync;
  writeSync: (fd: number, text: string) => number;
  fsyncSync: typeof fs.fsyncSync;
  closeSync: typeof fs.closeSync;
  renameSync: typeof fs.renameSync;
  rmSync: typeof fs.rmSync;
  statSync: (file: string) => { mode: number };
}

/**
 * Replace `file` with `text`, whole or not at all: the text goes to a new temporary file in the same folder (so the
 * rename never crosses file systems), with the file's permissions, and is renamed over it. On any error the temporary
 * file is removed and the error thrown: `file` is as it was.
 */
export function writeFileAtomic(file: string, text: string, io: AtomicWriteIo = fs): void {
  const mode = io.statSync(file).mode & 0o7777;
  // A dot file, which collect() skips, in case it is ever left behind.
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const fd = io.openSync(temp, 'wx', mode);
    try {
      io.writeSync(fd, text);
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
    io.renameSync(temp, file);
  } catch (error) {
    try { io.rmSync(temp, { force: true }); } catch { /* nothing to remove */ }
    throw error;
  }
}

/** Whether `inner` is `outer` or inside it. */
function isWithin(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The real folders the files may be in: each folder given, and the folder of each file given. */
function realRoots(targets: string[]): string[] {
  return targets.filter((t) => fs.existsSync(t)).map((t) => fs.realpathSync(fs.statSync(t).isDirectory() ? t : path.dirname(path.resolve(t))));
}

function realPath(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
}

interface WriteTotals { checked: number; written: number; changes: number; notes: number; failed: number; warned: number; explained: string[] }

function writeMigrations(targets: string[], files: string[], options: MigrationOptions, verify: boolean): number {
  const other = files.find((f) => path.extname(f).toLowerCase() !== '.smd');
  if (other) return fail(`Not migrated: ${other} is not a .smd file. smd migrate writes only .smd files (--dry-run reports on any file).`);
  const roots = realRoots(targets);
  const totals: WriteTotals = { checked: 0, written: 0, changes: 0, notes: 0, failed: 0, warned: 0, explained: [] };
  const seen = new Set<string>();
  for (const file of files) {
    const real = realPath(file);
    if (real === undefined) {
      console.error(`${file}: not migrated: it is a symbolic link to a file that does not exist.`);
      totals.failed++;
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    totals.checked++;
    if (!roots.some((root) => isWithin(root, real))) {
      console.error(`${file}: not migrated: it is a symbolic link to ${real}, outside the paths given.`);
      totals.failed++;
      continue;
    }
    migrateFile(file, real, options, verify, totals);
  }
  console.log(writeSummary(totals, verify));
  return totals.failed ? 1 : 0;
}

/** Plan, write, print and check one file (`real` is where it is written: the file a link inside the paths leads to). */
function migrateFile(file: string, real: string, options: MigrationOptions, verify: boolean, totals: WriteTotals): void {
  const fileOptions = { ...options, readFile: readerFor(file) };
  const original = read(real);
  const plan = migrationPlan(original, fileOptions);
  const { changes, notes } = planCounts(plan);
  totals.notes += notes;
  if (!changes) {
    if (notes) process.stdout.write(`${file}: nothing to migrate\n${migrationNotes(plan)}`);
    return;
  }
  try {
    writeFileAtomic(real, plan.result);
  } catch (error) {
    console.error(`${file}: not written (${(error as Error).message}). The file is unchanged.`);
    totals.failed++;
    return;
  }
  totals.written++;
  totals.changes += changes;
  const counts = notes ? [plural(changes, 'change'), plural(notes, 'note')] : [plural(changes, 'change')];
  process.stdout.write(`${file}: migrated to spec v2 (${counts.join(', ')})\n${migrationNotes(plan)}`);
  if (verify) verifyFile(file, real, original, plan, fileOptions, totals);
}

/** Read the written file back and check it: warnings on stderr, an error when it isn't what was written. */
function verifyFile(file: string, real: string, original: string, plan: MigrationPlan, options: MigrationOptions, totals: WriteTotals): void {
  const written = read(real);
  if (written !== plan.result) {
    console.error(`${file}: error: the file read back is not the migrated text; something else changed it. Check it against your version control.`);
    totals.failed++;
    return;
  }
  const result = checkMigration(original, written, plan, options);
  if (result.left.length) {
    const kinds = [...new Set(result.left.map((s) => s.kind))].join(', ');
    console.error(`${file}: warning: the migrated file still has ${plural(result.left.length, 'change')} to migrate (${kinds}). Please report it.`);
    totals.warned++;
  }
  if (result.rendering === 'differs') {
    console.error(`${file}: warning: spec v2 renders the migrated file differently from how v1 rendered it, and no step says why. Compare the two (smd export --to html) before you commit it.`);
    totals.warned++;
  }
  if (result.rendering === 'explained') totals.explained.push(...result.explainedBy.filter((k) => !totals.explained.includes(k)));
}

function writeSummary(t: WriteTotals, verify: boolean): string {
  const failed = t.failed ? `, ${t.failed} not migrated` : '';
  const lines = [`\n${plural(t.checked, 'file')} checked: ${t.written} migrated to spec v2 (${plural(t.changes, 'change')})${failed}.`];
  if (t.notes) lines.push(`${plural(t.notes, 'note')} to follow up: see them under each file.`);
  if (verify && t.written) lines.push(verifiedLine(t));
  if (t.written) lines.push('Review the changes (git diff) before you commit them.');
  return lines.join('\n');
}

function verifiedLine(t: WriteTotals): string {
  if (t.warned) return `Verified, with ${plural(t.warned, 'warning')}: see them above.`;
  const apart = t.explained.length ? `, apart from what the notes and v2-meaning steps say (${t.explained.join(', ')})` : '';
  return `Verified: nothing is left to migrate, and spec v2 renders each file as v1 rendered it${apart}.`;
}
