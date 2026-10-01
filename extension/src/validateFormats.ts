import type { Diagnostic, Severity } from './core';

/** `smd validate` output for CI: GitHub Actions workflow commands (`--format github`) and a Markdown job summary (`--summary`). */

/** One checked file. `file` is already relative to the repository root, with forward slashes. */
export interface FileReport { file: string; diagnostics: Diagnostic[]; fixed?: number }

/** A problem with a rule config file (smd.config.json / .smdrc); reported as a warning. */
export interface ConfigProblem { file: string; message: string }

export interface ValidationResult { files: FileReport[]; configProblems: ConfigProblem[] }

/** Workflow command per severity. Hints are left out: GitHub shows few annotations per step, so they go to the real problems. */
const COMMANDS: Partial<Record<Severity, string>> = { error: 'error', warning: 'warning', info: 'notice' };

/** Escape a workflow command message: `%`, CR and LF. */
export function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape a workflow command property value: as a message, plus `:` and `,`. */
export function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function command(name: string, props: Array<[string, string | number]>, message: string): string {
  const list = props.map(([key, value]) => `${key}=${escapeProperty(String(value))}`).join(',');
  return `::${name} ${list}::${escapeData(message)}`;
}

/**
 * `::error file=docs/a.smd,line=3,col=5,endColumn=9,title=smd link/missing-file::message`. Positions are 1-based;
 * `endColumn` is inclusive, so it equals the diagnostic's zero-based exclusive end. Undefined for hints.
 */
export function githubAnnotation(file: string, d: Diagnostic): string | undefined {
  const name = COMMANDS[d.severity];
  if (!name) return undefined;
  const col = d.column + 1;
  const props: Array<[string, string | number]> = [
    ['file', file], ['line', d.line + 1], ['col', col], ['endColumn', Math.max(d.endColumn, col)], ['title', `smd ${d.code}`],
  ];
  return command(name, props, d.message);
}

/** All annotations for a validation run, config problems first, one line each. */
export function githubAnnotations(result: ValidationResult): string[] {
  const lines = result.configProblems.map((p) => command('warning', [['file', p.file], ['title', 'smd config']], p.message));
  for (const r of result.files) {
    for (const d of r.diagnostics) {
      const line = githubAnnotation(r.file, d);
      if (line) lines.push(line);
    }
  }
  return lines;
}

export interface SummaryOptions {
  /** Most problems listed in the table (default 50); the rest are counted. */
  limit?: number;
  /** Link prefix for `file#Lline` links, e.g. `https://github.com/owner/repo/blob/<sha>/`. Plain `file:line` without it. */
  linkBase?: string;
}

const SEVERITY_ORDER: Severity[] = ['error', 'warning', 'info', 'hint'];
const SEVERITY_LABELS: Record<Severity, string> = { error: 'Errors', warning: 'Warnings', info: 'Notices', hint: 'Hints' };

interface Row { file: string; d: Diagnostic }

/** A Markdown job summary: counts per severity and a table of the first problems (hints left out), errors first. */
export function validationSummary(result: ValidationResult, options: SummaryOptions = {}): string {
  const rows = result.files.flatMap((r) => r.diagnostics.map((d) => ({ file: r.file, d })));
  const out = ['## smd validate', '', countsLine(result, rows), ''];
  const listed = rows.filter((r) => COMMANDS[r.d.severity])
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.d.severity) - SEVERITY_ORDER.indexOf(b.d.severity));
  if (!listed.length && !result.configProblems.length) return out.join('\n');
  out.push('| Severity | Count |', '|---|---:|');
  for (const severity of SEVERITY_ORDER) out.push(`| ${SEVERITY_LABELS[severity]} | ${countOf(rows, severity, result)} |`);
  out.push('');
  if (listed.length) out.push(...problemTable(listed, options), '');
  for (const p of result.configProblems) out.push(`- Config \`${p.file}\`: ${cell(p.message)}`);
  if (result.configProblems.length) out.push('');
  return out.join('\n');
}

function countOf(rows: Row[], severity: Severity, result: ValidationResult): number {
  const extra = severity === 'warning' ? result.configProblems.length : 0;
  return rows.filter((r) => r.d.severity === severity).length + extra;
}

function countsLine(result: ValidationResult, rows: Row[]): string {
  const files = `${result.files.length} file(s) checked`;
  const errors = countOf(rows, 'error', result);
  const warnings = countOf(rows, 'warning', result);
  if (!errors && !warnings) return `${files}: no errors or warnings.`;
  return `${files}: **${errors} error(s)**, **${warnings} warning(s)**.`;
}

function problemTable(rows: Row[], options: SummaryOptions): string[] {
  const limit = options.limit ?? 50;
  const out = ['| Severity | Location | Rule | Message |', '|---|---|---|---|'];
  for (const { file, d } of rows.slice(0, limit)) {
    out.push(`| ${d.severity} | ${location(file, d.line + 1, options.linkBase)} | \`${d.code}\` | ${cell(d.message)} |`);
  }
  if (rows.length > limit) out.push('', `…and ${rows.length - limit} more. Run \`smd validate\` locally for the full list.`);
  return out;
}

function location(file: string, line: number, linkBase?: string): string {
  const label = `${cell(file)}:${line}`;
  if (!linkBase) return label;
  const href = file.split('/').map(encodeURIComponent).join('/');
  return `[${label}](${linkBase}${href}#L${line})`;
}

/** Text that is safe inside a Markdown table cell: one line, `|` and HTML escaped. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, String.raw`\|`);
}

/** `https://github.com/owner/repo/blob/<sha>/` from the GitHub Actions environment, for summary links; undefined elsewhere. */
export function blobBase(env: Record<string, string | undefined>): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = env;
  if (!server || !repo || !sha) return undefined;
  return `${server}/${repo}/blob/${sha}/`;
}
