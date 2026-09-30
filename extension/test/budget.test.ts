import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentView, estimateTokens, outline, type Tokenizer } from '../src/core';
import { loadTokenizer, TokenizerError } from '../src/tokenizer';

const words = (n: number, word = 'lorem') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');

const lines = [
  '---', 'title: Plan', 'summary: Ship the plan.', '---', '# Plan', '',
  'Intro text stays.', '',
  '## Background', '', words(80, 'bg'), '',
  '### History', '', words(160, 'hist'), '',
  '## Tasks', '', '- [ ] Open task', words(60, 'task'), '',
  '## Constraints', '', ':::agent Rules', 'Never use floats.', ':::', '', words(80, 'rule'), '',
  '## Diagram', '', '```mermaid', 'graph TD', ...Array.from({ length: 40 }, (_, i) => `  N${i} --> N${i + 1}`), '```', '',
  '## Appendix', '', words(120, 'app'), '',
];
const doc = lines.join('\n');
const lineOf = (heading: string) => lines.indexOf(heading);
const full = agentView(doc);
const brief = agentView(doc, { brief: true });
const budgeted = (maxTokens: number, options = {}) => agentView(doc, { maxTokens, ...options });
const omitted = (maxTokens: number, options = {}) => budgeted(maxTokens, options).budget?.omitted.map((o) => o.heading);

test('a view that fits is unchanged', () => {
  const r = budgeted(full.tokens);
  assert.equal(r.text, full.text);
  assert.deepEqual(r.budget, { maxTokens: full.tokens, tokens: full.tokens, fits: true, condensed: false, omitted: [] });
  assert.equal(agentView(doc).budget, undefined);
});

test('condensing as brief comes first', () => {
  assert.ok(brief.tokens < full.tokens - 50);
  const r = budgeted(brief.tokens);
  assert.equal(r.text, brief.text);
  assert.deepEqual([r.budget?.condensed, r.budget?.fits, r.budget?.omitted], [true, true, []]);
  // Already brief: nothing to condense.
  assert.equal(budgeted(brief.tokens, { brief: true }).budget?.condensed, false);
});

test('sections are omitted least important first: deepest, largest, then those with key content', () => {
  // Each step: a budget one token under the previous step's view.
  const steps: string[][] = [];
  for (let max = brief.tokens - 1; ;) {
    const r = budgeted(max);
    steps.push(r.budget?.omitted.map((o) => o.heading) ?? []);
    if (!r.budget?.fits) break;
    max = r.tokens - 1;
  }
  assert.deepEqual(steps, [
    ['History'], // deepest first
    ['Background'], // then the largest level-2 section; its pointer replaces its subsection's
    ['Background', 'Appendix'],
    ['Background', 'Tasks', 'Appendix'], // Tasks has an open task, so it goes last
    ['Background', 'Tasks', 'Appendix'], // Constraints (agent instructions) and Diagram (condensed, small) stay
  ]);
  assert.deepEqual(omitted(1), ['Background', 'Tasks', 'Appendix']);
});

test('the header, intro, agent instructions and requested sections are never omitted', () => {
  const r = budgeted(1);
  assert.match(r.text, /^# Plan\nsummary: Ship the plan\.\n\n# Plan {2}\[L5\]\n\nIntro text stays\./);
  assert.match(r.text, /## Constraints {2}\[L\d+\]\n\n<agent-instructions title="Rules">\nNever use floats\.\n<\/agent-instructions>/);
  assert.equal(r.budget?.tokens, r.tokens);
  const excerpt = budgeted(1, { sections: ['background'] });
  assert.deepEqual([excerpt.budget?.omitted, excerpt.budget?.fits], [[], false]);
  assert.match(excerpt.text, /hist159/);
});

test('omitted sections leave a pointer saying how to read them', () => {
  const r = budgeted(brief.tokens - 1, { file: 'docs/plan.smd' });
  const [history] = r.budget?.omitted ?? [];
  const start = lineOf('### History');
  assert.deepEqual({ ...history, tokens: 0 }, { heading: 'History', level: 3, line: start, endLine: lineOf('## Tasks') - 1, tokens: 0 });
  const pointer = `[section omitted: ### History, L${start + 1}-L${lineOf('## Tasks')}, ≈${history.tokens} tokens — smd agent docs/plan.smd --section "History"]`;
  assert.ok(r.text.includes(`bg79\n\n${pointer}\n\n## Tasks`), r.text);
  assert.doesNotMatch(r.text, /hist0/);
  assert.match(budgeted(brief.tokens - 1).text, /— smd agent <file> --section "History"\]/);
  assert.match(budgeted(brief.tokens - 1, { file: 'my plan.smd' }).text, /— smd agent "my plan\.smd" --section "History"\]/);
  // A trailing section's pointer ends the view.
  assert.match(budgeted(1).text, /\n\n\[section omitted: ## Appendix, L76-L79, [^\n]*\]\n$/);
});

const wordCounter: Tokenizer = { name: 'words', count: (text) => text.split(/\s+/).filter(Boolean).length };

test('a tokenizer adds exact counts and is used for the budget', () => {
  const r = agentView(doc, { tokenizer: wordCounter });
  assert.equal(r.text, full.text);
  assert.deepEqual(r.counted, { tokenizer: 'words', tokens: wordCounter.count(full.text), originalTokens: wordCounter.count(doc) });
  const fit = agentView(doc, { tokenizer: wordCounter, maxTokens: wordCounter.count(brief.text) });
  assert.deepEqual([fit.budget?.condensed, fit.budget?.omitted, fit.budget?.tokens], [true, [], wordCounter.count(brief.text)]);
  assert.ok(estimateTokens(brief.text) > wordCounter.count(brief.text), 'counted in words, not the estimate');
});

test('outline shows exact counts next to the estimate', () => {
  assert.equal(outline(doc, { maxTokens: 1 }), outline(doc));
  const o = outline(doc, { tokenizer: wordCounter });
  assert.match(o, /^Plan · file ≈\d+ est · \d+ words tokens · full agent view ≈\d+ est · \d+ words tokens\n/);
  assert.match(o, /### History\s+≈\d+ · 162\n/);
});

/** A folder with a stand-in js-tiktoken package that counts space-separated words. */
function fakeTiktoken(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smd-tiktoken-'));
  const pkg = join(dir, 'node_modules', 'js-tiktoken');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'js-tiktoken', version: '0.0.0', main: 'index.js' }));
  writeFileSync(join(pkg, 'index.js'), 'exports.getEncoding = (name) => ({ encode: (text) => text.split(" ").map(() => name.length) });\n');
  return dir;
}

test('loadTokenizer resolves js-tiktoken at run time, or says how to install it', () => {
  const tokenizer = loadTokenizer('cl100k_base', { paths: [fakeTiktoken()] });
  assert.deepEqual([tokenizer.name, tokenizer.count('a b c')], ['cl100k_base', 3]);
  const empty = mkdtempSync(join(tmpdir(), 'smd-empty-'));
  assert.throws(() => loadTokenizer('o200k_base', { paths: [empty] }),
    (e: Error) => e instanceof TokenizerError && /needs the js-tiktoken package[^]*npm install --save-dev js-tiktoken/.test(e.message));
  assert.throws(() => loadTokenizer('gpt-9', { paths: [empty] }), /Unknown tokenizer "gpt-9"\. Available: o200k_base, cl100k_base/);
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
const example = join(__dirname, '..', '..', 'examples', 'checkout-redesign.smd');
const run = (args: string[], cwd?: string) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd });

test('CLI: smd agent --max-tokens and --tokenizer', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const r = run(['agent', example, '--max-tokens', '700', '--today', '2026-09-29']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[section omitted: ## Architecture, L90-L128, ≈\d+ tokens — smd agent .*checkout-redesign\.smd --section "Architecture"\]/);
  assert.match(r.stderr, /\[smd\] budget 700 tokens: condensed as --brief; omitted \d section\(s\): [^\n]*## Architecture \(≈\d+\)[^\n]*; now ≈\d+ tokens\./);
  const tight = run(['agent', example, '--max-tokens', '10']);
  assert.equal(tight.status, 0);
  assert.match(tight.stderr, /warning: still over the budget of 10 tokens/);
  assert.equal(run(['agent', example, '--max-tokens', '0']).status, 2);

  // The tokenizer package comes from the working directory, not the bundle.
  const withPackage = run(['agent', example, '--tokenizer', 'o200k_base', '--max-tokens', '400'], fakeTiktoken());
  assert.equal(withPackage.status, 0, withPackage.stderr);
  assert.match(withPackage.stderr, /^\[smd\] ≈\d+ est · \d+ o200k_base tokens \(file ≈\d+ est · \d+ o200k_base, \d+% smaller\)\n\[smd\] budget 400 o200k_base tokens: /);
  const outlined = run(['outline', example, '--tokenizer', 'o200k_base'], fakeTiktoken());
  assert.match(outlined.stdout, /file ≈\d+ est · \d+ o200k_base tokens/);
  let installed = true;
  try { loadTokenizer('o200k_base'); } catch { installed = false; }
  if (!installed) {
    const missing = run(['agent', example, '--tokenizer', 'o200k_base'], mkdtempSync(join(tmpdir(), 'smd-empty-')));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /needs the js-tiktoken package/);
  }
});
