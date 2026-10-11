import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { smdToPandocHtml } from '../src/core';
import { decodeEntities, parseHtml, serializeHtml, textContent } from '../src/core/htmlTree';
import {
  DOCX_MISSING_PANDOC, DocxError, docxPath, exportDocx, findPandoc, PANDOC_INSTALL_URL, pandocArgs, type Spawn,
} from '../src/docx';

/** The page's body, and its head. */
const body = (html: string) => /<body>\n([\s\S]*)\n<\/body>/.exec(html)?.[1] ?? '';
const head = (html: string) => /<head>\n([\s\S]*)\n<\/head>/.exec(html)?.[1] ?? '';
const pandocHtml = (source: string, options = {}) => body(smdToPandocHtml(source, { today: '2026-09-25', ...options }));

// ---- htmlTree: the small parser the profile reshapes the renderer's output with ----

test('htmlTree: parses and serializes elements, void elements, attributes and text as written', () => {
  const html = '<p class="a" data-x=\'1 "q"\'>Text &amp; <b>bold</b><br>end</p><img src=x.png alt="A &lt; B">';
  const nodes = parseHtml(html);
  assert.equal(serializeHtml(nodes), '<p class="a" data-x="1 &quot;q&quot;">Text &amp; <b>bold</b><br>end</p><img src="x.png" alt="A &lt; B">');
  assert.equal(textContent(nodes), 'Text & boldend');
});

test('htmlTree: copes with raw HTML: stray and missing closing tags, comments, doctype, script text', () => {
  assert.equal(serializeHtml(parseHtml('<div><p>a</span>b</div>c</p>')), '<div><p>ab</p></div>c');
  assert.equal(serializeHtml(parseHtml('<!DOCTYPE html><!-- note --><em>x')), '<em>x</em>');
  const script = parseHtml('<script>if (a < b) { "</p>" }</script><p>after</p>');
  assert.equal(script.length, 2);
  assert.equal(textContent(script.slice(0, 1)), 'if (a < b) { "</p>" }');
  assert.equal(decodeEntities('&#x27;&#39;&quot;&nbsp;&unknown;&#0;'), `''"\u00a0&unknown;&#0;`);
});

// ---- smdToPandocHtml: one construct at a time ----

test('pandoc profile: front matter becomes title, subtitle, authors, keywords and a table of contents', () => {
  const html = smdToPandocHtml('---\ntitle: Plan & scope\nsummary: The **plan**.\nstatus: review\nversion: 2\nowners: ["@a", "@b"]\ntags: [x, y]\ntoc: true\n---\n\n## One\n');
  assert.match(html, /^<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n/);
  assert.equal(head(html).split('\n').slice(1).join('\n'), [
    '<title>Plan &amp; scope</title>',
    '<meta name="subtitle" content="The plan.">',
    '<meta name="author" content="@a">',
    '<meta name="author" content="@b">',
    '<meta name="keywords" content="x, y">',
    '<meta name="toc" content="true">',
    '<meta name="toc-title" content="Contents">',
  ].join('\n'));
  // Status and version are the first paragraph; the rendered contents and header are not in the body.
  assert.equal(body(html), '<p><strong>Review</strong> · v2</p><h2 id="one">One</h2>');
  assert.equal(head(smdToPandocHtml('# Just text\n')), '<meta charset="utf-8">\n');
});

test('pandoc profile: callouts are block quotes under a bold title; collapsible ones are open', () => {
  assert.equal(pandocHtml(':::note\nBody **text**.\n:::\n'), '<blockquote><p><strong>Note</strong></p>\n<p>Body <strong>text</strong>.</p>\n</blockquote>');
  assert.match(pandocHtml(':::tip Pro tip\nX\n:::\n'), /^<blockquote><p><strong>Tip: Pro tip<\/strong><\/p>/);
  assert.match(pandocHtml(':::warning{collapsible} Hidden\nInside\n:::\n'), /^<blockquote><p><strong>Warning: Hidden<\/strong><\/p>\n<p>Inside<\/p>/);
});

test('pandoc profile: details, cards and boxes are expanded; tabs become headings one level down', () => {
  assert.equal(pandocHtml(':::details More\nHidden text.\n:::\n'), '<p><strong>More</strong></p>\n<p>Hidden text.</p>');
  assert.equal(pandocHtml(':::card Title\nBody\n:::\n'), '<p><strong>Title</strong></p>\n<p>Body</p>');
  const tabs = pandocHtml('## Install\n\n::::tabs\n:::tab npm\nUse npm.\n:::\n:::tab pnpm\nUse pnpm.\n:::\n::::\n');
  assert.match(tabs, /<h2 id="install">Install<\/h2>\s*<h3>npm<\/h3>\n<p>Use npm\.<\/p>\s*<h3>pnpm<\/h3>\n<p>Use pnpm\.<\/p>/);
  assert.match(pandocHtml('### Deep\n\n::::tabs\n:::tab A\nx\n:::\n::::\n'), /<h4>A<\/h4>/);
});

test('pandoc profile: agent blocks are left out, as in print, unless asked for', () => {
  const source = 'Before.\n\n:::agent Rules\nOnly for agents.\n:::\n\n:::human Why\nFor people.\n:::\n';
  assert.equal(pandocHtml(source), '<p>Before.</p>\n\n<p><strong>For humans: Why</strong></p>\n<p>For people.</p>');
  assert.match(pandocHtml(source, { agentBlocks: 'expanded' }), /<p><strong>For agents: Rules<\/strong><\/p>\n<p>Only for agents\.<\/p>/);
});

test('pandoc profile: figures keep figure and figcaption; a table figure captions its table; references link', () => {
  const html = pandocHtml(':::figure{#fig-a} The flow\n![Flow](flow.png)\n:::\n\n:::figure{#tbl-b kind=table} Prices\n| A | B |\n|---|:-:|\n| 1 | 2 |\n:::\n\nSee :ref[fig-a] and :ref[tbl-b].\n');
  assert.match(html, /^<figure id="fig-a">\n<p><img src="flow\.png" alt="Flow"><\/p>\n<figcaption>Figure 1: The flow<\/figcaption><\/figure>/);
  assert.match(html, /<table id="tbl-b"><caption>Table 1: Prices<\/caption>\n<thead>\n<tr>\n<th>A<\/th>\n<th align="center">B<\/th>/);
  assert.match(html, /<p>See <a href="#fig-a">Figure 1<\/a> and <a href="#tbl-b">Table 1<\/a>\.<\/p>/);
});

test('pandoc profile: tasks start with ☐ or ☑; a done task drops its due note', () => {
  assert.equal(pandocHtml('- [ ] Open :due[2026-09-20]\n- [x] Done :due[2026-09-20]\n- [ ] Soon :due[2026-09-28]\n'), [
    '<ul>', '<li>☐ Open 2026-09-20 · overdue</li>', '<li>☑ Done 2026-09-20</li>', '<li>☐ Soon 2026-09-28 (due soon)</li>', '</ul>',
  ].join('\n'));
});

test('pandoc profile: badges, priorities and statuses are bold text; progress, metrics and keys are text', () => {
  assert.equal(
    pandocHtml(':badge[Shipped]{color=green} :priority[P1] :status[On track]{color=green} :status{color=red} :progress{value=65} :kbd[Ctrl+K] :mention[@ops]\n'),
    '<p><strong>[Shipped]</strong> <strong>[P1]</strong> <strong>On track</strong> <strong>red</strong> 65% <code>Ctrl</code>+<code>K</code> @ops</p>',
  );
  assert.equal(pandocHtml(':metric[42%]{label="Activation" delta="+3.1%" trend=up}\n'), '<p><strong>42%</strong> Activation  +3.1% (up, good)</p>');
});

test('pandoc profile: styled text keeps what Word can show and drops colours', () => {
  assert.equal(
    pandocHtml('[a]{color=red} [b]{weight=bold} [c]{style="italic underline strike"} [d]{font=mono} [e]{#here bg=amber} ==f==\n'),
    '<p>a <strong>b</strong> <u><del><em>c</em></del></u> <code>d</code> <span id="here">e</span> <mark>f</mark></p>',
  );
});

test('pandoc profile: code is plain text with its language and title; Mermaid keeps its source', () => {
  assert.equal(
    pandocHtml('```ts title="a.ts" {1}\nconst a = 1 < 2;\n```\n'),
    '<p><strong>a.ts</strong></p><pre><code class="language-ts">const a = 1 &lt; 2;\n</code></pre>',
  );
  assert.equal(pandocHtml('```mermaid\nflowchart LR\n  A --> B\n```\n'), '<pre><code class="language-mermaid">flowchart LR\n  A --&gt; B\n</code></pre>');
  assert.equal(pandocHtml('```\nplain\n```\n'), '<pre><code>plain\n</code></pre>');
});

test('pandoc profile: math is MathML with its TeX annotation in Pandoc\'s math spans', () => {
  const html = pandocHtml('Inline $a < b$ and\n\n$$\n\\frac{1}{2}\n$$\n');
  assert.match(html, /^<p>Inline <span class="math inline"><math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"><semantics>.*<annotation encoding="application\/x-tex">a &lt; b<\/annotation><\/semantics><\/math><\/span> and<\/p>/);
  assert.match(html, /<p><span class="math display"><math [^>]*display="block"><semantics>.*<annotation encoding="application\/x-tex">\\frac\{1\}\{2\}<\/annotation>/);
  assert.ok(!html.includes('katex'));
});

test('pandoc profile: footnotes take Pandoc\'s footnote markup', () => {
  assert.equal(pandocHtml('Text[^n].\n\n[^n]: The **note**.\n'), [
    '<p>Text<a href="#fn-1" id="fnref-1" class="footnote-ref" role="doc-noteref"><sup>1</sup></a>.</p>',
    '<section class="footnotes" role="doc-endnotes"><ol><li id="fn-1" role="doc-endnote">',
    '<p>The <strong>note</strong>. <a href="#fnref-1" class="footnote-back" role="doc-backlink">↩︎</a></p>',
    '</li></ol></section>',
  ].join('\n'));
});

test('pandoc profile: decisions and risks are quotes with their facts; API blocks a heading line', () => {
  assert.equal(
    pandocHtml(':::decision{status=accepted date=2026-09-12 owner=@maya} EU first\nWhy.\n:::\n'),
    '<blockquote><p>Decision · <strong>Accepted</strong> · 2026-09-12 · @maya</p><p><strong>EU first</strong></p>\n<p>Why.</p>\n</blockquote>',
  );
  assert.match(pandocHtml(':::risk{impact=high likelihood=low owner=@ops} Limits\nPlan.\n:::\n'),
    /^<blockquote><p><strong>Limits<\/strong><\/p><p>Impact <b>high<\/b> · Likelihood <b>low<\/b> · Owner @ops<\/p>/);
  assert.match(pandocHtml(':::api{method=post path="/v1/orders" auth="token"} Create\nBody.\n:::\n'),
    /^<p><strong>POST<\/strong> <code>\/v1\/orders<\/code> Create 🔒 token<\/p>\n<p>Body\.<\/p>/);
});

test('pandoc profile: quotes end with their attribution; glossaries and changelogs stay lists and headings', () => {
  assert.equal(pandocHtml(':::quote{author="Ada" source="Notes"}\nWords.\n:::\n'), '<blockquote>\n<p>Words.</p>\n<p>— Ada, <cite>Notes</cite></p></blockquote>');
  assert.match(pandocHtml('The API.\n\n:::glossary Terms\n- **API**: Interface\n:::\n'),
    /^<p>The API\.<\/p>\n<p><strong>Terms<\/strong><\/p>\n<dl>\n<dt id="term-api">API<\/dt>\n<dd>Interface<\/dd>\n<\/dl>/);
  assert.match(pandocHtml(':::changelog\n## 1.0.0 — 2026-01-02\n- First\n:::\n'), /^<h2 id="[^"]+">1\.0\.0 — 2026-01-02<\/h2>\n<ul>\n<li>First<\/li>/);
});

test('pandoc profile: no scripts, classes, styles or data attributes reach Pandoc', () => {
  const source = [
    '# Title {.page-break}', '', 'Raw <b onclick="x()" style="color:red">bold</b> <script>alert(1)</script> <iframe src="x"></iframe>',
    '', '| A |', '|:-:|', '| 1 |', '', ':::box{bg=indigo}', 'Boxed', ':::', '', ':::card{.no-print} Internal', 'Hidden', ':::', '',
  ].join('\n');
  const html = pandocHtml(source);
  assert.ok(!/<script|<iframe|onclick|style=|data-|aria-|smd-/.test(html), html);
  assert.ok(!/ class=/.test(html.replaceAll(/ class="(?:math (?:inline|display)|language-\w+|footnote-\w+|footnotes)"/g, '')));
  assert.match(html, /<td align="center">1<\/td>/);
  assert.match(html, /<p>Boxed<\/p>/);
  assert.ok(!html.includes('Internal'));
});

test('pandoc profile: labels follow the document language', () => {
  const html = smdToPandocHtml('---\nlang: de\ntoc: true\n---\n\n:::note\nX\n:::\n\n:::figure Bild\n![a](a.png)\n:::\n');
  assert.match(html, /<html lang="de">/);
  assert.match(html, /<meta name="toc-title" content="Inhalt">/);
  assert.match(html, /<strong>Hinweis<\/strong>/);
  assert.match(html, /<figcaption>Abbildung 1: Bild<\/figcaption>/);
  assert.match(smdToPandocHtml('Text\n', { lang: 'de' }), /<html lang="de">/);
});

// ---- Finding and running Pandoc ----

test('findPandoc: --pandoc, then SMD_PANDOC, then pandoc on the PATH', () => {
  const files = new Set(['/opt/pandoc/bin/pandoc', '/custom/pandoc', 'C:\\Tools\\pandoc.exe', '/env/pandoc']);
  const isFile = (f: string) => files.has(f.replaceAll('\\', '/')) || files.has(f);
  const posix = { platform: 'linux' as const, isFile };
  assert.equal(findPandoc({ ...posix, explicit: '/custom/pandoc', env: { SMD_PANDOC: '/env/pandoc' } }), '/custom/pandoc');
  assert.equal(findPandoc({ ...posix, env: { SMD_PANDOC: '/env/pandoc', PATH: '/opt/pandoc/bin' } }), '/env/pandoc');
  assert.equal(findPandoc({ ...posix, env: { PATH: '/usr/bin:/opt/pandoc/bin' } }).replaceAll('\\', '/'), '/opt/pandoc/bin/pandoc');
  // Windows: pandoc.exe in a ;-separated Path.
  assert.equal(findPandoc({ platform: 'win32', isFile, env: { Path: 'C:\\Windows;C:\\Tools' } }).replaceAll('\\', '/'), 'C:/Tools/pandoc.exe');
});

test('findPandoc: a missing Pandoc says how to install it or convert by hand', () => {
  const isFile = () => false;
  assert.throws(() => findPandoc({ platform: 'linux', isFile, env: { PATH: '/usr/bin' } }), (e: Error) => e instanceof DocxError
    && e.message === DOCX_MISSING_PANDOC
    && e.message.includes(PANDOC_INSTALL_URL)
    && /--pandoc <path> or set SMD_PANDOC/.test(e.message)
    && /smd docx <file\.smd> --html-only -o page\.html, then run pandoc page\.html -f html -t docx -o page\.docx/.test(e.message));
  assert.throws(() => findPandoc({ isFile, explicit: 'nowhere/pandoc' }), /Pandoc was not found at nowhere\/pandoc \(from --pandoc\)/);
  assert.throws(() => findPandoc({ isFile, env: { SMD_PANDOC: 'gone' } }), /Pandoc was not found at gone \(from SMD_PANDOC\)/);
});

test('pandocArgs and docxPath: HTML on stdin to a .docx next to the document', () => {
  assert.deepEqual(pandocArgs({ out: 'a.docx', resourcePath: 'docs' }), ['--from', 'html', '--to', 'docx', '--output', 'a.docx', '--resource-path', 'docs']);
  assert.deepEqual(pandocArgs({ out: 'a.docx', resourcePath: '.', referenceDoc: 'ref.docx' }).slice(-2), ['--reference-doc', 'ref.docx']);
  assert.equal(docxPath(join('docs', 'plan.smd')), join('docs', 'plan.docx'));
});

/** A stand-in for child_process.spawn: records the call and exits with `code` after writing `stderr`. */
function fakeSpawn(result: { code?: number; stderr?: string; fail?: Error }, calls: unknown[][]): Spawn {
  return ((command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: (s: string) => void }; stderr: EventEmitter & { setEncoding: () => void } };
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    child.stdin = Object.assign(new EventEmitter(), {
      end: (input: string) => {
        calls.push([command, args, input]);
        setImmediate(() => {
          if (result.fail) { child.emit('error', result.fail); return; }
          if (result.stderr) child.stderr.emit('data', result.stderr);
          child.emit('close', result.code ?? 0);
        });
      },
    });
    return child;
  }) as unknown as typeof spawn;
}

test('exportDocx: runs Pandoc with the HTML on stdin and returns its warnings; failures reject', async () => {
  const calls: unknown[][] = [];
  const options = { out: 'out.docx', resourcePath: 'docs' };
  assert.equal(await exportDocx('pandoc', '<p>x</p>', options, fakeSpawn({ stderr: '[WARNING] Could not fetch resource a.png\n' }, calls)), '[WARNING] Could not fetch resource a.png');
  assert.deepEqual(calls, [['pandoc', pandocArgs(options), '<p>x</p>']]);
  await assert.rejects(exportDocx('pandoc', '', options, fakeSpawn({ code: 64, stderr: 'Unknown option\n' }, calls)), /Pandoc exited with code 64:\nUnknown option/);
  await assert.rejects(exportDocx('pandoc', '', options, fakeSpawn({ code: 1 }, calls)), /Pandoc exited with code 1\./);
  await assert.rejects(exportDocx('pandoc', '', options, fakeSpawn({ fail: new Error('spawn EACCES') }, calls)), /Could not run Pandoc \(pandoc\): spawn EACCES/);
  await assert.rejects(exportDocx('pandoc', '', { ...options, referenceDoc: 'missing-reference.docx' }, fakeSpawn({}, calls)),
    (e: Error) => e instanceof DocxError && /Reference document not found: missing-reference\.docx/.test(e.message));
});

// ---- CLI (requires `npm run build`) ----

const cli = join(__dirname, '..', 'dist', 'cli.js');
const examples = join(__dirname, '..', '..', 'examples');
const showcase = join(examples, 'showcase.smd');

/** The environment without PATH and SMD_PANDOC (any case), with PATH set to `path`. */
function envWithPath(path: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['path', 'smd_pandoc'].includes(k.toLowerCase())));
  return { ...env, PATH: path };
}

const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });

test('CLI: smd docx without Pandoc exits 2 with the install link and writes nothing; --html-only needs no Pandoc',
  { skip: !existsSync(cli) && 'run npm run build first' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'smd-docx-'));
    try {
      const out = join(dir, 'never.docx');
      const missing = run(['docx', showcase, '-o', out], envWithPath(dir));
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /smd docx needs Pandoc \(3\.0 or later\), which smd does not bundle/);
      assert.ok(missing.stderr.includes(PANDOC_INSTALL_URL));
      assert.equal(existsSync(out), false);

      const wrongPath = run(['docx', showcase, '--pandoc', join(dir, 'nope.exe'), '-o', out]);
      assert.equal(wrongPath.status, 2);
      assert.match(wrongPath.stderr, /Pandoc was not found at .*nope\.exe \(from --pandoc\)/);
      const wrongEnv = run(['docx', showcase, '-o', out], { ...envWithPath(dir), SMD_PANDOC: join(dir, 'gone') });
      assert.equal(wrongEnv.status, 2);
      assert.match(wrongEnv.stderr, /\(from SMD_PANDOC\)/);
      assert.equal(existsSync(out), false);

      const html = run(['docx', showcase, '--html-only'], envWithPath(dir));
      assert.equal(html.status, 0);
      assert.match(html.stdout, /^<!DOCTYPE html>\n<html lang="en">[\s\S]*<title>Styled Markdown Showcase<\/title>[\s\S]*<figcaption>Figure 1: Writing, checking and exporting a document<\/figcaption>/);
      const page = join(dir, 'page.html');
      assert.equal(run(['docx', showcase, '--html-only', '-o', page]).status, 0);
      assert.equal(readFileSync(page, 'utf8'), html.stdout);

      assert.equal(run(['docx', showcase, '--html-only', '--lang', '!!']).status, 2);
      const noFile = run(['docx', join(dir, 'missing.smd')]);
      assert.equal(noFile.status, 2);
      assert.match(noFile.stderr, /Not found: /);
      assert.match(run(['--help']).stdout, /smd docx <file\.smd> \[-o out\.docx\] \[--pandoc <path>\] \[--reference-doc <file\.docx>\] \[--html-only\] \[--lang <tag>\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

// ---- Integration: only where Pandoc is installed (SMD_PANDOC or the PATH) ----

const pandoc = (() => { try { return findPandoc(); } catch { return undefined; } })();

/** The files of a zip archive (a .docx), read from its central directory. */
function unzip(file: string): Map<string, string> {
  const zip = readFileSync(file);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'not a zip file');
  const files = new Map<string, string>();
  let at = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0; n--) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

/** Each paragraph of a WordprocessingML part: its style and text. */
function paragraphs(xml: string): Array<{ style: string; text: string }> {
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(([p]) => ({
    style: /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '',
    text: decodeEntities([...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')),
  }));
}

test('integration: Pandoc turns the showcase into a .docx with headings, tables, a footnote and figure captions',
  { skip: (!pandoc && 'Pandoc is not installed (put it on the PATH or set SMD_PANDOC)') || (!existsSync(cli) && 'run npm run build first') },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smd-docx-'));
    try {
      // The CLI, on the example as it is.
      const out = join(dir, 'showcase.docx');
      const result = run(['docx', showcase, '-o', out]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Wrote .*showcase\.docx \(converted with /);
      const files = unzip(out);
      const document = files.get('word/document.xml') ?? '';
      const paras = paragraphs(document);
      assert.ok(paras.some((p) => p.style === 'Title' && p.text === 'Styled Markdown Showcase'));
      for (const heading of ['Callouts', 'Diagrams', 'Math', 'For developers']) {
        assert.ok(paras.some((p) => p.style === 'Heading2' && p.text === heading), `heading ${heading}`);
      }
      assert.ok(paras.some((p) => p.style === 'Heading3' && p.text === 'npm'), 'tab label as a heading');
      assert.ok((document.match(/<w:tbl>/g) ?? []).length >= 2, 'tables');
      assert.ok(paras.some((p) => /Caption/.test(p.style) && p.text === 'Figure 1: Writing, checking and exporting a document'), 'figure caption');
      assert.ok(paras.some((p) => p.text === '☐ Try it now'), 'task');
      assert.match(document, /<m:oMath>/, 'math as Word equations');
      assert.ok(!document.includes('Implementation constraints'), 'agent blocks left out');

      // The library and exportDocx, on the showcase with a footnote: a real Word footnote.
      const source = `${readFileSync(showcase, 'utf8')}\nA claim that needs a source.[^src]\n\n[^src]: The source, with **bold** text.\n`;
      const html = smdToPandocHtml(source, { readFile: (rel) => { try { return readFileSync(join(examples, rel), 'utf8'); } catch { return undefined; } } });
      const noted = join(dir, 'noted.docx');
      await exportDocx(pandoc!, html, { out: noted, resourcePath: dirname(showcase) });
      const notedFiles = unzip(noted);
      assert.match(notedFiles.get('word/document.xml') ?? '', /<w:footnoteReference w:id="\d+" \/>/);
      assert.ok(paragraphs(notedFiles.get('word/footnotes.xml') ?? '').some((p) => p.text.includes('The source, with bold text.')), 'footnote text');
      assert.ok(paragraphs(notedFiles.get('word/document.xml') ?? '').some((p) => p.text.includes('export async function retry')), 'code block');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
