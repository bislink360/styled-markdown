import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { blockMerge, isMergeDoubt, splitLines, type BlockMergeResult } from '../src/core/blockMerge';
import { gitMergeFile, resolveMerge } from '../src/mergeCommand';
import { prng } from './fuzz/generate';

const merged = (base: string, ours: string, theirs: string, options = {}): BlockMergeResult => {
  const r = blockMerge(base, ours, theirs, options);
  if (isMergeDoubt(r)) assert.fail(`unexpected doubt: ${r.doubt}`);
  return r;
};

const lines = (...l: string[]) => l.map((s) => `${s}\n`).join('');

test('blockMerge: edits to neighbouring list items merge', () => {
  const base = lines('# Plan', '', '- one', '- two', '- three');
  const r = merged(base, base.replace('- one', '- ONE'), base.replace('- two', '- TWO'));
  assert.deepEqual(r, { text: lines('# Plan', '', '- ONE', '- TWO', '- three'), conflicts: 0 });
  // Nested items are units too.
  const nested = lines('- a', '  - b', '  - c', '- d');
  assert.equal(merged(nested, nested.replace('- b', '- B'), nested.replace('- c', '- C')).text, lines('- a', '  - B', '  - C', '- d'));
});

test('blockMerge: an item added next to an item the other side changed', () => {
  const base = lines('- one', '- two');
  const r = merged(base, lines('- one', '- two', '- new'), lines('- one', '- TWO'));
  assert.deepEqual(r, { text: lines('- one', '- TWO', '- new'), conflicts: 0 });
});

test('blockMerge: adjacent blocks, and blocks in one container', () => {
  const base = lines('# Title', 'Text under it.');
  assert.equal(merged(base, lines('# New title', 'Text under it.'), lines('# Title', 'Other text.')).text, lines('# New title', 'Other text.'));
  const box = lines(':::note Heads up', '### Inside', 'A paragraph.', ':::');
  const r = merged(box, box.replace(':::note', ':::warning'), box.replace('A paragraph.', 'A changed paragraph.'));
  assert.equal(r.text, lines(':::warning Heads up', '### Inside', 'A changed paragraph.', ':::'));
  const two = lines(':::note', '### One', '### Two', ':::');
  assert.equal(merged(two, two.replace('One', 'First'), two.replace('Two', 'Second')).text, lines(':::note', '### First', '### Second', ':::'));
});

test('blockMerge: different rows of one table, without realigning it', () => {
  const base = lines('| Name | Value |', '| ---- | ----- |', '| a    | 1     |', '| b    | 2     |');
  const r = merged(base, base.replace('| a    | 1     |', '| a    | 100 |'), base.replace('| b    | 2     |', '| b | 2 |'));
  assert.deepEqual(r, { text: lines('| Name | Value |', '| ---- | ----- |', '| a    | 100 |', '| b | 2 |'), conflicts: 0 });
});

test('blockMerge: front matter merges key by key, comments and order kept', () => {
  const base = lines('---', 'title: Plan', '# who decides', 'status: draft', 'owners: ["@a"]', '---', '', 'Body.');
  const ours = base.replace('title: Plan', 'title: The plan');
  const theirs = base.replace('status: draft', 'status: review');
  assert.equal(merged(base, ours, theirs).text, lines('---', 'title: The plan', '# who decides', 'status: review', 'owners: ["@a"]', '---', '', 'Body.'));
  // Keys added on both sides at the same place: both kept.
  const plain = lines('---', 'title: Plan', '---');
  assert.equal(merged(plain, lines('---', 'title: Plan', 'tags: [a]', '---'), lines('---', 'title: Plan', 'owners: ["@b"]', '---')).text,
    lines('---', 'title: Plan', 'tags: [a]', 'owners: ["@b"]', '---'));
});

test('blockMerge: an updated: date changed on both sides takes the later date', () => {
  const base = lines('---', 'title: Plan', 'status: draft', 'updated: 2026-10-01', '---');
  const ours = lines('---', 'title: Plan v2', 'status: draft', 'updated: 2026-10-20', '---');
  const theirs = lines('---', 'title: Plan', 'status: review', 'updated: "2026-10-25"', '---');
  assert.equal(merged(base, ours, theirs).text, lines('---', 'title: Plan v2', 'status: review', 'updated: "2026-10-25"', '---'));
  assert.equal(merged(base, theirs, ours).text, lines('---', 'title: Plan v2', 'status: review', 'updated: "2026-10-25"', '---'));
  // Other keys changed differently on both sides stay a conflict, around that key only.
  const r = merged(base, ours.replace('status: draft', 'status: done'), theirs);
  assert.equal(r.conflicts, 1);
  assert.match(r.text, /^---\ntitle: Plan v2\n<<<<<<< ours\nstatus: done\n=======\nstatus: review\n>>>>>>> theirs\nupdated: "2026-10-25"\n---\n$/);
});

test('blockMerge: the same change on both sides is taken once', () => {
  const base = lines('- one', '- two', '- three');
  const both = lines('- ONE', '- two', '- three');
  assert.deepEqual(merged(base, both, lines('- ONE', '- TWO', '- three')), { text: lines('- ONE', '- TWO', '- three'), conflicts: 0 });
});

test('blockMerge: a conflict is scoped to the one block both sides changed', () => {
  const base = lines('Intro.', '', '- one', '- two', '- three', '', 'End.');
  const r = merged(base, base.replace('- one\n- two', '- ONE\n- TWO'), base.replace('- two\n- three', '- 2\n- THREE'));
  assert.equal(r.conflicts, 1);
  assert.equal(r.text, lines('Intro.', '', '- ONE', '<<<<<<< ours', '- TWO', '=======', '- 2', '>>>>>>> theirs', '- THREE', '', 'End.'));
  // Marker size, labels and the diff3 style come from the options.
  const d = merged(base, base.replace('- two', '- TWO').replace('- one', '- ONE'), base.replace('- two', '- 2'), { markerSize: 3, diff3: true, labels: { ours: 'HEAD', theirs: 'topic' } });
  assert.equal(d.text, lines('Intro.', '', '- ONE', '<<< HEAD', '- TWO', '||| base', '- two', '===', '- 2', '>>> topic', '- three', '', 'End.'));
});

test('blockMerge: CRLF and mixed line breaks round-trip', () => {
  const base = '- one\r\n- two\r\n- three\r\n';
  assert.deepEqual(merged(base, base.replace('one', 'ONE'), base.replace('two', 'TWO')), { text: '- ONE\r\n- TWO\r\n- three\r\n', conflicts: 0 });
  const mixed = '# Title\r\n- one\n- two\r\n- three';
  assert.equal(merged(mixed, mixed.replace('one', 'ONE'), mixed.replace('two', 'TWO')).text, '# Title\r\n- ONE\n- TWO\r\n- three');
  const conflict = merged(base, base.replace('two', 'TWO'), base.replace('two', '2'));
  assert.equal(conflict.text, '- one\r\n<<<<<<< ours\r\n- TWO\r\n=======\r\n- 2\r\n>>>>>>> theirs\r\n- three\r\n');
  assert.deepEqual(splitLines('a\r\nb\nc'), ['a\r\n', 'b\n', 'c']);
});

test('blockMerge: in doubt, it merges nothing', () => {
  const base = lines('---', 'smd: 2', '---', '- one', '- two');
  const doubt = blockMerge(base, base.replace('smd: 2', 'smd: 1').replace('- one', '- ONE'), base.replace('- two', '- TWO'));
  assert.ok(isMergeDoubt(doubt) && /spec versions/.test(doubt.doubt));
  // Each side reads key by key, but the merge would set "x" twice.
  const fm = lines('---', 'a: 1', 'b: 2', '---');
  const twice = blockMerge(fm, lines('---', 'x: 1', 'a: 9', 'b: 2', '---'), lines('---', 'a: 1', 'b: 8', 'x: 2', '---'));
  assert.ok(isMergeDoubt(twice));
});

test('blockMerge: lines both sides changed inside one paragraph stay a line conflict', () => {
  const base = lines('One line.', 'Two line.');
  const r = merged(base, lines('One LINE.', 'Two line.'), lines('One line.', 'Two LINE.'));
  assert.equal(r.conflicts, 1);
  assert.equal(r.text, lines('<<<<<<< ours', 'One LINE.', 'Two line.', '=======', 'One line.', 'Two LINE.', '>>>>>>> theirs'));
});

// ---------------------------------------------------------------------------
// Properties over fuzzed edits of the corpus
// ---------------------------------------------------------------------------

const CORPUS = path.join(__dirname, 'compat', 'corpus');
const corpus = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.smd')).sort((a, b) => a.localeCompare(b))
  .map((f) => fs.readFileSync(path.join(CORPUS, f), 'utf8').split(/\r?\n/));

interface Line { text: string; eol: string; base?: number }
interface FuzzCase { base: string; ours: string; theirs: string; untouched: string[]; added: string[] }

const NEW_LINES = ['- item {t}', '| {t} | x |', 'A sentence {t}.', '', '### Heading {t}', '1. step {t}'];

/** One side: a few edits (change, delete, insert) near `center`; changed base lines go in `touched`. */
function side(base: readonly Line[], rand: () => number, tag: string, center: number, touched: Set<number>): Line[] {
  const out = base.map((l) => ({ ...l }));
  const edits = 1 + Math.floor(rand() * 3);
  for (let e = 0; e < edits; e++) {
    const at = Math.max(0, Math.min(out.length - 1, center + Math.floor(rand() * 5) - 2));
    const label = `${tag}${e}`;
    const kind = rand();
    const eol = out[at]?.eol ?? '\n';
    if (out[at]?.base !== undefined && kind < 0.45) {
      touched.add(out[at].base!);
      out[at] = { text: `${out[at].text} ${label}`, eol };
    } else if (out[at]?.base !== undefined && kind < 0.6) {
      touched.add(out[at].base!);
      out.splice(at, 1);
    } else {
      const text = NEW_LINES[Math.floor(rand() * NEW_LINES.length)].replace('{t}', label);
      out.splice(at + 1, 0, { text, eol });
    }
  }
  return out;
}

const join = (list: readonly Line[]) => list.map((l) => l.text + l.eol).join('');
const newLines = (list: readonly Line[]) => list.filter((l) => l.base === undefined && l.text).map((l) => l.text);

function fuzzCase(rand: () => number): FuzzCase {
  const doc = corpus[Math.floor(rand() * corpus.length)];
  const mode = rand();
  const eolFor = () => {
    if (mode < 0.6) return '\n';
    if (mode < 0.85) return '\r\n';
    return rand() < 0.5 ? '\n' : '\r\n';
  };
  const base: Line[] = doc.slice(0, -1).map((text, i) => ({ text, eol: eolFor(), base: i }));
  const center = Math.floor(rand() * base.length);
  const touched = new Set<number>();
  const ours = side(base, rand, 'ours', center, touched);
  const theirs = side(base, rand, 'theirs', center + Math.floor(rand() * 5) - 2, touched);
  const added = [...newLines(ours), ...newLines(theirs)];
  const untouched = base.filter((l) => !touched.has(l.base!)).map((l) => l.text);
  return { base: join(base), ours: join(ours), theirs: join(theirs), untouched, added };
}

/** The lines nobody changed are all in the output, in order and as they were. */
function keepsUntouched(output: string, untouched: readonly string[]): boolean {
  const out = output.split(/\r?\n/);
  let i = 0;
  for (const line of out) if (i < untouched.length && line === untouched[i]) i++;
  return i === untouched.length;
}

const hasMarkers = (text: string) => /^(<{7}|={7}|>{7})( |$)/m.test(text);

/** A clean merge keeps every line either side added or changed. */
const keepsAdded = (output: string, added: readonly string[]) => {
  const out = new Set(output.split(/\r?\n/));
  return added.every((a) => out.has(a));
};

const RUNS = Number(process.env.SMD_MERGE_RUNS ?? 250);
const SEED = Number(process.env.SMD_MERGE_SEED ?? 20261031);

test('blockMerge property: unchanged lines stay, clean merges keep both sides', () => {
  const rand = prng(SEED);
  let clean = 0;
  for (let n = 0; n < RUNS; n++) {
    const c = fuzzCase(rand);
    const r = blockMerge(c.base, c.ours, c.theirs);
    if (isMergeDoubt(r)) continue;
    const where = `case ${n} (seed ${SEED})`;
    assert.ok(keepsUntouched(r.text, c.untouched), `${where}: a line nobody changed was lost or changed`);
    if (r.conflicts) continue;
    clean++;
    assert.ok(!hasMarkers(r.text), `${where}: markers in a clean merge`);
    assert.ok(keepsAdded(r.text, c.added), `${where}: a side's change was lost`);
  }
  assert.ok(clean > RUNS / 4, `only ${clean} of ${RUNS} cases merged cleanly`);
});

const hasGit = spawnSync('git', ['--version']).status === 0;
const GIT_RUNS = Number(process.env.SMD_MERGE_GIT_RUNS ?? 40);

test('smd merge property: a clean git merge-file is kept byte for byte', { skip: !hasGit && 'git is not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'smd-merge-prop-'));
  const file = (name: string) => path.join(dir, name);
  const rand = prng(SEED + 1);
  let gitClean = 0;
  let resolved = 0;
  try {
    for (let n = 0; n < GIT_RUNS; n++) {
      const c = fuzzCase(rand);
      fs.writeFileSync(file('base.smd'), c.base);
      fs.writeFileSync(file('ours.smd'), c.ours);
      fs.writeFileSync(file('theirs.smd'), c.theirs);
      const git = gitMergeFile(file('base.smd'), file('ours.smd'), file('theirs.smd'));
      assert.ok(git, 'git merge-file failed');
      const outcome = resolveMerge(git, Buffer.from(c.base), Buffer.from(c.ours), Buffer.from(c.theirs));
      const where = `case ${n} (seed ${SEED + 1})`;
      if (git.status === 0) {
        gitClean++;
        assert.ok(outcome.output.equals(git.stdout) && outcome.code === 0, `${where}: differs from Git's clean merge`);
        continue;
      }
      const text = outcome.output.toString('utf8');
      assert.ok(keepsUntouched(text, c.untouched), `${where}: a line nobody changed was lost or changed`);
      if (outcome.code === 0) {
        resolved++;
        assert.ok(!hasMarkers(text) && keepsAdded(text, c.added), `${where}: a bad clean merge`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(gitClean > 0 && resolved > 0, `cases: ${gitClean} clean in Git, ${resolved} resolved by blocks`);
});
