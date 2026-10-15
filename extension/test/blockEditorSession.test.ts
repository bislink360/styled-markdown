import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BlockEditorSession, EditLog, containerForm, inlineAgree, inlineFields, lineSpan, mapBoundary, readEditorMessage, yamlScalar,
  type BlockView, type DocumentPort, type HostMessage, type LineDiagnostic, type RenderMessage, type SessionMessage, type SessionOptions, type TextChange,
} from '../src/blockEditorSession';
import { renderBlocks, segmentSmd, type BlockRenderOptions, type Segment } from '../src/core/blocks';
import { scanInline, type RenderedInline } from '../src/core/inlineEdit';
import { blockTemplates, type Snippet } from '../src/core/templates';
import type { TextEdit } from '../src/core/sourceEdit';
import { prng } from './fuzz/generate';

// The Block Editor's host side (src/blockEditorSession.ts) against a fake document: every message, validation,
// minimal edits that stay inside the block's lines, line endings, edits made meanwhile in a text editor, conflicts.

const TODAY = '2026-10-14';
const snippets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'snippets', 'smd.json'), 'utf8')) as Record<string, Snippet>;
const templates = blockTemplates(snippets, TODAY);
const LINE_BREAK = /\r?\n/;

/** A text document: edits come in as offsets, changes go out as VS Code reports them (ranges of the text before). */
class FakeDoc implements DocumentPort {
  version = 1;
  readonly eol: '\n' | '\r\n';
  onChange: (version: number, changes: TextChange[]) => void = () => undefined;
  refuse = false;

  constructor(public text: string) {
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
  }

  getText(): string {
    return this.text;
  }

  applyEdits(edits: readonly TextEdit[]): boolean {
    if (this.refuse) return false;
    const ordered = [...edits].sort((a, b) => b.from - a.from);
    const changes = ordered.map((e) => ({ ...this.position(e.from, 'start'), ...this.position(e.to, 'end'), text: e.insert }));
    for (const e of ordered) this.text = this.text.slice(0, e.from) + e.insert + this.text.slice(e.to);
    this.version++;
    this.onChange(this.version, changes as TextChange[]);
    return true;
  }

  /** What a text editor would do: replace [from, to) with `insert`. */
  type(from: number, to: number, insert: string): void {
    this.applyEdits([{ from, to, insert }]);
  }

  private position(offset: number, side: 'start' | 'end'): Record<string, number> {
    const before = this.text.slice(0, offset);
    const line = before.split('\n').length - 1;
    const character = offset - (before.lastIndexOf('\n') + 1);
    return side === 'start' ? { startLine: line, startCharacter: character } : { endLine: line, endCharacter: character };
  }
}

interface Harness {
  doc: FakeDoc;
  session: BlockEditorSession;
  sent: HostMessage[];
  render(): RenderMessage;
  send(message: SessionMessage): Promise<HostMessage | undefined>;
}

function harness(text: string, options: { diagnostics?: LineDiagnostic[]; render?: BlockRenderOptions; title?: string; scan?: SessionOptions['scan'] } = {}): Harness {
  const doc = new FakeDoc(text);
  const sent: HostMessage[] = [];
  const renderOptions = { today: TODAY, ...options.render };
  const session = new BlockEditorSession(doc, {
    render: (t) => renderBlocks(t, renderOptions),
    segment: (t) => segmentSmd(t, renderOptions),
    templates,
    post: (m) => sent.push(m),
    diagnostics: () => options.diagnostics ?? [],
    themePref: () => 'auto',
    title: options.title,
    scan: options.scan,
  });
  doc.onChange = (version, changes) => session.recordChange(version, changes);
  return {
    doc,
    session,
    sent,
    render: () => session.render(),
    async send(message) {
      const before = sent.length;
      await session.handle(message);
      return sent.slice(before).at(-1);
    },
  };
}

/** The top-level block (or child) whose source starts with `prefix`. */
function block(r: RenderMessage, prefix: string): BlockView {
  const all = (views: readonly BlockView[]): BlockView[] => views.flatMap((v) => [v, ...all(v.children ?? [])]);
  const found = all(r.blocks).find((b) => b.kind === 'block' && b.source.startsWith(prefix));
  assert.ok(found, `no block starting with ${JSON.stringify(prefix)}`);
  return found;
}

const lines = (text: string) => text.split(LINE_BREAK);

/** Lines outside [start, endBefore) of `before` are the same lines, in place, at either end of `after`. */
function onlyLinesChanged(before: string, after: string, start: number, endBefore: number): void {
  const a = lines(before);
  const b = lines(after);
  assert.deepEqual(b.slice(0, start), a.slice(0, start), 'lines above the block are untouched');
  const tail = a.length - endBefore;
  assert.deepEqual(b.slice(b.length - tail), a.slice(endBefore), 'lines below the block are untouched');
}

const DOC = [
  '---',
  'title: Plan',
  '---',
  '',
  '# Plan',
  '',
  'First paragraph',
  'second line.',
  '',
  ':::warning{collapsible} Heads up',
  'Inside the callout.',
  '',
  '- [ ] a task',
  ':::',
  '',
  '[ref]: https://example.com',
  '',
  'Last paragraph.',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('readEditorMessage accepts every message type with its fields', () => {
  const key = 'abc123#0';
  const valid: unknown[] = [
    { type: 'ready' },
    { type: 'edit', key, baseVersion: 3, oldText: 'a', newText: 'b', editId: 'e1' },
    { type: 'insert', template: 'Callout', atKey: key, editId: 'e2' },
    { type: 'insert', template: 'Callout', position: 'end' },
    { type: 'delete', key, editId: 'e3' },
    { type: 'move', key, direction: 'up' },
    { type: 'setAttr', key, name: 'status', value: 'accepted' },
    { type: 'setAttr', key, name: 'collapsible', value: true },
    { type: 'setAttr', key, name: 'collapsible', value: null },
    { type: 'setTitle', key, title: 'New' },
    { type: 'addFrontMatter' },
    { type: 'toggleTask', line: 4 },
    { type: 'openLink', href: 'other.smd#x' },
    { type: 'revealLine', line: 0 },
    { type: 'flushed', requestId: 1 },
  ];
  for (const m of valid) assert.ok(readEditorMessage(m), JSON.stringify(m));
  assert.deepEqual(readEditorMessage({ type: 'delete', key, editId: 'e3', extra: '<x>' }), { type: 'delete', key, editId: 'e3' }, 'unknown fields are dropped');
});

test('readEditorMessage ignores anything malformed', () => {
  const key = 'abc123#0';
  const invalid: unknown[] = [
    null, undefined, 'edit', 42, [], {}, { type: 'nope' }, { type: 'toString' }, { type: '__proto__' },
    { type: 'edit', key, baseVersion: 3, oldText: 'a', newText: 'b' },
    { type: 'edit', key, baseVersion: -1, oldText: 'a', newText: 'b', editId: 'e' },
    { type: 'edit', key, baseVersion: 1.5, oldText: 'a', newText: 'b', editId: 'e' },
    { type: 'edit', key: 'not a key', baseVersion: 1, oldText: 'a', newText: 'b', editId: 'e' },
    { type: 'edit', key, baseVersion: 1, oldText: 1, newText: 'b', editId: 'e' },
    { type: 'edit', key, baseVersion: 1, oldText: 'a', newText: 'b'.repeat(4_000_001), editId: 'e' },
    { type: 'edit', key, baseVersion: 1, oldText: 'a', newText: 'b', editId: 'has space' },
    { type: 'insert', template: 'Callout' },
    { type: 'insert', template: 'Callout', position: 'middle' },
    { type: 'insert', template: 7, position: 'end' },
    { type: 'delete' },
    { type: 'move', key, direction: 'left' },
    { type: 'setAttr', key, name: 'bad name', value: 'x' },
    { type: 'setAttr', key, name: 'x', value: 3 },
    { type: 'setAttr', key, name: 'x' },
    { type: 'setTitle', key },
    { type: 'toggleTask', line: '3' },
    { type: 'toggleTask', line: -2 },
    { type: 'openLink', href: '' },
    { type: 'openLink' },
    { type: 'revealLine', line: Number.NaN },
    { type: 'flushed' },
    { type: 'addFrontMatter', editId: 5 },
  ];
  for (const m of invalid) assert.equal(readEditorMessage(m), undefined, JSON.stringify(m)?.slice(0, 120));
});

// ---------------------------------------------------------------------------
// The log of changes
// ---------------------------------------------------------------------------

test('mapBoundary: changes above move a line, changes below leave it, an insertion at it depends on the side', () => {
  const change = (startLine: number, startCharacter: number, endLine: number, endCharacter: number, text: string): TextChange =>
    ({ startLine, startCharacter, endLine, endCharacter, text });
  assert.equal(mapBoundary(5, change(1, 0, 1, 0, 'a\nb\n'), true), 7, 'two lines inserted above');
  assert.equal(mapBoundary(5, change(1, 0, 3, 0, ''), true), 3, 'two lines removed above');
  assert.equal(mapBoundary(5, change(7, 0, 9, 0, ''), true), 5, 'below');
  assert.equal(mapBoundary(5, change(5, 2, 5, 2, 'x\n'), true), 5, 'later on the same line');
  assert.equal(mapBoundary(5, change(5, 0, 5, 0, 'new\n'), true), 6, 'a block start moves past lines put right before it');
  assert.equal(mapBoundary(5, change(5, 0, 5, 0, 'new\n'), false), 5, 'a block end stays before lines put right after it');
  assert.equal(mapBoundary(5, change(4, 3, 4, 3, 'x'), true), 5, 'typing on the line above');
  assert.equal(mapBoundary(5, change(2, 0, 7, 0, 'z'), true), 2, 'inside a replacement');
});

test('EditLog maps a range through the versions after it, and gives up beyond what it keeps', () => {
  const log = new EditLog(1);
  log.record(2, [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0, text: 'a\n' }]);
  log.record(3, [{ startLine: 10, startCharacter: 0, endLine: 12, endCharacter: 0, text: '' }]);
  assert.deepEqual(log.mapRange({ start: 4, end: 6 }, 1, 3), { start: 5, end: 7 });
  assert.deepEqual(log.mapRange({ start: 4, end: 6 }, 2, 3), { start: 4, end: 6 });
  assert.equal(log.mapRange({ start: 4, end: 6 }, 0, 3), undefined, 'older than the log');
  for (let v = 4; v < 1200; v++) log.record(v, []);
  assert.equal(log.mapRange({ start: 4, end: 6 }, 2, 1199), undefined, 'dropped');
});

test('lineSpan is the text of whole lines, line breaks excluded', () => {
  const text = 'a\r\nbb\r\nccc';
  assert.deepEqual(lineSpan(text, { start: 1, end: 2 }), { from: 3, to: 5 });
  assert.deepEqual(lineSpan(text, { start: 1, end: 3 }), { from: 3, to: 10 });
  assert.equal(lineSpan(text, { start: 2, end: 4 }), undefined);
  assert.equal(lineSpan(text, { start: 1, end: 1 }), undefined);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('render: the front matter, top-level blocks with their HTML, gaps, children, forms and problems', () => {
  const h = harness(DOC, { diagnostics: [{ line: 10, message: 'Odd', severity: 'warning' }, { line: 12, message: 'Bad', severity: 'error' }] });
  const r = h.render();
  assert.equal(r.version, 1);
  assert.deepEqual(r.frontMatter && { start: r.frontMatter.start, end: r.frontMatter.end, source: r.frontMatter.source }, { start: 0, end: 3, source: '---\ntitle: Plan\n---' });
  assert.match(r.header, /Plan/);
  const kinds = r.blocks.map((b) => (b.kind === 'gap' ? (b.blank ? 'blank' : 'gap') : b.type));
  assert.deepEqual(kinds, ['blank', 'heading', 'blank', 'paragraph', 'blank', 'container', 'gap', 'paragraph', 'blank']);
  const callout = block(r, ':::warning');
  assert.match(callout.html!, /smd-callout-warning/);
  assert.deepEqual(callout.children!.map((c) => c.type), ['paragraph', 'list'], 'blank gaps inside containers are left out');
  assert.equal(callout.children![0].html, undefined, 'children are found in the container HTML');
  assert.deepEqual(callout.problems, { count: 2, severity: 'error', messages: ['Line 11: Odd', 'Line 13: Bad'] });
  assert.deepEqual(callout.children![1].problems?.count, 1);
  assert.equal(callout.form?.name, 'warning');
  assert.deepEqual(callout.form!.fields.map((f) => [f.name, f.kind, f.value]), [
    ['title', 'title', 'Heads up'], ['collapsible', 'flag', 'true'], ['color', 'color', ''], ['bg', 'color', ''], ['border', 'color', ''],
  ]);
  assert.equal(r.blocks.find((b) => b.kind === 'gap' && !b.blank)?.source, '\n[ref]: https://example.com\n');
  assert.ok(r.templates.some((t) => t.name === 'Callout'));
  assert.deepEqual(h.session.status().blocks, 4);
});

test('containerForm: enumerated values, colors, flags and text, from CONTAINERS', () => {
  const form = containerForm(':::risk{impact=high owner=@a color=#123456} Outage', 'risk')!;
  const byName = Object.fromEntries(form.fields.map((f) => [f.name, f]));
  assert.equal(byName.title.value, 'Outage');
  assert.deepEqual(byName.impact.options, ['', 'low', 'medium', 'high', 'critical']);
  assert.equal(byName.impact.value, 'high');
  assert.equal(byName.likelihood.value, '');
  assert.equal(byName.owner.kind, 'text');
  assert.equal(byName.color.kind, 'color');
  assert.ok(byName.color.options!.includes('#123456') && byName.color.options!.includes('teal'));
  assert.equal(containerForm(':::card{accent=teal}', 'card')!.fields.find((f) => f.name === 'accent')?.kind, 'color');
  assert.equal(containerForm(':::details{title="Shown"} ignored', 'details')!.fields[0].value, 'Shown', 'title="…" wins');
  assert.equal(containerForm(':::warnign', 'warnign'), undefined, 'unknown kind');
  assert.equal(containerForm(':::note{a="x} t', 'note'), undefined, 'attributes that do not parse');
});

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

test('edit: the smallest change inside the block, nothing outside it, then ack', async () => {
  const h = harness(DOC);
  const r = h.render();
  const para = block(r, 'First');
  const reply = await h.send({ type: 'edit', key: para.key, baseVersion: r.version, oldText: para.source, newText: 'First paragraph,\nnow longer\nand longer.', editId: 'e1' });
  assert.deepEqual(reply, { type: 'ack', editId: 'e1', version: 2 });
  onlyLinesChanged(DOC, h.doc.text, para.start, para.end);
  assert.ok(h.doc.text.includes('First paragraph,\nnow longer\nand longer.\n\n:::warning'));
  assert.equal(h.session.status().lastAck, 'e1');
});

test('edit: no change, no edit; an edit the document refuses is a notice', async () => {
  const h = harness(DOC);
  const r = h.render();
  const para = block(r, 'First');
  assert.equal((await h.send({ type: 'edit', key: para.key, baseVersion: 1, oldText: para.source, newText: para.source, editId: 'same' }))?.type, 'ack');
  assert.equal(h.doc.version, 1);
  h.doc.refuse = true;
  assert.equal((await h.send({ type: 'edit', key: para.key, baseVersion: 1, oldText: para.source, newText: 'x', editId: 'no' }))?.type, 'notice');
});

test('edit: a CRLF document stays CRLF, and \\r\\n from the page reads as \\n', async () => {
  const crlf = DOC.replaceAll('\n', '\r\n');
  const h = harness(crlf);
  const r = h.render();
  const para = block(r, 'First');
  assert.equal(para.source, 'First paragraph\nsecond line.', 'the page gets \\n');
  await h.send({ type: 'edit', key: para.key, baseVersion: 1, oldText: 'First paragraph\r\nsecond line.', newText: 'One\nTwo\r\nThree', editId: 'e' });
  assert.ok(h.doc.text.includes('\r\nOne\r\nTwo\r\nThree\r\n\r\n:::warning'));
  assert.doesNotMatch(h.doc.text.replaceAll('\r\n', ''), /\n/, 'no bare \\n');
  onlyLinesChanged(crlf, h.doc.text, para.start, para.end);
});

test('edit: lines a text editor added or removed above in the meantime are taken into account', async () => {
  const h = harness(DOC);
  const r = h.render();
  const last = block(r, 'Last');
  h.doc.type(0, 0, ''); // nothing
  const at = h.doc.text.indexOf('# Plan');
  h.doc.type(at, at, 'Intro line\n\nMore intro\n\n');
  const gone = h.doc.text.indexOf('[ref]');
  h.doc.type(gone, gone + '[ref]: https://example.com\n'.length, '');
  const before = h.doc.text;
  const reply = await h.send({ type: 'edit', key: last.key, baseVersion: r.version, oldText: last.source, newText: 'Last paragraph, edited.', editId: 'e' });
  assert.equal(reply?.type, 'ack');
  assert.equal(h.doc.text, before.replace('Last paragraph.', 'Last paragraph, edited.'));
});

test('edit: a block changed elsewhere is a conflict with its text now, and nothing is written', async () => {
  const h = harness(DOC);
  const r = h.render();
  const para = block(r, 'First');
  const at = h.doc.text.indexOf('second line');
  h.doc.type(at, at + 6, 'SECOND');
  const before = h.doc.text;
  const reply = await h.send({ type: 'edit', key: para.key, baseVersion: r.version, oldText: para.source, newText: 'Mine', editId: 'e9' });
  assert.deepEqual(reply, { type: 'conflict', editId: 'e9', key: para.key, currentText: 'First paragraph\nSECOND line.' });
  assert.equal(h.doc.text, before);
  // Keeping the draft over the new text: the page sends it again against what is there now.
  await h.send({ type: 'edit', key: para.key, baseVersion: h.doc.version, oldText: 'First paragraph\nSECOND line.', newText: 'Mine', editId: 'e10' });
  assert.equal(h.doc.text, before.replace('First paragraph\nSECOND line.', 'Mine'));
});

test('edit: unknown keys, versions from the future and lines that are gone are conflicts', async () => {
  const h = harness(DOC);
  const r = h.render();
  const para = block(r, 'First');
  assert.deepEqual(await h.send({ type: 'edit', key: 'zzz#0', baseVersion: 1, oldText: '', newText: 'x', editId: 'a' }), { type: 'conflict', editId: 'a', key: 'zzz#0', currentText: null });
  assert.equal((await h.send({ type: 'edit', key: para.key, baseVersion: 99, oldText: para.source, newText: 'x', editId: 'b' }))?.type, 'conflict');
  h.doc.type(0, h.doc.text.length, 'short');
  assert.equal((await h.send({ type: 'edit', key: para.key, baseVersion: 1, oldText: para.source, newText: 'x', editId: 'c' }))?.type, 'conflict');
});

test('edit: several edits in a row before the next render follow the block as it grows', async () => {
  const h = harness(DOC);
  const r = h.render();
  const para = block(r, 'First');
  let old = para.source;
  for (const [i, next] of ['One', 'One\nTwo', 'One\nTwo\nThree\n\nFour', 'Five'].entries()) {
    const reply = await h.send({ type: 'edit', key: para.key, baseVersion: r.version, oldText: old, newText: next, editId: `e${i}` });
    assert.equal(reply?.type, 'ack', next);
    old = next;
  }
  onlyLinesChanged(DOC, h.doc.text, para.start, para.end);
  assert.ok(h.doc.text.includes('\n\nFive\n\n:::warning'));
});

test('render after an edit: the edited key is renamed to the block now on its lines, or pinned when they split', async () => {
  const h = harness(DOC);
  const r = h.render();
  const para = block(r, 'First');
  await h.send({ type: 'edit', key: para.key, baseVersion: 1, oldText: para.source, newText: 'Changed.', editId: 'a' });
  const r2 = h.render();
  assert.equal(r2.renamed[para.key], block(r2, 'Changed.').key);
  await h.send({ type: 'edit', key: para.key, baseVersion: r2.version, oldText: 'Changed.', newText: 'Two\n\nparagraphs', editId: 'b' });
  const r3 = h.render();
  assert.deepEqual(r3.pins[para.key], { start: para.start, end: para.start + 3 });
  assert.equal(r3.renamed[para.key], undefined);
});

test('edit: a child of a container is edited on its own; a text editor changing a sibling is no conflict', async () => {
  const h = harness(DOC);
  const r = h.render();
  const child = block(r, 'Inside');
  const at = h.doc.text.indexOf('a task');
  h.doc.type(at, at, 'very ');
  const reply = await h.send({ type: 'edit', key: child.key, baseVersion: r.version, oldText: child.source, newText: 'Inside, edited.', editId: 'c' });
  assert.equal(reply?.type, 'ack');
  assert.ok(h.doc.text.includes('Inside, edited.\n\n- [ ] very a task'));
});

// ---------------------------------------------------------------------------
// Insert, delete, move
// ---------------------------------------------------------------------------

/** `after` is `before` with lines added only: every old line is still there, in order, in runs around the new ones. */
function onlyInserted(before: string, after: string): string[] {
  const a = lines(before);
  const b = lines(after);
  let i = 0;
  const added: string[] = [];
  for (const line of b) {
    if (i < a.length && line === a[i]) i++;
    else added.push(line);
  }
  assert.equal(i, a.length, 'every old line is kept, in order');
  return added;
}

test('insert: after a block, at the start and at the end, only adding lines; the ack asks to edit the new block', async () => {
  const h = harness(DOC);
  const r = h.render();
  const para = block(r, 'First');
  const callout = templates.find((t) => t.name === 'Callout')!;
  let before = h.doc.text;
  const reply = await h.send({ type: 'insert', template: 'Callout', atKey: para.key, editId: 'i1' });
  assert.deepEqual(reply, { type: 'ack', editId: 'i1', version: 2, focus: { line: para.end + 1, edit: true, select: callout.select } });
  assert.deepEqual(onlyInserted(before, h.doc.text).filter(Boolean), callout.text.trimEnd().split('\n').filter(Boolean));
  assert.equal(lines(h.doc.text)[para.end + 1], callout.text.split('\n')[0]);

  before = h.doc.text;
  await h.send({ type: 'insert', template: 'Table', position: 'start', editId: 'i2' });
  onlyInserted(before, h.doc.text);
  assert.match(lines(h.doc.text)[4], /^\|/, 'right after the front matter');

  before = h.doc.text;
  await h.send({ type: 'insert', template: 'Math block', position: 'end', editId: 'i3' });
  onlyInserted(before, h.doc.text);
  assert.match(h.doc.text, /Last paragraph\.\n\n\$\$\n[^]*\n\$\$\n$/, 'before the final line break');
  assert.equal((await h.send({ type: 'insert', template: 'Nope', position: 'end', editId: 'i4' }))?.type, 'notice');
});

test('insert: into an empty document, and in a CRLF document with CRLF', async () => {
  const empty = harness('');
  empty.render();
  await empty.send({ type: 'insert', template: 'Math block', position: 'end', editId: 'a' });
  assert.match(empty.doc.text, /^\$\$\n/);
  const crlf = harness('# A\r\n\r\nText\r\n');
  const r = crlf.render();
  await crlf.send({ type: 'insert', template: 'Math block', atKey: block(r, '# A').key, editId: 'b' });
  assert.match(crlf.doc.text, /^# A\r\n\r\n\$\$\r\n[^\n]*\r\n\$\$\r\n\r\nText\r\n$/);
});

test('delete: the block and one blank line, nothing else', async () => {
  const h = harness(DOC);
  const r = h.render();
  const para = block(r, 'First');
  const reply = await h.send({ type: 'delete', key: para.key, editId: 'd' });
  assert.deepEqual(reply, { type: 'ack', editId: 'd', version: 2, focus: { line: para.start } });
  const expected = lines(DOC);
  expected.splice(para.start, para.end - para.start + 1);
  assert.equal(h.doc.text, expected.join('\n'));
  // A child of a container.
  const r2 = h.render();
  const child = block(r2, '- [ ]');
  await h.send({ type: 'delete', key: child.key, editId: 'd2' });
  assert.ok(h.doc.text.includes('Inside the callout.\n:::'), h.doc.text);
});

test('delete: a block that changed since the page got it is a conflict', async () => {
  const h = harness(DOC);
  const r = h.render();
  const para = block(r, 'Last');
  const at = h.doc.text.indexOf('Last');
  h.doc.type(at, at, 'The ');
  assert.equal((await h.send({ type: 'delete', key: para.key, editId: 'd' }))?.type, 'conflict');
  assert.ok(h.doc.text.includes('The Last paragraph.'));
  assert.equal((await h.send({ type: 'delete', key: para.key }))?.type, 'notice', 'without an editId');
});

test('move: up and down among siblings, the lines between unchanged, the same lines overall', async () => {
  const h = harness(DOC);
  const r = h.render();
  const para = block(r, 'First');
  const reply = await h.send({ type: 'move', key: para.key, direction: 'up', editId: 'm' });
  assert.equal(reply?.type, 'ack');
  assert.equal(h.doc.text, DOC.replace('# Plan\n\nFirst paragraph\nsecond line.', 'First paragraph\nsecond line.\n\n# Plan'));
  assert.deepEqual((reply as { focus: unknown }).focus, { line: 4 });
  const r2 = h.render();
  await h.send({ type: 'move', key: block(r2, 'First').key, direction: 'down', editId: 'm2' });
  assert.equal(h.doc.text, DOC);
  // Inside a container, among its own children.
  const r3 = h.render();
  await h.send({ type: 'move', key: block(r3, '- [ ]').key, direction: 'up', editId: 'm3' });
  assert.ok(h.doc.text.includes(':::warning{collapsible} Heads up\n- [ ] a task\n\nInside the callout.\n:::'), h.doc.text);
});

test('move: not past the first or last sibling, and never the front matter', async () => {
  const h = harness(DOC);
  const r = h.render();
  assert.equal((await h.send({ type: 'move', key: block(r, '# Plan').key, direction: 'up', editId: 'a' }))?.type, 'notice');
  assert.equal((await h.send({ type: 'move', key: block(r, 'Last').key, direction: 'down', editId: 'b' }))?.type, 'notice');
  assert.equal((await h.send({ type: 'move', key: r.frontMatter!.key, direction: 'down', editId: 'c' }))?.type, 'notice');
  assert.equal(h.doc.text, DOC);
});

// ---------------------------------------------------------------------------
// Header forms, front matter, flush
// ---------------------------------------------------------------------------

test('setAttr and setTitle change only the opening line, and only what they set', async () => {
  const h = harness(DOC);
  const callout = () => block(h.render(), ':::warning');
  const lineOf = () => lines(h.doc.text)[9];
  await h.send({ type: 'setAttr', key: callout().key, name: 'color', value: 'teal', editId: 'a' });
  assert.equal(lineOf(), ':::warning{collapsible color=teal} Heads up');
  await h.send({ type: 'setAttr', key: callout().key, name: 'collapsible', value: null, editId: 'b' });
  assert.equal(lineOf(), ':::warning{color=teal} Heads up');
  await h.send({ type: 'setTitle', key: callout().key, title: 'Mind the gap', editId: 'c' });
  assert.equal(lineOf(), ':::warning{color=teal} Mind the gap');
  const reply = await h.send({ type: 'setAttr', key: callout().key, name: 'collapsible', value: true, editId: 'd' });
  assert.deepEqual((reply as { focus: unknown }).focus, { line: 9 });
  assert.equal(lineOf(), ':::warning{collapsible color=teal} Mind the gap');
  const expected = lines(DOC);
  expected[9] = lineOf();
  assert.equal(h.doc.text, expected.join('\n'));
  assert.equal((await h.send({ type: 'setAttr', key: callout().key, name: 'color', value: 'a"b\'c', editId: 'e' }))?.type, 'notice');
  assert.equal((await h.send({ type: 'setTitle', key: block(h.render(), 'Last').key, title: 'x', editId: 'f' }))?.type, 'notice', 'not a container');
});

test('form changes and moves in a row, before the next render, still find their block', async () => {
  const h = harness(DOC);
  const r = h.render();
  const callout = block(r, ':::warning');
  await h.send({ type: 'setAttr', key: callout.key, name: 'color', value: 'teal', editId: 'a' });
  assert.equal((await h.send({ type: 'setTitle', key: callout.key, title: 'Careful', editId: 'b' }))?.type, 'ack');
  assert.equal(lines(h.doc.text)[9], ':::warning{collapsible color=teal} Careful');
  const last = block(r, 'Last');
  assert.equal((await h.send({ type: 'move', key: last.key, direction: 'up', editId: 'c' }))?.type, 'ack');
  assert.equal((await h.send({ type: 'move', key: last.key, direction: 'up', editId: 'd' }))?.type, 'ack');
  assert.ok(h.doc.text.includes('# Plan\n\nLast paragraph.\n\nFirst paragraph\nsecond line.\n'), h.doc.text);
});

test('addFrontMatter puts a title block at the top, once', async () => {
  const h = harness('# Doc\n\nText\n', { title: 'My notes: draft' });
  h.render();
  const reply = await h.send({ type: 'addFrontMatter', editId: 'f' });
  assert.equal(h.doc.text, '---\ntitle: "My notes: draft"\n---\n\n# Doc\n\nText\n');
  const focus = (reply as { focus: { select: { from: number; to: number } } }).focus;
  assert.equal('---\ntitle: "My notes: draft"\n---'.slice(focus.select.from, focus.select.to), '"My notes: draft"');
  assert.equal((await h.send({ type: 'addFrontMatter', editId: 'g' }))?.type, 'notice');
  assert.equal(yamlScalar('Plan 2026'), 'Plan 2026');
  assert.equal(yamlScalar('yes: no'), '"yes: no"');
});

test('flush resolves once the page has answered (and its edit is in), or after the timeout', async () => {
  const h = harness(DOC);
  const r = h.render();
  const para = block(r, 'First');
  const done = h.session.flush(5000);
  const request = h.sent.at(-1) as { type: string; requestId: number };
  assert.equal(request.type, 'flush');
  void h.session.handle({ type: 'edit', key: para.key, baseVersion: 1, oldText: para.source, newText: 'Saved', editId: 'x' });
  void h.session.handle({ type: 'flushed', requestId: request.requestId });
  await done;
  assert.ok(h.doc.text.includes('\nSaved\n'));
  const start = Date.now();
  await h.session.flush(20);
  assert.ok(Date.now() - start < 2000);
});

test('ready sends a render; status counts blocks and keys', async () => {
  const h = harness(DOC);
  const reply = await h.send({ type: 'ready' });
  assert.equal(reply?.type, 'render');
  const status = h.session.status();
  assert.equal(status.blocks, 4);
  assert.equal(status.keys.length, 4);
  assert.equal(status.renders, 1);
  assert.equal(status.lastAck, null);
});

// ---------------------------------------------------------------------------
// Property: random edits to random blocks change no line outside the edited block
// ---------------------------------------------------------------------------

const corpusDir = path.join(__dirname, 'compat', 'corpus');
const examplesDir = path.join(__dirname, '..', '..', 'examples');
const readDir = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.smd')).sort().map((f) => ({ name: f, dir, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
const RUNS = Number(process.env.SMD_FUZZ_RUNS ?? 300);

const editable = (views: readonly BlockView[]): BlockView[] =>
  views.flatMap((v) => [...(v.kind === 'block' || !v.blank ? [v] : []), ...editable(v.children ?? [])]);

function mutate(random: () => number, source: string): string {
  const pieces = ['', 'x', '\n', '\n\n', ':::', '- ', '# ', '```', '|', 'é😀', '\r\n', ' '];
  let text = source;
  const count = 1 + Math.floor(random() * 3);
  for (let i = 0; i < count; i++) {
    const at = Math.floor(random() * (text.length + 1));
    const cut = Math.floor(random() * 4);
    text = text.slice(0, at) + pieces[Math.floor(random() * pieces.length)] + text.slice(Math.min(text.length, at + cut));
  }
  return text;
}

test('property: random edits to random blocks (and children) of every example and corpus file change no other line', async () => {
  const random = prng(20261014);
  const documents = [...readDir(examplesDir), ...readDir(corpusDir)];
  const perDoc = Math.max(4, Math.ceil(RUNS / documents.length));
  for (const d of documents) {
    for (const eol of ['\n', '\r\n']) {
      const text = d.text.replaceAll('\r\n', '\n').replaceAll('\n', eol);
      const h = harness(text, { render: { readFile: (p) => (fs.existsSync(path.join(d.dir, p)) ? fs.readFileSync(path.join(d.dir, p), 'utf8') : undefined) } });
      for (let i = 0; i < perDoc; i++) {
        const r = h.render();
        const candidates = editable(r.blocks);
        if (r.frontMatter) candidates.push({ ...r.frontMatter, kind: 'block', type: 'frontmatter' });
        const picked = candidates[Math.floor(random() * candidates.length)];
        const target = { ...picked };
        if (random() < 0.3) {
          // Meanwhile, a text editor adds a line somewhere else.
          const all = lines(h.doc.text);
          const line = Math.floor(random() * (all.length + 1));
          if (line <= target.start || line >= target.end) {
            const offset = all.slice(0, line).reduce((sum, l) => sum + l.length + eol.length, 0);
            h.doc.type(Math.min(offset, h.doc.text.length), Math.min(offset, h.doc.text.length), `meanwhile${eol}`);
            if (line <= target.start) {
              target.start++;
              target.end++;
            }
          }
        }
        const before = h.doc.text;
        const newText = mutate(random, target.source);
        const reply = await h.send({ type: 'edit', key: target.key, baseVersion: r.version, oldText: target.source, newText, editId: `p${i}` });
        const where = `${d.name} (${JSON.stringify(eol)}) edit ${i} of lines ${target.start}-${target.end}`;
        assert.equal(reply?.type, 'ack', `${where}: ${JSON.stringify({ reply, source: target.source, newText, prev: i ? lines(before).slice(target.start - 2, target.end + 2) : [] })}`);
        onlyLinesChanged(before, h.doc.text, target.start, target.end);
        const changed = lines(h.doc.text).slice(target.start, lines(h.doc.text).length - (lines(before).length - target.end));
        assert.equal(changed.join('\n'), newText.replaceAll(/\r\n?/g, '\n'), where);
        if (eol === '\r\n') assert.doesNotMatch(h.doc.text.replaceAll('\r\n', ''), /\n/, `${where}: CRLF kept`);
      }
    }
  }
});

/**
 * A move: the block's lines are in the new text as one run, and without them both texts have the same lines in the
 * same order, but for blank lines (one may go or come with the block).
 */
function assertMoved(before: string, after: string, target: BlockView, name: string): void {
  if (before === after) return;
  const run = lines(before).slice(target.start, target.end);
  const a = lines(before);
  a.splice(target.start, run.length);
  const b = lines(after);
  const at = b.findIndex((_, i) => run.every((l, j) => b[i + j] === l));
  assert.ok(at >= 0, `${name}: the moved block is one run`);
  b.splice(at, run.length);
  const nonBlank = (ls: string[]) => ls.filter((l) => l.trim() !== '');
  assert.deepEqual(nonBlank(b), nonBlank(a), `${name}: every other line is kept, in order`);
  assert.ok(Math.abs(a.length - b.length) <= 2, `${name}: at most two blank lines differ`);
}

test('property: insert, move and delete never change a line they do not add, move or remove', async () => {
  const random = prng(7);
  const documents = [...readDir(examplesDir), ...readDir(corpusDir)];
  for (const d of documents) {
    const h = harness(d.text);
    for (let i = 0; i < 6; i++) {
      const r = h.render();
      const blocks = editable(r.blocks).filter((b) => b.kind === 'block');
      const target = blocks[Math.floor(random() * blocks.length)];
      const before = h.doc.text;
      const op = i % 3;
      if (op === 0) {
        await h.send({ type: 'insert', template: templates[Math.floor(random() * templates.length)].name, atKey: target.key, editId: `i${i}` });
        onlyInserted(before, h.doc.text);
      } else if (op === 1) {
        await h.send({ type: 'delete', key: target.key, editId: `d${i}` });
        onlyInserted(h.doc.text, before);
      } else {
        await h.send({ type: 'move', key: target.key, direction: random() < 0.5 ? 'up' : 'down', editId: `m${i}` });
        assertMoved(before, h.doc.text, target, d.name);
      }
    }
  }
});

test('segments of the fake document agree with segmentSmd (the session sees what the page sees)', () => {
  const h = harness(DOC);
  const r = h.render();
  const top = segmentSmd(DOC).filter((s: Segment) => s.kind !== 'frontmatter').map((s) => s.key);
  assert.deepEqual(r.blocks.map((b) => b.key), top);
});

// ---------------------------------------------------------------------------
// Inline directives and styled spans (setInline)
// ---------------------------------------------------------------------------

const INLINE_DOC = [
  '---',
  'title: Plan',
  'version: 2',
  '---',
  '',
  'Ship :badge[Beta]{color=blue .x} by :due[2026-10-30], :priority[P1] and [this]{color=red} `:badge[code]` v :badge[v{{version}}]',
  '',
  '- [ ] task :progress{value=40} :metric[42%]{label="Act" trend=up}',
  '',
  'Last.',
  '',
].join('\n');
const INLINE_ON = { render: { inlineIndex: true } };

test('readEditorMessage: setInline with its fields; anything malformed is ignored', () => {
  const key = 'abc123#0';
  const ok = { type: 'setInline', key, index: 2, name: 'badge', content: 'New', attrs: { color: 'red', bg: null }, editId: 'e1' };
  assert.deepEqual(readEditorMessage(ok), ok);
  assert.deepEqual(readEditorMessage({ type: 'setInline', key, index: 0, name: 'span' }), { type: 'setInline', key, index: 0, name: 'span' });
  const proto = readEditorMessage({ type: 'setInline', key, index: 0, name: 'span', attrs: JSON.parse('{"__proto__":"x"}') });
  assert.ok(proto?.type === 'setInline' && Object.hasOwn(proto.attrs!, '__proto__'), '"__proto__" stays a key');
  const invalid: unknown[] = [
    { type: 'setInline', key, index: -1, name: 'badge' },
    { type: 'setInline', key, index: 1.5, name: 'badge' },
    { type: 'setInline', key, index: 10_001, name: 'badge' },
    { type: 'setInline', key, index: 0, name: 'Badge' },
    { type: 'setInline', key, index: 0 },
    { type: 'setInline', key: 'x', index: 0, name: 'badge' },
    { type: 'setInline', key, index: 0, name: 'badge', content: 3 },
    { type: 'setInline', key, index: 0, name: 'badge', content: 'x'.repeat(2001) },
    { type: 'setInline', key, index: 0, name: 'badge', attrs: [] },
    { type: 'setInline', key, index: 0, name: 'badge', attrs: 'color=red' },
    { type: 'setInline', key, index: 0, name: 'badge', attrs: { 'bad key': 'x' } },
    { type: 'setInline', key, index: 0, name: 'badge', attrs: { color: 3 } },
    { type: 'setInline', key, index: 0, name: 'badge', attrs: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) },
    { type: 'setInline', key, index: 0, name: 'badge', editId: 'has space' },
  ];
  for (const m of invalid) assert.equal(readEditorMessage(m), undefined, JSON.stringify(m));
});

test('render: a block\'s inline items by number, with forms; marks only when the render asks for them', () => {
  const plain = block(harness(INLINE_DOC).render(), 'Ship');
  assert.equal(plain.inline, undefined);
  assert.doesNotMatch(plain.html!, /data-smd-inline/);
  const r = harness(INLINE_DOC, INLINE_ON).render();
  const ship = block(r, 'Ship');
  assert.deepEqual(ship.inline!.map((i) => [i.index, i.name, i.label, i.text]), [
    [0, 'badge', 'Badge', 'Beta'], [1, 'due', 'Due date', '2026-10-30'], [2, 'priority', 'Priority', 'P1'], [3, 'span', 'Styled text', 'this'],
    [4, 'badge', 'Badge', 'v{{version}}'],
  ]);
  assert.equal((ship.html!.match(/data-smd-inline="/g) ?? []).length, 5);
  const fields = (i: number) => ship.inline![i].fields!.map((f) => `${f.name}:${f.kind}:${f.value}`);
  assert.deepEqual(fields(0), ['content:text:Beta', 'color:color:blue']);
  assert.deepEqual(fields(1), ['content:date:2026-10-30']);
  assert.deepEqual(fields(2), ['content:select:P1']);
  assert.deepEqual(fields(3), ['color:color:red', 'bg:color:', 'border:color:']);
  assert.ok(ship.inline![2].fields![0].options!.includes('P0'));
  const task = block(r, '- [ ]');
  assert.deepEqual(task.inline!.map((i) => i.fields!.map((f) => f.name)), [['value', 'color', 'label'], ['content', 'label', 'delta', 'trend', 'good']]);
  assert.deepEqual(task.inline![1].fields!.find((f) => f.name === 'trend')!.options, ['', 'up', 'down', 'flat']);
  assert.equal(block(r, 'Last').inline, undefined, 'a block without items has none');
});

test('setInline: only the item\'s own text changes; everything else on the line and in the document stays', async () => {
  const h = harness(INLINE_DOC, INLINE_ON);
  const ship = block(h.render(), 'Ship');
  const before = h.doc.text;
  const ack = await h.send({ type: 'setInline', key: ship.key, index: 0, name: 'badge', content: 'GA', attrs: { color: 'green' }, editId: 'i1' });
  assert.deepEqual(ack, { type: 'ack', editId: 'i1', version: 2, focus: { line: ship.start, inline: 0 } });
  assert.equal(h.doc.text, before.replace(':badge[Beta]{color=blue .x}', ':badge[GA]{color=green .x}'));
  onlyLinesChanged(before, h.doc.text, ship.start, ship.end);
  // Before the next render: the next change from the same form still finds the block (pinned), checked against a fresh render.
  await h.send({ type: 'setInline', key: ship.key, index: 1, name: 'due', content: '2026-11-02', editId: 'i2' });
  await h.send({ type: 'setInline', key: ship.key, index: 2, name: 'priority', content: 'P0', editId: 'i3' });
  await h.send({ type: 'setInline', key: ship.key, index: 3, name: 'span', attrs: { color: null, border: 'amber' }, editId: 'i4' });
  assert.equal(lines(h.doc.text)[ship.start],
    'Ship :badge[GA]{color=green .x} by :due[2026-11-02], :priority[P0] and [this]{border=amber} `:badge[code]` v :badge[v{{version}}]');
  assert.deepEqual(h.sent.slice(-3).map((m) => m.type), ['ack', 'ack', 'ack']);
  const task = block(h.render(), '- [ ]');
  await h.send({ type: 'setInline', key: task.key, index: 1, name: 'metric', attrs: { trend: 'down', label: 'Activation rate' }, editId: 'i5' });
  assert.equal(lines(h.doc.text)[task.start], '- [ ] task :progress{value=40} :metric[42%]{label="Activation rate" trend=down}');
});

test('setInline: a variable in the content is compared as rendered, and the content is written as typed', async () => {
  const h = harness(INLINE_DOC, INLINE_ON);
  const ship = block(h.render(), 'Ship');
  await h.send({ type: 'setInline', key: ship.key, index: 4, name: 'badge', content: 'v{{version}}-rc', editId: 'v1' });
  assert.match(lines(h.doc.text)[ship.start], /v :badge\[v\{\{version\}\}-rc\]$/);
});

test('setInline: a CRLF document stays CRLF', async () => {
  const h = harness(INLINE_DOC.replaceAll('\n', '\r\n'), INLINE_ON);
  const ship = block(h.render(), 'Ship');
  await h.send({ type: 'setInline', key: ship.key, index: 0, name: 'badge', attrs: { color: 'red' }, editId: 'c1' });
  assert.equal(h.doc.text, INLINE_DOC.replace('color=blue', 'color=red').replaceAll('\n', '\r\n'));
});

test('setInline: a block changed in another editor is a conflict, and nothing is written', async () => {
  const h = harness(INLINE_DOC, INLINE_ON);
  const ship = block(h.render(), 'Ship');
  const at = h.doc.text.indexOf('Ship');
  h.doc.type(at, at + 4, 'Send');
  const changed = h.doc.text;
  const reply = await h.send({ type: 'setInline', key: ship.key, index: 0, name: 'badge', attrs: { color: 'red' }, editId: 'x1' });
  assert.equal(reply?.type, 'conflict');
  assert.equal(h.doc.text, changed);
});

test('setInline: a wrong name, a field the form lacks or a value that can\'t be written is refused, and nothing is written', async () => {
  const h = harness(INLINE_DOC, INLINE_ON);
  const ship = block(h.render(), 'Ship');
  const before = h.doc.text;
  const refused = async (message: SessionMessage) => {
    const reply = await h.send(message);
    assert.equal(h.doc.text, before, JSON.stringify(message));
    return reply;
  };
  const fallback = { type: 'notice', editId: 'r', fallback: ship.key };
  assert.deepEqual({ ...(await refused({ type: 'setInline', key: ship.key, index: 0, name: 'status', attrs: { color: 'red' }, editId: 'r' })), text: '' }, { ...fallback, text: '' });
  assert.equal((await refused({ type: 'setInline', key: ship.key, index: 9, name: 'badge', editId: 'r' }) as { fallback?: string }).fallback, ship.key, 'no such item');
  const lacking = await refused({ type: 'setInline', key: ship.key, index: 1, name: 'due', attrs: { color: 'red' }, editId: 'r' });
  assert.equal(lacking?.type, 'notice');
  assert.equal((lacking as { fallback?: string }).fallback, undefined, 'a field the form lacks: just a notice');
  await refused({ type: 'setInline', key: ship.key, index: 2, name: 'priority', attrs: { content: 'P0' }, editId: 'r' });
  // Content that would end the brackets early, or a value no attribute list can hold.
  assert.equal((await refused({ type: 'setInline', key: ship.key, index: 0, name: 'badge', content: 'a]b', editId: 'r' }) as { fallback?: string }).fallback, ship.key);
  await refused({ type: 'setInline', key: ship.key, index: 0, name: 'badge', attrs: { color: 'a"b\'c' }, editId: 'r' });
  await refused({ type: 'setInline', key: ship.key, index: 0, name: 'badge', content: 'two\nlines', editId: 'r' });
});

test('setInline: when the source and the HTML don\'t agree on the items, nothing has a form and every change is refused', async () => {
  // A scan that misses the first item: the numbers no longer match, so no item of the block can be trusted.
  const h = harness(INLINE_DOC, { ...INLINE_ON, scan: (ls) => scanInline(ls).slice(1) });
  const ship = block(h.render(), 'Ship');
  assert.ok(ship.inline!.every((i) => i.fields === undefined));
  const before = h.doc.text;
  const reply = await h.send({ type: 'setInline', key: ship.key, index: 1, name: 'due', content: '2026-12-01', editId: 'm1' });
  assert.equal(reply?.type, 'notice');
  assert.equal((reply as { fallback?: string }).fallback, ship.key, 'the page edits the source instead');
  assert.equal(h.doc.text, before);
  // Without numbered HTML (a render without inlineIndex) there is nothing to match either.
  const off = harness(INLINE_DOC);
  const plain = block(off.render(), 'Ship');
  const r2 = await off.send({ type: 'setInline', key: plain.key, index: 0, name: 'badge', attrs: { color: 'red' }, editId: 'm2' });
  assert.equal((r2 as { fallback?: string }).fallback, plain.key);
});

test('inlineFields and inlineAgree', () => {
  const [badge, span] = scanInline([':badge[A]{color=#123456} [t]{bg=teal}']);
  assert.deepEqual(inlineFields(badge)!.find((f) => f.name === 'color')!.options!.at(-1), '#123456', 'a color not in the list is kept as a choice');
  assert.deepEqual(inlineFields(span)!.map((f) => f.value), ['', 'teal', '']);
  assert.equal(inlineFields({ ...badge, at: undefined }), undefined, 'an item without a place has no form');
  assert.equal(inlineFields(scanInline([':due[{{when}}]'])[0])![0].kind, 'text', 'a date written as a variable is text');
  const rendered: RenderedInline[] = [{ kind: 'directive', name: 'badge', content: 'A', values: { color: '#123456' } }, { kind: 'span', name: 'span', content: '', values: { bg: 'teal' } }];
  assert.ok(inlineAgree([badge, span], rendered, {}));
  assert.ok(!inlineAgree([badge], rendered, {}));
  assert.ok(!inlineAgree([badge, span], [rendered[0], { ...rendered[1], values: { bg: 'red' } }], {}));
  assert.ok(!inlineAgree([badge, span], [{ ...rendered[0], content: 'B' }, rendered[1]], {}));
});

test('property: setInline on every item of every example and corpus file changes only that item\'s text', async () => {
  const random = prng(11);
  const colors = ['red', 'green', 'teal', 'muted'];
  let applied = 0;
  for (const d of [...readDir(examplesDir), ...readDir(corpusDir)]) {
    const h = harness(d.text, INLINE_ON);
    const r = h.render();
    for (const b of r.blocks.filter((v) => v.inline?.some((i) => i.fields))) {
      const item = b.inline!.find((i) => i.fields)!;
      const field = item.fields![Math.floor(random() * item.fields!.length)];
      const value = field.options?.length ? field.options[Math.floor(random() * field.options.length)] : colors[Math.floor(random() * colors.length)];
      const message: SessionMessage = field.name === 'content'
        ? { type: 'setInline', key: b.key, index: item.index, name: item.name, content: value || 'x', editId: `p${applied}` }
        : { type: 'setInline', key: b.key, index: item.index, name: item.name, attrs: { [field.name]: value || null }, editId: `p${applied}` };
      const before = h.doc.text;
      const reply = await h.send(message);
      if (reply?.type !== 'ack') continue;
      applied++;
      onlyLinesChanged(before, h.doc.text, b.start, b.end);
      const a = lines(before);
      const c = lines(h.doc.text);
      const changed = a.map((l, i) => (l === c[i] ? -1 : i)).filter((i) => i >= 0);
      assert.ok(changed.length <= 1, `${d.name}: at most one line changes`);
      h.render();
    }
  }
  assert.ok(applied > 20, `inline edits applied (${applied})`);
});

// ---------------------------------------------------------------------------
// Tables: the grid
// ---------------------------------------------------------------------------

const TABLE_DOC = [
  '# Tables',
  '',
  '| Name  | Status | Notes |',
  '| ----- | :----: | ----- |',
  '| Alice | :badge[Done]{color=green} | `a\\|b` |',
  '| Bob   | open   | x \\| y |',
  '',
  ':::note Inside',
  'Name | Age',
  '--- | ---:',
  'Carol | 41',
  ':::',
  '',
  '| a | b |',
  '|---|---|',
  '| ragged |',
  '',
].join('\n');

const ack = (editId: string, version: number, line: number, cell: { row: number; col: number }) => ({ type: 'ack', editId, version, focus: { line, cell } });

test('readEditorMessage: the table messages with their fields; anything malformed is ignored', () => {
  const key = 'abc123#0';
  const valid: [unknown, unknown][] = [
    [{ type: 'tableCell', key, row: 2, col: 1, text: 'x', editId: 't1' }, { type: 'tableCell', key, row: 2, col: 1, text: 'x', editId: 't1' }],
    [{ type: 'tableCell', key, row: 0, col: 0, text: '' }, { type: 'tableCell', key, row: 0, col: 0, text: '' }],
    [{ type: 'tableRow', key, op: 'insert', at: 1 }, { type: 'tableRow', key, op: 'insert', at: 1 }],
    [{ type: 'tableRow', key, op: 'delete', at: 3, editId: 'r' }, { type: 'tableRow', key, op: 'delete', at: 3, editId: 'r' }],
    [{ type: 'tableCol', key, op: 'insert', at: 0 }, { type: 'tableCol', key, op: 'insert', at: 0 }],
    [{ type: 'tableCol', key, op: 'delete', at: 2, extra: 1 }, { type: 'tableCol', key, op: 'delete', at: 2 }],
    [{ type: 'tableCol', key, op: 'align', at: 1, align: 'center' }, { type: 'tableCol', key, op: 'align', at: 1, align: 'center' }],
    [{ type: 'tableCol', key, op: 'align', at: 1, align: 'none' }, { type: 'tableCol', key, op: 'align', at: 1, align: 'none' }],
    [{ type: 'tableAlign', key, editId: 'a' }, { type: 'tableAlign', key, editId: 'a' }],
  ];
  for (const [raw, read] of valid) assert.deepEqual(readEditorMessage(raw), read, JSON.stringify(raw));
  const invalid: unknown[] = [
    { type: 'tableCell', key, row: 1, col: 1 },
    { type: 'tableCell', key, row: -1, col: 1, text: 'x' },
    { type: 'tableCell', key, row: 1.5, col: 1, text: 'x' },
    { type: 'tableCell', key, row: 1, col: 100_001, text: 'x' },
    { type: 'tableCell', key, row: 1, col: 1, text: 'x'.repeat(10_001) },
    { type: 'tableCell', key: 'nope', row: 1, col: 1, text: 'x' },
    { type: 'tableCell', key, row: 1, col: 1, text: 'x', editId: 'bad id' },
    { type: 'tableRow', key, op: 'move', at: 1 },
    { type: 'tableRow', key, at: 1 },
    { type: 'tableRow', key, op: 'insert', at: '1' },
    { type: 'tableCol', key, op: 'align', at: 1 },
    { type: 'tableCol', key, op: 'align', at: 1, align: 'justify' },
    { type: 'tableCol', key, op: 'insert', at: 1, align: 'left' },
    { type: 'tableCol', key, op: 'delete' },
    { type: 'tableAlign' },
    { type: 'tableAlign', key, editId: 7 },
  ];
  for (const m of invalid) assert.equal(readEditorMessage(m), undefined, JSON.stringify(m).slice(0, 120));
});

test('render: a table block has its cells as written and its alignments, at the top level and in a container; a ragged one says why not', () => {
  const r = harness(TABLE_DOC).render();
  assert.deepEqual(block(r, '| Name').table, {
    rows: [['Name', 'Status', 'Notes'], ['Alice', ':badge[Done]{color=green}', '`a\\|b`'], ['Bob', 'open', 'x \\| y']],
    aligns: ['none', 'center', 'none'],
  });
  assert.deepEqual(block(r, 'Name | Age').table, { rows: [['Name', 'Age'], ['Carol', '41']], aligns: ['none', 'right'] });
  assert.match(block(r, '| a | b').table!.refused!, /Line 3 of the table has 1 cells and the header has 2/);
  assert.equal(block(r, '# Tables').table, undefined);
});

test('tableCell: only the cell\'s text changes, on its own line; pipes are escaped; the ack names the cell', async () => {
  const h = harness(TABLE_DOC);
  const t = block(h.render(), '| Name');
  const before = h.doc.text;
  assert.deepEqual(await h.send({ type: 'tableCell', key: t.key, row: 2, col: 1, text: 'closed', editId: 'c1' }), ack('c1', 2, 2, { row: 2, col: 1 }));
  assert.equal(h.doc.text, before.replace('| Bob   | open   |', '| Bob   | closed   |'));
  onlyLinesChanged(before, h.doc.text, 5, 6);
  // Before the next render, the next changes from the grid still find the table (pinned).
  await h.send({ type: 'tableCell', key: t.key, row: 1, col: 0, text: 'Al|ice', editId: 'c2' });
  await h.send({ type: 'tableCell', key: t.key, row: 0, col: 2, text: '  ', editId: 'c3' });
  assert.deepEqual(lines(h.doc.text).slice(2, 6), [
    '| Name  | Status |  |',
    '| ----- | :----: | ----- |',
    '| Al\\|ice | :badge[Done]{color=green} | `a\\|b` |',
    '| Bob   | closed   | x \\| y |',
  ]);
  assert.deepEqual(block(h.render(), '| Name').table!.rows![1], ['Al\\|ice', ':badge[Done]{color=green}', '`a\\|b`']);
});

test('tableRow and tableCol: a row is one line added or removed; a column, on each line, one cell and its pipe', async () => {
  const h = harness(TABLE_DOC);
  const t = block(h.render(), '| Name');
  assert.deepEqual(await h.send({ type: 'tableRow', key: t.key, op: 'insert', at: 2, editId: 'r1' }), ack('r1', 2, 2, { row: 2, col: 0 }));
  assert.deepEqual(lines(h.doc.text).slice(4, 7), ['| Alice | :badge[Done]{color=green} | `a\\|b` |', '|       |        |        |', '| Bob   | open   | x \\| y |']);
  await h.send({ type: 'tableRow', key: t.key, op: 'delete', at: 1, editId: 'r2' });
  assert.deepEqual(await h.send({ type: 'tableCol', key: t.key, op: 'insert', at: 1, editId: 'r3' }), ack('r3', 4, 2, { row: 0, col: 1 }));
  await h.send({ type: 'tableCol', key: t.key, op: 'align', at: 3, align: 'right', editId: 'r4' });
  await h.send({ type: 'tableCol', key: t.key, op: 'delete', at: 2, editId: 'r5' });
  assert.deepEqual(lines(h.doc.text).slice(0, 8), [
    '# Tables',
    '',
    '| Name  |        | Notes |',
    '| ----- | ------ | ----: |',
    '|       |        |        |',
    '| Bob   |        | x \\| y |',
    '',
    ':::note Inside',
  ]);
  assert.deepEqual(lines(h.doc.text).slice(7), lines(TABLE_DOC).slice(7), 'the lines after the table are untouched');
  assert.deepEqual(block(h.render(), '| Name').table!.aligns, ['none', 'none', 'right']);
});

test('table edits in a container\'s table touch only its lines; Align table formats it as smd fmt does', async () => {
  const h = harness(TABLE_DOC);
  const t = block(h.render(), 'Name | Age');
  const before = h.doc.text;
  await h.send({ type: 'tableCol', key: t.key, op: 'insert', at: 2, editId: 'n1' });
  assert.deepEqual(lines(h.doc.text).slice(8, 11), ['Name | Age |      |', '--- | ---: | ----', 'Carol | 41 |      |']);
  onlyLinesChanged(before, h.doc.text, 8, 11);
  assert.deepEqual(await h.send({ type: 'tableAlign', key: t.key, editId: 'n2' }), ack('n2', 3, 8, { row: 0, col: 0 }));
  assert.deepEqual(lines(h.doc.text).slice(7, 12), [':::note Inside', '| Name  | Age |     |', '| ----- | --: | --- |', '| Carol |  41 |     |', ':::']);
  const notice = h.sent.length;
  await h.send({ type: 'tableAlign', key: t.key, editId: 'n3' });
  assert.deepEqual(h.sent.slice(notice).map((m) => m.type), ['notice', 'ack'], 'already aligned: said so, nothing written');
  assert.match((h.sent[notice] as { text: string }).text, /already aligned/);
});

test('table edits: a CRLF document stays CRLF', async () => {
  const h = harness(TABLE_DOC.replaceAll('\n', '\r\n'));
  const t = block(h.render(), '| Name');
  await h.send({ type: 'tableCell', key: t.key, row: 2, col: 0, text: 'Robert', editId: 'w1' });
  await h.send({ type: 'tableRow', key: t.key, op: 'insert', at: 3, editId: 'w2' });
  await h.send({ type: 'tableCol', key: t.key, op: 'insert', at: 0, editId: 'w3' });
  assert.doesNotMatch(h.doc.text, /[^\r]\n/, 'every line break is CRLF');
  assert.deepEqual(lines(h.doc.text).slice(5, 7), ['|       | Robert   | open   | x \\| y |', '|       |          |        |        |']);
});

test('table edits follow lines a text editor added above; a table changed elsewhere is a conflict, and nothing is written', async () => {
  const h = harness(TABLE_DOC);
  const t = block(h.render(), '| Name');
  h.doc.type(0, 0, 'Intro.\n\n');
  await h.send({ type: 'tableCell', key: t.key, row: 1, col: 0, text: 'Ann', editId: 'f1' });
  assert.equal(lines(h.doc.text)[6], '| Ann | :badge[Done]{color=green} | `a\\|b` |');
  const at = h.doc.text.indexOf('open');
  h.doc.type(at, at + 4, 'shut');
  const changed = h.doc.text;
  const reply = await h.send({ type: 'tableRow', key: t.key, op: 'insert', at: 1, editId: 'f2' });
  assert.equal(reply?.type, 'conflict');
  assert.equal(h.doc.text, changed);
});

test('table edits are refused, and nothing is written, for a table the grid can\'t read, a cell that isn\'t there or a change that wouldn\'t read back', async () => {
  const h = harness(TABLE_DOC);
  const r = h.render();
  const top = block(r, '| Name');
  const inner = block(r, 'Name | Age');
  const ragged = block(r, '| a | b');
  const before = h.doc.text;
  const refused = async (message: SessionMessage) => {
    const reply = await h.send(message) as { type: string; text?: string; fallback?: string };
    assert.equal(h.doc.text, before, JSON.stringify(message));
    assert.equal(reply.type, 'notice');
    return reply;
  };
  const r1 = await refused({ type: 'tableCell', key: ragged.key, row: 1, col: 0, text: 'x', editId: 'x1' });
  assert.equal(r1.fallback, ragged.key, 'a ragged table: the page edits its source');
  assert.match(r1.text!, /has 1 cells/);
  assert.equal((await refused({ type: 'tableCell', key: top.key, row: 9, col: 0, text: 'x', editId: 'x2' })).fallback, undefined, 'no such cell: a notice');
  await refused({ type: 'tableCell', key: top.key, row: 1, col: 0, text: 'two\nlines', editId: 'x3' });
  await refused({ type: 'tableRow', key: top.key, op: 'delete', at: 0, editId: 'x4' });
  await refused({ type: 'tableRow', key: top.key, op: 'insert', at: 0, editId: 'x5' });
  await refused({ type: 'tableCol', key: top.key, op: 'delete', at: 3, editId: 'x6' });
  // A heading at the start of a row without a leading pipe ends the table: the change would not read back.
  const r7 = await refused({ type: 'tableCell', key: inner.key, row: 1, col: 0, text: '# Carol', editId: 'x7' });
  assert.equal(r7.fallback, inner.key);
  assert.equal((await h.send({ type: 'tableAlign', key: 'zzzz#0', editId: 'x8' }))?.type, 'conflict', 'a key the session doesn\'t know');
});

test('inline items in table cells keep their forms around grid edits', async () => {
  const h = harness(TABLE_DOC, INLINE_ON);
  const t = block(h.render(), '| Name');
  assert.equal(t.inline?.[0].name, 'badge');
  assert.ok(t.inline![0].fields, 'the badge in a cell has its form');
  await h.send({ type: 'tableCell', key: t.key, row: 2, col: 0, text: 'Bobby', editId: 'b1' });
  assert.equal((await h.send({ type: 'setInline', key: t.key, index: 0, name: 'badge', attrs: { color: 'red' }, editId: 'b2' }))?.type, 'ack');
  assert.equal(lines(h.doc.text)[4], '| Alice | :badge[Done]{color=red} | `a\\|b` |');
  await h.send({ type: 'tableCell', key: t.key, row: 1, col: 1, text: ':badge[Late]{color=amber}', editId: 'b3' });
  const again = block(h.render(), '| Name');
  assert.equal(again.inline![0].text, 'Late');
  assert.ok(again.inline![0].fields);
});

test('property: a random grid change to every table of every example and corpus file changes only that table\'s lines', async () => {
  const random = prng(23);
  const pickOf = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const all = (views: readonly BlockView[]): BlockView[] => views.flatMap((v) => [v, ...all(v.children ?? [])]);
  let applied = 0;
  for (const d of [...readDir(examplesDir), ...readDir(corpusDir)]) {
    const h = harness(d.text);
    let r = h.render();
    for (const key of all(r.blocks).filter((v) => v.table?.rows).map((v) => v.key)) {
      // The table as the last render has it (an edit above may have moved it).
      const t = all(r.blocks).find((v) => v.key === key);
      if (!t?.table?.rows) continue;
      const rows = t.table.rows;
      const cols = rows[0].length;
      const editId = `q${applied}`;
      const message = pickOf<SessionMessage>([
        { type: 'tableCell', key: t.key, row: Math.floor(random() * rows.length), col: Math.floor(random() * cols), text: pickOf(['x', '', 'a|b', '`c`']), editId },
        { type: 'tableRow', key: t.key, op: 'insert', at: 1 + Math.floor(random() * rows.length), editId },
        { type: 'tableCol', key: t.key, op: 'insert', at: Math.floor(random() * (cols + 1)), editId },
        { type: 'tableCol', key: t.key, op: 'align', at: Math.floor(random() * cols), align: 'center', editId },
        { type: 'tableAlign', key: t.key, editId },
      ]);
      const before = h.doc.text;
      const reply = h.sent.length;
      await h.send(message);
      assert.ok(h.sent.slice(reply).some((m) => m.type === 'ack'), `${d.name}: ${JSON.stringify(message)} ${JSON.stringify(h.sent.slice(reply))}`);
      applied++;
      const grown = lines(h.doc.text).length - lines(before).length;
      onlyLinesChanged(before, h.doc.text, t.start, t.end);
      assert.ok(grown === 0 || (message.type === 'tableRow' && grown === 1), d.name);
      // Still a table the grid reads.
      r = h.render();
      const after = all(r.blocks).find((v) => v.start === t.start && v.type === 'table');
      assert.ok(after?.table?.rows, `${d.name}: still a table the grid edits`);
    }
  }
  assert.ok(applied > 10, `table edits applied (${applied})`);
});
