import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  imageExtension, imageFolder, imageMarkdown, inCodeBlock, isImagePath, listEnter, mergeLanguageSettings,
  pastedImageBase, smdLanguageSettings, SPELLCHECK_PATTERNS, toRegExp, uniqueFileName,
} from '../src/editing';

test('Enter continues task lists, keeping owners', () => {
  const line = '- [x] Finalize copy :priority[P1] @maya :due[2026-10-02] @legal';
  assert.deepEqual(listEnter(line, line.length), { kind: 'continue', prefix: '- [ ] ', suffix: ' @maya @legal' });
  assert.deepEqual(listEnter('  * [ ] Nested', 14), { kind: 'continue', prefix: '  * [ ] ', suffix: '' });
  // Splitting a line mid-way continues the list without copying owners.
  assert.deepEqual(listEnter('- [ ] Write docs @sam', 12), { kind: 'continue', prefix: '- [ ] ', suffix: '' });
});

test('Enter continues bullets and numbered lists', () => {
  assert.deepEqual(listEnter('- item', 6), { kind: 'continue', prefix: '- ', suffix: '' });
  assert.deepEqual(listEnter('9. step', 7), { kind: 'continue', prefix: '10. ', suffix: '' });
  assert.deepEqual(listEnter('3)  wide', 8), { kind: 'continue', prefix: '4)  ', suffix: '' });
});

test('Enter on an empty item ends the list; elsewhere it does nothing special', () => {
  assert.deepEqual(listEnter('- ', 2), { kind: 'end', line: '' });
  assert.deepEqual(listEnter('- [ ] ', 6), { kind: 'end', line: '' });
  assert.deepEqual(listEnter('- [ ] @maya', 11), { kind: 'end', line: '' }, 'only the carried-over owner');
  assert.equal(listEnter('Plain paragraph', 5), undefined);
  assert.equal(listEnter('-no space', 3), undefined);
  assert.equal(listEnter('- [ ] Task', 3), undefined, 'cursor inside the marker');
  assert.equal(listEnter('---', 3), undefined);
});

test('inCodeBlock tells fenced code apart', () => {
  const lines = ['- item', '```md', '- inside', '```', '- after', '~~~', 'x', '~~~'];
  assert.deepEqual(lines.map((_, i) => inCodeBlock(lines, i)), [false, true, true, true, false, true, true, true]);
});

test('image names, folders and links', () => {
  assert.ok(isImagePath('a/b/Photo.JPG') && !isImagePath('notes.txt'));
  assert.equal(imageExtension('image/png'), '.png');
  assert.equal(imageExtension('text/plain'), undefined);
  assert.equal(pastedImageBase('/w/docs/checkout-redesign.smd', new Date(2026, 8, 28, 9, 15, 2)), 'checkout-redesign-20260928-091502');
  assert.equal(uniqueFileName('shot', '.png', (n) => ['shot.png', 'shot-1.png'].includes(n)), 'shot-2.png');
  const root = path.resolve('/w');
  assert.equal(imageFolder(path.join(root, 'docs', 'a.smd'), root, 'docs/images'), path.join(root, 'docs', 'images'));
  assert.equal(imageFolder(path.join(root, 'notes', 'a.smd'), undefined, 'images'), path.join(root, 'notes', 'images'));
  const doc = path.join(root, 'docs', 'specs', 'a.smd');
  assert.equal(imageMarkdown(doc, path.join(root, 'docs', 'images', 'login_flow-v2.png')), '![login flow v2](../images/login_flow-v2.png)');
  assert.equal(imageMarkdown(doc, path.join(root, 'docs', 'specs', 'my shot (1).png')), '![my shot (1)](my%20shot%20%281%29.png)');
});

test('spell-check patterns hide syntax and keep prose', () => {
  const doc = [
    '---', 'title: Checkout', 'owners: ["@maya"]', '---', '',
    ':::warnign{collapsible accent=teal} Breaking change ahead',
    'Use [red text]{color=red weight=bold} and :badge[Shipped]{color=green}, ask @platform-team.',
    'See [docs](../specs/aprv.smd#rolout).',
    '```ts', 'const qwzx = 1;', '```', '',
    'Inline `qwzx()` code.', '', '---', 'A body paragraph between rules stays checked.', '---',
  ].join('\n');
  let masked = doc;
  for (const p of SPELLCHECK_PATTERNS) masked = masked.replace(toRegExp(p.pattern), (m) => ' '.repeat(m.length));
  for (const hidden of ['owners', 'warnign', 'collapsible', 'accent=teal', 'weight=bold', ':badge', '@platform-team', 'aprv', 'rolout', 'qwzx']) {
    assert.ok(!masked.includes(hidden), `"${hidden}" should be ignored`);
  }
  for (const kept of ['Breaking change ahead', 'red text', 'Shipped', 'ask', 'Inline', 'A body paragraph between rules stays checked.']) {
    assert.ok(masked.includes(kept), `"${kept}" should still be checked`);
  }
});

test('cSpell settings merge without clobbering the user\'s entries', () => {
  const user = { languageId: 'markdown', ignoreRegExpList: ['/x/'] };
  const once = mergeLanguageSettings([user]);
  assert.deepEqual(once, [user, smdLanguageSettings()]);
  assert.deepEqual(mergeLanguageSettings(once), once, 'running it again replaces our entry');
  assert.deepEqual(mergeLanguageSettings(undefined), [smdLanguageSettings()]);
  assert.deepEqual(smdLanguageSettings().ignoreRegExpList, SPELLCHECK_PATTERNS.map((p) => p.name));
});
