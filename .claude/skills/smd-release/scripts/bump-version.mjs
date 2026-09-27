#!/usr/bin/env node
// Bump the lockstep version of every Styled Markdown artifact and open a CHANGELOG entry.
//
//   node .claude/skills/smd-release/scripts/bump-version.mjs <major|minor|patch|X.Y.Z>
//
// Updates: extension/package.json, extension/package-lock.json, npm/package.json,
// extension/CHANGELOG.md (new "## X.Y.Z — YYYY-MM-DD" section with empty headings).
// Does not commit, tag or publish.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const arg = process.argv[2];
if (!arg) { console.error('Usage: bump-version.mjs <major|minor|patch|X.Y.Z>'); process.exit(2); }

const extPkgPath = join(ROOT, 'extension', 'package.json');
const extPkg = JSON.parse(readFileSync(extPkgPath, 'utf8'));
const [M, m, p] = extPkg.version.split('.').map(Number);
const next = arg === 'major' ? `${M + 1}.0.0` : arg === 'minor' ? `${M}.${m + 1}.0` : arg === 'patch' ? `${M}.${m}.${p + 1}` : arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) { console.error(`Not a version: ${next}`); process.exit(2); }

const setVersion = (path, update) => {
  if (!existsSync(path)) return;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  update(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  console.log(`updated ${path.replace(ROOT, '.')}`);
};
setVersion(extPkgPath, (j) => { j.version = next; });
setVersion(join(ROOT, 'extension', 'package-lock.json'), (j) => { j.version = next; if (j.packages?.['']) j.packages[''].version = next; });
setVersion(join(ROOT, 'npm', 'package.json'), (j) => { j.version = next; });

const changelogPath = join(ROOT, 'extension', 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');
if (!changelog.includes(`## ${next} `)) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = `## ${next} — ${today}\n\n### ⚠️ Breaking changes\n\n### Added\n\n### Changed\n\n### Deprecated\n\n### Fixed\n\n`;
  writeFileSync(changelogPath, changelog.replace(/^(# Changelog\s*\n\n)/, `$1${entry}`));
  console.log(`added "## ${next}" to extension/CHANGELOG.md (fill it in; delete empty headings)`);
}
console.log(`\n${extPkg.version} → ${next}. Next: npm run build && npm run build:npm (in extension/), then run release-check.mjs.`);
