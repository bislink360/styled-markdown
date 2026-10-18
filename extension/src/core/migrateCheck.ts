import { migrationPlan, type MigrationKind, type MigrationOptions, type MigrationPlan, type MigrationStep } from './migrate';
import { renderSmd } from './render';

/**
 * The check `smd migrate --to 2` runs on each file it writes (its `--verify`, on by default): the written document
 * has nothing left to migrate, and spec v2 renders it as v1 rendered the original. Pure, like the plan: files are
 * read only through `options.readFile`.
 *
 * Internal, as the plan is: not exported from the npm package.
 */

export interface MigrationCheck {
  /** Changes a new plan of the written document still makes (planned with `force`, as it says `smd: 2`): none expected. */
  left: MigrationStep[];
  /**
   * `same`: spec v2 renders the written document as v1 rendered the original. `explained`: it renders differently, and
   * the plan has notes or steps that keep the v2 meaning, which say where (typography left off, a value shown as
   * written, …). `differs`: it renders differently and nothing in the plan says why.
   */
  rendering: 'same' | 'explained' | 'differs';
  /** For `explained`: the kinds of the notes and v2-meaning steps, in the order the steps run. */
  explainedBy: MigrationKind[];
}

/** A fixed date, so that "overdue" and "stale" read the same in both renders whatever the day. */
const TODAY = '2000-01-01';

/**
 * Rendered HTML without what moves with the source lines (`data-line`, `data-task-line`: the `smd: 2` line may be
 * added) or names an include's query (`data-include`: the section may be rewritten to the heading's id), and with each
 * class once: v1 writes a repeated class twice, which collapsing duplicate attributes leaves out.
 */
export function comparableHtml(html: string): string {
  return html
    .replaceAll(/ data-(?:task-)?line="\d+"/g, '')
    .replaceAll(/ data-include="[^"]*"/g, '')
    .replaceAll(/ class="([^"]*)"/g, (_, names: string) => ` class="${[...new Set(names.split(' '))].join(' ')}"`);
}

/** Each document rendered with the rules its own `smd` value selects: the original's v1, the written one's v2. */
const rendered = (text: string, options: MigrationOptions) => comparableHtml(renderSmd(text, { readFile: options.readFile, today: TODAY }).html);

/**
 * Check a written migration: `original` is the document before it, `written` the document as read back, and `plan`
 * the plan that was applied (with the same `options`).
 */
export function checkMigration(original: string, written: string, plan: MigrationPlan, options: MigrationOptions = {}): MigrationCheck {
  const left = migrationPlan(written, { ...options, force: true }).steps.filter((s) => !s.note);
  if (rendered(written, options) === rendered(original, options)) return { left, rendering: 'same', explainedBy: [] };
  const explainedBy = [...new Set(plan.steps.filter((s) => s.note || s.keeps === 'v2').map((s) => s.kind))];
  return { left, rendering: explainedBy.length ? 'explained' : 'differs', explainedBy };
}
