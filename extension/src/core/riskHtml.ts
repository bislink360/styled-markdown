import { escapeHtml } from './attrs';
import { EN, label, messagesFor, term, type Messages } from './i18n';
import { riskMatrix, riskRegister, type RiskEntry, type RiskMatrix, type RiskRegister } from './risks';
import { RISK_LEVELS } from './spec';

/**
 * HTML for risks: the impact × likelihood matrix (`smd risks --html` and `:::risk-matrix`) and the register
 * table. Cells are coloured by score band with the theme's named colours, so both light and dark themes work.
 * All document text is escaped.
 */

export type RiskBand = 'low' | 'moderate' | 'high' | 'severe';

/** Score bands: 1–2 low, 3–4 moderate, 6–8 high, 9–16 severe. */
export function riskBand(score: number): RiskBand {
  if (score >= 9) return 'severe';
  if (score >= 6) return 'high';
  if (score >= 3) return 'moderate';
  return 'low';
}

export interface RiskMatrixHtmlOptions {
  /** Where a risk links to (e.g. `#risk-3`); undefined for plain text. */
  href?: (risk: RiskEntry) => string | undefined;
  /** The language of the headers and cell titles, a BCP 47 tag such as `de` (default English). */
  lang?: string;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The matrix as a table: impact rows (critical first) × likelihood columns, each cell listing its risks. */
export function riskMatrixHtml(matrix: RiskMatrix, risks: RiskEntry[], options: RiskMatrixHtmlOptions = {}): string {
  return riskMatrixTable(matrix, risks, options, messagesFor(options.lang));
}

/** riskMatrixHtml with the labels given. */
export function riskMatrixTable(matrix: RiskMatrix, risks: RiskEntry[], options: RiskMatrixHtmlOptions, m: Messages): string {
  const head = matrix.likelihood.map((l) => `<th scope="col">${escapeHtml(capital(term(m, 'likelihood', l)))}</th>`).join('');
  const rows = matrix.impact.map((impact) => {
    const cells = matrix.likelihood.map((likelihood) => {
      const inCell = risks.filter((r) => r.impact === impact && r.likelihood === likelihood);
      return matrixCell({ impact, likelihood }, inCell, options, m);
    });
    return `<tr><th scope="row">${escapeHtml(capital(term(m, 'impact', impact)))}</th>${cells.join('')}</tr>`;
  });
  return '<div class="smd-risk-matrix-wrap"><table class="smd-risk-matrix-grid">'
    + `<thead><tr><th class="smd-risk-matrix-corner" scope="col">${m['riskMatrix.corner']}</th>${head}</tr></thead>`
    + `<tbody>${rows.join('')}</tbody></table></div>`;
}

interface MatrixCellPlace { impact: string; likelihood: string }

function matrixCell({ impact, likelihood }: MatrixCellPlace, risks: RiskEntry[], options: RiskMatrixHtmlOptions, m: Messages): string {
  const score = cellScore(impact, likelihood);
  const title = capital(label(m, 'riskMatrix.cell', {
    impact: term(m, 'impact', impact), likelihood: term(m, 'likelihood', likelihood), count: risks.length,
  }));
  const items = risks.map((r) => `<li>${riskLink(r, options, m)}</li>`).join('');
  const list = items ? `<ul class="smd-risk-cell-list">${items}</ul>` : '';
  const count = risks.length ? `<span class="smd-risk-cell-count">${risks.length}</span>` : '';
  const empty = risks.length ? '' : ' smd-risk-cell-empty';
  return `<td class="smd-risk-cell smd-risk-band-${riskBand(score)}${empty}" data-score="${score}" title="${escapeHtml(title)}">${count}${list}</td>`;
}

function riskLink(r: RiskEntry, options: RiskMatrixHtmlOptions, m: Messages): string {
  const title = escapeHtml(r.title || m['risk.title']);
  const href = options.href?.(r);
  return href ? `<a href="${escapeHtml(href)}">${title}</a>` : `<span>${title}</span>`;
}



function cellScore(impact: string, likelihood: string): number {
  return (RISK_LEVELS.indexOf(impact) + 1) * (RISK_LEVELS.indexOf(likelihood) + 1);
}

/** Row anchor of the n-th risk (zero-based) in the register table. */
export const riskAnchor = (n: number) => `risk-${n + 1}`;

/** The register page body: heading, summary, matrix, then the table. */
export function riskRegisterHtml(register: RiskRegister, title = 'Risk register'): string {
  const index = new Map(register.risks.map((r, i) => [r, riskAnchor(i)]));
  const matrix = riskMatrixHtml(register.matrix, register.risks, { href: (r) => `#${index.get(r)}` });
  const summary = `${register.risks.length} risk(s) in ${register.documentsWithRisks} of ${register.documents} document(s). `
    + 'Score = impact × likelihood (low 1, medium 2, high 3, critical 4); a level marked ? was not set and counts as medium.';
  const body = register.risks.length ? `${matrix}${riskTableHtml(register.risks)}` : '<p>No risks found.</p>';
  return `<article class="smd-doc smd-risk-register"><h1 id="risk-register">${escapeHtml(title)}</h1>`
    + `<p class="smd-risk-register-summary">${escapeHtml(summary)}</p>`
    + `<div class="smd-risk-matrix">${body}</div></article>`;
}

const COLUMNS = ['#', 'Score', 'Risk', 'Impact', 'Likelihood', 'Owner', 'Status', 'Where', 'Mitigation'];

function riskTableHtml(risks: RiskEntry[]): string {
  const head = COLUMNS.map((c) => `<th scope="col">${c}</th>`).join('');
  const rows = risks.map((r, i) => riskRowHtml(r, i)).join('');
  return `<div class="smd-table-wrap"><table class="smd-risk-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function riskRowHtml(r: RiskEntry, i: number): string {
  const level = (key: 'impact' | 'likelihood') => escapeHtml(r.defaulted.includes(key) ? `${r[key]}?` : r[key]);
  const where = `<code>${escapeHtml(r.path + ':' + (r.line + 1))}</code>`
    + (r.section ? `<div class="smd-risk-where">${escapeHtml(r.section)}</div>` : '');
  const cells = [
    String(i + 1),
    `<span class="smd-risk-score smd-risk-band-${riskBand(r.score)}">${r.score}</span>`,
    `<strong>${escapeHtml(r.title || 'Risk')}</strong>`,
    level('impact'),
    level('likelihood'),
    escapeHtml(r.owner ?? ''),
    `<span class="smd-risk-status">${escapeHtml(r.status)}</span>`,
    where,
    escapeHtml(r.summary),
  ];
  return `<tr id="${riskAnchor(i)}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
}

/**
 * The matrix of one document's risks for `:::risk-matrix` (closed ones left out); risks with an `{#id}` link to it.
 * `m` gives the labels in the document's language.
 */
export function documentRiskMatrixHtml(text: string, m: Messages = EN): string {
  const risks = riskRegister([{ path: '', text }]).risks;
  return riskMatrixTable(riskMatrix(risks), risks, { href: (r) => (r.id ? `#${r.id}` : undefined) }, m);
}
