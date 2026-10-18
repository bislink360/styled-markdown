import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, formatSmd, renderSmd, smdToMarkdown, validateSmd } from '../src/core';
import { attrsToStyle, isStyleKey, parseAttrs } from '../src/core/attrs';
import { booleanValue } from '../src/core/fixes';
import { frontMatterProperty, frontMatterValues } from '../src/core/frontmatterSchema';
import { inlineOrder } from '../src/core/inlineEdit';
import { isKnownRule } from '../src/core/rules';
import { priorityRank } from '../src/core/util';
import { containerForm, inlineFields } from '../src/blockEditorSession';
import { completionsAt, hoverAt } from '../src/lspAssist';

/**
 * Vocabulary lookups read own entries only: `constructor`, `toString`, `__proto__`… are names every object inherits,
 * not containers, directives, values or rules.
 */

const PROTO_NAMES = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];
const html = (src: string) => renderSmd(src, { today: '2026-10-15' }).html;

test('own names: :::constructor and :::toString are unknown containers; :::__proto__ is no container at all', () => {
  const doc = ':::constructor Title\nBody\n:::\n\n:::toString\nx\n:::\n\n:::__proto__\nq\n:::\n';
  const diags = validateSmd(doc).map((d) => `${d.line}:${d.code}`);
  assert.deepEqual(diags, ['0:container/unknown', '4:container/unknown', '10:container/stray-close']);
  // Rendered as unknown containers: a box that keeps its title.
  assert.match(html(doc), /<div class="smd-box smd-box-constructor" data-line="0"><div class="smd-box-title">Title<\/div>/);
  assert.match(agentView(doc).text, /Title:\nBody/);
  const md = smdToMarkdown(doc);
  assert.match(md, /\*\*Title\*\*\n\nBody/);
  assert.doesNotMatch(md, /function|native code/);
  assert.equal(formatSmd(':::constructor{b=1 a=2} T\nx\n:::\n'), ':::constructor{b=1 a=2} T\nx\n:::\n');
});

test('own names: :constructor[x] is text, as any unknown name is', () => {
  for (const name of ['constructor', 'valueof', 'tostring']) {
    const doc = `See :${name}[x]{color=red} here.\n`;
    assert.match(html(doc), new RegExp(`See :${name}<span class="smd-span" style="[^"]*">x</span> here\\.`), name);
    assert.deepEqual(validateSmd(`See :${name}[x] here.\n`), [], name);
    assert.equal(agentView(`See :${name}[x] here.\n`).text.trim(), `See :${name}[x] here.`);
    assert.equal(smdToMarkdown(`See :${name}[x] here.\n`).trim(), `See :${name}[x] here.`);
  }
});

test('own names: attribute values, keys and statuses', () => {
  for (const name of PROTO_NAMES) {
    for (const key of ['size', 'weight', 'font', 'style']) {
      const { style, problems } = attrsToStyle(parseAttrs(`${key}=${name}`)!);
      assert.equal(style, '', `${key}=${name}`);
      assert.equal(problems.length, 1, `${key}=${name}`);
    }
    assert.equal(isStyleKey(name), false);
    assert.equal(booleanValue(name), undefined);
    assert.equal(frontMatterProperty(name), undefined);
    assert.deepEqual(frontMatterValues(name), []);
    assert.deepEqual(inlineOrder(name), []);
    assert.equal(isKnownRule(name), false);
    assert.equal(priorityRank(name), 5);
  }
  assert.doesNotMatch(agentView('Is :status[up]{color=constructor}.\n').text, /function/);
  assert.match(smdToMarkdown('Is :status[up]{color=constructor}.\n'), /⚪ up/);
  // A front matter key named like an inherited property is an unknown key, as any other is.
  assert.ok(validateSmd('---\nsmd: 1\nconstructor: x\n---\n\nText.\n').some((d) => d.code === 'frontmatter/unknown-key'));
  // A rule named like one is unknown.
  assert.ok(validateSmd('Text. <!-- smd-disable-line constructor -->\n').some((d) => d.code === 'rules/unknown'));
});

test('own names: completion, hovers and the Block Editor forms offer nothing for them', () => {
  assert.equal(containerForm(':::constructor{a=1} T', 'constructor'), undefined);
  assert.equal(containerForm(':::toString T', 'toString'), undefined);
  // A name outside the vocabulary (a directive only in spec v2) gets the generic form of a styled span, nothing inherited.
  const fields = inlineFields({ kind: 'directive', name: 'constructor', values: {}, content: 'x', at: { line: 0, start: 0, end: 16, content: { start: 13, end: 14 } } });
  assert.deepEqual(fields?.map((f) => f.name), ['content', 'color', 'bg', 'border']);
  // Attribute keys after an unknown name are the style keys; values of an inherited key are none.
  const keys = completionsAt(':::constructor{', 0, 15)?.items.map((i) => i.label) ?? [];
  assert.ok(keys.includes('color') && !keys.includes('constructor'), keys.join(', '));
  const values = completionsAt(':::warning{constructor=', 0, 23)?.items ?? [];
  assert.deepEqual(values, []);
  assert.deepEqual(completionsAt(':badge[x]{toString=', 0, 19)?.items ?? [], []);
  assert.equal(hoverAt(':::constructor', 0, 5), undefined);
  assert.equal(hoverAt('See :constructor[x].', 0, 7), undefined);
});
