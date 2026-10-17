import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import {
  agentView, formatSmd, markdownToSmd, parseSmd, renderSmd, smdToConfluence, smdToMarkdown, smdToNotion, smdToPandocHtml, validateSmd,
} from '../src/core';
import { alertCallout, GITHUB_ALERTS } from '../src/core/alerts';
import { markdownItSmd } from '../src/core/markdownIt';
import { alertLines, resetParseCache } from '../src/core/parse';
import { blockquoteToCallout } from '../src/core/refactors';
import { MkdocsBridge, type BridgeRender } from '../src/mkdocsBridge';
import { ObsidianEngine } from '../src/obsidianEngine';

/**
 * Graceful degradation (1.10, spec v2 RFC proposal 7a): unknown containers keep their title. And GitHub alerts
 * (`> [!NOTE]`, the RFC's "Not proposed" list) render as the matching callouts.
 */

const corpus = (name: string) => readFileSync(join(__dirname, 'compat', 'corpus', name), 'utf8');
const html = (src: string, options: Parameters<typeof renderSmd>[1] = {}) => renderSmd(src, { today: '2026-10-15', ...options }).html;
/** Rendered HTML without line numbers, to compare blocks written on different lines. */
const shape = (src: string) => html(src).replaceAll(/ data-(?:task-)?line="\d+"/g, '');
const view = (src: string, options: Parameters<typeof agentView>[1] = {}) => agentView(src, { today: '2026-10-15', ...options }).text.trim();

// ---------------------------------------------------------------------------
// Unknown containers keep their title
// ---------------------------------------------------------------------------

test('unknown containers: the title renders in the box, after the name or from title=, with inline Markdown', () => {
  assert.match(html(':::frobnicate Release *notes*\nBody.\n:::\n'),
    /<div class="smd-box smd-box-frobnicate" data-line="0"><div class="smd-box-title">Release <em>notes<\/em><\/div>\n<p data-line="1">Body\.<\/p>/);
  assert.match(html(':::frobnicate{title="From the attribute"}\nBody.\n:::\n'), /<div class="smd-box-title">From the attribute<\/div>/);
  assert.match(html(':::frobnicate{#x bg=amber} Styled\nBody.\n:::\n'),
    /<div id="x" class="smd-box smd-box-frobnicate" style="background:var\(--smd-amber-soft\)" data-line="0"><div class="smd-box-title">Styled<\/div>/);
  assert.match(html('---\nproduct: Acme\n---\n:::frobnicate About {{product}}\nx\n:::\n'), /<div class="smd-box-title">About Acme<\/div>/);
  // Without a title nothing is added.
  assert.match(html(':::frobnicate\nBody.\n:::\n'), /<div class="smd-box smd-box-frobnicate" data-line="0">\n<p/);
});

test('unknown containers: known containers without titles are unchanged', () => {
  assert.equal(html(':::box Ignored\nBody.\n:::\n'), html(':::box\nBody.\n:::\n'));
  for (const name of ['tabs', 'columns', 'steps', 'timeline']) {
    assert.equal(html(`:::${name} Ignored\n1. x\n:::\n`), html(`:::${name}\n1. x\n:::\n`), name);
  }
  assert.doesNotMatch(html(':::box Ignored\nx\n:::\n'), /smd-box-title/);
});

test('unknown containers: the stylesheet sets the title as a card title, in both themes and in print', () => {
  const css = readFileSync(join(__dirname, '..', 'media', 'smd.css'), 'utf8');
  assert.match(css, /\.smd-box-title \{ font-weight: 650; font-size: 1\.05em; margin-bottom: 6px; \}/);
  assert.match(css, /\.smd-card-title, \.smd-box-title, \.smd-tab-label, \.smd-code-title \{ break-after: avoid;/);
  // No colour of its own: the box's text colour, which each theme sets.
  assert.doesNotMatch(css, /\.smd-box-title[^{]*\{[^}]*color/);
});

test('unknown containers: the agent view shows the title as a `Title:` line, as for a card', () => {
  const doc = ':::frobnicate Release **notes**\nBody.\n:::\n\n:::frobnicate{title="Attr"}\nB.\n:::\n\n:::frobnicate\nC.\n:::\n\n:::box Ignored\nD.\n:::\n';
  assert.equal(view(doc), 'Release **notes**:\nBody.\n\nAttr:\nB.\n\nC.\n\nD.');
  assert.equal(view(':::card Release **notes**\nBody.\n:::\n'), 'Release **notes**:\nBody.');
});

test('unknown containers: smd to-md writes the title as a **Title** paragraph, as known callouts do', () => {
  assert.equal(smdToMarkdown(':::frobnicate Release *notes*\nBody.\n:::\n'), '**Release *notes***\n\nBody.\n');
  assert.equal(smdToMarkdown(':::frobnicate{title="Attr"}\nBody.\n:::\n'), '**Attr**\n\nBody.\n');
  assert.equal(smdToMarkdown(':::frobnicate\nBody.\n:::\n'), 'Body.\n');
  assert.equal(smdToMarkdown(':::box Ignored\nBody.\n:::\n'), 'Body.\n');
  // Inside a callout, in its blockquote.
  assert.equal(smdToMarkdown('::::note\n:::frobnicate Inner\nx\n:::\n::::\n'), '> [!NOTE]\n> **Inner**\n>\n> x\n\n');
});

test('unknown containers: Confluence, Notion and Word (docx, PDF through Pandoc) show the title in bold', () => {
  const doc = ':::frobnicate Release *notes*\nBody.\n:::\n';
  assert.equal(smdToConfluence(doc), '<p><strong>Release notes</strong></p>\n<p>Body.</p>\n');
  assert.deepEqual(smdToNotion(doc).map((b) => b.type), ['paragraph', 'paragraph']);
  assert.match(JSON.stringify(smdToNotion(doc)[0]), /"content":"Release notes"},"annotations":\{"bold":true\}/);
  assert.match(smdToPandocHtml(doc), /<p><strong>Release <em>notes<\/em><\/strong><\/p>\n<p>Body\.<\/p>/);
  // A box keeps the content only.
  assert.equal(smdToConfluence(':::box Ignored\nBody.\n:::\n'), '<p>Body.</p>\n');
});

test('unknown containers: ids in a title are link targets, as in a card title', () => {
  assert.ok(parseSmd(':::frobnicate See [this]{#here}\nx\n:::\n').ids.has('here'));
  assert.ok(!parseSmd(':::box See [this]{#here}\nx\n:::\n').ids.has('here'), 'a box drops its title');
  assert.ok(!validateSmd(':::frobnicate See [this]{#here}\nx\n:::\n\n[Link](#here)\n').some((d) => d.code === 'link/anchor'));
});

test('unknown containers: the validator warning is unchanged', () => {
  const found = validateSmd(':::frobnicate Title\nx\n:::\n');
  assert.deepEqual(found.map((d) => [d.code, d.severity, d.message]), [
    ['container/unknown', 'warning', 'Unknown container ":::frobnicate". It will render as a plain box.'],
  ]);
});

test('unknown containers: the markdown-it plugin and the Obsidian engine render the title too', () => {
  const plugin = new MarkdownIt().use(markdownItSmd).render(':::frobnicate Hello\nx\n:::\n');
  assert.match(plugin, /<div class="smd-box smd-box-frobnicate" data-line="0"><div class="smd-box-title">Hello<\/div>/);
  const obsidian = new ObsidianEngine({ containers: true, directives: true, agentBlocks: 'collapsed' }).render(':::frobnicate Hello\nx\n:::\n');
  assert.match(obsidian, /<div class="smd-box-title">Hello<\/div>/);
});

test('unknown containers: the corpus document is formatted, valid apart from its warnings, and reads with its titles', () => {
  const doc = corpus('unknown-containers.smd');
  assert.equal(formatSmd(doc), doc);
  const found = validateSmd(doc);
  assert.ok(found.length > 0 && found.every((d) => d.code === 'container/unknown' && d.severity === 'warning'));
  const page = html(doc);
  for (const title of ['Release checklist', 'From the attribute', 'Styled and titled', 'Outer title', 'Inner title', 'Inside a callout']) {
    assert.match(page, new RegExp(`<div class="smd-box-title">${title}</div>`), title);
  }
  assert.equal(page.match(/smd-box-title/g)?.length, 7);
  assert.match(view(doc), /^Outer title:\nInner card:\nA known container inside an unknown one\.$/m);
  assert.match(smdToMarkdown(doc), /^\*\*From the attribute\*\*\n\nThe title comes from `title=`\.$/m);
});

// ---------------------------------------------------------------------------
// GitHub alerts render as callouts
// ---------------------------------------------------------------------------

test('alerts: the five kinds map to callouts; IMPORTANT is info, as smd from-md converts it', () => {
  assert.deepEqual(GITHUB_ALERTS, { NOTE: 'note', TIP: 'tip', IMPORTANT: 'info', WARNING: 'warning', CAUTION: 'danger' });
  assert.equal(alertCallout('[!caution]'), 'danger');
  assert.equal(alertCallout('[!Important]  '), 'info');
  for (const s of ['[!NOTE] x', '[! NOTE]', '[!NOTE ]', '[!UNKNOWN]', 'x [!NOTE]', '[!NOTE]x']) assert.equal(alertCallout(s), undefined, s);
});

test('alerts: each kind renders exactly as the matching callout, so it has the same accessible structure', () => {
  for (const [kind, callout] of Object.entries(GITHUB_ALERTS)) {
    assert.equal(shape(`> [!${kind}]\n> Body with **bold**.\n`), shape(`:::${callout}\nBody with **bold**.\n:::\n`), kind);
  }
  const note = html('> [!NOTE]\n> Body.\n');
  assert.equal(note, '<article class="smd-doc"><div class="smd-callout smd-callout-note" data-line="0"><div class="smd-callout-title"><span class="smd-callout-icon" aria-hidden="true">✎</span>'
    + '<span>Note</span></div><div class="smd-callout-body">\n<p data-line="1">Body.</p>\n</div></div>\n</article>');
});

test('alerts: the marker in any case, a blank quote line after it, several blocks, lazy lines', () => {
  assert.equal(shape('> [!warning]\n> x\n'), shape(':::warning\nx\n:::\n'));
  assert.equal(shape('> [!Tip]\n>\n> One.\n>\n> - a\n> - b\n'), shape(':::tip\nOne.\n\n- a\n- b\n:::\n'));
  assert.equal(shape('> [!NOTE]\n> first\nlazy\n'), shape(':::note\nfirst\nlazy\n:::\n'));
  assert.equal(shape('> [!NOTE]   \n> after trailing blanks\n'), shape(':::note\nafter trailing blanks\n:::\n'));
});

test('alerts: blockquotes that are not GitHub alerts stay blockquotes', () => {
  const quotes = [
    '> [!NOTE] Text on the marker line.\n',
    '> [!UNKNOWN]\n> x\n',
    '> [! NOTE]\n> x\n',
    '> First line.\n> [!NOTE]\n> x\n',
    '> [!NOTE]\n',
    '> [!NOTE]\n>\n',
    '- > [!NOTE]\n  > In a list item.\n',
    '> > [!NOTE]\n> > In a quote.\n',
    '> **Note:** a bold label.\n',
    '> [!NOTE]\n> ===\n',
  ];
  for (const q of quotes) {
    const page = html(q);
    assert.match(page, /<blockquote/, q);
    assert.doesNotMatch(page, /smd-callout/, q);
  }
  assert.doesNotMatch(html('```md\n> [!NOTE]\n> x\n```\n'), /smd-callout/);
  assert.doesNotMatch(html('[!NOTE] not quoted\n'), /smd-callout/);
});

test('alerts: inside :::containers (which GitHub does not see) they are alerts too', () => {
  assert.match(html(':::card Release\n> [!CAUTION]\n> Careful.\n:::\n'),
    /<div class="smd-card-body">\n<div class="smd-callout smd-callout-danger" data-line="1">.*<p data-line="2">Careful\.<\/p>/s);
  assert.match(html('::::tabs\n:::tab One\n> [!TIP]\n> x\n:::\n::::\n'), /smd-callout-tip/);
});

test('alerts: in included documents, rendered and in the agent view', () => {
  const files: Record<string, string> = { 'part.smd': '## Part\n\n> [!WARNING]\n> Included alert.\n' };
  const readFile = (p: string) => files[p];
  const doc = ':::include{file="part.smd"}\n:::\n';
  assert.match(html(doc, { readFile }), /<div class="smd-callout smd-callout-warning"[^>]*>.*<p[^>]*>Included alert\.<\/p>/s);
  assert.match(view(doc, { readFile }), /<included file="part.smd">\n## Part {2}\[L1\]\n\n<warning>\nIncluded alert\.\n<\/warning>\n<\/included>/);
});

test('alerts: the agent view shows them as the callout, without the quote markers', () => {
  assert.equal(view('> [!WARNING]\n> Be careful.\n> - [ ] check\n'), '<warning>\nBe careful.\n- [ ] check\n</warning>');
  assert.equal(view('> [!IMPORTANT]\n> Key.\n\nAfter.\n'), '<info>\nKey.\n</info>\n\nAfter.');
  assert.equal(view('> [!TIP]\n>\n> ```sh\n> smd fmt\n> ```\n'), '<tip>\n\n```sh\nsmd fmt\n```\n</tip>');
  // A blockquote that is not an alert stays as written.
  assert.equal(view('> [!NOTE] same line\n'), '> [!NOTE] same line');
  // Done tasks are counted inside it in brief views.
  assert.equal(view('> [!NOTE]\n> - [x] done\n> - [x] done too\n\nNext.\n', { brief: true }), '<note>\n- (2 completed tasks omitted)\n</note>\n\nNext.');
  // Inside a container, between its tags.
  assert.equal(view(':::card Release\n> [!CAUTION]\n> Careful.\n:::\n'), 'Release:\n<danger>\nCareful.\n</danger>');
});

test('alerts: smd to-md writes them back as the same GitHub alerts, and from-md reads them as the same callouts', () => {
  const doc = corpus('github-alerts.smd');
  const md = smdToMarkdown(doc);
  for (const marker of ['> [!NOTE]', '> [!TIP]', '> [!IMPORTANT]', '> [!WARNING]', '> [!CAUTION]', '> [!note]', '> [!Warning]']) {
    assert.ok(md.split('\n').includes(marker), marker);
  }
  // Round trip: the alerts of the Markdown render the same as the callouts from-md makes of them.
  for (const [kind, callout] of Object.entries(GITHUB_ALERTS)) {
    const alert = `> [!${kind}]\n> Body.\n`;
    assert.equal(smdToMarkdown(alert), alert, kind);
    const back = markdownToSmd(smdToMarkdown(alert), 't');
    assert.match(back, new RegExp(`^:::${callout}\nBody\\.\n:::$`, 'm'), kind);
    assert.equal(shape(back.replace(/^---[\s\S]*?---\n\n/, '')), shape(alert), kind);
  }
  // from-md reads the marker in any case, as GitHub and rendering do.
  assert.match(markdownToSmd('> [!caution]\n> Hot.\n', 't'), /^:::danger\nHot\.\n:::$/m);
  assert.equal(blockquoteToCallout('> [!important]\n> x\n', 0)?.type, 'info');
});

test('alerts: Confluence and Notion export them as callouts; Word (docx, PDF through Pandoc) as a callout quote', () => {
  const alert = '> [!WARNING]\n> Be careful.\n';
  const callout = ':::warning\nBe careful.\n:::\n';
  assert.equal(smdToConfluence(alert), smdToConfluence(callout));
  assert.deepEqual(smdToNotion(alert), smdToNotion(callout));
  assert.equal(smdToPandocHtml(alert), smdToPandocHtml(callout));
  // A plain quote stays a quote.
  assert.match(smdToConfluence('> [!WARNING] same line\n'), /^<blockquote>/);
});

test('alerts: the markdown-it plugin renders them in .md previews, and leaves them alone without containers', () => {
  const md = new MarkdownIt().use(markdownItSmd);
  assert.match(md.render('> [!TIP]\n> Use it.\n'), /^<div class="smd-callout smd-callout-tip" data-line="0">.*<p>Use it\.<\/p>/s);
  assert.equal(new MarkdownIt().use(markdownItSmd, { containers: false }).render('> [!TIP]\n> Use it.\n'), '<blockquote>\n<p>[!TIP]\nUse it.</p>\n</blockquote>\n');
  // A host's own blockquote rule still renders the quotes that are not alerts.
  const host = new MarkdownIt();
  host.renderer.rules.blockquote_open = () => '<blockquote class="host">\n';
  host.use(markdownItSmd);
  assert.match(host.render('> plain\n'), /<blockquote class="host">/);
  assert.match(host.render('> [!NOTE]\n> alert\n'), /smd-callout-note/);
});

test('alerts and unknown containers: the MkDocs bridge renders them as renderSmd does', () => {
  const bridge = new MkdocsBridge();
  bridge.handle({ id: 0, method: 'site', params: { docsDir: __dirname, pages: { 'a.md': 'a/' }, today: '2026-10-15' } });
  const text = '> [!CAUTION]\n> Hot.\n\n:::frobnicate Kept title\nx\n:::\n';
  const page = bridge.handle({ id: 1, method: 'render', params: { path: 'a.md', text, header: false } }).result as BridgeRender;
  assert.match(page.html, /<div class="smd-callout smd-callout-danger"/);
  assert.match(page.html, /<div class="smd-box-title">Kept title<\/div>/);
});

test('alerts: their lines are known to the incremental parse, as to a full one', () => {
  const doc = 'Intro.\n\n> [!NOTE]\n> One.\n\n:::card\n> [!TIP]\n> Two.\n:::\n';
  assert.deepEqual(alertLines(doc).map((a) => [a.start, a.marker, a.callout]), [[2, 2, 'note'], [6, 6, 'tip']]);
  const edited = doc.replace('Intro.', 'Intro.\n\nMore.');
  const incremental = alertLines(edited);
  resetParseCache();
  assert.deepEqual(incremental, alertLines(edited));
  assert.deepEqual(incremental.map((a) => a.start), [4, 8]);
});

test('alerts: the corpus document is formatted and valid, and its blockquotes that are not alerts stay quotes', () => {
  const doc = corpus('github-alerts.smd');
  assert.equal(formatSmd(doc), doc);
  assert.deepEqual(validateSmd(doc, { today: '2026-10-15' }), []);
  const page = html(doc);
  assert.equal(page.match(/<div class="smd-callout /g)?.length, 10);
  assert.equal(page.match(/<blockquote/g)?.length, 9);
});
