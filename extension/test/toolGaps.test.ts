import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentView, extractTasks, getDocumentInfo, outline, renderSmd, smdToMarkdown, validateSmd } from '../src/core';
import { openTaskLines } from '../src/core/taskLines';

/**
 * Tool fixes of 1.10 (the spec v2 RFC's "Not proposed" list): the tools read documents as the renderer does.
 * - a task-shaped line that continues a paragraph is text, not a task
 * - an inline directive or styled span whose text runs over a line break reads as one item
 */

const corpusDir = join(__dirname, 'compat', 'corpus');
const examplesDir = join(__dirname, '..', '..', 'examples');
const corpus = (name: string) => readFileSync(join(corpusDir, name), 'utf8');
const TODAY = '2026-10-15';
const view = (src: string, options: Parameters<typeof agentView>[1] = {}) => agentView(src, { today: TODAY, ...options }).text.trim();
const taskLines = (src: string) => extractTasks(src, TODAY).map((t) => t.line);
/** The zero-based lines rendering shows a checkbox on. */
const renderedTasks = (src: string) => [...renderSmd(src, { today: TODAY }).html.matchAll(/data-task-line="(\d+)"/g)].map((m) => Number(m[1]));
const codes = (src: string) => validateSmd(src, { today: TODAY }).map((d) => `${d.line}:${d.code}`);

// ---------------------------------------------------------------------------
// Task lines
// ---------------------------------------------------------------------------

test('tasks: a task-shaped line that continues a paragraph is text, as in rendering', () => {
  // Indented four columns after a paragraph: lazy continuation, not a list item.
  assert.deepEqual(taskLines('foo\n    - [ ] x\n'), []);
  assert.deepEqual(renderedTasks('foo\n    - [ ] x\n'), []);
  // An ordered item other than 1 can't interrupt a paragraph; 1 and bullets can.
  assert.deepEqual(taskLines('foo\n2. [ ] x\n'), []);
  assert.deepEqual(taskLines('foo\n1. [ ] x\n'), [1]);
  assert.deepEqual(taskLines('foo\n- [ ] x\n'), [1]);
  // Past an item's content column by four or more: text of the item.
  assert.deepEqual(taskLines('- an item\n      - [ ] x\n'), []);
  assert.deepEqual(taskLines('- [ ] a\n    - [ ] b\n  - [x] c\n'), [0, 1, 2]);
  // A task needs text.
  assert.deepEqual(taskLines('- [ ]   \n- [ ] x\n'), [1]);
});

test('tasks: raw HTML, comments and display math hold no tasks, as in rendering', () => {
  assert.deepEqual(taskLines('<!--\n\n- [ ] hidden\n\n-->\n\n- [ ] shown\n'), [6]);
  assert.deepEqual(taskLines('<div>\n- [ ] html\n</div>\n\n- [ ] shown\n'), [4]);
  assert.deepEqual(taskLines('$$\n- [ ] math\n$$\n\n- [ ] shown\n'), [4]);
});

test('tasks: what rendering shows as tasks stays a task (containers, nesting, ordered, headings, front matter, code)', () => {
  const doc = [
    '---', 'smd: 1', 'title: T', '---', '', '## Plan', '', ':::warning Ship', '- [ ] in a callout', ':::', '', '1. [x] ordered', '2. [ ] second',
    '', '```text', '- [ ] code', '```', '', '    - [ ] indented code', '', '## Later', '- [ ] after a heading',
  ].join('\n');
  const tasks = extractTasks(doc, TODAY);
  assert.deepEqual(tasks.map((t) => [t.line, t.section, t.done]), [[8, 'Plan', false], [11, 'Plan', true], [12, 'Plan', false], [21, 'Later', false]]);
  assert.deepEqual(tasks.map((t) => t.line), renderedTasks(doc));
});

test('tasks: smd tasks, meta, the outline, the budget and the validator agree on the corpus document', () => {
  const doc = corpus('task-lines.smd');
  const lines = taskLines(doc);
  assert.deepEqual(lines, renderedTasks(doc));
  assert.deepEqual(lines.map((l) => l + 1), [11, 12, 14, 16, 17, 21, 22, 23, 25, 30, 31, 36, 39, 64]);
  assert.equal(getDocumentInfo(doc, { today: TODAY }).tasks.total, 14);
  assert.deepEqual(openTaskLines(doc), extractTasks(doc, TODAY).filter((t) => !t.done).map((t) => t.line));
  // The lines that continue paragraphs are not open tasks in the outline either.
  const sections = outline(doc, { today: TODAY }).split('\n');
  assert.doesNotMatch(sections.find((l) => l.includes('## Task lines that are text')) ?? '', /open task/);
  assert.match(sections.find((l) => l.includes('## Plain tasks')) ?? '', /3 open tasks/);
});

test('tasks: the agent view and the overdue check skip task-shaped text', () => {
  const doc = 'Done so far:\n    - [x] continues the paragraph\n\nNext:\n2. [ ] due :due[2020-01-01]\n\n- [ ] real :due[2020-01-01]\n';
  // The brief view omits completed tasks; text that looks like one stays.
  assert.match(view(doc, { brief: true }), /continues the paragraph/);
  assert.deepEqual(codes(doc).filter((c) => c.endsWith('task/overdue')), ['6:task/overdue']);
  assert.doesNotMatch(view(doc), /due 2020-01-01, OVERDUE\)\n\n- \[ \] real/);
  assert.match(view(doc), /- \[ \] real \(due 2020-01-01, OVERDUE\)/);
});

test('tasks: the scan agrees with rendering on every example and corpus document', () => {
  const files = [
    ...readdirSync(examplesDir).filter((f) => f.endsWith('.smd')).map((f) => join(examplesDir, f)),
    ...readdirSync(corpusDir).filter((f) => f.endsWith('.smd')).map((f) => join(corpusDir, f)),
  ];
  for (const file of files) {
    const doc = readFileSync(file, 'utf8');
    const lines = doc.split(/\r?\n/);
    // Tasks in quotes render with checkboxes but were never listed: the scan reads list lines only.
    const rendered = renderedTasks(doc).filter((l) => !/^\s*>/.test(lines[l]));
    assert.deepEqual(taskLines(doc), rendered, file);
  }
});

// ---------------------------------------------------------------------------
// Inline items across line breaks
// ---------------------------------------------------------------------------

test('inline items across line breaks: the agent view reads them whole, as rendering does', () => {
  assert.equal(view('The :badge[foo\nbar]{color=green} build.\n'), 'The [foo\nbar] build.');
  assert.equal(view('Is :status[on\ntrack]{color=green}.\n'), 'Is [status: on\ntrack (ok)].');
  assert.equal(view('This is [styled\ntext]{color=red} here.\n'), 'This is styled\ntext here.');
  assert.equal(view('A ==marked\nphrase== here.\n'), 'A marked\nphrase here.');
  assert.equal(view('- A :badge[list\n  item]{color=blue} badge\n'), '- A [list\n  item] badge');
  assert.equal(view('> A :badge[quoted\n> badge]{color=blue}\n'), '> A [quoted\n> badge]');
  // Math inside an item stays as written.
  assert.equal(view('M :badge[about\n$m_0$]{color=teal} at rest.\n'), 'M [about\n$m_0$] at rest.');
  // A name without brackets or attributes is text, as in rendering.
  assert.equal(view('A lone :badge[ stays text, and :badge alone too.\n'), 'A lone :badge[ stays text, and :badge alone too.');
});

test('inline items across line breaks: to-md converts them whole', () => {
  const md = (src: string) => smdToMarkdown(src).trim();
  assert.equal(md('The :badge[foo\nbar]{color=green} build.\n'), 'The `foo\nbar` build.');
  assert.equal(md('Is :status[on\ntrack]{color=green}.\n'), 'Is 🟢 on\ntrack.');
  assert.equal(md('This is [styled\ntext]{weight=bold} here.\n'), 'This is **styled\ntext** here.');
  assert.equal(md('A lone :badge[ stays text.\n'), 'A lone :badge[ stays text.');
});

test('inline items across line breaks: the validator checks a directive\'s attributes whole', () => {
  const diags = validateSmd('The :badge[foo\nbar]{colr=green} and :progress[a\nb]{value=200}.\n');
  assert.deepEqual(diags.map((d) => [d.line, d.code, d.severity]), [[1, 'attrs/unknown', 'warning'], [2, 'attrs/value', 'error']]);
  assert.match(diags[0].message, /":badge" does not take "colr"/);
  assert.deepEqual(diags[0].fix && { line: diags[0].fix.line, column: diags[0].fix.column, replacement: diags[0].fix.replacement }, { line: 1, column: 5, replacement: 'color' });
  // The attribute list ends a directive, not a styled span.
  assert.deepEqual(validateSmd('A :progress[half\nway]{value=50} done.\n'), []);
  assert.deepEqual(validateSmd('A :badge[x\ny]{color=gren}.\n').map((d) => d.message), ['Invalid color "gren".']);
});

test('inline items across line breaks: the corpus document', () => {
  const doc = corpus('inline-line-breaks.smd');
  const text = view(doc);
  assert.doesNotMatch(text, /\[\]|\]\{/);
  assert.match(text, /The build is \[green on\nevery branch\] today\./);
  const md = smdToMarkdown(doc);
  assert.doesNotMatch(md, /``|\]\{/);
  assert.match(md, /The build is `green on\nevery branch` today\./);
  assert.deepEqual(validateSmd(doc), []);
});
