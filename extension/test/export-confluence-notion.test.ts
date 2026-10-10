import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NOTION_LIMITS, notionRequests, smdToConfluence, smdToNotion, type NotionBlock, type NotionRichText } from '../src/core';
import { htmlToText } from '../src/core/exportTree';
import { splitText } from '../src/core/notion';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NAME = /^[A-Za-z_][\w:.-]*/;
const ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/;

/** Text between tags: `&` only in entities, and no `]]>` outside CDATA. */
function checkText(text: string, at: number): void {
  for (let i = text.indexOf('&'); i >= 0; i = text.indexOf('&', i + 1)) {
    assert.ok(ENTITY.test(text.slice(i)), `bare & at ${at + i}: ${text.slice(i, i + 20)}`);
  }
  assert.ok(!text.includes(']]>'), `]]> in text at ${at}`);
}

/** Attributes of a start tag: name="value" pairs, each name once, values without `<` and with entities only. */
function checkAttributes(source: string, at: number): void {
  const seen = new Set<string>();
  let rest = source;
  while (rest.trim()) {
    const m = /^\s+([A-Za-z_][\w:.-]*)="([^"<]*)"/.exec(rest);
    assert.ok(m, `bad attributes at ${at}: ${source}`);
    assert.ok(!seen.has(m[1]), `duplicate attribute ${m[1]} at ${at}`);
    seen.add(m[1]);
    checkText(m[2], at);
    rest = rest.slice(m[0].length);
  }
}

/** A tiny XML well-formedness check: balanced, properly nested elements, quoted attributes, escaped text, valid characters. */
function assertWellFormed(fragment: string): void {
  const xml = `<root xmlns:ac="urn:ac" xmlns:ri="urn:ri">${fragment}</root>`;
  for (const ch of xml) {
    const c = ch.codePointAt(0)!;
    assert.ok(c === 9 || c === 10 || c === 13 || (c >= 0x20 && c < 0xd800) || (c > 0xdfff && c < 0xfffe) || c > 0xffff, `invalid character U+${c.toString(16)}`);
  }
  const stack: string[] = [];
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    checkText(xml.slice(pos, lt < 0 ? xml.length : lt), pos);
    if (lt < 0) break;
    pos = markup(xml, lt, stack);
  }
  assert.deepEqual(stack, [], 'unclosed elements');
}

function markup(xml: string, lt: number, stack: string[]): number {
  if (xml.startsWith('<![CDATA[', lt)) {
    const end = xml.indexOf(']]>', lt);
    assert.ok(end > 0, `unterminated CDATA at ${lt}`);
    return end + 3;
  }
  const gt = xml.indexOf('>', lt);
  assert.ok(gt > 0, `unterminated tag at ${lt}`);
  const tag = xml.slice(lt + 1, gt);
  if (tag.startsWith('/')) {
    const name = tag.slice(1).trim();
    assert.equal(stack.pop(), name, `mismatched </${name}> at ${lt}`);
    return gt + 1;
  }
  const name = NAME.exec(tag)?.[0];
  assert.ok(name, `bad tag at ${lt}: <${tag}>`);
  const selfClosing = tag.endsWith('/');
  checkAttributes(tag.slice(name.length, selfClosing ? -1 : undefined).trimEnd(), lt);
  if (!selfClosing) stack.push(name);
  return gt + 1;
}

const confluence = (text: string, options = {}) => {
  const xml = smdToConfluence(text, { header: false, ...options });
  assertWellFormed(xml);
  return xml;
};

const notion = (text: string, options = {}) => smdToNotion(text, { header: false, ...options });
const body = (b: NotionBlock) => b[b.type] as Record<string, unknown> & { rich_text?: NotionRichText[]; children?: NotionBlock[] };
const plain = (rich: NotionRichText[] = []) => rich.map((r) => {
  if (r.type === 'text') return r.text.content;
  return r.type === 'equation' ? r.equation.expression : r.mention.date.start;
}).join('');

/** The rich text of a block: at most 100 objects an array, 2000 characters a text and 1000 an equation. */
function assertRichText(type: string, value: ReturnType<typeof body>): void {
  const arrays = [value.rich_text ?? [], ...((value.cells as NotionRichText[][] | undefined) ?? []), (value.caption as NotionRichText[] | undefined) ?? []];
  for (const rich of arrays) {
    assert.ok(rich.length <= NOTION_LIMITS.richText, `${type}: ${rich.length} rich text objects`);
    const too = rich.filter((r) => (r.type === 'text' && r.text.content.length > NOTION_LIMITS.text) || (r.type === 'equation' && r.equation.expression.length > NOTION_LIMITS.equation));
    assert.deepEqual(too, [], `${type}: rich text over the limit`);
  }
}

/** Every Notion limit holds for these blocks (as the top-level blocks of a request). */
function assertNotionLimits(blocks: NotionBlock[], depth = 0): void {
  assert.ok(depth === 0 || blocks.length <= NOTION_LIMITS.children, `${blocks.length} children`);
  for (const b of blocks) {
    assert.equal(b.object, 'block');
    const value = body(b);
    assert.ok(value, `block without its ${b.type} object`);
    assertRichText(b.type, value);
    const children = value.children ?? [];
    if (children.length) assert.ok(depth < NOTION_LIMITS.depth, `${b.type} has children at depth ${depth}`);
    assertNotionLimits(children, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

test('confluence: text is escaped and raw HTML never passes through', () => {
  const xml = confluence('Tom & Jerry <3 "quotes" a]]>b \u0001\n\n<div onclick="steal()"><b>Hi</b> &amp; bye<script>alert(1)</script><!-- note --></div>\n\nInline <span style="color:red">raw</span> html.\n');
  assert.match(xml, /<p>Tom &amp; Jerry &lt;3 “quotes” a\]\]&gt;b <\/p>/);
  assert.match(xml, /<p>Hi &amp; bye<\/p>/);
  assert.match(xml, /<p>Inline raw html\.<\/p>/);
  assert.doesNotMatch(xml, /onclick|steal|alert|script|<div|<span style="color:red|note/);
});

test('confluence: headings, emphasis, links, colours and anchors for in-page links', () => {
  const xml = confluence('## Setup {#setup}\n\n**b** *i* ~~s~~ `c` [red]{color=red weight=bold} [x]{color="#0ea5e9" bg=amber} ==m== [site](https://example.com/a?b=1&c=2) [up](#setup)\n');
  assert.match(xml, /^<h2><ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">setup<\/ac:parameter><\/ac:structured-macro>Setup<\/h2>/);
  assert.match(xml, /<strong>b<\/strong> <em>i<\/em> <span style="text-decoration: line-through;">s<\/span> <code>c<\/code> <strong><span style="color: #de350b;">red<\/span><\/strong>/);
  assert.match(xml, /<span style="color: #0ea5e9; background-color: #fffae6;">x<\/span> <span style="background-color: #fff0b3;">m<\/span>/);
  assert.match(xml, /<a href="https:\/\/example.com\/a\?b=1&amp;c=2">site<\/a>/);
  assert.match(xml, /<ac:link ac:anchor="setup"><ac:link-body>up<\/ac:link-body><\/ac:link>/);
  // Headings nothing links to get no anchor.
  assert.doesNotMatch(confluence('## Alone\n'), /anchor/);
});

test('confluence: callouts map to the info, note, tip and warning macros', () => {
  const macros = ['note', 'info', 'tip', 'success', 'warning', 'danger', 'question']
    .map((t) => /ac:name="(\w+)"><ac:parameter ac:name="title">([^<]+)</.exec(confluence(`:::${t}\nBody\n:::\n`))!.slice(1).join('/'));
  assert.deepEqual(macros, ['info/Note', 'info/Info', 'tip/Tip', 'tip/Success', 'note/Warning', 'warning/Danger', 'info/Question']);
  assert.equal(
    confluence(':::warning{collapsible} Breaking change\nBody\n:::\n'),
    '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Breaking change</ac:parameter><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="note"><ac:parameter ac:name="title">Warning</ac:parameter><ac:rich-text-body><p>Body</p></ac:rich-text-body></ac:structured-macro>' +
    '</ac:rich-text-body></ac:structured-macro>\n',
  );
});

test('confluence: code, Mermaid and math', () => {
  assert.equal(
    confluence('```ts title="src/a.ts" {2}\nconst a = "]]>" && b < c;\n```\n'),
    '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">typescript</ac:parameter><ac:parameter ac:name="title">src/a.ts</ac:parameter>' +
    '<ac:plain-text-body><![CDATA[const a = "]]]]><![CDATA[>" && b < c;]]></ac:plain-text-body></ac:structured-macro>\n',
  );
  const mermaid = confluence('```mermaid\ngraph LR\n  A --> B\n```\n');
  assert.match(mermaid, /ac:name="code"><ac:parameter ac:name="title">Mermaid diagram<\/ac:parameter><ac:plain-text-body><!\[CDATA\[graph LR\n {2}A --> B\]\]>/);
  assert.doesNotMatch(mermaid, /language/);
  const math = confluence('Inline $E = mc^2$.\n\n$$\n\\frac{1}{2}\n$$\n');
  assert.match(math, /<p>Inline <code>E = mc\^2<\/code>\.<\/p>/);
  assert.match(math, /<ac:parameter ac:name="title">LaTeX<\/ac:parameter><ac:plain-text-body><!\[CDATA\[\\frac\{1\}\{2\}\]\]>/);
});

test('confluence: details, tabs and columns', () => {
  const xml = confluence(':::details Logs\nLong.\n:::\n\n::::tabs\n:::tab npm\nnpm i\n:::\n:::tab\npnpm i\n:::\n::::\n\n:::::columns\n::::column\nLeft\n::::\n::::column\nRight\n::::\n:::::\n');
  const expands = [...xml.matchAll(/ac:name="expand"><ac:parameter ac:name="title">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(expands, ['Logs', 'npm', 'Tab']);
  assert.match(xml, /<p>Left<\/p>\n<p>Right<\/p>/);
});

test('confluence: task lists, statuses, badges, priorities and due dates', () => {
  const xml = confluence('- [ ] Open :priority[P0] :due[2026-01-02]\n- [x] Done :badge[Shipped]{color=green}\n- plain :status[At risk]{color=red} :status[]{color=amber}\n');
  assert.match(xml, /^<ac:task-list><ac:task><ac:task-id>1<\/ac:task-id><ac:task-status>incomplete<\/ac:task-status><ac:task-body>Open /);
  assert.match(xml, /ac:name="status"><ac:parameter ac:name="colour">Red<\/ac:parameter><ac:parameter ac:name="title">P0<\/ac:parameter>/);
  assert.match(xml, /<time datetime="2026-01-02" \/>/);
  assert.match(xml, /<ac:task-id>2<\/ac:task-id><ac:task-status>complete<\/ac:task-status><ac:task-body>Done <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green/);
  // The plain item is a list of its own after the task list.
  assert.match(xml, /<\/ac:task-list><ul><li>plain <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Red<\/ac:parameter><ac:parameter ac:name="title">At risk/);
  assert.match(xml, /colour">Yellow<\/ac:parameter><ac:parameter ac:name="title">amber</);
  // Dates do not depend on today: the output is the same whenever it is made.
  assert.doesNotMatch(xml, /overdue|soon/);
});

test('confluence: figures, references and footnotes', () => {
  const xml = confluence('See :ref[fig-a] and a note[^n].\n\n:::figure{#fig-a} The *flow*\n![Flow](img/flow%20chart.png)\n:::\n\n[^n]: The note.\n');
  assert.match(xml, /<ac:link ac:anchor="fig-a"><ac:link-body>Figure 1<\/ac:link-body><\/ac:link>/);
  assert.match(xml, /<sup><ac:link ac:anchor="fn-1"><ac:plain-text-link-body><!\[CDATA\[1\]\]><\/ac:plain-text-link-body><\/ac:link><\/sup>/);
  assert.match(xml, /<p><ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">fig-a<\/ac:parameter><\/ac:structured-macro><\/p>\n<p><ac:image ac:alt="Flow"><ri:attachment ri:filename="flow chart.png" \/><\/ac:image><\/p>\n<p><strong>Figure 1:<\/strong> <em>The <\/em><em>flow<\/em><\/p>/);
  assert.match(xml, /<hr \/><ol><li><ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">fn-1<\/ac:parameter><\/ac:structured-macro>The note\.<\/li><\/ol>/);
});

test('confluence: images by URL, relative images as attachments, other sources as their alt text', () => {
  const xml = confluence('![Logo](https://x.test/logo.png) ![Local](../media/a.png?v=2) ![Data](data:image/png;base64,AAAA)\n');
  assert.match(xml, /<ac:image ac:alt="Logo"><ri:url ri:value="https:\/\/x.test\/logo.png" \/><\/ac:image>/);
  assert.match(xml, /<ac:image ac:alt="Local"><ri:attachment ri:filename="a.png" \/><\/ac:image>/);
  assert.doesNotMatch(xml, /base64/);
});

test('confluence: decisions, risks, APIs and the risk matrix', () => {
  const doc = ':::decision{status=accepted date=2026-09-12 owner=@maya} Go EU first\nBecause.\n:::\n\n' +
    ':::risk{impact=high likelihood=low owner=@ops status=open} Rate limits\nPre-warm.\n:::\n\n:::risk-matrix\n:::\n\n' +
    ':::api{method=post path="/v1/orders" auth=token} Create\nBody.\n:::\n';
  const xml = confluence(doc);
  assert.match(xml, /ac:name="panel"><ac:parameter ac:name="title">Decision: Go EU first<\/ac:parameter><ac:rich-text-body><p><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green<\/ac:parameter><ac:parameter ac:name="title">accepted<\/ac:parameter><\/ac:structured-macro> · <time datetime="2026-09-12" \/> · @maya<\/p><p>Because\.<\/p>/);
  assert.match(xml, /title">Risk: Rate limits<\/ac:parameter><ac:rich-text-body><p>Impact <strong>high<\/strong> · Likelihood <strong>low<\/strong> · Owner @ops · <ac:structured-macro/);
  assert.match(xml, /<table><tbody><tr><th><p>Impact ↓ · Likelihood →<\/p><\/th><th><p>Low<\/p><\/th>/);
  assert.match(xml, /<tr><td><p><strong>High<\/strong><\/p><\/td><td><p>Rate limits<\/p><\/td>/);
  assert.match(xml, /title">POST \/v1\/orders — Create<\/ac:parameter><ac:rich-text-body><p>🔒 <code>token<\/code><\/p><p>Body\.<\/p>/);
});

test('confluence: agent and human blocks follow the human view, as rendering does', () => {
  const doc = '## History {agent=skip}\n\nOld.\n\n:::agent Rules\nDo X.\n:::\n\n:::human Why\nBecause.\n:::\n';
  const collapsed = confluence(doc);
  assert.match(collapsed, /<h2>History<\/h2>\n<p>Old\.<\/p>/);
  assert.match(collapsed, /ac:name="expand"><ac:parameter ac:name="title">For agents: Rules<\/ac:parameter><ac:rich-text-body><p>Do X\.<\/p>/);
  assert.match(collapsed, /ac:name="panel"><ac:parameter ac:name="title">For humans: Why<\/ac:parameter>/);
  assert.match(confluence(doc, { agentBlocks: 'expanded' }), /ac:name="panel"><ac:parameter ac:name="title">For agents: Rules/);
  assert.doesNotMatch(confluence(doc, { agentBlocks: 'hidden' }), /Do X|For agents/);
});

test('confluence: includes go through the reader; without one the fallback body stays', () => {
  const doc = ':::include{file="shared/terms.smd" section="Pricing"}\nSee the terms.\n:::\n';
  const readFile = (p: string) => (p === 'shared/terms.smd' ? '## Pricing\n\nMonthly & yearly.\n\n## Other\n\nNo.\n' : undefined);
  const included = confluence(doc, { readFile });
  assert.match(included, /<h2>Pricing<\/h2>\n<p>Monthly &amp; yearly\.<\/p>/);
  assert.doesNotMatch(included, /See the terms|No\./);
  const fallback = confluence(doc);
  assert.match(fallback, /<p><em>Include not available here: <\/em><a href="shared\/terms.smd#pricing"><code>shared\/terms.smd § Pricing<\/code><\/a><\/p>\n<p>See the terms\.<\/p>/);
});

test('confluence: the front matter header, localized labels, and the same output every time', () => {
  const doc = '---\ntitle: Plan\nstatus: draft\nversion: 2\nsummary: The **plan**.\nowners: [a, b]\nlang: de\n---\n\n:::note\nX\n:::\n';
  const xml = smdToConfluence(doc);
  assertWellFormed(xml);
  assert.match(xml, /^<p><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Yellow<\/ac:parameter><ac:parameter ac:name="title">Entwurf<\/ac:parameter><\/ac:structured-macro> · v2<\/p>\n<p>The <strong>plan<\/strong>\.<\/p>\n<p><strong>Verantwortlich: <\/strong>a, b<\/p>/);
  assert.match(xml, /<ac:parameter ac:name="title">Hinweis<\/ac:parameter>/);
  assert.doesNotMatch(xml, /<h1>/, 'the title is the page title');
  assert.equal(smdToConfluence(doc), xml);
  assert.equal(smdToConfluence(''), '');
});

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

test('notion: one block type per construct', () => {
  const blocks = notion('# One\n\n## Two\n\n### Three\n\n#### Four\n\nPara.\n\n- a\n- b\n\n1. first\n\n- [x] done\n- [ ] open\n\n```py\nx = 1\n```\n\n> Quoted\n\n:::tip Hint\nBody\n:::\n\n---\n\n| A | B |\n|---|---|\n| 1 |\n\n:::details More\nHidden\n:::\n\n$$\nx^2\n$$\n');
  assert.deepEqual(blocks.map((b) => b.type), [
    'heading_1', 'heading_2', 'heading_3', 'heading_3', 'paragraph', 'bulleted_list_item', 'bulleted_list_item', 'numbered_list_item',
    'to_do', 'to_do', 'code', 'quote', 'callout', 'divider', 'table', 'toggle', 'equation',
  ]);
  assert.deepEqual(blocks.slice(8, 10).map((b) => body(b).checked), [true, false]);
  assert.deepEqual(body(blocks[10]), { rich_text: [{ type: 'text', text: { content: 'x = 1' } }], language: 'python', caption: [] });
  assert.deepEqual(body(blocks[12]), {
    rich_text: [{ type: 'text', text: { content: 'Hint' }, annotations: { bold: true } }], icon: { type: 'emoji', emoji: '💡' }, color: 'green_background',
    children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'Body' } }] } }],
  });
  const table = body(blocks[14]);
  assert.equal(table.table_width, 2);
  assert.equal(table.has_column_header, true);
  assert.deepEqual(table.children!.map((r) => (r.table_row as { cells: NotionRichText[][] }).cells.map(plain)), [['A', 'B'], ['1', '']]);
  assert.equal(plain(body(blocks[15]).rich_text), 'More');
  assert.deepEqual(body(blocks[16]), { expression: 'x^2' });
});

test('notion: rich text annotations, links, equations, dates and statuses', () => {
  const [p] = notion('**b** *i* ~~s~~ `c` [g]{color=green} ==m== [site](https://x.test) [here](#top) [rel](other.smd) $a+b$ :due[2026-01-02] :badge[Beta]{color=amber} note[^1]\n\n[^1]: N.\n');
  const rich = body(p).rich_text!;
  type TextItem = Extract<NotionRichText, { type: 'text' }>;
  const find = (content: string) => rich.find((r): r is TextItem => r.type === 'text' && r.text.content === content);
  assert.deepEqual(find('b')?.annotations, { bold: true });
  assert.deepEqual(find('i')?.annotations, { italic: true });
  assert.deepEqual(find('s')?.annotations, { strikethrough: true });
  assert.deepEqual(find('c')?.annotations, { code: true });
  assert.deepEqual(find('g')?.annotations, { color: 'green' });
  assert.deepEqual(find('m')?.annotations, { color: 'yellow_background' });
  assert.deepEqual(find('site'), { type: 'text', text: { content: 'site', link: { url: 'https://x.test' } } });
  assert.ok(rich.some((r) => r.type === 'equation' && r.equation.expression === 'a+b'));
  assert.ok(rich.some((r) => r.type === 'mention' && r.mention.date.start === '2026-01-02'));
  assert.deepEqual(find('Beta')?.annotations, { code: true, color: 'yellow' });
  // Links within the page and relative links are text: Notion takes absolute URLs only.
  assert.match(plain(rich), / here rel /);
  assert.ok(!rich.some((r) => r.type === 'text' && r.text.link && !r.text.link.url.startsWith('https://')));
  assert.match(plain(rich), /note\[1\]$/);
});

test('notion: text over 2000 characters is split, never inside a surrogate pair', () => {
  const long = `${'a'.repeat(1999)}😀${'b'.repeat(2500)}`;
  const [p] = notion(`${long}\n`);
  const parts = body(p).rich_text!.map((r) => (r.type === 'text' ? r.text.content : ''));
  assert.deepEqual(parts.map((s) => s.length), [1999, 2000, 502]);
  assert.equal(parts.join(''), long);
  assert.deepEqual(splitText('abcde', 2), ['ab', 'cd', 'e']);
  const [code] = notion(`\`\`\`\n${'x'.repeat(4100)}\n\`\`\`\n`);
  assert.deepEqual(body(code).rich_text!.map((r) => plain([r]).length), [2000, 2000, 100]);
  assertNotionLimits([p, code]);
});

test('notion: over 100 rich text objects continue in another block', () => {
  const words = Array.from({ length: 120 }, (_, n) => (n % 2 ? `**w${n}**` : `w${n}`)).join(' ');
  const blocks = notion(`${words}\n`);
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'paragraph']);
  assert.equal(body(blocks[0]).rich_text!.length, 100);
  assertNotionLimits(blocks);
});

test('notion: nesting deeper than two levels is flattened, and nothing is lost', () => {
  const blocks = notion('- one\n  - two\n    - three\n      - four\n        - five\n');
  assertNotionLimits(blocks);
  const texts: string[] = [];
  const walk = (list: NotionBlock[]) => list.forEach((b) => { texts.push(plain(body(b).rich_text)); walk(body(b).children ?? []); });
  walk(blocks);
  assert.deepEqual(texts, ['one', 'two', 'three', 'four', 'five']);
  // A table that would nest too deep becomes paragraphs of its rows.
  const table = notion('- a\n  - b\n\n    | H | I |\n    |---|---|\n    | 1 | 2 |\n');
  assertNotionLimits(table);
  assert.match(JSON.stringify(table), /"H"\}\},\{"type":"text","text":\{"content":" \| "\}\},\{"type":"text","text":\{"content":"I"/);
});

test('notion: more than 100 children follow their block; long tables split under the same header', () => {
  const paragraphs = Array.from({ length: 150 }, (_, n) => `P${n}`).join('\n\n');
  const blocks = notion(`:::details Many\n${paragraphs}\n:::\n`);
  assert.equal(blocks[0].type, 'toggle');
  assert.equal(body(blocks[0]).children!.length, 100);
  assert.equal(blocks.length, 51);
  assertNotionLimits(blocks);
  const rows = Array.from({ length: 150 }, (_, n) => `| ${n} |`).join('\n');
  const tables = notion(`| N |\n|---|\n${rows}\n`);
  assert.deepEqual(tables.map((t) => body(t).children!.length), [100, 52]);
  assert.equal(plain((body(tables[1]).children![0].table_row as { cells: NotionRichText[][] }).cells[0]), 'N');
});

test('notion: requests hold at most 100 top-level and 1000 blocks', () => {
  const blocks = notion(Array.from({ length: 250 }, (_, n) => `P${n}`).join('\n\n'));
  const requests = notionRequests(blocks);
  assert.deepEqual(requests.map((r) => r.children.length), [100, 100, 50]);
  const lists = notion(Array.from({ length: 30 }, (_, n) => `- L${n}\n${Array.from({ length: 40 }, (_, k) => `  - ${n}.${k}`).join('\n')}`).join('\n\n'));
  const counts = notionRequests(lists).map((r) => r.children.reduce((sum, b) => sum + 1 + (body(b).children ?? []).length, 0));
  assert.ok(counts.every((c) => c <= NOTION_LIMITS.requestBlocks), String(counts));
  assert.equal(counts.reduce((a, b) => a + b, 0), 30 * 41);
  assert.deepEqual(notionRequests([]), []);
});

test('notion: images, Mermaid, callouts, panels and what Notion lacks', () => {
  const blocks = notion('![Diagram](https://x.test/d.png)\n\n![Local](img/a.png)\n\n```mermaid\ngraph LR\n```\n\n```weird\nx\n```\n\n' +
    ':::decision{status=accepted} Go\nWhy.\n:::\n\n<div>Raw <b>HTML</b></div>\n\n:::figure{#f} Cap\nBody\n:::\n');
  assert.deepEqual(body(blocks[0]), { type: 'external', external: { url: 'https://x.test/d.png' }, caption: [{ type: 'text', text: { content: 'Diagram' } }] });
  assert.equal(plain(body(blocks[1]).rich_text), 'Local');
  assert.equal(body(blocks[2]).language, 'mermaid');
  assert.equal(body(blocks[3]).language, 'plain text');
  assert.deepEqual(body(blocks[4]).icon, { type: 'emoji', emoji: '⚖️' });
  assert.equal(plain(body(blocks[4]).rich_text), 'Decision: Go');
  assert.deepEqual(blocks.slice(5).map((b) => [b.type, plain(body(b).rich_text)]), [['paragraph', 'Raw HTML'], ['paragraph', 'Body'], ['paragraph', 'Figure 1: Cap']]);
});

test('notion: output is plain JSON and the same every time', () => {
  const doc = readFileSync(join(__dirname, '..', '..', 'examples', 'showcase.smd'), 'utf8');
  const first = JSON.stringify(smdToNotion(doc));
  assert.equal(JSON.stringify(JSON.parse(first)), first);
  assert.equal(JSON.stringify(smdToNotion(doc)), first);
});

test('raw HTML to text: tags, comments, scripts and styles go; entities are decoded; a lone < stays', () => {
  assert.equal(htmlToText('<p class="x">a &lt;b&gt; &amp; &#169; &#x1F600;</p><!-- c --><style>p{}</style><script>x()</script> 1 < 2'), 'a <b> & © 😀 1 < 2');
});

// ---------------------------------------------------------------------------
// Every example and corpus document
// ---------------------------------------------------------------------------

const root = join(__dirname, '..', '..');
const documents = [join(root, 'examples'), join(__dirname, 'compat', 'corpus')]
  .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.smd')).map((f) => join(dir, f)));

test('every example and corpus document exports to well-formed Confluence XML and Notion blocks within the limits', () => {
  assert.ok(documents.length >= 15);
  for (const file of documents) {
    const text = readFileSync(file, 'utf8');
    const readFile = (p: string) => {
      const target = join(dirname(file), p);
      return existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    };
    const xml = smdToConfluence(text, { readFile });
    assert.ok(xml.trim(), file);
    assertWellFormed(xml);
    const blocks = smdToNotion(text, { readFile });
    assert.ok(blocks.length, file);
    for (const request of notionRequests(blocks)) {
      assert.ok(request.children.length <= NOTION_LIMITS.children, file);
      assertNotionLimits(request.children);
    }
  }
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('smd export: Confluence and Notion to stdout, and the usage on a bad format', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const run = (args: string[]) => spawnSync(process.execPath, [cli, 'export', ...args], { cwd: root, encoding: 'utf8' });
  const xml = run(['--to', 'confluence', 'examples/adr-0007-event-bus.smd']);
  assert.equal(xml.status, 0, xml.stderr);
  assertWellFormed(xml.stdout);
  const json = run(['--to', 'notion', 'examples/adr-0007-event-bus.smd']);
  assert.equal(json.status, 0, json.stderr);
  const requests = JSON.parse(json.stdout) as Array<{ children: NotionBlock[] }>;
  assert.ok(requests.length >= 1 && requests[0].children.length);
  const bad = run(['--to', 'word', 'examples/adr-0007-event-bus.smd']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown export format "word"[\s\S]*smd export --to confluence\|notion/);
  assert.equal(run(['examples/adr-0007-event-bus.smd']).status, 2);
});
