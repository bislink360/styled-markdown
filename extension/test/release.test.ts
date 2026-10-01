// Tests for the release workflow's scripts (extension/scripts/release).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changelogExcerpt, downloadsTable, dropEmptyHeadings, releaseNotes, versionFromTag } from '../scripts/release/changelog-excerpt.mjs';
import { checkRelease, isReleaseBranch } from '../scripts/release/check-versions.mjs';
import { isListed, listedVersions, registryRequest, waitForVersion } from '../scripts/release/wait-for-version.mjs';
import { publishDecision } from '../scripts/release/publish-gate.mjs';

const changelog = [
  '# Changelog',
  '',
  '## 1.5.0 — 2026-10-01',
  '',
  '### ⚠️ Breaking changes',
  '',
  '### Added',
  '- Release workflow.',
  '',
  '### Changed',
  '',
  '### Fixed',
  '- A fix.',
  '',
  '## 1.4.0 — 2026-09-30',
  '',
  'No breaking changes.',
  '',
  '### Added',
  '- Tasks view.',
  '',
  '## 1.4.0-beta — 2026-09-29',
  '',
  '- Not this one.',
  '',
  '## 1.3.0 — 2026-09-29',
  '',
  '### Added',
  '',
].join('\n');

test('versionFromTag accepts vX.Y.Z, X.Y.Z and refs/tags/vX.Y.Z only', () => {
  assert.equal(versionFromTag('v1.5.0'), '1.5.0');
  assert.equal(versionFromTag('1.5.0'), '1.5.0');
  assert.equal(versionFromTag('refs/tags/v10.0.12'), '10.0.12');
  assert.equal(versionFromTag('v1.5'), undefined);
  assert.equal(versionFromTag('v1.5.0-rc.1'), undefined);
  assert.equal(versionFromTag(undefined), undefined);
});

test('changelogExcerpt returns one section without its heading or empty subheadings', () => {
  assert.equal(changelogExcerpt(changelog, '1.5.0'), '### Added\n- Release workflow.\n\n### Fixed\n- A fix.');
  assert.equal(changelogExcerpt(changelog, '1.4.0'), 'No breaking changes.\n\n### Added\n- Tasks view.');
});

test('changelogExcerpt is undefined for a missing or empty section', () => {
  assert.equal(changelogExcerpt(changelog, '1.3.0'), undefined);
  assert.equal(changelogExcerpt(changelog, '2.0.0'), undefined);
  assert.equal(changelogExcerpt(changelog, '1.4'), undefined);
});

test('changelogExcerpt handles CRLF and the last section', () => {
  const crlf = '# Changelog\r\n\r\n## 1.0.0 — 2026-09-26\r\n\r\nFirst release.\r\n';
  assert.equal(changelogExcerpt(crlf, '1.0.0'), 'First release.');
});

test('dropEmptyHeadings keeps headings with content, including nested ones', () => {
  assert.deepEqual(dropEmptyHeadings(['### A', '', '### B', '#### B1', 'text', '### C']), ['', '### B', '#### B1', 'text']);
  assert.deepEqual(dropEmptyHeadings(['### A', '#### A1', '', '### B']), ['']);
  assert.deepEqual(dropEmptyHeadings(['### A', '#### A1', '#### A2', 'text']), ['### A', '#### A2', 'text']);
});

test('the real CHANGELOG has an excerpt for every released version', () => {
  const real = readFileSync(join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8');
  for (const version of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0']) {
    const excerpt = changelogExcerpt(real, version);
    assert.ok(excerpt && excerpt.length > 100, version);
    assert.ok(!/^## /m.test(excerpt), `${version} excerpt leaks into the next section`);
  }
});

test('releaseNotes puts the downloads table first when asked', () => {
  assert.equal(releaseNotes('1.5.0', 'Body'), 'Body\n');
  const notes = releaseNotes('1.5.0', 'Body', { downloads: true });
  assert.ok(notes.startsWith('## Downloads\n'));
  assert.ok(notes.endsWith('\n\nBody\n'));
  for (const asset of ['styled-markdown-1.5.0.vsix', 'styled-markdown-1.5.0.tgz', 'styled-markdown-reader.zip', 'styled-markdown-writer.zip']) {
    assert.ok(downloadsTable('1.5.0').includes(`\`${asset}\``), asset);
  }
});

test('isReleaseBranch accepts main and release/* only', () => {
  for (const name of ['origin/main', 'origin/release/v1.5.0', 'main', 'release/v2.0.0', 'refs/remotes/origin/main']) assert.ok(isReleaseBranch(name), name);
  for (const name of ['origin/feat/x', 'origin/mainline', 'origin/release', 'origin/chore/release-automation', 'origin/HEAD -> origin/main']) {
    assert.ok(!isReleaseBranch(name), name);
  }
});

const good = { tag: 'v1.5.0', extensionVersion: '1.5.0', lockVersion: '1.5.0', npmVersion: '1.5.0', changelog };

test('checkRelease passes a consistent release', () => {
  assert.deepEqual(checkRelease(good), []);
  assert.deepEqual(checkRelease({ ...good, branches: ['origin/feat/x', 'origin/release/v1.5.0'] }), []);
});

test('checkRelease reports every mismatch', () => {
  const problems = checkRelease({ ...good, tag: 'v1.3.0', npmVersion: undefined, branches: ['origin/feat/x'] });
  assert.equal(problems.length, 5);
  assert.match(problems[0], /extension\/package\.json has version 1\.5\.0, the tag is v1\.3\.0/);
  assert.match(problems[2], /npm\/package\.json has version \(none\)/);
  assert.match(problems[3], /no "## 1\.3\.0" section/);
  assert.match(problems[4], /not on main or a release\/\* branch \(found on: origin\/feat\/x\)/);
  assert.match(checkRelease({ ...good, branches: [] })[0], /found on: no branch/);
});

test('checkRelease rejects tags that are not vX.Y.Z', () => {
  assert.deepEqual(checkRelease({ ...good, tag: 'v1.5.0-rc.1' }), ['"v1.5.0-rc.1" is not a release tag (expected vX.Y.Z).']);
});

test('registryRequest builds the public lookup for each registry', () => {
  assert.equal(registryRequest('npm', '1.5.0')?.url, 'https://registry.npmjs.org/styled-markdown/1.5.0');
  assert.equal(registryRequest('openvsx', '1.5.0')?.url, 'https://open-vsx.org/api/bislink360/styled-markdown/1.5.0');
  const marketplace = registryRequest('marketplace', '1.5.0');
  assert.equal(marketplace?.init.method, 'POST');
  assert.match(String(marketplace?.init.body), /"value":"bislink360\.styled-markdown"/);
  assert.equal(registryRequest('pypi', '1.5.0'), undefined);
});

test('listedVersions reads each registry response', () => {
  assert.deepEqual(listedVersions('npm', { version: '1.5.0' }), ['1.5.0']);
  assert.deepEqual(listedVersions('openvsx', { error: 'not found' }), []);
  const gallery = { results: [{ extensions: [{ versions: [{ version: '1.5.0' }, { version: '1.4.0' }] }] }] };
  assert.deepEqual(listedVersions('marketplace', gallery), ['1.5.0', '1.4.0']);
  assert.deepEqual(listedVersions('marketplace', { results: [{ extensions: [] }] }), []);
});

const reply = (ok: boolean, json: unknown) => async () => ({ ok, json: async () => json }) as Response;

test('isListed treats HTTP and network errors as not listed', async () => {
  assert.equal(await isListed('npm', '1.5.0', reply(true, { version: '1.5.0' })), true);
  assert.equal(await isListed('npm', '1.5.0', reply(false, {})), false);
  assert.equal(await isListed('npm', '1.5.0', async () => { throw new Error('offline'); }), false);
});

test('waitForVersion retries until the version is listed', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: calls >= 3, json: async () => ({ version: '1.5.0' }) } as Response;
  };
  const lines: string[] = [];
  assert.equal(await waitForVersion('openvsx', '1.5.0', { attempts: 5, delayMs: 0, fetchImpl, log: (line: string) => lines.push(line) }), true);
  assert.equal(calls, 3);
  assert.equal(lines.at(-1), 'openvsx: 1.5.0 is listed.');
  assert.equal(await waitForVersion('npm', '9.9.9', { attempts: 2, delayMs: 0, fetchImpl: reply(false, {}), log: () => {} }), false);
});

const gate = { registry: 'openvsx', version: '1.5.0', secret: 'OVSX_PAT', dryRun: false, hasToken: true, listed: false };

test('publishDecision publishes only with a token, outside a dry run, when not listed yet', () => {
  assert.deepEqual(publishDecision(gate), { ready: true });
  assert.deepEqual(publishDecision({ ...gate, dryRun: true, hasToken: false }), { ready: false, notice: 'Dry run: 1.5.0 was not published to Open VSX.' });
  const missing = publishDecision({ ...gate, registry: 'npm', secret: 'NPM_TOKEN', hasToken: false });
  assert.equal(missing.ready, false);
  assert.match(String(missing.notice), /^NPM_TOKEN is not set, so 1\.5\.0 was not published to npm\./);
  assert.deepEqual(publishDecision({ ...gate, registry: 'marketplace', listed: true }), { ready: false, notice: 'VS Code Marketplace already lists 1.5.0; nothing to publish.' });
});
