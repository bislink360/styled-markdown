import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  addIssueLink, checkTaskLine, issueDraft, issueKey, issueTasks, planIssueSync, stripIssueRefs, taskIssueRef,
  type IssueRef, type IssueState, type IssueSyncAction, type IssueSyncKind, type IssueSyncPlan, type IssueTask,
} from './core';
import { collect, read } from './workspace';

/**
 * `smd issues`: sync tasks with GitHub Issues through the user's own GitHub CLI (`gh`), so no token
 * passes through smd. A dry run unless `apply`; creating and closing issues need their own flags.
 */

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** gh is not installed (not found on PATH). */
  missing?: boolean;
}

/** Runs `gh <args>` (with `input` on stdin). Injectable, so tests never reach GitHub. */
export type GhRunner = (args: string[], input?: string) => GhResult;

export interface IssuesOptions {
  /** `owner/name` for new issues (default: the repository of the current folder, from gh). */
  repo?: string;
  /** Write to GitHub and to the .smd files; otherwise only print the plan. */
  apply: boolean;
  /** Open an issue for every open task without one. */
  create: boolean;
  /** Close the issue of every done task. */
  close: boolean;
  /** Labels for new issues. */
  labels: string[];
  json: boolean;
  today?: string;
}

export interface IssuesIo {
  gh: GhRunner;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** A task with the file it is in, relative to the working directory. */
export type FileTask = IssueTask & { file: string };

type Status = 'planned' | 'needs-flag' | 'done' | 'failed' | 'not-run';

interface ActionResult {
  action: IssueSyncAction<FileTask>;
  status: Status;
  /** The issue the action is about: the linked one, or the one it created. */
  issue?: IssueRef;
  error?: string;
}

interface SyncRun {
  plan: IssueSyncPlan<FileTask>;
  results: ActionResult[];
  repo?: string;
  problems: string[];
}

const REPO = /^[A-Za-z0-9-]+\/[\w.-]+$/;
const FLAGS: Record<IssueSyncKind, string> = { check: '--apply', create: '--create', close: '--close' };
const KINDS: IssueSyncKind[] = ['check', 'create', 'close'];
const SUMMARY: Record<IssueSyncKind, { noun: string; todo: string; done: string }> = {
  check: { noun: 'task(s)', todo: 'to check off', done: 'checked off' },
  create: { noun: 'issue(s)', todo: 'to create', done: 'created' },
  close: { noun: 'issue(s)', todo: 'to close', done: 'closed' },
};
const HEADINGS: Record<IssueSyncKind, string> = {
  check: 'Check off tasks whose issue was closed',
  create: 'Open issues for tasks without one',
  close: 'Close issues whose task is done',
};

export function runIssues(targets: string[], options: IssuesOptions, io: IssuesIo): number {
  if (options.repo !== undefined && !REPO.test(options.repo)) return usage(io, `--repo needs owner/name, e.g. --repo bislink360/styled-markdown (got "${options.repo}").`);
  const files = targets.flatMap((t) => collect(t));
  if (!files.length) return usage(io, 'No .smd files found.');
  const ghProblem = checkGh(io.gh);
  if (ghProblem) return usage(io, ghProblem);

  const tasks = files.flatMap((file) => issueTasks(read(file), options.today).map((t) => ({ ...t, file: relativePath(file) })));
  const problems: string[] = [];
  const states = readStates(tasks, io.gh, problems);
  const plan = planIssueSync(tasks, states, options);
  const creates = plan.actions.some((a) => a.kind === 'create');
  const repo = options.repo ?? (creates ? currentRepo(io.gh) : undefined);
  if (creates && options.create && !repo) return usage(io, 'Could not tell the GitHub repository of the current folder: pass --repo owner/name.');

  const run: SyncRun = { plan, repo, problems, results: [] };
  run.results = options.apply ? applyPlan(plan, repo ?? '', options, io.gh) : plan.actions.map((action) => planned(action));
  report(run, options, io);
  return problems.length || run.results.some((r) => r.status === 'failed') ? 1 : 0;
}

/** Why gh can't be used, or undefined when it is installed and logged in to github.com. */
function checkGh(gh: GhRunner): string | undefined {
  const status = gh(['auth', 'status', '--hostname', 'github.com']);
  if (status.missing) return 'smd issues needs the GitHub CLI (gh): install it from https://cli.github.com, then run gh auth login.';
  if (!status.ok) return 'The GitHub CLI (gh) is not logged in to github.com: run gh auth login.';
  return undefined;
}

/** `owner/name` of the current folder's repository, from gh. */
function currentRepo(gh: GhRunner): string | undefined {
  const result = gh(['repo', 'view', '--json', 'nameWithOwner']);
  if (!result.ok) return undefined;
  const name = parseJson(result.stdout)?.nameWithOwner;
  return typeof name === 'string' && REPO.test(name) ? name : undefined;
}

/** The state of every linked issue, one gh call each; an issue that can't be read is left out and reported. */
function readStates(tasks: FileTask[], gh: GhRunner, problems: string[]): Map<string, IssueState> {
  const states = new Map<string, IssueState>();
  const seen = new Set<string>();
  for (const { issue } of tasks) {
    if (!issue || seen.has(issueKey(issue))) continue;
    seen.add(issueKey(issue));
    const result = gh(['api', `repos/${issue.repo}/issues/${issue.number}`]);
    const data = result.ok ? parseJson(result.stdout) : undefined;
    if (data?.state === 'open' || data?.state === 'closed') {
      states.set(issueKey(issue), { state: data.state, ...(typeof data.state_reason === 'string' ? { reason: data.state_reason } : {}) });
    } else {
      problems.push(`${issue.repo}#${issue.number}: ${firstLine(result.stderr) || 'unexpected answer from gh api'}`);
    }
  }
  return states;
}

function planned(action: IssueSyncAction<FileTask>): ActionResult {
  return { action, status: action.enabled ? 'planned' : 'needs-flag', issue: action.issue };
}

/** Carry out the enabled actions in order, stopping at the first failure. */
function applyPlan(plan: IssueSyncPlan<FileTask>, repo: string, options: IssuesOptions, gh: GhRunner): ActionResult[] {
  let stopped = false;
  return plan.actions.map((action) => {
    if (!action.enabled) return planned(action);
    if (stopped) return { action, status: 'not-run', issue: action.issue };
    const result = applyAction(action, repo, options, gh);
    stopped = result.status === 'failed';
    return result;
  });
}

function applyAction(action: IssueSyncAction<FileTask>, repo: string, options: IssuesOptions, gh: GhRunner): ActionResult {
  const fail = (error: string, issue = action.issue): ActionResult => ({ action, status: 'failed', issue, error });
  const { task } = action;
  if (!lineUnchanged(task)) return fail(`${task.file}:${task.line + 1} changed since it was read; run smd issues again`);
  if (action.kind === 'check') {
    return rewriteTaskLine(task, checkTaskLine) ? { action, status: 'done', issue: action.issue } : fail(`could not check off ${task.file}:${task.line + 1}`);
  }
  if (action.kind === 'close') {
    const issue = action.issue!;
    const comment = `Closed by \`smd issues\`: the task is checked off in \`${task.file}:${task.line + 1}\`.`;
    const result = gh(['issue', 'close', String(issue.number), '--repo', issue.repo, '--reason', 'completed', '--comment', comment]);
    return result.ok ? { action, status: 'done', issue } : fail(firstLine(result.stderr) || 'gh issue close failed');
  }
  return createIssue(action, repo, options.labels, gh);
}

/** Open the issue, then link it from the task line, so a second run never opens another one. */
function createIssue(action: IssueSyncAction<FileTask>, repo: string, labels: string[], gh: GhRunner): ActionResult {
  const { task } = action;
  const draft = issueDraft(task, { path: task.file });
  const args = ['issue', 'create', '--repo', repo, '--title', draft.title, '--body-file', '-', ...labels.flatMap((l) => ['--label', l])];
  const result = gh(args, draft.body);
  const issue = result.ok ? taskIssueRef(result.stdout) : undefined;
  if (!issue) return { action, status: 'failed', error: firstLine(result.stderr) || 'gh issue create printed no issue URL' };
  if (!rewriteTaskLine(task, (line) => addIssueLink(line, issue))) {
    return { action, status: 'failed', issue, error: `created ${issue.url} but could not link it from ${task.file}:${task.line + 1}; add the link by hand` };
  }
  return { action, status: 'done', issue };
}

/** The task's line as it is in the file now, without a trailing `\r`. */
function currentLine(task: FileTask): { lines: string[]; cr: string; line?: string } {
  const lines = read(task.file).split('\n');
  const raw = lines[task.line];
  const cr = raw?.endsWith('\r') ? '\r' : '';
  return { lines, cr, line: raw?.slice(0, raw.length - cr.length) };
}

function lineUnchanged(task: FileTask): boolean {
  return currentLine(task).line === task.source;
}

/** Replace the task's line with `edit(line)` (only if it is still as read), keeping its line ending. */
function rewriteTaskLine(task: FileTask, edit: (line: string) => string | undefined): boolean {
  const { lines, cr, line } = currentLine(task);
  if (line !== task.source) return false;
  const next = edit(line);
  if (next === undefined) return false;
  lines[task.line] = next + cr;
  fs.writeFileSync(task.file, lines.join('\n'));
  return true;
}

function report(run: SyncRun, options: IssuesOptions, io: IssuesIo): void {
  if (options.json) io.out(JSON.stringify(jsonReport(run, options), null, 2) + '\n');
  else io.out(textReport(run, options));
  for (const p of run.problems) io.err(`[smd] could not read ${p}`);
  io.err(`[smd] ${summary(run, options)}`);
}

function textReport(run: SyncRun, options: IssuesOptions): string {
  const out: string[] = [];
  if (!options.apply) out.push('Dry run: nothing is changed. Add --apply to sync (--create to open issues, --close to close them).', '');
  for (const kind of KINDS) {
    const results = run.results.filter((r) => r.action.kind === kind);
    if (!results.length) continue;
    const where = kind === 'create' && run.repo ? ` in ${run.repo}` : '';
    out.push(`${HEADINGS[kind]}${where} (${results.length}):`, ...results.map(resultLine), '');
  }
  if (run.plan.skipped.length) {
    out.push('Skipped:', ...run.plan.skipped.map((s) => `  ${taskLabel(s.task)}  ${s.issue.repo}#${s.issue.number}: ${s.reason}`), '');
  }
  if (!run.results.length && !run.plan.skipped.length) out.push('Nothing to sync.', '');
  return out.join('\n');
}

/** `  docs/plan.smd:12  Ship the quote endpoint  owner/repo#123  done` */
function resultLine(r: ActionResult): string {
  const issue = r.issue ? `${r.issue.repo}#${r.issue.number}` : '';
  return '  ' + [taskLabel(r.action.task), issue, statusNote(r)].filter(Boolean).join('  ');
}

function statusNote(r: ActionResult): string {
  switch (r.status) {
    case 'needs-flag': return `(needs ${FLAGS[r.action.kind]})`;
    case 'done': return 'done';
    case 'failed': return `FAILED: ${r.error}`;
    case 'not-run': return '(not run: stopped after an error)';
    default: return '';
  }
}

function taskLabel(task: FileTask): string {
  return `${task.file}:${task.line + 1}  ${stripIssueRefs(task.text) || task.text}`;
}

/** `dry run, nothing changed: 1 task(s) to check off, 2 issue(s) to create (needs --create), 0 issue(s) to close; 3 in sync.` */
function summary(run: SyncRun, options: IssuesOptions): string {
  const parts = KINDS.map((kind) => summaryPart(run.results.filter((r) => r.action.kind === kind), kind, options.apply));
  const failed = run.results.filter((r) => r.status === 'failed' || r.status === 'not-run').length;
  const tail = [`${run.plan.inSync.length} in sync`, failed ? `${failed} failed or not run` : ''].filter(Boolean);
  const head = options.apply ? '' : 'dry run, nothing changed: ';
  return `${head}${parts.join(', ')}; ${tail.join(', ')}.`;
}

/** `2 issue(s) to create (needs --create)`, after --apply `0 issue(s) created (2 more with --create)` */
function summaryPart(results: ActionResult[], kind: IssueSyncKind, apply: boolean): string {
  const waiting = results.filter((r) => r.status === 'needs-flag').length;
  const count = apply ? results.filter((r) => r.status === 'done').length : results.length;
  const text = `${count} ${SUMMARY[kind].noun} ${apply ? SUMMARY[kind].done : SUMMARY[kind].todo}`;
  if (!waiting) return text;
  return apply ? `${text} (${waiting} more with ${FLAGS[kind]})` : `${text} (needs ${FLAGS[kind]})`;
}

function jsonReport(run: SyncRun, options: IssuesOptions) {
  return {
    apply: options.apply,
    repo: run.repo ?? null,
    actions: run.results.map((r) => ({
      kind: r.action.kind, status: r.status, ...taskJson(r.action.task), issue: issueJson(r.issue), ...(r.error ? { error: r.error } : {}),
    })),
    skipped: run.plan.skipped.map((s) => ({ ...taskJson(s.task), issue: issueJson(s.issue), reason: s.reason })),
    inSync: run.plan.inSync.length,
    problems: run.problems,
  };
}

function taskJson(task: FileTask) {
  return { file: task.file, line: task.line, text: stripIssueRefs(task.text) || task.text, done: task.done };
}

function issueJson(issue: IssueRef | undefined) {
  return issue ? { repo: issue.repo, number: issue.number, url: issue.url } : null;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
}

/** `docs/plan.smd`: relative to the working directory, with forward slashes on every platform. */
function relativePath(file: string): string {
  return path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/');
}

function usage(io: IssuesIo, message: string): number {
  io.err(message);
  return 2;
}
