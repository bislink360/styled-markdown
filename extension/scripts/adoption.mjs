#!/usr/bin/env node
// Adoption numbers for Styled Markdown, from public sources. Read-only: it changes nothing anywhere.
//
//   node extension/scripts/adoption.mjs [--json] [--repo owner/name] [--maintainers login,login]
//
// GitHub (through the GitHub CLI, `gh`, logged in): stars, forks, watchers, open issues and pull requests,
// issues and pull requests opened by people outside the project, release asset downloads, and a code search
// for files with `smd: 2` front matter in other repositories.
// Registries (public endpoints, no credentials): npm downloads, VS Code Marketplace installs, Open VSX
// downloads, PyPI downloads of the MkDocs plugin. A package a registry doesn't have shows as "not listed".
//
// Prints a Markdown table (paste it into an issue, or append it to $GITHUB_STEP_SUMMARY); --json prints the
// same numbers as JSON. A source that fails shows "unavailable" and why; the exit code is 0 unless the
// arguments are wrong.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const NPM_PACKAGE = 'styled-markdown';
const EXTENSION_ID = 'bislink360.styled-markdown';
const PYPI_PACKAGE = 'mkdocs-styled-markdown';
const NOT_LISTED = 'not listed';

/** Authors whose issues and pull requests don't count as outside contributions. */
const INSIDER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function parseArgs(argv) {
  const options = { json: false, repo: 'bislink360/styled-markdown', maintainers: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--repo') options.repo = argv[++i];
    else if (arg === '--maintainers') options.maintainers = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo ?? '')) throw new Error(`--repo must be owner/name, got "${options.repo}"`);
  return options;
}

/** `gh api <path>` as parsed JSON; throws with gh's message when it fails. */
function ghApi(path, { paginate = false } = {}) {
  const args = ['api', '-H', 'Accept: application/vnd.github+json', path];
  if (paginate) args.splice(1, 0, '--paginate', '--slurp');
  // NOSONAR(javascript:S4036): runs the maintainer's or CI runner's own gh, found on PATH like the release scripts
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false });
  if (result.error) throw new Error(result.error.code === 'ENOENT' ? 'the GitHub CLI (gh) is not installed' : result.error.message);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `gh exited with ${result.status}`).trim().split('\n')[0]);
  const json = JSON.parse(result.stdout);
  return paginate ? json.flat() : json;
}

/** fetch() as JSON; 404 (and an empty registry answer) means "not listed". */
async function getJson(url, init) {
  const response = await fetch(url, { ...init, headers: { 'User-Agent': 'styled-markdown-adoption-script', ...init?.headers } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status} ${response.statusText}`);
  return response.json();
}

/** Run a source, turning a failure into { error } so one bad source doesn't hide the others. */
async function attempt(source) {
  try {
    return await source();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Issues and pull requests split by whether their author is outside the project. */
export function outsideContributions(items, maintainers = []) {
  const insiders = new Set(maintainers.map((m) => m.toLowerCase()));
  const counts = { issues: 0, pullRequests: 0, outsideIssues: 0, outsidePullRequests: 0, outsideAuthors: new Set() };
  for (const item of items) {
    const isPr = Boolean(item.pull_request);
    const login = String(item.user?.login ?? '');
    const bot = item.user?.type === 'Bot' || login.endsWith('[bot]');
    if (bot) continue;
    if (isPr) counts.pullRequests++; else counts.issues++;
    const outside = !INSIDER_ASSOCIATIONS.has(item.author_association) && !insiders.has(login.toLowerCase());
    if (!outside) continue;
    if (isPr) counts.outsidePullRequests++; else counts.outsideIssues++;
    counts.outsideAuthors.add(login);
  }
  return { ...counts, outsideAuthors: counts.outsideAuthors.size };
}

/** Download counts of release assets: the total, by kind of file, and for the latest release. */
export function releaseDownloads(releases) {
  const kind = (name) => {
    if (name.endsWith('.vsix')) return 'vsix';
    if (name.endsWith('.tgz')) return 'npm tgz';
    if (name.endsWith('.whl') || name.endsWith('.tar.gz')) return 'python';
    if (name.endsWith('.zip')) return 'zip';
    return 'other';
  };
  const byKind = {};
  let total = 0;
  for (const release of releases) {
    for (const asset of release.assets ?? []) {
      total += asset.download_count ?? 0;
      byKind[kind(asset.name)] = (byKind[kind(asset.name)] ?? 0) + (asset.download_count ?? 0);
    }
  }
  const published = releases.filter((r) => !r.draft).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
  const latest = published[0];
  return {
    releases: published.length,
    total,
    byKind,
    latest: latest ? { tag: latest.tag_name, downloads: (latest.assets ?? []).reduce((sum, a) => sum + (a.download_count ?? 0), 0) } : null,
  };
}

async function github(repo, maintainers) {
  const info = ghApi(`repos/${repo}`);
  const items = ghApi(`repos/${repo}/issues?state=all&per_page=100`, { paginate: true });
  return {
    stars: info.stargazers_count,
    forks: info.forks_count,
    watchers: info.subscribers_count,
    openIssuesAndPullRequests: info.open_issues_count,
    ...outsideContributions(items, maintainers),
  };
}

async function codeSearch(repo) {
  // Files whose front matter declares spec v2, outside this repository. GitHub's code search needs a login.
  const query = `"smd: 2" extension:smd -repo:${repo}`;
  const result = ghApi(`search/code?q=${encodeURIComponent(query)}&per_page=100`);
  const repos = new Set((result.items ?? []).map((item) => item.repository?.full_name).filter(Boolean));
  return { files: result.total_count, repositories: repos.size, repositoriesCapped: (result.total_count ?? 0) > 100, query };
}

async function npmDownloads() {
  const week = await getJson(`https://api.npmjs.org/downloads/point/last-week/${NPM_PACKAGE}`);
  if (!week || week.error) return { listed: false };
  const month = await getJson(`https://api.npmjs.org/downloads/point/last-month/${NPM_PACKAGE}`);
  return { listed: true, lastWeek: week.downloads, lastMonth: month?.downloads ?? null };
}

async function marketplaceInstalls() {
  const body = { filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }] }], flags: 0x100 }; // 0x100: statistics
  const json = await getJson('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
    body: JSON.stringify(body),
  });
  const extension = json?.results?.[0]?.extensions?.[0];
  if (!extension) return { listed: false };
  const stat = (name) => extension.statistics?.find((s) => s.statisticName === name)?.value ?? null;
  return { listed: true, installs: stat('install'), updates: stat('updateCount'), downloads: stat('downloadCount') };
}

async function openVsxDownloads() {
  const [namespace, name] = EXTENSION_ID.split('.');
  const json = await getJson(`https://open-vsx.org/api/${namespace}/${name}`);
  if (!json || json.error) return { listed: false };
  return { listed: true, downloads: json.downloadCount ?? null, version: json.version ?? null };
}

async function pypiDownloads() {
  const json = await getJson(`https://pypistats.org/api/packages/${PYPI_PACKAGE}/recent`);
  if (!json?.data) return { listed: false };
  return { listed: true, lastWeek: json.data.last_week, lastMonth: json.data.last_month };
}

export async function collect({ repo, maintainers }) {
  const [gh, releases, search, npm, marketplace, openVsx, pypi] = await Promise.all([
    attempt(() => github(repo, maintainers)),
    attempt(async () => releaseDownloads(ghApi(`repos/${repo}/releases?per_page=100`, { paginate: true }))),
    attempt(() => codeSearch(repo)),
    attempt(npmDownloads),
    attempt(marketplaceInstalls),
    attempt(openVsxDownloads),
    attempt(pypiDownloads),
  ]);
  return { date: new Date().toISOString().slice(0, 10), repo, github: gh, releases, codeSearch: search, npm, marketplace, openVsx, pypi };
}

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : n == null ? '–' : String(n));

/** The numbers as a Markdown table: one row per metric. */
export function markdownReport(data) {
  const rows = [];
  const row = (source, metric, value) => rows.push(`| ${source} | ${metric} | ${value} |`);
  const failed = (source, part) => (part?.error ? (row(source, '—', `unavailable: ${part.error.replaceAll('|', '\\|')}`), true) : false);
  const listed = (source, part) => (part?.listed === false ? (row(source, '—', NOT_LISTED), false) : true);

  const g = data.github;
  if (!failed('GitHub', g)) {
    row('GitHub', 'Stars', fmt(g.stars));
    row('GitHub', 'Forks', fmt(g.forks));
    row('GitHub', 'Watchers', fmt(g.watchers));
    row('GitHub', 'Open issues and pull requests', fmt(g.openIssuesAndPullRequests));
    row('GitHub', 'Issues (all time) / from outside contributors', `${fmt(g.issues)} / ${fmt(g.outsideIssues)}`);
    row('GitHub', 'Pull requests (all time) / from outside contributors', `${fmt(g.pullRequests)} / ${fmt(g.outsidePullRequests)}`);
    row('GitHub', 'Outside contributors (people)', fmt(g.outsideAuthors));
  }
  const r = data.releases;
  if (!failed('GitHub releases', r)) {
    row('GitHub releases', `Asset downloads, all ${fmt(r.releases)} releases`, fmt(r.total));
    for (const [kind, count] of Object.entries(r.byKind).sort()) row('GitHub releases', `… ${kind}`, fmt(count));
    if (r.latest) row('GitHub releases', `Asset downloads, latest (${r.latest.tag})`, fmt(r.latest.downloads));
  }
  const s = data.codeSearch;
  if (!failed('GitHub code search', s)) {
    row('GitHub code search', '`.smd` files with `smd: 2` in other repositories', fmt(s.files));
    row('GitHub code search', `… in repositories${s.repositoriesCapped ? ' (among the first 100 files)' : ''}`, fmt(s.repositories));
  }
  const n = data.npm;
  if (!failed('npm', n) && listed('npm', n)) {
    row('npm', 'Downloads, last week', fmt(n.lastWeek));
    row('npm', 'Downloads, last month', fmt(n.lastMonth));
  }
  const m = data.marketplace;
  if (!failed('VS Code Marketplace', m) && listed('VS Code Marketplace', m)) {
    row('VS Code Marketplace', 'Installs', fmt(m.installs));
    row('VS Code Marketplace', 'Updates', fmt(m.updates));
    row('VS Code Marketplace', 'Downloads', fmt(m.downloads));
  }
  const o = data.openVsx;
  if (!failed('Open VSX', o) && listed('Open VSX', o)) row('Open VSX', 'Downloads', fmt(o.downloads));
  const p = data.pypi;
  if (!failed('PyPI', p) && listed('PyPI', p)) {
    row('PyPI (MkDocs plugin)', 'Downloads, last week', fmt(p.lastWeek));
    row('PyPI (MkDocs plugin)', 'Downloads, last month', fmt(p.lastMonth));
  }
  return [`### Styled Markdown adoption, ${data.date}`, '', '| Source | Metric | Value |', '|---|---|---:|', ...rows, ''].join('\n');
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error('Usage: adoption.mjs [--json] [--repo owner/name] [--maintainers login,login]');
    return 2;
  }
  if (options.help) {
    console.log('Usage: adoption.mjs [--json] [--repo owner/name] [--maintainers login,login]');
    return 0;
  }
  const data = await collect(options);
  console.log(options.json ? JSON.stringify(data, null, 2) : markdownReport(data));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
