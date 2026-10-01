import type { TaskInfo } from './meta';

/**
 * Task export: CSV for spreadsheets and a Mermaid Gantt chart of tasks with due dates, from the
 * rows `extractTasks` returns (with the file each came from, as `smd tasks` lists them).
 */
export type TaskExportRow = TaskInfo & { file?: string };

/** CSV columns, in order. `line` is 1-based (as `smd tasks` prints it); `extractTasks` and `--json` are zero-based. */
export const TASK_CSV_COLUMNS = ['file', 'line', 'done', 'text', 'owners', 'priority', 'due', 'overdue', 'section'] as const;

/**
 * RFC 4180 CSV with a header row and CRLF line endings, UTF-8 without a byte order mark. Owners are
 * joined with `;`. Fields with a comma, quote or line break are quoted (quotes doubled). A field that
 * starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so spreadsheets
 * don't run it as a formula; this includes owners (`'@maya;@li`), since Excel reads `@maya` as one.
 */
export function tasksToCsv(rows: TaskExportRow[]): string {
  const lines = [TASK_CSV_COLUMNS.join(','), ...rows.map((r) => csvRecord(r).map(csvField).join(','))];
  return lines.map((l) => l + '\r\n').join('');
}

function csvRecord(r: TaskExportRow): string[] {
  return [
    r.file ?? '', String(r.line + 1), String(r.done), r.text, r.assignees.join(';'),
    r.priority ?? '', r.due ?? '', String(r.overdue ?? false), r.section ?? '',
  ];
}

/** Characters that make a spreadsheet treat a cell as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface GanttOptions {
  /** Chart title (default "Tasks"). */
  title?: string;
}

/**
 * A Mermaid `gantt` chart: one section per file (in path order), one milestone per task with a
 * valid YYYY-MM-DD due date (by date, then line), named by its text and owners. Done tasks are
 * marked `done`, overdue ones `crit`. Tasks without a due date are left out (see `ganttDate`).
 */
export function tasksToGantt(rows: TaskExportRow[], options: GanttOptions = {}): string {
  const out = ['gantt', `  title ${ganttText(options.title?.trim() || 'Tasks')}`, '  dateFormat YYYY-MM-DD'];
  for (const [file, tasks] of groupByFile(rows.filter((r) => ganttDate(r.due)))) {
    out.push(`  section ${ganttText(file || 'Tasks')}`);
    for (const t of tasks) out.push(`    ${milestone(t)}`);
  }
  return out.join('\n') + '\n';
}

/** The chart wrapped in a small `.smd` document with a `mermaid` fence, for `smd render`. */
export function ganttDocument(chart: string, title = 'Tasks'): string {
  const name = title.replace(/\s+/g, ' ').trim() || 'Tasks';
  const quoted = JSON.stringify(name);
  return `---\ntitle: ${quoted}\n---\n\n# ${name}\n\n\`\`\`mermaid\n${chart.trimEnd()}\n\`\`\`\n`;
}

/** The due date when it is a real calendar date in YYYY-MM-DD form, as the Gantt chart needs. */
export function ganttDate(due: string | undefined): string | undefined {
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return undefined;
  const time = Date.parse(due);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(due) ? due : undefined;
}

function groupByFile(rows: TaskExportRow[]): Array<[string, TaskExportRow[]]> {
  const groups = new Map<string, TaskExportRow[]>();
  for (const r of rows) {
    const file = r.file ?? '';
    const list = groups.get(file);
    if (list) list.push(r);
    else groups.set(file, [r]);
  }
  const byDate = (a: TaskExportRow, b: TaskExportRow) => a.due!.localeCompare(b.due!) || a.line - b.line;
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, tasks]) => [file, [...tasks].sort(byDate)]);
}

/** `Ship it @maya :crit, milestone, 2026-10-01, 0d` */
function milestone(t: TaskExportRow): string {
  const name = [t.text, ...t.assignees].filter(Boolean).join(' ') || `Task on line ${t.line + 1}`;
  const tags = [t.done ? 'done' : '', t.overdue ? 'crit' : '', 'milestone'].filter(Boolean);
  return `${ganttTaskName(name)} :${tags.join(', ')}, ${t.due}, 0d`;
}

/**
 * Words that start a statement when a Gantt line begins with them (Mermaid's lexer ignores case
 * and tries them before task names), and dates, which would be read as one.
 */
const GANTT_KEYWORDS = new Set([
  'gantt', 'dateformat', 'inclusiveenddates', 'topaxis', 'axisformat', 'tickinterval', 'includes', 'excludes', 'todaymarker',
  'weekday', 'weekend', 'title', 'accdescription', 'accdescr', 'acctitle', 'section', 'click', 'call', 'href',
]);

/** A task name: `ganttText`, and a leading keyword's first letter as an entity code (`#84;itle page`). */
function ganttTaskName(name: string): string {
  const text = ganttText(name);
  const word = /^[a-z]+/i.exec(text)?.[0].toLowerCase() ?? '';
  const statement = GANTT_KEYWORDS.has(word) || /^\d{4}-\d\d-\d\d/.test(text);
  return statement ? entity(text[0]) + text.slice(1) : text;
}

/**
 * One line of Gantt text. `:` ends a task name, `#` and `;` end its data, `%` starts a comment, and
 * `#…;` is Mermaid's entity syntax, so all four become entity codes (`#58;`), which Mermaid shows as
 * the character itself. Line breaks become spaces.
 */
function ganttText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[:#;%]/g, entity).trim();
}

function entity(ch: string): string {
  return `#${ch.codePointAt(0)};`;
}
