import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatSmd } from '../src/core';
import { completionsAt, hoverAt } from '../src/lspAssist';
import { chooseEncoding, fromClientColumn, toClientColumn } from '../src/lspDocuments';
import { contentLength, frame, LspEndpoint, MessageReader, type LspMessage, type LspResponse } from '../src/lspProtocol';
import { filePath, SmdLanguageServer, type LanguageServerOptions } from '../src/lsp';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'smd-lsp-'));
after(() => rmSync(root, { recursive: true, force: true }));
// Stops the config file search here, as a repository root does.
mkdirSync(join(root, '.git'));
mkdirSync(join(root, 'docs'));
mkdirSync(join(root, 'ruled'));

const PLAN = [
  '---', 'title: Plan', 'status: draft', '---', '',
  '# Plan', '',
  'See [the design](other.smd#design), [intro](#plan) and [ref][d].', '',
  ':::nope', 'x', ':::', '',
  'Text 😀 :badge[x]{colr=red}', '',
  '## Choices', '',
  ':::decision{status=accepted} Use LSP', 'Body', ':::', '',
  '```ts file="code.ts" lines="1-2"', '```', '',
  '[d]: other.smd', '',
].join('\n');
const OTHER = ['# Other', '', '## Design', '', 'The design.', '', ':::risk{impact=high} Slow parser', 'x', ':::', ''].join('\n');

const planFile = join(root, 'docs', 'plan.smd');
const otherFile = join(root, 'docs', 'other.smd');
const linksFile = join(root, 'docs', 'links.smd');
writeFileSync(planFile, PLAN);
writeFileSync(otherFile, OTHER);
writeFileSync(linksFile, '# Links\n');
writeFileSync(join(root, 'docs', 'code.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
writeFileSync(join(root, 'ruled', 'smd.config.json'), JSON.stringify({ rules: { 'container/unknown': 'off' } }));
writeFileSync(join(root, 'ruled', 'doc.smd'), ':::nope\nx\n:::\n');

const uriOf = (file: string) => pathToFileURL(file).href;
const PLAN_URI = uriOf(planFile);
const OTHER_URI = uriOf(otherFile);

// ---------------------------------------------------------------------------
// A server driven through its protocol endpoint
// ---------------------------------------------------------------------------

interface Diag { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity: number; code: string; source: string; message: string }

function client(capabilities: Record<string, unknown> = {}, options: Partial<LanguageServerOptions> = {}) {
  const sent: LspMessage[] = [];
  const exits: number[] = [];
  const server = new SmdLanguageServer({
    version: '9.9.9', send: (m) => sent.push(m), onExit: (code) => exits.push(code), log: () => undefined,
    mermaid: null, validateDelay: 0, today: '2026-10-01', ...options,
  });
  let id = 0;
  const request = (method: string, params?: unknown): LspResponse => {
    const n = ++id;
    server.endpoint.receive({ jsonrpc: '2.0', id: n, method, params });
    return sent.find((m) => 'id' in m && m.id === n) as LspResponse;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (method: string, params?: unknown): any => request(method, params).result;
  const notify = (method: string, params?: unknown) => server.endpoint.receive({ jsonrpc: '2.0', method, params });
  const published = (uri: string): Diag[] | undefined => {
    const last = sent.filter((m) => 'method' in m && m.method === 'textDocument/publishDiagnostics' && (m.params as { uri: string }).uri === uri).pop();
    return last && (last as { params: { diagnostics: Diag[] } }).params.diagnostics;
  };
  const open = (uri: string, text: string, version = 1) => notify('textDocument/didOpen', { textDocument: { uri, languageId: 'smd', version, text } });
  const change = (uri: string, text: string, version: number) => notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
  const at = (uri: string, line: number, character: number) => ({ textDocument: { uri }, position: { line, character } });
  const init = () => result('initialize', { processId: null, rootUri: uriOf(root), capabilities });
  return { server, sent, exits, request, result, notify, published, open, change, at, init };
}

/** A ready client with plan.smd open. */
function ready(capabilities?: Record<string, unknown>, options?: Partial<LanguageServerOptions>) {
  const c = client(capabilities, options);
  c.init();
  c.notify('initialized', {});
  c.open(PLAN_URI, PLAN);
  return c;
}

/** Applies LSP text edits (UTF-16 positions) to a text. */
function applyEdits(text: string, edits: Array<{ range: Diag['range']; newText: string }>): string {
  const offset = (p: { line: number; character: number }) => {
    let at = 0;
    for (let line = 0; line < p.line; line++) {
      const eol = /\r?\n/.exec(text.slice(at));
      at = eol ? at + eol.index + eol[0].length : text.length;
    }
    return at + p.character;
  };
  const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  return sorted.reduce((t, e) => t.slice(0, offset(e.range.start)) + e.newText + t.slice(offset(e.range.end)), text);
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

test('frame: Content-Length counts UTF-8 bytes', () => {
  const message: LspMessage = { jsonrpc: '2.0', method: 'x', params: { text: 'é😀' } };
  const framed = frame(message).toString('utf8');
  const body = JSON.stringify(message);
  assert.equal(framed, `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  assert.notEqual(Buffer.byteLength(body), body.length);
});

test('MessageReader: split and combined chunks, multi-byte bodies', () => {
  const bodies: string[] = [];
  const problems: string[] = [];
  const reader = new MessageReader((b) => bodies.push(b), (p) => problems.push(p));
  const one = frame({ jsonrpc: '2.0', method: 'a', params: { text: 'naïve 😀 ünïcödé' } });
  const two = frame({ jsonrpc: '2.0', method: 'b' });
  // Byte by byte: splits the header, the separator and the emoji's four bytes.
  for (const byte of one) reader.push(Buffer.from([byte]));
  assert.equal(bodies.length, 1);
  assert.equal(JSON.parse(bodies[0]).params.text, 'naïve 😀 ünïcödé');
  // Two messages in one chunk, then one and a half, then the rest.
  reader.push(Buffer.concat([one, two]));
  reader.push(Buffer.concat([two, one.subarray(0, 30)]));
  reader.push(one.subarray(30));
  assert.deepEqual(bodies.map((b) => JSON.parse(b).method), ['a', 'a', 'b', 'b', 'a']);
  // Other headers are allowed; a header block without a length is dropped.
  reader.push('Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: 2\r\n\r\n{}');
  reader.push('X-Nothing: 1\r\n\r\n');
  reader.push(two);
  assert.deepEqual(bodies.slice(5), ['{}', JSON.stringify({ jsonrpc: '2.0', method: 'b' })]);
  assert.equal(problems.length, 1);
  assert.equal(contentLength('Content-Length:12'), 12);
  assert.equal(contentLength('Content-Length: -1'), undefined);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('lifecycle: initialize first, shutdown then exit', () => {
  const c = client();
  assert.equal(c.request('textDocument/hover', c.at(PLAN_URI, 0, 0)).error?.code, -32002);
  c.open(PLAN_URI, PLAN);
  assert.equal(c.published(PLAN_URI), undefined, 'notifications before initialize are dropped');

  const init = c.init();
  assert.equal(init.serverInfo.name, 'smd-language-server');
  assert.equal(init.serverInfo.version, '9.9.9');
  assert.deepEqual(Object.keys(init.capabilities).sort((a, b) => a.localeCompare(b)), [
    'codeActionProvider', 'completionProvider', 'definitionProvider', 'documentFormattingProvider', 'documentSymbolProvider',
    'hoverProvider', 'positionEncoding', 'textDocumentSync', 'workspaceSymbolProvider',
  ]);
  assert.deepEqual(init.capabilities.textDocumentSync, { openClose: true, change: 1 });
  assert.equal(c.request('initialize', {}).error?.code, -32600);

  const before = c.sent.length;
  c.notify('$/cancelRequest', { id: 1 });
  c.notify('workspace/didChangeConfiguration', { settings: {} });
  c.server.endpoint.receive({ jsonrpc: '2.0', id: 99, result: null });
  assert.equal(c.sent.length, before, 'cancellation, unknown notifications and responses get no answer');
  assert.deepEqual(c.request('textDocument/references', {}).error, { code: -32601, message: 'Method not found: textDocument/references' });
  assert.deepEqual(c.request('$/unknown').error?.code, -32601);

  c.server.endpoint.receiveBody('{oops');
  assert.deepEqual(c.sent[c.sent.length - 1], { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: not valid JSON.' } });
  c.server.endpoint.receive({ jsonrpc: '2.0', id: 5 });
  assert.equal((c.sent[c.sent.length - 1] as LspResponse).error?.code, -32600);

  const shutdown = c.request('shutdown');
  assert.equal(shutdown.result, null);
  assert.equal(shutdown.error, undefined);
  assert.equal(c.request('textDocument/hover', c.at(PLAN_URI, 0, 0)).error?.code, -32600);
  c.notify('exit');
  assert.deepEqual(c.exits, [0]);

  const abrupt = client();
  abrupt.init();
  abrupt.notify('exit');
  assert.deepEqual(abrupt.exits, [1], 'exit without shutdown');
});

test('a failing handler answers InternalError and keeps serving', () => {
  const sent: LspMessage[] = [];
  const logged: string[] = [];
  const endpoint = new LspEndpoint({
    send: (m) => sent.push(m), onExit: () => undefined, log: (m) => logged.push(m),
    requests: { initialize: () => ({ capabilities: {} }), boom: () => { throw new Error('bad'); } },
    notifications: { crash: () => { throw new Error('worse'); } },
  });
  endpoint.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  endpoint.receive({ jsonrpc: '2.0', id: 2, method: 'boom' });
  endpoint.receive({ jsonrpc: '2.0', method: 'crash' });
  assert.deepEqual(sent[1], { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Internal error: bad' } });
  assert.equal(sent.length, 2);
  assert.match(logged.join('\n'), /boom failed: Error: bad[\s\S]*crash failed: Error: worse/);
});

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

test('position encodings: UTF-16 by default, UTF-32 or UTF-8 when the client offers only those', () => {
  assert.equal(chooseEncoding(undefined), 'utf-16');
  assert.equal(chooseEncoding(['utf-8', 'utf-16']), 'utf-16');
  assert.equal(chooseEncoding(['utf-8']), 'utf-8');
  assert.equal(chooseEncoding(['utf-32', 'utf-8']), 'utf-32');
  assert.equal(chooseEncoding(['latin-1']), 'utf-16');

  const line = 'aé😀b';
  // UTF-16 indices: a 0, é 1, 😀 2–3, b 4, end 5.
  assert.deepEqual([0, 1, 2, 4, 5].map((c) => toClientColumn(line, c, 'utf-16')), [0, 1, 2, 4, 5]);
  assert.deepEqual([0, 1, 2, 4, 5].map((c) => toClientColumn(line, c, 'utf-8')), [0, 1, 3, 7, 8]);
  assert.deepEqual([0, 1, 2, 4, 5].map((c) => toClientColumn(line, c, 'utf-32')), [0, 1, 2, 3, 4]);
  assert.deepEqual([0, 1, 3, 7, 8].map((c) => fromClientColumn(line, c, 'utf-8')), [0, 1, 2, 4, 5]);
  assert.deepEqual([0, 1, 2, 3, 4].map((c) => fromClientColumn(line, c, 'utf-32')), [0, 1, 2, 4, 5]);
  // Inside a character: its start. Past the end: the end.
  assert.equal(toClientColumn(line, 3, 'utf-8'), 3);
  assert.equal(fromClientColumn(line, 5, 'utf-8'), 2);
  assert.equal(fromClientColumn(line, 99, 'utf-16'), 5);
  assert.equal(fromClientColumn(line, 99, 'utf-8'), 5);
  assert.equal(toClientColumn(line, 99, 'utf-32'), 4);
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

test('didOpen publishes diagnostics with codes, severities and UTF-16 ranges', () => {
  const c = ready();
  const found = c.published(PLAN_URI)!;
  const unknown = found.find((d) => d.code === 'container/unknown')!;
  assert.deepEqual(unknown.range, { start: { line: 9, character: 3 }, end: { line: 9, character: 7 } });
  assert.equal(unknown.severity, 2);
  assert.equal(unknown.source, 'smd');
  const attrs = found.find((d) => d.code === 'attrs/unknown')!;
  // After "Text 😀 ": the emoji is two UTF-16 code units.
  assert.deepEqual(attrs.range.start, { line: 13, character: 8 });
});

test('positions follow the negotiated encoding (UTF-8)', () => {
  const c = ready({ general: { positionEncodings: ['utf-8'] } });
  const attrs = c.published(PLAN_URI)!.find((d) => d.code === 'attrs/unknown')!;
  assert.deepEqual(attrs.range, { start: { line: 13, character: 10 }, end: { line: 13, character: 29 } });
  // Hover over ":badge" at UTF-8 column 11 ("b").
  const hover = c.result('textDocument/hover', c.at(PLAN_URI, 13, 11));
  assert.match(hover.contents.value, /\*\*:badge\*\*/);
  assert.deepEqual(hover.range, { start: { line: 13, character: 10 }, end: { line: 13, character: 16 } });
  const [fix] = c.result('textDocument/codeAction', { textDocument: { uri: PLAN_URI }, range: attrs.range, context: { diagnostics: [attrs] } });
  assert.deepEqual(fix.edit.changes[PLAN_URI][0].range, { start: { line: 13, character: 20 }, end: { line: 13, character: 24 } });
});

test('rule settings from the nearest config file apply', () => {
  const c = ready();
  const uri = uriOf(join(root, 'ruled', 'doc.smd'));
  c.open(uri, ':::nope\nx\n:::\n');
  assert.equal(c.published(uri)!.filter((d) => d.code === 'container/unknown').length, 0);
  assert.equal(c.published(PLAN_URI)!.filter((d) => d.code === 'container/unknown').length, 1);
});

test('didChange revalidates; didClose clears the diagnostics', () => {
  const c = ready();
  c.change(PLAN_URI, '# Fixed\n', 2);
  assert.deepEqual(c.published(PLAN_URI), []);
  c.notify('textDocument/didClose', { textDocument: { uri: PLAN_URI } });
  assert.deepEqual(c.published(PLAN_URI), []);
  assert.equal(c.result('textDocument/documentSymbol', { textDocument: { uri: PLAN_URI } }), null);
});

test('codeAction offers the fix as a quick fix, also before a delayed validation ran', () => {
  const c = ready(undefined, { validateDelay: 60_000 });
  const range = { start: { line: 13, character: 0 }, end: { line: 13, character: 0 } };
  const [action] = c.result('textDocument/codeAction', { textDocument: { uri: PLAN_URI }, range, context: { diagnostics: [] } });
  assert.equal(action.title, 'Change to "color"');
  assert.equal(action.kind, 'quickfix');
  assert.equal(action.isPreferred, true);
  assert.equal(action.diagnostics[0].code, 'attrs/unknown');
  assert.deepEqual(action.edit.changes[PLAN_URI], [{ range: { start: { line: 13, character: 18 }, end: { line: 13, character: 22 } }, newText: 'color' }]);
  assert.match(applyEdits(PLAN, action.edit.changes[PLAN_URI]), /:badge\[x\]\{color=red\}/);
  // Refactorings only: none here.
  assert.deepEqual(c.result('textDocument/codeAction', { textDocument: { uri: PLAN_URI }, range, context: { diagnostics: [], only: ['refactor'] } }), []);

  // A change waiting for the delay is validated before fixes are offered.
  const changed = PLAN.replace('Text 😀 ', 'Text ');
  c.change(PLAN_URI, changed, 2);
  const [moved] = c.result('textDocument/codeAction', { textDocument: { uri: PLAN_URI }, range, context: { diagnostics: [] } });
  assert.deepEqual(moved.edit.changes[PLAN_URI][0].range.start, { line: 13, character: 15 });
  c.server.dispose();
});

test('documentSymbol: headings as a tree, blocks inside their section', () => {
  const c = ready();
  const symbols = c.result('textDocument/documentSymbol', { textDocument: { uri: PLAN_URI } });
  assert.equal(symbols.length, 1);
  const [plan] = symbols;
  assert.equal(plan.name, 'Plan');
  assert.equal(plan.detail, 'H1');
  assert.equal(plan.kind, 15);
  assert.equal(plan.range.start.line, 5);
  assert.equal(plan.range.end.line, 25);
  const [choices] = plan.children;
  assert.equal(choices.name, 'Choices');
  assert.deepEqual(choices.children.map((s: { name: string; kind: number; detail: string }) => [s.name, s.kind, s.detail]), [['Use LSP', 24, 'accepted']]);
});

test('workspace/symbol searches every .smd file in the workspace', () => {
  const c = ready();
  const found = c.result('workspace/symbol', { query: 'slowpars' });
  assert.deepEqual(found, [{
    name: 'Slow parser', kind: 14, containerName: 'risk · impact high',
    location: { uri: OTHER_URI, range: { start: { line: 6, character: 0 }, end: { line: 6, character: 0 } } },
  }]);
  // Open documents are searched with their unsaved text.
  c.change(PLAN_URI, '# Unsaved heading\n', 2);
  assert.equal(c.result('workspace/symbol', { query: 'unsaved' })[0].location.uri, PLAN_URI);
  assert.equal(c.result('workspace/symbol', { query: 'Choices' }).length, 0);
});

test('hover: containers, directives, links and code embeds', () => {
  const c = ready();
  const hover = (line: number, character: number) => c.result('textDocument/hover', c.at(PLAN_URI, line, character));
  assert.match(hover(17, 5).contents.value, /^\*\*:::decision\*\* — /);
  assert.equal(hover(17, 5).contents.kind, 'markdown');
  assert.match(hover(13, 9).contents.value, /^\*\*:badge\*\* — /);
  const link = PLAN.split('\n')[7];
  const design = hover(7, link.indexOf('other.smd#design') + 3);
  assert.match(design.contents.value, /\*\*Design\*\* — other\\\.smd[\s\S]*The design\./);
  assert.match(hover(7, link.indexOf('the design')).contents.value, /The design\./, 'hovering the link text');
  assert.match(hover(7, link.indexOf('#plan') + 2).contents.value, /\*\*Plan\*\*/);
  const embed = hover(21, 2).contents.value;
  assert.match(embed, /const a = 1;\nconst b = 2;/);
  assert.doesNotMatch(embed, /const c/);
  assert.equal(hover(10, 0), null);
});

test('completion: containers, attributes, front matter, directives', () => {
  const c = ready();
  const complete = (line: number, character: number) => c.result('textDocument/completion', c.at(PLAN_URI, line, character));
  const labels = (r: { items: Array<{ label: string }> }) => r.items.map((i) => i.label);

  const containers = complete(9, 5);
  assert.ok(labels(containers).includes('note'));
  assert.deepEqual(containers.items[0].textEdit.range, { start: { line: 9, character: 3 }, end: { line: 9, character: 5 } });
  assert.equal(containers.isIncomplete, false);

  assert.deepEqual(labels(complete(17, ':::decision{status='.length)).slice(0, 2), ['proposed', 'accepted']);
  assert.ok(labels(complete(2, 'status: dr'.length)).includes('draft'));
  assert.deepEqual(complete(2, 'status: dr'.length).items[0].textEdit.range.start, { line: 2, character: 8 });

  const directives = complete(13, 10);
  assert.ok(labels(directives).includes('badge'));
  assert.deepEqual(directives.items[0].textEdit.range, { start: { line: 13, character: 9 }, end: { line: 13, character: 10 } });
  assert.equal(complete(10, 1), null);
});

test('completion: paths and anchors for links', () => {
  const c = ready();
  const uri = uriOf(linksFile);
  c.open(uri, '# Links\n[a](\n[b](#\n[c](other.smd#d\n');
  const labels = (line: number, character: number) =>
    (c.result('textDocument/completion', c.at(uri, line, character)).items as Array<{ label: string }>).map((i) => i.label);
  const paths = labels(1, 4);
  for (const name of ['other.smd', 'plan.smd', 'code.ts', '#links']) assert.ok(paths.includes(name), name);
  assert.ok(!paths.includes('links.smd'), 'not the document itself');
  assert.deepEqual(labels(2, 5), ['links']);
  assert.deepEqual(labels(3, 15), ['other', 'design']);
});

test('definition: anchors, other documents and reference links', () => {
  const c = ready();
  const link = PLAN.split('\n')[7];
  const definition = (character: number) => c.result('textDocument/definition', c.at(PLAN_URI, 7, character));
  const start = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 0 } });
  assert.deepEqual(definition(link.indexOf('other.smd#design') + 12), { uri: OTHER_URI, range: start(2) });
  assert.deepEqual(definition(link.indexOf('#plan') + 1), { uri: PLAN_URI, range: start(5) });
  assert.deepEqual(definition(link.indexOf('[d]') + 1), { uri: PLAN_URI, range: start(24) });
  assert.equal(definition(0), null);
  // An open document is linked by the URI the client uses for it (VS Code style on Windows: file:///c%3A/…).
  const otherUri = OTHER_URI.replace(/^file:\/\/\/([A-Za-z]):/, (_, drive: string) => `file:///${drive.toLowerCase()}%3A`);
  assert.equal(filePath(otherUri)?.toLowerCase(), filePath(OTHER_URI)?.toLowerCase());
  c.open(otherUri, OTHER);
  assert.equal(definition(link.indexOf('other.smd') + 1).uri, otherUri);
});

test('formatting: edits produce the formatted document', () => {
  const c = ready();
  const cases = [
    '# Title\n::: note   Heads up\nText\n::::\n\n## Next\n|a|b|\n|-|-|\n|1|2|\n',
    '# Title\r\n::: note   Heads up\r\nText\r\n::::\r\n\r\n## Next\r\n|a|b|\r\n|-|-|\r\n|1|2|\r\n',
    '# A\nb',
    '# A\n\n\n\nb\n',
  ];
  cases.forEach((text, i) => {
    const uri = uriOf(join(root, 'docs', `fmt${i}.smd`));
    c.open(uri, text);
    const edits = c.result('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } });
    assert.equal(edits.length, 1);
    assert.equal(applyEdits(text, edits), formatSmd(text), JSON.stringify(text));
  });
  assert.deepEqual(c.result('textDocument/formatting', { textDocument: { uri: OTHER_URI.replace('other', 'none') }, options: {} }), null);
  const clean = uriOf(join(root, 'docs', 'clean.smd'));
  c.open(clean, formatSmd(cases[0]));
  assert.deepEqual(c.result('textDocument/formatting', { textDocument: { uri: clean }, options: {} }), []);
});

test('Mermaid syntax errors are published when parsing finishes, unless the document changed', async () => {
  const mermaid = async (source: string) => {
    if (source.includes('bad')) throw new Error('Parse error on line 2: bad');
  };
  const c = ready(undefined, { mermaid });
  const uri = uriOf(join(root, 'docs', 'diagram.smd'));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  c.open(uri, '# D\n\n```mermaid\nflowchart TD\n  bad\n```\n');
  assert.deepEqual(c.published(uri), []);
  await settle();
  assert.deepEqual(c.published(uri)!.map((d) => d.code), ['mermaid/syntax']);

  c.change(uri, '# D\n\n```mermaid\nflowchart TD\n  bad\n```\n', 2);
  c.change(uri, '# D\n', 3);
  await settle();
  assert.deepEqual(c.published(uri), [], 'the result for version 2 is dropped');
});

test('documents without a file path: validation, hover and completion still work', () => {
  const c = ready();
  const uri = 'untitled:Untitled-1';
  c.open(uri, ':::nope\n[a](\n');
  assert.ok(c.published(uri)!.some((d) => d.code === 'container/unknown'));
  assert.equal(c.result('textDocument/hover', c.at(uri, 0, 4)), null);
  assert.deepEqual(c.result('textDocument/completion', c.at(uri, 1, 4)).items, []);
});

test('assist helpers work on plain text', () => {
  assert.equal(completionsAt('::', 0, 2), undefined);
  assert.equal(completionsAt('```', 0, 3)!.items[0].label, 'mermaid');
  assert.ok(completionsAt('```mermaid\nfl', 1, 2)!.items.some((i) => i.label === 'flowchart'));
  assert.equal(hoverAt('nothing here', 0, 3), undefined);

  const at = (line: string) => completionsAt(line, 0, line.length)!;
  const labels = (line: string) => at(line).items.map((i) => i.label);
  assert.deepEqual([at(':badge[x]{color="gr').from, labels(':badge[x]{color="gr').includes('green')], [17, true]);
  assert.deepEqual([at(':badge[x]{co').from, labels(':badge[x]{co')], [10, ['color']]);
  assert.deepEqual(labels(':progress{value=1 la'), ['value', 'color', 'label']);
  assert.deepEqual(labels(':::note{collapsible='), ['open']);
  assert.ok(labels(':::note{').includes('collapsible'));
  assert.equal(at('Read *:sta').from, 7);
  assert.ok(labels(':sta').includes('status'));
  assert.equal(completionsAt('a:sta', 0, 5), undefined);
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: smd lsp --stdio speaks LSP over stdio', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const messages = [
    { id: 1, method: 'initialize', params: { processId: null, rootUri: uriOf(root), capabilities: {} } },
    { method: 'initialized', params: {} },
    { method: 'textDocument/didOpen', params: { textDocument: { uri: PLAN_URI, languageId: 'smd', version: 1, text: PLAN } } },
    { id: 2, method: 'textDocument/documentSymbol', params: { textDocument: { uri: PLAN_URI } } },
    { id: 3, method: 'shutdown' },
    { method: 'exit' },
  ];
  const input = Buffer.concat(messages.map((m) => frame({ jsonrpc: '2.0', ...m } as LspMessage)));
  const proc = spawnSync(process.execPath, [cli, 'lsp', '--stdio'], { input, timeout: 30_000 });
  assert.equal(proc.status, 0, proc.stderr.toString());
  const received: Array<Record<string, unknown>> = [];
  new MessageReader((b) => received.push(JSON.parse(b)), assert.fail).push(proc.stdout);
  assert.equal((received[0].result as { serverInfo: { name: string } }).serverInfo.name, 'smd-language-server');
  const diagnostics = received.find((m) => m.method === 'textDocument/publishDiagnostics')!.params as { diagnostics: Diag[] };
  assert.ok(diagnostics.diagnostics.some((d) => d.code === 'container/unknown'));
  assert.equal((received.find((m) => m.id === 2)!.result as Array<{ name: string }>)[0].name, 'Plan');
  assert.deepEqual(received.find((m) => m.id === 3), { jsonrpc: '2.0', id: 3, result: null });
  assert.match(proc.stderr.toString(), /\[smd lsp\] smd-language-server/);

  const unsupported = spawnSync(process.execPath, [cli, 'lsp', '--socket=5007'], { input: '', encoding: 'utf8' });
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /--stdio only/);
});
