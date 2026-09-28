import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatSmd, renderSmd, validateSmd } from '../src/core';
import { formatAttrs } from '../src/core/format';

const examplesDir = path.join(__dirname, '..', '..', 'examples');
const examples = fs.readdirSync(examplesDir).filter((f) => f.endsWith('.smd'));

const fmt = (lines: string[]) => formatSmd(lines.join('\n')).split('\n').slice(0, -1);

/** Rendered HTML with the parts formatting may legitimately change (source lines, style order) normalized. */
function renderedMeaning(text: string): string {
  return renderSmd(text).html
    .replace(/ data-line="\d*"/g, '')
    .replace(/style="([^"]*)"/g, (_, css: string) => `style="${css.split(';').sort().join(';')}"`);
}

for (const file of examples) {
  test(`fmt keeps the meaning of examples/${file}`, () => {
    const text = fs.readFileSync(path.join(examplesDir, file), 'utf8');
    const formatted = formatSmd(text);
    assert.equal(formatSmd(formatted), formatted, 'formatting is idempotent');
    assert.equal(renderedMeaning(formatted), renderedMeaning(text));
    const codes = (t: string) => validateSmd(t, { today: '2026-09-27' }).map((d) => d.code).sort();
    assert.deepEqual(codes(formatted), codes(text));
  });
}

test('fmt: colons follow nesting depth, siblings share a count', () => {
  assert.deepEqual(fmt([
    ':::columns',
    ':::column',
    '::::::card Frontend',
    'Text',
    ':::::',
    ':::',
    ':::column',
    'Plain',
    ':::',
    ':::',
  ]), [
    ':::::columns',
    '::::column',
    ':::card Frontend',
    'Text',
    ':::',
    '::::',
    '::::column',
    'Plain',
    '::::',
    ':::::',
  ]);
  assert.deepEqual(fmt(['::::::note', 'Hi', '::::::']), [':::note', 'Hi', ':::']);
});

test('fmt: unbalanced containers keep their colons', () => {
  assert.deepEqual(fmt(['::::tabs', ':::tab A', 'x', ':::']), ['::::tabs', ':::tab A', 'x', ':::']);
  assert.deepEqual(fmt(['text', '', ':::', '', '::::::note', 'x', '::::::']), ['text', '', ':::', '', '::::::note', 'x', '::::::']);
});

test('fmt: container opening lines', () => {
  assert.deepEqual(fmt(['::: note   Title  ', 'x', ':::']), [':::note Title', 'x', ':::']);
  assert.deepEqual(fmt([':::warning{ collapsible   title=\'Heads up\' .wide #w1 }', 'x', ':::']),
    [':::warning{#w1 .wide title="Heads up" collapsible}', 'x', ':::']);
  // Malformed attribute lists are left exactly as written.
  assert.deepEqual(fmt([':::note{title="x}', 'x', ':::']), [':::note{title="x}', 'x', ':::']);
});

test('fmt: attribute order, quoting and duplicates', () => {
  assert.equal(formatAttrs('weight=bold color=red', []), 'color=red weight=bold');
  assert.equal(formatAttrs('owner=@maya status=accepted date=2026-09-12', ['status', 'date', 'owner']),
    'status=accepted date=2026-09-12 owner=@maya');
  assert.equal(formatAttrs('.a #x .b .a flag custom=1', []), '#x .a .b flag custom=1');
  assert.equal(formatAttrs('color=red color=blue', []), 'color=blue');
  assert.equal(formatAttrs("bg='#fef3c7' path=/v1 label=Activation delta=-3 width=50% say='\"hi\"'", []),
    'bg="#fef3c7" path="/v1" label="Activation" delta="-3" width=50% say=\'"hi"\'');
  assert.equal(formatAttrs('', []), '');
  assert.equal(formatAttrs('=oops', []), null);
});

test('fmt: inline and heading attributes, but never inside code', () => {
  assert.deepEqual(fmt(['Hi [x]{ weight=bold  color=red } and :badge[New]{ color="green" } `[y]{b=1 a=2}`']),
    ['Hi [x]{color=red weight=bold} and :badge[New]{color=green} `[y]{b=1 a=2}`']);
  assert.deepEqual(fmt(['## Title {  agent=skip #hist }  ']), ['## Title {#hist agent=skip}']);
  assert.deepEqual(fmt(['```js', 'const a = [x]{ b=1 };', '```']), ['```js', 'const a = [x]{ b=1 };', '```']);
});

test('fmt: tables are aligned', () => {
  assert.deepEqual(fmt([
    '|Name|Qty|Note|',
    '|:-|-:|:-:|',
    '|apple|3|ok|',
    '|kiwi \\| lime|12|',
  ]), [
    '| Name         | Qty | Note |',
    '| :----------- | --: | :--: |',
    '| apple        |   3 |  ok  |',
    '| kiwi \\| lime |  12 |      |',
  ]);
  // Wide characters count as two columns.
  assert.deepEqual(fmt(['| a | b |', '| - | - |', '| ✅ | 漢字 |']), ['| a   | b    |', '| --- | ---- |', '| ✅  | 漢字 |']);
});

test('fmt: tables that are not safe to touch are kept', () => {
  const pipeInCode = ['| a | b |', '| - | - |', '| `x|y` | z |'];
  assert.deepEqual(fmt(pipeInCode), pipeInCode);
  // Directly after paragraph text a table can't start, so no blank line is added to make one.
  const afterText = ['Some text', '| a | b |', '| - | - |'];
  assert.deepEqual(fmt(afterText), afterText);
});

test('fmt: blank lines around blocks', () => {
  assert.deepEqual(fmt([
    '# Title',
    'Intro.',
    ':::note',
    '```sh',
    'ls',
    '```',
    ':::',
    'After.',
    '',
    '',
    '',
    '## Next',
    '| a |',
    '| - |',
    '## Last',
  ]), [
    '# Title',
    '',
    'Intro.',
    '',
    ':::note',
    '```sh',
    'ls',
    '```',
    ':::',
    '',
    'After.',
    '',
    '## Next',
    '',
    '| a   |',
    '| --- |',
    '',
    '## Last',
  ]);
});

test('fmt: blank lines are kept where they carry meaning', () => {
  // Code blocks, indented code, HTML comments and list items are left alone.
  const cases = [
    ['```', 'a', '', '', 'b', '```'],
    ['Text', '', '    code', '', '', '    more code'],
    ['<!-- note -->', '# Heading'],
    ['- item', '  continued', '```', 'x', '```'],
  ];
  for (const c of cases) assert.deepEqual(fmt(c), c);
});

test('fmt: front matter, line endings and the final newline', () => {
  assert.equal(formatSmd('---\ntitle: A\n---\n# A\n\n\n'), '---\ntitle: A\n---\n\n# A\n');
  assert.equal(formatSmd('# A\r\nText\r\n'), '# A\r\n\r\nText\r\n');
  assert.equal(formatSmd(''), '');
  assert.equal(formatSmd('\n\n'), '');
});
