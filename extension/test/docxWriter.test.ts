import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { decodeEntities } from '../src/core/htmlTree';
import { docxParts, hexColour, imageInfo, linkTarget, smdToDocx, stylesXml, type DocxWriterOptions } from '../src/core/docxWriter';
import { crc32, unzipEntry, zip } from '../src/core/zip';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const showcase = join(dirname(__dirname), '..', 'examples', 'showcase.smd');

/** The parts of a .docx written from `source`, as text (images as Latin-1). */
function parts(source: string, options: DocxWriterOptions = {}): Map<string, string> {
  const { entries } = docxParts(source, options);
  return new Map(entries.map((e) => [e.name, Buffer.from(e.data).toString(e.name.startsWith('word/media/') ? 'latin1' : 'utf8')]));
}

const documentXml = (source: string, options: DocxWriterOptions = {}) => parts(source, options).get('word/document.xml') ?? '';

/** Each paragraph of a WordprocessingML part: its style and text. */
function paragraphs(xml: string): Array<{ style: string; text: string; xml: string }> {
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)].map(([p]) => ({
    style: /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '',
    text: decodeEntities([...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')),
    xml: p,
  }));
}

/** Well-formed XML: one root, balanced and properly nested elements, quoted attributes, `&` only in entities. */
function assertWellFormed(xml: string, name: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  let roots = 0;
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g)) {
    const [, closing, tag, , selfClosing, text, stray] = m;
    assert.ok(!stray, `${name}: stray < at ${m.index}: ${body.slice(m.index!, m.index! + 40)}`);
    if (text !== undefined) {
      assert.ok(stack.length, `${name}: text outside the root`);
      assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text), `${name}: bare & in ${text.slice(0, 40)}`);
      continue;
    }
    if (closing) {
      assert.equal(stack.pop(), tag, `${name}: </${tag}> closes the wrong element`);
    } else {
      if (!stack.length) roots++;
      if (!selfClosing) stack.push(tag);
    }
  }
  assert.equal(stack.length, 0, `${name}: unclosed ${stack.join(' > ')}`);
  assert.equal(roots, 1, `${name}: one root element`);
}

/** A 2×1 PNG (8-bit RGB). */
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000010802000000' + '7b40e81d0000000c49444154789c63f8cfc0f01f0005fe02fe0d3d2c9d0000000049454e44ae426082', 'hex');
/** A 3×2 GIF. */
const GIF = Buffer.from('474946383961030002000000002c00000000030002000002024c01003b', 'hex');
/** The start of a 640×480 baseline JPEG: SOI, an APP0 segment, then SOF0. */
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108' + '01e0' + '0280' + '03012200021101031101', 'hex');

// ---------------------------------------------------------------------------
// zip.ts
// ---------------------------------------------------------------------------

test('zip: CRC-32 is the IEEE one; entries round-trip stored and deflated, with UTF-8 names', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
  const text = new TextEncoder().encode('<w:document>'.repeat(200));
  const entries = [{ name: 'word/document.xml', data: text }, { name: 'tiny', data: new Uint8Array([1]) }, { name: 'docs/näme.txt', data: new TextEncoder().encode('ü') }];
  for (const deflate of [undefined, (d: Uint8Array) => deflateRawSync(d)]) {
    const archive = zip(entries, deflate);
    for (const e of entries) assert.deepEqual(Buffer.from(unzipEntry(archive, e.name, inflateRawSync)!), Buffer.from(e.data), e.name);
    assert.equal(unzipEntry(archive, 'missing', inflateRawSync), undefined);
  }
  // Deflated only when smaller: the document shrinks, the one-byte entry is stored.
  assert.ok(zip(entries, deflateRawSync).length < zip(entries).length);
  // The same entries give the same bytes (a fixed date): exports don't change from run to run.
  assert.deepEqual(zip(entries, deflateRawSync), zip(entries, deflateRawSync));
});

test('zip: unzipEntry rejects what is not a ZIP archive', () => {
  assert.throws(() => unzipEntry(new TextEncoder().encode('not a zip at all, just text'), 'x', inflateRawSync), /Not a ZIP archive/);
  assert.throws(() => unzipEntry(new Uint8Array(3), 'x', inflateRawSync), /Not a ZIP archive/);
});

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

test('docx: a package Word opens: content types, relationships, styles, numbering, settings, all well-formed', () => {
  const files = parts(readFileSync(showcase, 'utf8'), { readFile: (p) => { try { return readFileSync(join(dirname(showcase), p), 'utf8'); } catch { return undefined; } } });
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'word/document.xml',
    'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml', 'word/settings.xml']) {
    assert.ok(files.has(name), name);
    assertWellFormed(files.get(name)!, name);
  }
  assert.equal([...files.keys()][0], '[Content_Types].xml', 'content types first');
  const types = files.get('[Content_Types].xml')!;
  assert.match(types, /PartName="\/word\/document\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document\.main\+xml"/);
  assert.match(files.get('_rels/.rels')!, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/officeDocument" Target="word\/document\.xml"/);
  const rels = files.get('word/_rels/document.xml.rels')!;
  for (const target of ['styles.xml', 'numbering.xml', 'settings.xml']) assert.ok(rels.includes(`Target="${target}"`), target);
  // Every r:id the document uses has a relationship.
  for (const [, id] of files.get('word/document.xml')!.matchAll(/r:(?:id|embed)="([^"]+)"/g)) assert.ok(rels.includes(`Id="${id}"`), id);
  assert.match(files.get('docProps/core.xml')!, /<dc:title>Styled Markdown Showcase<\/dc:title><dc:language>en<\/dc:language>/);
  // Word 2013+ mode, not compatibility mode.
  assert.match(files.get('word/settings.xml')!, /w:name="compatibilityMode" w:uri="http:\/\/schemas\.microsoft\.com\/office\/word" w:val="15"/);
});

test('docx: the same document gives the same bytes; smdToDocx zips the parts and passes warnings on', () => {
  const source = readFileSync(showcase, 'utf8');
  const a = smdToDocx(source, { deflate: deflateRawSync });
  const b = smdToDocx(source, { deflate: deflateRawSync });
  assert.deepEqual(a.data, b.data);
  assert.equal(Buffer.from(a.data).readUInt32LE(0), 0x04034b50);
  const document = unzipEntry(a.data, 'word/document.xml', inflateRawSync);
  assert.equal(Buffer.from(document!).toString('utf8'), parts(source).get('word/document.xml'));
  assert.deepEqual(smdToDocx('![x](gone.png)\n').warnings, ['Image gone.png was not found: only its alt text is in the .docx.']);
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

test('docx: the front matter title is the Title; headings are Heading 1–6 with Word\'s own names', () => {
  const xml = documentXml('---\ntitle: Plan & <Scope>\nstatus: draft\n---\n# One\n## Two\n###### Six\n');
  const paras = paragraphs(xml);
  assert.deepEqual(paras[0], { style: 'Title', text: 'Plan & <Scope>', xml: paras[0].xml });
  assert.ok(paras.some((p) => p.style === 'BodyText' && p.text.includes('draft')), 'the status line');
  assert.deepEqual(paras.filter((p) => p.style.startsWith('Heading')).map((p) => [p.style, p.text]), [['Heading1', 'One'], ['Heading2', 'Two'], ['Heading6', 'Six']]);
  const styles = stylesXml('en');
  for (let n = 1; n <= 6; n++) assert.ok(styles.includes(`w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>`), `heading ${n}`);
  for (const name of ['Body Text', 'Compact', 'Block Text', 'Source Code', 'Verbatim Char', 'footnote text', 'footnote reference', 'Hyperlink', 'Title']) {
    assert.ok(styles.includes(`<w:name w:val="${name}"/>`), name);
  }
});

test('docx: lists are numbered by Word; each ordered list starts at 1; nesting is the level; tasks have boxes', () => {
  const files = parts('1. one\n2. two\n   - inner\n\ntext\n\n1. again\n\n- [x] done\n- [ ] open\n');
  const paras = paragraphs(files.get('word/document.xml')!);
  const num = (text: string) => {
    const p = paras.find((x) => x.text === text)!.xml;
    return [/<w:ilvl w:val="(\d)"/.exec(p)?.[1], /<w:numId w:val="(\d+)"/.exec(p)?.[1]];
  };
  assert.deepEqual(num('one'), ['0', '2']);
  assert.deepEqual(num('two'), ['0', '2']);
  assert.deepEqual(num('inner'), ['1', '1']);
  assert.deepEqual(num('again'), ['0', '3']);
  assert.deepEqual(paras.filter((p) => /^[☒☐]/.test(p.text)).map((p) => p.text), ['☒done', '☐open']);
  const numbering = files.get('word/numbering.xml')!;
  assertWellFormed(numbering, 'numbering');
  assert.match(numbering, /<w:num w:numId="1"><w:abstractNumId w:val="0"\/><\/w:num>/);
  assert.match(numbering, /<w:num w:numId="3"><w:abstractNumId w:val="1"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"\/>/);
});

test('docx: tables have a grid, borders and a header row that repeats on each page', () => {
  const xml = documentXml('| A | B |\n|---|---|\n| 1 | **2** |\n| 3 |\n\n| C |\n|---|\n| 4 |\n');
  const tables = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((m) => m[0]);
  assert.equal(tables.length, 2);
  assert.equal((tables[0].match(/<w:gridCol /g) ?? []).length, 2);
  assert.equal((tables[0].match(/<w:tc>/g) ?? []).length, 6, 'short rows are filled up');
  assert.match(tables[0], /<w:tr><w:trPr><w:tblHeader\/><\/w:trPr>.*?<w:b\/>.*?A/);
  assert.ok(!/<\/w:tbl><w:tbl>/.test(xml), 'two tables in a row are kept apart, or Word joins them');
  assert.match(xml, /<\/w:tbl><w:p>.*<w:sectPr>/, 'a paragraph after the last table');
});

test('docx: code is Source Code, one paragraph a line, tabs kept; Mermaid and titles get a label', () => {
  const xml = documentXml('```ts title="a.ts"\nconst a = 1;\n\n\tb();\n```\n\n```mermaid\ngraph LR\n```\n');
  const code = paragraphs(xml).filter((p) => p.style === 'SourceCode');
  assert.deepEqual(code.map((p) => p.text), ['const a = 1;', '', 'b();', 'graph LR']);
  assert.match(code[2].xml, /<w:tab\/><w:t xml:space="preserve">b\(\);/);
  const labels = paragraphs(xml).filter((p) => p.text === 'a.ts' || p.text === 'Mermaid diagram');
  assert.equal(labels.length, 2);
});

test('docx: callouts and boxes are bars with a bold title; two boxes in a row are kept apart', () => {
  const xml = documentXml(':::warning Careful\nHot.\n:::\n\n:::warning Again\nStill hot.\n:::\n\n> quoted\n');
  const paras = paragraphs(xml);
  const title = paras.find((p) => p.text === 'Careful')!.xml;
  assert.match(title, /<w:left w:val="single" w:sz="24" w:space="8" w:color="FF991F"\/>/);
  assert.match(title, /<w:shd w:val="clear" w:color="auto" w:fill="FFFAE6"\/>/);
  assert.match(title, /<w:b\/>/);
  assert.match(paras.find((p) => p.text === 'Hot.')!.xml, /w:color="FF991F"/);
  // A spacer between the boxes, or Word draws one bar.
  assert.match(xml, /Hot\.<\/w:t><\/w:r><\/w:p><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"\/><\/w:pPr><\/w:p>/);
  assert.equal(paras.find((p) => p.text === 'quoted')!.style, 'BlockText');
});

test('docx: agent blocks are left out, as in print, unless asked for', () => {
  const source = 'Shown.\n\n:::agent\nAgent only.\n:::\n';
  assert.ok(!documentXml(source).includes('Agent only.'));
  assert.ok(documentXml(source, { agentBlocks: 'expanded' }).includes('Agent only.'));
  // `.no-print` blocks and headings too; the other exports keep them.
  const noPrint = 'Shown.\n\n:::card{.no-print} Internal\nSecret.\n:::\n\n## Draft notes {.no-print}\n';
  const xml = documentXml(noPrint);
  assert.ok(xml.includes('Shown.') && !xml.includes('Secret.') && !xml.includes('Internal') && !xml.includes('Draft notes'));
});

test('docx: footnotes are Word footnotes with their own part', () => {
  const files = parts('Claim.[^1] Again.[^1]\n\n[^1]: The **source**.\n');
  const document = files.get('word/document.xml')!;
  assert.equal((document.match(/<w:footnoteReference w:id="1"\/>/g) ?? []).length, 2);
  const footnotes = files.get('word/footnotes.xml')!;
  assertWellFormed(footnotes, 'footnotes');
  assert.match(footnotes, /<w:footnote w:type="separator" w:id="-1">.*<w:footnote w:type="continuationSeparator" w:id="0">/);
  assert.match(footnotes, /<w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"\/><\/w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><w:vertAlign w:val="superscript"\/><\/w:rPr><w:footnoteRef\/>/);
  assert.match(footnotes, /<w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">source<\/w:t>/);
  assert.match(files.get('[Content_Types].xml')!, /PartName="\/word\/footnotes\.xml"/);
  assert.match(files.get('word/_rels/document.xml.rels')!, /Id="rId4" Type="[^"]+\/footnotes" Target="footnotes\.xml"/);
  assert.match(files.get('word/settings.xml')!, /<w:footnotePr><w:footnote w:id="-1"\/><w:footnote w:id="0"\/><\/w:footnotePr>/);
  // Without footnotes, no part.
  assert.ok(!parts('No notes.\n').has('word/footnotes.xml'));
});

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

test('docx: text styles, colours, highlights and inline code are run properties', () => {
  const xml = documentXml('**b** *i* ~~s~~ `c` ==m== [red]{color=red} [hex]{color=#0ea5e9}\n');
  const run = (text: string) => new RegExp(`<w:r><w:rPr>((?:(?!</w:rPr>).)*)</w:rPr><w:t xml:space="preserve">${text}</w:t>`).exec(xml)?.[1] ?? '';
  assert.equal(run('b'), '<w:b/><w:bCs/>');
  assert.equal(run('i'), '<w:i/><w:iCs/>');
  assert.equal(run('s'), '<w:strike/>');
  assert.equal(run('c'), '<w:rStyle w:val="VerbatimChar"/><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>');
  assert.match(run('m'), /<w:shd w:val="clear" w:color="auto" w:fill="FFF0B3"\/>/);
  assert.equal(run('red'), '<w:color w:val="DE350B"/>');
  assert.equal(run('hex'), '<w:color w:val="0EA5E9"/>');
});

test('docx: web links are hyperlink relationships; #links go to bookmarks; other links are text', () => {
  const files = parts('## Goals\n\nSee [the site](<https://example.com/a b?q=1&r=2>), [goals](#goals) and [nowhere](#none).\n');
  const document = files.get('word/document.xml')!;
  const rels = files.get('word/_rels/document.xml.rels')!;
  const id = /<w:hyperlink r:id="(rId\d+)" w:history="1">.*?the site/.exec(document)?.[1];
  assert.ok(id);
  assert.match(rels, new RegExp(`Id="${id}" Type="[^"]+/hyperlink" Target="https://example\\.com/a%20b\\?q=1&amp;r=2" TargetMode="External"`));
  assert.match(document, /<w:bookmarkStart w:id="0" w:name="smd_goals"\/><w:bookmarkEnd w:id="0"\/><w:r><w:t xml:space="preserve">Goals/);
  assert.match(document, /<w:hyperlink w:anchor="smd_goals" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/>/);
  // A link to a place that isn't there stays text.
  assert.match(document, /<w:t xml:space="preserve">nowhere<\/w:t>/);
  assert.ok(!document.includes('w:anchor="smd_none"'));
  assert.equal(linkTarget('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(linkTarget('other.docx'), 'other.docx');
  assert.equal(linkTarget('javascript:alert(1)'), undefined);
});

test('docx: images beside the document are embedded with their size; others keep their alt text and warn', () => {
  const files = new Map([['img/dot.png', PNG], ['a.gif', GIF], ['photo.jpg', JPEG], ['notes.txt', Buffer.from('text')]]);
  const source = '![Dot](img/dot.png) ![Dot again](img/dot.png) ![Anim](a.gif) ![Photo](photo.jpg)\n\n'
    + '![Missing](gone.png) ![Text](notes.txt) ![Web](https://example.com/x.png)\n\n'
    + `![Inline](data:image/png;base64,${PNG.toString('base64')})\n`;
  const { entries, warnings } = docxParts(source, { readBinary: (p) => files.get(p) });
  const names = entries.map((e) => e.name);
  assert.deepEqual(names.filter((n) => n.startsWith('word/media/')), ['word/media/image1.png', 'word/media/image2.gif', 'word/media/image3.jpeg', 'word/media/image4.png']);
  const text = (name: string) => Buffer.from(entries.find((e) => e.name === name)!.data).toString('utf8');
  const document = text('word/document.xml');
  assert.equal((document.match(/<w:drawing>/g) ?? []).length, 5);
  // 2×1 px at 96 dpi.
  assert.match(document, /<wp:extent cx="19050" cy="9525"\/>.*descr="Dot"/);
  // 640 px is wider than the text column: scaled down, keeping the aspect ratio.
  const [cx, cy] = /<wp:extent cx="(\d+)" cy="(\d+)"\/><wp:effectExtent l="0" t="0" r="0" b="0"\/><wp:docPr id="\d+" name="Picture \d+" descr="Photo"/.exec(document)!.slice(1).map(Number);
  assert.equal(cx, Math.floor((9026 / 1440) * 914400), 'the width of the text column');
  assert.ok(Math.abs(cx / cy - 640 / 480) < 0.01);
  // The same file is stored once.
  const rels = text('word/_rels/document.xml.rels');
  assert.equal((rels.match(/Target="media\/image1\.png"/g) ?? []).length, 1);
  assert.match(text('[Content_Types].xml'), /<Default Extension="png" ContentType="image\/png"\/><Default Extension="gif" ContentType="image\/gif"\/><Default Extension="jpeg" ContentType="image\/jpeg"\/>/);
  assert.deepEqual(warnings, [
    'Image gone.png was not found: only its alt text is in the .docx.',
    'Image notes.txt is not PNG, JPEG or GIF: only its alt text is in the .docx.',
    'Image https://example.com/x.png is on the web: the .docx links to it instead of embedding it.',
  ]);
  assert.match(document, /<w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">Missing<\/w:t>/);
});

test('docx: imageInfo reads PNG, GIF and JPEG sizes; hexColour reads CSS colours', () => {
  assert.deepEqual(imageInfo(PNG), { ext: 'png', width: 2, height: 1 });
  assert.deepEqual(imageInfo(GIF), { ext: 'gif', width: 3, height: 2 });
  assert.deepEqual(imageInfo(JPEG), { ext: 'jpeg', width: 640, height: 480 });
  assert.equal(imageInfo(Buffer.from('<svg/>')), undefined);
  assert.equal(imageInfo(new Uint8Array()), undefined);
  assert.equal(hexColour('#0ea5e9'), '0EA5E9');
  assert.equal(hexColour('#abc'), 'AABBCC');
  assert.equal(hexColour('rgb(14, 165, 233)'), '0EA5E9');
  assert.equal(hexColour('var(--x)'), undefined);
  assert.equal(hexColour(undefined), undefined);
});

test('docx: characters XML can\'t hold are dropped; markup characters are escaped', () => {
  const files = parts('---\ntitle: "A \\u0001 B"\n---\nText with \u0007 bell, 5 < 6 & 7 > 3.\n\n```\n<script>]]></script>\n```\n');
  for (const [name, xml] of files) if (name.endsWith('.xml') || name.endsWith('.rels')) assertWellFormed(xml, name);
  const document = files.get('word/document.xml')!;
  assert.ok(!document.includes('\u0007') && !document.includes('\u0001'));
  assert.match(document, /5 &lt; 6 &amp; 7 &gt; 3/);
  assert.match(document, /&lt;script&gt;\]\]&gt;&lt;\/script&gt;/);
});

test('docx: a reference document\'s styles replace the built-in ones; the language is in the defaults', () => {
  const custom = '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>';
  assert.equal(parts('Hi.\n', { styles: custom }).get('word/styles.xml'), custom);
  assert.match(parts('---\nlang: de\n---\nHallo.\n').get('word/styles.xml')!, /<w:lang w:val="de"\/>/);
});
