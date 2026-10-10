#!/usr/bin/env node
// Prints the CHANGELOG section of one version, as GitHub release notes.
//
//   node extension/scripts/release/changelog-excerpt.mjs <X.Y.Z|vX.Y.Z> [--changelog <file>] [--downloads] [-o <file>]
//
// The section runs from "## X.Y.Z — date" to the next "## " heading. Empty "### …" headings
// (left by bump-version.mjs) are dropped. --downloads puts the table of release assets first,
// as on earlier releases. Exits 1 when the version has no section or the section is empty.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/bislink360/styled-markdown';

/** "v1.2.3" or "refs/tags/v1.2.3" → "1.2.3"; undefined when it isn't a plain X.Y.Z version. */
export function versionFromTag(tag) {
  const match = /^(?:refs\/tags\/)?v?(\d+\.\d+\.\d+)$/.exec(String(tag ?? '').trim());
  return match ? match[1] : undefined;
}

/** Heading level of a Markdown ATX heading line (0 when it isn't one). */
function headingLevel(line) {
  const match = /^(#{1,6})\s/.exec(line);
  return match ? match[1].length : 0;
}

/** Index of the "## X.Y.Z" heading line, or -1. */
export function findVersionHeading(lines, version) {
  const escaped = version.replaceAll('.', String.raw`\.`);
  const heading = new RegExp(String.raw`^##\s+\[?v?${escaped}\]?(?:\s|$)`);
  return lines.findIndex((line) => heading.test(line));
}

/** Removes "### …" headings that have nothing under them before the next heading of their level. */
export function dropEmptyHeadings(lines) {
  return lines.filter((line, i) => headingLevel(line) < 3 || hasContent(lines, i));
}

/** True when a heading has text under it (directly or under a deeper heading) before the next heading of its level or above. */
function hasContent(lines, index) {
  const level = headingLevel(lines[index]);
  for (let i = index + 1; i < lines.length; i++) {
    const next = headingLevel(lines[i]);
    if (next) {
      if (next <= level) return false;
      if (hasContent(lines, i)) return true;
    } else if (lines[i].trim()) {
      return true;
    }
  }
  return false;
}

/** The body of a version's section (without its "## " heading), trimmed; undefined when missing or empty. */
export function changelogExcerpt(changelog, version) {
  const lines = changelog.replaceAll('\r\n', '\n').split('\n');
  const start = findVersionHeading(lines, version);
  if (start < 0) return undefined;
  let end = lines.findIndex((line, i) => i > start && headingLevel(line) === 2);
  if (end < 0) end = lines.length;
  const excerpt = dropEmptyHeadings(lines.slice(start + 1, end)).join('\n').replaceAll(/\n{3,}/g, '\n\n').trim();
  return excerpt || undefined;
}

/** The table of release assets that opens the notes. */
export function downloadsTable(version) {
  const docs = `${REPO}/blob/v${version}/docs`;
  return [
    '## Downloads',
    '',
    '| Asset | What it is | How to install |',
    '|---|---|---|',
    `| \`styled-markdown-${version}.vsix\` | VS Code extension | \`code --install-extension styled-markdown-${version}.vsix\`, or Extensions → ⋯ → Install from VSIX… ([guide](${docs}/INSTALL.md)) |`,
    `| \`styled-markdown-${version}.tgz\` | npm package (library + \`smd\` CLI), the same file as on npm | \`npm install -g ./styled-markdown-${version}.tgz\` |`,
    `| \`styled-markdown-writer.zip\` | Agent skill: create and edit \`.smd\` following the rules | Unzip into \`~/.claude/skills/\` or upload in Claude → Settings → Capabilities → Skills ([guide](${docs}/SKILLS.md)) |`,
    '| `styled-markdown-reader.zip` | Agent skill: token-efficient reading | Same as above |',
    `| \`mkdocs_styled_markdown-${version}-py3-none-any.whl\` | MkDocs plugin (Python wheel; needs Node.js 18+) | \`pip install ./mkdocs_styled_markdown-${version}-py3-none-any.whl\` ([guide](${docs}/INSTALL.md#mkdocs-plugin)) |`,
    `| \`mkdocs_styled_markdown-${version}.tar.gz\` | MkDocs plugin source distribution | \`pip install ./mkdocs_styled_markdown-${version}.tar.gz\` |`,
  ].join('\n');
}

/** Release notes: the changelog excerpt, optionally after the downloads table. */
export function releaseNotes(version, excerpt, { downloads = false } = {}) {
  return (downloads ? `${downloadsTable(version)}\n\n${excerpt}` : excerpt) + '\n';
}

function parseArgs(argv) {
  const options = { version: undefined, changelog: undefined, out: undefined, downloads: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--changelog') options.changelog = argv[++i];
    else if (arg === '-o' || arg === '--out') options.out = argv[++i];
    else if (arg === '--downloads') options.downloads = true;
    else options.version = arg;
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const version = versionFromTag(options.version);
  if (!version) {
    console.error('Usage: changelog-excerpt.mjs <X.Y.Z|vX.Y.Z> [--changelog <file>] [--downloads] [-o <file>]');
    return 2;
  }
  const path = options.changelog ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'CHANGELOG.md');
  const excerpt = changelogExcerpt(readFileSync(path, 'utf8'), version);
  if (!excerpt) {
    console.error(`No changelog entry for ${version} in ${path} (or it is empty).`);
    return 1;
  }
  const notes = releaseNotes(version, excerpt, options);
  if (options.out) writeFileSync(options.out, notes);
  else process.stdout.write(notes);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
