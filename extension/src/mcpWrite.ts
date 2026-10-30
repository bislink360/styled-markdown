import * as fs from 'node:fs';
import { DECISION_STATUS, extractTasks, parseSmd, specVersion, STATUS_VALUES, validateSmd, type Diagnostic } from './core';
import { findSection, sectionsOf } from './core/sections';
import { applyLineEdits, type LineEdit } from './core/sourceEdit';
import { isFrontMatterRefusal, setFrontMatterValue } from './core/frontMatterEdit';
import { taskCheckbox } from './editing';
import { ToolError, type McpTool, type ToolInputSchema } from './mcpProtocol';
import { existsFrom, read } from './workspace';
import type { Sandbox } from './mcp';

/**
 * Opt-in write tools for `smd mcp --allow-write`: tick a task, set a document's status, add a decision. Each one
 * changes only the lines it is about, keeps the file's line endings, stays inside the server's root, and refuses a
 * change that would add validation errors.
 */

const FILE = { type: 'string', description: 'Path of a .smd file, relative to the root folder.' } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function schema(properties: ToolInputSchema['properties'], required: string[]): ToolInputSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export function writeTools(box: Sandbox, today: () => string = isoToday): McpTool[] {
  return [
    {
      name: 'check_task',
      description: 'Tick (or untick) one task in a .smd file. "line" is the 1-based line that "tasks" prints.',
      inputSchema: schema({
        file: FILE,
        line: { type: 'integer', minimum: 1, description: '1-based line of the task.' },
        done: { type: 'boolean', description: 'false unticks it (default true).' },
        text: { type: 'string', description: 'Part of the task text; refused if the line no longer has it.' },
      }, ['file', 'line']),
      annotations: { ...WRITE, idempotentHint: true },
      run: (args) => checkTask(box, args),
    },
    {
      name: 'set_status',
      description: 'Set the front matter status of a .smd file (and "updated" to today when it has one).',
      inputSchema: schema({ file: FILE, status: { type: 'string', enum: STATUS_VALUES, description: 'New status.' } }, ['file', 'status']),
      annotations: { ...WRITE, idempotentHint: true },
      run: (args) => setStatus(box, args, today()),
    },
    {
      name: 'add_decision',
      description: 'Append a :::decision block at the end of a section of a .smd file.',
      inputSchema: schema({
        file: FILE,
        section: { type: 'string', description: 'Heading text or id of the section.' },
        title: { type: 'string', description: 'One-line title.' },
        body: { type: 'string', description: 'Markdown: what was decided and why.' },
        status: { type: 'string', enum: DECISION_STATUS, description: 'Default: proposed.' },
        owner: { type: 'string', description: 'e.g. "@maya".' },
      }, ['file', 'section', 'title', 'body']),
      annotations: { ...WRITE, idempotentHint: false },
      run: (args) => addDecision(box, args, today()),
    },
  ];
}

type Args = Record<string, unknown>;

function checkTask(box: Sandbox, args: Args): string {
  const doc = openDocument(box, args.file as string);
  const index = (args.line as number) - 1;
  const done = args.done !== false;
  const task = extractTasks(doc.text).find((t) => t.line === index);
  const box_ = task && taskCheckbox(doc.lines[index]);
  if (!task || !box_) throw new ToolError(`Line ${index + 1} of ${doc.name} is not a task. Call "tasks" for the current lines.`);
  const expected = args.text as string | undefined;
  if (expected && !doc.lines[index].toLowerCase().includes(expected.toLowerCase())) {
    throw new ToolError(`Line ${index + 1} of ${doc.name} no longer has "${expected}": ${doc.lines[index].trim()}. Call "tasks" again.`);
  }
  if (box_.done === done) return `Already ${done ? 'done' : 'open'}: ${doc.name}:${index + 1}  ${doc.lines[index].trim()}\n`;
  const line = doc.lines[index];
  const changed = line.slice(0, box_.column) + (done ? 'x' : ' ') + line.slice(box_.column + 1);
  const saved = doc.save([{ start: index, end: index + 1, lines: [changed] }]);
  return `${done ? 'Done' : 'Reopened'}: ${doc.name}:${index + 1}  ${saved[index].trim()}\n`;
}

function setStatus(box: Sandbox, args: Args, today: string): string {
  const doc = openDocument(box, args.file as string);
  const status = args.status as string;
  const set = (lines: string[], key: string, value: string): string[] => {
    const edits = setFrontMatterValue(lines, key, value);
    if (isFrontMatterRefusal(edits)) throw new ToolError(`Can't set ${key} in ${doc.name}: ${edits.refused}`);
    return edits.length ? applyLineEdits(lines, edits) : lines;
  };
  let lines = set(doc.lines, 'status', status);
  if (lines === doc.lines) return `${doc.name} already has status: ${status}\n`;
  if (/^updated\s*:/m.test(frontMatterText(lines))) lines = set(lines, 'updated', today);
  doc.saveLines(lines);
  return `${doc.name}: status ${status}\n`;
}

function addDecision(box: Sandbox, args: Args, today: string): string {
  const doc = openDocument(box, args.file as string);
  const title = (args.title as string).trim();
  if (!title || /[\r\n]/.test(title)) throw new ToolError('"title" must be one non-empty line.');
  const owner = args.owner as string | undefined;
  if (owner !== undefined && !/^@[\w.-]+(?:\/[\w.-]+)?$/.test(owner)) throw new ToolError('"owner" must look like "@maya" or "@org/team".');
  const status = (args.status as string | undefined) ?? 'proposed';
  const parsed = parseSmd(doc.text);
  const section = findSection(sectionsOf(parsed.headings, doc.lines.length), args.section as string, specVersion(doc.text));
  if (!section) throw new ToolError(`No section matching "${args.section as string}" in ${doc.name}. Call "read" with mode "outline" to list them.`);
  let end = section.end;
  while (end > section.start && !doc.lines[end].trim()) end--;
  const attrs = [`status=${status}`, `date=${today}`, ...(owner ? [`owner=${owner}`] : [])].join(' ');
  const body = (args.body as string).replace(/\r\n?/g, '\n').trim().split('\n');
  const block = ['', `:::decision{${attrs}} ${title}`, ...body, ':::'];
  const next = doc.lines[end + 1];
  if (next !== undefined && next.trim()) block.push('');
  doc.save([{ start: end + 1, end: end + 1, lines: block }]);
  return `Added the decision "${title}" (${status}) to ${doc.name} › ${section.heading.text}, lines ${end + 3}-${end + 4 + body.length}.\n`;
}

interface OpenDocument {
  name: string;
  text: string;
  lines: string[];
  /** Applies the edits, checks the result and writes it; returns the new lines. */
  save(edits: LineEdit[]): string[];
  saveLines(lines: string[]): string[];
}

function openDocument(box: Sandbox, file: string): OpenDocument {
  const path = box.document(file);
  const text = read(path);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const name = box.name(path);
  const saveLines = (next: string[]): string[] => {
    const out = next.join(eol);
    const added = newErrors(text, out, path, box);
    if (added.length) {
      const list = added.slice(0, 3).map((d) => `line ${d.line + 1}: ${d.message} (${d.code})`).join('; ');
      throw new ToolError(`Not written: the change would add ${added.length} validation error(s) to ${name}: ${list}`);
    }
    fs.writeFileSync(path, out);
    return next;
  };
  return { name, text, lines, saveLines, save: (edits) => saveLines(applyLineEdits(lines, edits)) };
}

/** Errors in `after` that `before` didn't have (compared by code and message, so moved lines don't count). */
function newErrors(before: string, after: string, file: string, box: Sandbox): Diagnostic[] {
  const options = { fileExists: existsFrom(file), readFile: box.reader(file) };
  const errors = (text: string) => validateSmd(text, options).filter((d) => d.severity === 'error');
  const seen = new Map<string, number>();
  for (const d of errors(before)) seen.set(`${d.code} ${d.message}`, (seen.get(`${d.code} ${d.message}`) ?? 0) + 1);
  return errors(after).filter((d) => {
    const key = `${d.code} ${d.message}`;
    const left = seen.get(key) ?? 0;
    if (left) seen.set(key, left - 1);
    return !left;
  });
}

function frontMatterText(lines: readonly string[]): string {
  if (lines[0]?.trim() !== '---') return '';
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  return close > 0 ? lines.slice(1, close).join('\n') : '';
}

function isoToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
