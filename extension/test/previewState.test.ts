import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';

// The page runtime (media/runtime.js) exports its pure helpers when loaded outside a browser.
const runtimePath = join(__dirname, '..', 'media', 'runtime.js');
const { mapLine, pickAnchor, findLine, stableKeys, lruCache, diagramKey } = createRequire(__filename)(runtimePath);

test('mapLine follows lines through inserted and deleted lines', () => {
  // Enter at the end of line 3: lines after it move down one.
  assert.equal(mapLine(10, [[3, 3, 1]]), 11);
  assert.equal(mapLine(3, [[3, 3, 1]]), 3);
  assert.equal(mapLine(2, [[3, 3, 1]]), 2);
  // Lines 4–6 replaced by a single line: later lines move up two, lines inside collapse onto it.
  assert.equal(mapLine(10, [[4, 6, 0]]), 8);
  assert.equal(mapLine(5, [[4, 6, 0]]), 4);
  assert.equal(mapLine(6, [[4, 6, 0]]), 4);
  // Paste of five lines at the top, then delete of two lines further down, applied in order.
  assert.equal(mapLine(20, [[0, 0, 5], [10, 12, 0]]), 23);
  assert.equal(mapLine(7, undefined), 7);
});

test('pickAnchor chooses the last element starting above the viewport and the offset into it', () => {
  const items = [
    { line: 0, top: 0 },
    { line: 4, top: 100 },
    { line: 4, top: 100 }, // a list and its first item share a line
    { line: 6, top: 130 },
    { line: 9, top: 400 },
  ];
  assert.deepEqual(pickAnchor(items, 150), { line: 6, offset: 20 });
  assert.deepEqual(pickAnchor(items, 100), { line: 4, offset: 0 });
  assert.equal(pickAnchor([{ line: 5, top: 300 }], 0), null);
});

test('findLine prefers an exact line and falls back to the closest line above', () => {
  const items = [{ line: 0 }, { line: 4 }, { line: 4 }, { line: 9 }];
  assert.deepEqual(findLine(items, 4), { index: 1, exact: true });
  assert.deepEqual(findLine(items, 7), { index: 2, exact: false });
  assert.deepEqual(findLine([{ line: 3 }], 1), { index: -1, exact: false });
});

test('stableKeys depend on content and repeats, not on position', () => {
  assert.deepEqual(stableKeys(['tabs:A|B', 'details:Why', 'tabs:A|B']), ['tabs:A|B#0', 'details:Why#0', 'tabs:A|B#1']);
  // Inserting an unrelated block above keeps the keys of the ones below.
  assert.deepEqual(stableKeys(['details:New', 'tabs:A|B']).slice(1), stableKeys(['tabs:A|B']));
});

test('diagram cache is keyed by theme and source and evicts the least recently used', () => {
  assert.notEqual(diagramKey('light', 'graph A'), diagramKey('dark', 'graph A'));
  const cache = lruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1); // a is now most recent
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('the runtime is inert without a DOM and without CommonJS (exported HTML inlines it)', () => {
  const source = readFileSync(runtimePath, 'utf8');
  assert.doesNotThrow(() => vm.runInNewContext(source, {}));
  assert.doesNotMatch(source, /<\/script/i);
});
