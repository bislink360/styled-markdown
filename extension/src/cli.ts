import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  agentView, applyFixes, extractTasks, formatSmd, getDocumentInfo, markdownToSmd, outline, renderPage, smdToMarkdown,
  validateSmd, SMD_VERSION, type Diagnostic, type TaskInfo,
} from './core';
import { fillTemplate, SKILLS, TEMPLATES } from './skillsBundle';
// Injected by scripts/build.mjs. package.json itself stays out of the bundle, so editing its
// scripts or dependencies doesn't change the CLI's bytes (and the copies bundled in skills/).
declare const __SMD_PKG_VERSION__: string;
const pkg = { version: typeof __SMD_PKG_VERSION__ === 'string' ? __SMD_PKG_VERSION__ : '0.0.0-dev' };

const HELP = `smd — Styled Markdown tool (spec v${SMD_VERSION})

Reading (token-efficient, for agents):
  smd outline <file.smd>
      Sections with line ranges and token costs, open tasks, where agent instructions are.
  smd agent <file.smd> [--section "<heading>"]... [--brief] [--include-human] [--embed] [--no-lines]
      Compact agent view: styling, layout and human-only content removed; meaning kept.
      --section    only these sections (repeatable; agent instructions elsewhere are still included)
      --brief      also condense diagrams, long code, :::details and completed tasks
      --embed      inline file="…" code embeds instead of referencing the file
  smd tasks <files|dirs...> [--all] [--mine @name] [--json]
      Open tasks across documents with owner, priority and due date (overdue first).
  smd meta <file.smd> [--no-diagnostics]
      Full JSON summary: front matter, outline, tasks, decisions, risks, agent blocks.

Checking and converting:
  smd validate <files|dirs...> [--json] [--fix] [--strict] [--stale-after <days>]
      Check .smd files. Exit code 1 on errors (or warnings with --strict). --fix applies safe fixes.
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

const VALUE_OPTIONS = new Set(['--stale-after', '-o', '--title', '--section', '--dir', '--mine', '--today', '--template', '--only']);

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

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const { command, positional, flags } = args;
  const value = (name: string) => args.values.get(name)?.[0];
  const today = value('--today');
  const staleAfter = value('--stale-after');
  const staleAfterDays = staleAfter === undefined ? undefined : Number(staleAfter);
  if (staleAfterDays !== undefined && !(staleAfterDays >= 0)) return fail('--stale-after needs a number of days (0 turns the check off).');

  switch (command) {
    case 'outline': {
      const file = requireFile(positional[0]);
      process.stdout.write(outline(read(file), { readFile: readerFor(file), today }));
      return 0;
    }
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
    case 'meta': {
      const file = requireFile(positional[0]);
      const info = getDocumentInfo(read(file), { fileExists: existsFrom(file), readFile: readerFor(file), today, staleAfterDays });
      if (flags.has('--no-diagnostics')) delete (info as Partial<typeof info>).diagnostics;
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
      return 0;
    }
    case 'validate':
      return validate(positional.length ? positional : ['.'], flags.has('--json'), flags.has('--fix'), flags.has('--strict'), today, staleAfterDays);
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

function validate(targets: string[], json: boolean, fix: boolean, strict: boolean, today?: string, staleAfterDays?: number): number {
  const files = targets.flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const report: Array<{ file: string; diagnostics: Diagnostic[]; fixed?: number }> = [];
  for (const file of files) {
    const opts = { fileExists: existsFrom(file), readFile: readerFor(file), today, staleAfterDays };
    let text = read(file);
    let diagnostics = validateSmd(text, opts);
    let fixed: number | undefined;
    if (fix && diagnostics.some((d) => d.fix)) {
      const result = applyFixes(text, diagnostics);
      if (result.applied) {
        text = result.text;
        fs.writeFileSync(file, text);
        fixed = result.applied;
        diagnostics = validateSmd(text, opts);
      }
    }
    report.push({ file, diagnostics, ...(fixed ? { fixed } : {}) });
  }

  const all = report.flatMap((r) => r.diagnostics);
  const errors = all.filter((d) => d.severity === 'error').length;
  const warnings = all.filter((d) => d.severity === 'warning').length;

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

process.exitCode = main(process.argv.slice(2));
