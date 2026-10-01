import {
  decisionBadge, decisionHref, decisionLog, documentTitle, escapeInline, headingAbove, linkTarget, plural, type DecisionEntry,
} from './decisions';
import { formatSmd } from './format';
import { parseFrontMatter } from './frontmatter';
import { extractTasks, type TaskInfo } from './meta';
import { parseSmd } from './parse';
import { parseSelector, querySmd, type QueryMatch } from './query';
import type { Heading } from './render';
import { PRIORITY_VALUES } from './spec';
import { priorityRank } from './util';

/**
 * Status report (`smd report`): how the tasks and decisions of a set of documents changed since an earlier
 * version of them, as data or as a draft that follows the `status-report` template.
 *
 * Tasks have no ids, so a task is matched across versions by its document and its text (case and spacing
 * ignored); its owner, priority and due date may change. A renamed task counts as removed and added.
 */

export interface ReportDocument {
  /** The document's path as given; it labels and links each item, so use the same path in both versions. */
  path: string;
  text: string;
}

export interface StatusReportOptions {
  /** "Today" as YYYY-MM-DD for overdue and due-soon tasks and the report's date (default: the current date). */
  today?: string;
  /**
   * What the earlier version is, for headings (`Done since …`): a Git revision or a YYYY-MM-DD date. Without an
   * earlier version, a date still selects the decisions dated on or after it.
   */
  since?: string;
  /** The commit the earlier version was read from, shown next to `since` in the report. */
  revision?: string;
  /** The report's title before ` — status <today>` (default `Status report`). */
  title?: string;
  /** The link to a document from where the report will live (default: the path as given). */
  link?: (path: string) => string;
}

export interface ReportTask extends TaskInfo {
  /** The document's path as given. */
  path: string;
  /** The document's front matter `title`, else its first `#` heading, else its file name. */
  document: string;
  /** The id of the task's section heading; null above the first heading. */
  anchor: string | null;
}

export interface ReportDecision {
  decision: DecisionEntry;
  /** The decision's status in the earlier version; null when it is new (or, without one, dated since). */
  before: string | null;
}

export interface ReportRisk {
  title: string;
  impact: string;
  likelihood: string | null;
  owner: string | null;
  path: string;
  document: string;
  line: number;
  section: string | null;
  /** The risk's own `{#id}`, else its section's heading id; null above the first heading. */
  anchor: string | null;
}

export interface StatusChanges {
  /** False when there was no earlier version: tasks done now can't be dated, so `done`, `added` and `removed` are empty. */
  compared: boolean;
  today: string;
  /** Tasks done now that were open (or didn't exist) in the earlier version. */
  done: ReportTask[];
  /** Tasks that didn't exist in the earlier version, open or already done. */
  added: ReportTask[];
  /** Tasks of the earlier version that are gone, as they were then. */
  removed: ReportTask[];
  /** Every open task: overdue first, then by priority, due date, path and line. */
  open: ReportTask[];
  /** Open tasks past their due date. */
  overdue: ReportTask[];
  /** Open tasks due today or in the next 7 days. */
  dueSoon: ReportTask[];
  /** Decisions that are new or changed status since (without an earlier version: dated on or after a `since` date). */
  decisions: ReportDecision[];
  /** Decisions still proposed, newest first. */
  needed: DecisionEntry[];
  /** Open risks with impact high or critical. */
  risks: ReportRisk[];
  /** The current documents, with how many tasks and open tasks each has. */
  documents: Array<{ path: string; document: string; tasks: number; openTasks: number }>;
}

const SOON_DAYS = 7;
const HIGH_RISKS = parseSelector('risk[impact=high|critical]');
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The draft report for `before` (null when there is no earlier version) and `after`. */
export function statusReport(before: ReportDocument[] | null, after: ReportDocument[], options: StatusReportOptions = {}): string {
  return statusReportMarkdown(statusChanges(before, after, options), options);
}

/** How the tasks and decisions changed from `before` (null when there is no earlier version) to `after`. */
export function statusChanges(before: ReportDocument[] | null, after: ReportDocument[], options: StatusReportOptions = {}): StatusChanges {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const now = after.flatMap((d) => documentTasks(d, today));
  const open = now.filter((t) => !t.done).sort(compareTasks);
  const tasks = before ? taskChanges(before.flatMap((d) => documentTasks(d, today)), now) : { done: [], added: [], removed: [] };
  const decisionsNow = decisionLog(after);
  return {
    compared: before !== null,
    today,
    ...tasks,
    open,
    overdue: open.filter((t) => t.overdue),
    dueSoon: open.filter((t) => isDueSoon(t, today)),
    decisions: before ? decisionChanges(decisionLog(before), decisionsNow) : datedSince(decisionsNow, options.since),
    needed: decisionsNow.filter((d) => d.status === 'proposed'),
    risks: after.flatMap(documentRisks),
    documents: after.map((d) => documentEntry(d, now)),
  };
}

function documentEntry(doc: ReportDocument, tasks: ReportTask[]): StatusChanges['documents'][number] {
  const own = tasks.filter((t) => t.path === doc.path);
  return { path: doc.path, document: describe(doc).document, tasks: own.length, openTasks: own.filter((t) => !t.done).length };
}

function describe(doc: ReportDocument): { document: string; headings: Heading[] } {
  const headings = parseSmd(doc.text).headings;
  return { document: documentTitle(parseFrontMatter(doc.text).data, headings, doc.path), headings };
}

function documentTasks(doc: ReportDocument, today: string): ReportTask[] {
  const { document, headings } = describe(doc);
  return extractTasks(doc.text, today).map((t) => ({ ...t, path: doc.path, document, anchor: headingAbove(headings, t.line)?.slug ?? null }));
}

/** Pairs each current task with an unpaired earlier one of the same document and text, in document order. */
function taskChanges(before: ReportTask[], after: ReportTask[]): Pick<StatusChanges, 'done' | 'added' | 'removed'> {
  const pool = new Map<string, ReportTask[]>();
  for (const t of before) pool.set(taskKey(t), [...(pool.get(taskKey(t)) ?? []), t]);
  const pairs = after.map((t) => ({ now: t, before: pool.get(taskKey(t))?.shift() }));
  return {
    done: pairs.filter((p) => p.now.done && !p.before?.done).map((p) => p.now),
    added: pairs.filter((p) => !p.before).map((p) => p.now),
    removed: [...pool.values()].flat().sort(compareLocation),
  };
}

function taskKey(t: ReportTask): string {
  return `${t.path}\0${t.text.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

function isDueSoon(t: ReportTask, today: string): boolean {
  if (!t.due || t.overdue || !DATE.test(t.due)) return false;
  const days = (Date.parse(t.due) - Date.parse(today)) / 86_400_000;
  return days >= 0 && days <= SOON_DAYS;
}

/** As `smd tasks`: overdue first, then by priority, due date, path and line. */
function compareTasks(a: ReportTask, b: ReportTask): number {
  return Number(b.overdue ?? false) - Number(a.overdue ?? false) || priorityRank(a.priority) - priorityRank(b.priority)
    || compareText(a.due ?? '9999', b.due ?? '9999') || compareLocation(a, b);
}

function compareLocation(a: { path: string; line: number }, b: { path: string; line: number }): number {
  return compareText(a.path, b.path) || a.line - b.line;
}

/** Byte-order comparison, so the order doesn't depend on the locale. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Decisions that are new or whose status changed, matched by document and title like tasks. */
function decisionChanges(before: DecisionEntry[], after: DecisionEntry[]): ReportDecision[] {
  const pool = new Map<string, DecisionEntry[]>();
  for (const d of before) pool.set(decisionKey(d), [...(pool.get(decisionKey(d)) ?? []), d]);
  return after.flatMap((d): ReportDecision[] => {
    const then = pool.get(decisionKey(d))?.shift();
    if (!then) return [{ decision: d, before: null }];
    return then.status === d.status ? [] : [{ decision: d, before: then.status }];
  });
}

function decisionKey(d: DecisionEntry): string {
  return `${d.path}\0${d.title.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

/** Without an earlier version: the decisions dated on or after a `since` date. */
function datedSince(decisions: DecisionEntry[], since: string | undefined): ReportDecision[] {
  if (!since || !DATE.test(since)) return [];
  const day = (d: DecisionEntry) => (d.date ?? '').slice(0, 10);
  return decisions.filter((d) => DATE.test(day(d)) && day(d) >= since).map((d) => ({ decision: d, before: null }));
}

/** Open (or status-less) risks with impact high or critical. */
function documentRisks(doc: ReportDocument): ReportRisk[] {
  const matches = querySmd(doc.text, HIGH_RISKS, { lineRefs: false }).filter((m) => (first(m.attrs.status) ?? 'open').toLowerCase() === 'open');
  if (!matches.length) return [];
  const { document, headings } = describe(doc);
  return matches.map((m) => riskOf(m, doc.path, document, headings));
}

function riskOf(m: QueryMatch, path: string, document: string, headings: Heading[]): ReportRisk {
  return {
    title: m.title,
    impact: (first(m.attrs.impact) ?? 'high').toLowerCase(),
    likelihood: first(m.attrs.likelihood) ?? null,
    owner: first(m.attrs.owner) ?? null,
    path,
    document,
    line: m.line,
    section: m.section,
    anchor: first(m.attrs.id) ?? headingAbove(headings, m.line)?.slug ?? null,
  };
}

function first(value: string | string[] | undefined): string | undefined {
  const v = [value ?? []].flat()[0]?.trim();
  return v || undefined;
}

// The draft document. Items are plain list entries, not tasks, decisions or risks of their own, so the
// report doesn't add to `smd tasks` or `smd decisions` and a past due date doesn't make it fail validation.

type Link = (path: string) => string;

const UNKNOWN = 'Unknown: there was no earlier version to compare with.';

/**
 * The changes as a draft status report: a formatted .smd document in the shape of the `status-report` template,
 * linking each item to its section. It passes `smd validate` and `smd fmt --check` when the links resolve from
 * where it is saved (see `link`). The summary is left for a person to write.
 */
export function statusReportMarkdown(changes: StatusChanges, options: StatusReportOptions = {}): string {
  const link = options.link ?? ((path: string) => path);
  const period = options.since ? `since ${escapeInline(options.since)}` : 'this period';
  const lines = [
    ...frontMatter(changes, options, link),
    ...intro(changes, options),
    ...summarySection(changes),
    `## Done ${period}`, '', ...doneItems(changes, link), '',
    `## New ${period}`, '', ...newItems(changes, link), '',
    ...removedSection(changes, period),
    '## Open tasks', '',
    '### Overdue', '', ...items(changes.overdue, (t) => taskItem(t, link)), '',
    `### Due in the next ${SOON_DAYS} days`, '', ...items(changes.dueSoon, (t) => taskItem(t, link)), '',
    '### Other open tasks', '', ...items(otherOpen(changes), (t) => taskItem(t, link)), '',
    '## Risks and blockers', '', ...items(changes.risks, (r) => riskItem(r, link)), '',
    `## Decisions ${period}`, '', ...items(changes.decisions, (d) => decisionItem(d, changes.compared, link)), '',
    '## Decisions needed', '', ...items(changes.needed, (d) => decisionItem({ decision: d, before: null }, false, link)), '',
    '## Sources', '', ...items(changes.documents, (d) => `- [${escapeInline(d.document)}](${linkTarget(link(d.path))}) — ${plural(d.openTasks, 'open task')}`),
  ];
  return formatSmd(lines.join('\n') + '\n');
}

function frontMatter(changes: StatusChanges, options: StatusReportOptions, link: Link): string[] {
  const title = `${options.title?.trim() || 'Status report'} — status ${changes.today}`;
  const summary = `Draft: ${counts(changes, options.since)}. Replace with one sentence on overall health.`;
  const related = changes.documents.map((d) => JSON.stringify(link(d.path)));
  return [
    '---',
    'smd: 1',
    `title: ${JSON.stringify(title)}`,
    `summary: ${JSON.stringify(summary)}`,
    'status: draft',
    'tags: [status]',
    `updated: ${changes.today}`,
    ...(related.length ? [`related: [${related.join(', ')}]`] : []),
    '---',
    '',
  ];
}

/** `2 tasks done and 1 added since HEAD~1; 5 open tasks, 1 overdue` */
function counts(changes: StatusChanges, since?: string): string {
  const open = `${plural(changes.open.length, 'open task')}, ${changes.overdue.length} overdue`;
  if (!changes.compared) return open;
  const period = since ? ` since ${since}` : '';
  return `${plural(changes.done.length, 'task')} done and ${changes.added.length} added${period}; ${open}`;
}

function intro(changes: StatusChanges, options: StatusReportOptions): string[] {
  const base = options.since ? ` with their version at ${escapeInline(options.since)}` : ' with their earlier version';
  const at = options.revision ? ` (${escapeInline(options.revision)})` : '';
  const from = `Drafted by \`smd report\` from ${plural(changes.documents.length, 'document')}`;
  if (changes.compared) return [`${from}, compared${base}${at}. Review it and write the summary before sharing.`, ''];
  return [
    `${from}. Review it and write the summary before sharing.`,
    '',
    ':::warning No earlier version to compare with',
    'There was no earlier version of the documents (for example, no Git history), so completed and new tasks can\'t be dated:',
    'this draft shows the current state only.',
    ':::',
    '',
  ];
}

function summarySection(changes: StatusChanges): string[] {
  const total = changes.documents.reduce((n, d) => n + d.tasks, 0);
  const progress = total ? Math.round(((total - changes.open.length) / total) * 100) : 0;
  const atRisk = changes.overdue.length > 0 || changes.risks.length > 0;
  const status = atRisk ? ':status[At risk]{color=orange}' : ':status[On track]{color=green}';
  const metrics = [
    ...(changes.compared ? [`:metric[${changes.done.length}]{label="Done"}`, `:metric[${changes.added.length}]{label="New"}`] : []),
    `:metric[${changes.open.length}]{label="Open"}`,
    `:metric[${changes.overdue.length}]{label="Overdue"}`,
  ];
  return [
    '## Summary',
    '',
    `**Overall:** ${status} · **Progress:** :progress{value=${progress}}`,
    '',
    metrics.join(' '),
    '',
    '_Write one or two sentences on overall health and the most important thing to know, and check the status above._',
    '',
  ];
}

/** One list entry per item, or `None.` */
function items<T>(list: T[], item: (value: T) => string): string[] {
  return list.length ? list.map(item) : ['None.'];
}

function doneItems(changes: StatusChanges, link: Link): string[] {
  if (!changes.compared) return [UNKNOWN];
  return items(changes.done, (t) => taskItem(t, link, changes.added.includes(t) ? ':badge[new]{color=blue}' : ''));
}

function newItems(changes: StatusChanges, link: Link): string[] {
  if (!changes.compared) return [UNKNOWN];
  return items(changes.added, (t) => taskItem(t, link, t.done ? ':badge[done]{color=green}' : ''));
}

/** Only when tasks were removed: renamed tasks show up here and under New. */
function removedSection(changes: StatusChanges, period: string): string[] {
  if (!changes.removed.length) return [];
  return [
    `## Removed ${period}`,
    '',
    'Tasks are matched by their text, so a reworded task is listed here and under New.',
    '',
    ...changes.removed.map((t) => `- ~~${escapeInline(t.text)}~~${t.done ? ' (was done)' : ''} — ${escapeInline(where(t.document, t.section))}`),
    '',
  ];
}

/** Open tasks that are neither overdue nor due soon. */
function otherOpen(changes: StatusChanges): ReportTask[] {
  return changes.open.filter((t) => !changes.overdue.includes(t) && !changes.dueSoon.includes(t));
}

/** `- Ship it · :priority[P1] · @maya · due 2026-10-01 — [Plan › Rollout](plan.smd#rollout)` */
function taskItem(t: ReportTask, link: Link, badge = ''): string {
  const bits = [
    escapeInline(t.text) + (badge ? ` ${badge}` : ''),
    t.priority ? priority(t.priority) : '',
    t.assignees.map(escapeInline).join(' '),
    t.due ? dueText(t) : '',
  ];
  return `- ${bits.filter(Boolean).join(' · ')} — ${sourceLink(t, link)}`;
}

/** A known priority as a pill, anything else as plain text. */
function priority(value: string): string {
  const known = PRIORITY_VALUES.some((p) => p.toLowerCase() === value.toLowerCase());
  return known ? `:priority[${value}]` : escapeInline(value);
}

function dueText(t: ReportTask): string {
  const due = `due ${escapeInline(t.due ?? '')}`;
  return t.overdue ? `${due} :badge[overdue]{color=red}` : due;
}

function riskItem(r: ReportRisk, link: Link): string {
  const bits = [`**${escapeInline(r.title)}**`, `impact ${escapeInline(r.impact)}`];
  if (r.likelihood) bits.push(`likelihood ${escapeInline(r.likelihood)}`);
  if (r.owner) bits.push(escapeInline(r.owner));
  return `- ${bits.join(' · ')} — ${sourceLink(r, link)}`;
}

function decisionItem(d: ReportDecision, compared: boolean, link: Link): string {
  const e = d.decision;
  const change = d.before ? ` (was ${escapeInline(d.before)})` : '';
  const isNew = compared && !d.before ? ' (new)' : '';
  const bits = [`${decisionBadge(e.status)} ${escapeInline(e.title)}${change}${isNew}`];
  if (e.date) bits.push(escapeInline(e.date));
  if (e.owner) bits.push(escapeInline(e.owner));
  const target = decisionHref(e, link(e.path));
  return `- ${bits.join(' · ')} — [${escapeInline(where(e.document, e.adr ? null : e.section))}](${linkTarget(target)})`;
}

/** `[Plan › Rollout](plan.smd#rollout)` */
function sourceLink(item: { path: string; document: string; section: string | null; anchor: string | null }, link: Link): string {
  const href = link(item.path);
  const target = item.anchor ? `${href}#${item.anchor}` : href;
  return `[${escapeInline(where(item.document, item.anchor ? item.section : null))}](${linkTarget(target)})`;
}

function where(document: string, section: string | null): string {
  return section && section !== document ? `${document} › ${section}` : document;
}
