import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyFixes, readRuleConfig, RULE_CODES, validateSmd, type Diagnostic } from '../src/core';
import { loadRuleConfig } from '../src/config';

const found = (diagnostics: Diagnostic[]) => diagnostics.map((d) => `${d.line}:${d.code}:${d.severity}`);
// Line 0 has container/unknown (warning), line 1 attrs/value (error).
const src = ':::warnign\nA [word]{color=blu}\n:::\n';

test('every code the validator reports is registered, and the schema lists them all', () => {
  const sources = ['validate.ts', 'rules.ts', 'mermaid.ts'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'core', f), 'utf8')).join('\n');
  const emitted = new Set([...sources.matchAll(/'((?:frontmatter|container|attrs|directive|mermaid|math|fence|link|footnote|task|rules)\/[a-z-]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...emitted].sort(), Object.keys(RULE_CODES).sort());

  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'smd-config.schema.json'), 'utf8'));
  const keys = Object.keys(schema.properties.rules.properties);
  const categories = [...new Set(Object.keys(RULE_CODES).map((c) => `${c.split('/')[0]}/*`))];
  assert.deepEqual(keys.sort(), ['*', ...categories, ...Object.keys(RULE_CODES)].sort());
});

test('rule settings turn rules off and change severities; the most specific key wins', () => {
  assert.deepEqual(found(validateSmd(src)), ['0:container/unknown:warning', '1:attrs/value:error']);
  assert.deepEqual(found(validateSmd(src, { rules: { 'container/unknown': 'off' } })), ['1:attrs/value:error']);
  assert.deepEqual(found(validateSmd(src, { rules: { 'attrs/*': 'hint', 'container/unknown': 'error' } })),
    ['0:container/unknown:error', '1:attrs/value:hint']);
  assert.deepEqual(found(validateSmd(src, { rules: { '*': 'off', 'attrs/value': 'warning' } })), ['1:attrs/value:warning']);
  assert.deepEqual(found(validateSmd(src, { rules: { '*': 'info', 'attrs/*': 'off' } })), ['0:container/unknown:info']);
});

test('readRuleConfig reports unknown rules and settings', () => {
  assert.deepEqual(readRuleConfig({ rules: { 'link/*': 'off', 'task/overdue': 'error' } }), { rules: { 'link/*': 'off', 'task/overdue': 'error' }, problems: [] });
  const { rules, problems } = readRuleConfig({ rules: { 'link/mising-file': 'off', 'attrs/value': 'loud', 'nope/*': 'off' } });
  assert.deepEqual(rules, {});
  assert.deepEqual(problems, [
    'Unknown rule "link/mising-file" — did you mean "link/missing-file"?',
    'Rule "attrs/value" must be one of: off, error, warning, info, hint.',
    'Unknown rule "nope/*".',
  ]);
  assert.deepEqual(readRuleConfig([]).problems, ['The config must be a JSON object.']);
  assert.deepEqual(readRuleConfig({}), { rules: {}, problems: [] });
});

test('suppression comments: next line, same line, ranges', () => {
  const codes = (text: string) => found(validateSmd(text)).map((f) => f.replace(/:(error|warning|info|hint)$/, ''));
  assert.deepEqual(codes(`<!-- smd-disable-next-line container/unknown -->\n${src}`), ['2:attrs/value']);
  assert.deepEqual(codes(`<!-- smd-disable-next-line -->\n${src}`), ['2:attrs/value'], 'no codes: every rule, next line only');
  assert.deepEqual(codes(':::warnign <!-- smd-disable-line -->\nA [word]{color=blu} <!-- smd-disable-line attrs/* -->\n:::\n'), []);
  assert.deepEqual(codes('<!-- smd-disable attrs/value, container/unknown -->\n:::warnign\n[a]{color=blu}\n<!-- smd-enable attrs/value -->\n[b]{color=blu}\n:::warnign\nx\n:::\n:::\n'),
    ['4:attrs/value'], 'enable lifts only the listed code');
  // Comments inside code are not directives.
  assert.deepEqual(codes('```html\n<!-- smd-disable -->\n```\n:::warnign\nx\n:::\n'), ['3:container/unknown']);
});

test('unknown codes in suppression comments are reported with a fix', () => {
  const text = '<!-- smd-disable-next-line containr/unknown -->\n:::warnign\nx\n:::\n';
  const diags = validateSmd(text);
  assert.deepEqual(found(diags), ['0:rules/unknown:warning', '1:container/unknown:warning']);
  assert.equal(applyFixes(text, diags.filter((d) => d.code === 'rules/unknown')).text.split('\n')[0], '<!-- smd-disable-next-line container/unknown -->');
});

test('loadRuleConfig uses the nearest config file and stops at the repository root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-rules-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs', 'adr'), { recursive: true });
  fs.writeFileSync(path.join(root, 'smd.config.json'), '{"rules":{"*":"off"}}');
  fs.writeFileSync(path.join(repo, '.smdrc'), '{"rules":{"link/*":"off"}}');
  fs.writeFileSync(path.join(repo, 'docs', 'adr', 'smd.config.json'), '{"rules":{"task/overdue":"error"}}');
  fs.mkdirSync(path.join(repo, 'bad'));
  fs.writeFileSync(path.join(repo, 'bad', 'smd.config.json'), '{ nope');

  const cache = new Map();
  assert.deepEqual(loadRuleConfig(path.join(repo, 'docs', 'adr', 'x.smd'), cache).rules, { 'task/overdue': 'error' });
  assert.deepEqual(loadRuleConfig(path.join(repo, 'docs', 'plan.smd'), cache).rules, { 'link/*': 'off' });
  assert.equal(loadRuleConfig(path.join(repo, 'docs', 'plan.smd'), cache).file, path.join(repo, '.smdrc'));
  assert.match(loadRuleConfig(path.join(repo, 'bad', 'x.smd')).problems[0], /^Not valid JSON/);

  // Outside a repository, a config above the document still applies; inside one, the search stops at .git.
  fs.rmSync(path.join(repo, '.smdrc'));
  assert.deepEqual(loadRuleConfig(path.join(repo, 'docs', 'plan.smd')).rules, {});
  fs.rmSync(path.join(repo, '.git'), { recursive: true });
  assert.deepEqual(loadRuleConfig(path.join(repo, 'docs', 'plan.smd')).rules, { '*': 'off' });
  fs.rmSync(root, { recursive: true, force: true });
});
