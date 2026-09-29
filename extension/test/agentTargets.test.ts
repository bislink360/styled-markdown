import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copilotInstructions, cursorRule, parseTargets, rulesBody, upsertSection, SECTION_END, SECTION_START,
} from '../src/agentTargets';

const cli = join(__dirname, '..', 'dist', 'cli.js');
const skip = !existsSync(cli) && 'run npm run build first';
const rulesSource = readFileSync(join(__dirname, '..', '..', 'skills', 'agent-rules.md'), 'utf8');
const body = rulesBody(rulesSource);

function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'skills', 'install', ...args], { cwd, encoding: 'utf8' });
}

function frontMatter(text: string): string[] {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'front matter');
  return m[1].split('\n');
}

const count = (text: string, part: string) => text.split(part).length - 1;

test('parseTargets: default, commas, repeats, duplicates and unknown names', () => {
  assert.deepEqual(parseTargets([]), ['claude']);
  assert.deepEqual(parseTargets(['cursor,Copilot', 'agents', 'cursor']), ['cursor', 'copilot', 'agents']);
  assert.throws(() => parseTargets(['cursor,windsurf']), /Unknown --target "windsurf"\. Use claude, cursor, copilot, agents/);
});

test('rules body: one source, CLI command filled in', () => {
  assert.doesNotMatch(body, /\{\{smd\}\}/);
  assert.match(body, /^## Styled Markdown \(\.smd\)/);
  assert.match(body, /`node \.smd\/smd\.cjs outline <file>`/);
  assert.ok(cursorRule(body).endsWith(body));
  assert.ok(copilotInstructions(body).endsWith(body));
});

test('cursor and copilot files have the expected front matter', () => {
  assert.deepEqual(frontMatter(cursorRule(body)), [
    'description: Read and write Styled Markdown (.smd) files with the smd CLI', 'globs: **/*.smd', 'alwaysApply: false',
  ]);
  assert.deepEqual(frontMatter(copilotInstructions(body)), [
    'description: "Read and write Styled Markdown (.smd) files with the smd CLI"', 'applyTo: "**/*.smd"',
  ]);
});

test('AGENTS.md section: created, appended, replaced in place, never duplicated', () => {
  const created = upsertSection(undefined, body);
  assert.ok(created.startsWith(`${SECTION_START}\n`));
  assert.ok(created.endsWith(`${SECTION_END}\n`));

  const user = '# My agents\n\nUse pnpm.\n';
  const appended = upsertSection(user, body);
  assert.ok(appended.startsWith('# My agents\n\nUse pnpm.\n\n<!-- styled-markdown:start -->'));

  const edited = appended.replace('Use pnpm.', 'Use pnpm.\n\nMore rules.') + '\n## Later\n\nKept.\n';
  const stale = edited.replace('### Reading', '### Old reading');
  const again = upsertSection(stale, body);
  assert.equal(again, edited);
  assert.equal(count(again, SECTION_START), 1);
  assert.equal(count(again, SECTION_END), 1);
  assert.equal(upsertSection(again, body), again);
});

test('AGENTS.md section keeps CRLF line endings and rejects broken markers', () => {
  const crlf = upsertSection('# Rules\r\n\r\nBe nice.\r\n', body);
  assert.doesNotMatch(crlf.replace(/\r\n/g, ''), /\n/);
  assert.throws(() => upsertSection(`x\n${SECTION_START}\nhalf\n`, body), /broken styled-markdown section/);
  assert.throws(() => upsertSection(`${SECTION_END}\n${SECTION_START}\n`, body), /broken styled-markdown section/);
});

test('CLI: skills install --target writes each target and the shared CLI', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'smd-targets-'));
  const res = run(root, '--target', 'cursor,copilot', '--target', 'agents');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Installed smd CLI → .*smd\.cjs/);
  assert.match(res.stdout, /Created .*styled-markdown\.mdc {2}\(Cursor rule for \*\*\/\*\.smd\)/);
  assert.match(res.stdout, /Created .*AGENTS\.md {2}\(styled-markdown section\)/);
  assert.equal(readFileSync(join(root, '.cursor', 'rules', 'styled-markdown.mdc'), 'utf8'), cursorRule(body));
  assert.equal(readFileSync(join(root, '.github', 'instructions', 'styled-markdown.instructions.md'), 'utf8'), copilotInstructions(body));
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), upsertSection(undefined, body));
  assert.ok(!existsSync(join(root, '.claude')), 'no Claude skills unless asked');
  const version = execFileSync(process.execPath, [join(root, '.smd', 'smd.cjs'), '--version'], { encoding: 'utf8' });
  assert.match(version, /^smd \d/);
});

test('CLI: --target agents twice keeps the user content and one section', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'smd-agents-'));
  writeFileSync(join(root, 'AGENTS.md'), '# Project\n\nRun tests with npm test.\n');
  assert.equal(run(root, '--target', 'agents').status, 0);
  const first = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const second = run(root, '--target', 'agents', '--dir', '.');
  assert.equal(second.status, 0);
  assert.match(second.stdout, /Updated .*AGENTS\.md/);
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(text, first);
  assert.ok(text.startsWith('# Project\n\nRun tests with npm test.\n\n'));
  assert.equal(count(text, SECTION_START), 1);
});

test('CLI: --dir sets the project root for other targets', { skip }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'smd-cwd-'));
  const project = join(cwd, 'project');
  mkdirSync(project);
  assert.equal(run(cwd, '--target', 'copilot', '--dir', 'project').status, 0);
  assert.ok(existsSync(join(project, '.github', 'instructions', 'styled-markdown.instructions.md')));
  assert.ok(existsSync(join(project, '.smd', 'smd.cjs')));
  assert.deepEqual(readdirSync(cwd), ['project']);
});

test('CLI: default and --target claude install the Claude skills as before', { skip }, () => {
  for (const extra of [[], ['--target', 'claude']]) {
    const root = mkdtempSync(join(tmpdir(), 'smd-claude-'));
    const res = run(root, ...extra);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(readdirSync(join(root, '.claude', 'skills')).sort(), ['styled-markdown-reader', 'styled-markdown-writer']);
    assert.deepEqual(readdirSync(root), ['.claude']);
    assert.doesNotMatch(res.stdout, /smd CLI|Created/);
  }
});

test('CLI: claude plus other targets installs both', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'smd-both-'));
  const res = run(root, '--target', 'claude,cursor', '--only', 'reader');
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readdirSync(join(root, '.claude', 'skills')), ['styled-markdown-reader']);
  assert.ok(existsSync(join(root, '.cursor', 'rules', 'styled-markdown.mdc')));
});

test('CLI: unknown targets and conflicting options are usage errors', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'smd-bad-'));
  const cases: [string[], RegExp][] = [
    [['--target', 'windsurf'], /Unknown --target "windsurf"/],
    [['--target', 'cursor', '--global'], /--global only applies to --target claude/],
    [['--target', 'agents', '--only', 'reader'], /--only only applies to --target claude/],
    [['--target', 'claude,agents', '--dir', 'x'], /--dir is the skills folder for --target claude/],
  ];
  for (const [args, message] of cases) {
    const res = run(root, ...args);
    assert.equal(res.status, 2, args.join(' '));
    assert.match(res.stderr, message);
  }
  assert.deepEqual(readdirSync(root), [], 'nothing written');
});
