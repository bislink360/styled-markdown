import { escapeHtml } from './attrs';
import { decisionLog, headingAbove, isInactiveDecision, type DecisionEntry } from './decisions';
import { compareTasks, extractTasks, type TaskInfo } from './meta';
import { dueNote } from './markdownItHtml';
import { dueState, type Heading } from './render';
import { riskBand, riskMatrixHtml } from './riskHtml';
import { riskMatrix, riskRegister, type RiskEntry } from './risks';
import type { Linker } from './siteLinks';

/**
 * The dashboard of a static site (`smd build`): open tasks (overdue first, then by priority and due date),
 * decisions (newest first) and open risks (highest score first, with the impact × likelihood matrix) across
 * every document, each linking to its place on its page. All document text is escaped.
 */

export interface DashboardDocument {
  /** Source path; tasks, decisions and risks are labelled and ordered by it. */
  source: string;
  /** Page path in the site. */
  output: string;
  title: string;
  text: string;
  headings: Heading[];
}

export interface DashboardOptions {
  linker: Linker;
  /** The dashboard's own path in the site, for relative links. */
  output: string;
  /** YYYY-MM-DD for overdue and due-soon tasks; defaults to the current date. */
  today?: string;
}

/** Risk statuses that no longer need attention (as `smd index` counts open risks). */
const SETTLED_RISKS = new Set(['mitigated', 'closed']);

type DashboardTask = TaskInfo & { file: string; doc: DashboardDocument };

/** The dashboard page body. */
export function dashboardHtml(documents: DashboardDocument[], options: DashboardOptions): string {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const tasks = documents
    .flatMap((doc) => extractTasks(doc.text, today).filter((t) => !t.done).map((t): DashboardTask => ({ ...t, file: doc.source, doc })))
    .sort(compareTasks);
  const sources = documents.map((d) => ({ path: d.source, text: d.text }));
  const decisions = decisionLog(sources);
  const risks = riskRegister(sources).risks.filter((r) => !SETTLED_RISKS.has(r.status));
  const bySource = new Map(documents.map((d) => [d.source, d]));
  const link: PlaceHref = (source, anchor) => placeHref(bySource.get(source), anchor, options);
  const overdue = tasks.filter((t) => t.overdue).length;
  const proposed = decisions.filter((d) => d.status === 'proposed').length;
  const summary = `${tasks.length} open task(s), ${overdue} overdue · ${decisions.length} decision(s), ${proposed} proposed · `
    + `${risks.length} open risk(s) · ${documents.length} document(s)`;
  return '<article class="smd-doc smd-site-dashboard"><h1 id="dashboard">Dashboard</h1>'
    + `<p class="smd-site-lead">${escapeHtml(summary)}</p>`
    + `<h2 id="tasks">Open tasks</h2>${tasksTable(tasks, today, link)}`
    + `<h2 id="decisions">Decisions</h2>${decisionsTable(decisions, link)}`
    + `<h2 id="risks">Open risks</h2>${risksSection(risks, documents, link)}`
    + '</article>';
}

type PlaceHref = (source: string, anchor: string | null | undefined) => string | undefined;

/** The URL of a place in a document: its page, at the anchor when there is one. */
function placeHref(doc: DashboardDocument | undefined, anchor: string | null | undefined, options: DashboardOptions): string | undefined {
  if (!doc) return undefined;
  return options.linker.href(options.output, doc.output) + (anchor ? `#${encodeURIComponent(anchor)}` : '');
}

/** The label escaped, as a link when there is a URL. */
function linked(href: string | undefined, label: string): string {
  return href === undefined ? escapeHtml(label) : `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/** `Document › Section`. */
function where(document: string, section: string | null): string {
  return section && section !== document ? `${document} › ${section}` : document;
}

function table(columns: string[], rows: string[][], empty: string): string {
  if (!rows.length) return `<p class="smd-site-empty">${escapeHtml(empty)}</p>`;
  const head = columns.map((c) => `<th scope="col">${c}</th>`).join('');
  const body = rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="smd-table-wrap"><table class="smd-site-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function tasksTable(tasks: DashboardTask[], today: string, link: PlaceHref): string {
  const rows = tasks.map((t) => {
    const anchor = headingAbove(t.doc.headings, t.line)?.slug;
    return [
      t.due ? dueCell(t.due, today) : '',
      escapeHtml(t.text),
      t.assignees.map((a) => `<span class="smd-mention">${escapeHtml(a)}</span>`).join(' '),
      escapeHtml(t.priority ?? ''),
      linked(link(t.file, anchor), where(t.doc.title, t.section)),
    ];
  });
  return table(['Due', 'Task', 'Owner', 'Priority', 'Where'], rows, 'No open tasks.');
}

function dueCell(date: string, today: string): string {
  const state = dueState(date, today);
  return `<span class="smd-due smd-due-${state}">${escapeHtml(date)}${dueNote(state)}</span>`;
}

function decisionsTable(decisions: DecisionEntry[], link: PlaceHref): string {
  const rows = decisions.map((d) => [
    escapeHtml(d.date ?? ''),
    `<span class="smd-decision-status smd-decision-${escapeHtml(d.status)}">${escapeHtml(d.status)}</span>`,
    `<span${isInactiveDecision(d.status) ? ' class="smd-site-inactive"' : ''}>${linked(link(d.path, d.anchor), d.title || 'Decision')}</span>`,
    escapeHtml(d.owner ?? ''),
    escapeHtml(where(d.document, d.section)),
  ]);
  return table(['Date', 'Status', 'Decision', 'Owner', 'Where'], rows, 'No decisions.');
}

function risksSection(risks: RiskEntry[], documents: DashboardDocument[], link: PlaceHref): string {
  if (!risks.length) return '<p class="smd-site-empty">No open risks.</p>';
  const headings = new Map(documents.map((d) => [d.source, d.headings]));
  const anchor = (r: RiskEntry) => r.id ?? headingAbove(headings.get(r.path) ?? [], r.line)?.slug;
  const matrix = riskMatrixHtml(riskMatrix(risks), risks, { href: (r) => link(r.path, anchor(r)) });
  const rows = risks.map((r) => [
    `<span class="smd-risk-score smd-risk-band-${riskBand(r.score)}">${r.score}</span>`,
    linked(link(r.path, anchor(r)), r.title || 'Risk'),
    escapeHtml(r.impact),
    escapeHtml(r.likelihood),
    escapeHtml(r.owner ?? ''),
    `<span class="smd-risk-status">${escapeHtml(r.status)}</span>`,
    escapeHtml(r.summary),
  ]);
  return `<div class="smd-risk-matrix">${matrix}</div>`
    + table(['Score', 'Risk', 'Impact', 'Likelihood', 'Owner', 'Status', 'Mitigation'], rows, '');
}
