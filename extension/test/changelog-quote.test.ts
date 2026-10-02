import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import smd from '../src/core/markdownIt';
import {
  agentView, applyFixes, formatSmd, parseSmd, querySmd, renderSmd, smdToMarkdown, validateSmd, type Diagnostic,
} from '../src/core';
import { compareVersions, findChangelogs, isIsoDate, parseVersion, splitEntry, versionKey } from '../src/core/changelog';
import { quoteCite } from '../src/core/quote';

const corpus = (name: string) => readFileSync(join(__dirname, 'compat', 'corpus', `${name}.smd`), 'utf8');
const codes = (diagnostics: Diagnostic[]) => diagnostics.map((d) => `${d.line}:${d.code}:${d.severity}`);
const body = (html: string) => html.replace(/^<article class="smd-doc">/, '').replace(/<\/article>$/, '');

const changelog = [
  ':::changelog Release history',
  'Newest first.',
  '',
  '## 1.2.0 — 2026-03-01',
  '- Added *export*',
  '',
  '## [1.1.0] - 2026-01-15',
  '### Fixed',
  '- Dates',
  '',
  '## Unreleased',
  ':::',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

test('changelog: entries render as a timeline list with versions and <time> dates, in the order written', () => {
  assert.equal(body(renderSmd(changelog).html),
    '<div class="smd-changelog" data-line="0"><div class="smd-changelog-title">Release history</div>\n'
    + '<p data-line="1">Newest first.</p>\n'
    + '<ol class="smd-changelog-list">\n'
    + '<li class="smd-changelog-entry">\n'
    + '<h2 id="120-2026-03-01" data-line="3"><span class="smd-changelog-version">1.2.0</span> — <time class="smd-changelog-date" datetime="2026-03-01">2026-03-01</time></h2>\n'
    + '<ul data-line="4">\n<li data-line="4">Added <em>export</em></li>\n</ul>\n'
    + '</li>\n'
    + '<li class="smd-changelog-entry">\n'
    + '<h2 id="110-2026-01-15" data-line="6"><span class="smd-changelog-version">[1.1.0]</span> - <time class="smd-changelog-date" datetime="2026-01-15">2026-01-15</time></h2>\n'
    + '<h3 id="fixed" data-line="7">Fixed</h3>\n'
    + '<ul data-line="8">\n<li data-line="8">Dates</li>\n</ul>\n'
    + '</li>\n'
    + '<li class="smd-changelog-entry">\n'
    + '<h2 id="unreleased" data-line="10"><span class="smd-changelog-version">Unreleased</span></h2>\n'
    + '</li>\n'
    + '</ol>\n'
    + '</div>\n');
});

test('changelog: release headings keep the ids and outline entries they have in any other block', () => {
  const asBox = changelog.replace(':::changelog', ':::box');
  const ids = (html: string) => [...html.matchAll(/<h\d id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids(renderSmd(changelog).html), ids(renderSmd(asBox).html));
  assert.deepEqual(renderSmd(changelog).headings, renderSmd(asBox).headings);
  assert.deepEqual(parseSmd(changelog).headings, parseSmd(asBox).headings);
  const withLinks = `[1.2.0](https://example.com/1.2.0)\n\n${changelog.replace('## 1.2.0 — 2026-03-01', '## [1.2.0](https://x.test/c) — 2026-03-01 {#v12 .big}')}`;
  assert.match(renderSmd(withLinks).html,
    /<h2 id="v12" class="smd-u-big" data-line="5"><span class="smd-changelog-version"><a href="https:\/\/x.test\/c">1.2.0<\/a><\/span> — <time/);
});

test('changelog: invalid dates stay text; content before the first release and deeper headings are not entries', () => {
  const html = renderSmd(':::changelog\n### Intro\n## 2.0 — 2026-02-30\nx\n## v1 (2026-01-02)\n:::\n').html;
  assert.match(html, /<h3 id="intro" data-line="1">Intro<\/h3>\n<ol class="smd-changelog-list">/);
  assert.match(html, /<span class="smd-changelog-version">2.0<\/span> — <span class="smd-changelog-date smd-changelog-date-invalid">2026-02-30<\/span>/);
  assert.match(html, /<span class="smd-changelog-version">v1<\/span> \(<time class="smd-changelog-date" datetime="2026-01-02">2026-01-02<\/time>\)/);
  assert.equal(renderSmd(':::changelog\nNo releases yet.\n:::\n').html, '<article class="smd-doc"><div class="smd-changelog" data-line="0">\n<p data-line="1">No releases yet.</p>\n</div>\n</article>');
});

test('changelog: headings in nested blocks are not entries; a nested changelog has its own list', () => {
  const html = renderSmd(':::changelog\n## 1.0 — 2026-01-01\n:::note\n## Inside a note\n:::\n::::changelog\n### 0.1 — 2025-01-01\n::::\n:::\n').html;
  assert.equal((html.match(/<ol class="smd-changelog-list">/g) ?? []).length, 2);
  assert.match(html, /<h2 id="inside-a-note" data-line="3">Inside a note<\/h2>/);
  assert.match(html, /<span class="smd-changelog-version">0.1<\/span>/);
});

test('changelog: entry headings split into version and date', () => {
  assert.deepEqual(splitEntry('1.2.0 — 2026-03-01'), { version: '1.2.0', date: '2026-03-01', dateStart: 5 });
  assert.deepEqual(splitEntry('[1.2.0] - 2026-03-01'), { version: '[1.2.0]', date: '2026-03-01', dateStart: 7 });
  assert.deepEqual(splitEntry('Release 1.2.0-beta - The big one -- 2026-03-01'), { version: 'Release 1.2.0-beta - The big one', date: '2026-03-01', dateStart: 32 });
  assert.deepEqual(splitEntry('v2 (2026-1-2)'), { version: 'v2', date: '2026-1-2', dateStart: 2 });
  assert.deepEqual(splitEntry('2.0 (beta)'), { version: '2.0 (beta)' });
  assert.deepEqual(splitEntry('Unreleased'), { version: 'Unreleased' });
  assert.deepEqual(splitEntry('— 2026-03-01'), { version: '— 2026-03-01' });
  assert.ok(isIsoDate('2024-02-29'));
  assert.ok(!isIsoDate('2026-02-29'));
  assert.ok(!isIsoDate('2026-3-1'));
});

test('changelog: versions compare as semantic versions', () => {
  const v = (s: string) => parseVersion(s)!;
  const sorted = ['1.10.0', '1.2.0', '1.2.0-rc.1', '1.2.0-beta.11', '1.2.0-beta.2', '1.2.0-alpha', '1.2', 'v1.1.9']
    .sort((a, b) => compareVersions(v(b), v(a)));
  assert.deepEqual(sorted, ['1.10.0', '1.2.0', '1.2', '1.2.0-rc.1', '1.2.0-beta.11', '1.2.0-beta.2', '1.2.0-alpha', 'v1.1.9']);
  assert.deepEqual(parseVersion('[v2.0.1](https://x.test/v3)'), { parts: [2, 0, 1], pre: [] });
  assert.equal(parseVersion('Unreleased'), undefined);
  assert.equal(versionKey('v1.2'), '1.2');
  assert.equal(versionKey('Unreleased'), 'unreleased');
});

test('changelog: the scanner skips code and nested blocks, and takes the highest heading level used', () => {
  const blocks = findChangelogs(['```', ':::changelog', '```', ':::changelog', '### 1.1', '```', '## no', '```', '## 1.0', ':::note', '## inner', ':::', ':::']);
  assert.deepEqual(blocks.map((b) => [b.line, b.entries.map((e) => `${e.line}:${e.version}`)]), [[3, ['8:1.0']]]);
  assert.deepEqual(findChangelogs(['# x']), []);
});

test('changelog: validation warns about bad dates, order and duplicates, with a fix for year-first dates', () => {
  const src = ':::changelog\n## 1.3.0 — 2026/3/1\n## 1.4.0 — 2026-02-01\n## 1.2.0 — March 2026\n## v1.2 — 2025-12-01\n## Unreleased\n## Unreleased\n## 1.1.0-rc.1 — 2026-02-30\n:::\n';
  const diagnostics = validateSmd(src);
  assert.deepEqual(codes(diagnostics), [
    '1:changelog/date:warning', '2:changelog/order:warning', '3:changelog/date:warning', '4:changelog/duplicate:warning',
    '6:changelog/duplicate:warning', '7:changelog/date:warning',
  ]);
  assert.match(diagnostics[1].message, /Version 1.4.0 is newer than 1.3.0 on line 2/);
  assert.match(diagnostics[3].message, /Version v1.2 is already listed on line 4/);
  assert.deepEqual([diagnostics[0].column, diagnostics[0].endColumn], [11, 19]);
  assert.equal(diagnostics[2].fix, undefined);
  assert.match(applyFixes(src, diagnostics).text, /^## 1\.3\.0 — 2026-03-01$/m);
  assert.deepEqual(validateSmd(changelog), []);
  assert.ok(validateSmd(src).every((d) => d.severity === 'warning'));
});

test('changelog: agent view lists version and date, then the entries', () => {
  const view = agentView(changelog).text;
  assert.equal(view, '<changelog title="Release history">\nNewest first.\n\n## 1.2.0 (2026-03-01)  [L4]\n- Added *export*\n\n'
    + '## 1.1.0 (2026-01-15)  [L7]\n### Fixed  [L8]\n- Dates\n\n## Unreleased  [L11]\n</changelog>\n');
  const [match] = querySmd(changelog, 'changelog');
  assert.equal(match.title, 'Release history');
  assert.match(match.text, /^<changelog title="Release history">\n[\s\S]*## 1\.2\.0 \(2026-03-01\)/);
  assert.match(agentView(changelog, { sections: ['1.2.0'] }).text, /^## 1\.2\.0 \(2026-03-01\)  \[L4\]\n- Added \*export\*$/m);
});

test('changelog: to-md keeps the headings and lists under a bold title', () => {
  assert.equal(smdToMarkdown(changelog), '**Release history**\n\nNewest first.\n\n## 1.2.0 — 2026-03-01\n- Added *export*\n\n'
    + '## [1.1.0] - 2026-01-15\n### Fixed\n- Dates\n\n## Unreleased\n');
});

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

const quote = ':::quote{author="Ada *Lovelace*" source="Notes" cite="https://example.com/notes?a=1&b=2"}\nThe engine weaves **patterns**.\n:::\n';

test('quote: renders as a figure with a cited blockquote and an attribution caption', () => {
  assert.equal(body(renderSmd(quote).html),
    '<figure class="smd-quote" data-line="0"><blockquote cite="https://example.com/notes?a=1&amp;b=2">\n'
    + '<p data-line="1">The engine weaves <strong>patterns</strong>.</p>\n'
    + '</blockquote><figcaption class="smd-quote-caption">— <span class="smd-quote-author">Ada <em>Lovelace</em></span>, '
    + '<cite><a href="https://example.com/notes?a=1&amp;b=2">Notes</a></cite></figcaption></figure>\n');
  assert.equal(body(renderSmd(':::quote{#q .wide}\nx\n:::\n').html),
    '<figure id="q" class="smd-quote smd-u-wide" data-line="0"><blockquote>\n<p data-line="1">x</p>\n</blockquote></figure>\n');
  assert.match(renderSmd(':::quote{source="[Book](b.smd)" cite="https://x.test"}\nx\n:::\n').html, /— <cite><a href="b.smd">Book<\/a><\/cite><\/figcaption>/);
});

test('quote: cite keeps only http(s) and relative URLs', () => {
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:x', 'data:text/html,x', 'mailto:a@b.c', '//evil.test/x', String.raw`\\evil`, '/\\evil', 'a b', ' ']) {
    assert.equal(quoteCite(bad), undefined, bad);
    const html = renderSmd(`:::quote{author=A source=S cite="${bad}"}\nx\n:::\n`).html;
    assert.ok(!html.includes(' cite=') && !html.includes('href='), bad);
  }
  for (const good of ['https://x.test/a', 'http://x.test', 'notes.smd#part', '/quotes/1', '?q=1']) assert.equal(quoteCite(good), good);
  assert.match(renderSmd(':::quote{cite="https://x.test/ä b"}\nx\n:::\n').html, /<blockquote>/);
  assert.match(renderSmd(':::quote{cite="https://x.test/ä"}\nx\n:::\n').html, /<blockquote cite="https:\/\/x.test\/%C3%A4">/);
});

test('quote: never numbered as a figure', () => {
  const src = ':::quote{author=A}\nq\n:::\n\n:::figure{#f} Cap\nx\n:::\n\n:ref[f]\n';
  assert.match(renderSmd(src).html, /<a class="smd-ref" href="#f">Figure 1<\/a>/);
  assert.match(renderSmd(src).html, /Figure 1:<\/span> Cap/);
  assert.deepEqual(parseSmd(src).figures.map((f) => f.label), ['Figure 1']);
  assert.match(agentView(src, { lineRefs: false }).text, /<figure id="f"> Figure 1: Cap/);
});

test('quote: validation warns about an empty body, a missing author and a dropped cite', () => {
  assert.deepEqual(codes(validateSmd(':::quote{cite="javascript:x"}\n\n:::\n')), ['0:quote/empty:warning', '0:quote/author:warning', '0:quote/cite:warning']);
  assert.deepEqual(codes(validateSmd(':::quote{author="A"}\n```\ncode\n```\n:::\n')), []);
  assert.deepEqual(codes(validateSmd(':::quote{author="A"}\n:::\n')), ['0:quote/empty:warning']);
  assert.deepEqual(codes(validateSmd(':::quote{author="A" by=x}\nq\n:::\n')), ['0:attrs/unknown:warning']);
  assert.deepEqual(codes(validateSmd('```\n:::quote\n```\n')), []);
  const [first] = validateSmd('  :::quote\n  x\n  :::\n');
  assert.deepEqual([first.column, first.endColumn], [5, 10]);
  assert.deepEqual(validateSmd(quote), []);
});

test('quote: agent view tags the quote with its attribution', () => {
  assert.equal(agentView(quote).text, '<quote author="Ada *Lovelace*" source="Notes" cite="https://example.com/notes?a=1&b=2">\nThe engine weaves **patterns**.\n</quote>\n');
  assert.equal(agentView(':::quote{cite="javascript:x"}\nq\n:::\n').text, '<quote>\nq\n</quote>\n');
  assert.deepEqual(querySmd(quote, 'quote[author*=lovelace]').map((m) => m.line), [0]);
});

test('quote: to-md is a blockquote that ends with the attribution', () => {
  // Like every blockquote block, it ends with a blank line so the next one doesn't merge into it.
  assert.equal(smdToMarkdown(quote), '> The engine weaves **patterns**.\n>\n> — Ada *Lovelace*, *[Notes](https://example.com/notes?a=1&b=2)*\n\n');
  assert.equal(smdToMarkdown(':::quote{source="*Book*"}\nq\n:::\n'), '> q\n>\n> — *Book*\n\n');
  assert.equal(smdToMarkdown(':::quote\nq\n:::\n'), '> q\n\n');
  assert.equal(smdToMarkdown(':::card\n:::quote{author=A}\nq\n:::\n:::\n'), '> > q\n> >\n> > — A\n>\n\n');
});

// ---------------------------------------------------------------------------
// Both
// ---------------------------------------------------------------------------

test('changelog and quote: the markdown-it plugin renders them like renderSmd', () => {
  const doc = `${changelog}\n${quote}`;
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true }).use(smd, { codeFrames: true, headingIds: true, sourceLines: true });
  assert.equal(`<article class="smd-doc">${md.render(doc)}</article>`, renderSmd(doc).html);
  const plain = new MarkdownIt().use(smd).render('::: changelog\n## 1.0 -- 2026-01-01\n:::\n');
  assert.equal(plain, '<div class="smd-changelog" data-line="0">\n<ol class="smd-changelog-list">\n<li class="smd-changelog-entry">\n'
    + '<h2><span class="smd-changelog-version">1.0</span> -- <time class="smd-changelog-date" datetime="2026-01-01">2026-01-01</time></h2>\n</li>\n</ol>\n</div>\n');
  assert.match(new MarkdownIt().use(smd, { containers: false }).render(quote), /^<p>:::quote/);
});

test('changelog and quote: the corpus documents are valid and formatted', () => {
  for (const name of ['changelog', 'quote']) {
    const text = corpus(name);
    assert.deepEqual(validateSmd(text, { today: '2026-10-01' }), [], name);
    assert.equal(formatSmd(text), text, name);
  }
  assert.equal(formatSmd(':::quote{cite="https://x.test" source="S" author="A B"}\nq\n:::\n'), ':::quote{author="A B" source="S" cite="https://x.test"}\nq\n:::\n');
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('changelog and quote: smd validate reports only warnings, so it still exits 0', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-cq-'));
  try {
    writeFileSync(join(dir, 'doc.smd'), '---\nsmd: 1\n---\n\n:::changelog\n## 1.0 — 2026/1/1\n## 2.0 — 2026-02-01\n:::\n\n:::quote\n:::\n');
    const run = spawnSync(process.execPath, [cli, 'validate', 'doc.smd', '--no-mermaid'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /changelog\/date/);
    assert.match(run.stdout, /changelog\/order/);
    assert.match(run.stdout, /quote\/empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
