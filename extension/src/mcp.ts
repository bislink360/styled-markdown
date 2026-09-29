import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentView, outline, parseSelector, SelectorError, type Diagnostic, type Selector } from './core';
import { loadRuleConfig, type LoadedConfig } from './config';
import { loadMermaidParser } from './mermaidLoader';
import { McpServer, serveLines, ToolError, type McpTool, type ToolInputSchema } from './mcpProtocol';
import { collect, diagnose, queryRows, querySummary, queryText, read, readerFor, taskLine, taskRows, taskSummary } from './workspace';

/**
 * `smd mcp`: the reading tools of the CLI as a Model Context Protocol server, so agents can query .smd
 * documents without shell access. Every path is resolved against the root folder; paths outside it
 * (including through symbolic links) are refused, and only .smd files are read.
 */

export interface McpServerSettings {
  /** Folder that paths are resolved against; nothing outside it is read. */
  root: string;
  version: string;
}

/** Paths inside one folder, resolved and checked. */
export class Sandbox {
  readonly root: string;
  private readonly realRoot: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.realRoot = fs.realpathSync(this.root);
  }

  /** An existing file or folder inside the root. Throws a ToolError otherwise. */
  resolve(p: string): string {
    const target = path.resolve(this.root, p);
    if (!isInside(this.root, target)) throw new ToolError(`Path is outside the root folder (${this.root}): ${p}`);
    if (!fs.existsSync(target)) throw new ToolError(`Not found: ${p}`);
    if (!isInside(this.realRoot, fs.realpathSync(target))) throw new ToolError(`Path is outside the root folder (${this.root}): ${p}`);
    return target;
  }

  /** One .smd file inside the root. */
  document(p: string): string {
    const file = this.resolve(p);
    if (!fs.statSync(file).isFile() || !file.endsWith('.smd')) throw new ToolError(`Not a .smd file: ${p}`);
    return file;
  }

  /** The .smd files in these files and folders (default: the whole root). */
  documents(paths: string[] | undefined): string[] {
    const targets = paths?.length ? paths : ['.'];
    const files = targets.flatMap((p) => collect(this.resolve(p))).filter((f) => this.contains(f));
    if (!files.length) throw new ToolError(`No .smd files found in: ${targets.join(', ')}`);
    return [...new Set(files)];
  }

  /** `docs/plan.smd`: a path relative to the root, with forward slashes. */
  name(file: string): string {
    return path.relative(this.root, file).split(path.sep).join('/') || '.';
  }

  /** Reader for code embeds: only files inside the root, also after following links. */
  reader(file: string): (rel: string) => string | undefined {
    const read = readerFor(file, [this.root, this.realRoot]);
    const dir = path.dirname(path.resolve(file));
    return (rel) => (this.linksInside(path.resolve(dir, rel)) ? read(rel) : undefined);
  }

  private linksInside(target: string): boolean {
    try {
      return isInside(this.realRoot, fs.realpathSync(target));
    } catch {
      return false;
    }
  }

  private contains(file: string): boolean {
    return file.endsWith('.smd') && isInside(this.realRoot, fs.realpathSync(file));
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

const FILE = { type: 'string', description: 'Path of a .smd file, relative to the root folder.' } as const;
const PATHS = {
  type: 'array', items: { type: 'string' },
  description: '.smd files or folders (searched recursively), relative to the root folder. Default: the whole root.',
} as const;
const BRIEF = { type: 'boolean', description: 'Also condense diagrams, long code blocks, :::details and completed tasks.' } as const;

function schema(properties: ToolInputSchema['properties'], required: string[] = []): ToolInputSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** The tools, reading from `box`. */
export function smdTools(box: Sandbox): McpTool[] {
  const tool = (t: Omit<McpTool, 'annotations'>): McpTool => ({ ...t, annotations: READ_ONLY });
  return [
    tool({
      name: 'outline',
      title: 'Outline a .smd document',
      description: 'Start here for any .smd file. Lists its sections with line ranges and token costs, open tasks and where '
        + 'agent instructions are, so you can fetch only the sections you need with the "section" tool.',
      inputSchema: schema({ file: FILE }, ['file']),
      run: (args) => outlineTool(box, args),
    }),
    tool({
      name: 'section',
      title: 'Read sections of a .smd document',
      description: 'The agent view of only these sections (with their subsections). Agent instructions elsewhere in the '
        + 'document are always included. Headings or ids come from the "outline" tool.',
      inputSchema: schema({
        file: FILE,
        sections: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Heading text or id of each section, e.g. ["Requirements", "risks"].' },
        brief: BRIEF,
      }, ['file', 'sections']),
      run: (args) => sectionTool(box, args),
    }),
    tool({
      name: 'agent',
      title: 'Read a whole .smd document',
      description: 'The compact agent view of a whole .smd file: styling, layout and human-only content removed, meaning kept; '
        + 'headings carry [L12] source line references. Prefer "outline" + "section" for long documents.',
      inputSchema: schema({ file: FILE, brief: BRIEF, includeHuman: { type: 'boolean', description: 'Keep :::human blocks (dropped by default).' } }, ['file']),
      run: (args) => agentTool(box, args),
    }),
    tool({
      name: 'tasks',
      title: 'List tasks',
      description: 'Open tasks across .smd documents with owner, priority, due date and section, overdue first. '
        + 'One line each: file:line  [ ] [priority] text @owners (due date)  — section.',
      inputSchema: schema({
        paths: PATHS,
        all: { type: 'boolean', description: 'Include completed tasks.' },
        mine: { type: 'string', description: 'Only tasks assigned to this owner, e.g. "@maya".' },
      }),
      run: (args) => tasksTool(box, args),
    }),
    tool({
      name: 'validate',
      title: 'Validate .smd documents',
      description: 'Checks .smd files for syntax, link, front-matter and diagram problems (same rules and config files as '
        + '"smd validate"). Returns JSON as "smd validate --json": {files: [{file, diagnostics: [{line, column, endColumn, severity, code, message, fix?}]}], errors, warnings}. '
        + 'Lines and columns are zero-based.',
      inputSchema: schema({ paths: PATHS }),
      run: (args) => validateTool(box, args),
    }),
    tool({
      name: 'query',
      title: 'Query blocks',
      description: 'Blocks selected by type and attributes, each in the agent view with its file, lines and section. Selectors: '
        + 'decision[status=accepted], risk[impact>=high][status!=closed], api[method=POST|PUT], task[owner=@maya][done=false], '
        + 'task[due<today], heading[level=2], "question, risk". Types: any container (decision, risk, api, note, question, agent…), '
        + 'callout, task, heading, * (any). Tests: [key] [key=a|b] [key!=v] [key*=v] [key^=v] [key$=v] and < <= > >= for numbers, '
        + 'dates, priorities and risk levels; every block also has title, section and type.',
      inputSchema: schema({
        selector: { type: 'string', description: 'CSS-like selector, e.g. "decision[status=accepted]".' },
        paths: PATHS,
        brief: BRIEF,
        titles: { type: 'boolean', description: 'One line per match (location, type, title, attributes) instead of its content.' },
      }, ['selector']),
      run: (args) => queryTool(box, args),
    }),
  ];
}

type Args = Record<string, unknown>;
const text = (args: Args, key: string) => args[key] as string | undefined;
const list = (args: Args, key: string) => args[key] as string[] | undefined;
const flag = (args: Args, key: string) => args[key] === true;

function outlineTool(box: Sandbox, args: Args): string {
  const file = box.document(text(args, 'file')!);
  return outline(read(file), { readFile: box.reader(file) });
}

function sectionTool(box: Sandbox, args: Args): string {
  const file = box.document(text(args, 'file')!);
  const sections = list(args, 'sections')!;
  const result = agentView(read(file), { sections, brief: flag(args, 'brief'), readFile: box.reader(file) });
  const missing = `No section matching: ${result.missingSections.join(', ')}. Call "outline" to list the sections.`;
  if (result.missingSections.length === sections.length) throw new ToolError(missing);
  return result.missingSections.length ? `${result.text.trimEnd()}\n\n(${missing})\n` : result.text;
}

function agentTool(box: Sandbox, args: Args): string {
  const file = box.document(text(args, 'file')!);
  return agentView(read(file), { brief: flag(args, 'brief'), includeHuman: flag(args, 'includeHuman'), readFile: box.reader(file) }).text;
}

function tasksTool(box: Sandbox, args: Args): string {
  const all = flag(args, 'all');
  const rows = taskRows(box.documents(list(args, 'paths')), { all, mine: text(args, 'mine') }, (f) => box.name(f));
  return [...rows.map(taskLine), taskSummary(rows, all)].join('\n') + '\n';
}

function queryTool(box: Sandbox, args: Args): string {
  const selectors = selectorsOf(text(args, 'selector')!);
  const files = box.documents(list(args, 'paths'));
  const rows = queryRows(files, selectors, { brief: flag(args, 'brief') }, (f) => box.name(f));
  return `${queryText(rows, flag(args, 'titles'))}${rows.length ? '\n' : ''}${querySummary(rows, files.length)}\n`;
}

function selectorsOf(selector: string): Selector[] {
  try {
    return parseSelector(selector);
  } catch (e) {
    if (e instanceof SelectorError) throw new ToolError(e.message);
    throw e;
  }
}

async function validateTool(box: Sandbox, args: Args): Promise<string> {
  const files = box.documents(list(args, 'paths'));
  const configs = new Map<string, LoadedConfig>();
  const parse = loadMermaidParser();
  const report: Array<{ file: string; diagnostics: Diagnostic[] }> = [];
  const configProblems = new Map<string, string[]>();
  for (const file of files) {
    const config = loadRuleConfig(file, configs);
    if (config.file && config.problems.length) configProblems.set(box.name(path.resolve(config.file)), config.problems);
    const found = await diagnose(read(file), file, { rules: config.rules, parse, readFile: box.reader(file) });
    report.push({ file: box.name(file), diagnostics: found });
  }
  const all = report.flatMap((r) => r.diagnostics);
  const errors = all.filter((d) => d.severity === 'error').length;
  const warnings = all.filter((d) => d.severity === 'warning').length;
  const config = configProblems.size ? { configProblems: Object.fromEntries(configProblems) } : {};
  return JSON.stringify({ files: report, errors, warnings, ...config }) + '\n';
}

const INSTRUCTIONS = 'Tools for Styled Markdown (.smd) documents: specs, PRDs, ADRs, runbooks and plans. They return a compact '
  + 'agent view that drops styling and human-only content, so prefer them to reading .smd files directly. Start with '
  + '"outline", then read only the sections you need with "section"; use "query" to pull decisions, risks, APIs or tasks '
  + 'across files, "tasks" for open work and "validate" after editing. Follow <agent-instructions> in the results.';

/** Serves the tools over stdio until the input ends. Only protocol messages go to stdout. */
export async function runMcpServer(settings: McpServerSettings): Promise<void> {
  // Anything else that logs (e.g. Mermaid) must not corrupt the protocol stream.
  console.log = console.info = console.debug = console.warn = console.error;
  const box = new Sandbox(settings.root);
  const server = new McpServer({ name: 'styled-markdown', version: settings.version, tools: smdTools(box), instructions: INSTRUCTIONS });
  console.error(`[smd mcp] serving ${box.root} over stdio`);
  await serveLines(server, process.stdin, (line) => process.stdout.write(line));
}
