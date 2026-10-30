import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyFixes, decisionLogMarkdown, fillTemplate, ganttDocument, markdownToSmd, renderSmd, smdToMarkdown, SMD_VERSION, statusChanges,
  statusReportMarkdown, validateSmd,
} from '../src/core';
import { markdownForV2, migrationPlan, type MigrationOptions, type MigrationPlan } from '../src/core/migrate';
import { checkMigration, comparableHtml } from '../src/core/migrateCheck';
import { writeFileAtomic, type AtomicWriteIo } from '../src/migrateCommand';
import { migrationEdit, migrationNotes, planCounts } from '../src/migrateReport';

/**
 * Styled Markdown 2.0: `smd migrate --to 2` writes (spec v2 RFC, "Rollout and migration"), the editor's "Migrate to
 * Spec v2" applies the same plan as one edit, and the writers of new documents write `smd: 2`.
 */

const TODAY = '2026-10-15';
const root = path.join(__dirname, '..', '..');
const cli = path.join(__dirname, '..', 'dist', 'cli.js');
const noCli = !fs.existsSync(cli) && 'run npm run build first';
const doc = (body: string, smd = 'smd: 1') => `---\n${smd}\n---\n\n${body}\n`;
const crlf = (s: string) => s.replaceAll('\n', '\r\n');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'smd-migrate-write-'));
const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, 'migrate', ...args], { cwd, encoding: 'utf8' });
/** The document as spec v1 and v2 render it, comparable (no source lines). */
const shown = (text: string, readFile?: MigrationOptions['readFile']) => comparableHtml(renderSmd(text, { readFile, today: TODAY }).html);

// ---------------------------------------------------------------------------
// The check after writing
// ---------------------------------------------------------------------------

test('checkMigration: a migrated document renders under spec v2 as the original under v1', () => {
  const original = doc('::::note\nx\n:::\n\nSee :abbr[HTML] and $$ x\ny $$');
  const plan = migrationPlan(original);
  const check = checkMigration(original, plan.result, plan);
  assert.deepEqual(check, { left: [], rendering: 'same', explainedBy: [] });
});

test('checkMigration: a difference the notes or v2-meaning steps explain, and one nothing explains', () => {
  const quoted = doc('"Quoted" -- text.');
  const plan = migrationPlan(quoted);
  assert.deepEqual(checkMigration(quoted, plan.result, plan), { left: [], rendering: 'explained', explainedBy: ['typography'] }, 'typography left off: a note');
  const cased = doc(':::decision{status=Accepted} D\nx\n:::', 'smd: 1\nstatus: Draft');
  const casePlan = migrationPlan(cased);
  assert.equal(checkMigration(cased, casePlan.result, casePlan).rendering, 'same', 'values in the vocabulary\'s case render the same here');
  // A plan that explains nothing, and a written text that renders differently (an include read with the v2 rules).
  const fake: MigrationPlan = { from: 1, steps: [], result: doc('"Quoted"', 'smd: 2') };
  assert.deepEqual(checkMigration(doc('"Quoted"'), fake.result, fake), { left: [], rendering: 'differs', explainedBy: [] });
});

test('checkMigration: changes left in the written document are reported', () => {
  const written = doc('::::note\nx\n:::', 'smd: 2');
  const check = checkMigration(doc('::::note\nx\n:::'), written, { from: 1, steps: [], result: written });
  assert.deepEqual(check.left.map((s) => s.kind), ['closer']);
});

// ---------------------------------------------------------------------------
// The editor command's edit
// ---------------------------------------------------------------------------

/** Apply an edit to a text, as the editor does. */
const applied = (text: string, plan: MigrationPlan) => {
  const edit = migrationEdit(text, plan);
  return edit ? text.slice(0, edit.start) + edit.text + text.slice(edit.end) : text;
};

test('migrationEdit: one edit over the changed lines, which gives the migrated text', () => {
  for (const text of [
    doc('Intro.\n\n::::note\nx\n:::\n\nEnd.'),
    crlf(doc('Intro.\n\n::::note\nx\n:::\n\nEnd.')),
    'No front matter, see :abbr[x].\n',
    '\nStarts with a blank line.',
    doc('A.\n\n:abbr[x]\n\nB.\n\n:sep{.w}\n\nC.'),
  ]) {
    const plan = migrationPlan(text);
    const edit = migrationEdit(text, plan);
    assert.ok(edit, JSON.stringify(text));
    assert.equal(applied(text, plan), plan.result, JSON.stringify(text));
    // Line boundaries, so it never splits a CRLF: the edit starts a line and ends before one (or at the end).
    assert.ok(edit.start === 0 || text[edit.start - 1] === '\n', 'starts a line');
    assert.ok(edit.end === text.length || text[edit.end - 1] === '\n', 'ends a line');
  }
  const text = doc('One.\n\nTwo.\n\n::::note\nx\n:::\n\nThree.');
  const edit = migrationEdit(text, migrationPlan(text))!;
  assert.equal(text.slice(0, edit.start), '---\n', 'the lines before the first change are kept');
  assert.equal(text.slice(edit.end), '\nThree.\n', 'and the lines after the last');
  // The edit's text ends a line too: the closer `:::` that becomes `::::` is replaced, not prefixed with a colon.
  assert.match(edit.text, /\n::::\n$/);
});

test('migrationEdit: nothing to apply for a spec v2 document, or a plan with only notes', () => {
  const v2 = doc('"Quoted"', 'smd: 2');
  assert.equal(migrationEdit(v2, migrationPlan(v2)), undefined);
  const broken = '---\ntitle: [x\n---\n\nText.\n';
  const plan = migrationPlan(broken);
  assert.equal(planCounts(plan).changes, 0);
  assert.equal(migrationEdit(broken, plan), undefined);
  assert.match(migrationNotes(plan), /^ {2}line 3, note: Spec version: Not rewritten: the front matter does not parse/);
});

// ---------------------------------------------------------------------------
// Writing a file whole or not at all
// ---------------------------------------------------------------------------

test('writeFileAtomic: the new text replaces the file; a failed step leaves the file and no temporary file', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'a.smd');
    fs.writeFileSync(file, 'old\r\n');
    writeFileAtomic(file, 'new\r\nlines');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new\r\nlines', 'written exactly: line endings and no added newline');
    for (const step of ['writeSync', 'renameSync', 'openSync'] as const) {
      const io: AtomicWriteIo = { ...fs, [step]: () => { throw new Error(`${step} failed`); } };
      assert.throws(() => writeFileAtomic(file, 'partial', io), new RegExp(`${step} failed`));
      assert.equal(fs.readFileSync(file, 'utf8'), 'new\r\nlines', `${step}: the file is unchanged`);
      assert.deepEqual(fs.readdirSync(dir), ['a.smd'], `${step}: no temporary file is left`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The CLI writes
// ---------------------------------------------------------------------------

test('CLI: smd migrate --to 2 writes each file that needs it, keeps line endings, and prints the notes', { skip: noCli }, () => {
  const dir = tempDir();
  try {
    const files: Record<string, string> = {
      'old.smd': doc('"Quoted" text.\n\n::::note\nx\n:::'),
      'windows.smd': crlf(doc('::::note\nx\n:::\n\nSee :abbr[HTML].')).replace(/\r\n$/, ''),
      'bare.smd': 'No front matter.',
      'done.smd': doc('Already "v2".', 'smd: 2'),
      'broken.smd': '---\ntitle: [x\n---\n\nText.\n',
      'notes.md': '# Not .smd\n',
    };
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    const expected = (name: string) => migrationPlan(files[name]).result;

    const check = run(dir, '.', '--to', '2', '--check');
    assert.equal(check.status, 1, 'something to migrate: --check exits 1');
    assert.match(check.stdout, /old\.smd: needs migrating to spec v2 \(2 changes\)/);
    assert.match(check.stdout, /\n5 files checked: 3 to migrate to spec v2\.\nRun smd migrate --to 2 to migrate them/);
    assert.doesNotMatch(check.stdout, /done\.smd|broken\.smd/);
    for (const [name, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), text, `--check writes nothing: ${name}`);

    const written = run(dir, '.', '--to', '2');
    assert.equal(written.status, 0, written.stderr);
    assert.equal(written.stderr, '');
    assert.match(written.stdout, /old\.smd: migrated to spec v2 \(2 changes, 1 note\)\n {2}line 5, note: Typography: Spec v2 turns the typographer off/);
    assert.match(written.stdout, /windows\.smd: migrated to spec v2 \(3 changes\)\n/);
    assert.match(written.stdout, /broken\.smd: nothing to migrate\n {2}line 3, note: Spec version: Not rewritten/);
    assert.doesNotMatch(written.stdout, /done\.smd/, 'a spec v2 file is not mentioned');
    assert.match(written.stdout, /\n5 files checked: 3 migrated to spec v2 \(6 changes\)\.\n2 notes to follow up/);
    assert.match(written.stdout, /\nVerified: nothing is left to migrate, and spec v2 renders each file as v1 rendered it, apart from what the notes and v2-meaning steps say \(typography\)\./);
    for (const name of ['old.smd', 'windows.smd', 'bare.smd']) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), expected(name), name);
    assert.match(fs.readFileSync(path.join(dir, 'windows.smd'), 'utf8'), /^---\r\nsmd: 2\r\n[^]*\\:abbr\[HTML\]\.$/, 'CRLF kept, and no newline added at the end');
    assert.equal(fs.readFileSync(path.join(dir, 'bare.smd'), 'utf8'), '---\nsmd: 2\n---\n\nNo front matter.');
    for (const name of ['done.smd', 'broken.smd', 'notes.md']) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), files[name], `${name} is not written`);
    assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(files).sort(), 'no temporary file is left');

    // Running it again changes nothing: every file says smd: 2 now, and the plan of an smd: 2 document is empty.
    const after = Object.fromEntries(Object.keys(files).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
    const again = run(dir, '.', '--to', '2');
    assert.equal(again.status, 0);
    assert.match(again.stdout, /5 files checked: 0 migrated to spec v2 \(0 changes\)\./);
    assert.doesNotMatch(again.stdout, /Verified|Review the changes/);
    for (const name of Object.keys(files)) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), after[name], `idempotent: ${name}`);
    assert.equal(run(dir, '.', '--to', '2', '--check').status, 0, '--check passes once migrated');
    assert.equal(run(dir, '.', '--to', '2', '--dry-run').status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: smd migrate --to 2 refuses files that are not .smd, before writing anything', { skip: noCli }, () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'a.smd'), doc('::::note\nx\n:::'));
    fs.writeFileSync(path.join(dir, 'b.md'), doc('::::note\nx\n:::'));
    const r = run(dir, 'a.smd', 'b.md', '--to', '2');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^Not migrated: b\.md is not a \.smd file\. smd migrate writes only \.smd files/);
    assert.equal(fs.readFileSync(path.join(dir, 'a.smd'), 'utf8'), doc('::::note\nx\n:::'), 'nothing is written');
    assert.equal(fs.readFileSync(path.join(dir, 'b.md'), 'utf8'), doc('::::note\nx\n:::'));
    assert.equal(run(dir, 'b.md', '--to', '2', '--dry-run').status, 1, '--dry-run still reports on any file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: smd migrate --to 2 does not write through a symbolic link that leads outside the paths given', { skip: noCli }, (t) => {
  const dir = tempDir();
  try {
    const inside = path.join(dir, 'docs');
    const outside = path.join(dir, 'elsewhere');
    fs.mkdirSync(inside);
    fs.mkdirSync(outside);
    const target = path.join(outside, 'shared.smd');
    fs.writeFileSync(target, doc('::::note\nx\n:::'));
    fs.writeFileSync(path.join(inside, 'own.smd'), doc('::::note\nx\n:::'));
    try {
      fs.symlinkSync(target, path.join(inside, 'link.smd'), 'file');
    } catch {
      t.skip('this system does not let us create symbolic links');
      return;
    }
    const r = run(dir, 'docs', '--to', '2');
    assert.equal(r.status, 1, 'not everything was migrated');
    assert.match(r.stderr, /link\.smd: not migrated: it is a symbolic link to .*shared\.smd, outside the paths given\./);
    assert.equal(fs.readFileSync(target, 'utf8'), doc('::::note\nx\n:::'), 'the file outside is unchanged');
    assert.match(fs.readFileSync(path.join(inside, 'own.smd'), 'utf8'), /^---\nsmd: 2\n/, 'the others are migrated');
    assert.match(r.stdout, /2 files checked: 1 migrated to spec v2 \(2 changes\), 1 not migrated\./);
    // A link to a file inside the paths given writes that file, once, and keeps the link.
    fs.rmSync(path.join(inside, 'link.smd'));
    fs.writeFileSync(path.join(inside, 'real.smd'), doc('::::note\nx\n:::'));
    fs.symlinkSync(path.join(inside, 'real.smd'), path.join(inside, 'alias.smd'), 'file');
    const linked = run(dir, 'docs', '--to', '2');
    assert.equal(linked.status, 0, linked.stderr);
    assert.ok(fs.lstatSync(path.join(inside, 'alias.smd')).isSymbolicLink(), 'the link stays a link');
    assert.match(fs.readFileSync(path.join(inside, 'real.smd'), 'utf8'), /^---\nsmd: 2\n/);
    assert.match(linked.stdout, /: 1 migrated to spec v2 \(2 changes\)\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a file that cannot be written is reported, left as it was, and the exit code is 1', { skip: noCli }, (t) => {
  if (process.platform !== 'win32' && process.getuid?.() === 0) {
    t.skip('root can write read-only files');
    return;
  }
  const dir = tempDir();
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked);
  const file = path.join(locked, 'a.smd');
  try {
    fs.writeFileSync(file, doc('::::note\nx\n:::'));
    // Windows refuses to replace a read-only file; elsewhere, a read-only folder refuses the temporary file.
    fs.chmodSync(file, 0o444);
    if (process.platform !== 'win32') fs.chmodSync(locked, 0o555);
    const r = run(dir, 'locked', '--to', '2');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /a\.smd: not written \(.+\)\. The file is unchanged\./);
    assert.equal(fs.readFileSync(file, 'utf8'), doc('::::note\nx\n:::'));
    assert.deepEqual(fs.readdirSync(locked), ['a.smd'], 'no temporary file is left');
    assert.match(r.stdout, /1 file checked: 0 migrated to spec v2 \(0 changes\), 1 not migrated\./);
  } finally {
    fs.chmodSync(locked, 0o755);
    fs.chmodSync(file, 0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: the check after writing warns when spec v2 renders a file differently and no step says why', { skip: noCli }, () => {
  const dir = tempDir();
  try {
    // Included text is read with the including document's version: once it says smd: 2, the included quotes stay
    // straight, and the plan of the including document can't see them.
    fs.writeFileSync(path.join(dir, 'main.smd'), doc(':::include{file="part.smd"}\n[Part](part.smd)\n:::'));
    fs.writeFileSync(path.join(dir, 'part.smd'), 'A "quoted" part.\n');
    const r = run(dir, 'main.smd', '--to', '2');
    assert.equal(r.status, 0, 'a warning, not a failure');
    assert.match(r.stdout, /main\.smd: migrated to spec v2 \(1 change\)/);
    assert.match(r.stderr, /main\.smd: warning: spec v2 renders the migrated file differently from how v1 rendered it, and no step says why/);
    assert.match(r.stdout, /Verified, with 1 warning: see them above\./);
    fs.writeFileSync(path.join(dir, 'main.smd'), doc(':::include{file="part.smd"}\n[Part](part.smd)\n:::'));
    const quiet = run(dir, 'main.smd', '--to', '2', '--no-verify');
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stderr, '', '--no-verify skips the check');
    assert.doesNotMatch(quiet.stdout, /Verified/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A `$$` that never closes, which rendering reads as text that opens nothing, before fences the plan must rewrite. */
const UNCLOSED_MATH = '---\nsmd: 1\ntitle: X\n---\n\nPricing:\n$$5 per seat\n\n::::tabs\n:::tab A\nOne.\n::::\n:::\n';

test('validate: a $$ that nothing closes opens nothing; the lines after it are checked (both versions)', () => {
  const codes = (text: string) => validateSmd(text).map((d) => `${d.line + 1} ${d.code}`);
  assert.deepEqual(codes(UNCLOSED_MATH), ['7 math/unclosed', '12 container/colons', '13 container/colons']);
  assert.deepEqual(codes('---\nsmd: 2\n---\n\n$$\nx\n\n:::warnign\ny\n:::\n'), ['5 math/unclosed', '8 container/unknown']);
  // Each opener that nothing closes is reported; none hides the lines after it.
  assert.deepEqual(codes('---\nsmd: 1\n---\n\n$$a\n\n:::warnign\nz\n:::\n\n$$b\n'), ['5 math/unclosed', '7 container/unknown', '11 math/unclosed']);
  // Math that a later line closes is still math: nothing inside it is checked.
  assert.deepEqual(codes('---\nsmd: 1\n---\n\n$$\n:::warnign\n$$\n'), []);
  // A fence inside unclosed math is still a fence, and a $$ in it closes nothing.
  assert.deepEqual(codes('---\nsmd: 1\n---\n\n$$ x\n```\ny $$\n```\n\n:::warnign\nz\n:::\n'), ['5 math/unclosed', '10 container/unknown']);
});

test('migrate: fences after math that v1 closes and v2 does not are written as v2 pairs them (found by fuzzing)', () => {
  // v1 closes the math on the last line ($$$$$$, $$E = mc^2$$); the $$ step leaves it alone, since splitting it would
  // change the math, so spec v2 reads the $$ as text and the :::: as a fence.
  for (const text of ['$$\n:::human Why\n::::\n$$$$$$', '<div>\n:::agent Rules\n</div>\n$$\n::::\n$$E = mc^2$$']) {
    const plan = migrationPlan(text);
    assert.ok(plan.steps.some((s) => s.kind === 'closer'), text);
    assert.deepEqual(migrationPlan(plan.result, { force: true }).steps.filter((s) => !s.note), [], `${text}: the plan settles`);
  }
});

test('CLI: a $$ that never closes doesn\'t hide the closing fences after it from the plan', { skip: noCli }, () => {
  const plan = migrationPlan(UNCLOSED_MATH);
  assert.deepEqual(plan.steps.map((s) => s.kind), ['closer', 'closer', 'version']);
  assert.equal(shown(plan.result), shown(UNCLOSED_MATH), 'spec v2 renders the migrated document as v1 renders the original');
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'pricing.smd'), UNCLOSED_MATH);
    const r = run(dir, 'pricing.smd', '--to', '2');
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'no warning from the check after writing');
    assert.match(r.stdout, /pricing\.smd: migrated to spec v2 \(3 changes\)/);
    assert.equal(fs.readFileSync(path.join(dir, 'pricing.smd'), 'utf8'), plan.result);
    assert.match(plan.result, /\nOne\.\n:::\n::::\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Every tracked document, migrated on disk
// ---------------------------------------------------------------------------

/** The tracked .smd files, relative to the repository (every .smd file outside generated folders without Git). */
function trackedDocuments(): string[] {
  const git = spawnSync('git', ['ls-files', '-z', '--', '*.smd'], { cwd: root, encoding: 'utf8' });
  if (git.status === 0 && git.stdout) return git.stdout.split('\0').filter(Boolean).sort((a, b) => a.localeCompare(b));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (['node_modules', 'dist', 'out', 'site'].includes(entry.name) || entry.name.startsWith('.')) continue;
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.smd')) out.push(rel.replaceAll('\\', '/'));
    }
  };
  walk('');
  return out.sort((a, b) => a.localeCompare(b));
}

/** A reader of files next to `file`, as the CLI's (inside the copy). */
const readerIn = (file: string) => (rel: string) => {
  try { return fs.readFileSync(path.resolve(path.dirname(file), rel), 'utf8'); } catch { return undefined; }
};

test('every tracked v1 document, migrated by the CLI, renders under spec v2 as it did under v1', { skip: noCli }, () => {
  const documents = trackedDocuments();
  const dir = tempDir();
  try {
    // Two copies: the original, and one to migrate (with the options that keep typography, links and values).
    for (const copy of ['original', 'migrated', 'default']) {
      for (const rel of documents) {
        fs.mkdirSync(path.join(dir, copy, path.dirname(rel)), { recursive: true });
        fs.copyFileSync(path.join(root, rel), path.join(dir, copy, rel));
      }
    }
    const v1 = documents.filter((rel) => migrationPlan(fs.readFileSync(path.join(root, rel), 'utf8')).from < 2);
    assert.ok(v1.length > 30, `${v1.length} v1 documents`);

    // Without options: typography and bare domains are notes, so their rendering may differ, as the check says.
    const plain = run(dir, 'default', '--to', '2');
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stderr, '', 'no file fails the check after writing');
    assert.match(plain.stdout, /\nVerified: nothing is left to migrate/);

    const r = run(dir, 'migrated', '--to', '2', '--keep-typography', '--link-domains', '--quote-variables');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    let compared = 0;
    for (const rel of v1) {
      const original = path.join(dir, 'original', rel);
      const migrated = path.join(dir, 'migrated', rel);
      const before = fs.readFileSync(original, 'utf8');
      const after = fs.readFileSync(migrated, 'utf8');
      const plan = migrationPlan(before, { readFile: readerIn(original), keepTypography: true, linkDomains: true, quoteVariables: true });
      assert.equal(after, plan.result, `${rel}: written as planned`);
      assert.deepEqual(migrationPlan(after).steps, [], `${rel}: nothing left to migrate`);
      // Values written in the vocabulary's case and values shown as written (proposals 11 and 10) are meant to show
      // as spec v2 shows them: corpus/vocabulary-case.smd, corpus/migrate.smd and examples/showcase.smd.
      if (plan.steps.some((s) => !s.note && (s.kind === 'value-case' || s.kind === 'variable-spelling'))) continue;
      assert.equal(shown(after, readerIn(migrated)), shown(before, readerIn(original)), `${rel}: spec v2 renders the migrated file as v1 rendered it`);
      compared++;
    }
    assert.ok(compared >= v1.length - 3, `${compared} of ${v1.length} compared`);
    for (const rel of documents) {
      const unchanged = migrationPlan(fs.readFileSync(path.join(root, rel), 'utf8')).from >= 2;
      if (unchanged) assert.equal(fs.readFileSync(path.join(dir, 'migrated', rel), 'utf8'), fs.readFileSync(path.join(root, rel), 'utf8'), `${rel} already says smd: 2`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Writers write smd: 2
// ---------------------------------------------------------------------------

const TEMPLATE_DIR = path.join(root, 'skills', 'styled-markdown-writer', 'assets', 'templates');
const templates = () => fs.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.smd')).sort((a, b) => a.localeCompare(b));

test('every writer of new documents writes smd: 2', () => {
  assert.equal(SMD_VERSION, 2);
  const smd2 = /^---\r?\nsmd: 2\r?\n/;
  assert.match(markdownToSmd('# Title\n\nText.\n', 'x'), smd2, 'smd from-md');
  assert.match(markdownToSmd('---\ntitle: X\n---\n\nText.\n', 'x'), smd2, 'smd from-md, with front matter');
  assert.match(decisionLogMarkdown([]), smd2, 'smd decisions --md');
  assert.match(statusReportMarkdown(statusChanges(null, [{ path: 'a.smd', text: doc('- [ ] Task') }], { today: TODAY })), smd2, 'smd report');
  assert.match(ganttDocument('gantt\n'), smd2, 'smd tasks --gantt --smd');
  for (const name of templates()) assert.match(fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf8'), smd2, `smd init --template ${name}`);
  assert.equal(templates().length, 16);
  assert.match(fs.readFileSync(path.join(root, 'playground', 'starter.smd'), 'utf8'), smd2, 'the playground');
  const snippets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'snippets', 'smd.json'), 'utf8')) as Record<string, { body: string[] }>;
  assert.equal(snippets['Front matter'].body[1], 'smd: 2', 'the front matter snippet');
  // A document that has front matter and says which version reads it keeps it.
  assert.match(markdownToSmd('---\nsmd: 1\ntitle: X\n---\n\nText.\n', 'x'), /^---\nsmd: 1\n/);
});

test('the fix for a missing smd key writes smd: 1, the version the document is read with', () => {
  // Adding smd: 2 would change which rules read an existing document (typography, links, directives): that is what
  // smd migrate --to 2 does, carefully. `smd validate --fix` keeps the document's meaning.
  const text = '---\ntitle: X\n---\n\n"Quoted" -- text.\n';
  const fixed = applyFixes(text, validateSmd(text).filter((d) => d.code === 'frontmatter/version'));
  assert.equal(fixed.text, '---\nsmd: 1\ntitle: X\n---\n\n"Quoted" -- text.\n');
  assert.equal(shown(fixed.text), shown(text));
});

test('every template validates under spec v2 and shows what it showed under v1, but for straight quotes', () => {
  /** v1's curly quotes written straight, as spec v2 shows them without typography: true. */
  const straight = (html: string) => html.replaceAll(/[‘’]/g, '\'').replaceAll(/[“”]/g, '&quot;');
  for (const name of templates()) {
    const text = fillTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf8'), 'Saved searches', TODAY);
    const v1 = text.replace(/^smd: 2$/m, 'smd: 1');
    const problems = (s: string) => validateSmd(s).filter((d) => d.severity === 'error' || d.severity === 'warning').map((d) => `${d.line + 1} ${d.code}`);
    assert.deepEqual(problems(text), [], `${name}: no errors or warnings under spec v2`);
    assert.deepEqual(problems(text), problems(v1), name);
    // No dashes, ellipses, symbols or bare domain links that only the v1 rules make: only quotes differ.
    assert.equal(shown(text), straight(shown(v1)), `${name}: spec v2 shows the template as v1 does, with straight quotes`);
    assert.ok(migrationPlan(v1).steps.every((s) => s.kind === 'version' || (s.kind === 'typography' && /\(\d+ quotes?\)/.test(s.reason))), name);
  }
});

// ---------------------------------------------------------------------------
// from-md: Markdown read with the spec v2 rules, as GitHub shows it
// ---------------------------------------------------------------------------

test('from-md: the converted Markdown shows under spec v2 as GitHub shows the .md', () => {
  const md = [
    '# Guide', '',
    'It\'s "quoted" -- see example.com, www.example.com or https://example.com/x... (c) 2026.', '',
    '## Returns {ok}', '',
    '> [!NOTE]', '> Hello "there".', '',
    '$$', 'x^2', '$$', '',
    '$$ a', 'b $$', '',
    'Costs $5 and $10.', '',
    'Write :abbr[HTML], :Badge[x] and :sep{.wide}; keep `:code[x]` and 10:30[1].', '',
  ].join('\n');
  const smd = markdownToSmd(md, 'fallback');
  assert.match(smd, /^---\nsmd: 2\ntitle: "Guide"\nstatus: draft\nupdated: \d{4}-\d{2}-\d{2}\n---\n\n/);
  assert.match(smd, /\n\$\$\na\nb\n\$\$\n/, 'multi-line $$ delimiters on their own lines, so the math stays math');
  assert.match(smd, /Write \\:abbr\[HTML\], \\:Badge\[x\] and \\:sep\{\.wide\}; keep `:code\[x\]` and 10:30\[1\]\./, 'literal :name[…] stays text');
  const html = renderSmd(smd, { today: TODAY }).html;
  assert.match(html, /It's &quot;quoted&quot; -- see example\.com, <a href="http:\/\/www\.example\.com">www\.example\.com<\/a> or <a href="https:\/\/example\.com\/x">https:\/\/example\.com\/x<\/a>\.\.\. \(c\) 2026\./, 'text as written; GFM autolinks only');
  assert.match(html, /<h2 id="returns-ok"[^>]*>Returns \{ok\}<\/h2>/, 'a heading\'s {word} is text');
  assert.match(html, /Write :abbr\[HTML\], :Badge\[x\] and :sep\{\.wide\}; keep <code>:code\[x\]<\/code> and 10:30\[1\]\./);
  assert.equal((html.match(/class="smd-math-block"/g) ?? []).length, 2, 'both display math blocks');
  assert.match(html, /<p[^>]*>Costs \$5 and \$10\.<\/p>/);
  assert.match(html, /smd-callout-note/);
  assert.deepEqual(validateSmd(smd).filter((d) => d.severity === 'error' || d.severity === 'warning'), []);
});

test('from-md: Markdown without anything spec v2 reads differently is only given front matter', () => {
  const md = 'Intro with `code`, **bold** and [a link](https://example.com).\n\n- [ ] Task\n';
  assert.equal(markdownForV2(md), md);
  assert.match(markdownToSmd(md, 'notes'), /^---\nsmd: 2\ntitle: "notes"\nstatus: draft\nupdated: [\d-]+\n---\n\nIntro with `code`/);
  assert.equal(markdownToSmd('\r\n', 'x').startsWith('---\nsmd: 2\n'), true);
});

test('from-md round trips: to-md and back gives the same document', () => {
  for (const md of [
    '# Guide\n\nIt\'s "quoted" -- see example.com.\n\n## Returns {ok}\n\n> [!WARNING]\n> Careful.\n\n$$ x\ny $$\n\nWrite :abbr[HTML] here.\n\n- [ ] task\n',
    '---\ntitle: Kept\ntags: [a]\n---\n\n## Section\n\n> [!TIP]\n> A tip.\n',
  ]) {
    const smd = markdownToSmd(md, 'x');
    const back = markdownToSmd(smdToMarkdown(smd), 'x');
    // to-md ends a blockquote with a blank line, which comes back at the end of the file.
    assert.equal(back.trimEnd(), smd.trimEnd());
    assert.equal(shown(back), shown(smd));
  }
});
