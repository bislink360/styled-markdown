import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FRONTMATTER_KEYS, FRONTMATTER_SCHEMA, frontMatterValues, validateSmd, type ValidateOptions } from '../src/core';

const fm = (yaml: string, options: ValidateOptions = {}) =>
  validateSmd(`---\nsmd: 1\n${yaml}\n---\n\nBody\n`, { today: '2026-09-27', ...options })
    .filter((d) => d.code.startsWith('frontmatter/'))
    .map((d) => `${d.line}:${d.code}:${d.severity}`);

test('the published JSON schema matches the one the tools use', () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'smd-frontmatter.schema.json'), 'utf8'));
  assert.deepEqual(file, JSON.parse(JSON.stringify(FRONTMATTER_SCHEMA)));
  assert.deepEqual(Object.keys(FRONTMATTER_SCHEMA.properties).sort(), Object.keys(FRONTMATTER_KEYS).sort());
});

test('values offered for completion come from the schema', () => {
  assert.deepEqual(frontMatterValues('status'), ['draft', 'review', 'approved', 'deprecated', 'archived']);
  assert.deepEqual(frontMatterValues('theme'), ['auto', 'light', 'dark']);
  assert.deepEqual(frontMatterValues('toc'), ['true', 'false']);
  assert.deepEqual(frontMatterValues('smd'), ['1']);
  assert.ok(frontMatterValues('accent').includes('indigo'));
  assert.deepEqual(frontMatterValues('title'), []);
  assert.deepEqual(frontMatterValues('custom'), []);
});

test('front matter values are checked against the schema', () => {
  assert.deepEqual(fm('status: Approved\naudience: both\ntheme: dark\naccent: "#6366f1"\ntoc: true\nowners: ["@a"]\ntags: x\nupdated: 2026-09-01'), []);
  assert.deepEqual(fm('status: done'), ['2:frontmatter/status:warning']);
  assert.deepEqual(fm('audience: robots'), ['2:frontmatter/audience:warning']);
  assert.deepEqual(fm('theme: neon'), ['2:frontmatter/value:warning']);
  assert.deepEqual(fm('accent: brand'), ['2:frontmatter/accent:error']);
  assert.deepEqual(fm('accent: rgb(10, 20, 30)'), []);
  assert.deepEqual(fm('toc: yes'), ['2:frontmatter/type:warning']);
  assert.deepEqual(fm('tags: {a: 1}'), ['2:frontmatter/type:warning']);
  assert.deepEqual(fm('title: [a, b]'), ['2:frontmatter/type:warning']);
  assert.deepEqual(fm('title: 1984\nversion: 1.0'), [], 'numbers are fine as text');
  assert.deepEqual(fm('created: last week'), ['2:frontmatter/date:warning']);
  assert.deepEqual(fm('owner: "@maya"'), ['2:frontmatter/unknown-key:hint']);
  assert.deepEqual(fm('status:'), [], 'empty values are left alone');
});

test('the theme message lists the allowed values', () => {
  const [d] = validateSmd('---\nsmd: 1\ntheme: neon\n---\n').filter((x) => x.code === 'frontmatter/value');
  assert.equal(d.message, 'Unknown theme "neon". Use one of: auto, light, dark.');
});

test('stale documents: updated long ago and still live', () => {
  assert.deepEqual(fm('updated: 2026-03-31'), [], 'exactly 180 days old');
  assert.deepEqual(fm('updated: 2026-03-30'), ['2:frontmatter/stale:info'], '181 days old');
  assert.deepEqual(fm('updated: 2025-01-01\nstatus: archived'), []);
  assert.deepEqual(fm('updated: 2025-01-01\nstatus: Deprecated'), []);
  assert.deepEqual(fm('updated: 2025-01-01', { staleAfterDays: 0 }), [], '0 turns it off');
  assert.deepEqual(fm('updated: 2026-08-01', { staleAfterDays: 30 }), ['2:frontmatter/stale:info']);
  assert.deepEqual(fm('created: 2020-01-01'), [], 'only "updated" counts');
  const [d] = validateSmd('---\nsmd: 1\nupdated: 2026-01-01\n---\n', { today: '2026-09-27' }).filter((x) => x.code === 'frontmatter/stale');
  assert.equal(d.message, 'Last updated 269 days ago (more than 180). Review the document and bump "updated", or set "status: archived".');
});
