// Tests for the adoption report (extension/scripts/adoption.mjs): the parts that don't touch the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownReport, outsideContributions, parseArgs, releaseDownloads } from '../scripts/adoption.mjs';

test('outside contributions leave out the owner, members, collaborators, listed maintainers and bots', () => {
  const items = [
    { user: { login: 'owner' }, author_association: 'OWNER' },
    { user: { login: 'owner' }, author_association: 'OWNER', pull_request: {} },
    { user: { login: 'teammate' }, author_association: 'MEMBER', pull_request: {} },
    { user: { login: 'Maintainer' }, author_association: 'CONTRIBUTOR' },
    { user: { login: 'dependabot[bot]', type: 'Bot' }, author_association: 'NONE', pull_request: {} },
    { user: { login: 'alice' }, author_association: 'NONE' },
    { user: { login: 'alice' }, author_association: 'CONTRIBUTOR', pull_request: {} },
    { user: { login: 'bob' }, author_association: 'FIRST_TIME_CONTRIBUTOR', pull_request: {} },
  ];
  assert.deepEqual(outsideContributions(items, ['maintainer']), {
    issues: 3, pullRequests: 4, outsideIssues: 1, outsidePullRequests: 2, outsideAuthors: 2,
  });
});

test('release downloads are summed by kind and for the latest published release', () => {
  const releases = [
    { tag_name: 'v1.0.0', published_at: '2026-01-01T00:00:00Z', assets: [{ name: 'x-1.0.0.vsix', download_count: 4 }] },
    { tag_name: 'v1.1.0', published_at: '2026-02-01T00:00:00Z', assets: [
      { name: 'x-1.1.0.vsix', download_count: 2 }, { name: 'x-1.1.0.tgz', download_count: 1 },
      { name: 'x.whl', download_count: 3 }, { name: 'skills.zip', download_count: 5 },
    ] },
    { tag_name: 'v1.2.0', draft: true, published_at: null, assets: [] },
  ];
  assert.deepEqual(releaseDownloads(releases), {
    releases: 2, total: 15, byKind: { vsix: 6, 'npm tgz': 1, python: 3, zip: 5 }, latest: { tag: 'v1.1.0', downloads: 11 },
  });
});

test('the report says "not listed" for a registry without the package, and why a source failed', () => {
  const report = markdownReport({
    date: '2026-10-30',
    repo: 'o/r',
    github: { error: 'gh: not logged in | try gh auth login' },
    releases: { releases: 1, total: 3, byKind: { vsix: 3 }, latest: { tag: 'v1.0.0', downloads: 3 } },
    codeSearch: { files: 2, repositories: 1, repositoriesCapped: false },
    npm: { listed: false },
    marketplace: { listed: true, installs: 1234, updates: 5, downloads: 99 },
    openVsx: { listed: false },
    pypi: { listed: true, lastWeek: 1, lastMonth: 7 },
  });
  assert.match(report, /^### Styled Markdown adoption, 2026-10-30\n\n\| Source \| Metric \| Value \|/);
  assert.match(report, /\| GitHub \| — \| unavailable: gh: not logged in \\\| try gh auth login \|/);
  assert.match(report, /\| npm \| — \| not listed \|/);
  assert.match(report, /\| Open VSX \| — \| not listed \|/);
  assert.match(report, /\| VS Code Marketplace \| Installs \| 1,234 \|/);
  assert.match(report, /\| GitHub releases \| Asset downloads, latest \(v1\.0\.0\) \| 3 \|/);
  assert.match(report, /\| PyPI \(MkDocs plugin\) \| Downloads, last month \| 7 \|/);
});

test('arguments: --json, --repo and --maintainers; anything else is an error', () => {
  assert.deepEqual(parseArgs(['--json', '--repo', 'a/b', '--maintainers', 'x, y']), { json: true, repo: 'a/b', maintainers: ['x', 'y'] });
  assert.throws(() => parseArgs(['--repo', 'nope']), /owner\/name/);
  assert.throws(() => parseArgs(['--frobnicate']), /Unknown argument/);
});
