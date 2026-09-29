#!/usr/bin/env node
// Pre-release static analysis gate: runs SonarQube locally in Docker and blocks on new
// bugs, vulnerabilities, unreviewed security hotspots and severe code smells.
//
//   node .claude/skills/sonarqube-scan/scripts/sonar-scan.mjs
//        [--strict] [--no-coverage] [--update-baseline] [--out <file>] [--port 9000] [--down] [--reset]
//
// Steps:
//   1. start SonarQube + Postgres (docker-compose.yml next to this folder) and wait until UP
//   2. first run only: replace the default admin password with a random one and create an
//      analysis token, both kept in ~/.smd-sonar/state.json (shared by every worktree)
//   3. run the unit tests with Node's coverage → extension/coverage/lcov.info
//   4. run sonar-scanner in Docker against the current checkout (sonar-project.properties)
//   5. wait for the server to process the report, then gate on the results:
//        - open issues of severity Blocker/High (Critical); Medium (Major) too with --strict
//        - any open security issue (vulnerability), whatever its severity
//        - security hotspots still "to review"
//      Findings listed in baseline.json (existing debt, accepted by a maintainer) are reported
//      but don't block. --update-baseline rewrites that file from the current results.
//      SonarQube's own quality gate is only reported: its "new code" depends on what this local
//      server happened to analyse before, so the committed baseline is what makes the gate repeatable.
//   6. write a Markdown report (default .scannerwork/sonar-report.md) and exit 1 if blocked.
//
// Exit codes: 0 pass, 1 blocking findings, 2 usage or infrastructure error.

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const option = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const KNOWN = new Set(['--strict', '--no-coverage', '--update-baseline', '--out', '--port', '--down', '--reset', '--help']);
const unknown = argv.filter((a, i) => a.startsWith('--') && !KNOWN.has(a) && !['--out', '--port'].includes(argv[i - 1]));
if (flag('--help') || unknown.length) {
  if (unknown.length) console.error(`Unknown option(s): ${unknown.join(' ')}`);
  console.error('Usage: sonar-scan.mjs [--strict] [--no-coverage] [--update-baseline] [--out <file>] [--port 9000] [--down] [--reset]');
  process.exit(unknown.length ? 2 : 0);
}

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: SKILL, encoding: 'utf8' }).trim(); // NOSONAR(javascript:S4036): developer tool, git comes from the maintainer's PATH
const COMPOSE = join(SKILL, 'docker-compose.yml');
const BASELINE = join(SKILL, 'baseline.json');
const PORT = option('--port') ?? process.env.SONAR_PORT ?? '9000';
const HOST = `http://127.0.0.1:${PORT}`;
const STATE_DIR = join(homedir(), '.smd-sonar');
const STATE_FILE = join(STATE_DIR, 'state.json');
const OUT = option('--out') ?? join(ROOT, '.scannerwork', 'sonar-report.md');
const STRICT = flag('--strict');

const props = Object.fromEntries(readFileSync(join(ROOT, 'sonar-project.properties'), 'utf8')
  .split(/\r?\n/).filter((l) => /^\s*[\w.]+\s*=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const PROJECT = props['sonar.projectKey'];
const VERSION = JSON.parse(readFileSync(join(ROOT, 'extension', 'package.json'), 'utf8')).version;

const log = (msg) => console.log(`[sonar] ${msg}`);
const die = (msg) => { console.error(`[sonar] ${msg}`); process.exit(2); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compose(args, env = {}) {
  const r = spawnSync('docker', ['compose', '-f', COMPOSE, ...args], { // NOSONAR(javascript:S4036): developer tool, docker comes from the maintainer's PATH
    stdio: 'inherit',
    env: { ...process.env, SMD_REPO_ROOT: ROOT.replace(/\\/g, '/'), SONAR_PORT: PORT, ...env },
  });
  if (r.error) die(`docker is not available: ${r.error.message}`);
  return r.status ?? 1;
}

// ── state (admin password + token), outside the repo so worktrees share one server ──
const readState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const writeState = (s) => { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 }); };

// ── HTTP API ──
// A busy server occasionally drops keep-alive sockets: retry network errors (not HTTP errors).
async function fetchRetry(url, init, attempts = 4) {
  for (let attempt = 1; attempt < attempts; attempt++) {
    try { return await fetch(url, init); } catch { await sleep(1000 * attempt); }
  }
  return fetch(url, init);
}

async function api(path, { auth, method = 'GET', form } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.pass ?? ''}`).toString('base64')}`;
  let body;
  if (form) { body = new URLSearchParams(form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  const res = await fetchRetry(`${HOST}${path}`, { method, headers, body });
  const text = await res.text();
  if (!res.ok) { const err = new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`); err.status = res.status; throw err; }
  return text ? JSON.parse(text) : {};
}
const valid = async (auth) => { try { return (await api('/api/authentication/validate', { auth })).valid === true; } catch { return false; } };

async function waitUp(timeoutMs = 6 * 60_000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const { status } = await api('/api/system/status');
      if (status === 'UP') return;
      if (status === 'DB_MIGRATION_NEEDED') await api('/api/system/migrate_db', { method: 'POST' });
      if (status !== last) { log(`server status: ${status}`); last = status; }
    } catch { /* not listening yet */ }
    await sleep(3000);
  }
  die(`SonarQube did not come up within ${timeoutMs / 60_000} min. Check: docker compose -f ${relative(ROOT, COMPOSE)} logs sonarqube`);
}

async function ensureAuth() {
  const state = readState();
  if (state.token && await valid({ user: state.token })) return state.token;

  let pass = process.env.SONAR_ADMIN_PASSWORD ?? state.adminPassword;
  if (!pass || !await valid({ user: 'admin', pass })) {
    if (!await valid({ user: 'admin', pass: 'admin' })) {
      die(`Can't sign in as admin. Set SONAR_ADMIN_PASSWORD, or wipe the local server with --reset.`);
    }
    // Fresh server: replace the default password (policy: ≥12 chars, upper, lower, digit, special).
    pass = `${randomBytes(18).toString('base64url')}aA1!`;
    await api('/api/users/change_password', { auth: { user: 'admin', pass: 'admin' }, method: 'POST', form: { login: 'admin', previousPassword: 'admin', password: pass } });
    log(`admin password set; stored in ${STATE_FILE}`);
  }
  const { token } = await api('/api/user_tokens/generate', { auth: { user: 'admin', pass }, method: 'POST', form: { name: `smd-sonar-${Date.now()}` } });
  writeState({ ...state, adminPassword: pass, token });
  return token;
}

async function ensureProject(auth) {
  const found = await api(`/api/projects/search?projects=${encodeURIComponent(PROJECT)}`, { auth });
  if (found.components?.length) return;
  await api('/api/projects/create', { auth, method: 'POST', form: { project: PROJECT, name: props['sonar.projectName'] ?? PROJECT, mainBranch: 'main' } });
  log(`created project ${PROJECT}`);
}

// ── coverage from the unit tests (Node's built-in coverage, lcov reporter needs Node ≥ 20.11) ──
function coverage() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 20 || (maj === 20 && min < 11)) { log(`Node ${process.versions.node} has no lcov reporter; skipping coverage`); return false; }
  const ext = join(ROOT, 'extension');
  if (!existsSync(join(ext, 'node_modules'))) die('extension/node_modules is missing. Run `npm ci` in extension/ first.');
  const lcov = join(ext, 'coverage', 'lcov.info');
  mkdirSync(dirname(lcov), { recursive: true });
  const files = readdirSync(join(ext, 'test')).filter((f) => f.endsWith('.test.ts')).sort((a, b) => a.localeCompare(b)).map((f) => join('test', f));
  log('running unit tests with coverage');
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--experimental-test-coverage',
    '--test-reporter=lcov', `--test-reporter-destination=${lcov}`, '--test-reporter=dot', '--test-reporter-destination=stdout', ...files],
  { cwd: ext, stdio: 'inherit' });
  if (r.status !== 0) die('unit tests failed; fix them before running the analysis (or pass --no-coverage).');
  // The scanner runs in Linux with the repo at /usr/src: make paths repo-relative with forward slashes.
  // Node emits one BRDA record per code block rather than per condition, which SonarQube rejects
  // as inconsistent; keep line coverage only.
  const fixed = readFileSync(lcov, 'utf8')
    .replace(/^(BRDA|BRF|BRH):.*\r?\n/gm, '')
    .replace(/^SF:(.*)$/gm, (_, p) => {
      const abs = /^([a-zA-Z]:|\/)/.test(p) ? p : join(ext, p);
      return `SF:${relative(ROOT, abs).replace(/\\/g, '/')}`;
    });
  writeFileSync(lcov, fixed);
  return true;
}

// ── results ──
const SEV_RANK = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, BLOCKER: 4 };
const LEGACY_SEV = { INFO: 'INFO', MINOR: 'LOW', MAJOR: 'MEDIUM', CRITICAL: 'HIGH', BLOCKER: 'BLOCKER' };
const LEGACY_QUALITY = { BUG: 'RELIABILITY', VULNERABILITY: 'SECURITY', CODE_SMELL: 'MAINTAINABILITY' };

function classify(issue) {
  // MQR mode (SonarQube 10.2+) reports impacts; standard mode only severity/type.
  const impacts = issue.impacts?.length
    ? issue.impacts.map((i) => ({ quality: i.softwareQuality, severity: i.severity }))
    : [{ quality: LEGACY_QUALITY[issue.type] ?? 'MAINTAINABILITY', severity: LEGACY_SEV[issue.severity] ?? 'MEDIUM' }];
  const severity = impacts.reduce((a, i) => (SEV_RANK[i.severity] > SEV_RANK[a] ? i.severity : a), 'INFO');
  const qualities = [...new Set(impacts.map((i) => i.quality))];
  return { severity, qualities };
}

const fileOf = (component) => component.slice(component.indexOf(':') + 1);
const issueKey = (i) => `issue|${i.rule}|${fileOf(i.component)}|${i.hash ?? i.message}`;
const hotspotKey = (h) => `hotspot|${h.ruleKey ?? h.securityCategory}|${fileOf(h.component)}|${h.message}`;

async function paged(path, field, auth) {
  const all = [];
  for (let p = 1; ; p++) {
    const page = await api(`${path}&ps=500&p=${p}`, { auth });
    all.push(...(page[field] ?? []));
    const total = page.paging?.total ?? page.total ?? 0;
    if (all.length >= total || !(page[field] ?? []).length || p >= 20) return all;
  }
}

// The scanner image keeps its work dir (and report-task.txt) inside the container, so find the
// analysis through the API: the newest task submitted after the scan started.
async function waitForTask(auth, since) {
  for (let i = 0; i < 200; i++) {
    const { queue = [], current } = await api(`/api/ce/component?component=${encodeURIComponent(PROJECT)}`, { auth });
    const pending = queue.some((t) => Date.parse(t.submittedAt) >= since);
    if (!pending && current && Date.parse(current.submittedAt) >= since) {
      if (current.status === 'SUCCESS') return current;
      die(`server failed to process the analysis: ${current.errorMessage ?? current.status}`);
    }
    await sleep(2000);
  }
  die('timed out waiting for the server to process the analysis');
}

async function measures(auth) {
  const keys = ['ncloc', 'coverage', 'duplicated_lines_density', 'bugs', 'vulnerabilities', 'code_smells', 'security_hotspots', 'sqale_index'];
  try {
    const { component } = await api(`/api/measures/component?component=${PROJECT}&metricKeys=${keys.join(',')}`, { auth });
    return Object.fromEntries(component.measures.map((m) => [m.metric, m.value]));
  } catch { return {}; }
}

const ICON = { BLOCKER: '⛔', HIGH: '🔴', MEDIUM: '🟠', LOW: '🟡', INFO: '⚪' };
const loc = (i) => `\`${fileOf(i.component)}${i.line ? `:${i.line}` : ''}\``;
const pct = (v) => (v == null ? undefined : `${v}%`);

function metricRows({ m, known, hotspots, coverageOn }) {
  return [
    ['Lines of code', m.ncloc],
    ['Coverage (unit tests, lines)', coverageOn ? pct(m.coverage) ?? 'n/a' : 'skipped'],
    ['Duplicated lines', pct(m.duplicated_lines_density)],
    ['Bugs', m.bugs], ['Vulnerabilities', m.vulnerabilities], ['Code smells', m.code_smells],
    ['Security hotspots to review', hotspots.length],
    ['Technical debt', m.sqale_index == null ? undefined : `${Math.round(m.sqale_index / 60)} h`],
    ['Accepted baseline findings', known.length],
  ].filter((r) => r[1] != null).map(([k, v]) => `| ${k} | ${v} |`);
}

function findingLine(f) {
  return f.kind === 'hotspot'
    ? `- 🔥 hotspot (${f.vulnerabilityProbability}) ${loc(f)} ${f.message} — \`${f.ruleKey ?? f.securityCategory}\``
    : `- ${ICON[f.severity]} ${f.severity} ${f.qualities.join('/')} ${loc(f)} ${f.message} — \`${f.rule}\``;
}

function warningTable(warnings) {
  const byRule = new Map();
  for (const w of warnings) { const g = byRule.get(w.rule) ?? { ...w, n: 0 }; g.n++; byRule.set(w.rule, g); }
  const groups = [...byRule.values()].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.n - a.n);
  return ['| Rule | Severity | Count | Example |', '|---|---|---|---|',
    ...groups.map((g) => `| \`${g.rule}\` | ${g.severity} | ${g.n} | ${loc(g)} ${g.message.replaceAll('|', String.raw`\|`)} |`)];
}

function report({ gate, blocking, warnings, ...counts }) {
  const failed = (gate.conditions ?? []).filter((c) => c.status === 'ERROR');
  const lines = [
    `# SonarQube gate — ${PROJECT} ${VERSION}`,
    '',
    `**Result:** ${blocking.length ? `❌ BLOCKED (${blocking.length})` : '✅ PASS'}  `,
    `**Mode:** ${STRICT ? 'strict (Medium blocks)' : 'default (Blocker/High, security, hotspots block)'}  `,
    `**SonarQube quality gate (informational):** ${gate.status}  `,
    `**Dashboard:** ${HOST}/dashboard?id=${PROJECT}`,
    '',
    '| Metric | Value |', '|---|---|',
    ...metricRows(counts),
  ];
  if (failed.length) {
    lines.push('', '## Quality gate conditions not met (new code on this server; informational)', '',
      ...failed.map((c) => `- \`${c.metricKey}\`: ${c.actualValue} (threshold ${c.comparator} ${c.errorThreshold})`));
  }
  if (blocking.length) lines.push('', '## Blocking', '', ...blocking.map(findingLine));
  if (warnings.length) lines.push('', `## Non-blocking (${warnings.length})`, '', ...warningTable(warnings));
  return lines.join('\n') + '\n';
}

// ── main ──
if (flag('--reset')) {
  log('removing the local SonarQube server and its data');
  compose(['--profile', 'scan', 'down', '-v']);
  rmSync(STATE_FILE, { force: true });
  if (argv.length === 1) process.exit(0);
}

log(`starting SonarQube on ${HOST} (first start pulls images and takes a few minutes)`);
if (compose(['up', '-d', 'db', 'sonarqube']) !== 0) die('docker compose up failed');
await waitUp();
const token = await ensureAuth();
const auth = { user: token };
await ensureProject(auth);

const coverageOn = !flag('--no-coverage') && coverage();

log('running sonar-scanner');
const scanStart = Date.now() - 5000; // tolerate clock skew between host and container
const scanArgs = ['--profile', 'scan', 'run', '--rm', 'scanner', 'sonar-scanner',
  `-Dsonar.projectVersion=${VERSION}`,
  // Worktrees have a .git file pointing at a host path the container can't see.
  '-Dsonar.scm.disabled=true',
  ...(coverageOn ? [] : ['-Dsonar.javascript.lcov.reportPaths=']),
];
if (compose(scanArgs, { SONAR_TOKEN: token }) !== 0) die('sonar-scanner failed (see output above)');

const task = await waitForTask(auth, scanStart);
const { projectStatus: gate } = await api(`/api/qualitygates/project_status?analysisId=${task.analysisId}`, { auth });
const m = await measures(auth);
const issues = (await paged(`/api/issues/search?components=${PROJECT}&resolved=false`, 'issues', auth))
  .map((i) => ({ ...i, kind: 'issue', ...classify(i) }));
const hotspots = (await paged(`/api/hotspots/search?project=${PROJECT}&status=TO_REVIEW`, 'hotspots', auth))
  .map((h) => ({ ...h, kind: 'hotspot' }));

const threshold = STRICT ? SEV_RANK.MEDIUM : SEV_RANK.HIGH;
const gating = [
  ...hotspots,
  ...issues.filter((i) => SEV_RANK[i.severity] >= threshold || i.qualities.includes('SECURITY')),
];
const keyOf = (f) => (f.kind === 'hotspot' ? hotspotKey(f) : issueKey(f));

if (flag('--update-baseline')) {
  const accepted = gating.map(keyOf).sort((a, b) => a.localeCompare(b));
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Existing findings accepted as known debt by a maintainer. The gate still reports them but does not block. Regenerate with sonar-scan.mjs --update-baseline; remove entries as they are fixed.',
    version: VERSION,
    findings: accepted,
  }, null, 2) + '\n');
  log(`baseline updated: ${accepted.length} finding(s) → ${relative(ROOT, BASELINE)}`);
}

// Multiset match, so a second copy of an accepted finding in the same file still blocks.
const budget = new Map();
for (const k of existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).findings ?? [] : []) budget.set(k, (budget.get(k) ?? 0) + 1);
const blocking = [];
const known = [];
for (const f of gating) {
  const k = keyOf(f);
  if (budget.get(k) > 0) { budget.set(k, budget.get(k) - 1); known.push(f); } else blocking.push(f);
}
const stale = [...budget.values()].reduce((a, n) => a + n, 0);
const warnings = issues.filter((i) => !gating.includes(i));

const md = report({ gate, m, blocking, known, warnings, hotspots, coverageOn })
  + (stale ? `\n> ${stale} baseline entr${stale > 1 ? 'ies no longer match' : 'y no longer matches'} a finding (fixed or moved). Prune with \`--update-baseline\`.\n` : '');
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md);
console.log(`\n${md}`);
log(`report written to ${relative(ROOT, OUT) || OUT}`);

if (flag('--down')) compose(['stop']);
process.exit(blocking.length ? 1 : 0);
