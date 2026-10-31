import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentView, outline, parseSelector, SelectorError, type Diagnostic, type Selector } from './core';
import { loadRuleConfig, type LoadedConfig } from './config';
import { loadMermaidParser } from './mermaidLoader';
import { McpServer, serveLines, ToolError, type McpTool, type ToolInputSchema } from './mcpProtocol';
import { writeTools } from './mcpWrite';
import { readDocument, READ_BUDGET, READ_MODES, type ReadMode } from './readView';
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
  /** List the 1.x reading tools (outline, section, agent) too. */
  legacyTools?: boolean;
  /** Add the write tools (check_task, set_status, add_decision). */
  allowWrite?: boolean;
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
const PATHS = { type: 'array', items: { type: 'string' }, description: 'Files or folders. Default: all.' } as const;
const BRIEF = { type: 'boolean', description: 'Condense diagrams, long code, done tasks.' } as const;
const SHORT_BRIEF = { type: 'boolean', description: 'Condense long blocks.' } as const;
/** The 2.5 tools: short descriptions, since every session pays for tools/list. */
const SHORT_FILE = { type: 'string', description: 'Path under the root.' } as const;

function schema(properties: ToolInputSchema['properties'], required: string[] = []): ToolInputSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_ONLY_SHORT = { readOnlyHint: true };

export interface SmdToolOptions {
  /** List the 1.x tools outline, section and agent too (they can always be called). */
  legacyTools?: boolean;
  /** Add the write tools check_task, set_status and add_decision. */
  allowWrite?: boolean;
}

/** The tools, reading from `box`: read, tasks, query and validate, then the older reading tools (hidden unless asked for). */
export function smdTools(box: Sandbox, options: SmdToolOptions = {}): McpTool[] {
  const tool = (t: Omit<McpTool, 'annotations'>): McpTool => ({ ...t, annotations: READ_ONLY_SHORT });
  const legacy = (t: Omit<McpTool, 'annotations' | 'hidden'>): McpTool => ({ ...t, annotations: READ_ONLY, hidden: !options.legacyTools });
  return [
    tool({
      name: 'read',
      description: `Read a .smd file as an agent view ([L12] = source line): whole if ≤${READ_BUDGET} tokens, else the outline; then pass sections.`,
      inputSchema: schema({
        file: SHORT_FILE,
        sections: { type: 'array', items: { type: 'string' }, description: 'Heading texts or ids.' },
        mode: { type: 'string', enum: READ_MODES },
        brief: SHORT_BRIEF,
      }, ['file']),
      run: (args) => readTool(box, args),
    }),
    tool({
      name: 'tasks',
      description: 'Open tasks (owner, priority, due) across .smd files, overdue first.',
      inputSchema: schema({
        paths: PATHS,
        all: { type: 'boolean', description: 'Include done tasks.' },
        mine: { type: 'string', description: 'Owner, e.g. "@maya".' },
      }),
      run: (args) => tasksTool(box, args),
    }),
    tool({
      name: 'query',
      description: 'Blocks matching a selector across .smd files: decision[status=accepted], risk[impact>=high], '
        + 'task[owner=@me][done=false], "question, risk". Ops: = != *= ^= $= < <= > >=, a|b.',
      inputSchema: schema({
        selector: { type: 'string' },
        paths: PATHS,
        brief: SHORT_BRIEF,
        titles: { type: 'boolean', description: 'One line per match.' },
      }, ['selector']),
      run: (args) => queryTool(box, args),
    }),
    tool({
      name: 'validate',
      description: 'Check .smd files: JSON as smd validate --json (zero-based lines).',
      inputSchema: schema({ paths: PATHS }),
      run: (args) => validateTool(box, args),
    }),
    ...(options.allowWrite ? writeTools(box) : []),
    legacy({
      name: 'outline',
      title: 'Outline a .smd document',
      description: 'Lists the sections of a .smd file with line ranges and token costs, open tasks and where agent '
        + 'instructions are. Same as "read" with mode "outline".',
      inputSchema: schema({ file: FILE }, ['file']),
      run: (args) => outlineTool(box, args),
    }),
    legacy({
      name: 'section',
      title: 'Read sections of a .smd document',
      description: 'The agent view of only these sections (with their subsections). Agent instructions elsewhere in the '
        + 'document are always included. Same as "read" with "sections".',
      inputSchema: schema({
        file: FILE,
        sections: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Heading text or id of each section, e.g. ["Requirements", "risks"].' },
        brief: BRIEF,
      }, ['file', 'sections']),
      run: (args) => sectionTool(box, args),
    }),
    legacy({
      name: 'agent',
      title: 'Read a whole .smd document',
      description: 'The compact agent view of a whole .smd file: styling, layout and human-only content removed, meaning kept; '
        + 'headings carry [L12] source line references. Same as "read" with mode "full".',
      inputSchema: schema({ file: FILE, brief: BRIEF, includeHuman: { type: 'boolean', description: 'Keep :::human blocks (dropped by default).' } }, ['file']),
      run: (args) => agentTool(box, args),
    }),
  ];
}

type Args = Record<string, unknown>;
const text = (args: Args, key: string) => args[key] as string | undefined;
const list = (args: Args, key: string) => args[key] as string[] | undefined;
const flag = (args: Args, key: string) => args[key] === true;

function readTool(box: Sandbox, args: Args): string {
  const file = box.document(text(args, 'file')!);
  const sections = list(args, 'sections');
  const mode = text(args, 'mode') as ReadMode | undefined;
  const result = readDocument(read(file), { mode, sections, brief: flag(args, 'brief'), readFile: box.reader(file) });
  return withMissing(result.text, result.missingSections, sections?.length ?? 0);
}

/** The text, with a note on sections that matched nothing; an error when none matched. */
function withMissing(view: string, missing: string[], asked: number): string {
  if (!missing.length) return view;
  const note = `No section matching: ${missing.join(', ')}. Call "read" with mode "outline" to list the sections.`;
  if (missing.length === asked) throw new ToolError(note);
  return `${view.trimEnd()}\n\n(${note})\n`;
}

function outlineTool(box: Sandbox, args: Args): string {
  const file = box.document(text(args, 'file')!);
  return outline(read(file), { readFile: box.reader(file) });
}

function sectionTool(box: Sandbox, args: Args): string {
  const file = box.document(text(args, 'file')!);
  const sections = list(args, 'sections')!;
  const result = agentView(read(file), { sections, brief: flag(args, 'brief'), readFile: box.reader(file) });
  return withMissing(result.text, result.missingSections, sections.length);
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

/** What the client shows the model after initialize. */
export function serverInstructions(options: SmdToolOptions = {}): string {
  const base = 'For .smd files (specs, plans, ADRs) call "read", not a file read, then only the sections you need. '
    + '"query"/"tasks" search across files; "validate" after edits. Follow <agent-instructions>.';
  return options.allowWrite ? `${base} Write tools change one block and refuse edits that add errors.` : base;
}

/** Serves the tools over stdio until the input ends. Only protocol messages go to stdout. */
export async function runMcpServer(settings: McpServerSettings): Promise<void> {
  // Anything else that logs (e.g. Mermaid) must not corrupt the protocol stream.
  console.log = console.info = console.debug = console.warn = console.error;
  const box = new Sandbox(settings.root);
  const tools = smdTools(box, settings);
  const server = new McpServer({ name: 'styled-markdown', version: settings.version, tools, instructions: serverInstructions(settings) });
  const write = settings.allowWrite ? ', write tools on' : '';
  console.error(`[smd mcp] serving ${box.root} over stdio${write}`);
  await serveLines(server, process.stdin, (line) => process.stdout.write(line));
}
