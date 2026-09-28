import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkMermaid, mermaidBlocks, type MermaidParse } from '../src/core';

const bundle = path.join(__dirname, '..', 'dist', 'mermaid-parse.js');
const examplesDir = path.join(__dirname, '..', '..', 'examples');

test('mermaidBlocks finds diagrams with a known type', () => {
  const src = [
    '---', 'title: T', '---', '',
    '```mermaid', 'flowchart LR', '  A --> B', '```', '',
    '~~~mermaid', '%% comment', '---', 'config: {}', '---', 'sequenceDiagram', '~~~', '',
    '```mermaid', 'flowchat LR', '```', '',
    '```mermaid', '```', '',
    '```js', 'flowchart LR', '```',
  ].join('\n');
  assert.deepEqual(mermaidBlocks(src).map((b) => [b.line, b.source.split('\n')[0]]), [[5, 'flowchart LR'], [10, '%% comment']]);
});

test('parse errors map to the document line and columns', async () => {
  const src = 'Intro\n\n```mermaid\nsequenceDiagram\n  A->>B hi\n```\n';
  const jison: MermaidParse = async () => {
    throw Object.assign(new Error('Parse error'), { hash: { loc: { first_line: 2, last_line: 2, first_column: 5, last_column: 9 }, token: 'NEWLINE', expected: ["'TXT'"] } });
  };
  assert.deepEqual(await checkMermaid(src, jison), [{
    line: 4, column: 5, endColumn: 9, severity: 'error', code: 'mermaid/syntax',
    message: 'Mermaid syntax error: expected TXT, got end of line.',
  }]);

  const langium: MermaidParse = async () => {
    throw { result: { lexerErrors: [], parserErrors: [{ message: "Expecting token of type ':' but found `1`.", token: { startLine: 2, startColumn: 7, endColumn: 7 } }] } };
  };
  const pie = '```mermaid\npie title X\n  "a" 1\n```';
  assert.deepEqual(await checkMermaid(pie, langium), [{
    line: 2, column: 6, endColumn: 7, severity: 'error', code: 'mermaid/syntax',
    message: "Mermaid syntax error: Expecting token of type ':' but found `1`.",
  }]);

  // An error at the end of the diagram points at its last non-blank line.
  const eof: MermaidParse = async () => {
    throw Object.assign(new Error('x'), { hash: { loc: { first_line: 2, last_line: 4, first_column: 3, last_column: 0 }, token: 1, expected: ["'SQE'", "'PE'", "'TAGEND'", "'PIPE'", "'TEXT'"] } });
  };
  const [d] = await checkMermaid('```mermaid\nflowchart LR\n  A[open --> B\n\n```', eof);
  assert.deepEqual([d.line, d.column, d.endColumn], [2, 2, 14]);
  assert.equal(d.message, 'Mermaid syntax error: expected SQE, PE, TAGEND, PIPE…, got end of diagram.');

  // Anything else is reported on the diagram's first line.
  const odd: MermaidParse = async () => { throw new Error('Parsing failed: something odd\nmore'); };
  const [o] = await checkMermaid('```mermaid\n  flowchart LR\n```', odd);
  assert.deepEqual([o.line, o.column, o.endColumn, o.message], [1, 2, 14, 'Mermaid syntax error: something odd']);
});

test('the bundled Mermaid parser accepts every example and reports real errors', { skip: !fs.existsSync(bundle) && 'run npm run build first' }, async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parse } = require(bundle) as { parse: MermaidParse };
  for (const file of fs.readdirSync(examplesDir).filter((f) => f.endsWith('.smd'))) {
    assert.deepEqual(await checkMermaid(fs.readFileSync(path.join(examplesDir, file), 'utf8'), parse), [], file);
  }
  const broken = [
    '```mermaid', 'flowchart LR', '  A --> B', '  B -->> C', '```', '',
    '```mermaid', 'pie title Split', '  "a" : 1', '  "b" 2', '```', '',
    '```mermaid', 'classDiagram', '  class A', '```',
  ].join('\n');
  const found = await checkMermaid(broken, parse);
  assert.deepEqual(found.map((d) => [d.line, d.code]), [[3, 'mermaid/syntax'], [9, 'mermaid/syntax']]);
});
