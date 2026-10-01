import { CONTAINER_OPEN, parseContainerInfo } from './containers';
import { querySmd, type QueryMatch } from './query';
import { RISK_LEVELS } from './spec';

/**
 * Risk register (`smd risks`): every `:::risk` block across documents, scored impact × likelihood
 * and sorted by score, with an impact × likelihood matrix of counts.
 *
 * Each level ranks 1–4 (low, medium, high, critical), so a score runs from 1 to 16. A missing or unknown
 * impact or likelihood counts as `medium` (the spec's default impact) and is listed in `defaulted`;
 * a missing status is `open`. Closed risks are left out unless `all` or `status` asks for them.
 */

export interface RiskOptions {
  /** Only risks with one of these statuses (overrides the default, which leaves out `closed`). */
  status?: string[];
  /** Only risks owned by this person or team (`@maya` or `maya`, case-insensitive). */
  owner?: string;
  /** Include closed risks. */
  all?: boolean;
}

export interface RiskEntry {
  /** The document, as given. */
  path: string;
  /** Zero-based line of the `:::risk` opening fence. */
  line: number;
  title: string;
  /** Explicit `{#id}` of the block, when given. */
  id?: string;
  impact: string;
  likelihood: string;
  /** Impact rank × likelihood rank, 1–16. */
  score: number;
  owner: string | null;
  status: string;
  /** The nearest heading above the block. */
  section: string | null;
  /** One line from the body: a `Mitigation:` line when there is one, else its first sentence. */
  summary: string;
  /** Attributes that were missing or unknown and took their default (`impact`, `likelihood`). */
  defaulted: string[];
}

/** Counts per cell: `counts[row][column]`, rows by impact (critical first), columns by likelihood (low first). */
export interface RiskMatrix {
  impact: string[];
  likelihood: string[];
  counts: number[][];
}

export interface RiskRegister {
  risks: RiskEntry[];
  matrix: RiskMatrix;
  /** Documents read, and how many of them have a listed risk. */
  documents: number;
  documentsWithRisks: number;
}

const DEFAULT_LEVEL = 'medium';
const SUMMARY_MAX = 160;

/** Risks of several documents, filtered and sorted by score. */
export function riskRegister(documents: Array<{ path: string; text: string }>, options: RiskOptions = {}): RiskRegister {
  const all = documents.flatMap((d) => documentRisks(d.text, d.path));
  const risks = all.filter((r) => keepRisk(r, options)).sort(compareRisks);
  return {
    risks,
    matrix: riskMatrix(risks),
    documents: documents.length,
    documentsWithRisks: new Set(risks.map((r) => r.path)).size,
  };
}

/** Every risk of one document, in document order and unfiltered. */
export function documentRisks(text: string, path = ''): RiskEntry[] {
  const lines = text.split(/\r?\n/);
  return querySmd(text, 'risk', { brief: true, lineRefs: false }).map((m) => riskEntry(m, writtenAttrs(lines[m.line]), path));
}

/** The attributes as written on the opening line (querySmd adds the spec's default impact). */
function writtenAttrs(line: string): Record<string, string> {
  const open = CONTAINER_OPEN.exec(line);
  return (open && parseContainerInfo(open[3] + open[4])?.attrs.values) || {};
}

function riskEntry(m: QueryMatch, written: Record<string, string>, path: string): RiskEntry {
  const defaulted = LEVEL_KEYS.filter((key) => !RISK_LEVELS.includes(lower(written[key])));
  const level = (key: string) => (defaulted.includes(key) ? DEFAULT_LEVEL : lower(written[key]));
  const impact = level('impact');
  const likelihood = level('likelihood');
  return {
    path,
    line: m.line,
    title: m.title,
    ...(typeof m.attrs.id === 'string' ? { id: m.attrs.id } : {}),
    impact,
    likelihood,
    score: riskScore(impact, likelihood),
    owner: written.owner?.trim() || null,
    status: lower(written.status) || 'open',
    section: m.section,
    summary: riskSummary(m.text),
    defaulted,
  };
}

const LEVEL_KEYS = ['impact', 'likelihood'];
const lower = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/** Impact rank × likelihood rank (1–4 each); unknown levels rank as `medium`. */
export function riskScore(impact: string, likelihood: string): number {
  return levelRank(impact) * levelRank(likelihood);
}

function levelRank(level: string): number {
  const i = RISK_LEVELS.indexOf(level.toLowerCase());
  return (i < 0 ? RISK_LEVELS.indexOf(DEFAULT_LEVEL) : i) + 1;
}

function keepRisk(r: RiskEntry, options: RiskOptions): boolean {
  if (options.owner && !ownedBy(r, options.owner)) return false;
  if (options.status?.length) return options.status.some((s) => s.toLowerCase() === r.status);
  return options.all === true || r.status !== 'closed';
}

const bare = (s: string) => s.trim().toLowerCase().replace(/^@/, '');

function ownedBy(r: RiskEntry, owner: string): boolean {
  return (r.owner ?? '').split(/[\s,]+/).some((o) => o && bare(o) === bare(owner));
}

/** Score, then impact, both highest first; then path and line. */
export function compareRisks(a: RiskEntry, b: RiskEntry): number {
  return b.score - a.score || levelRank(b.impact) - levelRank(a.impact) || compareText(a.path, b.path) || a.line - b.line;
}

/** Byte-order comparison, so the order doesn't depend on the locale. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Impact × likelihood counts of the risks given. */
export function riskMatrix(risks: RiskEntry[]): RiskMatrix {
  const impact = [...RISK_LEVELS].reverse();
  const likelihood = [...RISK_LEVELS];
  const counts = impact.map((i) => likelihood.map((l) => risks.filter((r) => r.impact === i && r.likelihood === l).length));
  return { impact, likelihood, counts };
}

/** The body line that best summarizes the risk, from its agent view (`<risk …>` … `</risk>`). */
export function riskSummary(agentText: string): string {
  const body = agentText.split('\n').slice(1, -1).map(plainLine).filter(Boolean);
  const mitigation = body.find((l) => /^mitigat\w*\s*:/i.test(l));
  return clip(mitigation ?? firstSentence(body[0] ?? ''));
}

/** A body line without list markers and emphasis; empty for tags, pointers and blank lines. */
function plainLine(line: string): string {
  const text = line.trim();
  if (/^<\/?[a-z][\w-]*(?:\s[^>]*)?>/i.test(text) || /^\[[a-z]+: /.test(text)) return '';
  return text.replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(/^>\s*/, '').replaceAll('**', '').trim();
}

function firstSentence(line: string): string {
  const end = /[.!?](?=\s|$)/.exec(line);
  return end ? line.slice(0, end.index + 1) : line;
}

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX - 1).trimEnd() + '…' : text;
}


// ---------------------------------------------------------------------------
// Text output
// ---------------------------------------------------------------------------

/** `docs/plan.smd:12  [9] high×medium  Title  @ops  open  — Section  → Mitigation summary` */
export function riskLine(r: RiskEntry): string {
  const parts = [
    `${r.path}:${r.line + 1}`,
    `[${r.score}] ${levelLabel(r, 'impact')}×${levelLabel(r, 'likelihood')}`,
    r.title || 'Risk',
    r.owner ?? '',
    r.status,
    r.section ? `— ${r.section}` : '',
    r.summary ? `→ ${r.summary}` : '',
  ];
  return parts.filter(Boolean).join('  ');
}

/** A level, with `?` when it wasn't written and took the default. */
function levelLabel(r: RiskEntry, key: 'impact' | 'likelihood'): string {
  return r.defaulted.includes(key) ? `${r[key]}?` : r[key];
}

/** The matrix as aligned text: impact rows (critical first) × likelihood columns, `·` for none. */
export function riskMatrixText(matrix: RiskMatrix): string {
  const corner = 'impact ↓ likelihood →';
  const width = Math.max(...matrix.likelihood.map((l) => l.length));
  const cell = (s: string) => s.padStart(width);
  const head = [corner, ...matrix.likelihood.map(cell)].join('  ');
  const rows = matrix.impact.map((impact, i) => {
    const counts = matrix.counts[i].map((n) => cell(n ? String(n) : '·'));
    return [impact.padEnd(corner.length), ...counts].join('  ');
  });
  return [head, ...rows].join('\n') + '\n';
}

/** The register as text: one line per risk, a blank line, then the matrix. Empty when there are no risks. */
export function riskRegisterText(register: RiskRegister): string {
  if (!register.risks.length) return '';
  return register.risks.map(riskLine).join('\n') + '\n\n' + riskMatrixText(register.matrix);
}

/** `5 risk(s) in 3 of 7 file(s), closed ones left out (--all includes them).` */
export function riskRegisterSummary(register: RiskRegister, options: RiskOptions = {}): string {
  const count = `${register.risks.length} risk(s) in ${register.documentsWithRisks} of ${register.documents} file(s)`;
  const filtered = options.status?.length || options.all;
  return filtered ? `${count}.` : `${count}, closed ones left out (--all includes them).`;
}

/** `:::risk-matrix` in plain Markdown: a bold label and a table of one document's risks (closed ones left out). */
export function riskMatrixMarkdown(text: string, title = ''): string[] {
  const risks = riskRegister([{ path: '', text }]).risks;
  const matrix = riskMatrix(risks);
  const label = title ? `**Risk matrix: ${title}**` : '**Risk matrix**';
  const head = `| Impact ↓ / Likelihood → | ${matrix.likelihood.map(capital).join(' | ')} |`;
  const rule = `| --- |${' --- |'.repeat(matrix.likelihood.length)}`;
  const rows = matrix.impact.map((impact) => {
    const cells = matrix.likelihood.map((likelihood) => markdownCell(risks, impact, likelihood));
    return `| **${capital(impact)}** | ${cells.join(' | ')} |`;
  });
  return [label, '', head, rule, ...rows, ''];
}

function markdownCell(risks: RiskEntry[], impact: string, likelihood: string): string {
  const titles = risks.filter((r) => r.impact === impact && r.likelihood === likelihood).map((r) => r.title.replaceAll('|', String.raw`\|`));
  return titles.join('<br>');
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
