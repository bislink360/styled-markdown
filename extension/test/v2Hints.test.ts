import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyFixes, renderSmd, validateSmd, type Diagnostic, type ValidateOptions } from '../src/core';

/**
 * The 1.10 hints for what spec v2 rejects or reads differently, each with a fix that keeps rendering. Hints (one info),
 * except what 2.0 reports in every document: attrs/duplicate and container/title-conflict are errors, and priority on
 * :::agent is an attrs/unknown warning.
 */

const HINT_CODES = ['container/colons', 'heading/attrs-text', 'include/section-match', 'frontmatter/version'];

const doc = (body: string, smd = 'smd: 1') => `---\n${smd}\n---\n\n${body}\n`;
const only = (code: string, text: string, options: ValidateOptions = {}) => validateSmd(text, options).filter((d) => d.code === code);
const found = (diagnostics: Diagnostic[]) => diagnostics.map((d) => `${d.line}:${d.code}:${d.severity}`);
/** The text with the fixes of `code` applied. */
const fixed = (code: string, text: string, options: ValidateOptions = {}) => applyFixes(text, only(code, text, options)).text;

test('container/colons: a closer with another colon count than its container is a hint, fixed to the count', () => {
  const text = doc('::::tabs\n:::tab A\nOne\n::::\n:::tab B\nTwo\n:::\n:::');
  const hints = only('container/colons', text);
  assert.deepEqual(found(hints), ['7:container/colons:hint', '11:container/colons:hint']);
  assert.match(hints[0].message, /4 colons and closes ":::tab" on line 6, which has 3.*spec v2 \(smd: 2\).*Write it with 3 colons/);
  assert.deepEqual([hints[0].column, hints[0].endColumn], [0, 4]);
  const after = fixed('container/colons', text);
  assert.equal(after, doc('::::tabs\n:::tab A\nOne\n:::\n:::tab B\nTwo\n:::\n::::'));
  assert.equal(renderSmd(after).html, renderSmd(text).html, 'the fix keeps the rendering');
  assert.deepEqual(only('container/colons', after), []);
});

test('container/colons: matching closers, stray closers and fences in code are not reported', () => {
  assert.deepEqual(only('container/colons', doc('::::tabs\n:::tab A\nOne\n:::\n::::')), []);
  assert.deepEqual(only('container/colons', doc(':::note\nx\n:::\n::::')), [], 'a stray closer is container/stray-close');
  assert.deepEqual(only('container/colons', doc('::::note\n```\n:::\n```\n::::')), []);
  // An indented closer keeps its indentation.
  const indented = doc('- item\n\n  ::::note\n  x\n  :::');
  assert.deepEqual(only('container/colons', indented).map((d) => [d.column, d.endColumn]), [[2, 5]]);
  assert.match(fixed('container/colons', indented), /\n {2}::::\n$/);
});

test('attrs/duplicate: a key, an id or a class given twice, in every kind of attribute list', () => {
  const text = doc([
    ':::note{color=red color=blue} Title', 'x', ':::', '',
    '## Heading {#a #b .c}', '',
    'A [span]{color=red bg=yellow color=blue} and :badge[B]{color=red color=green} and [c]{.x .y .x}.',
  ].join('\n'));
  const hints = only('attrs/duplicate', text);
  assert.deepEqual(found(hints), ['4:attrs/duplicate:error', '8:attrs/duplicate:error', '10:attrs/duplicate:error', '10:attrs/duplicate:error', '10:attrs/duplicate:error']);
  assert.equal(hints[0].message, '"color" is given more than once in this attribute list. The last one is used, but an attribute may be given only once. Remove the earlier ones.');
  assert.match(hints[1].message, /^"#id" is given more than once/);
  const after = fixed('attrs/duplicate', text);
  assert.equal(after, doc([
    ':::note{color=blue} Title', 'x', ':::', '',
    '## Heading {#b .c}', '',
    'A [span]{color=blue bg=yellow} and :badge[B]{color=green} and [c]{.x .y}.',
  ].join('\n')));
  // The last value wins when rendered, and it stays where the key first was: nothing changes but a repeated class.
  assert.equal(renderSmd(after).html, renderSmd(text).html.replace('smd-u-x smd-u-y smd-u-x', 'smd-u-x smd-u-y'));
});

test('attrs/duplicate: distinct items, code and malformed lists are not reported', () => {
  assert.deepEqual(only('attrs/duplicate', doc('[a]{color=red bg=red .x .y #id} :badge[b]{color=red}\n\n## H {#id .x}')), []);
  assert.deepEqual(only('attrs/duplicate', doc('`[a]{color=red color=blue}`\n\n```\n[a]{color=red color=blue}\n```')), []);
  assert.deepEqual(only('attrs/duplicate', doc('[a]{color=red color=}')), []);
  // Items are read with the shared lexer, so an escaped quote stays inside its value.
  const escaped = doc(':::note{title="Say \\"hi\\" twice" title="Final"}\nx\n:::');
  assert.deepEqual(found(only('attrs/duplicate', escaped)), ['4:attrs/duplicate:error']);
  assert.equal(fixed('attrs/duplicate', escaped), doc(':::note{title="Final"}\nx\n:::'));
  // Several duplicates in one list are one hint.
  const both = only('attrs/duplicate', doc('[a]{color=red .x color=blue .x}'));
  assert.equal(both.length, 1);
  assert.match(both[0].message, /^"color", "\.x" are given more than once/);
});

test('container/title-conflict: title= and title text, with a fix that drops the text', () => {
  const text = doc(':::note{title="Attribute title"} Text title\nBody\n:::');
  const hints = only('container/title-conflict', text);
  assert.deepEqual(found(hints), ['4:container/title-conflict:error']);
  assert.equal(hints[0].message, 'This title text is not shown: title="Attribute title" in the attributes wins. A container is titled either by title="…" or by text after its attributes, not both. Remove the text, or move it into title="…".');
  assert.deepEqual([hints[0].column, hints[0].endColumn], [33, 43]);
  const after = fixed('container/title-conflict', text);
  assert.equal(after, doc(':::note{title="Attribute title"}\nBody\n:::'));
  assert.equal(renderSmd(after).html, renderSmd(text).html);
});

test('container/title-conflict: a fix for an unknown attribute never makes one (fuzz seed 20260928, case 2150)', () => {
  // `ible` is close to `title`, but a bare `title` beside title text would be a title conflict, an error since 2.0.
  const text = doc(':::warning{ible} Heads up\nx\n:::');
  const [unknown] = only('attrs/unknown', text);
  assert.equal(unknown.fix, undefined);
  assert.equal(only('attrs/unknown', doc(':::warning{ible}\nx\n:::'))[0].fix?.replacement, 'title', 'without title text, title is still offered');
});

test('container/title-conflict: one title, comments and unknown containers are not reported', () => {
  for (const line of [':::note{title="A"}', ':::note Text', ':::note{.x} Text', ':::note{title="A"} <!-- a comment -->', ':::notte{title="A"} Text']) {
    assert.deepEqual(only('container/title-conflict', doc(`${line}\nx\n:::`)), [], line);
  }
  // Text beside a comment is reported, without a fix that would remove the comment.
  const [hint] = only('container/title-conflict', doc(':::note{title="A"} B <!-- c -->\nx\n:::'));
  assert.equal(hint.fix, undefined);
});

test('heading/attrs-text: "{}" and bare words after a heading, with fixes that keep the rendering', () => {
  const text = doc('## Object {}\n\n## Returns {ok}\n\n## Both {#id ok .c}\n\n## Agent {agent}');
  const hints = only('heading/attrs-text', text);
  assert.deepEqual(found(hints), ['4:heading/attrs-text:hint', '6:heading/attrs-text:hint', '8:heading/attrs-text:hint', '10:heading/attrs-text:hint']);
  assert.match(hints[0].message, /^"\{\}" after a heading is read as an empty attribute list and dropped today\. In spec v2 \(smd: 2\).*Remove the braces/);
  assert.match(hints[1].message, /^"\{ok\}" after a heading is read as an attribute list, and "ok" is dropped today\./);
  assert.equal(hints[3].fix, undefined, '{agent} renders data-agent="true": no fix');
  const after = fixed('heading/attrs-text', text);
  assert.equal(after, doc('## Object\n\n## Returns\n\n## Both {#id .c}\n\n## Agent {agent}'));
  assert.equal(renderSmd(after).html, renderSmd(text).html);
});

test('heading/attrs-text: lists of #id, .class and key=value, and headings in code, are not reported', () => {
  assert.deepEqual(only('heading/attrs-text', doc('## A {#id}\n\n## B {.c agent=skip}\n\n## C {x=1}\n\n```\n## D {}\n```\n\n    ## E {}')), []);
});

test('include/section-match: a section found by a part of its heading is an info, fixed to the heading id', () => {
  const files: Record<string, string> = { 'terms.smd': '# Terms\n\n## Rapid deployment\n\nShip it.\n\n## Refunds {#money-back}\n\nYes.\n' };
  const options: ValidateOptions = { readFile: (p) => files[p], fileExists: (p) => p in files };
  const text = doc(':::include{file="terms.smd" section="deploy"}\n:::');
  const hints = only('include/section-match', text, options);
  assert.deepEqual(found(hints), ['4:include/section-match:info']);
  assert.match(hints[0].message, /^section="deploy" finds the heading "Rapid deployment" in "terms\.smd" only by a part of its text\. In spec v2 \(smd: 2\).*section="rapid-deployment"/);
  const after = fixed('include/section-match', text, options);
  assert.equal(after, doc(':::include{file="terms.smd" section="rapid-deployment"}\n:::'));
  assert.equal(renderSmd(after, options).html.replace(/data-include="[^"]*"/g, ''), renderSmd(text, options).html.replace(/data-include="[^"]*"/g, ''));
  // An exact id, a whole heading text in any case, or a section that matches nothing (include/missing-section) is not.
  for (const section of ['rapid-deployment', 'Rapid Deployment', '#money-back', 'refunds', 'nope']) {
    assert.deepEqual(only('include/section-match', doc(`:::include{file="terms.smd" section="${section}"}\n:::`), options), [], section);
  }
  // Without a reader nothing is checked.
  assert.deepEqual(only('include/section-match', text), []);
});

test('priority on :::agent, removed in 2.0: an attrs/unknown warning on the attribute, with a fix that removes it', () => {
  const text = doc(':::agent{priority=high} Read this\nx\n:::\n\n:::agent{title="T" priority=1}\ny\n:::');
  const hints = only('attrs/unknown', text);
  assert.deepEqual(found(hints), ['4:attrs/unknown:warning', '8:attrs/unknown:warning']);
  assert.equal(hints[0].message, 'Unknown attribute "priority" on ":::agent". It was removed in Styled Markdown 2.0, since no tool read it. Remove it.');
  assert.deepEqual([hints[1].column, hints[1].endColumn], [19, 27]);
  const after = fixed('attrs/unknown', text);
  assert.equal(after, doc(':::agent Read this\nx\n:::\n\n:::agent{title="T"}\ny\n:::'));
  assert.equal(renderSmd(after).html, renderSmd(text).html);
  assert.deepEqual(validateSmd(after).filter((d) => d.severity !== 'info'), []);
  // Other containers report it as any unknown attribute.
  const [other] = only('attrs/unknown', doc(':::note{priority=high}\nx\n:::'));
  assert.equal(other.message, 'Unknown attribute "priority" on ":::note".');
  assert.equal(found(validateSmd(':::agent{priority=high}\nx\n:::\n', {}))[0], '0:attrs/unknown:warning', 'without front matter too');
});

test('an invalid figure kind is an attrs/value error (figure/kind until 2.0), in every document', () => {
  for (const text of [':::figure{kind=tabel}\nx\n:::\n', doc(':::figure{kind=tabel}\nx\n:::'), doc(':::figure{kind=tabel}\nx\n:::', 'smd: 2')]) {
    const [d] = validateSmd(text).filter((x) => x.code !== 'frontmatter/version');
    assert.deepEqual([d.code, d.severity], ['attrs/value', 'error'], text);
    assert.equal(d.message, 'Invalid kind "tabel" on ":::figure" — did you mean "table"? Use one of: figure, table, listing.');
  }
});

test('duplicates and title conflicts are errors in every document: no front matter, smd: 1 and smd: 2', () => {
  const body = '[a]{color=red color=blue}\n\n:::note{title="A"} B\nx\n:::';
  for (const text of [`${body}\n`, doc(body), doc(body, 'smd: 2')]) {
    const codes = validateSmd(text).filter((d) => d.code !== 'frontmatter/version').map((d) => `${d.code}:${d.severity}`);
    assert.deepEqual(codes, ['attrs/duplicate:error', 'container/title-conflict:error'], text);
  }
});

test('frontmatter/version: values Number() reads as 1 that are not whole numbers are an info, fixed to smd: 1', () => {
  const cases: Array<[string, string]> = [
    ['smd: true', 'a boolean'], ['smd: [1]', 'a list'], ['smd: 1.0', 'a decimal'], ['smd: 0x1', 'a decimal'],
    ['smd: "1.0"', 'a string that is not a whole number'], ['smd: " 1"', 'a string that is not a whole number'], ['smd: 1.0 # v1', 'a decimal'],
  ];
  for (const [line, kind] of cases) {
    const text = doc('Body', line);
    const [d, ...rest] = only('frontmatter/version', text);
    assert.equal(rest.length, 0, line);
    assert.equal(d.severity, 'info', line);
    assert.equal(d.line, 1);
    assert.ok(d.message.includes(` is ${kind}, which counts as version 1 today. The spec version is a whole number, and Styled Markdown 2.0 reports other values as a warning. Write "smd: 1".`), `${line}: ${d.message}`);
    const after = fixed('frontmatter/version', text);
    assert.equal(after.split('\n')[1], line.endsWith('# v1') ? 'smd: 1 # v1' : 'smd: 1', line);
    assert.deepEqual(only('frontmatter/version', after), [], line);
  }
  // A list written on its own lines is reported without a fix.
  const [block] = only('frontmatter/version', doc('Body', 'smd:\n  - 1'));
  assert.equal(block.severity, 'info');
  assert.equal(block.fix, undefined);
});

test('frontmatter/version: whole numbers and digit strings pass; other versions warn, v2 until 2.0', () => {
  for (const line of ['smd: 1', 'smd: "1"', "smd: '01'"]) assert.deepEqual(only('frontmatter/version', doc('Body', line)), [], line);
  const [v2] = only('frontmatter/version', doc('Body', 'smd: 2'));
  assert.equal(v2.severity, 'warning');
  assert.equal(v2.message, 'Unsupported Styled Markdown version "2": spec v2 is not supported until Styled Markdown 2.0. This tool reads the document with the version 1 rules.');
  const [v3] = only('frontmatter/version', doc('Body', 'smd: 3'));
  assert.deepEqual([v3.severity, v3.message], ['warning', 'Unsupported Styled Markdown version "3". This tool supports version 1.']);
  const [missing] = only('frontmatter/version', '---\ntitle: x\n---\n');
  assert.equal(missing.severity, 'info');
});

test('the 1.10 hints can be configured and suppressed like other rules', () => {
  const text = doc('::::note\n[a]{color=red color=blue}\n:::\n\n## A {}\n\n:::agent{priority=high}\nx\n:::');
  const codes = (options: ValidateOptions = {}, t = text) => found(validateSmd(t, options));
  assert.deepEqual(codes(), ['5:attrs/duplicate:error', '6:container/colons:hint', '8:heading/attrs-text:hint', '10:attrs/unknown:warning']);
  assert.deepEqual(codes({ rules: { 'attrs/duplicate': 'warning', 'heading/*': 'warning', 'attrs/unknown': 'off' } }),
    ['5:attrs/duplicate:warning', '6:container/colons:hint', '8:heading/attrs-text:warning']);
  assert.deepEqual(codes({ rules: { 'container/colons': 'error' } })[1], '6:container/colons:error');
  const suppressed = text.replace('## A {}', '<!-- smd-disable-next-line heading/attrs-text -->\n## A {}').replace(':::agent{', '<!-- smd-disable-next-line attrs/unknown -->\n:::agent{');
  assert.deepEqual(codes({}, suppressed), ['5:attrs/duplicate:error', '6:container/colons:hint']);
});

const corpus = path.join(__dirname, 'compat', 'corpus');
const corpusOptions: ValidateOptions = { readFile: (p) => { try { return fs.readFileSync(path.join(corpus, p), 'utf8'); } catch { return undefined; } } };
const corpusDiagnostics = (name: string, unsuppressed = false) => {
  const text = fs.readFileSync(path.join(corpus, name), 'utf8');
  return validateSmd(unsuppressed ? text.replaceAll('smd-disable', 'smd-xisable').replaceAll('smd-enable', 'smd-xnable') : text, corpusOptions);
};

test('the hints that stay hints are never an error or a warning by default', () => {
  const seen = new Set<string>();
  for (const name of ['v2-hints.smd', 'smd-version.smd']) {
    for (const d of corpusDiagnostics(name)) {
      if (!HINT_CODES.includes(d.code)) continue;
      seen.add(d.code);
      assert.ok(d.severity === 'hint' || d.severity === 'info', `${name}: ${d.code} is ${d.severity}`);
    }
  }
  assert.deepEqual([...seen].sort(), [...HINT_CODES].sort(), 'the corpus documents pin every case');
});

test('the corpus pins the 2.0 errors in a v1 and a v2 document, silenced so that both pass validation', () => {
  for (const name of ['v2-hints.smd', 'v2-validation.smd']) {
    assert.deepEqual(corpusDiagnostics(name).filter((d) => d.severity === 'error'), [], name);
    const errors = corpusDiagnostics(name, true).filter((d) => d.severity === 'error' || (d.code === 'attrs/unknown' && /priority/.test(d.message)));
    const codes = [...new Set(errors.map((d) => `${d.code}:${d.severity}`))].sort();
    const expected = ['attrs/duplicate:error', 'attrs/unknown:warning', 'container/title-conflict:error'];
    // The v2 document also has an invalid figure kind (mermaid/syntax needs the CLI's parser: see mermaid.test.ts).
    assert.deepEqual(codes, name === 'v2-validation.smd' ? [...expected, 'attrs/value:error'].sort() : expected, name);
  }
});
