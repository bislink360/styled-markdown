import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { checkArguments, McpServer, serveLines, ToolError, type JsonRpcResponse, type McpTool } from '../src/mcpProtocol';
import { Sandbox, smdTools } from '../src/mcp';

const echo: McpTool = {
  name: 'echo',
  description: 'Echoes its text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' }, loud: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['text'], additionalProperties: false },
  run: (args) => {
    if (args.text === 'fail') throw new ToolError('Asked to fail.');
    if (args.text === 'crash') throw new Error('boom');
    return args.loud ? String(args.text).toUpperCase() : String(args.text);
  },
};
const logged: string[] = [];
const server = new McpServer({ name: 'test', version: '1.0.0', tools: [echo], log: (m) => logged.push(m) });
const call = async (method: string, params?: unknown, id: number | string = 1) =>
  (await server.handle({ jsonrpc: '2.0', id, method, params })) as JsonRpcResponse;
const resultOf = async (method: string, params?: unknown) => (await call(method, params)).result as Record<string, unknown>;

test('initialize negotiates the protocol version and announces tools', async () => {
  const init = await resultOf('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
  assert.deepEqual(init, { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'test', version: '1.0.0' } });
  assert.equal((await resultOf('initialize', { protocolVersion: '1999-01-01' })).protocolVersion, '2025-06-18');
  assert.deepEqual(await resultOf('ping'), {});
});

test('tools/list and tools/call', async () => {
  const { tools } = await resultOf('tools/list') as { tools: Array<{ name: string; inputSchema: unknown }> };
  assert.deepEqual(tools.map((t) => t.name), ['echo']);
  assert.deepEqual(await resultOf('tools/call', { name: 'echo', arguments: { text: 'hi', loud: true } }), { content: [{ type: 'text', text: 'HI' }] });
});

test('tool failures are results with isError, protocol failures are JSON-RPC errors', async () => {
  const failed = async (args: unknown) => (await resultOf('tools/call', { name: 'echo', arguments: args })) as { isError: boolean; content: Array<{ text: string }> };
  assert.deepEqual(await failed({ text: 'fail' }), { content: [{ type: 'text', text: 'Asked to fail.' }], isError: true });
  assert.equal((await failed({ text: 'crash' })).content[0].text, 'boom');
  assert.match(logged.join('\n'), /echo failed: Error: boom/);
  assert.match((await failed({})).content[0].text, /"text" is required/);
  assert.match((await failed({ text: 1 })).content[0].text, /"text" must be a string/);
  assert.match((await failed({ text: 'x', txt: 'y' })).content[0].text, /unknown argument "txt"/);
  assert.match((await failed({ text: 'x', tags: [] })).content[0].text, /"tags" needs at least 1/);
  assert.match((await failed({ text: 'x', tags: [1] })).content[0].text, /array of strings/);
  assert.match((await failed([])).content[0].text, /arguments must be an object/);

  assert.equal((await call('tools/call', { name: 'nope' })).error?.code, -32602);
  assert.match((await call('tools/call', { name: 'nope' })).error!.message, /Unknown tool: nope\. Available: echo/);
  assert.equal((await call('tools/call', {})).error?.code, -32602);
  assert.deepEqual(await call('resources/list', undefined, 'a'), { jsonrpc: '2.0', id: 'a', error: { code: -32601, message: 'Method not found: resources/list' } });
  assert.equal(((await server.handle({ id: 3, method: 'ping' })) as JsonRpcResponse).error?.code, -32600);
  assert.equal(((await server.handleLine('{oops')) as JsonRpcResponse).error?.code, -32700);
});

test('notifications get no answer; batches get one answer per request', async () => {
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'unknown/notification' }), undefined);
  const batch = await server.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 1, result: {} }]);
});

test('checkArguments allows extra keys unless additionalProperties is false', () => {
  assert.equal(checkArguments({ type: 'object', properties: {} }, { any: 1 }), undefined);
  assert.match(checkArguments({ type: 'object', properties: {}, additionalProperties: false }, { any: 1 }) ?? '', /unknown argument/);
});

test('serveLines answers each line and finishes when the input ends', async () => {
  const input = new PassThrough();
  const out: string[] = [];
  const done = serveLines(server, input, (line) => out.push(line));
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\r\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n\n{"jsonrpc":"2.0","id":2,');
  input.end('"method":"ping"}');
  await done;
  assert.deepEqual(out.map((l) => JSON.parse(l).id).sort(), [1, 2]);
  assert.ok(out.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n')));
});

// A root folder with documents, and a document outside it.
const base = mkdtempSync(join(tmpdir(), 'smd-mcp-'));
const root = join(base, 'root');
mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs', 'plan.smd'), [
  '# Plan', '', ':::agent', 'Keep answers short.', ':::', '',
  '## Decisions', '', ':::decision{status=accepted} Ship in the EU first', 'Smaller market.', ':::', '',
  '## Tasks', '', '- [ ] Write the spec @maya :priority[P0]', '- [x] Kickoff @li', '',
  '## Notes', '', ':::human', 'Only for people.', ':::', '', '```js file="../../secret.txt"', '```', '',
].join('\n'));
writeFileSync(join(root, 'docs', 'broken.smd'), '# Broken\n\n:::decison Oops\nx\n:::\n');
writeFileSync(join(root, 'readme.md'), '# Not smd\n');
writeFileSync(join(base, 'secret.txt'), 'TOP SECRET');
writeFileSync(join(base, 'outside.smd'), '# Outside\n');
let linked = false;
try {
  symlinkSync(base, join(root, 'escape'), 'junction');
  linked = true;
} catch { /* symbolic links need extra rights on some systems */ }
after(() => rmSync(base, { recursive: true, force: true }));

const box = new Sandbox(root);
const tools = new Map(smdTools(box).map((t) => [t.name, t]));
const run = async (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args);
const rejects = (name: string, args: Record<string, unknown>, message: RegExp) =>
  assert.rejects(async () => run(name, args), (e: Error) => e instanceof ToolError && message.test(e.message));

test('Sandbox refuses paths outside the root, missing paths and non-.smd files', async () => {
  await rejects('outline', { file: '../outside.smd' }, /outside the root folder/);
  await rejects('outline', { file: join(base, 'outside.smd') }, /outside the root folder/);
  await rejects('outline', { file: 'docs/missing.smd' }, /Not found: docs\/missing\.smd/);
  await rejects('outline', { file: 'readme.md' }, /Not a \.smd file/);
  await rejects('outline', { file: 'docs' }, /Not a \.smd file/);
  await rejects('tasks', { paths: ['..'] }, /outside the root folder/);
  if (linked) {
    await rejects('outline', { file: 'escape/outside.smd' }, /outside the root folder/);
    // Folder scans skip documents reached through links.
    assert.doesNotMatch(await run('tasks', { all: true }), /Outside/);
  }
});

test('outline, section and agent return the agent view', async () => {
  assert.match(await run('outline', { file: 'docs/plan.smd' }), /Decisions/);
  const agent = await run('agent', { file: 'docs/plan.smd' });
  assert.match(agent, /<agent-instructions>/);
  assert.doesNotMatch(agent, /Only for people|TOP SECRET/);
  assert.match(await run('agent', { file: 'docs/plan.smd', includeHuman: true }), /Only for people/);
  const section = await run('section', { file: 'docs/plan.smd', sections: ['decisions'] });
  assert.match(section, /Ship in the EU first/);
  assert.match(section, /Keep answers short/); // agent instructions always come along
  assert.doesNotMatch(section, /Write the spec/);
  assert.match(await run('section', { file: 'docs/plan.smd', sections: ['decisions', 'nope'] }), /No section matching: nope/);
  await rejects('section', { file: 'docs/plan.smd', sections: ['nope'] }, /No section matching: nope\. Call "outline"/);
});

test('tasks, validate and query read every .smd file under the root', async () => {
  assert.equal(await run('tasks', {}), 'docs/plan.smd:15  [ ] [P0] Write the spec @maya  — Tasks\n1 task(s) open.\n');
  assert.match(await run('tasks', { all: true, mine: '@li' }), /\[x\] Kickoff @li[^]*1 task\(s\)\./);
  const report = JSON.parse(await run('validate', { paths: ['docs'] }));
  assert.deepEqual(report.files.map((f: { file: string }) => f.file).sort(), ['docs/broken.smd', 'docs/plan.smd']);
  assert.ok(report.errors >= 1);
  assert.ok(report.files.find((f: { file: string }) => f.file === 'docs/broken.smd').diagnostics.some((d: { code: string }) => d.code === 'container/unknown'));
  assert.match(await run('query', { selector: 'decision[status=accepted]' }), /^docs\/plan\.smd:9-11 {2}— Decisions\n<decision status="accepted">[^]*1 match\(es\) in 1 of 2 file\(s\)\.\n$/);
  assert.match(await run('query', { selector: 'task', titles: true, paths: ['docs/plan.smd'] }), /docs\/plan\.smd:15 {2}task {2}Write the spec/);
  assert.equal(await run('query', { selector: 'risk' }), '0 match(es) in 0 of 2 file(s).\n');
  await rejects('query', { selector: 'decison' }, /Did you mean "decision"/);
  await rejects('validate', { paths: ['readme.md'] }, /No \.smd files found/);
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd mcp speaks JSON-RPC over stdio', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ...['outline', 'agent'].map((name, i) => ({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name, arguments: { file: 'docs/plan.smd' } } })),
    { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'section', arguments: { file: 'docs/plan.smd', sections: ['Tasks'] } } },
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'tasks', arguments: {} } },
    { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'validate', arguments: { paths: ['docs'] } } },
    { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'query', arguments: { selector: 'decision' } } },
    { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'delete', arguments: {} } },
    { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'outline', arguments: { file: '../outside.smd' } } },
    { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'query', arguments: { selector: 'risk[' } } },
  ];
  const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n';
  const proc = spawnSync(process.execPath, [cli, 'mcp', '--root', root], { input, encoding: 'utf8', timeout: 30_000 });
  assert.equal(proc.status, 0, proc.stderr);
  // stdout holds nothing but protocol messages.
  const byId = new Map<unknown, JsonRpcResponse>(proc.stdout.trim().split('\n').map((l) => JSON.parse(l)).map((m: JsonRpcResponse) => [m.id, m]));
  assert.deepEqual([...byId.keys()].sort((a, b) => String(a).localeCompare(String(b))), [1, 10, 11, 12, 13, 14, 15, 2, 20, 21, 22, null]);
  const result = (id: number) => byId.get(id)!.result as { content: Array<{ text: string }>; isError?: boolean };
  const text = (id: number) => result(id).content[0].text;
  assert.equal((byId.get(1)!.result as { serverInfo: { name: string } }).serverInfo.name, 'styled-markdown');
  const listed = (byId.get(2)!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  assert.deepEqual(listed, ['outline', 'section', 'agent', 'tasks', 'validate', 'query']);
  assert.match(text(10), /Tasks/);
  assert.match(text(11), /<agent-instructions>/);
  assert.match(text(12), /Write the spec/);
  assert.match(text(13), /1 task\(s\) open/);
  assert.ok(JSON.parse(text(14)).errors >= 1);
  assert.match(text(15), /Ship in the EU first/);
  assert.equal(byId.get(20)!.error?.code, -32602);
  assert.equal(result(21).isError, true);
  assert.match(text(21), /outside the root folder/);
  assert.equal(result(22).isError, true);
  assert.equal(byId.get(null)!.error?.code, -32700);

  const badRoot = spawnSync(process.execPath, [cli, 'mcp', '--root', join(base, 'missing')], { input: '', encoding: 'utf8' });
  assert.equal(badRoot.status, 2);
});
