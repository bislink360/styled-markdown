import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentView, extractTasks, getDocumentInfo, issueTasks, outline, planIssueSync, querySmd, renderSmd, smdToMarkdown, validateSmd,
} from '../src/core';
import { inlineText } from '../src/core/agentView';
import { fenceLines, inlineMathSpans } from '../src/core/parse';
import { convertInline } from '../src/core/toMarkdown';
import { readdirSync } from 'node:fs';
import { fillTemplate } from '../src/core';

const TODAY = '2026-09-26';
const codes = (text: string, opts = {}) => validateSmd(text, { today: TODAY, ...opts }).map((d) => d.code);
const prd = readFileSync(join(__dirname, '..', '..', 'examples', 'checkout-redesign.smd'), 'utf8');

// ---------------------------------------------------------------------------
// PM / developer components
// ---------------------------------------------------------------------------

test('decision, risk, api and timeline render', () => {
  const html = renderSmd([
    ':::decision{status=accepted date=2026-09-01 owner=@a} Use Postgres', 'Because.', ':::',
    ':::risk{impact=high likelihood=low owner=@b} Rate limits', 'Mitigate.', ':::',
    ':::api{method=POST path="/v1/x" auth=token} Create', 'Body.', ':::',
    ':::timeline', '- **2026-10-01** — Beta', ':::',
  ].join('\n')).html;
  assert.match(html, /smd-decision smd-decision-accepted/);
  assert.match(html, /Use Postgres/);
  assert.match(html, /smd-risk smd-risk-high/);
  assert.match(html, /smd-api-method smd-api-post">POST/);
  assert.match(html, /<code class="smd-api-path">\/v1\/x<\/code>/);
  assert.match(html, /smd-timeline/);
});

test('enumerated and required attributes are validated', () => {
  assert.ok(codes(':::api{method=POST} x\n:::').includes('attrs/required'));
  const risk = validateSmd(':::risk{impact=hgh} x\n:::');
  assert.equal(risk[0].code, 'attrs/value');
  assert.match(risk[0].message, /did you mean "high"/);
  assert.ok(codes(':::decision{status=maybe} x\n:::').includes('attrs/value'));
  assert.ok(codes(':metric[3]{trend=sideways label=x}').includes('attrs/value'));
});

test('priority, due and metric directives', () => {
  const html = renderSmd(':priority[P0] :due[2026-09-20] :due[2026-09-30] :due[2026-12-01] :metric[42%]{label="Activation" delta="+3%" trend=up}', { today: TODAY }).html;
  assert.match(html, /smd-priority" style="--smd-badge:var\(--smd-red\)">P0/);
  assert.match(html, /smd-due-overdue/);
  assert.match(html, /smd-due-soon/);
  assert.match(html, /smd-due-later/);
  assert.match(html, /smd-metric-good"><span aria-hidden="true">▲<\/span> \+3%<span class="smd-sr-only"> \(up, good\)<\/span>/);
  assert.ok(codes(':due[next week]').includes('attrs/value'));
  assert.ok(codes(':priority[urgent]').includes('attrs/value'));
  assert.ok(codes(':metric[3]').includes('attrs/required'));
});

test('overdue open tasks are reported, done tasks are not', () => {
  assert.ok(codes('- [ ] Ship :due[2026-09-01]').includes('task/overdue'));
  assert.ok(!codes('- [x] Ship :due[2026-09-01]').includes('task/overdue'));
});

test('heading attributes: custom id, agent=skip, stripped from text', () => {
  const r = renderSmd('## Background {agent=skip}\n\n## Setup {#install .lead}');
  assert.equal(r.headings[0].text, 'Background');
  assert.equal(r.headings[0].agent, 'skip');
  assert.equal(r.headings[1].slug, 'install');
  assert.match(r.html, /<h2[^>]*data-agent="skip"[^>]*>Background<\/h2>/);
  assert.ok(codes('## X {agent=focus}').includes('attrs/value'));
  assert.deepEqual(codes('## X {#x}\n\n[go](#x)'), []);
});

test('code line highlights and file embeds', () => {
  const hl = renderSmd('```ts {2}\na\nb\n```').html;
  assert.match(hl, /<pre class="smd-has-hl"><span class="smd-hl-line" style="top:calc\(14px \+ 1 \* 1.55em\)">/);
  const files: Record<string, string> = { 'src/a.ts': 'line1\nline2\nline3\n' };
  const readFile = (p: string) => files[p];
  const embed = renderSmd('```ts file="src/a.ts" lines="2-3"\n```', { readFile }).html;
  assert.match(embed, /smd-code-title">src\/a.ts:2-3/);
  assert.match(embed, /line2\nline3/);
  assert.doesNotMatch(embed, /line1/);
  assert.ok(codes('```ts file="nope.ts"\n```', { readFile }).includes('fence/embed-missing'));
  assert.ok(codes('```ts file="src/a.ts" lines="2-9"\n```', { readFile }).includes('fence/range'));
  assert.ok(codes('```ts file="src/a.ts"\nstuff\n```', { readFile }).includes('fence/embed-body'));
});

// ---------------------------------------------------------------------------
// Agent view — token reduction without losing meaning
// ---------------------------------------------------------------------------

test('agent view drops human-only content and styling but keeps meaning', () => {
  const r = agentView(prd, { today: TODAY });
  assert.ok(r.tokens < r.originalTokens * 0.7, `expected ≥30% smaller, got ${r.tokens}/${r.originalTokens}`);
  assert.doesNotMatch(r.text, /usability sessions/); // :::human block
  assert.doesNotMatch(r.text, /Our checkout was designed in 2019/); // {agent=skip} section
  assert.doesNotMatch(r.text, /\{color=|:::|:badge\[|\{agent=skip\}/); // no styling syntax left
  assert.match(r.text, /<agent-instructions title="Engineering constraints">/);
  assert.match(r.text, /Never use floats for money/);
  assert.match(r.text, /<decision status="accepted" date="2026-09-08" owner="@maya"> Accordion layout/);
  assert.match(r.text, /<risk impact="high" likelihood="medium" owner="@payments" status="open">/);
  assert.match(r.text, /API POST \/v1\/orders — Create the order/);
  assert.match(r.text, /<question title="Should guest users see wallet buttons/);
  assert.match(r.text, /## Requirements {2}\[L53\]/);
  assert.match(r.text, /\[P1\] @api-team \(due 2026-09-25, OVERDUE\)/);
  assert.match(r.text, /Checkout abandonment: 38% \(\+2\.1pp\)/);
  assert.match(r.text, /\[code: src\/pricing\.ts lines 7-13/);
  assert.deepEqual(r.skippedSections, ['Background', 'Design', 'Analytics']);
});

test('section selection keeps document-wide agent instructions', () => {
  const r = agentView(prd, { sections: ['requirements'] });
  assert.ok(r.tokens < r.originalTokens * 0.3);
  assert.match(r.text, /## Requirements/);
  assert.doesNotMatch(r.text, /## Risks/);
  assert.match(r.text, /Document-wide agent instructions:[\s\S]*Never use floats for money/);
  assert.deepEqual(agentView(prd, { sections: ['nonexistent'] }).missingSections, ['nonexistent']);
});

test('brief mode condenses diagrams, details and completed tasks', () => {
  const r = agentView(prd, { brief: true, sections: ['architecture', 'requirements'] });
  assert.match(r.text, /\[diagram: sequenceDiagram, \d+ lines — see L\d+-L\d+\]/);
  assert.match(r.text, /\(1 completed task omitted\)/);
  assert.doesNotMatch(r.text, /participant C as Checkout page/);
  const withDetails = agentView(prd, { brief: true, includeHuman: true, sections: ['analytics'] });
  assert.match(withDetails.text, /\[details: Full event list — omitted, see L\d+\]/);
});

test('agent view can inline embedded source on request', () => {
  const readFile = (p: string) => (p === 'src/pricing.ts' ? 'a\nb\nc\nd\ne\nf\nexport function subtotalCents() {}\n' : undefined);
  const r = agentView(prd, { embed: true, readFile, sections: ['architecture'] });
  assert.match(r.text, /src\/pricing\.ts lines 7-13:\n```ts\nexport function subtotalCents/);
});

/** Indented code at the top level, in a list and in a container, and display math, next to four-space lines that are text. */
const AS_WRITTEN = [
  'Text :badge[top] ==mark== [red]{color=red}.', '',
  '    code :badge[x] ==mark== [text]{color=red} ![alt](a.png) :ref[fig-a]', '',
  'Paragraph', '    continued :badge[lazy] ==m==', '',
  '- item', '    more :badge[item]', '',
  '        nested :kbd[Ctrl] ==mark==', '',
  ':::note Title :badge[t]', '    first :badge[c] ==mark==', ':::', '',
  ':::figure{#fig-a} Caption', 'x', ':::', '',
  '$$', String.raw`\sqrt[3]{x} ==m== :badge[b]`, '$$', '',
  String.raw`$$\sqrt[3]{y} ==m==$$`,
].join('\n');
const AS_WRITTEN_PART = [
  'Included :badge[inc].', '', '    inc code :badge[x] ==mark== [text]{color=red}', '',
  '$$', String.raw`\sqrt[3]{z} ==m==`, '$$', '', 'Para', '    lazy :badge[inc-lazy]', '',
].join('\n');
const AS_WRITTEN_INCLUDING = 'Before :badge[b].\n\n:::include{file="part.smd"}\n:::\n';
const asWrittenFile = (p: string) => (p === 'part.smd' ? AS_WRITTEN_PART : undefined);
const has = (text: string, ...lines: string[]) => assert.ok(`\n${text}\n`.includes(`\n${lines.join('\n')}\n`), `${lines.join('\n')}\n--- not in ---\n${text}`);

test('agent view leaves indented code and display math as written, as rendering shows them', () => {
  // What rendering shows: code and math as written; a four-space line that continues a paragraph or a list item is text.
  const html = renderSmd(AS_WRITTEN).html;
  assert.ok(html.includes('<code>code :badge[x] ==mark== [text]{color=red} ![alt](a.png) :ref[fig-a]\n</code>'));
  assert.ok(html.includes('<code>  nested :kbd[Ctrl] ==mark==\n</code>'));
  assert.ok(html.includes('<code>first :badge[c] ==mark==\n</code>'));
  assert.match(html, /continued <span class="smd-badge"[^>]*>lazy<\/span> <mark>m<\/mark>/);
  assert.match(html, /more <span class="smd-badge"[^>]*>item<\/span>/);
  assert.ok(html.includes(String.raw`<annotation encoding="application/x-tex">\sqrt[3]{x} ==m== :badge[b]</annotation>`));
  assert.ok(html.includes(String.raw`<annotation encoding="application/x-tex">\sqrt[3]{y} ==m==</annotation>`));

  for (const brief of [false, true]) {
    const view = agentView(AS_WRITTEN, { brief }).text;
    has(view, 'Text [top] mark red.');
    has(view, '    code :badge[x] ==mark== [text]{color=red} ![alt](a.png) :ref[fig-a]');
    has(view, 'Paragraph', '    continued [lazy] m');
    has(view, '- item', '    more [item]', '', '        nested :kbd[Ctrl] ==mark==');
    has(view, '<note title="Title [t]">', '    first :badge[c] ==mark==', '</note>');
    has(view, '$$', String.raw`\sqrt[3]{x} ==m== :badge[b]`, '$$', '', String.raw`$$\sqrt[3]{y} ==m==$$`);
  }
  // In included text too, by where the included lines are code or math.
  assert.ok(renderSmd(AS_WRITTEN_INCLUDING, { readFile: asWrittenFile }).html.includes('<code>inc code :badge[x] ==mark== [text]{color=red}\n</code>'));
  has(agentView(AS_WRITTEN_INCLUDING, { readFile: asWrittenFile }).text,
    'Before [b].', '', '<included file="part.smd">', 'Included [inc].', '', '    inc code :badge[x] ==mark== [text]{color=red}', '',
    '$$', String.raw`\sqrt[3]{z} ==m==`, '$$', '', 'Para', '    lazy [inc-lazy]', '</included>');
});

test('agent view and plain Markdown keep indented code verbatim, like fenced code: no line of it is a task, a comment or a table row', () => {
  const code = ['    - [x] not a task', '    <!-- kept -->', '    | a | b |', '    trailing   '];
  const text = ['Intro.', '', '- [x] done', '', 'Code:', '', ...code, '', 'After <!-- gone --> text.', '', '- [x] done too'].join('\n');
  assert.ok(renderSmd(text).html.includes('<code>- [x] not a task\n&lt;!-- kept --&gt;\n| a | b |\n'));
  has(agentView(text).text, 'Code:', '', ...code, '', 'After  text.');
  // Condensed views count the two tasks of the lists, not the line of code that looks like one.
  has(agentView(text, { brief: true }).text, '- (1 completed task omitted)', 'Code:', '', ...code, '', 'After  text.', '', '- (1 completed task omitted)');
  has(smdToMarkdown(text), 'Code:', '', ...code, '', 'After <!-- gone --> text.');
  // In included text, and for display math: a line of math with bars is not a table row.
  const readFile = (p: string) => (p === 'part.smd' ? ['Included.', '', ...code, '', '$$', String.raw`|a| \le |b|`, '$$', ''].join('\n') : undefined);
  const including = 'Before.\n\n:::include{file="part.smd"}\n:::\n';
  has(agentView(including, { readFile, brief: true }).text, '<included file="part.smd">', 'Included.', '', ...code, '', '$$', String.raw`|a| \le |b|`, '$$', '</included>');
  has(smdToMarkdown(including, { readFile }), 'Included.', '', ...code, '', '$$', String.raw`|a| \le |b|`, '$$');
});

/** Inline math in a heading, a task, a table cell and a container title, inside other syntax, and dollar signs that are not math. */
const INLINE_MATH = [
  String.raw`## Heading $\sqrt[3]{h}$ ==mark==`, '',
  String.raw`- [ ] Task $\sqrt[3]{t}$ :badge[b]`, '',
  '| a | b |', '|---|---|', String.raw`| $\sqrt[3]{c}$ ==m== | $a ==b== c$ |`, '',
  String.raw`:::note Title $\sqrt[3]{n}$ ==t==`, 'Body.', ':::', '',
  String.raw`Around ==a $x=y$ b== and [span $\sqrt[3]{s}$]{color=red}, not in ` + '`$a ==b==$`.', '',
  String.raw`Money $5 and $10 ==cheap==, or \$a ==b== c\$ [red]{color=red}.`,
].join('\n');

test('agent view and plain Markdown leave $inline math$ as written, as rendering reads it', () => {
  const html = renderSmd(INLINE_MATH).html;
  const tex = [...html.matchAll(/<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/g)].map((m) => m[1]);
  assert.deepEqual(tex, [String.raw`\sqrt[3]{h}`, String.raw`\sqrt[3]{t}`, String.raw`\sqrt[3]{c}`, 'a ==b== c', String.raw`\sqrt[3]{n}`, 'x=y', String.raw`\sqrt[3]{s}`]);
  // Dollar signs that open no math are text, and the syntax around them is syntax.
  assert.match(html, /Money \$5 and \$10 <mark>cheap<\/mark>, or \$a <mark>b<\/mark> c\$ <span[^>]*>red<\/span>\./);

  const view = agentView(INLINE_MATH).text;
  has(view, String.raw`## Heading $\sqrt[3]{h}$ mark  [L1]`);
  has(view, String.raw`- [ ] Task $\sqrt[3]{t}$ [b]`);
  has(view, String.raw`|$\sqrt[3]{c}$ m|$a ==b== c$|`);
  has(view, String.raw`<note title="Title $\sqrt[3]{n}$ t">`);
  has(view, String.raw`Around a $x=y$ b and span $\sqrt[3]{s}$, not in ` + '`$a ==b==$`.');
  has(view, String.raw`Money $5 and $10 cheap, or \$a b c\$ red.`);

  const md = smdToMarkdown(INLINE_MATH);
  has(md, String.raw`## Heading $\sqrt[3]{h}$ **mark**`);
  has(md, String.raw`- [ ] Task $\sqrt[3]{t}$ ` + '`b`');
  has(md, String.raw`| $\sqrt[3]{c}$ **m** | $a ==b== c$ |`);
  has(md, String.raw`> **Title $\sqrt[3]{n}$ **t****`);
  has(md, String.raw`Around **a $x=y$ b** and span $\sqrt[3]{s}$, not in ` + '`$a ==b==$`.');
  has(md, String.raw`Money $5 and $10 **cheap**, or \$a **b** c\$ red.`);

  // In included text too.
  const readFile = (p: string) => (p === 'part.smd' ? String.raw`Included $\sqrt[3]{i}$ ==m==.` + '\n' : undefined);
  const including = ':::include{file="part.smd"}\n:::\n';
  has(agentView(including, { readFile }).text, String.raw`Included $\sqrt[3]{i}$ m.`);
  has(smdToMarkdown(including, { readFile }), String.raw`Included $\sqrt[3]{i}$ **m**.`);
});

test('inline math is found as the inline parser reads a line; tasks, meta and query keep it, and text without math is unchanged', () => {
  const spans = (line: string) => inlineMathSpans(line).map(([start, end]) => line.slice(start, end));
  assert.deepEqual(spans(String.raw`a $x$ b $\sqrt[3]{y}$ c`), ['$x$', String.raw`$\sqrt[3]{y}$`]);
  // The opening and closing conditions of the rule: no space inside the `$` signs, no digit after the closing one.
  for (const line of ['$5 and $10', 'from $5-$10', 'a $ x$ b', 'a $x $ b', 'a $$ b', 'one $ sign']) assert.deepEqual(spans(line), [], line);
  // `\$` opens nothing and closes nothing.
  assert.deepEqual(spans(String.raw`\$a$b$ and $c \$ d$ and \$e ==f== g\$`), ['$b$', String.raw`$c \$ d$`]);
  // Rules that come first: code spans, link destinations and HTML tags hold no math; an image's alt text is its own text.
  assert.deepEqual(spans('`$a$` [l](u/$b) [m](u/$c) <i title="$d$"> ![alt $e$](i.png) $f$'), ['$f$']);
  assert.deepEqual(spans('[US$]{color=red} or [CA$]{color=blue}'), ['$]{color=red} or [CA$']);

  assert.equal(inlineText(String.raw`:badge[a] $\sqrt[3]{x}$ ==m== {{v}} $y^{{v}}$`, { variables: { v: 2 } }), String.raw`[a] $\sqrt[3]{x}$ m 2 $y^{{v}}$`);
  assert.equal(inlineText('Pay $5 and $10 ==now== [red]{color=red} `==code==` {{v}}', { variables: { v: 2 } }), 'Pay $5 and $10 now red `==code==` 2');
  assert.equal(convertInline(String.raw`:badge[a] $\sqrt[3]{x}$ ==m==`), '`a` ' + String.raw`$\sqrt[3]{x}$ **m**`);
  assert.equal(convertInline('Pay $5 and $10 ==now== [red]{color=red weight=bold}'), 'Pay $5 and $10 **now** **red**');

  const text = [
    String.raw`## Costs $\sqrt[3]{h}$ ==now==`, '', String.raw`- [ ] Check $\sqrt[3]{t}$ ==soon== :priority[P1]`, '- [ ] Pay $5 and $10 ==now== :due[2026-10-01]', '',
    String.raw`:::decision{status=accepted} Use $\sqrt[3]{d}$ ==here==`, ':::',
  ].join('\n');
  const tasks = extractTasks(text, TODAY);
  assert.deepEqual(tasks.map((t) => [t.text, t.section, t.priority ?? '', t.due ?? '']), [
    [String.raw`Check $\sqrt[3]{t}$ soon`, String.raw`Costs $\sqrt[3]{h}$ now`, 'P1', ''], ['Pay $5 and $10 now', String.raw`Costs $\sqrt[3]{h}$ now`, '', '2026-10-01'],
  ]);
  assert.equal(querySmd(text, 'decision')[0].title, String.raw`Use $\sqrt[3]{d}$ here`);
  assert.equal(getDocumentInfo(text, { today: TODAY }).decisions[0].title, String.raw`Use $\sqrt[3]{d}$ here`);
});

/** What the checks of text report when it is text: a link, a reference, a footnote, a figure, an image, attributes, directives, a variable. */
const CHECKED = '[x](#nope) [y][nope-ref] [^nope-fn] :ref[nope-fig] ![i](missing.png) [a]{color=nope} :badg[typo] :priority[P9] {{nope}}';
const CHECKED_CODES = [
  'link/missing-anchor', 'link/undefined-reference', 'footnote/undefined', 'figure/unknown-ref', 'link/missing-file', 'attrs/value', 'directive/unknown', 'attrs/value',
  'variable/undefined',
];
const HEAD = ['---', 'smd: 1', 'title: V', '---', ''];
const found = (text: string) => validateSmd(text, { today: TODAY, fileExists: () => false }).map((d) => `${d.line}:${d.code}`);

test('validation reports nothing inside indented code or math, where nothing is syntax', () => {
  const literal = [
    ...HEAD, 'Code:', '', `    ${CHECKED}`, '    - [ ] task :due[2020-01-01]', '', '- item', '', `      ${CHECKED}`, '',
    ':::note', `    ${CHECKED}`, ':::', '', String.raw`Math $${CHECKED} \sqrt[3]{x}$ and $\sqrt[3]{y}$ end.`, '',
    '$$', String.raw`\text{[a]{color=nope} :ref[nope-fig] :badg[typo]}`, '$$',
  ].join('\n');
  const html = renderSmd(literal).html;
  assert.equal(html.match(/<code>/g)?.length, 3);
  assert.doesNotMatch(html, /smd-badge|<a |<img |smd-span/);
  assert.deepEqual(found(literal), []);

  // The same in text is reported as before: also on a four-space line that continues a paragraph, and around math.
  const text = [
    ...HEAD, `Text ${CHECKED}`, '', 'Paragraph', `    ${CHECKED}`, '', '- [ ] task :due[2020-01-01]', '',
    'Ref [text $x$][nope-ref] and $y$ [b]{color=nope} $z$ [c]{color=nope}.',
  ].join('\n');
  assert.deepEqual(found(text), [
    ...CHECKED_CODES.map((code) => `5:${code}`), ...CHECKED_CODES.map((code) => `8:${code}`), '10:task/overdue',
    '12:link/undefined-reference', '12:attrs/value', '12:attrs/value',
  ]);
});

test('tasks, meta, query and issue sync read no task in indented code, as in fenced code', () => {
  const text = [
    ...HEAD, '## Plan', '', '- [ ] real :due[2020-01-01]', '    - [x] nested, four spaces in', '', 'Example:', '', '    - [ ] in code acme/shop#1', '    - [x] done in code', '',
    '- item', '', '      - [ ] code in a list', '', '```', '- [ ] fenced', '```',
  ].join('\n');
  assert.equal(renderSmd(text).html.match(/<code>/g)?.length, 3);
  const tasks = ['7:real', '8:nested, four spaces in'];
  assert.deepEqual(extractTasks(text, TODAY).map((t) => `${t.line}:${t.text}`), tasks);
  const info = getDocumentInfo(text, { today: TODAY });
  assert.deepEqual([info.tasks.total, info.tasks.done, info.tasks.open.length], [2, 1, 1]);
  assert.deepEqual(querySmd(text, 'task').map((m) => `${m.line}:${m.title}`), tasks);
  assert.deepEqual(issueTasks(text, TODAY).map((t) => `${t.line}:${t.text}`), tasks);
  // The line of code names an issue; a sync neither reads nor creates anything for it.
  assert.deepEqual(planIssueSync(issueTasks(text, TODAY), new Map(), { create: true }).actions.map((a) => [a.kind, a.task.line]), [['create', 7]]);
  assert.deepEqual(found(text).filter((d) => d.endsWith('task/overdue')), ['7:task/overdue']);
});

test('outlines and the token budget count the open tasks smd tasks lists: none in fenced or indented code', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  const text = [
    ...HEAD, '## Plan', '', '- [ ] real', '', 'Example:', '', '    - [ ] in indented code', '', '```', '- [ ] fenced', '```', '',
    '- item', '', '      - [ ] code in a list', '',
    '## Notes', '', '```', ...Array.from({ length: 12 }, (_, i) => `- [ ] fenced ${i} ${words(4)}`), '```', '', '    - [ ] indented only', '',
    '## Other', '', words(60), '',
  ].join('\n');
  assert.deepEqual(extractTasks(text, TODAY).filter((t) => !t.done).map((t) => t.line), [7]);
  const o = outline(text, { today: TODAY });
  assert.match(o, /## Plan\s+≈\d+\s+1 open task\n/);
  assert.doesNotMatch(o, /## (?:Notes|Other).*open task/);
  // Over the budget, a section whose only task-shaped lines are code is no more important than any other: the larger goes first.
  const full = agentView(text, { today: TODAY }).tokens;
  const budget = agentView(text, { today: TODAY, maxTokens: full - 1 }).budget!;
  assert.deepEqual(budget.omitted.map((s) => s.heading), ['Notes']);
});

test('outline notes read code and display math as written: a container or Mermaid line there marks nothing', () => {
  const marks = [':::agent', ':::api GET /x', ':::decision{status=accepted} Use Y', ':::risk', ':::question', ':::warning'];
  const text = [
    ...HEAD, '## Real', '', '```mermaid', 'graph TD', '  A --> B', '```', '', ':::decision{status=accepted} Use X', 'Body.', ':::', '',
    '## Examples', '', '````md', '```mermaid', 'graph TD', '```', ...marks, '````', '', 'Indented:', '', ...marks.map((m) => `    ${m}`), '',
    '$$', ...marks, '$$', '', '    ```mermaid', '    graph TD', '',
  ].join('\n');
  // As rendered: one diagram and one decision, in the first section; the rest is code and math.
  const html = renderSmd(text).html;
  assert.equal(html.match(/class="smd-diagram"/g)?.length, 1);
  assert.equal(html.match(/class="smd-decision /g)?.length, 1);
  assert.doesNotMatch(html, /smd-agent|smd-api|smd-risk|smd-question|smd-callout/);
  const o = outline(text, { today: TODAY });
  assert.match(o, /## Real\s+≈\d+\s+diagram, decision\n/);
  assert.match(o, /## Examples\s+≈\d+\n/);
  // A diagram is a fence that opens: not one in other code, nor indented code that looks like a fence.
  assert.deepEqual([...fenceLines(text)], [7, 18]);
});

test('the token budget reads code and display math as written: a container line there neither pins a section nor keeps it longer', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  const text = [
    ...HEAD, '## Pinned', '', words(80), '', '```', ':::agent', '```', '',
    '## Callouts', '', words(40), '', '    :::warning', '', '$$', ':::decision{status=accepted} Use Y', '$$', '',
    '## Plain', '', words(20), '',
  ].join('\n');
  const full = agentView(text, { today: TODAY }).tokens;
  // The largest goes first: `:::agent` in code is no instruction, and the callouts are code and math.
  assert.deepEqual(agentView(text, { today: TODAY, maxTokens: full - 1 }).budget!.omitted.map((s) => s.heading), ['Pinned']);
  const two = agentView(text, { today: TODAY, maxTokens: full - 150 }).budget!.omitted.map((s) => s.heading);
  assert.deepEqual(two, ['Pinned', 'Callouts']);
});

test('inline math that runs on to the next line is math to the views and to validation, as it renders', () => {
  const text = [
    ...HEAD, 'The cost $a + ==x== :badge[y]{color=nope}', 'b {{nope}} [r](nope.smd)$ grows ==z==', '', '- item $a', '  :due[bad] b$ ok', '',
    '> q $x +', '> [c]{color=nope} y$ z', '', 'Pay $5 and', '$10 ==m== [d]{color=nope}',
  ].join('\n');
  const html = renderSmd(text).html;
  assert.equal(html.match(/class="katex"/g)?.length, 3);
  assert.doesNotMatch(html, /smd-badge|smd-due|<a /);
  assert.match(html, /grows <mark>z<\/mark>[\s\S]*\$10 <mark>m<\/mark>/);
  // Math is kept as written on both lines; the text around it converts.
  for (const view of [agentView(text).text, smdToMarkdown(text)]) {
    assert.ok(view.includes('The cost $a + ==x== :badge[y]{color=nope}\nb {{nope}} [r](nope.smd)$ grows '), view);
    assert.ok(view.includes('- item $a\n  :due[bad] b$ ok'), view);
    assert.ok(view.includes('> q $x +\n> [c]{color=nope} y$ z'), view);
    assert.doesNotMatch(view, /==z==|==m==/);
  }
  // Only the attribute list after the money is text.
  assert.deepEqual(found(text), ['15:attrs/value']);
});

test('a `$$` line in indented code opens no math: no false math/unclosed, and the lines after it are checked', () => {
  const text = [...HEAD, 'Example:', '', '    $$', '    x', '', 'Text [a]{color=nope}', '', '$$', 'y^2', '$$'].join('\n');
  const html = renderSmd(text).html;
  assert.equal(html.match(/<code>/g)?.length, 1);
  assert.equal(html.match(/class="katex-display"/g)?.length, 1);
  assert.deepEqual(found(text), ['10:attrs/value']);
});

test('a `$$` line in indented code hides no {{name}} after it from the variable checks', () => {
  const text = ['---', 'smd: 1', 'title: V', 'release: "2.0"', '---', '', 'Example:', '', '    $$', '    x', '', 'Version {{release}}, not {{relase}}.'].join('\n');
  assert.match(renderSmd(text).html, /Version 2\.0, not \{\{relase\}\}\./);
  // `release` is shown, so it is no unknown key; `{{relase}}` is undefined.
  assert.deepEqual(found(text), ['11:variable/undefined']);
});

test('outline lists sections with costs and markers', () => {
  const o = outline(prd, { today: TODAY });
  assert.match(o, /^Checkout Redesign — One-Page Checkout · approved · file ≈\d+ tokens/);
  assert.match(o, /L21-38\s+## Background\s+≈\d+\s+skipped for agents/);
  assert.match(o, /## Requirements\s+≈\d+\s+7 open tasks/);
  assert.match(o, /## Implementation notes\s+≈\d+\s+AGENT INSTRUCTIONS/);
  assert.ok(o.length / 4 < 400, 'outline stays small');
});

// ---------------------------------------------------------------------------
// Tasks, meta and conversion
// ---------------------------------------------------------------------------

test('tasks carry owner, priority, due date and section', () => {
  const tasks = extractTasks(prd, TODAY).filter((t) => !t.done);
  const idem = tasks.find((t) => t.text.startsWith('Idempotent order creation'))!;
  assert.deepEqual(idem.assignees, ['@api-team']);
  assert.equal(idem.priority, 'P0');
  assert.equal(idem.due, '2026-10-03');
  assert.equal(idem.overdue, false);
  assert.equal(idem.section, 'Requirements');
  assert.equal(tasks.find((t) => t.due === '2026-09-25')!.overdue, true);
});

test('meta includes decisions and risks', () => {
  const info = getDocumentInfo(prd, { today: TODAY });
  assert.deepEqual(info.decisions.map((d) => d.status), ['accepted', 'accepted', 'rejected']);
  assert.equal(info.risks[0].impact, 'high');
  assert.equal(info.outline.find((h) => h.text === 'Background')?.agent, 'skip');
});

test('plain Markdown fallbacks for new syntax', () => {
  const md = smdToMarkdown([
    '## Background {agent=skip}',
    ':::decision{status=accepted owner=@a} Use X', 'Why', ':::',
    ':::risk{impact=high} Y', ':::',
    ':::api{method=GET path="/v1/y"} Get Y', ':::',
    '- [ ] Task :priority[P1] :due[2026-10-01] :metric[5]{label=Bugs}',
    '```ts file="src/a.ts" lines="1-1" {1}', '```',
  ].join('\n'), { readFile: () => 'const a = 1;\nconst b = 2;\n' });
  assert.match(md, /^## Background$/m);
  assert.match(md, /> \[!NOTE\]\n> \*\*Decision \(accepted · @a\): Use X\*\*/);
  assert.match(md, /> \[!CAUTION\]\n> \*\*Risk \(impact high\): Y\*\*/);
  assert.match(md, /\*\*`GET \/v1\/y`\*\* — Get Y/);
  assert.match(md, /\*\*P1\*\* 📅 2026-10-01 \*\*5\*\* Bugs/);
  assert.match(md, /\[`src\/a.ts`\]\(src\/a.ts#L1-L1\)\n\n```ts\nconst a = 1;\n```/);
});

test('plain Markdown leaves indented code and display math as written', () => {
  const md = smdToMarkdown(AS_WRITTEN);
  has(md, 'Text `top` **mark** red.');
  has(md, '    code :badge[x] ==mark== [text]{color=red} ![alt](a.png) :ref[fig-a]');
  // Four spaces that continue a paragraph or a list item are text, and still convert.
  has(md, 'Paragraph', '    continued `lazy` **m**');
  has(md, '- item', '    more `item`', '', '        nested :kbd[Ctrl] ==mark==');
  has(md, '> **Title `t`**', '>', '>     first :badge[c] ==mark==');
  has(md, '$$', String.raw`\sqrt[3]{x} ==m== :badge[b]`, '$$', '', String.raw`$$\sqrt[3]{y} ==m==$$`);
  // In included text too.
  has(smdToMarkdown(AS_WRITTEN_INCLUDING, { readFile: asWrittenFile }),
    'Before `b`.', '', '<!-- included from part.smd -->', 'Included `inc`.', '', '    inc code :badge[x] ==mark== [text]{color=red}', '',
    '$$', String.raw`\sqrt[3]{z} ==m==`, '$$', '', 'Para', '    lazy `inc-lazy`');
});

// ---------------------------------------------------------------------------
// CLI (requires `npm run build`)
// ---------------------------------------------------------------------------

const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: skills install writes both self-contained skills', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-skill-'));
  execFileSync(process.execPath, [cli, 'skills', 'install', '--dir', dir]);
  const reader = join(dir, 'styled-markdown-reader');
  const writer = join(dir, 'styled-markdown-writer');
  assert.match(readFileSync(join(reader, 'SKILL.md'), 'utf8'), /^---\r?\nname: styled-markdown-reader\r?\n/);
  assert.match(readFileSync(join(writer, 'SKILL.md'), 'utf8'), /^---\r?\nname: styled-markdown-writer\r?\n/);
  for (const f of ['references/syntax.md', 'references/style-guide.md', 'assets/templates/prd.smd', 'scripts/smd.cjs']) {
    assert.ok(existsSync(join(writer, f)), f);
  }
  const out = execFileSync(process.execPath, [join(reader, 'scripts', 'smd.cjs'), 'outline', join(__dirname, '..', '..', 'examples', 'feature-spec.smd')], { encoding: 'utf8' });
  assert.match(out, /Saved Searches · review/);
});

test('every template produces a valid document', () => {
  const dir = join(__dirname, '..', '..', 'skills', 'styled-markdown-writer', 'assets', 'templates');
  const names = readdirSync(dir);
  assert.equal(names.length, 16);
  for (const name of names) {
    const doc = fillTemplate(readFileSync(join(dir, name), 'utf8'), 'Example', TODAY);
    const problems = validateSmd(doc, { today: TODAY }).filter((d) => d.severity === 'error' || d.severity === 'warning');
    assert.deepEqual(problems, [], name);
  }
});
