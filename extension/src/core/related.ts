import { agentView } from './agentView';
import { parseFrontMatter } from './frontmatter';
import { splitTarget } from './links';
import { parseSmd } from './parse';

/**
 * Documents listed in front matter `related:`, summarized so an agent can decide whether to open them:
 * title, status, summary and the cost of the full agent view. Only one level deep, so cycles can't occur.
 */
export interface RelatedDoc {
  /** The entry as written in `related:`. */
  target: string;
  /** Local path without `#anchor` or `?query` (undefined for URLs). */
  path?: string;
  /** `read`: an .smd file that was read; `url`, `not-smd` and `missing` were not read. */
  state: 'read' | 'url' | 'not-smd' | 'missing';
  title?: string;
  status?: string;
  summary?: string;
  /** Approximate tokens of the document's full agent view. */
  tokens?: number;
}

export interface RelatedOptions {
  /** Reads a path relative to the document; undefined when missing or not allowed. */
  readFile?: (relativePath: string) => string | undefined;
  today?: string;
}

export interface SmdSummary {
  title: string;
  status?: string;
  summary?: string;
  tokens: number;
}

/** Front matter `related:` entries (one string or a list of strings), in order, without duplicates. */
export function relatedEntries(text: string): string[] {
  const related = parseFrontMatter(text).data.related;
  const list: unknown[] = Array.isArray(related) ? related : [related];
  const entries = list.filter((r): r is string => typeof r === 'string').map((r) => r.trim()).filter(Boolean);
  return [...new Set(entries)];
}

export function relatedDocs(text: string, options: RelatedOptions = {}): RelatedDoc[] {
  return relatedEntries(text).map((target) => describeRelated(target, options));
}

function describeRelated(target: string, options: RelatedOptions): RelatedDoc {
  const split = splitTarget(target);
  if (!split) return { target, state: 'url' };
  const base = { target, path: split.path };
  if (!/\.smd$/i.test(split.path)) return { ...base, state: 'not-smd' };
  const text = options.readFile?.(split.path);
  if (text === undefined) return { ...base, state: 'missing' };
  return { ...base, state: 'read', ...summarizeSmd(text, options.today) };
}

/** Title, status, summary and full agent-view cost of an .smd document. */
export function summarizeSmd(text: string, today?: string): SmdSummary {
  const data = parseFrontMatter(text).data;
  const title = oneLine(data.title) ?? parseSmd(text).headings.find((h) => h.level === 1)?.text ?? '(untitled)';
  const status = oneLine(data.status);
  const summary = oneLine(data.summary);
  return { title, ...(status ? { status } : {}), ...(summary ? { summary } : {}), tokens: agentView(text, { today }).tokens };
}

function oneLine(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : undefined;
}

const NOT_READ: Record<Exclude<RelatedDoc['state'], 'read'>, string> = {
  url: 'URL, not read',
  'not-smd': 'not an .smd file, not read',
  missing: 'not found, or outside the project',
};

/**
 * The block `smd outline --related` appends:
 *
 *   Related documents:
 *     docs/adr-0007.smd  Use an event bus · accepted · agent view ≈640 tokens
 *       summary: …
 *     https://example.com/spec  (URL, not read)
 *
 * Empty when there are none.
 */
export function formatRelated(docs: RelatedDoc[]): string {
  if (!docs.length) return '';
  const out = ['Related documents:', ...docs.flatMap(relatedLines)];
  out.push('', 'Open one only if the task needs it: smd outline <path>, then smd agent <path> [--section "<heading>"]');
  return out.join('\n') + '\n';
}

function relatedLines(doc: RelatedDoc): string[] {
  const where = doc.path ?? doc.target;
  if (doc.state !== 'read') return [`  ${where}  (${NOT_READ[doc.state]})`];
  const cost = `agent view ≈${doc.tokens ?? 0} tokens`;
  const lines = [`  ${where}  ${[doc.title, doc.status, cost].filter(Boolean).join(' · ')}`];
  if (doc.summary) lines.push(`    summary: ${doc.summary}`);
  return lines;
}
