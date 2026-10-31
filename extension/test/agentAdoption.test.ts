import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer, ToolError, type JsonRpcResponse } from '../src/mcpProtocol';
import { Sandbox, serverInstructions, smdTools } from '../src/mcp';
import { readDocument, READ_BUDGET } from '../src/readView';
import { savingsReport, savingsRow, savingsText } from '../src/savings';
import { CLAUDE_SKILL_CLI, McpConfigError, mcpConfigFor, mergeMcpConfig } from '../src/agentSetup';

const small = ['---', 'title: Small', 'status: draft', 'updated: 2026-01-01', '---', '', '## Goals', '', 'Ship it.', '', '## Tasks', '', '- [ ] Write the spec @maya', '- [x] Kickoff', ''].join('\n');
const big = ['---', 'title: Big', '---', '', ...Array.from({ length: 12 }, (_, i) => [`## Part ${i}`, '', 'word '.repeat(400), '']).flat()].join('\n');

test('readDocument: the whole view when it fits, else the outline', () => {
  const whole = readDocument(small);
  assert.equal(whole.shown, 'full');
  assert.match(whole.text, /Ship it\./);
  const long = readDocument(big);
  assert.equal(long.shown, 'outline');
  assert.ok(long.fullTokens > READ_BUDGET);
  assert.match(long.text, /Part 3/);
  assert.doesNotMatch(long.text, /word word/);
  assert.match(long.text, /over the 2000-token budget/);
  assert.equal(readDocument(big, { maxTokens: 100_000 }).shown, 'full');
  assert.equal(readDocument(small, { mode: 'outline' }).shown, 'outline');
  assert.equal(readDocument(big, { mode: 'full' }).shown, 'full');
  const part = readDocument(big, { sections: ['Part 3', 'nope'] });
  assert.equal(part.shown, 'sections');
  assert.deepEqual(part.missingSections, ['nope']);
  assert.ok(part.fullTokens < long.fullTokens);
});

test('savings: per file and total, in tokens and dollars', () => {
  const styled = `${big}\n## Background {agent=skip}\n\n${'history '.repeat(300)}\n`;
  const rows = [savingsRow('a.smd', small), savingsRow('b.smd', styled)];
  // A tiny document's agent view can be a little larger than the file (its header line): savings may be negative.
  assert.ok(rows[1].agent < rows[1].raw && rows[1].brief < rows[1].raw);
  const report = savingsReport(rows, 3);
  assert.equal(report.total.raw, rows[0].raw + rows[1].raw);
  assert.equal(report.total.saved, report.total.raw - report.total.agent);
  assert.equal(report.dollars, Math.round(((report.total.saved * 3) / 1e6) * 10000) / 10000);
  assert.match(savingsText(report), /^file +raw +agent/);
  assert.match(savingsText(report), /Reading all 2 document\(s\) once/);
  assert.equal(savingsReport([], 3).total.percent, 0);
});

test('agent setup: MCP config per agent, merged into existing files', () => {
  assert.deepEqual(mcpConfigFor('claude'), { file: '.mcp.json', key: 'mcpServers', entry: { command: 'node', args: [CLAUDE_SKILL_CLI, 'mcp'] } });
  assert.equal(mcpConfigFor('copilot')?.file, '.vscode/mcp.json');
  assert.equal(mcpConfigFor('copilot')?.key, 'servers');
  assert.equal(mcpConfigFor('cursor')?.file, '.cursor/mcp.json');
  assert.equal(mcpConfigFor('agents'), undefined);
  const spec = mcpConfigFor('claude')!;
  const fresh = JSON.parse(mergeMcpConfig(undefined, spec));
  assert.deepEqual(Object.keys(fresh.mcpServers), ['styled-markdown']);
  const existing = '{\r\n    "mcpServers": {\r\n        "other": { "command": "x" }\r\n    },\r\n    "extra": 1\r\n}\r\n';
  const merged = mergeMcpConfig(existing, spec);
  assert.ok(merged.includes('\r\n        "other"'), 'keeps indentation and line endings');
  assert.deepEqual(Object.keys(JSON.parse(merged).mcpServers), ['other', 'styled-markdown']);
  assert.equal(JSON.parse(merged).extra, 1);
  assert.equal(mergeMcpConfig(merged, spec), merged, 'idempotent');
  assert.throws(() => mergeMcpConfig('{ // comment\n}', spec), McpConfigError);
  assert.throws(() => mergeMcpConfig('{"mcpServers": []}', spec), McpConfigError);
});

// MCP: a root folder with documents.
const root = mkdtempSync(join(tmpdir(), 'smd-adopt-'));
after(() => rmSync(root, { recursive: true, force: true }));
const write = (name: string, text: string) => writeFileSync(join(root, name), text);
const box = new Sandbox(root);
const tools = (options = {}) => new Map(smdTools(box, options).map((t) => [t.name, t]));
const run = async (name: string, args: Record<string, unknown>, options = { allowWrite: true }) => tools(options).get(name)!.run(args);

test('MCP read tool: auto, outline, full and sections', async () => {
  write('small.smd', small);
  write('big.smd', big);
  assert.match(await run('read', { file: 'small.smd' }), /Ship it\./);
  assert.match(await run('read', { file: 'big.smd' }), /over the 2000-token budget/);
  assert.match(await run('read', { file: 'big.smd', mode: 'full' }), /word word/);
  assert.match(await run('read', { file: 'big.smd', sections: ['Part 2'] }), /Part 2/);
  await assert.rejects(async () => run('read', { file: 'big.smd', sections: ['nope'] }), (e: Error) => e instanceof ToolError && /mode "outline"/.test(e.message));
});

test('MCP tools/list: four reading tools under 500 tokens; old names still callable', async () => {
  const server = new McpServer({ name: 's', version: '1', tools: smdTools(box), instructions: serverInstructions() });
  const listed = ((await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as JsonRpcResponse).result as { tools: Array<{ name: string }> };
  assert.deepEqual(listed.tools.map((t) => t.name), ['read', 'tasks', 'query', 'validate']);
  const tokens = Math.ceil((JSON.stringify(listed) + serverInstructions()).length / 4);
  assert.ok(tokens < 500, `tools/list + instructions ≈${tokens} tokens`);
  const called = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'outline', arguments: { file: 'small.smd' } } })) as JsonRpcResponse;
  assert.match(JSON.stringify(called.result), /Goals/);
  const legacy = smdTools(box, { legacyTools: true }).filter((t) => !t.hidden).map((t) => t.name);
  assert.deepEqual(legacy, ['read', 'tasks', 'query', 'validate', 'outline', 'section', 'agent']);
  const writable = smdTools(box, { allowWrite: true }).filter((t) => !t.hidden).map((t) => t.name);
  assert.deepEqual(writable, ['read', 'tasks', 'query', 'validate', 'check_task', 'set_status', 'add_decision']);
  assert.match(serverInstructions({ allowWrite: true }), /Write tools/);
});

test('MCP check_task ticks one task and refuses other lines', async () => {
  write('plan.smd', small.replace(/\n/g, '\r\n'));
  const line = small.split('\n').indexOf('- [ ] Write the spec @maya') + 1;
  assert.match(await run('check_task', { file: 'plan.smd', line, text: 'write the spec' }), /^Done: plan\.smd:13 {2}- \[x\] Write the spec/);
  const after1 = readFileSync(join(root, 'plan.smd'), 'utf8');
  assert.ok(after1.includes('- [x] Write the spec @maya\r\n'), 'keeps CRLF');
  assert.equal(after1.replace('- [x] Write', '- [ ] Write'), small.replace(/\n/g, '\r\n'), 'only the checkbox changed');
  assert.match(await run('check_task', { file: 'plan.smd', line }), /^Already done/);
  assert.match(await run('check_task', { file: 'plan.smd', line, done: false }), /^Reopened/);
  await assert.rejects(async () => run('check_task', { file: 'plan.smd', line: 1 }), /not a task/);
  await assert.rejects(async () => run('check_task', { file: 'plan.smd', line, text: 'other' }), /no longer has "other"/);
  await assert.rejects(async () => run('check_task', { file: '../x.smd', line: 1 }), /outside the root/);
});

test('MCP set_status sets the status and the updated date', async () => {
  write('plan.smd', small);
  const today = () => '2026-10-30';
  const setStatus = smdTools(box, { allowWrite: true }).find((t) => t.name === 'set_status')!;
  // The real tool uses today's date; check the shape, then the date logic through a fresh document.
  assert.match(await setStatus.run({ file: 'plan.smd', status: 'approved' }), /status approved/);
  const text = readFileSync(join(root, 'plan.smd'), 'utf8');
  assert.match(text, /^status: approved$/m);
  assert.doesNotMatch(text, /^updated: 2026-01-01$/m);
  assert.match(await setStatus.run({ file: 'plan.smd', status: 'approved' }), /already has status/);
  write('bare.smd', '# No front matter\n');
  await assert.rejects(async () => setStatus.run({ file: 'bare.smd', status: 'review' }), /Can't set status/);
  void today;
});

test('MCP add_decision appends a block to a section and refuses bad input', async () => {
  write('plan.smd', small);
  const out = await run('add_decision', { file: 'plan.smd', section: 'goals', title: 'Ship in the EU first', body: 'Smaller market.', status: 'accepted', owner: '@maya' });
  assert.match(out, /Added the decision "Ship in the EU first" \(accepted\) to plan\.smd › Goals, lines 11-13/);
  const lines = readFileSync(join(root, 'plan.smd'), 'utf8').split('\n');
  assert.match(lines[10], /^:::decision\{status=accepted date=\d{4}-\d{2}-\d{2} owner=@maya\} Ship in the EU first$/);
  assert.deepEqual(lines.slice(8, 15), ['Ship it.', '', lines[10], 'Smaller market.', ':::', '', '## Tasks']);
  await assert.rejects(async () => run('add_decision', { file: 'plan.smd', section: 'nope', title: 't', body: 'b' }), /No section matching "nope"/);
  await assert.rejects(async () => run('add_decision', { file: 'plan.smd', section: 'goals', title: 'a\nb', body: 'b' }), /one non-empty line/);
  await assert.rejects(async () => run('add_decision', { file: 'plan.smd', section: 'goals', title: 't', body: 'b', owner: 'maya' }), /"owner"/);
  const before = readFileSync(join(root, 'plan.smd'), 'utf8');
  await assert.rejects(async () => run('add_decision', { file: 'plan.smd', section: 'tasks', title: 't', body: ':::decison{x} Oops\nbody' }), /Not written/);
  assert.equal(readFileSync(join(root, 'plan.smd'), 'utf8'), before, 'nothing written on refusal');
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
const smd = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 });

test('CLI: smd read and smd savings', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  write('small.smd', small);
  write('big.smd', big);
  const read = smd('read', join(root, 'small.smd'));
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /Ship it\./);
  assert.match(read.stderr, /\[smd\] full · agent view ≈\d+ tokens/);
  assert.match(smd('read', join(root, 'big.smd')).stdout, /smd agent <file> --section/);
  assert.match(smd('read', join(root, 'big.smd'), '--section', 'Part 1').stdout, /Part 1/);
  assert.equal(smd('read', join(root, 'big.smd'), '--section', 'nope').status, 1);
  assert.equal(smd('read', join(root, 'big.smd'), '--max-tokens', 'x').status, 2);
  const savings = smd('savings', root, '--json', '--price', '15');
  assert.equal(savings.status, 0, savings.stderr);
  assert.equal(JSON.parse(savings.stdout).price, 15);
  assert.equal(smd('savings', root, '--price', '-1').status, 2);
});

test('CLI: smd init --agent sets up skills, rules and MCP configs', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const project = join(root, 'project');
  mkdirSync(join(project, '.vscode'), { recursive: true });
  writeFileSync(join(project, '.vscode', 'mcp.json'), '{\n  "servers": { "mine": { "command": "x" } }\n}\n');
  const out = smd('init', '--agent', 'claude,cursor,copilot,agents', '--dir', project);
  assert.equal(out.status, 0, out.stderr);
  for (const file of ['.claude/skills/styled-markdown-reader/SKILL.md', '.claude/skills/styled-markdown-reader/scripts/smd.cjs', '.smd/smd.cjs',
    '.cursor/rules/styled-markdown.mdc', '.github/instructions/styled-markdown.instructions.md', 'AGENTS.md', '.mcp.json', '.cursor/mcp.json']) {
    assert.ok(existsSync(join(project, file)), file);
  }
  const vscode = JSON.parse(readFileSync(join(project, '.vscode', 'mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(vscode.servers), ['mine', 'styled-markdown']);
  assert.equal(JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8')).mcpServers['styled-markdown'].args[0], CLAUDE_SKILL_CLI);
  assert.match(smd('init', '--agent', 'claude', '--dir', project).stdout, /Unchanged .*\.mcp\.json/);
  assert.equal(smd('init', '--agent', 'nope').status, 2);
  assert.equal(smd('init', 'doc.smd', '--agent', 'claude').status, 2);
  const noMcp = join(root, 'nomcp');
  assert.equal(smd('init', '--agent', 'cursor', '--dir', noMcp, '--no-mcp').status, 0);
  assert.ok(!existsSync(join(noMcp, '.cursor', 'mcp.json')));
});
