import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkMermaid, extractTasks, ganttDate, ganttDocument, tasksToCsv, tasksToGantt, validateSmd, TASK_CSV_COLUMNS, type MermaidParse,
  type TaskExportRow,
} from '../src/core';

const TODAY = '2026-09-30';
const doc = [
  '# Plan', '',
  '## Build', '',
  '- [ ] Ship it @maya @li :priority[P0] :due[2026-10-01]',
  '- [x] Draft the spec @maya :due[2026-09-10]',
  '- [ ] Late one @ops :due[2026-09-20]',
  '- [ ] No date :priority[P2]',
  '- [ ] Bad date :due[2026-02-30]',
  '- [ ] Soon, maybe :due[next week]',
  '',
  '## Odd "names"', '',
  '- [ ] =SUM(A1:A2) and "quotes", commas :due[2026-11-01]',
  '- [ ] Title page: fix #12; 50% done :due[2026-11-02]',
  '- [ ] click here :due[2026-11-03]',
  '- [ ] 2026-12-01 release :due[2026-11-04]',
  '- [ ] -1 day',
  '',
].join('\n');

const rows = (file = 'docs/plan.smd'): TaskExportRow[] => extractTasks(doc, TODAY).map((t) => ({ ...t, file }));

test('tasksToCsv writes a header, CRLF records and the columns in a stable order', () => {
  const csv = tasksToCsv(rows());
  const lines = csv.split('\r\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines[0], 'file,line,done,text,owners,priority,due,overdue,section');
  assert.deepEqual([...TASK_CSV_COLUMNS], lines[0].split(','));
  assert.equal(lines[1], "docs/plan.smd,5,false,Ship it,'@maya;@li,P0,2026-10-01,false,Build");
  assert.equal(lines[2], "docs/plan.smd,6,true,Draft the spec,'@maya,,2026-09-10,false,Build");
  assert.equal(lines[3], "docs/plan.smd,7,false,Late one,'@ops,,2026-09-20,true,Build");
  assert.equal(lines[4], 'docs/plan.smd,8,false,No date,,P2,,false,Build');
  assert.equal(lines.length, 12);
  assert.doesNotMatch(csv, /^﻿/);
  assert.equal(tasksToCsv([]), 'file,line,done,text,owners,priority,due,overdue,section\r\n');
});

test('tasksToCsv quotes commas, quotes and line breaks and defuses formulas', () => {
  const lines = tasksToCsv(rows()).split('\r\n');
  assert.equal(lines[7], `docs/plan.smd,14,false,"'=SUM(A1:A2) and ""quotes"", commas",,,2026-11-01,false,"Odd ""names"""`);
  assert.equal(lines[11], `docs/plan.smd,18,false,'-1 day,,,,false,"Odd ""names"""`);
  const base = rows()[0];
  const odd = { ...base, file: '+x.smd', text: 'two\nlines', section: '@here', assignees: [] };
  assert.equal(tasksToCsv([odd]).split('\r\n')[1], `'+x.smd,5,false,"two\nlines",,P0,2026-10-01,false,'@here`);
  assert.match(tasksToCsv([{ ...odd, text: '\tx' }]), /,'\tx,/);
  // Without a file (library use) the column is empty.
  assert.match(tasksToCsv([{ ...base, file: undefined }]), /\r\n,5,false,Ship it,/);
});

test('tasksToGantt charts tasks with due dates as milestones, a section per file', () => {
  const chart = tasksToGantt([...rows('b.smd').slice(0, 3), ...rows('a.smd').slice(0, 4)], { title: 'Q4: plan' });
  assert.equal(chart, [
    'gantt',
    '  title Q4#58; plan',
    '  dateFormat YYYY-MM-DD',
    '  section a.smd',
    '    Draft the spec @maya :done, milestone, 2026-09-10, 0d',
    '    Late one @ops :crit, milestone, 2026-09-20, 0d',
    '    Ship it @maya @li :milestone, 2026-10-01, 0d',
    '  section b.smd',
    '    Draft the spec @maya :done, milestone, 2026-09-10, 0d',
    '    Late one @ops :crit, milestone, 2026-09-20, 0d',
    '    Ship it @maya @li :milestone, 2026-10-01, 0d',
    '',
  ].join('\n'));
  assert.equal(tasksToGantt([]), 'gantt\n  title Tasks\n  dateFormat YYYY-MM-DD\n');
});

test('tasksToGantt escapes what Mermaid would misread in names', () => {
  const lines = tasksToGantt(rows()).split('\n');
  assert.ok(lines.includes('    =SUM(A1#58;A2) and "quotes", commas :milestone, 2026-11-01, 0d'));
  assert.ok(lines.includes('    #84;itle page#58; fix #35;12#59; 50#37; done :milestone, 2026-11-02, 0d'));
  assert.ok(lines.includes('    #99;lick here :milestone, 2026-11-03, 0d'));
  assert.ok(lines.includes('    #50;026-12-01 release :milestone, 2026-11-04, 0d'));
  assert.ok(!lines.some((l) => /Bad date|Soon|No date/.test(l)));
  const [unnamed] = rows();
  assert.match(tasksToGantt([{ ...unnamed, text: '', assignees: [] }]), /\n {4}Task on line 5 :milestone, 2026-10-01, 0d\n/);
});

test('ganttDate accepts only real YYYY-MM-DD dates', () => {
  assert.equal(ganttDate('2026-10-01'), '2026-10-01');
  assert.equal(ganttDate('2028-02-29'), '2028-02-29');
  for (const bad of [undefined, '', '2026-02-30', '2026-13-01', '2026-9-1', 'next week', '2026-10-01T10:00']) assert.equal(ganttDate(bad), undefined, bad);
});

test('ganttDocument wraps the chart in a valid .smd document', () => {
  const smd = ganttDocument(tasksToGantt(rows()), 'Q4 "plan"');
  assert.match(smd, /^---\ntitle: "Q4 \\"plan\\""\n---\n\n# Q4 "plan"\n\n```mermaid\ngantt\n[^]*\n```\n$/);
  assert.deepEqual(validateSmd(smd).filter((d) => d.severity === 'error' || d.severity === 'warning'), []);
});

const bundle = path.join(__dirname, '..', 'dist', 'mermaid-parse.js');
test('the Gantt chart parses with the bundled Mermaid parser', { skip: !fs.existsSync(bundle) && 'run npm run build first' }, async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parse } = require(bundle) as { parse: MermaidParse };
  const nasty = rows().map((r) => ({ ...r, text: `${r.text} %% #x; a;b: c`, file: 'docs/a: #1;.smd' }));
  for (const chart of [tasksToGantt(rows(), { title: 'Q4 #1; 50% done: plan' }), tasksToGantt(nasty), tasksToGantt([])]) {
    assert.deepEqual(await checkMermaid(ganttDocument(chart), parse), [], chart);
  }
  // Each keyword at the start of a name would otherwise be a statement.
  const words = ['gantt', 'dateFormat x', 'title x', 'section x', 'click x', 'call x', 'href "x"', 'excludes x', 'todayMarker x', 'weekday monday', 'topAxis', '2026-01-01'];
  const keywords = words.map((text) => ({ ...rows()[0], text, assignees: [] }));
  assert.deepEqual(await checkMermaid(ganttDocument(tasksToGantt(keywords)), parse), []);
  await assert.rejects(parse('gantt\n  dateFormat YYYY-MM-DD\n  section a\n    click x :milestone, 2026-10-01, 0d\n'));
});

// Requires `npm run build`.
const cli = path.join(__dirname, '..', 'dist', 'cli.js');
const examples = path.join(__dirname, '..', '..', 'examples');
const smd = (...args: string[]) => spawnSync(process.execPath, [cli, 'tasks', ...args], { encoding: 'utf8' });

test('CLI: smd tasks text and --json output is unchanged', { skip: !fs.existsSync(cli) && 'run npm run build first' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-tasks-'));
  fs.writeFileSync(path.join(dir, 'plan.smd'), doc);
  const file = path.join(dir, 'plan.smd');
  // The 1.3.0 output, byte for byte (a date that doesn't exist counted as overdue then too).
  const text = smd(file, '--today', TODAY);
  assert.equal(text.stdout, [
    '9  [ ] Bad date (due 2026-02-30, OVERDUE)  — Build',
    '7  [ ] Late one @ops (due 2026-09-20, OVERDUE)  — Build',
    '5  [ ] [P0] Ship it @maya @li (due 2026-10-01)  — Build',
    '8  [ ] [P2] No date  — Build',
    '14  [ ] =SUM(A1:A2) and "quotes", commas (due 2026-11-01)  — Odd "names"',
    '15  [ ] Title page: fix #12; 50% done (due 2026-11-02)  — Odd "names"',
    '16  [ ] click here (due 2026-11-03)  — Odd "names"',
    '17  [ ] 2026-12-01 release (due 2026-11-04)  — Odd "names"',
    '18  [ ] -1 day  — Odd "names"',
    '10  [ ] Soon, maybe (due next week)  — Build',
  ].map((l) => `${file}:${l}\n`).join(''));
  assert.equal(text.stderr, '[smd] 10 task(s) open, 2 overdue.\n');
  const json = smd(file, '--today', TODAY, '--json');
  assert.equal(json.stdout, JSON.stringify(JSON.parse(json.stdout), null, 2) + '\n');
  assert.deepEqual(Object.keys(JSON.parse(json.stdout)[0]), ['text', 'line', 'done', 'section', 'assignees', 'due', 'overdue', 'file']);
  assert.equal(json.stderr, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: smd tasks --csv, --gantt and --gantt --smd, to stdout or -o', { skip: !fs.existsSync(cli) && 'run npm run build first' }, () => {
  const csv = smd(examples, '--csv', '--today', TODAY);
  assert.equal(csv.status, 0);
  assert.match(csv.stdout, /^file,line,done,text,owners,priority,due,overdue,section\r\n.*showcase\.smd,\d+,false,Legal review of new terms,'@legal,P0,2026-09-20,true,/);
  assert.match(csv.stderr, /task\(s\) open/);
  const gantt = smd(examples, '--gantt', '--all', '--today', TODAY);
  assert.match(gantt.stdout, /^gantt\n {2}title Tasks\n {2}dateFormat YYYY-MM-DD\n {2}section .*checkout-redesign\.smd\n/);
  assert.match(gantt.stdout, /Kickoff with design @sam :done, milestone, 2026-09-10, 0d/);
  assert.match(gantt.stderr, /^\[smd\] \d+ task\(s\) on the chart, \d+ without a YYYY-MM-DD due date left out\.\n$/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-gantt-'));
  const out = path.join(dir, 'timeline.smd');
  const written = smd(examples, '--gantt', '--smd', '--title', 'Timeline', '-o', out);
  assert.equal(written.stdout, '');
  assert.match(written.stderr, /Wrote .*timeline\.smd/);
  assert.match(fs.readFileSync(out, 'utf8'), /^---\ntitle: "Timeline"\n---\n\n# Timeline\n\n```mermaid\ngantt\n {2}title Timeline\n/);
  const validate = spawnSync(process.execPath, [cli, 'validate', out], { encoding: 'utf8' });
  assert.equal(validate.status, 0, validate.stdout);
  assert.match(validate.stdout, /0 error\(s\), 0 warning\(s\)/);
  assert.equal(smd(examples, '--json', '-o', path.join(dir, 't.json')).status, 0);
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(path.join(dir, 't.json'), 'utf8'))));
  fs.rmSync(dir, { recursive: true, force: true });

  const both = smd(examples, '--csv', '--json');
  assert.equal(both.status, 2);
  assert.match(both.stderr, /Choose one output format: --json or --csv/);
  assert.equal(smd(examples, '--smd').status, 2);
  assert.equal(execFileSync(process.execPath, [cli, 'tasks', examples, '--gantt'], { encoding: 'utf8', stdio: 'pipe' }).startsWith('gantt\n'), true);
});
