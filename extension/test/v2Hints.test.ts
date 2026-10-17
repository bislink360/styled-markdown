import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyFixes, renderSmd, specVersion, validateSmd, type Diagnostic, type ValidateOptions } from '../src/core';

/** The 1.10 hints for what spec v2 rejects or reads differently: hints (one info), each with a fix that keeps rendering. */

const V2_CODES = [
  'container/colons', 'attrs/duplicate', 'container/title-conflict', 'heading/attrs-text', 'include/section-match',
  'deprecated/agent-priority', 'frontmatter/version',
];

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
  assert.deepEqual(found(hints), ['4:attrs/duplicate:hint', '8:attrs/duplicate:hint', '10:attrs/duplicate:hint', '10:attrs/duplicate:hint', '10:attrs/duplicate:hint']);
  assert.match(hints[0].message, /^"color" is given more than once in this attribute list, and the last one is used\. Styled Markdown 2\.0 reports duplicate attributes as errors/);
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
  assert.deepEqual(found(only('attrs/duplicate', escaped)), ['4:attrs/duplicate:hint']);
  assert.equal(fixed('attrs/duplicate', escaped), doc(':::note{title="Final"}\nx\n:::'));
  // Several duplicates in one list are one hint.
  const both = only('attrs/duplicate', doc('[a]{color=red .x color=blue .x}'));
  assert.equal(both.length, 1);
  assert.match(both[0].message, /^"color", "\.x" are given more than once/);
});

test('container/title-conflict: title= and title text, with a fix that drops the text', () => {
  const text = doc(':::note{title="Attribute title"} Text title\nBody\n:::');
  const hints = only('container/title-conflict', text);
  assert.deepEqual(found(hints), ['4:container/title-conflict:hint']);
  assert.match(hints[0].message, /title="Attribute title" in the attributes wins\. Styled Markdown 2\.0 reports a container titled both ways as an error/);
  assert.deepEqual([hints[0].column, hints[0].endColumn], [33, 43]);
  const after = fixed('container/title-conflict', text);
  assert.equal(after, doc(':::note{title="Attribute title"}\nBody\n:::'));
  assert.equal(renderSmd(after).html, renderSmd(text).html);
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

test('deprecated/agent-priority: a hint with a fix that removes it', () => {
  const text = doc(':::agent{priority=high} Read this\nx\n:::\n\n:::agent{title="T" priority=1}\ny\n:::');
  const hints = only('deprecated/agent-priority', text);
  assert.deepEqual(found(hints), ['4:deprecated/agent-priority:hint', '8:deprecated/agent-priority:hint']);
  assert.match(hints[0].message, /^"priority" on ":::agent" is deprecated: no tool reads it, and Styled Markdown 2\.0 removes it/);
  assert.deepEqual([hints[1].column, hints[1].endColumn], [19, 27]);
  const after = fixed('deprecated/agent-priority', text);
  assert.equal(after, doc(':::agent Read this\nx\n:::\n\n:::agent{title="T"}\ny\n:::'));
  assert.equal(renderSmd(after).html, renderSmd(text).html);
  assert.deepEqual(only('deprecated/agent-priority', doc(':::agent{title="T"}\nx\n:::\n\n:::note{priority=high}\nx\n:::')), []);
});

test('figure/kind: the message says the code is deprecated and folds into attrs/value', () => {
  const [d] = validateSmd(':::figure{kind=tabel}\nx\n:::\n');
  assert.equal(d.code, 'figure/kind');
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /The "figure\/kind" code is deprecated: Styled Markdown 2\.0 reports this as "attrs\/value"/);
});

test('frontmatter/version: a value that is not a whole number is a warning (2.0), reads as version 1 and is fixed to smd: 1', () => {
  const cases: Array<[string, string]> = [
    ['smd: true', 'a boolean'], ['smd: [1]', 'a list'], ['smd: [2]', 'a list'], ['smd: 1.0', 'a decimal'], ['smd: 0x1', 'a decimal'],
    ['smd: 1.5', 'a decimal'], ['smd: 0', 'not a positive number'], ['smd: -2', 'not a positive number'], ['smd: "0"', 'not a positive number'],
    ['smd: "1.0"', 'a string that is not a whole number'], ['smd: " 1"', 'a string that is not a whole number'], ['smd: v2', 'a string that is not a whole number'],
    ['smd: 1.0 # v1', 'a decimal'],
  ];
  for (const [line, kind] of cases) {
    const text = doc('Body', line);
    const [d, ...rest] = only('frontmatter/version', text);
    assert.equal(rest.length, 0, line);
    assert.equal(d.severity, 'warning', line);
    assert.equal(d.line, 1);
    assert.ok(d.message.endsWith(` is ${kind}, but the spec version is a whole number: this tool reads the document with the version 1 rules. Write "smd: 1", or "smd: 2" for the spec v2 rules (smd migrate --to 2 writes it).`), `${line}: ${d.message}`);
    assert.equal(specVersion(text), 1, line);
    const after = fixed('frontmatter/version', text);
    assert.equal(after.split('\n')[1], line.endsWith('# v1') ? 'smd: 1 # v1' : 'smd: 1', line);
    assert.deepEqual(only('frontmatter/version', after), [], line);
  }
  // A list written on its own lines is reported without a fix.
  const [block] = only('frontmatter/version', doc('Body', 'smd:\n  - 1'));
  assert.equal(block.severity, 'warning');
  assert.equal(block.fix, undefined);
  // An empty value is YAML's null.
  assert.equal(only('frontmatter/version', doc('Body', 'smd:'))[0].severity, 'warning');
});

test('frontmatter/version: a whole number written as a decimal reads as that number, with a warning and a fix', () => {
  const text = doc('Body', 'smd: 2.0');
  const [d] = only('frontmatter/version', text);
  assert.equal(d.severity, 'warning');
  assert.ok(d.message.endsWith('"smd: 2.0" is a decimal, but the spec version is a whole number: this tool reads the document with the version 2 rules. Write "smd: 2".'), d.message);
  assert.equal(specVersion(text), 2);
  assert.equal(fixed('frontmatter/version', text).split('\n')[1], 'smd: 2');
});

test('frontmatter/version: versions 1 and 2 pass, as whole numbers or digit strings; a newer version warns and reads as v2', () => {
  for (const line of ['smd: 1', 'smd: "1"', "smd: '01'", 'smd: 2', 'smd: "2"', 'smd: 2 # spec v2']) {
    assert.deepEqual(only('frontmatter/version', doc('Body', line)), [], line);
  }
  for (const line of ['smd: 3', 'smd: "3"', 'smd: 12']) {
    const [newer] = only('frontmatter/version', doc('Body', line));
    const n = line.replaceAll(/\D/g, '');
    assert.deepEqual([newer.severity, newer.message, newer.fix], ['warning',
      `Styled Markdown version ${n} is newer than this tool knows, so it reads the document with the version 2 rules. Update Styled Markdown, or write "smd: 2".`, undefined], line);
    assert.equal(specVersion(doc('Body', line)), 2, line);
  }
  const [missing] = only('frontmatter/version', '---\ntitle: x\n---\n');
  assert.equal(missing.severity, 'info');
  assert.equal(missing.message, 'Add "smd: 1" to the front matter so tools know which Styled Markdown version this file targets.', 'unchanged in 2.0');
});

test('the 1.10 hints can be configured and suppressed like other rules', () => {
  const text = doc('::::note\n[a]{color=red color=blue}\n:::\n\n## A {}\n\n:::agent{priority=high}\nx\n:::');
  const codes = (options: ValidateOptions = {}, t = text) => found(validateSmd(t, options));
  assert.deepEqual(codes(), ['5:attrs/duplicate:hint', '6:container/colons:hint', '8:heading/attrs-text:hint', '10:deprecated/agent-priority:hint']);
  assert.deepEqual(codes({ rules: { 'attrs/duplicate': 'off', 'heading/*': 'warning', 'deprecated/*': 'off' } }),
    ['6:container/colons:hint', '8:heading/attrs-text:warning']);
  assert.deepEqual(codes({ rules: { 'container/colons': 'error' } })[1], '6:container/colons:error');
  const suppressed = text.replace('## A {}', '<!-- smd-disable-next-line heading/attrs-text -->\n## A {}').replace(':::agent{', '<!-- smd-disable-next-line deprecated/* -->\n:::agent{');
  assert.deepEqual(codes({}, suppressed), ['5:attrs/duplicate:hint', '6:container/colons:hint']);
});

test('no 1.10 hint is an error or a warning by default, so documents that pass --strict still do (frontmatter/version is a warning since 2.0)', () => {
  const corpus = path.join(__dirname, 'compat', 'corpus');
  const options: ValidateOptions = { readFile: (p) => { try { return fs.readFileSync(path.join(corpus, p), 'utf8'); } catch { return undefined; } } };
  const seen = new Set<string>();
  for (const name of ['v2-hints.smd', 'smd-version.smd']) {
    for (const d of validateSmd(fs.readFileSync(path.join(corpus, name), 'utf8'), options)) {
      if (!V2_CODES.includes(d.code)) continue;
      seen.add(d.code);
      // The RFC's versioning rules make an invalid `smd` value a warning in 2.0 (smd-version.smd says `smd: 1.0`).
      const expected = d.code === 'frontmatter/version' ? ['warning'] : ['hint', 'info'];
      assert.ok(expected.includes(d.severity), `${name}: ${d.code} is ${d.severity}`);
    }
  }
  assert.deepEqual([...seen].sort(), [...V2_CODES].sort(), 'the corpus documents pin every case');
});
