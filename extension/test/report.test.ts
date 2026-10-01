import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSmd, statusChanges, statusReport, statusReportMarkdown, validateSmd } from '../src/core';

const before = [
  '---', 'smd: 1', 'title: Checkout plan', '---', '',
  '## Build', '',
  '- [ ] Quote endpoint :priority[P1] @api :due[2026-09-20]',
  '- [ ] Write the runbook',
  '- [x] Already done',
  '- [ ] Wallet buttons @payments :due[2026-10-03]',
  '- [ ] Dogfood @maya :due[2026-09-25]', '',
  ':::decision{status=proposed date=2026-09-01} Use EventBridge', 'Why.', ':::', '',
  ':::decision{status=accepted date=2026-08-01} Keep the monolith', 'Why.', ':::', '',
].join('\n');

const after = [
  '---', 'smd: 1', 'title: Checkout plan', '---', '',
  '## Build', '',
  '- [x] Quote endpoint :priority[P1] @api :due[2026-09-20]',
  '- [ ] Write the  RUNBOOK and alerts :priority[P0]',
  '- [x] Already done',
  '- [ ] Wallet buttons @payments :due[2026-10-03]',
  '- [ ] Dogfood @maya :due[2026-09-25]',
  '- [x] Fix the flaky test @li',
  '- [ ] Load test :priority[P2] :due[2026-11-01]', '',
  ':::decision{status=accepted date=2026-09-01} Use EventBridge', 'Why.', ':::', '',
  ':::decision{status=accepted date=2026-08-01} Keep the monolith', 'Why.', ':::', '',
  ':::decision{date=2026-09-28} Show wallets to guests?', 'Options.', ':::', '',
  '## Risks', '',
  ':::risk{impact=high likelihood=medium owner=@payments} Apple Pay verification', 'Waiting.', ':::', '',
  ':::risk{impact=critical status=mitigated} Old outage', 'Done.', ':::', '',
  ':::risk{impact=medium} Small thing', 'Meh.', ':::', '',
].join('\n');

const notes = '# Notes\n\n- [ ] Note task\n';
const today = '2026-09-30';
const texts = (tasks: Array<{ text: string }>) => tasks.map((t) => t.text);

test('statusChanges: done since, new and removed tasks, matched by document and text', () => {
  const c = statusChanges([{ path: 'plan.smd', text: before }, { path: 'notes.smd', text: notes }], [{ path: 'plan.smd', text: after }], { today });
  assert.equal(c.compared, true);
  assert.deepEqual(texts(c.done), ['Quote endpoint', 'Fix the flaky test']);
  // A reworded task counts as removed and added; a whole document removed takes its tasks with it.
  assert.deepEqual(texts(c.added), ['Write the RUNBOOK and alerts', 'Fix the flaky test', 'Load test']);
  assert.deepEqual(c.removed.map((t) => [t.path, t.text]), [['notes.smd', 'Note task'], ['plan.smd', 'Write the runbook']]);
  const quote = c.done[0];
  assert.deepEqual([quote.path, quote.document, quote.section, quote.anchor, quote.priority, quote.assignees], ['plan.smd', 'Checkout plan', 'Build', 'build', 'P1', ['@api']]);
  // Only the text matters: a different owner, priority or due date is the same task.
  const moved = statusChanges([{ path: 'plan.smd', text: before }], [{ path: 'plan.smd', text: before.replace('@maya :due[2026-09-25]', '@li :due[2026-10-09]') }], { today });
  assert.deepEqual([moved.done, moved.added, moved.removed], [[], [], []]);
  // Case and spacing are ignored; the same text twice pairs in document order.
  const twice = '- [ ] Ship it\n- [ ] Ship it\n';
  const dup = statusChanges([{ path: 'a.smd', text: twice }], [{ path: 'a.smd', text: '- [x] ship  IT\n- [ ] Ship it\n- [ ] Ship it\n' }], { today });
  assert.deepEqual([texts(dup.done), dup.added.map((t) => t.line)], [['ship IT'], [2]]);
  // The same text in another document is another task.
  const other = statusChanges([{ path: 'a.smd', text: twice }], [{ path: 'b.smd', text: twice }], { today });
  assert.deepEqual([other.added.length, other.removed.length], [2, 2]);
});

test('statusChanges: open tasks overdue first, overdue, due in the next 7 days', () => {
  const c = statusChanges([{ path: 'plan.smd', text: before }], [{ path: 'plan.smd', text: after }], { today });
  assert.deepEqual(texts(c.open), ['Dogfood', 'Write the RUNBOOK and alerts', 'Load test', 'Wallet buttons']);
  assert.deepEqual(texts(c.overdue), ['Dogfood']);
  assert.deepEqual(texts(c.dueSoon), ['Wallet buttons']);
  assert.deepEqual(texts(statusChanges(null, [{ path: 'plan.smd', text: after }], { today: '2026-10-10' }).dueSoon), []);
  assert.deepEqual(c.documents, [{ path: 'plan.smd', document: 'Checkout plan', tasks: 7, openTasks: 4 }]);
});

test('statusChanges: decisions since, decisions needed and open high-impact risks', () => {
  const c = statusChanges([{ path: 'plan.smd', text: before }], [{ path: 'plan.smd', text: after }], { today });
  assert.deepEqual(c.decisions.map((d) => [d.decision.title, d.decision.status, d.before]), [
    ['Show wallets to guests?', 'proposed', null],
    ['Use EventBridge', 'accepted', 'proposed'],
  ]);
  assert.deepEqual(c.needed.map((d) => d.title), ['Show wallets to guests?']);
  assert.deepEqual(c.risks, [{
    title: 'Apple Pay verification', impact: 'high', likelihood: 'medium', owner: '@payments', path: 'plan.smd',
    document: 'Checkout plan', line: 29, section: 'Risks', anchor: 'risks',
  }]);
});

test('statusChanges: without an earlier version, the current state only and decisions dated since a date', () => {
  const c = statusChanges(null, [{ path: 'plan.smd', text: after }], { today, since: '2026-09-02' });
  assert.equal(c.compared, false);
  assert.deepEqual([c.done, c.added, c.removed], [[], [], []]);
  assert.equal(c.open.length, 4);
  assert.deepEqual(c.decisions.map((d) => [d.decision.title, d.before]), [['Show wallets to guests?', null]]);
  assert.deepEqual(statusChanges(null, [{ path: 'plan.smd', text: after }], { today, since: 'HEAD~1' }).decisions, []);
  // An empty earlier version (nothing existed yet): every task is new.
  assert.equal(statusChanges([], [{ path: 'plan.smd', text: after }], { today }).added.length, 7);
});

test('statusReport: a formatted, valid draft in the shape of the status-report template', () => {
  const md = statusReport([{ path: 'docs/plan.smd', text: before }], [{ path: 'docs/plan.smd', text: after }], {
    today, since: 'HEAD~1', revision: 'abc1234', title: 'Checkout', link: (p) => p.replace(/^docs\//, ''),
  });
  assert.equal(formatSmd(md), md);
  assert.match(md, /^---\nsmd: 1\ntitle: "Checkout — status 2026-09-30"\nsummary: "Draft: 2 tasks done and 3 added since HEAD~1; 4 open tasks, 1 overdue\. /);
  assert.match(md, /\nstatus: draft\ntags: \[status\]\nupdated: 2026-09-30\nrelated: \["plan\.smd"\]\n---\n/);
  assert.match(md, /compared with their version at HEAD\\~1 \(abc1234\)/);
  assert.match(md, /\*\*Overall:\*\* :status\[At risk\]\{color=orange\} · \*\*Progress:\*\* :progress\{value=43\}/);
  assert.match(md, /## Done since HEAD\\~1\n\n- Quote endpoint · :priority\[P1\] · @api · due 2026-09-20 — \[Checkout plan › Build\]\(plan\.smd#build\)\n- Fix the flaky test :badge\[new\]\{color=blue\} · @li/);
  assert.match(md, /## New since HEAD\\~1\n\n- Write the RUNBOOK and alerts · :priority\[P0\] — /);
  assert.match(md, /## Removed since HEAD\\~1\n\n.*reworded task.*\n\n- ~~Write the runbook~~ — Checkout plan › Build\n/);
  assert.match(md, /### Overdue\n\n- Dogfood · @maya · due 2026-09-25 :badge\[overdue\]\{color=red\} — /);
  assert.match(md, /### Due in the next 7 days\n\n- Wallet buttons · @payments · due 2026-10-03 — /);
  assert.match(md, /### Other open tasks\n\n- Write the RUNBOOK and alerts · :priority\[P0\] — .*\n- Load test · :priority\[P2\] · due 2026-11-01 — .*\n\n## Risks/);
  assert.match(md, /## Risks and blockers\n\n- \*\*Apple Pay verification\*\* · impact high · likelihood medium · @payments — \[Checkout plan › Risks\]\(plan\.smd#risks\)\n/);
  assert.match(md, /- :badge\[accepted\]\{color=green\} Use EventBridge \(was proposed\) · 2026-09-01 — \[Checkout plan › Build\]\(plan\.smd#build\)/);
  assert.match(md, /## Decisions needed\n\n- :badge\[proposed\]\{color=blue\} Show wallets to guests\? · 2026-09-28 — /);
  assert.match(md, /## Sources\n\n- \[Checkout plan\]\(plan\.smd\) — 4 open tasks\n$/);
  // The report adds no tasks, decisions or risks of its own, and has no :::agent block (the template has none).
  assert.doesNotMatch(md, /^\s*- \[[ xX]\]|^:::(decision|risk|agent)/m);
  const problems = validateSmd(md, { fileExists: (p) => p === 'plan.smd', readFile: (p) => (p === 'plan.smd' ? after : undefined), today });
  assert.deepEqual(problems, []);
});

test('statusReportMarkdown: without an earlier version, says so; empty lists say None', () => {
  const c = statusChanges(null, [{ path: 'notes.smd', text: '# Notes\n\nNothing yet.\n' }], { today });
  const md = statusReportMarkdown(c);
  assert.equal(formatSmd(md), md);
  assert.match(md, /\n:::warning No earlier version to compare with\n/);
  assert.match(md, /## Done this period\n\nUnknown: there was no earlier version to compare with\.\n\n## New this period\n\nUnknown/);
  assert.match(md, /:status\[On track\]\{color=green\} · \*\*Progress:\*\* :progress\{value=0\}\n\n:metric\[0\]\{label="Open"\} :metric\[0\]\{label="Overdue"\}/);
  assert.match(md, /### Overdue\n\nNone\.\n/);
  assert.doesNotMatch(md, /## Removed/);
  assert.match(md, /- \[Notes\]\(notes\.smd\) — 0 open tasks\n$/);
  assert.deepEqual(validateSmd(md, { fileExists: () => true, readFile: () => undefined, today }), []);
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd report drafts a status report since a Git revision or a date', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-report-'));
  const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, 'report', ...args], { cwd, encoding: 'utf8' });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const commit = (date: string) => git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', date, '--date', date);
  try {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'plan.smd'), before);
    writeFileSync(join(dir, 'docs', 'notes.smd'), notes);
    git('init', '-q');
    git('add', '.');
    process.env.GIT_COMMITTER_DATE = '2026-09-01T12:00:00';
    try { commit('2026-09-01T12:00:00'); } finally { delete process.env.GIT_COMMITTER_DATE; }

    writeFileSync(join(dir, 'docs', 'plan.smd'), after);
    unlinkSync(join(dir, 'docs', 'notes.smd'));

    const head = run(dir, 'docs', '--since', 'HEAD', '--today', today, '--title', 'Checkout', '-o', 'status.smd');
    assert.equal(head.status, 0, head.stderr);
    assert.match(head.stderr, /\[smd\] Status report since HEAD \([0-9a-f]{7}\) from 1 file\(s\): 2 done, 3 new, 2 removed; 4 open, 1 overdue, 1 due soon; 2 decision change\(s\), 1 high-impact risk\(s\)\./);
    const report = readFileSync(join(dir, 'status.smd'), 'utf8');
    assert.match(report, /title: "Checkout — status 2026-09-30"/);
    assert.match(report, /\[Checkout plan › Build\]\(docs\/plan\.smd#build\)/);
    assert.match(report, /- ~~Note task~~ — Notes\n/);
    const check = spawnSync(process.execPath, [cli, 'validate', join(dir, 'status.smd'), '--strict', '--no-mermaid', '--today', today], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout);
    assert.equal(spawnSync(process.execPath, [cli, 'fmt', '--check', join(dir, 'status.smd')]).status, 0);
    assert.equal(run(dir, 'docs', '--since', 'HEAD', '-o', 'status.smd').status, 2, 'never overwrites a draft');

    // A date: the last commit before it; before the first commit, everything is new.
    const date = run(dir, 'docs', '--since', '2026-09-02', '--today', today);
    assert.equal(date.status, 0, date.stderr);
    assert.equal(date.stdout.replace(/2026-09-02/g, 'HEAD'), run(dir, 'docs', '--since', 'HEAD', '--today', today).stdout);
    assert.match(run(dir, 'docs', '--since', '2026-08-01', '--today', today).stderr, /since 2026-08-01 \(before the first commit\) from 1 file\(s\): 3 done, 7 new, 0 removed/);

    assert.equal(run(dir, 'docs', '--since', 'no-such-ref').status, 2);
    assert.equal(run(dir, 'docs').status, 2);

    // Windows: from an 8.3 short path (as tmpdir() is on CI runners), files must still be found at the revision.
    if (process.platform === 'win32') {
      const short = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();
      const fromShort = run(short, 'docs', '--since', 'HEAD', '--today', today, '--title', 'Checkout');
      assert.equal(fromShort.stdout, run(dir, 'docs', '--since', 'HEAD', '--today', today, '--title', 'Checkout').stdout);
      assert.match(fromShort.stderr, /2 done, 3 new, 2 removed/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: smd report outside Git reports the current state for a date', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-report-nogit-'));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'report', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
  try {
    writeFileSync(join(dir, 'plan.smd'), after);
    const r = run('--since', '2026-09-02', '--today', today);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no Git history to compare with, current state only; 4 open, 1 overdue/);
    assert.match(r.stdout, /:::warning No earlier version to compare with/);
    assert.equal(run('--since', 'HEAD').status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
