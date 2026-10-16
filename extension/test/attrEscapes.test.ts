import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentView, formatSmd, renderSmd, smdToMarkdown, validateSmd } from '../src/core';
import { findAttrsEnd, parseAttrs } from '../src/core/attrs';
import { formatAttrs, quote } from '../src/core/format';

/**
 * Escapes in quoted attribute values (1.10, spec v2 RFC proposal 6): `\"` inside double quotes and `\'` inside single
 * quotes are the quote; every other backslash stays, and a list valid before 1.10 reads as it did.
 */

const corpus = (name: string) => readFileSync(join(__dirname, 'compat', 'corpus', name), 'utf8');
const codes = (text: string) => validateSmd(text, { today: '2026-10-15' }).map((d) => d.code);

test('escapes: \\" and \\\' are the quote inside their own quotes; every other backslash stays', () => {
  assert.deepEqual(parseAttrs(String.raw`title="say \"hi\""`)?.values, { title: 'say "hi"' });
  assert.deepEqual(parseAttrs(String.raw`title='it\'s'`)?.values, { title: "it's" });
  assert.deepEqual(parseAttrs(String.raw`a="it\'s" b='say \"hi\"'`)?.values, { a: String.raw`it\'s`, b: String.raw`say \"hi\"` }, 'only the own quote');
  assert.deepEqual(parseAttrs(String.raw`p="C:\Users\docs" q="\\server\share"`)?.values, { p: String.raw`C:\Users\docs`, q: String.raw`\\server\share` });
  // A value that ends with a backslash was valid before 1.10 and reads as it did.
  assert.deepEqual(parseAttrs(String.raw`title="C:\docs\" next=1`)?.values, { title: 'C:\\docs\\', next: '1' });
  // So does any list that only reads without escapes; one that reads neither way is malformed.
  assert.deepEqual(parseAttrs(String.raw`title="a\" b`)?.values, { title: 'a\\', b: 'true' });
  assert.equal(parseAttrs(String.raw`title="never \"closed`)?.values.title, 'never \\');
  assert.equal(parseAttrs(String.raw`t="a\"b"c"`), null);
});

test('escapes: findAttrsEnd skips an escaped quote, and reads a list without escapes when that finds no end', () => {
  const src = String.raw`[x]{title="a}b\"c"} after}`;
  assert.equal(findAttrsEnd(src, 3), src.indexOf('} after'));
  const v1 = String.raw`[x]{title="C:\docs\"} after`;
  assert.equal(findAttrsEnd(v1, 3), v1.indexOf('} after'));
});

test('escapes: rendering, validation, the agent view and to-md read the value', () => {
  const doc = String.raw`:::note{title="It's \"done\""}` + '\nBody.\n:::\n\n' + String.raw`Rate :metric[42%]{label="The \"active\" share" trend=up} now.` + '\n';
  assert.deepEqual(codes(doc), []);
  const html = renderSmd(doc).html;
  assert.match(html, /<\/span>It’s “done”<\/span>/);
  assert.match(html, /smd-metric-label">The &quot;active&quot; share</);
  assert.match(agentView(doc).text, /The "active" share: 42%/);
  assert.match(smdToMarkdown(doc), /\*\*42%\*\* The "active" share/);
  const span = String.raw`[q]{title="say \"hi\""}`;
  assert.deepEqual(codes(span), ['attrs/unknown'], 'a well-formed list: only the unknown key');
  assert.equal(agentView(span).text.trim(), 'q');
});

test('escapes: fmt quotes only as needed, escapes only with both kinds of quote, and never changes a value', () => {
  assert.equal(quote('title', 'say "hi"', []), `'say "hi"'`);
  assert.equal(quote('title', "it's", []), `"it's"`);
  assert.equal(quote('title', `it's "x"`, []), String.raw`"it's \"x\""`);
  assert.equal(formatAttrs(String.raw`title="say \"hi\""`, []), `title='say "hi"'`);
  assert.equal(formatAttrs(String.raw`title='it\'s'`, []), `title="it's"`);
  assert.equal(formatAttrs(String.raw`title="it's \"x\""`, []), String.raw`title="it's \"x\""`);
  assert.equal(formatAttrs(String.raw`title="C:\docs\"`, []), String.raw`title="C:\docs\"`);
  // A backslash before a quote with both kinds of quote: no quoting reads back the same, so it is left as written.
  assert.equal(formatAttrs(String.raw`t='a\"b\'c'`, []), null);
  const line = String.raw`:::note{t='a\"b\'c'} Title`;
  assert.equal(formatSmd(`${line}\nx\n:::\n`), `${line}\nx\n:::\n`);
  const doc = corpus('attribute-escapes.smd');
  assert.deepEqual(validateSmd(doc, { today: '2026-10-15' }), []);
  assert.equal(formatSmd(doc), doc);
});
