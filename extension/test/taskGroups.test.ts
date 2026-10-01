import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTasks } from '../src/core';
import { taskCheckbox } from '../src/editing';
import {
  compareTasks, dueBucket, groupDescription, groupTasks, isTaskGrouping, overdueCount, taskDescription, withOverdue,
  type FileTask,
} from '../src/taskGroups';

const TODAY = '2026-09-30';

const plan = [
  '# Plan',
  '## Launch',
  '- [ ] Legal review :priority[P1] @legal :due[2026-09-20]',
  '- [ ] Ship it :priority[P0] @maya @sam :due[2026-10-03]',
  '- [ ] Write docs @maya',
  '- [x] Kickoff @sam :due[2026-09-10]',
  '- [ ] Pick a name :priority[P2]',
  '- [ ] Go live :due[2026-09-30]',
  '- [ ] Retro :due[2026-11-15] @Maya',
].join('\n');
const notes = '- [ ] Book a room :priority[P0] @sam :due[2026-09-01]\n- [ ] Bad date :due[2026-13-45]\n';

const tasks: FileTask[] = [
  ...extractTasks(plan, TODAY).map((t) => ({ ...t, file: 'docs/plan.smd' })),
  ...extractTasks(notes, TODAY).map((t) => ({ ...t, file: 'a/notes.smd' })),
];
const labels = (groups: ReturnType<typeof groupTasks>) => groups.map((g) => [g.label, g.tasks.map((t) => t.text)]);

test('grouping by owner: owners alphabetically (case-insensitive), Unassigned last, overdue first inside', () => {
  assert.deepEqual(labels(groupTasks(tasks, 'owner', TODAY)), [
    ['@legal', ['Legal review']],
    ['@maya', ['Ship it', 'Retro', 'Write docs']],
    ['@sam', ['Book a room', 'Ship it', 'Kickoff']],
    ['Unassigned', ['Pick a name', 'Go live', 'Bad date']],
  ]);
});

test('grouping by due date: Overdue, Today, This week, Later, Earlier (done), No due date', () => {
  assert.deepEqual(labels(groupTasks(tasks, 'due', TODAY)), [
    ['Overdue', ['Book a room', 'Legal review']],
    ['Today', ['Go live']],
    ['This week', ['Ship it']],
    ['Later', ['Retro']],
    ['Earlier', ['Kickoff']],
    ['No due date', ['Pick a name', 'Bad date', 'Write docs']],
  ]);
  assert.deepEqual(groupTasks(tasks, 'due', TODAY).map((g) => g.key).slice(0, 2), ['due:overdue', 'due:today']);
});

test('grouping by document: by path, then the usual order', () => {
  assert.deepEqual(labels(groupTasks(tasks, 'document', TODAY)), [
    ['a/notes.smd', ['Book a room', 'Bad date']],
    ['docs/plan.smd', ['Legal review', 'Ship it', 'Pick a name', 'Kickoff', 'Go live', 'Retro', 'Write docs']],
  ]);
});

test('an empty list has no groups', () => {
  for (const by of ['owner', 'due', 'document'] as const) assert.deepEqual(groupTasks([], by, TODAY), []);
});

test('due buckets use whole days', () => {
  const at = (due?: string, done = false) => dueBucket({ text: '', line: 0, done, section: null, assignees: [], due }, TODAY);
  assert.equal(at('2026-09-29'), 'overdue');
  assert.equal(at('2026-09-29', true), 'earlier');
  assert.equal(at('2026-09-30'), 'today');
  assert.equal(at('2026-10-07'), 'week');
  assert.equal(at('2026-10-08'), 'later');
  assert.equal(at(undefined), 'none');
  assert.equal(at('next week'), 'none');
});

test('overdue follows the day the view is refreshed on', () => {
  const [task] = extractTasks('- [ ] Ship :due[2026-10-01]', '2026-09-01').map((t) => ({ ...t, file: 'x.smd' }));
  assert.equal(task.overdue, false);
  assert.equal(withOverdue(task, '2026-10-02').overdue, true);
  assert.equal(withOverdue({ ...task, done: true }, '2026-10-02').overdue, false);
  const plain = { ...task, due: undefined, overdue: undefined };
  assert.equal(withOverdue(plain, '2026-10-02'), plain, 'tasks without a date are left alone');
});

test('compareTasks orders overdue, priority, due date, file and line', () => {
  const t = (p: Partial<FileTask>): FileTask => ({ text: '', line: 0, done: false, section: null, assignees: [], file: 'a.smd', ...p });
  const sorted = [
    t({ text: 'e', file: 'b.smd' }), t({ text: 'd', line: 3 }), t({ text: 'c', due: '2026-10-01' }),
    t({ text: 'b', priority: 'high' }), t({ text: 'a', overdue: true, priority: 'P3' }),
  ].sort(compareTasks);
  assert.deepEqual(sorted.map((x) => x.text), ['a', 'b', 'c', 'd', 'e']);
});

test('descriptions show priority, due date, overdue and owners', () => {
  const [ship, legal] = [tasks[1], tasks[0]];
  assert.equal(taskDescription(ship), 'P0 · due 2026-10-03 · @maya @sam');
  assert.equal(taskDescription(legal), 'P1 · due 2026-09-20 (overdue) · @legal');
  assert.equal(taskDescription(tasks[4]), 'P2');
  assert.equal(groupDescription(tasks.filter((x) => !x.done)), '8 open · 2 overdue');
  assert.equal(groupDescription(tasks), '8 open, 1 done · 2 overdue');
  assert.equal(groupDescription([tasks[4]]), '1 open');
  assert.equal(overdueCount(tasks), 2);
});

test('grouping names are validated', () => {
  assert.ok(isTaskGrouping('owner') && isTaskGrouping('due') && isTaskGrouping('document'));
  assert.ok(!isTaskGrouping('priority') && !isTaskGrouping(undefined));
});

test('taskCheckbox finds the box of a task line', () => {
  assert.deepEqual(taskCheckbox('- [ ] Ship'), { column: 3, done: false });
  assert.deepEqual(taskCheckbox('  12. [X] Done'), { column: 7, done: true });
  assert.deepEqual(taskCheckbox('* [x] ok'), { column: 3, done: true });
  assert.equal(taskCheckbox('- [] no'), undefined);
  assert.equal(taskCheckbox('[ ] not a list'), undefined);
});
