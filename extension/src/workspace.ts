import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  checkMermaid, extractTasks, querySmd, validateSmd, type Diagnostic, type MermaidParse, type QueryMatch, type QueryOptions,
  type RuleSettings, type Selector, type TaskInfo,
} from './core';
import { compareTasks } from './taskGroups';

/** Reading .smd files from disk, shared by the CLI and the MCP server. */

export type TaskRow = TaskInfo & { file: string };
export type QueryRow = QueryMatch & { file: string };

/** The .smd files under `target` (itself when it is a file), skipping node_modules and dot folders. */
export function collect(target: string): string[] {
  if (!fs.existsSync(target)) {
    console.error(`Not found: ${target}`);
    return [];
  }
  if (fs.statSync(target).isFile()) return [target];
  const out: string[] = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.name.endsWith('.smd')) out.push(full);
  }
  return out;
}

export function existsFrom(file: string) {
  const dir = path.dirname(path.resolve(file));
  return (rel: string) => fs.existsSync(path.resolve(dir, rel));
}

/** Folders a document may embed files from: the working directory, its own folder and the enclosing Git repository. */
function embedRoots(file: string): string[] {
  const dir = path.dirname(path.resolve(file));
  const roots = [path.resolve(process.cwd()), dir];
  // Also allow the enclosing Git repository (docs/ commonly embeds ../src/…).
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { roots.push(d); break; }
    if (path.dirname(d) === d) break;
  }
  return roots;
}

/**
 * File reader for code embeds. Only files inside `roots` (by default the current working directory, the enclosing Git
 * repository or the document's own folder) can be embedded, so a document cannot pull in e.g. ~/.ssh keys.
 */
export function readerFor(file: string, roots = embedRoots(file)) {
  const dir = path.dirname(path.resolve(file));
  return (rel: string): string | undefined => {
    const target = path.resolve(dir, rel);
    if (!roots.some((r) => target === r || target.startsWith(r + path.sep))) return undefined;
    try { return fs.readFileSync(target, 'utf8'); } catch { return undefined; }
  };
}

export function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

export interface DiagnoseOptions {
  rules: RuleSettings;
  today?: string;
  staleAfterDays?: number;
  /** Mermaid's parser, to report diagram syntax errors. */
  parse?: MermaidParse;
  /** Reader for code embeds (default: readerFor(file)). */
  readFile?: (relativePath: string) => string | undefined;
}

/** Every diagnostic for one document, in source order. */
export async function diagnose(text: string, file: string, options: DiagnoseOptions): Promise<Diagnostic[]> {
  const { rules, today, staleAfterDays, parse } = options;
  const readFile = options.readFile ?? readerFor(file);
  const found = validateSmd(text, { fileExists: existsFrom(file), readFile, today, staleAfterDays, rules });
  if (parse) found.push(...await checkMermaid(text, parse, rules));
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

export interface TaskFilter { all: boolean; mine?: string; today?: string }

/** Tasks in `files` (open ones unless `all`), overdue first, then by priority and due date. `name` labels each file. */
export function taskRows(files: string[], filter: TaskFilter, name = (file: string) => file): TaskRow[] {
  const { all, mine, today } = filter;
  const rows: TaskRow[] = [];
  for (const file of files) {
    for (const t of extractTasks(read(file), today)) {
      if (!all && t.done) continue;
      if (mine && !t.assignees.some((a) => a.toLowerCase() === mine.toLowerCase())) continue;
      rows.push({ ...t, file: name(file) });
    }
  }
  return rows.sort(compareTasks);
}

/** `docs/plan.smd:12  [ ] [P0] Ship it @maya (due 2026-10-01)  — Section` */
export function taskLine(r: TaskRow): string {
  const bits = [
    r.done ? '[x]' : '[ ]',
    r.priority ? `[${r.priority}]` : '',
    r.text,
    r.assignees.length ? r.assignees.join(' ') : '',
    r.due ? `(due ${r.due}${r.overdue ? ', OVERDUE' : ''})` : '',
  ].filter(Boolean);
  return `${r.file}:${r.line + 1}  ${bits.join(' ')}${r.section ? `  — ${r.section}` : ''}`;
}

/** `N task(s) open, M overdue.` */
export function taskSummary(rows: TaskRow[], all: boolean): string {
  const overdue = rows.filter((r) => r.overdue).length;
  const open = all ? '' : ' open';
  return `${rows.length} task(s)${open}${overdue ? `, ${overdue} overdue` : ''}.`;
}

/** Blocks in `files` that match `selectors`. `name` labels each file. */
export function queryRows(files: string[], selectors: Selector[], options: QueryOptions, name = (file: string) => file): QueryRow[] {
  return files.flatMap((file) => querySmd(read(file), selectors, options).map((m) => ({ file: name(file), ...m })));
}

/** Matches as text: each location and its agent view, or (with `titles`) one line per match. Empty when none. */
export function queryText(rows: QueryRow[], titles: boolean): string {
  if (!rows.length) return '';
  const blocks = rows.map((r) => (titles ? titleLine(r) : `${location(r)}\n${r.text}\n`));
  return blocks.join('\n').trimEnd() + '\n';
}

/** `[smd] 3 match(es) in 2 of 5 file(s).` without the prefix. */
export function querySummary(rows: QueryRow[], fileCount: number): string {
  return `${rows.length} match(es) in ${new Set(rows.map((r) => r.file)).size} of ${fileCount} file(s).`;
}

/** `docs/plan.smd:12-20  — Section` */
function location(r: QueryRow): string {
  const end = r.endLine > r.line ? `-${r.endLine + 1}` : '';
  return `${r.file}:${r.line + 1}${end}${r.section ? `  — ${r.section}` : ''}`;
}

/** `docs/plan.smd:12  decision  Title  {status=accepted}` (then the section, as in `location`). */
function titleLine(r: QueryRow): string {
  const end = r.endLine > r.line ? `-${r.endLine + 1}` : '';
  const attrs = Object.entries(r.attrs).map(([k, v]) => `${k}=${[v].flat().join(',')}`).join(' ');
  const parts = [`${r.file}:${r.line + 1}${end}`, r.type, r.title, attrs && `{${attrs}}`, r.section && `— ${r.section}`];
  return parts.filter(Boolean).join('  ');
}
