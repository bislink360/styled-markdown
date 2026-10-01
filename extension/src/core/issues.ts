import { extractTasks, type TaskInfo } from './meta';

/**
 * GitHub Issues sync for tasks (`smd issues`), the pure part: find the issue a task links to, plan
 * what to sync from the tasks and the issues' states, draft a new issue, and rewrite one task line.
 * Talking to GitHub and writing files is left to the caller.
 *
 * A task is linked by a reference to the issue anywhere on its line (outside code spans):
 * `[#123](https://github.com/owner/repo/issues/123)` (any link text), a bare
 * `https://github.com/owner/repo/issues/123` URL, or `owner/repo#123`. The first one counts.
 */

export interface IssueRef {
  /** `owner/name`, as written. */
  repo: string;
  number: number;
  /** `https://github.com/owner/name/issues/123` */
  url: string;
  /** Zero-based columns of the reference on its line (a Markdown link's URL only). */
  column: number;
  endColumn: number;
}

/** A task with the issue it links to, if any, and its line as written (to check before rewriting it). */
export type IssueTask = TaskInfo & { issue?: IssueRef; source: string };

export interface IssueState {
  state: 'open' | 'closed';
  /** GitHub's `state_reason` of a closed issue: `completed`, `not_planned`, … */
  reason?: string;
}

export type IssueSyncKind = 'check' | 'create' | 'close';

export interface IssueSyncAction<T extends IssueTask = IssueTask> {
  /** `check`: check the task off (its issue closed); `create`: open an issue for it; `close`: close its issue (the task is done). */
  kind: IssueSyncKind;
  task: T;
  issue?: IssueRef;
  /** False when the flag this action needs (`create` or `close`) was not given: it is only reported. */
  enabled: boolean;
}

export interface IssueSyncPlan<T extends IssueTask = IssueTask> {
  /** Check-offs first, then new issues, then issues to close; in task order within each. */
  actions: Array<IssueSyncAction<T>>;
  /** Linked tasks whose issue already agrees with them. */
  inSync: T[];
  /** Linked tasks left alone, with the reason (the issue could not be read, or was closed as not planned). */
  skipped: Array<{ task: T; issue: IssueRef; reason: string }>;
}

export interface IssueSyncOptions {
  /** Open an issue for every open task without one. */
  create?: boolean;
  /** Close the issue of every done task whose issue is open. */
  close?: boolean;
}

export interface IssueDraftSource {
  /** The document's path, as shown in the issue body (e.g. relative to the repository). */
  path: string;
}

const URL_SOURCE = String.raw`https?://github\.com/([A-Za-z0-9-]+)/([\w.-]+)/issues/(\d+)(?![\w/])`;
const ISSUE_URL = new RegExp(URL_SOURCE, 'gi');
/** A Markdown link or autolink to an issue, removed whole from titles. */
const ISSUE_LINK = new RegExp(String.raw`\[[^\]\n]*\]\(\s*${URL_SOURCE}\s*\)|<${URL_SOURCE}>`, 'gi');
const SHORT_REF = /(?<![\w./-])([A-Za-z0-9-]+)\/([\w.-]+)#(\d+)(?!\w)/g;
const CODE_SPAN = /`+[^`]*`+/g;
const TASK_BOX = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/;
const GITHUB_TITLE_MAX = 256;

/** Every issue reference on a line, in order, ignoring code spans. */
export function parseIssueRefs(line: string): IssueRef[] {
  const masked = mask(line, CODE_SPAN);
  const refs = [...masked.matchAll(ISSUE_URL)].map((m) => ref(m, m[0].length));
  const rest = mask(masked, ISSUE_URL);
  refs.push(...[...rest.matchAll(SHORT_REF)].map((m) => ref(m, m[0].length)));
  return refs.sort((a, b) => a.column - b.column);
}

/** The issue a task line links to: its first reference. */
export function taskIssueRef(line: string): IssueRef | undefined {
  return parseIssueRefs(line)[0];
}

/** `owner/name#123`, lower case, to compare references. */
export function issueKey(issue: Pick<IssueRef, 'repo' | 'number'>): string {
  return `${issue.repo.toLowerCase()}#${issue.number}`;
}

/** The tasks of a document, each with the issue it links to. */
export function issueTasks(text: string, today?: string): IssueTask[] {
  const lines = text.split('\n');
  return extractTasks(text, today).map((t) => {
    const source = lines[t.line].replace(/\r$/, '');
    const issue = taskIssueRef(source);
    return issue ? { ...t, issue, source } : { ...t, source };
  });
}

/**
 * What a sync would do: check off open tasks whose issue closed (unless closed as not planned),
 * open issues for open tasks without one, close issues whose task is done. Done tasks without an
 * issue are left alone, and each issue is closed once even when several tasks link to it.
 */
export function planIssueSync<T extends IssueTask>(
  tasks: T[], states: ReadonlyMap<string, IssueState>, options: IssueSyncOptions = {},
): IssueSyncPlan<T> {
  const plan: IssueSyncPlan<T> = { actions: [], inSync: [], skipped: [] };
  const closing = new Set<string>();
  for (const task of tasks) {
    const issue = task.issue;
    if (!issue) {
      if (!task.done) plan.actions.push({ kind: 'create', task, enabled: !!options.create });
      continue;
    }
    const key = issueKey(issue);
    const step = syncStep(task, states.get(key));
    if (step === 'check') plan.actions.push({ kind: step, task, issue, enabled: true });
    else if (step === 'close' && !closing.has(key)) {
      closing.add(key);
      plan.actions.push({ kind: step, task, issue, enabled: !!options.close });
    } else if (step === 'close' || step === 'sync') plan.inSync.push(task);
    else plan.skipped.push({ task, issue, reason: SKIP_REASONS[step] });
  }
  const order: IssueSyncKind[] = ['check', 'create', 'close'];
  plan.actions.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return plan;
}

type SyncStep = 'check' | 'close' | 'sync' | 'unread' | 'not-planned';

const SKIP_REASONS: Record<string, string> = {
  unread: 'the issue could not be read',
  'not-planned': 'the issue was closed as not planned; the task stays open',
};

/** What a linked task needs, given its issue's state (undefined when it could not be read). */
function syncStep(task: IssueTask, state: IssueState | undefined): SyncStep {
  if (!state) return 'unread';
  if (state.state === 'open') return task.done ? 'close' : 'sync';
  if (task.done) return 'sync';
  return state.reason === 'not_planned' ? 'not-planned' : 'check';
}

/** Title and body for a new issue. Owners go in a code span, so GitHub doesn't @-mention anyone. */
export function issueDraft(task: TaskInfo, source: IssueDraftSource): { title: string; body: string } {
  const title = plainTitle(stripIssueRefs(task.text)) || `Task at ${source.path}:${task.line + 1}`;
  const where = task.section ? ` (section "${task.section}")` : '';
  const details = [
    task.assignees.length ? `- Owners: ${task.assignees.map((a) => '`' + a + '`').join(', ')}` : '',
    task.priority ? `- Priority: ${task.priority}` : '',
    task.due ? `- Due: ${task.due}` : '',
  ].filter(Boolean);
  const body = [
    `Task from \`${source.path}:${task.line + 1}\`${where}.`,
    details.join('\n'),
    'Created by `smd issues`. The task links back to this issue; when the issue is closed, `smd issues --apply` checks the task off.',
  ].filter(Boolean).join('\n\n');
  return { title: truncate(title, GITHUB_TITLE_MAX), body: body + '\n' };
}

/** Task text without issue references (and links whose URL was one), for titles and listings. */
export function stripIssueRefs(text: string): string {
  return text
    .replace(ISSUE_LINK, '')
    .replace(ISSUE_URL, '')
    .replace(SHORT_REF, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * The task line with ` [#N](url)` added at the end of its content: nothing else changes, and
 * trailing whitespace and a `\r` stay at the end.
 */
export function addIssueLink(line: string, issue: Pick<IssueRef, 'number' | 'url'>): string {
  const content = line.trimEnd();
  const tail = line.slice(content.length);
  return `${content} [#${issue.number}](${issue.url})${tail}`;
}

/** The task line with its box checked; undefined when it is not a task line. Nothing else changes. */
export function checkTaskLine(line: string): string | undefined {
  const m = TASK_BOX.exec(line);
  if (!m) return undefined;
  if (m[2] !== ' ') return line;
  return `${m[1]}x${line.slice(m[1].length + 1)}`;
}

function ref(m: RegExpMatchArray, length: number): IssueRef {
  const repo = `${m[1]}/${m[2]}`;
  const number = Number(m[3]);
  const column = m.index ?? 0;
  return { repo, number, url: `https://github.com/${repo}/issues/${number}`, column, endColumn: column + length };
}

/** `text` with every match of `re` replaced by spaces, so columns stay the same. */
function mask(text: string, re: RegExp): string {
  return text.replace(re, (m) => ' '.repeat(m.length));
}

/** GitHub shows `**bold**`, `__bold__` and `~~struck~~` literally in titles. */
function plainTitle(text: string): string {
  return text.replace(/(\*\*|__|~~)(.+?)\1/g, '$2');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}
