import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  agentView, applyFixes, checkMermaid, extractTasks, formatRelated, formatSmd, getDocumentInfo, markdownToSmd, outline, parseSelector, querySmd,
  relatedDocs, renderPage, smdIndex, smdToMarkdown, validateSmd, SelectorError, SMD_VERSION, type Diagnostic, type QueryMatch, type Selector, type TaskInfo,
} from './core';
import { loadMermaidParser } from './mermaidLoader';
import { loadRuleConfig, readConfigFile, type LoadedConfig } from './config';
import { fillTemplate, SKILLS, TEMPLATES } from './skillsBundle';
// Injected by scripts/build.mjs. package.json itself stays out of the bundle, so editing its
// scripts or dependencies doesn't change the CLI's bytes (and the copies bundled in skills/).
declare const __SMD_PKG_VERSION__: string;
const pkg = { version: typeof __SMD_PKG_VERSION__ === 'string' ? __SMD_PKG_VERSION__ : '0.0.0-dev' };

const HELP = `smd — Styled Markdown tool (spec v${SMD_VERSION})

Reading (token-efficient, for agents):
  smd outline <file.smd> [--related]
      Sections with line ranges and token costs, open tasks, where agent instructions are.
      --related    also list the front matter "related:" documents: title, status, summary and cost
  smd agent <file.smd> [--section "<heading>"]... [--brief] [--include-human] [--embed] [--no-lines]
      Compact agent view: styling, layout and human-only content removed; meaning kept.
      --section    only these sections (repeatable; agent instructions elsewhere are still included)
      --brief      also condense diagrams, long code, :::details and completed tasks
      --embed      inline file="…" code embeds instead of referencing the file
  smd tasks <files|dirs...> [--all] [--mine @name] [--json]
      Open tasks across documents with owner, priority and due date (overdue first).
  smd query "<selector>" <files|dirs...> [--json] [--titles] [--brief] [--no-lines]
      Blocks selected by type and attributes, each in the agent view. Exit code 1 when nothing matches.
        decision[status=accepted]      risk[impact>=high][status!=closed]      api[method=POST|PUT]
        task[owner=@maya][done=false]  task[due<today]    question, risk       heading[level=2]
      Types: any container (decision, risk, api, note, question, agent…), callout, task, heading, * (any).
      Tests: [key] [key=a|b] [key!=v] [key*=v] [key^=v] [key$=v] [key<v] (also <= > >=: numbers, dates,
      priorities, risk levels); every block also has title, section and type.
      --titles  one line per match instead of its content
  smd meta <file.smd> [--no-diagnostics]
      Full JSON summary: front matter, outline, tasks, decisions, risks, agent blocks.
  smd index <files|dirs...> [-o catalog.json] [--compact]
      JSON catalog of every document: title, summary, status, owners, tags, token costs, sections
      and counts (open tasks, decisions, risks, questions, APIs). Agents read it to pick documents,
      then run outline or agent --section on them. Paths are relative to the working directory.
      --compact  one line of JSON instead of indented

Checking and converting:
  smd validate <files|dirs...> [--json] [--fix] [--strict] [--config <file>] [--no-mermaid] [--stale-after <days>]
      Check .smd files. Exit code 1 on errors (or warnings with --strict). --fix applies safe fixes.
      Rules are configured by the nearest smd.config.json or .smdrc (or --config):
        { "rules": { "link/missing-file": "off", "frontmatter/*": "hint", "task/overdue": "error" } }
      and silenced inline with <!-- smd-disable-next-line rule/code -->.
      Mermaid diagrams are parsed for syntax errors (--no-mermaid skips it).
      Documents whose "updated" date is over 180 days old are reported as stale (--stale-after 0: off).
  smd fmt <files|dirs...> [--check] [--stdout]
      Format .smd files in place: container fences, attribute lists, tables and blank lines.
      --check   change nothing; list unformatted files and exit 1 if there are any
      --stdout  print the formatted file instead of writing it (one file)
  smd render <file.smd> [-o out.html]      Standalone HTML page
  smd to-md <file.smd> [-o out.md]         Plain GitHub-flavored Markdown
  smd from-md <file.md> [-o out.smd]       Upgrade Markdown to .smd
  smd init <file.smd> [--template <name>] [--title "My doc"]
      New document from a template: ${Object.keys(TEMPLATES).join(', ')} (default: prd)
  smd templates                            List templates

Agent skills:
  smd skills install [--dir <skills-dir>] [--global] [--only reader|writer]
      Install the agent skills (each with this CLI bundled) into .claude/skills (default),
      a custom directory, or ~/.claude/skills (--global):
        styled-markdown-reader   read .smd token-efficiently
        styled-markdown-writer   create/edit .smd following the rules
`;

interface Args { command?: string; positional: string[]; flags: Set<string>; values: Map<string, string[]> }

const VALUE_OPTIONS = new Set(['--config', '--stale-after', '-o', '--title', '--section', '--dir', '--mine', '--today', '--template', '--only']);

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  const args: Args = { command, positional: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE_OPTIONS.has(a)) {
      const list = args.values.get(a) ?? [];
      list.push(rest[++i] ?? '');
      args.values.set(a, list);
    } else if (a.startsWith('-')) {
      args.flags.add(a);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

function main(argv: string[]): number | Promise<number> {
  const args = parseArgs(argv);
  const { command, positional, flags } = args;
  const value = (name: string) => args.values.get(name)?.[0];
  const today = value('--today');
  const staleAfter = value('--stale-after');
  const staleAfterDays = staleAfter === undefined ? undefined : Number(staleAfter);
  if (staleAfterDays !== undefined && !(staleAfterDays >= 0)) return fail('--stale-after needs a number of days (0 turns the check off).');

  switch (command) {
    case 'outline':
      return outlineFile(requireFile(positional[0]), flags.has('--related'), today);
    case 'agent': {
      const file = requireFile(positional[0]);
      const result = agentView(read(file), {
        sections: args.values.get('--section'),
        brief: flags.has('--brief'),
        includeHuman: flags.has('--include-human'),
        embed: flags.has('--embed'),
        lineRefs: !flags.has('--no-lines'),
        readFile: readerFor(file),
        today,
      });
      if (result.missingSections.length) {
        console.error(`No section matching: ${result.missingSections.join(', ')}. Run "smd outline ${file}" to list sections.`);
        if (result.missingSections.length === (args.values.get('--section')?.length ?? 0)) return 1;
      }
      process.stdout.write(result.text);
      const saved = result.originalTokens ? Math.round((1 - result.tokens / result.originalTokens) * 100) : 0;
      console.error(`[smd] ≈${result.tokens} tokens (file ≈${result.originalTokens}, ${saved}% smaller)`);
      return 0;
    }
    case 'tasks':
      return tasks(positional.length ? positional : ['.'], flags.has('--all'), value('--mine'), flags.has('--json'), today);
    case 'query':
      return query(positional[0], positional.slice(1), { json: flags.has('--json'), titles: flags.has('--titles'), brief: flags.has('--brief'), lineRefs: !flags.has('--no-lines'), today });
    case 'meta': {
      const file = requireFile(positional[0]);
      const rules = configFor(file, value('--config')).rules;
      const info = getDocumentInfo(read(file), { fileExists: existsFrom(file), readFile: readerFor(file), today, rules, staleAfterDays });
      if (flags.has('--no-diagnostics')) delete (info as Partial<typeof info>).diagnostics;
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
      return 0;
    }
    case 'index':
      return index(positional, value('-o'), flags.has('--compact'), today);
    case 'validate':
      return validate(positional.length ? positional : ['.'], flags.has('--json'), flags.has('--fix'), flags.has('--strict'), today, value('--config'), !flags.has('--no-mermaid'), staleAfterDays);
    case 'fmt':
      return fmt(positional.length ? positional : ['.'], flags.has('--check'), flags.has('--stdout'));
    case 'render': {
      const file = requireFile(positional[0]);
      return write(value('-o'), renderPage(read(file), { readFile: readerFor(file) }));
    }
    case 'to-md':
      return write(value('-o'), smdToMarkdown(read(requireFile(positional[0])), { readFile: readerFor(positional[0]) }));
    case 'from-md': {
      const file = requireFile(positional[0]);
      return write(value('-o'), markdownToSmd(read(file), path.basename(file, path.extname(file))));
    }
    case 'init': {
      const file = positional[0];
      if (!file) return fail('init needs a file name, e.g. smd init docs/plan.smd');
      if (fs.existsSync(file)) return fail(`${file} already exists.`);
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      const name = value('--template') ?? 'prd';
      const tpl = TEMPLATES[name];
      if (!tpl) return fail(`Unknown template "${name}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
      fs.writeFileSync(file, fillTemplate(tpl.text, value('--title') ?? path.basename(file, '.smd'), today));
      console.log(`Created ${file} from the "${name}" template. Fill in the placeholders, then run: smd validate ${file}`);
      return 0;
    }
    case 'templates':
      for (const [name, t] of Object.entries(TEMPLATES)) console.log(`${name.padEnd(15)} ${t.description}`);
      return 0;
    case 'skills':
      if (positional[0] !== 'install') return fail('Usage: smd skills install [--dir <skills-dir>] [--global] [--only reader|writer]');
      return installSkills(flags.has('--global') ? path.join(os.homedir(), '.claude', 'skills') : value('--dir') ?? path.join('.claude', 'skills'), value('--only'));
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    case '--version':
    case '-v':
      console.log(`smd ${pkg.version} (Styled Markdown spec v${SMD_VERSION})`);
      return 0;
    default:
      return fail(`Unknown command "${command}".\n\n${HELP}`);
  }
}

async function validate(
  targets: string[], json: boolean, fix: boolean, strict: boolean, today?: string, configFile?: string, mermaid = true, staleAfterDays?: number,
): Promise<number> {
  const files = targets.flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const report: Array<{ file: string; diagnostics: Diagnostic[]; fixed?: number }> = [];
  const configs = new Map<string, LoadedConfig>();
  const reported = new Set<string>();
  let configProblems = 0;
  const parse = mermaid ? loadMermaidParser() : undefined;
  for (const file of files) {
    const config = configFor(file, configFile, configs);
    if (config.problems.length && !reported.has(config.file!)) {
      reported.add(config.file!);
      configProblems += config.problems.length;
      for (const p of config.problems) console.error(`${config.file}: warning  ${p}`);
    }
    const opts = { fileExists: existsFrom(file), readFile: readerFor(file), today, staleAfterDays, rules: config.rules };
    const check = async (text: string) => {
      const found = validateSmd(text, opts);
      if (parse) found.push(...await checkMermaid(text, parse, config.rules));
      return found.sort((a, b) => a.line - b.line || a.column - b.column);
    };
    let text = read(file);
    let diagnostics = await check(text);
    let fixed: number | undefined;
    if (fix && diagnostics.some((d) => d.fix)) {
      const result = applyFixes(text, diagnostics);
      if (result.applied) {
        text = result.text;
        fs.writeFileSync(file, text);
        fixed = result.applied;
        diagnostics = await check(text);
      }
    }
    report.push({ file, diagnostics, ...(fixed ? { fixed } : {}) });
  }

  const all = report.flatMap((r) => r.diagnostics);
  const errors = all.filter((d) => d.severity === 'error').length;
  const warnings = all.filter((d) => d.severity === 'warning').length + configProblems;

  if (json) {
    process.stdout.write(JSON.stringify({ files: report, errors, warnings }, null, 2) + '\n');
  } else {
    const color = process.stdout.isTTY;
    const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
    const sev = { error: paint(31, 'error'), warning: paint(33, 'warning'), info: paint(36, 'info'), hint: paint(90, 'hint') };
    for (const r of report) {
      if (r.fixed) console.log(`${r.file}: applied ${r.fixed} fix(es)`);
      for (const d of r.diagnostics) {
        console.log(`${r.file}:${d.line + 1}:${d.column + 1}  ${sev[d.severity]}  ${d.message}  ${paint(90, d.code)}`);
      }
    }
    console.log(`\n${files.length} file(s) checked: ${errors} error(s), ${warnings} warning(s).`);
  }
  return errors > 0 || (strict && warnings > 0) ? 1 : 0;
}

/** Rule settings for a file: from `--config`, else the nearest config file. */
function configFor(file: string, configFile?: string, cache?: Map<string, LoadedConfig>): LoadedConfig {
  if (!configFile) return loadRuleConfig(file, cache);
  const key = `explicit:${configFile}`;
  const cached = cache?.get(key);
  if (cached) return cached;
  const config = fs.existsSync(configFile) ? readConfigFile(configFile) : { file: configFile, rules: {}, problems: ['Config file not found.'] };
  cache?.set(key, config);
  return config;
}

function fmt(targets: string[], check: boolean, stdout: boolean): number {
  if (stdout) {
    if (targets.length !== 1 || !fs.existsSync(targets[0]) || !fs.statSync(targets[0]).isFile()) return fail('--stdout needs exactly one file.');
    process.stdout.write(formatSmd(read(targets[0])));
    return 0;
  }
  const files = targets.flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const changed: string[] = [];
  for (const file of files) {
    const text = read(file);
    const formatted = formatSmd(text);
    if (formatted === text) continue;
    changed.push(file);
    if (!check) fs.writeFileSync(file, formatted);
    console.log(check ? `${file}: not formatted` : `${file}: formatted`);
  }
  console.log(`
${files.length} file(s) checked: ${changed.length} ${check ? 'need formatting' : 'formatted'}.`);
  return check && changed.length ? 1 : 0;
}

function tasks(targets: string[], all: boolean, mine: string | undefined, json: boolean, today?: string): number {
  const files = targets.flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const rows: Array<TaskInfo & { file: string }> = [];
  for (const file of files) {
    for (const t of extractTasks(read(file), today)) {
      if (!all && t.done) continue;
      if (mine && !t.assignees.some((a) => a.toLowerCase() === mine.toLowerCase())) continue;
      rows.push({ ...t, file });
    }
  }
  const rank = (p?: string) => {
    const k = (p ?? '').toLowerCase();
    return ({ p0: 0, critical: 0, p1: 1, high: 1, p2: 2, medium: 2, p3: 3, low: 3, p4: 4 } as Record<string, number>)[k] ?? 5;
  };
  rows.sort((a, b) => Number(b.overdue ?? false) - Number(a.overdue ?? false) || rank(a.priority) - rank(b.priority)
    || (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.file.localeCompare(b.file) || a.line - b.line);
  if (json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  for (const r of rows) {
    const bits = [
      r.done ? '[x]' : '[ ]',
      r.priority ? `[${r.priority}]` : '',
      r.text,
      r.assignees.length ? r.assignees.join(' ') : '',
      r.due ? `(due ${r.due}${r.overdue ? ', OVERDUE' : ''})` : '',
    ].filter(Boolean);
    console.log(`${r.file}:${r.line + 1}  ${bits.join(' ')}${r.section ? `  — ${r.section}` : ''}`);
  }
  console.error(`[smd] ${rows.length} task(s)${all ? '' : ' open'}${rows.some((r) => r.overdue) ? `, ${rows.filter((r) => r.overdue).length} overdue` : ''}.`);
  return 0;
}

interface QueryFlags { json: boolean; titles: boolean; brief: boolean; lineRefs: boolean; today?: string }
type QueryRow = QueryMatch & { file: string };

function query(selector: string | undefined, targets: string[], flags: QueryFlags): number {
  if (!selector) return fail('Usage: smd query "<selector>" <files|dirs...>, e.g. smd query "decision[status=accepted]" docs/');
  let selectors: Selector[];
  try {
    selectors = parseSelector(selector);
  } catch (e) {
    if (e instanceof SelectorError) return fail(e.message);
    throw e;
  }
  const files = (targets.length ? targets : ['.']).flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const options = { brief: flags.brief, lineRefs: flags.lineRefs, today: flags.today };
  const rows: QueryRow[] = files.flatMap((file) => querySmd(read(file), selectors, options).map((m) => ({ file, ...m })));
  if (flags.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  } else if (rows.length) {
    const blocks = rows.map((r) => (flags.titles ? titleLine(r) : `${location(r)}\n${r.text}\n`));
    process.stdout.write(blocks.join('\n').trimEnd() + '\n');
  }
  console.error(`[smd] ${rows.length} match(es) in ${new Set(rows.map((r) => r.file)).size} of ${files.length} file(s).`);
  return rows.length ? 0 : 1;
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

function outlineFile(file: string, related: boolean, today?: string): number {
  const text = read(file);
  process.stdout.write(outline(text, { readFile: readerFor(file), today }));
  if (related) process.stdout.write(relatedBlock(file, text, today));
  return 0;
}

/** `smd outline --related`: the related documents, with paths relative to the working directory. */
function relatedBlock(file: string, text: string, today?: string): string {
  const dir = path.dirname(path.resolve(file));
  const docs = relatedDocs(text, { readFile: readerFor(file), today })
    .map((d) => (d.path === undefined ? d : { ...d, path: displayPath(dir, d.path) }));
  const block = formatRelated(docs);
  return block ? '\n' + block : '';
}

function displayPath(dir: string, rel: string): string {
  return relativePath(path.resolve(dir, rel));
}

function index(targets: string[], out: string | undefined, compact: boolean, today?: string): number {
  const files = (targets.length ? targets : ['.']).flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const documents = files.map((file) => ({ path: relativePath(file), text: read(file) }));
  const catalog = smdIndex(documents, { today, generator: `smd ${pkg.version}` });
  const json = compact ? JSON.stringify(catalog) : JSON.stringify(catalog, null, 2);
  const tokens = catalog.documents.reduce((sum, d) => sum + d.tokens.agent, 0);
  console.error(`[smd] ${catalog.documents.length} document(s) indexed, ≈${tokens} tokens in full agent view.`);
  return write(out, json + '\n');
}

/** `docs/plan.smd`: relative to the working directory, with forward slashes on every platform. */
function relativePath(file: string): string {
  return path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/');
}

function installSkills(dir: string, only?: string): number {
  const chosen = SKILLS.filter((sk) => !only || sk.name.endsWith(only));
  if (!chosen.length) return fail('--only must be "reader" or "writer".');
  for (const skill of chosen) {
    const target = path.resolve(dir, skill.name);
    for (const [rel, content] of Object.entries(skill.files)) {
      fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
      fs.writeFileSync(path.join(target, rel), content);
    }
    // Bundle this very CLI (one self-contained file) so the skill works without npm.
    fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
    fs.copyFileSync(__filename, path.join(target, 'scripts', 'smd.cjs'));
    console.log(`Installed ${skill.name.padEnd(24)} → ${target}  (${skill.summary})`);
  }
  return 0;
}

function collect(target: string): string[] {
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

function existsFrom(file: string) {
  const dir = path.dirname(path.resolve(file));
  return (rel: string) => fs.existsSync(path.resolve(dir, rel));
}

/**
 * File reader for code embeds. Only files inside the current working directory, the enclosing Git repository or the
 * document's own folder can be embedded, so a document cannot pull in e.g. ~/.ssh keys.
 */
function readerFor(file: string) {
  const dir = path.dirname(path.resolve(file));
  const roots = [path.resolve(process.cwd()), dir];
  // Also allow the enclosing Git repository (docs/ commonly embeds ../src/…).
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { roots.push(d); break; }
    if (path.dirname(d) === d) break;
  }
  return (rel: string): string | undefined => {
    const target = path.resolve(dir, rel);
    if (!roots.some((r) => target === r || target.startsWith(r + path.sep))) return undefined;
    try { return fs.readFileSync(target, 'utf8'); } catch { return undefined; }
  };
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function requireFile(file: string | undefined): string {
  if (!file || !fs.existsSync(file)) {
    console.error(file ? `Not found: ${file}` : 'Missing file argument.');
    process.exit(2);
  }
  return file;
}

function write(target: string | undefined, content: string): number {
  if (target) {
    fs.writeFileSync(target, content);
    console.error(`Wrote ${target}`);
  } else {
    process.stdout.write(content);
  }
  return 0;
}

function fail(message: string): number {
  console.error(message);
  return 2;
}

void Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
