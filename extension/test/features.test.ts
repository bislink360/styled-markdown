import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentView, extractTasks, getDocumentInfo, outline, renderSmd, smdToMarkdown, validateSmd,
} from '../src/core';
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
  assert.equal(names.length, 13);
  for (const name of names) {
    const doc = fillTemplate(readFileSync(join(dir, name), 'utf8'), 'Example', TODAY);
    const problems = validateSmd(doc, { today: TODAY }).filter((d) => d.severity === 'error' || d.severity === 'warning');
    assert.deepEqual(problems, [], name);
  }
});
