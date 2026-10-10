#!/usr/bin/env node
// Checks that a release tag matches what it ships, before anything is built or published.
//
//   node extension/scripts/release/check-versions.mjs <vX.Y.Z> [--branches [--commit <rev>]] [--output <file>]
//
// - the tag is a plain vX.Y.Z
// - extension/package.json, extension/package-lock.json, npm/package.json and the MkDocs plugin's
//   integrations/mkdocs/pyproject.toml have version X.Y.Z
// - extension/CHANGELOG.md has a non-empty "## X.Y.Z" section
// - with --branches: the tagged commit (or --commit, e.g. HEAD before tagging) is on origin/main
//   or an origin/release/* branch
// --output appends "version=X.Y.Z" to the file (pass "$GITHUB_OUTPUT" in a workflow).
// Prints every problem and exits 1 if there is any.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogExcerpt, versionFromTag } from './changelog-excerpt.mjs';

/** True for the branches a release may be tagged from: main and release/*, local or remote. */
export function isReleaseBranch(name) {
  const branch = String(name).trim().replace(/^(?:refs\/remotes\/|remotes\/)?origin\//, '');
  return branch === 'main' || /^release\/\S+$/.test(branch);
}

/**
 * Problems with a release, as messages; empty when it may ship. Without `branches`, the branch isn't checked.
 * @param {{ tag: string, extensionVersion?: string, lockVersion?: string, npmVersion?: string, pythonVersion?: string, changelog?: string, branches?: string[] }} release
 * @returns {string[]}
 */
export function checkRelease({ tag, extensionVersion, lockVersion, npmVersion, pythonVersion, changelog, branches }) {
  const version = versionFromTag(tag);
  if (!version) return [`"${tag}" is not a release tag (expected vX.Y.Z).`];
  const problems = [];
  const manifests = [
    ['extension/package.json', extensionVersion],
    ['extension/package-lock.json', lockVersion],
    ['npm/package.json', npmVersion],
    ['integrations/mkdocs/pyproject.toml', pythonVersion],
  ];
  for (const [file, found] of manifests) {
    if (found !== version) problems.push(`${file} has version ${found ?? '(none)'}, the tag is v${version}.`);
  }
  if (!changelogExcerpt(changelog ?? '', version)) {
    problems.push(`extension/CHANGELOG.md has no "## ${version}" section, or it is empty.`);
  }
  if (branches && !branches.some(isReleaseBranch)) {
    problems.push(`v${version} is not on main or a release/* branch (found on: ${branches.join(', ') || 'no branch'}).`);
  }
  return problems;
}

function readJsonVersion(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : undefined;
}

/** The `version` of the `[project]` table in a pyproject.toml, or undefined. */
export function pyprojectVersion(text) {
  let table = '';
  for (const line of text.split('\n').map((l) => l.trim())) {
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) table = header[1].trim();
    const version = table === 'project' ? /^version *= *["']([^"']+)["']/.exec(line) : null;
    if (version) return version[1];
  }
  return undefined;
}

function readPyprojectVersion(path) {
  return existsSync(path) ? pyprojectVersion(readFileSync(path, 'utf8')) : undefined;
}

/** Remote branches that contain the commit, from the clone's own git; empty when it can't tell. */
function branchesContaining(commit) {
  try {
    const out = execFileSync('git', ['branch', '-r', '--contains', commit, '--format=%(refname:short)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); // NOSONAR(javascript:S4036): runs the maintainer's or CI runner's own git, found on PATH like the other release scripts
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const options = { tag: undefined, branches: false, commit: undefined, output: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--branches') options.branches = true;
    else if (argv[i] === '--commit') options.commit = argv[++i];
    else if (argv[i] === '--output') options.output = argv[++i];
    else options.tag = argv[i];
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (!options.tag) {
    console.error('Usage: check-versions.mjs <vX.Y.Z> [--branches [--commit <rev>]] [--output <file>]');
    return 2;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const problems = checkRelease({
    tag: options.tag,
    extensionVersion: readJsonVersion(join(root, 'extension', 'package.json')),
    lockVersion: readJsonVersion(join(root, 'extension', 'package-lock.json')),
    npmVersion: readJsonVersion(join(root, 'npm', 'package.json')),
    pythonVersion: readPyprojectVersion(join(root, 'integrations', 'mkdocs', 'pyproject.toml')),
    changelog: readFileSync(join(root, 'extension', 'CHANGELOG.md'), 'utf8'),
    branches: options.branches ? branchesContaining(options.commit ?? `${options.tag}^{commit}`) : undefined,
  });
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length) return 1;
  const version = versionFromTag(options.tag);
  if (options.output) appendFileSync(options.output, `version=${version}\n`);
  console.log(`v${version}: versions, changelog${options.branches ? ' and branch' : ''} OK.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
