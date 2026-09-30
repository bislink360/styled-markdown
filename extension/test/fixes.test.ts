import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFixes, validateSmd, type Diagnostic } from '../src/core';
import { normalizeDate, uniqueSuggestion } from '../src/core/fixes';

const options = { today: '2026-09-01' };
const withCode = (text: string, code: string) => validateSmd(text, options).filter((d) => d.code === code);

/** Every `code` diagnostic in `src` has a fix; applying them gives `expected`, which no longer has the problem. */
function assertFixes(code: string, src: string, expected: string): void {
  const found = withCode(src, code);
  assert.ok(found.length, `${code} is reported`);
  assert.ok(found.every((d) => d.fix), `every ${code} has a fix`);
  assert.equal(applyFixes(src, found).text, expected);
  assert.deepEqual(withCode(expected, code), [], `${code} is gone after fixing`);
}

/** `code` is reported for `src`, without a fix. */
function assertNoFix(code: string, src: string): void {
  const found = withCode(src, code);
  assert.ok(found.length, `${code} is reported`);
  assert.deepEqual(found.map((d) => d.fix), found.map(() => undefined), `${code} has no fix for ${JSON.stringify(src)}`);
}

test('uniqueSuggestion only answers when one candidate is closest', () => {
  assert.equal(uniqueSuggestion('aproved', ['draft', 'approved', 'archived']), 'approved');
  assert.equal(uniqueSuggestion('Dark', ['auto', 'light', 'dark']), 'dark');
  assert.equal(uniqueSuggestion('P5', ['P0', 'P1', 'P2', 'P3', 'P4']), undefined, 'a tie');
  assert.equal(uniqueSuggestion('zzzzzz', ['red', 'blue']), undefined, 'nothing close');
});

test('normalizeDate only rewrites year-first dates', () => {
  assert.equal(normalizeDate('2026/9/5'), '2026-09-05');
  assert.equal(normalizeDate('2026.10.15'), '2026-10-15');
  assert.equal(normalizeDate('09/05/2026'), undefined, 'day and month order is ambiguous');
  assert.equal(normalizeDate('2026-13-01'), undefined);
});

test('fix: frontmatter/status, frontmatter/audience and frontmatter/value (close enum match)', () => {
  assertFixes('frontmatter/status', '---\nsmd: 1\nstatus: aproved\n---\n', '---\nsmd: 1\nstatus: approved\n---\n');
  assertFixes('frontmatter/status', '---\nsmd: 1\nstatus: "reveiw" # soon\n---\n', '---\nsmd: 1\nstatus: "review" # soon\n---\n');
  assertFixes('frontmatter/audience', '---\nsmd: 1\naudience: agent\n---\n', '---\nsmd: 1\naudience: agents\n---\n');
  assertFixes('frontmatter/value', '---\nsmd: 1\ntheme: Dark\n---\n', '---\nsmd: 1\ntheme: dark\n---\n');
  assertNoFix('frontmatter/status', '---\nsmd: 1\nstatus: shipped\n---\n');
});

test('fix: frontmatter/accent (misspelled named color)', () => {
  assertFixes('frontmatter/accent', '---\nsmd: 1\naccent: bleu\n---\n', '---\nsmd: 1\naccent: blue\n---\n');
  assertNoFix('frontmatter/accent', '---\nsmd: 1\naccent: "#12345"\n---\n');
});

test('fix: frontmatter/type (boolean written as a string)', () => {
  assertFixes('frontmatter/type', '---\nsmd: 1\ntoc: "true"\n---\n', '---\nsmd: 1\ntoc: true\n---\n');
  assertFixes('frontmatter/type', '---\nsmd: 1\ntoc: no\n---\n', '---\nsmd: 1\ntoc: false\n---\n');
  assertNoFix('frontmatter/type', '---\nsmd: 1\ntoc: maybe\n---\n');
  assertNoFix('frontmatter/type', '---\nsmd: 1\ntags: {a: 1}\n---\n');
});

test('fix: frontmatter/date (year-first date with other separators)', () => {
  assertFixes('frontmatter/date', '---\nsmd: 1\nupdated: 2026/9/5\n---\n', '---\nsmd: 1\nupdated: 2026-09-05\n---\n');
  assertNoFix('frontmatter/date', '---\nsmd: 1\nupdated: 09/05/2026\n---\n');
});

test('fix: container/unclosed (closing line at the end, where the container already ends)', () => {
  assertFixes('container/unclosed', ':::note\nbody\n', ':::note\nbody\n:::\n');
  assertFixes('container/unclosed', '::::card A\n:::note\nx', '::::card A\n:::note\nx\n:::\n::::');
  // Indented, it may belong to a list that ends it sooner; with a code block open, the closing would land inside it.
  assertNoFix('container/unclosed', '- item\n   :::note\n   body\n');
  assertNoFix('container/unclosed', ':::note\n```\ncode\n');
});

test('fix: fence/unclosed (closing fence at the end, where the code block already ends)', () => {
  assertFixes('fence/unclosed', '# A\n\n```ts\nconst a = 1;\n', '# A\n\n```ts\nconst a = 1;\n```\n');
  assertFixes('fence/unclosed', '~~~~\ncode', '~~~~\ncode\n~~~~');
  assertNoFix('fence/unclosed', '- item\n  ```ts\n  code\n');
});

test('fix: attrs/value (enum, color, style, date and priority typos)', () => {
  assertFixes('attrs/value', ':::decision{status="acepted" date=2026/9/1}\nx\n:::\n', ':::decision{status="accepted" date=2026-09-01}\nx\n:::\n');
  assertFixes('attrs/value', ':::card{accent=gren}\nx\n:::\n', ':::card{accent=green}\nx\n:::\n');
  assertFixes('attrs/value', ':::note{color=bleu weight=bld}\nx\n:::\n', ':::note{color=blue weight=bold}\nx\n:::\n');
  assertFixes('attrs/value', 'A [b]{color=blu size=lrg}', 'A [b]{color=blue size=lg}');
  assertFixes('attrs/value', ':metric[4]{label=x trend=Up} :badge[y]{color=gren}', ':metric[4]{label=x trend=up} :badge[y]{color=green}');
  assertFixes('attrs/value', ':priority[hgh] and :due[2026/10/5]', ':priority[high] and :due[2026-10-05]');
  assertFixes('attrs/value', '## Two {agent=skp}', '## Two {agent=skip}');
  assertNoFix('attrs/value', ':priority[P5]');
  assertNoFix('attrs/value', ':progress{value=140}');
  assertNoFix('attrs/value', '[x]{color="#12"}');
});

test('fix: attrs/unknown (misspelled attribute name)', () => {
  assertFixes('attrs/unknown', ':::card{colr=red}\nx\n:::\n', ':::card{color=red}\nx\n:::\n');
  assertFixes('attrs/unknown', 'A [word]{colr=red} :badge[x]{colr=red}', 'A [word]{color=red} :badge[x]{color=red}');
  assertFixes('attrs/unknown', '# Title {agnet=skip}', '# Title {agent=skip}');
  // Renaming would overwrite a value that is already set, or there is no close name.
  assertNoFix('attrs/unknown', '[x]{color=red colr=blue}');
  assertNoFix('attrs/unknown', '[x]{emphasis=yes}');
});

test('applyFixes: several fixes in one document, adjacent edits, and one pass per line', () => {
  const src = [
    '---', 'status: aproved', 'toc: yes', 'accent: bleu', 'titel: Plan', '---',
    ':::decision{status=acepted date=2026/9/1}', 'A [b]{color=blu size=lrg} :priority[hgh]', '',
    ':::warnign', 'x', ':::', '', ':::note', '```ts', 'code',
  ].join('\n');
  const diagnostics = validateSmd(src, options);
  const result = applyFixes(src, diagnostics);
  assert.equal(result.applied, diagnostics.filter((d) => d.fix).length, 'no fix overlaps another');
  assert.equal(result.text, [
    '---', 'smd: 1', 'status: approved', 'toc: true', 'accent: blue', 'title: Plan', '---',
    ':::decision{status=accepted date=2026-09-01}', 'A [b]{color=blue size=lg} :priority[high]', '',
    ':::warning', 'x', ':::', '', ':::note', '```ts', 'code', '```',
  ].join('\n'));
  // The code block had to close first; the next round closes both open containers, then nothing is left to fix.
  const second = applyFixes(result.text, validateSmd(result.text, options));
  assert.equal(second.text, `${result.text}\n:::\n:::`);
  const left = validateSmd(second.text, options);
  assert.deepEqual(left.filter((d) => d.fix), []);
  assert.equal(applyFixes(second.text, left).applied, 0);
});

test('applyFixes: CRLF is kept, overlapping edits apply once, insertions at one point close the innermost first', () => {
  assert.equal(applyFixes('---\r\nsmd: 1\r\nstatus: aproved\r\n---\r\n:::note\r\nx\r\n', validateSmd('---\r\nsmd: 1\r\nstatus: aproved\r\n---\r\n:::note\r\nx\r\n', options)).text,
    '---\r\nsmd: 1\r\nstatus: approved\r\n---\r\n:::note\r\nx\r\n:::\r\n');
  const fix = { line: 0, column: 0, endColumn: 3, replacement: 'b', title: 't' };
  const diagnostic = (line: number, f: Diagnostic['fix']): Diagnostic => ({ line, column: 0, endColumn: 1, severity: 'warning', code: 'x/y', message: '', fix: f });
  assert.deepEqual(applyFixes('aaa', [diagnostic(0, fix), diagnostic(0, { ...fix, replacement: 'c' })]), { text: 'b', applied: 1 });
  const close = (line: number, closing: string) => diagnostic(line, { line: 2, column: 0, endColumn: 0, replacement: `${closing}\n`, title: 't' });
  // Given in any order, the block opened later is closed first.
  assert.equal(applyFixes('::::a\n:::b\n', [close(1, ':::'), close(0, '::::')]).text, '::::a\n:::b\n:::\n::::\n');
});

const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd validate --fix repeats until nothing is left to fix', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-fix-'));
  const file = join(dir, 'doc.smd');
  writeFileSync(file, '---\nsmd: 1\nstatus: aproved\n---\n:::note\n```ts\ncode\n');
  const out = execFileSync(process.execPath, [cli, 'validate', '--fix', '--json', '--no-mermaid', file], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.files[0].fixed, 3);
  assert.deepEqual(report.files[0].diagnostics, []);
  assert.equal(readFileSync(file, 'utf8'), '---\nsmd: 1\nstatus: approved\n---\n:::note\n```ts\ncode\n```\n:::\n');
  rmSync(dir, { recursive: true, force: true });
});
