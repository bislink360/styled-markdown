#!/usr/bin/env node
// Styled Markdown release gate.
//
// Compares the working tree with the last released tag across every public surface
// (format vocabulary, validation, rendering, agent view, CLI, npm API, VS Code manifest,
// skills), runs the test suites, checks version consistency, and derives the minimum
// semver bump. Prints a Markdown report; exits 1 when something blocks the release.
//
//   node .claude/skills/smd-release/scripts/release-check.mjs [--base v1.0.0] [--skip-vscode] [--skip-tests] [--out report.md]
//
// Requires: git, Node 18+, npm. The baseline is built once in a temporary git worktree and cached.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Arguments and helpers
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const isWin = process.platform === 'win32';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function run(cmd, args, cwd, { allowFail = false, quiet = true } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: isWin, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}\n${(r.stdout || '').slice(-2000)}\n${(r.stderr || '').slice(-2000)}`);
  }
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' };
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const log = (s) => process.stderr.write(`[release-check] ${s}\n`);

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const EXT = join(ROOT, 'extension');

// Findings
const breaking = [];   // incompatible for users/agents/CI → needs a MAJOR bump
const review = [];     // behaviour changes a human must confirm are intended
const features = [];   // additive changes → at least a MINOR bump
const failures = [];   // blocks the release regardless of version
const passed = [];     // checks that ran and passed

// ---------------------------------------------------------------------------
// 1. Base version
// ---------------------------------------------------------------------------
const semver = (v) => v.replace(/^v/, '').split('.').map(Number);
const cmpSemver = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const tags = git('tag', '--list', 'v*').split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort(cmpSemver);
const BASE = option('--base') ?? tags[tags.length - 1];
if (!BASE) { console.error('No release tag (vX.Y.Z) found; pass --base.'); process.exit(2); }
log(`comparing working tree with ${BASE}`);

// ---------------------------------------------------------------------------
// 2. Versions are consistent and ahead of the base
// ---------------------------------------------------------------------------
const extPkg = readJson(join(EXT, 'package.json'));
const npmPkgPath = join(ROOT, 'npm', 'package.json');
const npmPkg = existsSync(npmPkgPath) ? readJson(npmPkgPath) : null;
const version = extPkg.version;
if (npmPkg && npmPkg.version !== version) failures.push(`Version mismatch: extension ${version} vs npm ${npmPkg.version}. They are released in lockstep.`);
if (cmpSemver(version, BASE) <= 0) failures.push(`Version ${version} is not greater than the last release ${BASE}. Bump the version on the release branch.`);
const changelogPath = join(EXT, 'CHANGELOG.md');
const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
if (!new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm').test(changelog)) {
  failures.push(`extension/CHANGELOG.md has no "## ${version}" entry.`);
}
const cliSrc = readFileSync(join(EXT, 'src', 'cli.ts'), 'utf8');
if (!/pkg\.version/.test(cliSrc)) review.push('The CLI no longer reports its version from package.json.');

// ---------------------------------------------------------------------------
// 3. Build and test the working tree
// ---------------------------------------------------------------------------
log('building working tree…');
run('npm', ['run', 'build'], EXT);
if (npmPkg) run('npm', ['run', 'build:npm'], EXT);
const NEW_CLI = join(EXT, 'dist', 'cli.js');

if (!flag('--skip-tests')) {
  log('typecheck + unit tests…');
  const tc = run('npm', ['run', 'typecheck'], EXT, { allowFail: true });
  (tc.ok ? passed : failures).push(tc.ok ? 'Typecheck' : `Typecheck failed:\n${tc.out.slice(-1500)}`);
  const ut = run('npm', ['test'], EXT, { allowFail: true });
  const summary = /ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(ut.out + ut.err);
  if (ut.ok) passed.push(`Unit tests${summary ? ` (${summary[2]}/${summary[1]})` : ''}`);
  else failures.push(`Unit tests failed${summary ? ` (${summary[3]} failing)` : ''}:\n${(ut.out + ut.err).split('\n').filter((l) => /✖|Error|expected|actual/.test(l)).slice(0, 20).join('\n')}`);
  if (!flag('--skip-vscode')) {
    log('VS Code integration tests…');
    const it = run('node', ['test/integration/run.mjs'], EXT, { allowFail: true });
    const failed = (it.out + it.err).split('\n').filter((l) => l.includes('✖'));
    if (it.ok && !failed.length) passed.push(`VS Code integration tests (${(it.out.match(/✔/g) || []).length} checks)`);
    else failures.push(`VS Code integration tests failed:\n${failed.join('\n') || (it.out + it.err).slice(-1500)}`);
  }
} else {
  review.push('Tests were skipped (--skip-tests). Run the full check before publishing.');
}

// ---------------------------------------------------------------------------
// 4. Build the baseline in a temporary worktree (cached per tag)
// ---------------------------------------------------------------------------
const cacheDir = join(tmpdir(), 'smd-release-baseline', BASE);
const baseCli = join(cacheDir, 'cli.js');
const baseNpm = join(cacheDir, 'npm');
if (!existsSync(baseCli)) {
  log(`building baseline ${BASE} (first run only)…`);
  const wt = mkdtempSync(join(tmpdir(), 'smd-base-'));
  try {
    git('worktree', 'add', '--detach', wt, BASE);
    run('npm', ['ci', '--no-audit', '--no-fund'], join(wt, 'extension'));
    run('node', ['scripts/build.mjs'], join(wt, 'extension'));
    mkdirSync(cacheDir, { recursive: true });
    cpSync(join(wt, 'extension', 'dist', 'cli.js'), baseCli);
    if (existsSync(join(wt, 'extension', 'scripts', 'build-npm.mjs')) && existsSync(join(wt, 'npm', 'package.json'))) {
      run('npm', ['run', 'build:npm'], join(wt, 'extension'));
      cpSync(join(wt, 'npm'), baseNpm, { recursive: true });
    }
  } finally {
    try { git('worktree', 'remove', '--force', wt); } catch { rmSync(wt, { recursive: true, force: true }); git('worktree', 'prune'); }
  }
}

// ---------------------------------------------------------------------------
// 5. Format vocabulary (spec.ts): removals break existing documents
// ---------------------------------------------------------------------------
const requireExt = createRequire(join(EXT, 'package.json'));
const esbuild = requireExt('esbuild');
function loadSpec(source) {
  const dir = mkdtempSync(join(tmpdir(), 'smd-spec-'));
  const file = join(dir, 'spec.ts');
  writeFileSync(file, source);
  const out = esbuild.buildSync({ entryPoints: [file], bundle: true, format: 'cjs', platform: 'node', write: false });
  const mod = { exports: {} };
  new Function('module', 'exports', out.outputFiles[0].text)(mod, mod.exports);
  rmSync(dir, { recursive: true, force: true });
  return mod.exports;
}
const oldSpec = loadSpec(git('show', `${BASE}:extension/src/core/spec.ts`));
const newSpec = loadSpec(readFileSync(join(EXT, 'src', 'core', 'spec.ts'), 'utf8'));

const diffSet = (label, a = [], b = [], { removedIs = 'breaking', addedIs = 'feature' } = {}) => {
  const A = new Set(a), B = new Set(b);
  const removed = [...A].filter((x) => !B.has(x));
  const added = [...B].filter((x) => !A.has(x));
  if (removed.length) (removedIs === 'breaking' ? breaking : review).push(`${label} removed: ${removed.join(', ')}`);
  if (added.length) (addedIs === 'feature' ? features : review).push(`${label} added: ${added.join(', ')}`);
};
if (oldSpec.SMD_VERSION !== newSpec.SMD_VERSION) breaking.push(`Spec version changed ${oldSpec.SMD_VERSION} → ${newSpec.SMD_VERSION} (documents declare \`smd: N\`).`);
diffSet('Block containers', Object.keys(oldSpec.CONTAINERS), Object.keys(newSpec.CONTAINERS));
for (const name of Object.keys(oldSpec.CONTAINERS)) {
  const o = oldSpec.CONTAINERS[name], n = newSpec.CONTAINERS[name];
  if (!n) continue;
  diffSet(`:::${name} attributes`, o.attrs, n.attrs);
  for (const [k, vals] of Object.entries(o.values ?? {})) diffSet(`:::${name} ${k} values`, vals, n.values?.[k] ?? (n.attrs?.includes(k) ? vals : []));
  for (const k of Object.keys(n.values ?? {})) if (!o.values?.[k]) review.push(`:::${name} now restricts "${k}" to: ${n.values[k].join(', ')} (previously free text).`);
  const newlyRequired = (n.required ?? []).filter((k) => !(o.required ?? []).includes(k));
  if (newlyRequired.length) breaking.push(`:::${name} now requires: ${newlyRequired.join(', ')}`);
  if ((o.parent ?? null) !== (n.parent ?? null)) review.push(`:::${name} parent rule changed: ${o.parent ?? 'none'} → ${n.parent ?? 'none'}`);
}
diffSet('Inline directives', Object.keys(oldSpec.INLINE_DIRECTIVES), Object.keys(newSpec.INLINE_DIRECTIVES));
for (const name of Object.keys(oldSpec.INLINE_DIRECTIVES)) {
  const o = oldSpec.INLINE_DIRECTIVES[name], n = newSpec.INLINE_DIRECTIVES[name];
  if (!n) continue;
  diffSet(`:${name} attributes`, o.attrs, n.attrs);
  for (const [k, vals] of Object.entries(o.values ?? {})) diffSet(`:${name} ${k} values`, vals, n.values?.[k] ?? (n.attrs?.includes(k) ? vals : []));
  for (const k of Object.keys(n.values ?? {})) if (!o.values?.[k]) review.push(`:${name} now restricts "${k}" to: ${n.values[k].join(', ')} (previously free text).`);
  if (!o.content && n.content) breaking.push(`:${name} now requires [content].`);
}
diffSet('Named colors', oldSpec.NAMED_COLORS, newSpec.NAMED_COLORS);
diffSet('Front matter keys', Object.keys(oldSpec.FRONTMATTER_KEYS), Object.keys(newSpec.FRONTMATTER_KEYS));
diffSet('Front matter status values', oldSpec.STATUS_VALUES, newSpec.STATUS_VALUES);
diffSet('Front matter audience values', oldSpec.AUDIENCE_VALUES, newSpec.AUDIENCE_VALUES);
diffSet('Style keys', Object.keys(oldSpec.STYLE_KEYS ?? {}), Object.keys(newSpec.STYLE_KEYS ?? {}));
diffSet('Mermaid diagram types accepted', oldSpec.MERMAID_TYPES, newSpec.MERMAID_TYPES);

// ---------------------------------------------------------------------------
// 6. Diagnostic rule codes: CI filters and agents key on them
// ---------------------------------------------------------------------------
const codesIn = (src) => [...new Set([...src.matchAll(/'([a-z]+\/[a-z-]+)'/g)].map((m) => m[1]))].sort();
diffSet('Diagnostic codes', codesIn(git('show', `${BASE}:extension/src/core/validate.ts`)), codesIn(readFileSync(join(EXT, 'src', 'core', 'validate.ts'), 'utf8')), { addedIs: 'review' });

// ---------------------------------------------------------------------------
// 7. Behaviour on a document corpus: validation, agent view, Markdown export, HTML
// ---------------------------------------------------------------------------
function collect(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== 'html') collect(p, out); }
    else if (e.endsWith('.smd')) out.push(p);
  }
  return out;
}
const corpus = [
  ...collect(join(ROOT, 'examples')),
  ...collect(join(ROOT, 'docs', 'gallery')),
  ...collect(join(EXT, 'test', 'compat', 'corpus')),
];
const TODAY = '2026-01-01';
const cli = (bin, args) => run('node', [bin, ...args], ROOT, { allowFail: true });
const classesIn = (html) => new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c.startsWith('smd-')));
const firstDiff = (a, b) => {
  const x = a.split('\n'), y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return `line ${i + 1}: \`${(x[i] ?? '∅').slice(0, 90)}\` → \`${(y[i] ?? '∅').slice(0, 90)}\``;
  return '';
};
log(`comparing behaviour on ${corpus.length} corpus documents…`);
const removedClasses = new Set();
for (const file of corpus) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const v = (bin) => {
    const r = cli(bin, ['validate', file, '--json', '--today', TODAY]);
    try { return JSON.parse(r.out).files[0].diagnostics; } catch { return []; }
  };
  const oldDiag = v(baseCli), newDiag = v(NEW_CLI);
  const errs = (d) => d.filter((x) => x.severity === 'error');
  if (!errs(oldDiag).length && errs(newDiag).length) {
    breaking.push(`${rel} passed validation in ${BASE} but now has ${errs(newDiag).length} error(s): ${[...new Set(errs(newDiag).map((d) => d.code))].join(', ')}`);
  }
  const newWarn = newDiag.filter((d) => d.severity === 'warning' && !oldDiag.some((o) => o.code === d.code && o.line === d.line));
  if (newWarn.length) review.push(`${rel}: ${newWarn.length} new warning(s) (${[...new Set(newWarn.map((d) => d.code))].join(', ')})`);

  for (const [label, args] of [['Agent view', ['agent', file, '--today', TODAY]], ['Markdown export', ['to-md', file]]]) {
    const a = cli(baseCli, args).out, b = cli(NEW_CLI, args).out;
    if (a !== b) review.push(`${label} of ${rel} changed (${firstDiff(a, b)})`);
  }
  const ha = cli(baseCli, ['render', file]).out, hb = cli(NEW_CLI, ['render', file]).out;
  if (ha && hb) { const nb = classesIn(hb); for (const c of classesIn(ha)) if (!nb.has(c)) removedClasses.add(c); }
}
if (removedClasses.size) review.push(`CSS classes no longer emitted in rendered HTML (custom stylesheets may target them): ${[...removedClasses].join(', ')}`);

// ---------------------------------------------------------------------------
// 8. CLI surface: commands and flags
// ---------------------------------------------------------------------------
const helpOf = (bin) => cli(bin, ['--help']).out;
const commandsOf = (h) => [...h.matchAll(/^\s+smd ([a-z-]+)/gm)].map((m) => m[1]);
const flagsOf = (h) => [...new Set([...h.matchAll(/(--[a-z][a-z-]*)/g)].map((m) => m[1]))];
const oldHelp = helpOf(baseCli), newHelp = helpOf(NEW_CLI);
diffSet('CLI commands', commandsOf(oldHelp), commandsOf(newHelp));
diffSet('CLI flags', flagsOf(oldHelp), flagsOf(newHelp));
const templatesOf = (bin) => cli(bin, ['templates']).out.split('\n').map((l) => l.split(/\s+/)[0]).filter(Boolean);
diffSet('Document templates (smd init --template)', templatesOf(baseCli), templatesOf(NEW_CLI));

// ---------------------------------------------------------------------------
// 9. npm library API
// ---------------------------------------------------------------------------
if (npmPkg) {
  const newApi = Object.keys(createRequire(import.meta.url)(join(ROOT, 'npm', 'dist', 'index.cjs')));
  if (existsSync(join(baseNpm, 'dist', 'index.cjs'))) {
    const oldApi = Object.keys(createRequire(import.meta.url)(join(baseNpm, 'dist', 'index.cjs')));
    diffSet('npm exports', oldApi, newApi);
    const oldPkg = readJson(join(baseNpm, 'package.json'));
    diffSet('npm package entry points', Object.keys(oldPkg.exports ?? {}), Object.keys(npmPkg.exports ?? {}));
    diffSet('npm bin commands', Object.keys(oldPkg.bin ?? {}), Object.keys(npmPkg.bin ?? {}));
    if (oldPkg.engines?.node !== npmPkg.engines?.node) review.push(`npm engines.node changed: ${oldPkg.engines?.node} → ${npmPkg.engines?.node}`);
    const oldTypes = readdirSync(join(baseNpm, 'dist', 'types')).map((f) => readFileSync(join(baseNpm, 'dist', 'types', f), 'utf8')).join('\n');
    const newTypes = readdirSync(join(ROOT, 'npm', 'dist', 'types')).map((f) => readFileSync(join(ROOT, 'npm', 'dist', 'types', f), 'utf8')).join('\n');
    if (oldTypes !== newTypes) review.push('TypeScript declarations changed. Review for narrowed parameter types or removed/renamed fields in dist/types.');
  } else {
    features.push(`npm package present; ${BASE} has no npm build to compare with (first npm release). Exports: ${newApi.length}.`);
  }
}

// ---------------------------------------------------------------------------
// 10. VS Code extension manifest
// ---------------------------------------------------------------------------
const oldExt = JSON.parse(git('show', `${BASE}:extension/package.json`));
const c0 = oldExt.contributes ?? {}, c1 = extPkg.contributes ?? {};
if (oldExt.name !== extPkg.name || oldExt.publisher !== extPkg.publisher) breaking.push(`Extension identity changed ${oldExt.publisher}.${oldExt.name} → ${extPkg.publisher}.${extPkg.name}: users will not receive updates.`);
if (oldExt.engines?.vscode !== extPkg.engines?.vscode) review.push(`Minimum VS Code version changed: ${oldExt.engines?.vscode} → ${extPkg.engines?.vscode}`);
diffSet('Extension commands', (c0.commands ?? []).map((c) => c.command), (c1.commands ?? []).map((c) => c.command));
diffSet('Extension settings', Object.keys(c0.configuration?.properties ?? {}), Object.keys(c1.configuration?.properties ?? {}));
for (const [k, p] of Object.entries(c0.configuration?.properties ?? {})) {
  const q = c1.configuration?.properties?.[k];
  if (q && JSON.stringify(p.default) !== JSON.stringify(q.default)) review.push(`Setting ${k} default changed: ${JSON.stringify(p.default)} → ${JSON.stringify(q.default)}`);
  if (q && p.enum && q.enum) diffSet(`Setting ${k} values`, p.enum, q.enum);
}
diffSet('Language ids', (c0.languages ?? []).map((l) => l.id), (c1.languages ?? []).map((l) => l.id));
diffSet('File extensions', (c0.languages ?? []).flatMap((l) => l.extensions ?? []), (c1.languages ?? []).flatMap((l) => l.extensions ?? []));
diffSet('Keybindings', (c0.keybindings ?? []).map((k) => `${k.key}→${k.command}`), (c1.keybindings ?? []).map((k) => `${k.key}→${k.command}`), { removedIs: 'review' });
const snippetPrefixes = (json) => Object.values(json).flatMap((s) => [].concat(s.prefix));
diffSet('Snippet prefixes', snippetPrefixes(JSON.parse(git('show', `${BASE}:extension/snippets/smd.json`))), snippetPrefixes(readJson(join(EXT, 'snippets', 'smd.json'))), { removedIs: 'review' });

// ---------------------------------------------------------------------------
// 11. Agent skills
// ---------------------------------------------------------------------------
const skillNamesAt = (ref) => git('ls-tree', '-d', '--name-only', `${ref}:skills`).split('\n').filter(Boolean);
let newSkills = [];
try { newSkills = readdirSync(join(ROOT, 'skills')).filter((d) => existsSync(join(ROOT, 'skills', d, 'SKILL.md'))); } catch { /* none */ }
diffSet('Agent skills', skillNamesAt(BASE), newSkills);
for (const s of newSkills) {
  const md = readFileSync(join(ROOT, 'skills', s, 'SKILL.md'), 'utf8');
  const name = /^name:\s*(.+)$/m.exec(md)?.[1]?.trim();
  if (name !== s) failures.push(`skills/${s}/SKILL.md has name "${name}", which must match its folder name.`);
  const bundled = join(ROOT, 'skills', s, 'scripts', 'smd.cjs');
  if (existsSync(bundled) && readFileSync(bundled, 'utf8') !== readFileSync(NEW_CLI, 'utf8')) failures.push(`skills/${s}/scripts/smd.cjs is stale. Run npm run build.`);
}

// ---------------------------------------------------------------------------
// 12. Required bump vs actual bump
// ---------------------------------------------------------------------------
const [bM, bm, bp] = semver(BASE), [vM, vm, vp] = semver(version);
const actual = vM > bM ? 'major' : vm > bm ? 'minor' : vp > bp ? 'patch' : 'none';
const required = breaking.length ? 'major' : features.length ? 'minor' : 'patch';
const rank = { none: 0, patch: 1, minor: 2, major: 3 };
if (rank[actual] < rank[required]) failures.push(`Version bump too small: ${BASE} → ${version} is a ${actual} bump, but the changes require a ${required} bump.`);
if (actual === 'major' && !breaking.length) review.push(`${version} is a major bump but no breaking change was detected. Is that intended?`);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const section = (title, items, empty) => `### ${title}\n\n${items.length ? items.map((i) => `- ${i.replace(/\n/g, '\n  ')}`).join('\n') : `_${empty}_`}\n`;
const verdict = failures.length ? '❌ BLOCKED' : breaking.length ? '⚠️ READY ONLY AS A MAJOR RELEASE, after explicit human approval of the breaking changes' : review.length ? '🟡 READY after a human confirms the behaviour changes below' : '✅ READY';
const report = `## Release check: ${BASE} → ${version}

**Verdict:** ${verdict}
**Required bump:** ${required} · **Actual bump:** ${actual} · **Corpus:** ${corpus.length} documents

${section('❌ Blocking failures', failures, 'none')}
${section('💥 Breaking changes (not backward compatible)', breaking, 'none detected')}
${section('🔍 Behaviour changes to confirm', review, 'none')}
${section('✨ Additive changes', features, 'none')}
${section('✅ Passed', passed, 'no checks ran')}`;
const outFile = option('--out');
if (outFile) writeFileSync(outFile, report);
process.stdout.write(report);
process.exit(failures.length ? 1 : 0);
