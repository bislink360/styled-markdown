import { agentView, sectionCosts, type SectionCost } from './agentView';
import { asStringList, parseFrontMatter } from './frontmatter';
import { getDocumentInfo, type SmdDocumentInfo } from './meta';
import { SMD_VERSION } from './spec';

/**
 * Document catalog (`smd index`): one JSON entry per document with its metadata, token costs,
 * sections and the counts an agent needs to decide which documents to read, before reading any.
 * The output is deterministic (no timestamps, entries sorted by path) so it can be committed and diffed.
 */

/** Identifies the catalog format; `version` changes only when the shape changes incompatibly. */
export const INDEX_FORMAT = 'smd-index';
export const INDEX_VERSION = 1;

export interface IndexOptions {
  /** YYYY-MM-DD used for overdue tasks; defaults to the current date. */
  today?: string;
}

export interface SmdIndexSection {
  level: number;
  text: string;
  /** Heading id, usable with `smd agent --section`. */
  id: string;
  /** Zero-based first and last line (the section runs to the next heading of the same or a higher level). */
  line: number;
  endLine: number;
  /** Approximate tokens of reading the section (subsections included) through the agent view. */
  tokens: number;
  /** `skip` when the heading is marked {agent=skip}. */
  agent?: string;
}

export interface SmdIndexCounts {
  openTasks: number;
  doneTasks: number;
  /** Open tasks whose due date has passed. */
  overdueTasks: number;
  /** Decisions by status (a decision without one is `proposed`). */
  decisions: Record<string, number>;
  risks: number;
  /** Risks whose status is not `mitigated` or `closed`. */
  openRisks: number;
  /** `:::question` blocks. */
  questions: number;
  /** `:::api` endpoints. */
  apis: number;
  diagrams: number;
  /** `:::agent` instruction blocks. */
  agentInstructions: number;
}

export interface SmdIndexEntry {
  /** As given, normally relative to the working directory with forward slashes. */
  path: string;
  /** Front matter `title`, else the first `#` heading, else the file name. */
  title: string;
  summary: string | null;
  status: string | null;
  owners: string[];
  tags: string[];
  audience: string | null;
  updated: string | null;
  related: string[];
  /** Approximate tokens of the raw file and of its full agent view (`smd agent`). */
  tokens: { file: number; agent: number };
  counts: SmdIndexCounts;
  sections: SmdIndexSection[];
}

export interface SmdIndex {
  format: typeof INDEX_FORMAT;
  version: number;
  /** Styled Markdown spec version. */
  smd: number;
  /** The tool that wrote the catalog, e.g. `smd 1.3.0`, when known. */
  generator?: string;
  documents: SmdIndexEntry[];
}

const CLOSED_RISK = new Set(['mitigated', 'closed']);

/** The catalog entry of one document. */
export function indexEntry(text: string, path: string, options: IndexOptions = {}): SmdIndexEntry {
  const data = parseFrontMatter(text).data;
  const info = getDocumentInfo(text, { today: options.today });
  const view = agentView(text, { today: options.today });
  return {
    path,
    title: info.title ?? fileName(path),
    summary: info.summary,
    status: scalar(data.status),
    owners: asStringList(data.owners),
    tags: asStringList(data.tags),
    audience: scalar(data.audience),
    updated: scalar(data.updated),
    related: asStringList(data.related),
    tokens: { file: view.originalTokens, agent: view.tokens },
    counts: countsOf(info),
    sections: sectionCosts(text, { today: options.today }).map(indexSection),
  };
}

/** A catalog of several documents, sorted by path (a path given twice is listed once). */
export function smdIndex(documents: Array<{ path: string; text: string }>, options: IndexOptions & { generator?: string } = {}): SmdIndex {
  const sorted = [...new Map(documents.map((d) => [d.path, d.text]))].sort(([a], [b]) => comparePaths(a, b));
  return {
    format: INDEX_FORMAT,
    version: INDEX_VERSION,
    smd: SMD_VERSION,
    ...(options.generator ? { generator: options.generator } : {}),
    documents: sorted.map(([path, text]) => indexEntry(text, path, options)),
  };
}

function countsOf(info: SmdDocumentInfo): SmdIndexCounts {
  const open = info.tasks.open;
  return {
    openTasks: open.length,
    doneTasks: info.tasks.done,
    overdueTasks: open.filter((t) => t.overdue).length,
    decisions: tally(info.decisions.map((d) => d.status.toLowerCase())),
    risks: info.risks.length,
    openRisks: info.risks.filter((r) => !CLOSED_RISK.has((r.status ?? '').toLowerCase())).length,
    questions: info.containers.question ?? 0,
    apis: info.containers.api ?? 0,
    diagrams: info.diagrams.length,
    agentInstructions: info.agentBlocks.length,
  };
}

function indexSection(s: SectionCost): SmdIndexSection {
  const h = s.heading;
  return { level: h.level, text: h.text, id: h.slug, line: s.start, endLine: s.end, tokens: s.tokens, ...(h.agent ? { agent: h.agent } : {}) };
}

/** How often each value occurs, keys sorted so the output is stable. */
function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of [...values].sort()) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

/** A front matter string, number or boolean as text; null when missing or not a scalar. */
function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
}

function fileName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.smd$/i, '');
}

/** Byte-order comparison, so the order doesn't depend on the locale. */
function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
