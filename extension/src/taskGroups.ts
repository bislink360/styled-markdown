import { dueState, type TaskInfo } from './core';
import { priorityRank } from './core/util';

/**
 * Grouping and ordering for the tasks view, without VS Code dependencies so it can be unit tested.
 * The CLI's `smd tasks` shares the order (overdue first, then priority, then due date).
 */

export type TaskGrouping = 'owner' | 'due' | 'document';
export const TASK_GROUPINGS: readonly TaskGrouping[] = ['owner', 'due', 'document'];

/** A task and the document it is in: `file` labels and sorts it (e.g. a workspace-relative path). */
export type FileTask = TaskInfo & { file: string };

export interface TaskGroup<T extends FileTask = FileTask> {
  /** Stable within a grouping, e.g. `owner:@maya`, `due:overdue`, `document:docs/plan.smd`. */
  key: string;
  label: string;
  tasks: T[];
}

const rank = priorityRank;

/** Overdue first, then by priority, due date (none last), file and line. */
export function compareTasks(a: FileTask, b: FileTask): number {
  return Number(b.overdue ?? false) - Number(a.overdue ?? false) || rank(a.priority) - rank(b.priority)
    || (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.file.localeCompare(b.file) || a.line - b.line;
}

export const isTaskGrouping = (value: unknown): value is TaskGrouping => TASK_GROUPINGS.includes(value as TaskGrouping);

/** `task.overdue` as of `today`, so a view kept open over midnight stays right. */
export function withOverdue<T extends FileTask>(task: T, today: string): T {
  if (!task.due) return task;
  return { ...task, overdue: !task.done && dueState(task.due, today) === 'overdue' };
}

/** Group `tasks` (overdue flags already set for today), ordering groups and the tasks inside them. */
export function groupTasks<T extends FileTask>(tasks: readonly T[], by: TaskGrouping, today: string): TaskGroup<T>[] {
  if (by === 'owner') return groupByOwner(tasks);
  if (by === 'due') return groupByDue(tasks, today);
  return groupByDocument(tasks);
}

function add<K, T>(map: Map<K, T[]>, key: K, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ---------------------------------------------------------------------------
// By owner
// ---------------------------------------------------------------------------

export const UNASSIGNED = 'Unassigned';

/** One group per owner, alphabetically, then Unassigned. A task with two owners is in both groups. */
function groupByOwner<T extends FileTask>(tasks: readonly T[]): TaskGroup<T>[] {
  const owners = new Map<string, { label: string; tasks: T[] }>();
  const unassigned: T[] = [];
  for (const t of tasks) {
    if (!t.assignees.length) unassigned.push(t);
    for (const owner of t.assignees) {
      const id = owner.toLowerCase();
      const entry = owners.get(id) ?? { label: owner, tasks: [] };
      entry.tasks.push(t);
      owners.set(id, entry);
    }
  }
  const groups = [...owners.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, g]) => ({ key: `owner:${id}`, label: g.label, tasks: g.tasks.sort(compareTasks) }));
  if (unassigned.length) groups.push({ key: 'owner:', label: UNASSIGNED, tasks: unassigned.sort(compareTasks) });
  return groups;
}

// ---------------------------------------------------------------------------
// By due date
// ---------------------------------------------------------------------------

export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'earlier' | 'none';

/** Buckets in display order. `earlier` holds completed tasks whose date has passed. */
export const DUE_BUCKETS: ReadonlyArray<{ bucket: DueBucket; label: string }> = [
  { bucket: 'overdue', label: 'Overdue' },
  { bucket: 'today', label: 'Today' },
  { bucket: 'week', label: 'This week' },
  { bucket: 'later', label: 'Later' },
  { bucket: 'earlier', label: 'Earlier' },
  { bucket: 'none', label: 'No due date' },
];

const DAY = 86_400_000;

/** Where a task goes when grouping by due date. "This week" is the next seven days. */
export function dueBucket(task: TaskInfo, today: string): DueBucket {
  if (!task.due || dueState(task.due, today) === 'invalid') return 'none';
  const days = (Date.parse(task.due) - Date.parse(today)) / DAY;
  if (days < 0) return task.done ? 'earlier' : 'overdue';
  if (days === 0) return 'today';
  return days <= 7 ? 'week' : 'later';
}

function groupByDue<T extends FileTask>(tasks: readonly T[], today: string): TaskGroup<T>[] {
  const buckets = new Map<DueBucket, T[]>();
  for (const t of tasks) add(buckets, dueBucket(t, today), t);
  return DUE_BUCKETS
    .filter(({ bucket }) => buckets.has(bucket))
    .map(({ bucket, label }) => ({ key: `due:${bucket}`, label, tasks: buckets.get(bucket)!.sort(compareTasks) }));
}

// ---------------------------------------------------------------------------
// By document
// ---------------------------------------------------------------------------

/** One group per document, by path. */
function groupByDocument<T extends FileTask>(tasks: readonly T[]): TaskGroup<T>[] {
  const files = new Map<string, T[]>();
  for (const t of tasks) add(files, t.file, t);
  return [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, list]) => ({ key: `document:${file}`, label: file, tasks: list.sort(compareTasks) }));
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** `P0 · due 2026-10-03 (overdue) · @maya @sam` — the parts a task has. */
export function taskDescription(task: TaskInfo): string {
  const due = task.due ? `due ${task.due}${task.overdue ? ' (overdue)' : ''}` : '';
  return [task.priority ?? '', due, task.assignees.join(' ')].filter(Boolean).join(' · ');
}

/** `3 open · 1 overdue` for a group's description (`3 open, 2 done` when completed ones are shown too). */
export function groupDescription(tasks: readonly TaskInfo[]): string {
  const open = tasks.filter((t) => !t.done).length;
  const overdue = tasks.filter((t) => t.overdue).length;
  const count = open === tasks.length ? `${open} open` : `${open} open, ${tasks.length - open} done`;
  return overdue ? `${count} · ${overdue} overdue` : count;
}

/** Overdue tasks across `tasks`, counting a task once. */
export const overdueCount = (tasks: readonly TaskInfo[]): number => tasks.filter((t) => t.overdue).length;
