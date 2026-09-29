#!/usr/bin/env node
// Plan a release train: one release branch, one independent branch per feature.
//
//   node .claude/skills/version-control/scripts/plan-release.mjs <X.Y.Z> <feature> [<feature> …]
//        [--base main|vX.Y.Z] [--dry-run] [--no-pr] [--no-bump]
//
// <feature> is a short slug ("link-completion") → feat/link-completion, or a full branch name
// with a prefix ("fix/preview-scroll", "docs/tables"). Idempotent: re-running with more features
// adds them to the existing release.
//
// Steps:
//   1. release/vX.Y.Z from origin/<base> (skipped if it exists), pushed
//   2. on the release branch: version bump + CHANGELOG heading via smd-release's bump-version.mjs,
//      committed as "chore(release): start X.Y.Z", pushed (done in a temporary worktree)
//   3. one branch per feature from the release branch head, pushed (existing ones are left alone)
//   4. a draft tracking PR release/vX.Y.Z → <base> listing the feature branches (needs gh)
// Your current checkout is never modified.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const option = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--base');
const [version, ...features] = positional;
const BASE = option('--base') ?? 'main';
const DRY = flag('--dry-run');

if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !features.length) {
  console.error('Usage: plan-release.mjs <X.Y.Z> <feature> [<feature> …] [--base main] [--dry-run] [--no-pr] [--no-bump]');
  process.exit(2);
}

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (args, cwd = ROOT) => { try { return git(args, cwd); } catch { return null; } };
const act = (label, fn) => { console.log(`${DRY ? '[dry-run] ' : ''}${label}`); if (!DRY) return fn(); };

// ---- validate the version -------------------------------------------------
git(['fetch', '--quiet', 'origin', '--tags', '--prune']);
const semver = (v) => v.replace(/^v/, '').split('.').map(Number);
const cmp = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const tags = git(['tag', '--list', 'v*']).split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort(cmp);
// Hotfix trains (--base vX.Y.Z) are compared with their base tag, so older lines can be patched.
const last = /^v\d+\.\d+\.\d+$/.test(BASE) ? BASE : tags[tags.length - 1];
if (tags.includes(`v${version}`)) { console.error(`v${version} is already released.`); process.exit(1); }
if (last && cmp(version, last) <= 0) { console.error(`${version} must be greater than ${last === BASE ? 'its base' : 'the last release'} ${last}.`); process.exit(1); }
if (last) {
  const [a, b, c] = semver(last), [x, y, z] = semver(version);
  const kind = x > a ? 'major' : y > b ? 'minor' : 'patch';
  const expected = kind === 'major' ? `${a + 1}.0.0` : kind === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
  if (version !== expected) console.warn(`warning: ${last} → ${version} skips versions (next ${kind} would be ${expected}).`);
}

const RELEASE = `release/v${version}`;
// --base may be a branch (normally main) or a release tag for hotfixes (--base v1.2.0 → release/v1.2.1).
const BASE_IS_TAG = /^v\d+\.\d+\.\d+$/.test(BASE);
if (BASE_IS_TAG && !tags.includes(BASE)) { console.error(`Tag ${BASE} not found.`); process.exit(1); }
const baseSource = BASE_IS_TAG ? git(['rev-parse', `${BASE}^{commit}`]) : `refs/remotes/origin/${BASE}`;
const baseRef = BASE_IS_TAG ? BASE : `origin/${BASE}`;
const PR_BASE = BASE_IS_TAG ? 'main' : BASE;
const remoteHas = (b) => tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]) !== null;
const branchOf = (f) => (/^(feat|fix|docs|chore|perf|refactor|test)\//.test(f) ? f : `feat/${f}`);
const featureBranches = [...new Set(features.map(branchOf))];
for (const b of featureBranches) {
  if (!/^[a-z]+\/[a-z0-9][a-z0-9._-]*$/.test(b)) { console.error(`Invalid branch name "${b}" (use lowercase slugs like feat/table-captions).`); process.exit(2); }
}

// ---- 1. release branch ---------------------------------------------------------
if (remoteHas(RELEASE)) {
  console.log(`${RELEASE} exists; adding features to it.`);
} else {
  act(`create ${RELEASE} from ${baseRef} and push`, () => {
    git(['push', 'origin', `${baseSource}:refs/heads/${RELEASE}`]);
    git(['fetch', '--quiet', 'origin']);
  });
}

// ---- 2. open the release at its version (bump + changelog heading) ------------
const bumpScript = join(ROOT, '.claude', 'skills', 'smd-release', 'scripts', 'bump-version.mjs');
const releasePkgVersion = () => {
  const ref = remoteHas(RELEASE) ? `origin/${RELEASE}` : baseRef;
  const txt = tryGit(['show', `${ref}:extension/package.json`]);
  return txt ? JSON.parse(txt).version : null;
};
if (flag('--no-bump')) {
  console.log('skipping version bump (--no-bump)');
} else if (releasePkgVersion() === version) {
  console.log(`${RELEASE} is already at ${version}.`);
} else if (!existsSync(bumpScript)) {
  console.warn(`warning: ${bumpScript} not found; bump the version on ${RELEASE} manually.`);
} else {
  act(`bump ${RELEASE} to ${version} (commit "chore(release): start ${version}") and push`, () => {
    const wt = mkdtempSync(join(tmpdir(), 'smd-plan-'));
    try {
      git(['worktree', 'add', '--quiet', '-B', `plan-tmp-${version}`, wt, `origin/${RELEASE}`]);
      const r = spawnSync(process.execPath, [bumpScript, version], { cwd: wt, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);
      git(['add', '-A'], wt);
      git(['commit', '--quiet', '-m', `chore(release): start ${version}`, '-m', `Open ${RELEASE}: bump the extension, npm package and lockfile to ${version} and add the ${version} CHANGELOG heading. Feature PRs into ${RELEASE} add their entries under it.`], wt);
      git(['push', '--quiet', 'origin', `HEAD:refs/heads/${RELEASE}`], wt);
    } finally {
      tryGit(['worktree', 'remove', '--force', wt]);
      tryGit(['worktree', 'prune']);
      tryGit(['branch', '-D', `plan-tmp-${version}`]);
      rmSync(wt, { recursive: true, force: true });
    }
    git(['fetch', '--quiet', 'origin']);
  });
}

// ---- 3. feature branches -------------------------------------------------------
const created = [], existing = [];
for (const b of featureBranches) {
  if (remoteHas(b)) { existing.push(b); continue; }
  act(`create ${b} from ${RELEASE} and push`, () => git(['push', '--quiet', 'origin', `refs/remotes/origin/${RELEASE}:refs/heads/${b}`]));
  created.push(b);
}
if (!DRY) git(['fetch', '--quiet', 'origin']);

// ---- 4. draft tracking PR --------------------------------------------------------
const hasGh = spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0;
const repo = (tryGit(['remote', 'get-url', 'origin']) ?? '').replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
let trackingPr = null;
if (!flag('--no-pr') && hasGh && repo) {
  const find = spawnSync('gh', ['api', `repos/${repo}/pulls?state=open&head=${repo.split('/')[0]}:${RELEASE}&base=${PR_BASE}`, '--jq', '.[0].html_url // ""'], { encoding: 'utf8' });
  trackingPr = find.stdout?.trim() || null;
  const list = featureBranches.map((b) => `- [ ] \`${b}\` → PR into \`${RELEASE}\``).join('\n');
  if (!trackingPr) {
    const body = `## Release ${version}\n\nTracking PR for the ${RELEASE} release train. Feature branches (each merged into \`${RELEASE}\` by its own PR):\n\n${list}\n\n## Before merging this PR (after the release is published)\n- [ ] All feature PRs merged into \`${RELEASE}\`\n- [ ] CHANGELOG entry for ${version} complete; release-check (full mode) ✅\n- [ ] Maintainer approval of the release report\n- [ ] Tag \`v${version}\` pushed on the release branch, artifacts built and published, registries verified\n\nMerge with a **merge commit** (not squash) so the tagged commit stays in \`${PR_BASE}\`'s history.`;
    act(`open draft tracking PR ${RELEASE} → ${PR_BASE}`, () => {
      const r = spawnSync('gh', ['pr', 'create', '--repo', repo, '--draft', '--base', PR_BASE, '--head', RELEASE, '--title', `chore(release): ${version}`, '--body', body], { encoding: 'utf8' });
      if (r.status !== 0) console.warn(`warning: could not open the tracking PR: ${(r.stderr || '').trim()}`);
      trackingPr = r.stdout?.trim().split('\n').pop() || null;
    });
  } else if (created.length) {
    console.log(`tracking PR exists: ${trackingPr} (add the new branches to its checklist: ${created.join(', ')})`);
  }
}

// ---- summary ----------------------------------------------------------------------
const slug = (b) => b.replace(/[^a-z0-9]+/gi, '-');
console.log(`
Release train ${version}
  release branch : ${RELEASE}${trackingPr ? `\n  tracking PR    : ${trackingPr}` : ''}
  new branches   : ${created.join(', ') || 'none'}
  already existed: ${existing.join(', ') || 'none'}

Work on each feature in its own worktree (keeps parallel work isolated; short paths avoid
Windows path-length limits in node_modules):
${featureBranches.map((b) => `  git worktree add ../wt-${slug(b)} ${b}`).join('\n')}

Open each feature PR against the release branch:
  gh pr create --base ${RELEASE} --head <branch> --title "feat(<area>): …"`);
