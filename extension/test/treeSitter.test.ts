// The Tree-sitter grammar in integrations/tree-sitter-smd: its queries name the same containers and
// directives as spec.ts, its name patterns accept them, and (when tree-sitter-cli is installed there)
// every .smd file in the repository parses without ERROR nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINERS, INLINE_DIRECTIVES } from '../src/core/spec';

const grammarDir = join(__dirname, '..', '..', 'integrations', 'tree-sitter-smd');
const UTF8 = 'utf8';
const highlights = readFileSync(join(grammarDir, 'queries', 'highlights.scm'), UTF8);
const grammarRules = JSON.parse(readFileSync(join(grammarDir, 'src', 'grammar.json'), UTF8)).rules as Record<
  string,
  { type: string; value: string }
>;

interface NameList {
  negated: boolean;
  names: string[];
}

/** The `(#any-of? …)` and `(#not-any-of? …)` name lists that highlights.scm applies to a node type. */
function nameLists(nodeType: string): NameList[] {
  const pattern = new RegExp(String.raw`\(\(${nodeType}\) @([\w.]+)\s*\(#(not-)?any-of\? @\1((?:\s+"[^"]*")+)\)\)`, 'g');
  return [...highlights.matchAll(pattern)].map((m) => ({
    negated: m[2] === 'not-',
    names: [...m[3].matchAll(/"([^"]*)"/g)].map((n) => n[1]),
  }));
}

function assertSameNames(nodeType: string, expected: string[]) {
  const lists = nameLists(nodeType);
  assert.deepEqual(lists.map((l) => l.negated).sort((a, b) => Number(a) - Number(b)), [false, true],
    `highlights.scm should have one any-of and one not-any-of list for ${nodeType}`);
  for (const list of lists) {
    assert.deepEqual([...list.names].sort((a, b) => a.localeCompare(b)), [...expected].sort((a, b) => a.localeCompare(b)),
      `${list.negated ? 'not-any-of' : 'any-of'} names for ${nodeType} differ from spec.ts`);
  }
}

function grammarPattern(rule: string): RegExp {
  const node = grammarRules[rule];
  assert.equal(node?.type, 'PATTERN', `grammar rule ${rule} should be a pattern`);
  return new RegExp(`^(?:${node.value})$`);
}

test('tree-sitter: highlights.scm knows exactly the containers in spec.ts', () => {
  assertSameNames('container_name', Object.keys(CONTAINERS));
});

test('tree-sitter: highlights.scm knows exactly the inline directives in spec.ts', () => {
  assertSameNames('directive_name', Object.keys(INLINE_DIRECTIVES));
});

test('tree-sitter: the grammar accepts every container and directive name', () => {
  const container = grammarPattern('container_name');
  for (const name of Object.keys(CONTAINERS)) assert.match(name, container);
  const directive = grammarPattern('directive_name');
  for (const name of Object.keys(INLINE_DIRECTIVES)) assert.match(name, directive);
});

const cli = join(grammarDir, 'node_modules', 'tree-sitter-cli', 'cli.js');
const binary = ['tree-sitter', 'tree-sitter.exe'].some((name) => existsSync(join(grammarDir, 'node_modules', 'tree-sitter-cli', name)));
const skip = !(existsSync(cli) && binary) && 'tree-sitter-cli is not installed (npm ci in integrations/tree-sitter-smd)';

test('tree-sitter: every .smd file in the repository parses without errors', { skip, timeout: 300_000 }, () => {
  const result = spawnSync(process.execPath, [join(grammarDir, 'scripts', 'parse-all.mjs')], { encoding: UTF8 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
