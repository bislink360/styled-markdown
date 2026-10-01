import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSite, type SiteSource } from '../src/core';
import { dashboardHtml } from '../src/core/siteDashboard';
import { joinPath, linker, normalizeBase, pageOutput, relativeHref, rewriteLinks, siteBacklinks } from '../src/core/siteLinks';
import { breadcrumbsHtml, navOrder, navTree, pagerHtml, sidebarHtml, type SitePage } from '../src/core/siteNav';
import { excerpt, searchDoc, searchIndexScript } from '../src/core/siteSearch';
import { renderSmd } from '../src/core/render';
import { collectSources, isInside, outProblem, previousBuild, removeFiles, runBuild, SITE_MARKER } from '../src/siteBuild';

const assets = { css: '/*css*/', runtimeJs: '/*runtime*/', siteCss: '/*site css*/', siteJs: '/*site js*/' };
const fileOf = (build: ReturnType<typeof buildSite>, path: string) => build.files.find((f) => f.path === path)?.content ?? '';

// ---------------------------------------------------------------------------
// Paths and link rewriting
// ---------------------------------------------------------------------------

test('page paths mirror the source folders; relative hrefs climb only as far as needed', () => {
  assert.equal(pageOutput('guide/setup.smd'), 'guide/setup.html');
  assert.equal(pageOutput('README.md'), 'README.html');
  assert.equal(joinPath('guide/deep', '../setup.smd'), 'guide/setup.smd');
  assert.equal(joinPath('guide', './a/./b.smd'), 'guide/a/b.smd');
  assert.equal(joinPath('guide', '../../outside.smd'), undefined);
  assert.equal(relativeHref('guide/a.html', 'guide/b.html'), 'b.html');
  assert.equal(relativeHref('guide/deep/a.html', 'api/b.html'), '../../api/b.html');
  assert.equal(relativeHref('index.html', 'guide/my page.html'), 'guide/my%20page.html');
  assert.equal(normalizeBase('docs'), '/docs/');
  assert.equal(normalizeBase('/docs'), '/docs/');
  assert.equal(normalizeBase('https://example.com/docs'), 'https://example.com/docs/');
  assert.equal(linker('/docs/').href('guide/deep/a.html', 'api/b.html'), '/docs/api/b.html');
});

test('rewriteLinks points document links at pages, keeps anchors, external links and #fragments, and collects files', () => {
  const pages = new Map([['guide/setup.smd', 'guide/setup.html'], ['api/orders.md', 'api/orders.html'], ['README.md', 'index.html']]);
  const html = [
    '<a href="setup.smd#install">a</a>',
    '<a href="../api/orders.md">b</a>',
    '<a href="../README.md#top">c</a>',
    '<a href="https://example.com/x.smd">d</a>',
    '<a href="#local">e</a>',
    '<img src="../img/logo%20big.png" alt="">',
    '<a href="../../escape.smd">f</a>',
    '<a href="missing.smd">g</a>',
    '<a href="mailto:a@b.c">h</a>',
    '<a href="files/report.pdf?x=1&amp;y=2">i</a>',
    '<code>&lt;a href=&quot;setup.smd&quot;&gt;</code>',
  ].join('\n');
  const relative = rewriteLinks(html, 'guide/intro.smd', 'guide/intro.html', { pages, linker: linker() });
  assert.match(relative.html, /href="setup\.html#install"/);
  assert.match(relative.html, /href="\.\.\/api\/orders\.html"/);
  assert.match(relative.html, /href="\.\.\/index\.html#top"/);
  assert.match(relative.html, /href="https:\/\/example\.com\/x\.smd"/);
  assert.match(relative.html, /href="#local"/);
  assert.match(relative.html, /src="\.\.\/img\/logo%20big\.png"/);
  assert.match(relative.html, /href="\.\.\/\.\.\/escape\.smd"/, 'links above the source folder stay as written');
  assert.match(relative.html, /href="missing\.smd"/, 'a .smd file that is not a page stays as written');
  assert.match(relative.html, /href="mailto:a@b\.c"/);
  assert.match(relative.html, /href="files\/report\.pdf\?x=1&amp;y=2"/);
  assert.match(relative.html, /&lt;a href=&quot;setup\.smd&quot;&gt;/, 'code is never rewritten');
  assert.deepEqual(relative.assets.sort(), ['guide/files/report.pdf', 'img/logo big.png']);

  const based = rewriteLinks(html, 'guide/intro.smd', 'guide/intro.html', { pages, linker: linker('/docs/') });
  assert.match(based.html, /href="\/docs\/guide\/setup\.html#install"/);
  assert.match(based.html, /href="\/docs\/index\.html#top"/);
  assert.match(based.html, /src="\/docs\/img\/logo%20big\.png"/);
  assert.match(based.html, /href="#local"/);
  assert.match(based.html, /href="https:\/\/example\.com\/x\.smd"/);
});

test('siteBacklinks lists each linking document once, from links and related:, never the document itself', () => {
  const docs = [
    { path: 'a.smd', text: '# A\n\n[b](b.smd) [b again](b.smd#x) [self](a.smd) [ext](https://x.dev/b.smd)\n' },
    { path: 'guide/c.smd', text: '---\nrelated: [../b.smd]\n---\n# C\n' },
    { path: 'b.smd', text: '# B\n\n[nowhere](missing.smd)\n' },
  ];
  const backlinks = siteBacklinks(docs);
  assert.deepEqual(backlinks.get('b.smd')?.sort(), ['a.smd', 'guide/c.smd']);
  assert.equal(backlinks.get('a.smd'), undefined);
  assert.equal(backlinks.has('missing.smd'), false);
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const page = (source: string, title: string): SitePage => ({ source, output: pageOutput(source), title });

test('navTree orders documents and folders by title; index or README is the folder overview', () => {
  const home = { ...page('README.md', 'Home'), output: 'index.html' };
  const pages = [
    home,
    page('zeta.smd', 'Alpha doc'),
    page('alpha.smd', 'beta doc'),
    page('guide/setup.smd', 'Setup'),
    page('guide/README.md', 'Guide'),
    page('guide/index.smd', 'Guide index'),
    page('api/b.smd', 'B'),
    page('api/a.smd', 'A'),
  ];
  const tree = navTree(pages, home);
  assert.deepEqual(tree.pages.map((p) => p.title), ['Alpha doc', 'beta doc']);
  assert.deepEqual(tree.folders.map((f) => f.name), ['api', 'guide'], 'folders by title: "api" < "Guide index"');
  const guide = tree.folders[1];
  assert.equal(guide.index?.source, 'guide/index.smd', 'index.smd wins over README.md');
  assert.deepEqual(guide.pages.map((p) => p.title), ['Guide', 'Setup']);
  assert.deepEqual(navOrder(tree, home).map((p) => p.source),
    ['README.md', 'zeta.smd', 'alpha.smd', 'api/a.smd', 'api/b.smd', 'guide/index.smd', 'guide/README.md', 'guide/setup.smd']);

  const html = sidebarHtml(tree, 'guide/setup.html', linker());
  assert.match(html, /<a href="setup\.html" aria-current="page">Setup<\/a>/);
  assert.match(html, /<details open><summary><a href="index\.html">Guide index<\/a>/);
  assert.match(html, /<details><summary><span>api<\/span>/, 'other folders stay closed');
  assert.match(html, /<a href="\.\.\/zeta\.html">Alpha doc<\/a>/);
});

test('breadcrumbs and previous/next links', () => {
  const home = { ...page('index.smd', 'Docs'), output: 'index.html' };
  const pages = [home, page('guide/README.md', 'Guide'), page('guide/deep/x.smd', 'X <y>'), page('guide/a.smd', 'A')];
  const tree = navTree(pages, home);
  const x = pages[2];
  const crumbs = breadcrumbsHtml(tree, x, home, linker());
  assert.match(crumbs, /<a href="\.\.\/\.\.\/index\.html">Docs<\/a>.*<a href="\.\.\/README\.html">Guide<\/a>.*<span>deep<\/span>.*<span aria-current="page">X &lt;y&gt;<\/span>/);
  assert.equal(breadcrumbsHtml(tree, home, home, linker()), '');
  const order = navOrder(tree, home);
  assert.deepEqual(order.map((p) => p.title), ['Docs', 'Guide', 'A', 'X <y>']);
  const pager = pagerHtml(order, pages[3], linker());
  assert.match(pager, /rel="prev" href="README\.html"><span>Previous<\/span>Guide<\/a>/);
  assert.match(pager, /rel="next" href="deep\/x\.html"><span>Next<\/span>X &lt;y&gt;<\/a>/);
  assert.doesNotMatch(pagerHtml(order, x, linker()), /rel="next"/);
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test('searchDoc indexes the title, summary, intro and an excerpt of each section, human-only content included', () => {
  const text = '---\ntitle: Payments\nsummary: How we take money.\n---\nIntro about **cards**.\n\n## Refunds {#refunds}\n\n:::human\nOnly for people: refund window is 30 days.\n:::\n\n## Fees\n\n| Fee | Amount |\n|---|---|\n| Card | 2% |\n\n- [Docs](other.smd) explain it\n';
  const doc = searchDoc({ output: 'pay/payments.html', title: 'Payments', text, headings: renderSmd(text).headings });
  assert.equal(doc.t, 'Payments');
  assert.equal(doc.u, 'pay/payments.html');
  assert.equal(doc.s, 'How we take money.');
  assert.equal(doc.x, 'Intro about cards.');
  assert.deepEqual(doc.h.map((h) => [h.h, h.a]), [['Refunds', 'refunds'], ['Fees', 'fees']]);
  assert.match(doc.h[0].x, /refund window is 30 days/);
  assert.equal(doc.h[1].x, 'Fee Amount Card 2% Docs explain it');
});

test('excerpt shortens at a word and the index script cannot close a script tag', () => {
  const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
  const short = excerpt(long, 50);
  assert.ok(short.length <= 51 && short.endsWith('…'));
  assert.match(short, /word\d+…$/, 'cut after a whole word');
  const script = searchIndexScript({ v: 1, docs: [{ t: '</script><script>alert(1)</script>', u: 'a.html', s: '', x: '', h: [] }] });
  assert.doesNotMatch(script, /<\/script>/i);
  assert.match(script, /^window\.SMD_SEARCH_INDEX=/);
  const index = JSON.parse(script.replace(/^window\.SMD_SEARCH_INDEX=/, '').replace(/;\n$/, ''));
  assert.equal(index.docs[0].t, '</script><script>alert(1)</script>');
});

// The site script (media/site.js) exports its pure helpers when loaded outside a browser.
const siteJs = createRequire(__filename)(join(__dirname, '..', 'media', 'site.js'));

test('site search ranks title and heading matches first and needs every word', () => {
  const index = {
    v: 1,
    docs: [
      { t: 'Payments', u: 'payments.html', s: 'Cards and refunds', x: '', h: [{ h: 'Refunds', a: 'refunds', x: 'Refund window is 30 days.' }] },
      { t: 'Orders', u: 'orders.html', s: '', x: 'Orders can be refunded.', h: [{ h: 'Cancel', a: 'cancel', x: 'Cancel then refund the payment.' }] },
    ],
  };
  const results = siteJs.search(index, 'refund');
  assert.equal(results[0].url, 'payments.html#refunds');
  assert.ok(results.some((r: { url: string }) => r.url === 'orders.html#cancel'));
  assert.deepEqual(siteJs.search(index, 'refund payment').map((r: { url: string }) => r.url), ['payments.html', 'payments.html#refunds', 'orders.html#cancel']);
  assert.deepEqual(siteJs.search(index, 'payments').map((r: { url: string }) => r.url), ['payments.html'], 'sections do not match through the page title alone');
  assert.deepEqual(siteJs.search(index, '   '), []);
  assert.deepEqual(siteJs.search(null, 'x'), []);
  assert.deepEqual(siteJs.terms(' "Refund", window? '), ['refund', 'window']);
});

test('site search highlights with text parts and cuts snippets around the first hit', () => {
  assert.deepEqual(siteJs.highlightParts('<b>Refund</b> refund', ['refund']), [
    { text: '<b>', mark: false }, { text: 'Refund', mark: true }, { text: '</b> ', mark: false }, { text: 'refund', mark: true },
  ]);
  assert.deepEqual(siteJs.highlightParts('abc', []), [{ text: 'abc', mark: false }]);
  const text = 'x'.repeat(300) + ' needle ' + 'y'.repeat(300);
  const cut = siteJs.snippet(text, ['needle'], 60);
  assert.ok(cut.includes('needle') && cut.startsWith('…') && cut.endsWith('…'));
  assert.equal(siteJs.snippet('short', ['x'], 60), 'short');
});

test('the site script builds results with DOM text nodes, never innerHTML', () => {
  const source = readFileSync(join(__dirname, '..', 'media', 'site.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

test('dashboard lists open tasks overdue first, decisions and open risks with the matrix, linked and escaped', () => {
  const doc = (source: string, text: string) => ({ source, output: pageOutput(source), title: source, text, headings: renderSmd(text).headings });
  const documents = [
    doc('plan.smd', '# Plan\n\n## Work\n\n- [ ] Later task @li :due[2026-12-01]\n- [ ] Late <script>x</script> @maya :due[2026-01-01]\n- [x] Done task\n'),
    doc('guide/adr.smd', '# ADR\n\n## Choice\n\n:::decision{status=accepted date=2026-05-01 owner=@li} Use <b>queues</b>\nBody\n:::\n\n:::decision{date=2026-06-01} Pick a vendor\n:::\n'),
    doc('risks.smd', '# Risks\n\n## Top\n\n:::risk{impact=high likelihood=high owner=@ops #r1} Outage\nMitigation: failover.\n:::\n\n:::risk{impact=low status=mitigated} Done risk\n:::\n\n:::risk{impact=critical status=closed} Old\n:::\n'),
  ];
  const html = dashboardHtml(documents, { linker: linker(), output: 'dashboard.html', today: '2026-09-29' });
  assert.match(html, /2 open task\(s\), 1 overdue · 2 decision\(s\), 1 proposed · 1 open risk\(s\) · 3 document\(s\)/);
  const tasks = html.slice(html.indexOf('id="tasks"'), html.indexOf('id="decisions"'));
  assert.ok(tasks.indexOf('Late') < tasks.indexOf('Later task'), 'overdue first');
  assert.match(tasks, /smd-due-overdue">2026-01-01/);
  assert.match(tasks, /Late &lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(tasks, /<a href="plan\.html#work">plan\.smd › Work<\/a>/);
  assert.doesNotMatch(tasks, /Done task/);
  const decisions = html.slice(html.indexOf('id="decisions"'), html.indexOf('id="risks"'));
  assert.ok(decisions.indexOf('Pick a vendor') < decisions.indexOf('queues'), 'newest first');
  assert.match(decisions, /<a href="guide\/adr\.html#choice">Use &lt;b&gt;queues&lt;\/b&gt;<\/a>/);
  assert.match(decisions, /smd-decision-status smd-decision-proposed">proposed/);
  const risks = html.slice(html.indexOf('id="risks"'));
  assert.match(risks, /smd-risk-matrix-grid/);
  assert.match(risks, /<a href="risks\.html#r1">Outage<\/a>/);
  assert.doesNotMatch(risks, /Done risk|>Old</);
  assert.match(dashboardHtml([], { linker: linker(), output: 'dashboard.html' }), /No open tasks\.[\s\S]*No decisions\.[\s\S]*No open risks\./);
});

// ---------------------------------------------------------------------------
// The whole site
// ---------------------------------------------------------------------------

const sources: SiteSource[] = [
  { path: 'README.md', text: '---\ntitle: Team <Docs>\n---\n# Welcome\n\nStart with [setup](guide/setup.smd#install). ![logo](img/logo.png)\n' },
  { path: 'guide/setup.smd', text: '---\ntitle: Setup\nsummary: Install it.\n---\n## Install\n\n```mermaid\ngraph TD; A-->B\n```\n\nBack [home](../README.md).\n' },
  { path: 'guide/setup.md', text: '# Shadowed\n' },
  { path: 'dashboard.smd', text: '# My dashboard\n\nMath $x^2$.\n' },
  { path: '_smd/oops.smd', text: '# Clash\n' },
  { path: 'notes.txt', text: 'not a document' },
];

test('buildSite renders every document into the site layout with shared assets', () => {
  const site = buildSite(sources, { today: '2026-09-29', assets });
  const paths = site.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    '_smd/runtime.js', '_smd/search-index.js', '_smd/site.css', '_smd/site.js', '_smd/smd.css',
    'dashboard.html', 'guide/setup.html', 'index.html', 'smd-dashboard.html',
  ]);
  assert.deepEqual(site.skipped, ['_smd/oops.smd', 'guide/setup.md']);
  assert.deepEqual(site.assets, ['img/logo.png']);
  assert.equal(fileOf(site, '_smd/site.js'), '/*site js*/');

  const home = fileOf(site, 'index.html');
  assert.match(home, /<title>Team &lt;Docs&gt;<\/title>/, 'the README is the home page and names the site');
  assert.match(home, /href="guide\/setup\.html#install"/);
  assert.match(home, /<link rel="stylesheet" href="_smd\/smd\.css">/);
  assert.match(home, /<a class="smd-site-dash" href="smd-dashboard\.html">/, 'the dashboard moves aside for a dashboard document');
  assert.doesNotMatch(home, /cdn\.jsdelivr|<style>/, 'no CDN assets without diagrams or math, no inlined CSS');
  assert.match(home, /data-smd-root=""/);

  const setup = fileOf(site, 'guide/setup.html');
  assert.match(setup, /<title>Setup · Team &lt;Docs&gt;<\/title>/);
  assert.match(setup, /<link rel="stylesheet" href="\.\.\/_smd\/site\.css">/);
  assert.match(setup, /<script src="\.\.\/_smd\/runtime\.js"><\/script>/);
  assert.match(setup, /mermaid\.min\.js/);
  assert.match(setup, /href="\.\.\/index\.html">home<\/a>/);
  assert.match(setup, /class="smd-site-crumbs"/);
  assert.match(setup, /<aside class="smd-site-backlinks"[^>]*><h2>Linked from<\/h2><ul><li><a href="\.\.\/index\.html">Team &lt;Docs&gt;<\/a>/);
  assert.match(setup, /data-smd-root="\.\.\/"/);
  assert.match(fileOf(site, 'dashboard.html'), /katex\.min\.css/);

  const index = fileOf(site, '_smd/search-index.js');
  assert.match(index, /"u":"guide\/setup\.html"/);
  assert.match(index, /"s":"Install it\."/);
  assert.match(fileOf(site, 'smd-dashboard.html'), /<h1 id="dashboard">Dashboard<\/h1>/);
});

test('buildSite generates a home index when there is no index or README, and absolute links under --base', () => {
  const site = buildSite([
    { path: 'b.smd', text: '---\ntitle: Beta\nstatus: draft\nsummary: Second <doc>.\n---\n# Beta\n' },
    { path: 'guide/a.smd', text: '# Alpha\n\n[beta](../b.smd)\n' },
  ], { title: 'Handbook', base: '/docs/', assets });
  const home = fileOf(site, 'index.html');
  assert.match(home, /<h1 id="top">Handbook<\/h1>/);
  assert.match(home, /2 document\(s\) · <a href="\/docs\/dashboard\.html">Dashboard<\/a>/);
  assert.match(home, /<a href="\/docs\/b\.html">Beta<\/a> <span class="smd-doc-status smd-doc-status-draft">draft<\/span><div class="smd-site-summary">Second &lt;doc&gt;\.<\/div>/);
  assert.match(home, /<h2>guide<\/h2><ul class="smd-site-index"><li><a href="\/docs\/guide\/a\.html">Alpha<\/a>/);
  assert.match(fileOf(site, 'guide/a.html'), /href="\/docs\/b\.html">beta<\/a>/);
  assert.match(fileOf(site, 'guide/a.html'), /data-smd-root="\/docs\/"/);
  assert.deepEqual(site.pages.map((p) => p.output), ['index.html', 'b.html', 'guide/a.html']);
});

// ---------------------------------------------------------------------------
// Writing safely (siteBuild.ts)
// ---------------------------------------------------------------------------

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'smd-site-'));
}

test('--out is refused inside the sources or around them', () => {
  const root = tempDir();
  try {
    const docs = join(root, 'docs');
    assert.ok(isInside(docs, join(docs, 'site')));
    assert.ok(!isInside(docs, join(root, 'docs-site')));
    assert.match(outProblem(docs, docs) ?? '', /inside the source folder/);
    assert.match(outProblem(docs, join(docs, 'site')) ?? '', /inside the source folder/);
    assert.match(outProblem(docs, root) ?? '', /contains the source folder/);
    assert.equal(outProblem(docs, join(root, 'site')), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing --out is used only when empty or a previous build, and --clean deletes only recorded files', () => {
  const root = tempDir();
  try {
    const out = join(root, 'site');
    assert.equal(previousBuild(out), undefined);
    mkdirSync(out);
    assert.equal(previousBuild(out), undefined);
    writeFileSync(join(out, 'mine.txt'), 'keep');
    assert.match(String(previousBuild(out)), /not empty and is not a previous smd build/);
    writeFileSync(join(out, SITE_MARKER), '{"format":"other","files":[]}');
    assert.match(String(previousBuild(out)), /not a previous smd build/, 'a marker of another format does not count');
    mkdirSync(join(out, 'guide', 'deep'), { recursive: true });
    writeFileSync(join(out, 'guide', 'deep', 'a.html'), 'a');
    writeFileSync(join(out, 'index.html'), 'i');
    writeFileSync(join(root, 'outside.txt'), 'outside');
    writeFileSync(join(out, SITE_MARKER), JSON.stringify({ format: 'smd-site', files: ['index.html', 'guide/deep/a.html', '../outside.txt', 'missing.html', 7] }));
    const files = previousBuild(out);
    assert.deepEqual(files, ['index.html', 'guide/deep/a.html', '../outside.txt', 'missing.html']);
    removeFiles(out, files as string[]);
    assert.deepEqual(readdirSync(out), ['mine.txt'], 'built files, the marker and emptied folders are gone; other files stay');
    assert.ok(existsSync(join(root, 'outside.txt')), 'never outside --out');
    const file = join(root, 'file');
    writeFileSync(file, '');
    assert.match(String(previousBuild(file)), /is a file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runBuild writes the site, copies linked files from inside the sources only, and records what it wrote', () => {
  const root = tempDir();
  try {
    const docs = join(root, 'docs');
    mkdirSync(join(docs, 'img'), { recursive: true });
    mkdirSync(join(docs, '.hidden'), { recursive: true });
    writeFileSync(join(docs, 'index.smd'), '# Home\n\n![a](img/a.png) ![s](.hidden/secret.png) ![o](../outside.png) [m](notes.md)\n');
    writeFileSync(join(docs, 'notes.md'), '# Notes\n');
    writeFileSync(join(docs, 'img', 'a.png'), 'png');
    writeFileSync(join(docs, '.hidden', 'secret.png'), 'secret');
    writeFileSync(join(root, 'outside.png'), 'outside');
    assert.deepEqual(collectSources(docs, false).map((s) => s.path), ['index.smd']);
    assert.deepEqual(collectSources(docs, true).map((s) => s.path).sort(), ['index.smd', 'notes.md']);

    const errors: string[] = [];
    const io = { err: (text: string) => errors.push(text) };
    const out = join(root, 'site');
    const options = { dir: docs, out, md: false, clean: false, generator: 'smd test', today: '2026-09-29' };
    assert.equal(runBuild(options, io), 0);
    assert.ok(existsSync(join(out, 'img', 'a.png')));
    assert.ok(existsSync(join(out, 'notes.md')), 'a linked .md file is copied as is without --md');
    assert.ok(!existsSync(join(out, '.hidden')) && !existsSync(join(out, 'outside.png')), 'no dot folders, nothing from outside');
    const marker = JSON.parse(readFileSync(join(out, SITE_MARKER), 'utf8'));
    assert.equal(marker.format, 'smd-site');
    assert.ok(marker.files.includes('index.html') && marker.files.includes('img/a.png'));
    assert.match(errors.join('\n'), /Built 1 page\(s\).*copied 2 linked file\(s\); 1 linked file\(s\) not found/);

    // With --md, notes.md becomes a page; the copied notes.md of the last build is stale until --clean.
    errors.length = 0;
    assert.equal(runBuild({ ...options, md: true }, io), 0);
    assert.ok(existsSync(join(out, 'notes.html')));
    assert.match(errors.join('\n'), /1 file\(s\) of the previous build are no longer part of the site/);
    assert.equal(runBuild({ ...options, md: true, clean: true }, io), 0);
    assert.ok(!existsSync(join(out, 'notes.md')));

    assert.equal(runBuild({ ...options, out: join(docs, 'site') }, io), 2);
    assert.equal(runBuild({ ...options, dir: join(root, 'nope') }, io), 2);
    const empty = join(root, 'empty');
    mkdirSync(empty);
    assert.equal(runBuild({ ...options, dir: empty }, io), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Every file under a folder, relative to it (readdirSync's `recursive` needs Node 20). */
function filesUnder(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(root, join(prefix, e.name)) : [join(prefix, e.name)]));
}

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd build examples writes a site whose local links all resolve', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const repo = join(__dirname, '..', '..');
  const dir = tempDir();
  try {
    const out = join(dir, 'site');
    execFileSync(process.execPath, [cli, 'build', 'examples', '--out', out, '--md', '--today', '2026-09-29'], { cwd: repo, stdio: 'pipe' });
    for (const file of ['index.html', 'dashboard.html', 'checkout-redesign.html', '_smd/smd.css', '_smd/site.js', '_smd/search-index.js', SITE_MARKER]) {
      assert.ok(existsSync(join(out, file)), file);
    }
    assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /href="showcase\.html"/, 'the README links to pages, not .smd files');
    const html = filesUnder(out).filter((f) => f.endsWith('.html'));
    assert.ok(html.length >= 9);
    for (const file of html) {
      const content = readFileSync(join(out, file), 'utf8');
      for (const m of content.matchAll(/\s(?:href|src)="([^"#?]+)[^"]*"/g)) {
        if (/^(?:[a-z]+:|\/\/)/i.test(m[1])) continue;
        const target = join(dirname(join(out, file)), decodeURIComponent(m[1]));
        assert.ok(existsSync(target) && statSync(target).isFile(), `${file} links to missing ${m[1]}`);
      }
    }
    const refused = spawnSync(process.execPath, [cli, 'build', 'examples', '--out', 'examples/site'], { cwd: repo, encoding: 'utf8' });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /inside the source folder/);
    assert.equal(spawnSync(process.execPath, [cli, 'build'], { cwd: repo }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
