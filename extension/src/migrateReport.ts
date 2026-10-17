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

function stepReport(step: MigrationStep): string {
  const lines = step.endLine > step.line ? `lines ${step.line + 1}-${step.endLine + 1}` : `line ${step.line + 1}`;
  if (step.note) return `    ${lines}, note: ${step.reason}\n`;
  const reason = step.reason === migrationKind(step.kind).reason ? '' : `: ${step.reason}`;
  const removed = step.before ? step.before.split('\n').map((l) => `      - ${cut(l)}\n`).join('') : '';
  const added = step.after ? step.after.split('\n').map((l) => `      + ${cut(l)}\n`).join('') : '';
  return `    ${lines}${step.before ? '' : ' (inserted before it)'}${reason}\n${removed}${added}`;
}

/** The last lines: how many files need migrating, and that nothing was written. */
export function migrationSummary(plans: MigrationPlan[]): string {
  const counts = plans.map(planCounts);
  const need = counts.filter((c) => c.changes > 0).length;
  const changes = counts.reduce((n, c) => n + c.changes, 0);
  const notes = counts.reduce((n, c) => n + c.notes, 0);
  return `\n${plural(plans.length, 'file')} checked: ${need} to migrate to spec v2 (${plural(changes, 'change')}, ${plural(notes, 'note')}).\n`
    + 'Dry run: nothing was written. Styled Markdown 2.0 applies the migration.\n';
}
