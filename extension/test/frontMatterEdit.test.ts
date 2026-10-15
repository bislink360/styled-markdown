import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRONT_MATTER_FIELDS, frontMatterFields, isFrontMatterRefusal, readFrontMatterBlock, setFrontMatterValue, yamlText, type FrontMatterValue,
} from '../src/core/frontMatterEdit';
import { parseFrontMatter } from '../src/core/frontmatter';
import { applyLineEdits } from '../src/core/sourceEdit';
import { prng } from './fuzz/generate';

// Front matter edited one key at a time (src/core/frontMatterEdit.ts): only that key's lines change, comments, order
// and quoting stay, and YAML the line-based approach can't edit safely is refused.

const FM = [
  '---',
  'title: "Plan: Q4"   # the title',
  'summary: \'It\'\'s fine\'',
  'status: drafty',
  '# who owns it',
  'owners:',
  '  - "@maya"',
  '  - "@api"',
  'tags: [a, "b c"]',
  'version: 1.4',
  'updated: 2026-10-01',
  'toc: true',
  'custom: {a: 1}',
  'notes: |',
  '  long',
  '  text',
  '---',
];

function set(lines: readonly string[], key: string, value: FrontMatterValue): string[] {
  const edits = setFrontMatterValue(lines, key, value);
  assert.ok(!isFrontMatterRefusal(edits), `${key}: ${JSON.stringify(edits)}`);
  return applyLineEdits(lines, edits);
}

const data = (lines: readonly string[]) => parseFrontMatter(`${lines.join('\n')}\n`).data;

test('readFrontMatterBlock: each key, its lines and how its value is written', () => {
  const block = readFrontMatterBlock(FM);
  assert.ok(!isFrontMatterRefusal(block));
  assert.equal(block.close, 16);
  const by = Object.fromEntries(block.entries.map((e) => [e.key, e]));
  assert.deepEqual([by.title.style, by.title.quote, by.title.span], ['plain', 'double', { start: 7, end: 17 }]);
  assert.equal(by.summary.quote, 'single');
  assert.deepEqual([by.owners.style, by.owners.line, by.owners.end, by.owners.items?.length], ['block', 5, 8, 2]);
  assert.equal(by.tags.style, 'flow');
  assert.equal(by.custom.refused, 'a flow mapping ({…})');
  assert.equal(by.notes.refused, 'a block scalar (| or >)');
  assert.deepEqual([by.notes.line, by.notes.end], [13, 16]);
});

test('readFrontMatterBlock refuses YAML the form can\'t edit safely', () => {
  const cases: [string[], RegExp][] = [
    [['---', 'a: &x 1', 'b: *x', '---'], /anchors, aliases or tags/],
    [['---', 'a: !!str 1', '---'], /anchors, aliases or tags/],
    [['---', 'tags: [&x a, *x]', '---'], /anchors, aliases or tags/],
    [['---', 'owners:', '  - *x', '---'], /anchors, aliases or tags|not valid/],
    [['---', '"title": x', '---'], /a key the form can't read/],
    [['---', '? title', ': x', '---'], /a key the form can't read/],
    [['---', 'title: x', 'title: y', '---'], /not valid YAML/],
    [['---', 'title: [unclosed', '---'], /not valid YAML/],
    [['---', 'title: x'], /not closed/],
  ];
  for (const [lines, reason] of cases) {
    const block = readFrontMatterBlock(lines);
    assert.ok(isFrontMatterRefusal(block), JSON.stringify(lines));
    assert.match(block.refused, reason, JSON.stringify(lines));
    assert.ok(isFrontMatterRefusal(frontMatterFields(lines)));
  }
  // `*` inside a value is text, not an alias.
  assert.ok(!isFrontMatterRefusal(readFrontMatterBlock(['---', 'summary: The *new* checkout', '---'])));
});

test('setFrontMatterValue changes only the value, keeping quotes and comments', () => {
  assert.deepEqual(set(FM, 'title', 'Plan: Q5')[1], 'title: "Plan: Q5"   # the title');
  assert.deepEqual(set(FM, 'summary', 'It\'s great')[2], 'summary: \'It\'\'s great\'');
  assert.deepEqual(set(FM, 'status', 'draft')[3], 'status: draft');
  assert.deepEqual(set(FM, 'updated', '2026-10-15')[10], 'updated: 2026-10-15');
  assert.deepEqual(set(FM, 'toc', 'false')[11], 'toc: false');
  assert.deepEqual(set(FM, 'version', '2.0.1')[9], 'version: 2.0.1');
  assert.deepEqual(set(FM, 'version', '1.10')[9], 'version: "1.10"', 'a number that would read back as 1.1 is quoted');
  assert.deepEqual(set(['---', 'title: Plain', '---'], 'title', '2026')[1], 'title: "2026"', 'text that would read as a number');
  assert.deepEqual(set(['---', 'title: Plain', '---'], 'title', 'a: b')[1], 'title: "a: b"');
  assert.deepEqual(set(['---', 'title: Plain', '---'], 'title', 'New title')[1], 'title: New title');
  assert.deepEqual(set(['---', 'title:   # later', '---'], 'title', 'Now')[1], 'title: Now   # later', 'an empty value');
});

test('setFrontMatterValue: lists keep their style; unchanged items keep their text', () => {
  assert.deepEqual(set(FM, 'owners', ['@maya', '@new']).slice(5, 9), ['owners:', '  - "@maya"', '  - "@new"', 'tags: [a, "b c"]']);
  assert.deepEqual(set(FM, 'owners', ['@api']).slice(5, 8), ['owners:', '  - "@api"', 'tags: [a, "b c"]']);
  assert.deepEqual(set(FM, 'tags', ['a', 'b c', 'd'])[8], 'tags: [a, "b c", d]');
  assert.deepEqual(set(FM, 'tags', ['@x'])[8], 'tags: ["@x"]', 'an item that needs quotes');
  assert.deepEqual(set(['---', 'tags: a, b', '---'], 'tags', ['a', 'b', 'c'])[1], 'tags: a, b, c', 'a list written as text');
  assert.deepEqual(set(['---', 'tags:', '---'], 'tags', ['x'])[1], 'tags: [x]');
});

test('setFrontMatterValue: a new key goes before the closing ---; null removes a key and its lines', () => {
  const added = set(FM, 'theme', 'dark');
  assert.deepEqual(added.slice(-2), ['theme: dark', '---']);
  assert.deepEqual(set(FM, 'related', ['x.smd', 'https://example.com/a b'])[16], 'related: [x.smd, https://example.com/a b]');
  assert.deepEqual(set(FM, 'smd', '1')[16], 'smd: 1');
  assert.equal(data(set(FM, 'smd', '1')).smd, 1);
  const removed = set(FM, 'owners', null);
  assert.deepEqual(removed.slice(3, 6), ['status: drafty', '# who owns it', 'tags: [a, "b c"]'], 'the comment above stays');
  assert.deepEqual(setFrontMatterValue(FM, 'lang', null), [], 'removing a key that is not there: nothing');
  assert.deepEqual(setFrontMatterValue(FM, 'status', 'drafty'), [], 'the same value: nothing');
  assert.deepEqual(set(['---', '---'], 'title', 'First'), ['---', 'title: First', '---']);
});

test('setFrontMatterValue refuses keys written as YAML it can\'t edit, and values that would not read back', () => {
  const refused = (lines: readonly string[], key: string, value: FrontMatterValue) => {
    const r = setFrontMatterValue(lines, key, value);
    assert.ok(isFrontMatterRefusal(r), `${key}: ${JSON.stringify(r)}`);
    return r.refused;
  };
  assert.match(refused(FM, 'notes', 'x'), /block scalar/);
  assert.match(refused(FM, 'custom', 'x'), /flow mapping/);
  assert.match(refused(['---', 'summary: one', '  two', '---'], 'summary', 'x'), /several lines/);
  assert.match(refused(['---', 'summary: "one', '  two"', '---'], 'summary', 'x'), /several lines/);
  assert.match(refused(['---', 'tags: [a, [b]]', '---'], 'tags', ['a']), /nested/);
  assert.match(refused(['---', 'owners:', '  - a', '    - b', '---'], 'owners', ['a']), /several lines|not valid/);
  assert.match(refused(['---', 'toc: true', '---'], 'toc', 'maybe'), /can't be written/, 'not a boolean');
  assert.match(refused(['---', 'a: &x 1', '---'], 'title', 'x'), /anchors/);
  // The other keys of a front matter with a block scalar can still be edited.
  assert.equal(set(FM, 'title', 'Fine')[1], 'title: "Fine"   # the title');
});

test('yamlText: plain only when it reads back as the same text', () => {
  assert.equal(yamlText('plain text', 'plain'), 'plain text');
  assert.equal(yamlText('true', 'plain'), '"true"');
  assert.equal(yamlText('null', 'plain'), '"null"');
  assert.equal(yamlText('#tag', 'plain'), '"#tag"');
  assert.equal(yamlText(' lead', 'plain'), '" lead"');
  assert.equal(yamlText('a "q"', 'double'), '"a \\"q\\""');
  assert.equal(yamlText('it\'s', 'single'), '\'it\'\'s\'');
  assert.equal(yamlText('b, c', 'plain', new Set(['string']), true), '"b, c"', 'a comma in a flow list');
});

test('frontMatterFields: every known key, with its value, kind and choices; refused ones say why', () => {
  const fields = frontMatterFields(FM);
  assert.ok(!isFrontMatterRefusal(fields));
  assert.deepEqual(fields.map((f) => f.name), FRONT_MATTER_FIELDS);
  const by = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.deepEqual([by.title.kind, by.title.value], ['text', 'Plan: Q4']);
  assert.deepEqual([by.status.kind, by.status.options?.at(-1)], ['select', 'drafty'], 'a value not among the choices stays one');
  assert.deepEqual([by.owners.kind, by.owners.value], ['list', '@maya, @api']);
  assert.deepEqual([by.updated.kind, by.created.kind, by.created.value], ['date', 'date', '']);
  assert.deepEqual(by.toc.options, ['', 'true', 'false']);
  assert.deepEqual(by.smd.options, ['', '1']);
  const loose = frontMatterFields(['---', 'updated: next week', '---']);
  assert.ok(!isFrontMatterRefusal(loose));
  assert.equal(loose.find((f) => f.name === 'updated')?.kind, 'text', 'a date that is not YYYY-MM-DD');
  const refusedField = frontMatterFields(['---', 'title: |', '  Long', '---']);
  assert.ok(!isFrontMatterRefusal(refusedField));
  assert.equal(refusedField.find((f) => f.name === 'title')?.refused, 'a block scalar (| or >)');
  const comma = frontMatterFields(['---', 'tags: ["a, b"]', '---']);
  assert.ok(!isFrontMatterRefusal(comma));
  assert.equal(comma.find((f) => f.name === 'tags')?.refused, 'an item with a comma');
});

// ---------------------------------------------------------------------------
// Property: no unrelated line changes
// ---------------------------------------------------------------------------

const POOL: Record<string, string[][]> = {
  title: [['title: Plain title'], ['title: "Quoted: yes"'], ['title: \'Single\'   # c'], ['title:']],
  summary: [['summary: Short'], ['summary: >', '  folded', '  text']],
  status: [['status: draft'], ['status: "review"']],
  owners: [['owners: ["@a", "@b"]'], ['owners:', '  - "@a"', '  - b'], ['owners: "@solo"']],
  tags: [['tags: [x, y]'], ['tags:', '- one', '- two'], ['tags: a, b']],
  version: [['version: 1.2'], ['version: "2.0"']],
  updated: [['updated: 2026-01-02']],
  toc: [['toc: false']],
  custom: [['custom: {k: v}'], ['custom:', '  nested: 1'], ['custom: kept']],
};
const COMMENTS = ['# a comment', '', '  # indented comment'];
const VALUES: Record<string, FrontMatterValue[]> = {
  title: ['New', 'With: colon', '123', null, 'it\'s'],
  summary: ['One line', null],
  status: ['approved', 'draft', null],
  owners: [['@a'], ['@a', '@c', 'd e'], null],
  tags: [['x'], ['p', 'q', 'r'], null],
  version: ['3', '3.10', null],
  updated: ['2026-12-31', null],
  toc: ['true', null],
  theme: ['dark', null],
  lang: ['de', 'pt-BR'],
  related: [['a.smd']],
  smd: ['1'],
};

test('property: setting a key changes only its own lines (or adds one before ---), and every other key reads the same', () => {
  const random = prng(19);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  let applied = 0;
  let refusals = 0;
  for (let run = 0; run < 400; run++) {
    const keys = Object.keys(POOL).filter(() => random() < 0.6);
    const lines = ['---'];
    for (const key of keys) {
      if (random() < 0.3) lines.push(pick(COMMENTS));
      lines.push(...pick(POOL[key]));
    }
    lines.push('---');
    const key = pick(Object.keys(VALUES));
    const value = pick(VALUES[key]);
    const result = setFrontMatterValue(lines, key, value);
    if (isFrontMatterRefusal(result)) {
      refusals++;
      continue;
    }
    applied++;
    const after = applyLineEdits(lines, result);
    const block = readFrontMatterBlock(lines);
    assert.ok(!isFrontMatterRefusal(block));
    const entry = block.entries.find((e) => e.key === key);
    const [start, end] = entry ? [entry.line, entry.end] : [block.close, block.close];
    const tail = lines.length - end;
    assert.deepEqual(after.slice(0, start), lines.slice(0, start), `above ${key}: ${JSON.stringify({ lines, value })}`);
    assert.deepEqual(after.slice(after.length - tail), lines.slice(end), `below ${key}: ${JSON.stringify({ lines, value })}`);
    const before = data(lines);
    const now = data(after);
    for (const k of new Set([...Object.keys(before), ...Object.keys(now)])) {
      if (k !== key) assert.deepEqual(now[k], before[k], `${k} unchanged`);
    }
    if (value === null) assert.ok(!Object.hasOwn(now, key));
    else assert.equal(Array.isArray(now[key]) || typeof now[key] === 'string' ? String(now[key]).replaceAll(', ', ',') : String(now[key]), String(value).replaceAll(', ', ','));
  }
  assert.ok(applied > 200, `applied ${applied}`);
  assert.ok(refusals > 5, `refused ${refusals}`);
});
