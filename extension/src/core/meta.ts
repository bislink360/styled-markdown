import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo } from './containers';
import { parseFrontMatter } from './frontmatter';
import { parseSmd } from './parse';
import { dueState } from './render';
import { validateSmd, type Diagnostic, type ValidateOptions } from './validate';
import { inlineText } from './agentView';
import { substituteLine } from './variables';
import { priorityRank } from './util';

export interface TaskInfo {
  text: string;
  /** Zero-based line. */
  line: number;
  done: boolean;
  /** Nearest heading above the task. */
  section: string | null;
  assignees: string[];
  priority?: string;
  due?: string;
  overdue?: boolean;
}

export interface DecisionInfo { title: string; status: string; date?: string; owner?: string; line: number }
export interface RiskInfo { title: string; impact: string; likelihood?: string; owner?: string; status?: string; line: number }

/** A machine-readable summary of an .smd document — what an agent needs before reading the whole thing. */
export interface SmdDocumentInfo {
  frontMatter: Record<string, unknown>;
  title: string | null;
  summary: string | null;
  outline: Array<{ level: number; text: string; id: string; line: number; agent?: string }>;
  tasks: { total: number; done: number; open: TaskInfo[] };
  decisions: DecisionInfo[];
  risks: RiskInfo[];
  agentBlocks: Array<{ title: string; line: number; content: string }>;
  containers: Record<string, number>;
  diagrams: Array<{ type: string; line: number }>;
  diagnostics: { errors: number; warnings: number; items: Diagnostic[] };
}

/** Parse every task (open and done) with its owner, priority and due date. */
export function extractTasks(text: string, today?: string): TaskInfo[] {
  const fm = parseFrontMatter(text);
  const lines = text.split(/\r?\n/);
  const tasks: TaskInfo[] = [];
  let section: string | null = null;
  let fence: string | null = null;
  for (let i = fm.bodyStartLine; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const h = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+\{[^{}]*\})?\s*#*\s*$/.exec(line);
    if (h) { section = inlineText(h[1], undefined, false, undefined, fm.data); continue; }
    const m = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!m) continue;
    const body = substituteLine(m[2], fm.data);
    const due = /:due\[([^\]]+)\]/.exec(body)?.[1]?.trim();
    const priority = /:priority\[([^\]]+)\]/.exec(body)?.[1]?.trim();
    const assignees = [
      ...[...body.matchAll(/:mention\[([^\]]+)\]/g)].map((x) => x[1].trim()),
      ...[...body.replace(/`[^`]*`/g, '').matchAll(/(?:^|\s)(@[\w.-]+)/g)].map((x) => x[1]),
    ];
    const done = m[1] !== ' ';
    tasks.push({
      // Owner, priority and due date live in their own fields, so strip them from the text.
      text: inlineText(body)
        .replace(/\s*\(due [^)]*\)/, '')
        .replace(/\s*\[(?:P\d|critical|high|medium|low)\]/i, '')
        .replace(/(^|\s)@[\w.-]+(?=\s|$)/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
      line: i,
      done,
      section,
      assignees: [...new Set(assignees)],
      ...(priority ? { priority } : {}),
      ...(due ? { due, overdue: !done && dueState(due, today) === 'overdue' } : {}),
    });
  }
  return tasks;
}

/** Overdue first, then by priority, due date (none last), file and line: the order of `smd tasks` and the tasks view. */
export function compareTasks(a: TaskInfo & { file: string }, b: TaskInfo & { file: string }): number {
  return Number(b.overdue ?? false) - Number(a.overdue ?? false) || priorityRank(a.priority) - priorityRank(b.priority)
    || (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.file.localeCompare(b.file) || a.line - b.line;
}

export function getDocumentInfo(text: string, options: ValidateOptions = {}): SmdDocumentInfo {
  const fm = parseFrontMatter(text);
  const rendered = parseSmd(text);
  const lines = text.split(/\r?\n/);
  const agentBlocks: SmdDocumentInfo['agentBlocks'] = [];
  const decisions: DecisionInfo[] = [];
  const risks: RiskInfo[] = [];
  const containers: Record<string, number> = {};
  const diagrams: SmdDocumentInfo['diagrams'] = [];

  const stack: Array<{ name: string; line: number; title: string; body: string[] }> = [];
  let fence: string | null = null;
  for (let i = fm.bodyStartLine; i < lines.length; i++) {
    const line = lines[i];
    for (const s of stack) if (s.name === 'agent') s.body.push(line);
    if (fence) {
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    const f = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (f) {
      fence = f[1];
      if (f[2].toLowerCase() === 'mermaid') {
        const kind = lines.slice(i + 1).find((l) => l.trim() && !l.trim().startsWith('%%'))?.trim().split(/[\s;:]/)[0] ?? 'unknown';
        diagrams.push({ type: kind, line: i });
      }
      continue;
    }
    if (CONTAINER_CLOSE.test(line) && stack.length) {
      const done = stack.pop()!;
      if (done.name === 'agent') {
        done.body.pop(); // the closing fence itself
        agentBlocks.push({ title: done.title, line: done.line, content: done.body.join('\n').trim() });
      }
      continue;
    }
    const open = CONTAINER_OPEN.exec(line);
    const info = open ? parseContainerInfo(open[3] + open[4]) : null;
    if (open && info) {
      containers[info.name] = (containers[info.name] ?? 0) + 1;
      const v = info.attrs.values;
      const title = inlineText(info.title, undefined, false, undefined, fm.data);
      if (info.name === 'decision') decisions.push({ title, status: v.status ?? 'proposed', date: v.date, owner: v.owner, line: i });
      if (info.name === 'risk') risks.push({ title, impact: v.impact ?? 'medium', likelihood: v.likelihood, owner: v.owner, status: v.status, line: i });
      stack.push({ name: info.name, line: i, title, body: [] });
    }
  }

  const all = extractTasks(text, options.today);
  const items = validateSmd(text, options);
  return {
    frontMatter: fm.data,
    title: typeof fm.data.title === 'string' ? fm.data.title : rendered.headings.find((h) => h.level === 1)?.text ?? null,
    summary: typeof fm.data.summary === 'string' ? fm.data.summary : null,
    outline: rendered.headings.map((h) => ({ level: h.level, text: h.text, id: h.slug, line: h.line, ...(h.agent ? { agent: h.agent } : {}) })),
    tasks: { total: all.length, done: all.filter((t) => t.done).length, open: all.filter((t) => !t.done) },
    decisions,
    risks,
    agentBlocks,
    containers,
    diagrams,
    diagnostics: {
      errors: items.filter((d) => d.severity === 'error').length,
      warnings: items.filter((d) => d.severity === 'warning').length,
      items,
    },
  };
}
