import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  agentView, applyFixes, decisionLog, decisionLogMarkdown, diffSmd, formatRelated, formatSmd, getDocumentInfo, markdownToSmd, outline,
  parseSelector, relatedDocs, renderPage, smdIndex, smdToMarkdown, statusChanges, statusReportMarkdown, suggest, DECISION_STATUS_FILTERS, SelectorError, SMD_VERSION, type AgentViewOptions, type AgentViewResult, type BudgetResult, type Diagnostic,
  type DiffResult, type ReportDocument, type Selector, type Tokenizer,
} from './core';
import { loadMermaidParser } from './mermaidLoader';
import { loadTokenizer, TokenizerError, TOKENIZERS } from './tokenizer';
import { loadRuleConfig, readConfigFile, type LoadedConfig } from './config';
import { runMcpServer } from './mcp';
import { AGENT_RULES, fillTemplate, SKILLS, TEMPLATES } from './skillsBundle';
import {
  parseTargets, rulesBody, SHARED_CLI_COMMAND, SHARED_CLI_PATH, TARGET_FILES, type AgentTarget, type RulesTarget, type TargetFile,
} from './agentTargets';
import {
  collect, decisionLine, decisionSummary, deletedSince, diagnose, existsFrom, git, gitPath, queryRows, querySummary, queryText, read, readerFor,
  reportSummary, taskLine, taskRows, taskSummary, workingPath,
} from './workspace';
// Injected by scripts/build.mjs. package.json itself stays out of the bundle, so editing its
// scripts or dependencies doesn't change the CLI's bytes (and the copies bundled in skills/).
declare const __SMD_PKG_VERSION__: string;
const pkg = { version: typeof __SMD_PKG_VERSION__ === 'string' ? __SMD_PKG_VERSION__ : '0.0.0-dev' };

const HELP = `smd — Styled Markdown tool (spec v${SMD_VERSION})

Reading (token-efficient, for agents):
  smd outline <file.smd> [--related] [--tokenizer <name>]
      Sections with line ranges and token costs, open tasks, where agent instructions are.
      --related    also list the front matter "related:" documents: title, status, summary and cost
  smd agent <file.smd> [--section "<heading>"]... [--brief] [--include-human] [--embed] [--no-lines]
                       [--max-tokens <n>] [--tokenizer <name>]
      Compact agent view: styling, layout and human-only content removed; meaning kept.
      --section    only these sections (repeatable; agent instructions elsewhere are still included)
      --brief      also condense diagrams, long code, :::details and completed tasks
      --embed      inline file="…" code embeds instead of referencing the file
      --max-tokens fit the view into n tokens: condense as --brief, then replace the least important
                   sections with one-line pointers (never the header, agent instructions or --section)
      --tokenizer  exact counts next to the ≈ estimate (also on outline, and used by --max-tokens) for an
                   OpenAI encoding: ${TOKENIZERS.join(', ')}. Approximate for Claude models.
                   Needs the js-tiktoken package in your project or installed globally; smd doesn't bundle it.
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
  smd diff <old.smd> <new.smd> [--json] [--brief] [--no-lines] [--exit-code]
  smd diff <files|dirs...> --since <git-ref> [--json] [--brief] [--no-lines] [--exit-code]
      Only the sections that changed, in the agent view of the new version: front-matter changes,
      then changed, renamed and added sections, then removed ones (heading and old lines only).
      --since      compare each .smd file with its version at a Git commit, branch or tag
      --exit-code  exit 1 when something changed (like git diff); the default is 0
  smd meta <file.smd> [--no-diagnostics]
      Full JSON summary: front matter, outline, tasks, decisions, risks, agent blocks.
  smd decisions <files|dirs...> [--status <list>] [--owner @name] [--json] [--md] [-o <file>] [--title "…"]
      Decision log (ADR index): every :::decision across documents, newest first and undated last, with
      date, status, title, owner, file:line and document › section.
      --status  only these statuses, comma-separated: ${DECISION_STATUS_FILTERS.join(', ')} (open = proposed)
      --owner   only decisions owned by @name
      --md      an ADR index to commit: front matter and a table linking each decision (--title sets its title).
                Links are relative to the -o file: smd decisions docs/ --md -o docs/decisions.smd
  smd report <files|dirs...> --since <date|git-ref> [-o report.smd] [--title "…"] [--today YYYY-MM-DD]
      Draft a status report (the status-report template) from how tasks and decisions changed since a Git
      commit, branch or tag, or a date (the last commit before it): done and new tasks, open tasks with
      overdue and due in the next 7 days, decisions since and still needed, open high-impact risks, and
      links to each source section. Tasks are matched by document and text, so a reworded task counts
      as removed and added. Without Git history, a date reports the current state only.
      -o        write the draft there (never over an existing file); links are relative to it
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

Agent integration:
  smd mcp [--root <dir>]
      Model Context Protocol server over stdio with the tools outline, section, agent, tasks, validate
      and query. Only .smd files inside --root (default: the current directory) can be read.
      Register it, e.g.: claude mcp add smd -- npx -y -p styled-markdown smd mcp

Agent skills:
  smd skills install [--dir <skills-dir>] [--global] [--only reader|writer]
      Install the agent skills (each with this CLI bundled) into .claude/skills (default),
      a custom directory, or ~/.claude/skills (--global):
        styled-markdown-reader   read .smd token-efficiently
        styled-markdown-writer   create/edit .smd following the rules
  smd skills install --target <claude|cursor|copilot|agents>[,…] [--dir <project>]
      Install for other agents too (repeatable or comma-separated; default: claude). Other targets write
      reading/writing rules into the project (--dir, default: current folder) and this CLI to .smd/smd.cjs:
        cursor    .cursor/rules/styled-markdown.mdc (applies to **/*.smd)
        copilot   .github/instructions/styled-markdown.instructions.md (applies to **/*.smd)
        agents    a styled-markdown section in AGENTS.md (created, or replaced between its markers)
`;

const SKILLS_USAGE = 'Usage: smd skills install [--dir <dir>] [--global] [--only reader|writer] [--target claude|cursor|copilot|agents]';

interface Args { command?: string; positional: string[]; flags: Set<string>; values: Map<string, string[]> }

const VALUE_OPTIONS = new Set([
  '--config', '--stale-after', '-o', '--title', '--section', '--dir', '--mine', '--today', '--template', '--only', '--root', '--target', '--since',
  '--max-tokens', '--tokenizer', '--status', '--owner',
]);

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
      return outlineFile(requireFile(positional[0]), flags.has('--related'), today, value('--tokenizer'));
    case 'agent':
      return agentFile(requireFile(positional[0]), args, today);
    case 'tasks':
      return tasks(positional.length ? positional : ['.'], flags.has('--all'), value('--mine'), flags.has('--json'), today);
    case 'query':
      return query(positional[0], positional.slice(1), { json: flags.has('--json'), titles: flags.has('--titles'), brief: flags.has('--brief'), lineRefs: !flags.has('--no-lines'), today });
    case 'diff':
      return diff(positional, value('--since'), { json: flags.has('--json'), brief: flags.has('--brief'), lineRefs: !flags.has('--no-lines'), exitCode: flags.has('--exit-code'), today });
    case 'meta': {
      const file = requireFile(positional[0]);
      const rules = configFor(file, value('--config')).rules;
      const info = getDocumentInfo(read(file), { fileExists: existsFrom(file), readFile: readerFor(file), today, rules, staleAfterDays });
      if (flags.has('--no-diagnostics')) delete (info as Partial<typeof info>).diagnostics;
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
      return 0;
    }
    case 'decisions':
      return decisions(positional, args);
    case 'report':
      return report(positional, args);
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
    case 'mcp':
      return mcp(value('--root'));
    case 'skills':
      return skillsCommand(args);
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
    const check = (text: string) => diagnose(text, file, { rules: config.rules, today, staleAfterDays, parse });
    const text = read(file);
    const result = fix ? await fixUntilStable(text, check) : { text, diagnostics: await check(text), applied: 0 };
    if (result.applied) fs.writeFileSync(file, result.text);
    report.push({ file, diagnostics: result.diagnostics, ...(result.applied ? { fixed: result.applied } : {}) });
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

/** Rounds of `--fix`: one fix can make another possible, e.g. a code block closed before its container. */
const FIX_PASSES = 5;

/** Apply fixes and check again until none apply, so `--fix` leaves nothing it could still fix. */
async function fixUntilStable(
  text: string, check: (text: string) => Promise<Diagnostic[]>,
): Promise<{ text: string; diagnostics: Diagnostic[]; applied: number }> {
  let current = text;
  let diagnostics = await check(current);
  let applied = 0;
  for (let pass = 0; pass < FIX_PASSES; pass++) {
    const result = applyFixes(current, diagnostics);
    if (!result.applied) break;
    current = result.text;
    applied += result.applied;
    diagnostics = await check(current);
  }
  return { text: current, diagnostics, applied };
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
  const rows = taskRows(files, { all, mine, today });
  if (json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  for (const r of rows) console.log(taskLine(r));
  console.error(`[smd] ${taskSummary(rows, all)}`);
  return 0;
}

interface QueryFlags { json: boolean; titles: boolean; brief: boolean; lineRefs: boolean; today?: string }

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
  const rows = queryRows(files, selectors, options);
  process.stdout.write(flags.json ? JSON.stringify(rows, null, 2) + '\n' : queryText(rows, flags.titles));
  console.error(`[smd] ${querySummary(rows, files.length)}`);
  return rows.length ? 0 : 1;
}

async function mcp(root = '.'): Promise<number> {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return fail(`--root must be a folder: ${root}`);
  await runMcpServer({ root, version: pkg.version });
  return 0;
}

function outlineFile(file: string, related: boolean, today?: string, tokenizerName?: string): number {
  return withTokenizer(tokenizerName, (tokenizer) => {
    const text = read(file);
    process.stdout.write(outline(text, { readFile: readerFor(file), today, tokenizer }));
    if (related) process.stdout.write(relatedBlock(file, text, today));
    return 0;
  });
}

/** Run with the `--tokenizer` given (if any), or fail with its install hint. */
function withTokenizer(name: string | undefined, run: (tokenizer?: Tokenizer) => number): number {
  if (name === undefined) return run(undefined);
  let tokenizer: Tokenizer;
  try {
    tokenizer = loadTokenizer(name);
  } catch (e) {
    if (e instanceof TokenizerError) return fail(e.message);
    throw e;
  }
  return run(tokenizer);
}

function agentFile(file: string, args: Args, today?: string): number {
  const raw = args.values.get('--max-tokens')?.[0];
  const maxTokens = raw === undefined ? undefined : Number(raw);
  if (maxTokens !== undefined && !(Number.isInteger(maxTokens) && maxTokens > 0)) {
    return fail('--max-tokens needs a whole number of tokens, e.g. --max-tokens 2000.');
  }
  return withTokenizer(args.values.get('--tokenizer')?.[0], (tokenizer) => printAgentView(file, args, { maxTokens, tokenizer, today }));
}

function printAgentView(file: string, args: Args, extra: Pick<AgentViewOptions, 'maxTokens' | 'tokenizer' | 'today'>): number {
  const sections = args.values.get('--section');
  const result = agentView(read(file), {
    sections,
    brief: args.flags.has('--brief'),
    includeHuman: args.flags.has('--include-human'),
    embed: args.flags.has('--embed'),
    lineRefs: !args.flags.has('--no-lines'),
    readFile: readerFor(file),
    file,
    ...extra,
  });
  if (result.missingSections.length) {
    console.error(`No section matching: ${result.missingSections.join(', ')}. Run "smd outline ${file}" to list sections.`);
    if (result.missingSections.length === (sections?.length ?? 0)) return 1;
  }
  process.stdout.write(result.text);
  console.error(sizeLine(result));
  if (result.budget) for (const line of budgetLines(result.budget, result.counted?.tokenizer)) console.error(line);
  return 0;
}

/** `[smd] ≈1531 tokens (file ≈2430, 37% smaller)`, with a tokenizer `[smd] ≈1531 est · 1402 o200k_base tokens (…)` */
function sizeLine(result: AgentViewResult): string {
  const counted = result.counted;
  const [tokens, original] = counted ? [counted.tokens, counted.originalTokens] : [result.tokens, result.originalTokens];
  const saved = original ? Math.round((1 - tokens / original) * 100) : 0;
  if (!counted) return `[smd] ≈${tokens} tokens (file ≈${original}, ${saved}% smaller)`;
  const exact = counted.tokenizer;
  return `[smd] ≈${result.tokens} est · ${tokens} ${exact} tokens (file ≈${result.originalTokens} est · ${original} ${exact}, ${saved}% smaller)`;
}

/** What `--max-tokens` did, and a warning when even the smallest view is over the budget. */
function budgetLines(budget: BudgetResult, tokenizer?: string): string[] {
  const unit = tokenizer ? `${tokenizer} tokens` : 'tokens';
  const size = tokenizer ? `${budget.tokens} ${unit}` : `≈${budget.tokens} ${unit}`;
  const steps = [
    budget.condensed ? 'condensed as --brief' : '',
    budget.omitted.length ? `omitted ${budget.omitted.length} section(s): ${budget.omitted.map(omittedLabel).join(', ')}` : '',
  ].filter(Boolean);
  const lines = [`[smd] budget ${budget.maxTokens} ${unit}: ${steps.join('; ') || 'fits as is'}; now ${size}.`];
  if (!budget.fits) {
    lines.push(`[smd] warning: still over the budget of ${budget.maxTokens} ${unit}. The header, agent instructions and `
      + 'requested sections are never omitted; ask for fewer sections or a larger budget.');
  }
  return lines;
}

function omittedLabel(o: BudgetResult['omitted'][number]): string {
  return `${'#'.repeat(o.level)} ${o.heading} (≈${o.tokens})`;
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

/** `smd decisions`: the decision log as text, JSON (`--json`) or an ADR index document (`--md`). */
function decisions(targets: string[], args: Args): number {
  const status = statusFilter(args.values.get('--status'));
  if (typeof status === 'string') return fail(status);
  const files = (targets.length ? targets : ['.']).flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const documents = files.map((file) => ({ path: relativePath(file), text: read(file) }));
  const rows = decisionLog(documents, { status, owner: args.values.get('--owner')?.[0] });
  const out = args.values.get('-o')?.[0];
  console.error(`[smd] ${decisionSummary(rows, files.length)}`);
  if (args.flags.has('--json')) return write(out, JSON.stringify(rows, null, 2) + '\n');
  if (!args.flags.has('--md')) return write(out, rows.map((r) => decisionLine(r) + '\n').join(''));
  const base = out ? path.dirname(path.resolve(out)) : process.cwd();
  const link = (p: string) => path.relative(base, path.resolve(p)).split(path.sep).join('/');
  return write(out, decisionLogMarkdown(rows, { title: args.values.get('--title')?.[0], link }));
}

/** `smd report`: a draft status report comparing the documents with their version at --since. */
function report(positional: string[], args: Args): number {
  const since = args.values.get('--since')?.[0];
  if (!since || since.startsWith('-')) return fail('report needs --since <date|git-ref>, e.g. smd report docs/ --since 2026-09-01 -o status.smd');
  const out = args.values.get('-o')?.[0];
  if (out && fs.existsSync(out)) return fail(`${out} already exists. The report is a draft to edit: choose another -o file or remove it first.`);
  const targets = positional.length ? positional : ['.'];
  const files = targets.filter((t) => fs.existsSync(t)).flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const base = baseline(since, targets, files);
  if (typeof base === 'string') return fail(base);
  const options = { since, revision: base.revision, today: args.values.get('--today')?.[0], title: args.values.get('--title')?.[0] };
  const changes = statusChanges(base.before, files.map((file) => ({ path: relativePath(file), text: read(file) })), options);
  console.error(`[smd] ${reportSummary(changes, files.length, since, base.revision)}`);
  const dir = out ? path.dirname(path.resolve(out)) : process.cwd();
  const link = (p: string) => path.relative(dir, path.resolve(p)).split(path.sep).join('/');
  return write(out, statusReportMarkdown(changes, { ...options, link }));
}

interface Baseline { before: ReportDocument[] | null; revision?: string }

/** The documents at --since: a Git revision, or the last commit before a date. Null without history; a message on error. */
function baseline(since: string, targets: string[], files: string[]): Baseline | string {
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(since);
  const top = git(['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return isDate ? { before: null } : `--since ${since} needs a Git repository; outside one, give a date (YYYY-MM-DD) to report the current state.`;
  const commit = isDate ? git(['rev-list', '-1', `--before=${since}T00:00:00`, 'HEAD']) : git(['rev-parse', '--verify', '--quiet', `${since}^{commit}`]);
  if (commit === undefined) return isDate ? { before: null } : `Unknown Git revision "${since}".`;
  // No commit before the date: the documents didn't exist yet, so every task is new.
  if (!commit.trim()) return { before: [], revision: 'before the first commit' };
  return { before: versionAt(commit.trim(), top, targets, files), revision: commit.trim().slice(0, 7) };
}

/** The documents as they were at a commit, including ones deleted since, labelled with their working-tree paths. */
function versionAt(commit: string, top: string, targets: string[], files: string[]): ReportDocument[] {
  const at = (topPath: string, file: string): ReportDocument[] => {
    const text = git(['show', `${commit}:${topPath}`]);
    return text === undefined ? [] : [{ path: relativePath(file), text }];
  };
  return [
    ...files.flatMap((file) => at(gitPath(top, file), file)),
    ...deletedSince(commit, targets, top).flatMap((p) => at(p, workingPath(top, p))),
  ];
}

/** `--status accepted,open` (repeatable) as a list; a message when a status is unknown. */
function statusFilter(values: string[] | undefined): string[] | string | undefined {
  if (!values) return undefined;
  const list = values.flatMap((v) => v.split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const known = `Statuses: ${DECISION_STATUS_FILTERS.join(', ')} (open = proposed).`;
  if (!list.length) return `--status needs one or more decision statuses. ${known}`;
  const unknown = list.find((s) => !DECISION_STATUS_FILTERS.includes(s));
  if (unknown === undefined) return list;
  const hint = suggest(unknown, DECISION_STATUS_FILTERS);
  const didYouMean = hint ? ` Did you mean "${hint}"?` : '';
  return `Unknown decision status "${unknown}".${didYouMean} ${known}`;
}

/** `docs/plan.smd`: relative to the working directory, with forward slashes on every platform. */
function relativePath(file: string): string {
  return path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/');
}

/** `smd skills install [--target …]`: Claude skills (the default) and/or instruction files for other agents. */
function skillsCommand(args: Args): number {
  if (args.positional[0] !== 'install') return fail(SKILLS_USAGE);
  let targets: AgentTarget[];
  try {
    targets = parseTargets(args.values.get('--target') ?? []);
  } catch (e) {
    return fail((e as Error).message);
  }
  const problem = targetOptionsProblem(targets, args);
  if (problem) return fail(problem);
  const others = targets.filter((t): t is RulesTarget => t !== 'claude');
  const code = targets.includes('claude') ? installSkills(claudeSkillsDir(args), args.values.get('--only')?.[0]) : 0;
  return code || !others.length ? code : installAgentRules(others, args.values.get('--dir')?.[0] ?? '.');
}

function claudeSkillsDir(args: Args): string {
  if (args.flags.has('--global')) return path.join(os.homedir(), '.claude', 'skills');
  return args.values.get('--dir')?.[0] ?? path.join('.claude', 'skills');
}

/** Options that only make sense for the Claude skills, or that would mean two different folders at once. */
function targetOptionsProblem(targets: AgentTarget[], args: Args): string | undefined {
  const claude = targets.includes('claude');
  const others = targets.length > (claude ? 1 : 0);
  if (!others) return undefined;
  if (args.flags.has('--global')) return '--global only applies to --target claude. Install rules for other agents per project (--dir <project>).';
  if (!claude && args.values.has('--only')) return '--only only applies to --target claude. The rules for other agents cover reading and writing.';
  if (claude && args.values.has('--dir')) return '--dir is the skills folder for --target claude but the project root for other targets. Install them in separate runs.';
  return undefined;
}

/** Writes the shared CLI to <root>/.smd/smd.cjs and each target's instruction file. */
function installAgentRules(targets: RulesTarget[], root: string): number {
  const cli = path.resolve(root, SHARED_CLI_PATH);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.copyFileSync(__filename, cli);
  console.log(`Installed smd CLI → ${cli}  (agents run it as: ${SHARED_CLI_COMMAND})`);
  const body = rulesBody(AGENT_RULES);
  try {
    for (const target of targets) writeTargetFile(TARGET_FILES[target], root, body);
  } catch (e) {
    return fail((e as Error).message);
  }
  return 0;
}

function writeTargetFile(spec: TargetFile, root: string, body: string): void {
  const file = path.resolve(root, spec.file);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  const content = spec.render(body, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const verb = existing === undefined ? 'Created' : 'Updated';
  console.log(`${verb} ${file}  (${spec.label})`);
}

interface DiffFlags { json: boolean; brief: boolean; lineRefs: boolean; exitCode: boolean; today?: string }
interface FileDiff { file: string; status: 'changed' | 'added' | 'deleted'; result: DiffResult }

function diff(positional: string[], since: string | undefined, flags: DiffFlags): number {
  if (since !== undefined) return diffSince(positional.length ? positional : ['.'], since, flags);
  if (positional.length !== 2) return fail('Usage: smd diff <old.smd> <new.smd>, or smd diff <files|dirs...> --since <git-ref>');
  const [oldFile, newFile] = positional.map((f) => requireFile(f));
  const result = diffSmd(read(oldFile), read(newFile), flags);
  const diffs: FileDiff[] = result.text ? [{ file: newFile, status: 'changed', result }] : [];
  return reportDiffs(diffs, 1, { oldFile }, flags);
}

/** Each .smd file under the targets against its version at a Git revision, including files deleted since. */
function diffSince(targets: string[], ref: string, flags: DiffFlags): number {
  if (!ref || ref.startsWith('-')) return fail('--since needs a Git commit, branch or tag, e.g. --since HEAD~1');
  const top = git(['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return fail('--since needs a Git repository: run smd diff inside one.');
  if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) === undefined) return fail(`Unknown Git revision "${ref}".`);
  const files = targets.filter((t) => fs.existsSync(t)).flatMap((t) => collect(t));
  const deleted = deletedSince(ref, targets, top);
  if (!files.length && !deleted.length) return fail('No .smd files found.');
  const diffs = [
    ...files.map((file) => fileSince(file, ref, top, flags)),
    ...deleted.map((p) => deletedFile(p, ref, top, flags)),
  ];
  return reportDiffs(diffs.filter((d) => d.status !== 'changed' || d.result.text), files.length + deleted.length, { since: ref }, flags);
}

function fileSince(file: string, ref: string, top: string, flags: DiffFlags): FileDiff {
  const old = git(['show', `${ref}:${gitPath(top, file)}`]);
  const text = read(file);
  const result = diffSmd(old ?? '', text, flags);
  if (old !== undefined) return { file, status: 'changed', result };
  // A new file: its whole agent view reads better than every section labelled "added".
  const view = agentView(text, { brief: flags.brief, lineRefs: flags.lineRefs, readFile: readerFor(file), today: flags.today });
  return { file, status: 'added', result: { ...result, text: view.text, tokens: view.tokens } };
}

function deletedFile(topPath: string, ref: string, top: string, flags: DiffFlags): FileDiff {
  const file = workingPath(top, topPath);
  return { file, status: 'deleted', result: diffSmd(git(['show', `${ref}:${topPath}`]) ?? '', '', flags) };
}

function reportDiffs(diffs: FileDiff[], checked: number, base: { since?: string; oldFile?: string }, flags: DiffFlags): number {
  const context = base.since ? `since ${base.since}` : `compared with ${base.oldFile}`;
  if (flags.json) {
    const rows = diffs.map((d) => ({ file: d.file, status: d.status, ...base, frontMatter: d.result.frontMatter, sections: d.result.sections, tokens: d.result.tokens }));
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  } else if (diffs.length) {
    process.stdout.write(diffs.map((d) => `${d.file}: ${d.status} ${context}\n\n${d.result.text}`).join('\n'));
  }
  const tokens = diffs.reduce((n, d) => n + d.result.tokens, 0);
  const full = diffs.filter((d) => d.status !== 'deleted').reduce((n, d) => n + d.result.fullTokens, 0);
  const saved = tokens < full ? `, ${Math.round((1 - tokens / full) * 100)}% smaller` : '';
  console.error(`[smd] ${diffs.length} of ${checked} file(s) changed ${context}: ≈${tokens} tokens (full agent view ≈${full}${saved})`);
  return flags.exitCode && diffs.length ? 1 : 0;
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
