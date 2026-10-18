import { KIND_ORDER, migrationKind, type MigrationKind, type MigrationPlan, type MigrationStep } from './core/migrate';

/** The readable dry-run report of `smd migrate --to 2` and of the editor command "Preview Migration to Spec v2". */

const TITLES: Record<MigrationKind, string> = {
  closer: 'Closing fences',
  'duplicate-attrs': 'Duplicate attributes',
  'title-text': 'Container title text that is not shown',
  'agent-priority': 'Priority on agent blocks',
  'math-delimiters': '$$ delimiters',
  'heading-braces': 'Braces after headings',
  'attr-escapes': 'Backslashes in attribute values',
  'unknown-directive': 'Unknown inline directives',
  'include-section': 'Include sections',
  'value-case': 'Enumerated values',
  typography: 'Typography',
  'fuzzy-link': 'Bare domain links',
  'variable-spelling': 'Front matter values',
  version: 'Spec version',
};

/** Longest line of a short diff; longer ones are cut with "…". */
const WIDTH = 100;

const cut = (s: string) => (s.length > WIDTH ? `${s.slice(0, WIDTH - 1)}…` : s);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Changes and notes in a plan. */
export function planCounts(plan: MigrationPlan): { changes: number; notes: number } {
  const notes = plan.steps.filter((s) => s.note).length;
  return { changes: plan.steps.length - notes, notes };
}

/** One file's report: a heading line, then the steps grouped by kind, with 1-based lines and short diffs. */
export function migrationReport(file: string, plan: MigrationPlan): string {
  const { changes, notes } = planCounts(plan);
  if (!plan.steps.length) {
    const why = plan.from >= 2 ? `already spec v2 (smd: ${plan.from})` : 'nothing to migrate';
    return `${file}: ${why}\n`;
  }
  const head = `${file}: ${plural(changes, 'change')} and ${plural(notes, 'note')} to migrate from smd: ${plan.from} to spec v2\n`;
  return head + KIND_ORDER.map((kind) => kindReport(kind, plan.steps.filter((s) => s.kind === kind))).join('');
}

function kindReport(kind: MigrationKind, steps: MigrationStep[]): string {
  if (!steps.length) return '';
  const { proposal, keeps, reason } = migrationKind(kind);
  const source = proposal === 'versioning' ? 'RFC versioning rules' : `proposal ${proposal}`;
  const kept = keeps === 'v1' ? 'v1 rendering kept' : 'v2 meaning kept';
  const changes = steps.some((s) => !s.note) ? `\n    ${reason}` : '';
  return `\n  ${TITLES[kind]} (${source}; ${kept}):${changes}\n${steps.map(stepReport).join('')}`;
}

/** `line 3` or `lines 3-5`, 1-based. */
const linesOf = (step: MigrationStep) => (step.endLine > step.line ? `lines ${step.line + 1}-${step.endLine + 1}` : `line ${step.line + 1}`);

function stepReport(step: MigrationStep): string {
  const lines = linesOf(step);
  if (step.note) return `    ${lines}, note: ${step.reason}\n`;
  const reason = step.reason === migrationKind(step.kind).reason ? '' : `: ${step.reason}`;
  const removed = step.before ? step.before.split('\n').map((l) => `      - ${cut(l)}\n`).join('') : '';
  const added = step.after ? step.after.split('\n').map((l) => `      + ${cut(l)}\n`).join('') : '';
  return `    ${lines}${step.before ? '' : ' (inserted before it)'}${reason}\n${removed}${added}`;
}

/** What `smd migrate --to 2 --dry-run` says after its summary: how to apply the plan. */
export const DRY_RUN_NEXT = 'Dry run: nothing was written. Run it without --dry-run to migrate.';

/** The last lines: how many files need migrating, and that nothing was written (`next`: how to apply the plan). */
export function migrationSummary(plans: MigrationPlan[], next = DRY_RUN_NEXT): string {
  const counts = plans.map(planCounts);
  const need = counts.filter((c) => c.changes > 0).length;
  const changes = counts.reduce((n, c) => n + c.changes, 0);
  const notes = counts.reduce((n, c) => n + c.notes, 0);
  return `\n${plural(plans.length, 'file')} checked: ${need} to migrate to spec v2 (${plural(changes, 'change')}, ${plural(notes, 'note')}).\n${next}\n`;
}

/** The plan's notes, which a migration leaves to the author, one per line with its 1-based lines ("" without any). */
export function migrationNotes(plan: MigrationPlan): string {
  return plan.steps.filter((s) => s.note).map((s) => `  ${linesOf(s)}, note: ${TITLES[s.kind]}: ${s.reason}\n`).join('');
}

/** One replacement that turns a document into its migrated text: offsets into the document, and the new text. */
export interface MigrationEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * The edit that applies `plan` to `text` (the text it was planned from), for an editor: the lines from the first that
 * changes to the last, so that undoing it is one step and the rest of the document, and the cursor there, stay put.
 * Undefined when the plan changes nothing. The edit starts and ends at line boundaries, so it never splits a CRLF.
 */
export function migrationEdit(text: string, plan: MigrationPlan): MigrationEdit | undefined {
  const next = plan.result;
  if (next === text || !planCounts(plan).changes) return undefined;
  const shorter = Math.min(text.length, next.length);
  let start = 0;
  while (start < shorter && text[start] === next[start]) start++;
  if (start > 0) start = text.lastIndexOf('\n', start - 1) + 1;
  let tail = 0;
  while (tail < shorter - start && text[text.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  // The kept end starts a line in both texts: after a "\n", or at the end.
  while (tail > 0 && (text[text.length - tail - 1] !== '\n' || next[next.length - tail - 1] !== '\n')) tail--;
  return { start, end: text.length - tail, text: next.slice(start, next.length - tail) };
}
