import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addIssueLink, checkTaskLine, issueDraft, issueTasks, parseIssueRefs, planIssueSync, stripIssueRefs, taskIssueRef,
  type IssueState,
} from '../src/core';
import { runIssues, type GhResult, type IssuesOptions } from '../src/issueSync';

const URL120 = 'https://github.com/acme/shop/issues/120';

test('parseIssueRefs accepts a Markdown link, a bare URL and owner/name#N, in order', () => {
  const refs = parseIssueRefs(`- [ ] A [#120](${URL120}) and https://github.com/acme/shop/issues/7 and other-org/web.app#42`);
  assert.deepEqual(refs.map((r) => [r.repo, r.number, r.url]), [
    ['acme/shop', 120, URL120],
    ['acme/shop', 7, 'https://github.com/acme/shop/issues/7'],
    ['other-org/web.app', 42, 'https://github.com/other-org/web.app/issues/42'],
  ]);
  assert.equal(taskIssueRef(`- [ ] Any text [the quote bug](${URL120})`)?.number, 120);
  assert.equal(taskIssueRef('- [ ] A <https://github.com/acme/shop/issues/5>')?.number, 5);
});

test('parseIssueRefs ignores code spans, bare #N, pull requests and look-alikes', () => {
  assert.deepEqual(parseIssueRefs('- [ ] Run `gh issue view acme/shop#3` and `https://github.com/acme/shop/issues/4`'), []);
  assert.deepEqual(parseIssueRefs('- [ ] The #1 priority, see #12'), []);
  assert.deepEqual(parseIssueRefs('- [ ] https://github.com/acme/shop/pull/9 and https://example.com/a/b#12'), []);
  assert.deepEqual(parseIssueRefs('- [ ] https://github.com/acme/shop/issues/9/comments'), []);
  // The URL's path is not read as owner/name#N.
  assert.deepEqual(parseIssueRefs('- [ ] https://github.com/acme/shop/issues/9#issuecomment-1').map((r) => r.number), [9]);
});

test('issueTasks links each task to its first reference', () => {
  const text = `# Plan\r\n- [ ] One acme/shop#1 acme/shop#2\r\n- [x] Two\r\n\`\`\`\r\n- [ ] not a task acme/shop#3\r\n\`\`\`\r\n`;
  const tasks = issueTasks(text);
  assert.deepEqual(tasks.map((t) => [t.line, t.issue?.number, t.source]), [
    [1, 1, '- [ ] One acme/shop#1 acme/shop#2'],
    [2, undefined, '- [x] Two'],
  ]);
});

const doc = [
  '# Plan', '',
  '## Build',
  '- [ ] Ship the quote endpoint :priority[P0] @api-team :due[2026-10-03]',
  `- [ ] Fix the flaky test @maya [#120](${URL120})`,
  '- [x] Kickoff with design https://github.com/acme/shop/issues/118',
  '- [ ] Write docs acme/shop#121',
  '- [ ] Dropped idea acme/shop#122',
  '- [x] Old task without a link',
  '- [ ] Explain `acme/shop#999` in code',
  '',
].join('\n');

const states = new Map<string, IssueState>([
  ['acme/shop#120', { state: 'closed', reason: 'completed' }],
  ['acme/shop#118', { state: 'open' }],
  ['acme/shop#121', { state: 'open' }],
  ['acme/shop#122', { state: 'closed', reason: 'not_planned' }],
]);

test('planIssueSync: check off, create, close, in sync and skipped', () => {
  const plan = planIssueSync(issueTasks(doc), states, { create: true });
  assert.deepEqual(plan.actions.map((a) => [a.kind, a.task.line, a.issue?.number, a.enabled]), [
    ['check', 4, 120, true],
    ['create', 3, undefined, true],
    ['create', 9, undefined, true],
    ['close', 5, 118, false],
  ]);
  assert.deepEqual(plan.inSync.map((t) => t.line), [6]);
  assert.deepEqual(plan.skipped.map((s) => [s.task.line, s.reason]), [[7, 'the issue was closed as not planned; the task stays open']]);
  // Unknown state: skipped, never acted on.
  const unread = planIssueSync(issueTasks(doc), new Map(), {});
  assert.deepEqual(unread.actions.map((a) => a.kind), ['create', 'create']);
  assert.equal(unread.skipped.length, 4);
});

test('planIssueSync: nothing to do, and each issue closed once', () => {
  const synced = planIssueSync(issueTasks('- [ ] A acme/shop#121\n- [x] B\n'), states);
  assert.deepEqual([synced.actions, synced.inSync.length, synced.skipped], [[], 1, []]);
  const twice = planIssueSync(issueTasks('- [x] A acme/shop#118\n- [x] B acme/shop#118\n'), states, { close: true });
  assert.deepEqual(twice.actions.map((a) => [a.kind, a.task.line]), [['close', 0]]);
});

test('addIssueLink appends the link and changes nothing else', () => {
  const issue = { number: 7, url: 'https://github.com/acme/shop/issues/7' };
  assert.equal(addIssueLink('  - [ ] Ship it @api', issue), '  - [ ] Ship it @api [#7](https://github.com/acme/shop/issues/7)');
  assert.equal(addIssueLink('- [ ] Ship it  \r', issue), '- [ ] Ship it [#7](https://github.com/acme/shop/issues/7)  \r');
});

test('checkTaskLine checks the box only', () => {
  assert.equal(checkTaskLine('  1. [ ] Ship [ ] it acme/shop#1'), '  1. [x] Ship [ ] it acme/shop#1');
  assert.equal(checkTaskLine('- [X] Done'), '- [X] Done');
  assert.equal(checkTaskLine('Not a task'), undefined);
});

test('issueDraft: title without markers, body with source and owners in a code span', () => {
  const [task] = issueTasks(doc).filter((t) => t.line === 3);
  const draft = issueDraft(task, { path: 'docs/plan.smd' });
  assert.equal(draft.title, 'Ship the quote endpoint');
  assert.match(draft.body, /^Task from `docs\/plan\.smd:4` \(section "Build"\)\.\n\n- Owners: `@api-team`\n- Priority: P0\n- Due: 2026-10-03\n\n/);
  assert.doesNotMatch(draft.body.replace(/`[^`]*`/g, ''), /@/); // nobody is @-mentioned
  const styled = { ...task, text: '**2026-10-06** — Internal _dogfood_ ~~beta~~' };
  assert.equal(issueDraft(styled, { path: 'p.smd' }).title, '2026-10-06 — Internal _dogfood_ beta');
  assert.equal(stripIssueRefs(`Fix it [#120](${URL120}) now acme/shop#3`), 'Fix it now');
});

// ---------------------------------------------------------------------------
// The command, with a fake gh
// ---------------------------------------------------------------------------

interface FakeGh {
  calls: string[][];
  inputs: Array<string | undefined>;
  run: (args: string[], input?: string) => GhResult;
}

function fakeGh(options: { missing?: boolean; loggedOut?: boolean; failCreateAfter?: number } = {}): FakeGh {
  const calls: string[][] = [];
  const inputs: Array<string | undefined> = [];
  let next = 200;
  const ok = (stdout = ''): GhResult => ({ ok: true, stdout, stderr: '' });
  const run = (args: string[], input?: string): GhResult => {
    calls.push(args);
    inputs.push(input);
    if (options.missing) return { ok: false, missing: true, stdout: '', stderr: 'spawn gh ENOENT' };
    const [a, b] = args;
    if (a === 'auth') return options.loggedOut ? { ok: false, stdout: '', stderr: 'not logged in' } : ok();
    if (a === 'repo') return ok('{"nameWithOwner":"acme/shop"}\n');
    if (a === 'api') {
      const state = states.get(b.replace(/^repos\/(.+)\/issues\/(\d+)$/, '$1#$2'));
      return state ? ok(JSON.stringify({ state: state.state, state_reason: state.reason ?? null })) : { ok: false, stdout: '', stderr: 'HTTP 404: Not Found' };
    }
    if (a === 'issue' && b === 'create') {
      if (options.failCreateAfter !== undefined && next - 200 >= options.failCreateAfter) return { ok: false, stdout: '', stderr: 'HTTP 422: label does not exist' };
      return ok(`https://github.com/acme/shop/issues/${next++}\n`);
    }
    return ok();
  };
  return { calls, inputs, run };
}

function withDoc(text: string, body: (dir: string, file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'smd-issues-'));
  const cwd = process.cwd();
  try {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'plan.smd'), text);
    process.chdir(dir);
    body(dir, join(dir, 'docs', 'plan.smd'));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function sync(gh: FakeGh, flags: Partial<IssuesOptions> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const options: IssuesOptions = { apply: false, create: false, close: false, labels: [], json: false, ...flags };
  const code = runIssues(['docs'], options, { gh: gh.run, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join(''), err: err.join('\n') };
}

const writes = (gh: FakeGh) => gh.calls.filter((c) => c[0] === 'issue');

test('smd issues: a dry run prints the plan and changes nothing', () => {
  withDoc(doc, (_dir, file) => {
    const gh = fakeGh();
    const r = sync(gh, { create: true, close: true });
    assert.equal(r.code, 0);
    assert.equal(readFileSync(file, 'utf8'), doc);
    assert.deepEqual(writes(gh), []);
    assert.match(r.out, /^Dry run: nothing is changed\./);
    assert.match(r.out, /Check off tasks whose issue was closed \(1\):\n {2}docs\/plan\.smd:5 {2}Fix the flaky test {2}acme\/shop#120\n/);
    assert.match(r.out, /Open issues for tasks without one in acme\/shop \(2\):\n {2}docs\/plan\.smd:4 {2}Ship the quote endpoint\n {2}docs\/plan\.smd:10 /);
    assert.match(r.out, /Close issues whose task is done \(1\):\n {2}docs\/plan\.smd:6 {2}Kickoff with design {2}acme\/shop#118\n/);
    assert.match(r.out, /Skipped:\n {2}docs\/plan\.smd:8 {2}Dropped idea {2}acme\/shop#122: the issue was closed as not planned/);
    assert.match(r.err, /dry run, nothing changed: 1 task\(s\) to check off, 2 issue\(s\) to create, 1 issue\(s\) to close; 1 in sync\./);
    // Without --create and --close, those actions are listed as needing the flag.
    const plain = sync(fakeGh());
    assert.match(plain.out, /docs\/plan\.smd:4 {2}Ship the quote endpoint {2}\(needs --create\)/);
    assert.match(plain.err, /1 task\(s\) to check off, 2 issue\(s\) to create \(needs --create\), 1 issue\(s\) to close \(needs --close\); 1 in sync\./);
  });
});

test('smd issues --apply checks off tasks whose issue closed, and only that', () => {
  const crlf = doc.replace(/\n/g, '\r\n');
  withDoc(crlf, (_dir, file) => {
    const gh = fakeGh();
    const r = sync(gh, { apply: true });
    assert.equal(r.code, 0);
    assert.equal(readFileSync(file, 'utf8'), crlf.replace('- [ ] Fix the flaky test', '- [x] Fix the flaky test'));
    assert.deepEqual(writes(gh), []);
    assert.match(r.err, /\[smd\] 1 task\(s\) checked off, 0 issue\(s\) created \(2 more with --create\), 0 issue\(s\) closed \(1 more with --close\); 1 in sync\./);
    // Idempotent: the second run has nothing left to check off.
    const again = sync(fakeGh(), { apply: true });
    assert.equal(readFileSync(file, 'utf8'), crlf.replace('- [ ] Fix the flaky test', '- [x] Fix the flaky test'));
    assert.match(again.err, /0 task\(s\) checked off/);
  });
});

test('smd issues --apply --create --close opens and links issues, closes done ones, and never twice', () => {
  withDoc(doc, (_dir, file) => {
    const gh = fakeGh();
    const r = sync(gh, { apply: true, create: true, close: true, labels: ['smd', 'backlog'] });
    assert.equal(r.code, 0, r.err);
    const lines = readFileSync(file, 'utf8').split('\n');
    assert.equal(lines[3], '- [ ] Ship the quote endpoint :priority[P0] @api-team :due[2026-10-03] [#200](https://github.com/acme/shop/issues/200)');
    assert.equal(lines[9], '- [ ] Explain `acme/shop#999` in code [#201](https://github.com/acme/shop/issues/201)');
    assert.equal(lines[4], `- [x] Fix the flaky test @maya [#120](${URL120})`);
    assert.deepEqual(lines.filter((_l, i) => ![3, 4, 9].includes(i)), doc.split('\n').filter((_l, i) => ![3, 4, 9].includes(i)));
    const [create, , close] = writes(gh);
    assert.deepEqual(create, [
      'issue', 'create', '--repo', 'acme/shop', '--title', 'Ship the quote endpoint', '--body-file', '-', '--label', 'smd', '--label', 'backlog',
    ]);
    assert.match(gh.inputs[gh.calls.indexOf(create)] ?? '', /^Task from `docs\/plan\.smd:4`/);
    assert.deepEqual(close.slice(0, 6), ['issue', 'close', '118', '--repo', 'acme/shop', '--reason']);
    assert.match(r.out, /docs\/plan\.smd:4 {2}Ship the quote endpoint {2}acme\/shop#200 {2}done/);
    assert.match(r.err, /1 task\(s\) checked off, 2 issue\(s\) created, 1 issue\(s\) closed; 1 in sync\./);

    // A second run creates nothing: every open task is linked now.
    const again = fakeGh();
    sync(again, { apply: true, create: true });
    assert.deepEqual(writes(again), []);
  });
});

test('smd issues --apply stops at the first failed gh call and reports what was done', () => {
  withDoc(doc, (_dir, file) => {
    const gh = fakeGh({ failCreateAfter: 0 });
    const r = sync(gh, { apply: true, create: true, close: true, json: true });
    assert.equal(r.code, 1);
    const report = JSON.parse(r.out);
    assert.deepEqual(report.actions.map((a: { kind: string; status: string }) => `${a.kind} ${a.status}`), [
      'check done', 'create failed', 'create not-run', 'close not-run',
    ]);
    assert.equal(report.actions[1].error, 'HTTP 422: label does not exist');
    assert.equal(writes(gh).length, 1); // the failed create; nothing after it
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\[#20\d\]/);
  });
});

test('smd issues: gh missing or logged out exits 2, an unreadable issue is skipped', () => {
  withDoc(doc, () => {
    const missing = sync(fakeGh({ missing: true }));
    assert.equal(missing.code, 2);
    assert.match(missing.err, /needs the GitHub CLI \(gh\): install it from https:\/\/cli\.github\.com/);
    const loggedOut = sync(fakeGh({ loggedOut: true }));
    assert.equal(loggedOut.code, 2);
    assert.match(loggedOut.err, /not logged in to github\.com: run gh auth login/);
    assert.equal(sync(fakeGh(), { repo: 'not a repo' }).code, 2);
  });
  withDoc('- [ ] Lost acme/shop#404\n', () => {
    const r = sync(fakeGh(), { apply: true });
    assert.equal(r.code, 1);
    assert.match(r.err, /could not read acme\/shop#404: HTTP 404: Not Found/);
    assert.match(r.out, /Skipped:\n {2}docs\/plan\.smd:1 {2}Lost {2}acme\/shop#404: the issue could not be read/);
  });
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd issues with gh missing, and with a stub gh on PATH', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-issues-cli-'));
  const bin = join(dir, 'bin');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'issues', ...args], { cwd: dir, encoding: 'utf8', env: { ...env, PATH: bin } });
  try {
    mkdirSync(bin);
    writeFileSync(join(dir, 'plan.smd'), '# Plan\n\n- [ ] Ship it @api\n- [ ] Fixed elsewhere acme/shop#5\n');
    const missing = run('plan.smd');
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /needs the GitHub CLI \(gh\)/);
    // execFile without a shell can't run a .cmd stub on Windows, so the stub runs on POSIX only.
    if (process.platform === 'win32') return;
    const log = join(dir, 'gh.log');
    writeFileSync(join(bin, 'gh'), [
      '#!/bin/sh',
      `echo "$@" >> "${log}"`,
      'case "$1" in',
      '  api) echo \'{"state":"closed","state_reason":"completed"}\' ;;',
      '  repo) echo \'{"nameWithOwner":"acme/shop"}\' ;;',
      '  issue) while IFS= read -r _; do :; done; echo https://github.com/acme/shop/issues/9 ;;',
      'esac',
    ].join('\n') + '\n');
    chmodSync(join(bin, 'gh'), 0o755);
    const dry = run('plan.smd');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run/);
    assert.equal(readFileSync(join(dir, 'plan.smd'), 'utf8'), '# Plan\n\n- [ ] Ship it @api\n- [ ] Fixed elsewhere acme/shop#5\n');
    const applied = run('plan.smd', '--apply', '--create');
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(readFileSync(join(dir, 'plan.smd'), 'utf8'), '# Plan\n\n- [ ] Ship it @api [#9](https://github.com/acme/shop/issues/9)\n- [x] Fixed elsewhere acme/shop#5\n');
    assert.match(readFileSync(log, 'utf8'), /^issue create --repo acme\/shop --title Ship it --body-file -$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
