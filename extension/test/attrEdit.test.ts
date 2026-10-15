import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAttrs, type Attrs } from '../src/core/attrs';
import {
  containerHeader, lexAttrs, removeAttr, removeContainerAttr, setAttr, setContainerAttr, setContainerTitle, setId, type AttrItem,
} from '../src/core/attrEdit';
import { parseContainerInfo } from '../src/core/containers';
import { formatAttrs, formatSmd } from '../src/core/format';
import { CONTAINERS } from '../src/core/spec';
import { prng } from './fuzz/generate';

/** Position-preserving attribute edits (src/core/attrEdit.ts). */

/** What parseAttrs would make of the lexed items. */
function attrsOf(items: readonly AttrItem[]): Attrs {
  const attrs: Attrs = { values: {}, classes: [] };
  for (const i of items) {
    if (i.kind === 'class') attrs.classes.push(i.name);
    else if (i.kind === 'id') attrs.id = i.name;
    else attrs.values[i.name] = i.value ?? 'true';
  }
  return attrs;
}

const PIECES = ['#id', '#x-1', '.cls', '.a_b', 'key=value', 'k="two words"', "q='it'", 'flag', 'title="A {b}"', 'n=50%', 'e=""', ' ', '  ', '=', '"', "'", '}', '{', 'x=', '.', '#', '@'];

test('lexAttrs reads what parseAttrs reads, and its spans hold what they say', () => {
  const random = prng(3);
  for (let i = 0; i < 3000; i++) {
    const src = Array.from({ length: Math.floor(random() * 6) }, () => PIECES[Math.floor(random() * PIECES.length)]).join(random() < 0.8 ? ' ' : '');
    const items = lexAttrs(src);
    const parsed = parseAttrs(src);
    assert.equal(items === null, parsed === null, JSON.stringify(src));
    if (!items || !parsed) continue;
    assert.deepEqual(attrsOf(items), parsed, JSON.stringify(src));
    for (const item of items) {
      const text = src.slice(item.start, item.end);
      assert.equal(text.trim(), text);
      if (item.kind === 'key') assert.ok(text.startsWith(item.name), JSON.stringify([src, item]));
      else assert.equal(text, `${item.kind === 'id' ? '#' : '.'}${item.name}`);
      if (item.valueSpan) assert.equal(src.slice(item.valueSpan.start, item.valueSpan.end), `${item.quote}${item.value}${item.quote}`);
    }
  }
});

test('lexAttrs: spans, kinds and quote styles', () => {
  assert.deepEqual(lexAttrs(' #i .c k="v w" f s=\'x\' b=1 '), [
    { kind: 'id', name: 'i', start: 1, end: 3, quote: '' },
    { kind: 'class', name: 'c', start: 4, end: 6, quote: '' },
    { kind: 'key', name: 'k', start: 7, end: 14, quote: '"', value: 'v w', valueSpan: { start: 9, end: 14 } },
    { kind: 'key', name: 'f', start: 15, end: 16, quote: '' },
    { kind: 'key', name: 's', start: 17, end: 22, quote: "'", value: 'x', valueSpan: { start: 19, end: 22 } },
    { kind: 'key', name: 'b', start: 23, end: 26, quote: '', value: '1', valueSpan: { start: 25, end: 26 } },
  ]);
  assert.equal(lexAttrs('a="unclosed'), null);
});

test('setAttr changes only the value: formatted values stay formatted, others keep their quotes when they fit', () => {
  assert.equal(setAttr('color="red"  .x', 'color', 'blue'), 'color="blue"  .x');
  assert.equal(setAttr('color=red', 'color', 'blue'), 'color=blue');
  assert.equal(setAttr('color=""', 'color', 'blue'), 'color=blue');
  assert.equal(setAttr("title='A'", 'title', 'B "q"'), "title='B \"q\"'");
  assert.equal(setAttr('title="A"', 'title', 'B "q"'), "title='B \"q\"'");
  assert.equal(setAttr('status=accepted', 'status', 'two words'), 'status="two words"');
  assert.equal(setAttr('status=accepted', 'status', 'rejected'), 'status=rejected');
  // The last of a repeated key is the one parseAttrs keeps.
  assert.equal(setAttr('a=1 a=2', 'a', '3'), 'a=1 a=3');
  // Flags.
  assert.equal(setAttr('collapsible', 'collapsible', 'false'), 'collapsible=false');
  assert.equal(setAttr('open=false', 'open', true), 'open');
  assert.equal(setAttr('open', 'open', true), 'open');
  // Values no list can hold, malformed lists, bad keys.
  assert.equal(setAttr('a=1', 'a', 'both " and \''), null);
  assert.equal(setAttr('a=1', 'a', 'two\nlines'), null);
  assert.equal(setAttr('a="x', 'a', '1'), null);
  assert.equal(setAttr('a=1', '1bad', '1'), null);
});

test('setAttr puts a new key where formatAttrs would, quoted as it would', () => {
  const decision = CONTAINERS.decision.attrs!;
  assert.equal(setAttr('status=accepted owner=@a', 'date', '2026-01-01', decision), 'status=accepted date=2026-01-01 owner=@a');
  assert.equal(setAttr('status=accepted', 'title', 'Use it', decision), 'title="Use it" status=accepted');
  assert.equal(setAttr('#id .c', 'status', 'accepted', decision), '#id .c status=accepted');
  assert.equal(setAttr('', 'collapsible', true), 'collapsible');
  assert.equal(setAttr('  ', 'bg', 'indigo'), 'bg=indigo');
  assert.equal(setAttr('color=red unknown=1', 'bg', 'indigo'), 'color=red bg=indigo unknown=1');
  assert.equal(setAttr('color=red unknown=1', 'other', 'x'), 'color=red unknown=1 other=x');
});

test('after setAttr on a formatted list, smd fmt has nothing to change', () => {
  const random = prng(8);
  const values = ['accepted', 'two words', '@owner', '2026-01-01', '50%', 'say "hi"', "it's", 'red', ''];
  for (const [name, spec] of Object.entries(CONTAINERS)) {
    const order = spec.attrs ?? [];
    const keys = [...order, 'color', 'bg', 'align', 'custom', 'collapsible'];
    for (let i = 0; i < 40; i++) {
      const pick = () => keys[Math.floor(random() * keys.length)];
      const value = () => values[Math.floor(random() * values.length)];
      const start = Array.from({ length: Math.floor(random() * 4) }, () => `${pick()}="${value().replaceAll('"', '')}"`);
      if (random() < 0.3) start.unshift('.cls');
      if (random() < 0.3) start.unshift('#the-id');
      const formatted = formatAttrs(start.join(' '), order)!;
      const key = pick();
      const v = random() < 0.2 ? true : value();
      const out = setAttr(formatted, key, v, order);
      assert.ok(out !== null);
      assert.equal(formatAttrs(out, order), out, `${name}: ${formatted} + ${key}=${String(v)}`);
      assert.equal(parseAttrs(out)!.values[key], v === true ? 'true' : v);
    }
  }
});

test('removeAttr removes every copy of a key and the space beside it', () => {
  assert.equal(removeAttr('a=1 b=2 a=3', 'a'), 'b=2');
  assert.equal(removeAttr('#i .c key="v"', 'key'), '#i .c');
  assert.equal(removeAttr('key="v" .c', 'key'), '.c');
  assert.equal(removeAttr('key="v"', 'key'), '');
  assert.equal(removeAttr('a=1', 'b'), 'a=1');
  assert.equal(removeAttr('a="x', 'a'), null);
});

test('setId replaces the id that wins, adds one first, or removes them', () => {
  assert.equal(setId('.c #old k=v', 'new'), '.c #new k=v');
  assert.equal(setId('#a #b', 'c'), '#a #c');
  assert.equal(setId('.c k=v', 'fig-1'), '#fig-1 .c k=v');
  assert.equal(setId('', 'fig-1'), '#fig-1');
  assert.equal(setId('#a .c #b', undefined), '.c');
  assert.equal(setId('.c', 'not valid'), null);
});

test('containerHeader finds the colons, the name, the attributes and the title', () => {
  const line = '  ::::decision{status=accepted}  Use Postgres  ';
  const h = containerHeader(line)!;
  const at = (s: { start: number; end: number }) => line.slice(s.start, s.end);
  assert.deepEqual([at(h.indent), at(h.colons), at(h.name), at(h.attrs!), at(h.title)], ['  ', '::::', 'decision', '{status=accepted}', 'Use Postgres']);
  const bare = containerHeader(':::note')!;
  assert.deepEqual([bare.attrs, bare.title], [undefined, { start: 7, end: 7 }]);
  const spaced = containerHeader('::: tip Title')!;
  assert.equal('::: tip Title'.slice(spaced.name.start, spaced.name.end), 'tip');
  // An attribute list that is never closed is part of the title, as parseContainerInfo reads it.
  const open = containerHeader(':::note{a=1 Title')!;
  assert.equal(open.attrs, undefined);
  assert.equal(':::note{a=1 Title'.slice(open.title.start, open.title.end), '{a=1 Title');
  assert.equal(containerHeader(':::'), null);
  assert.equal(containerHeader('text'), null);
});

/** The title parseContainerInfo reads from an opening line. */
const titleOf = (line: string) => parseContainerInfo(line.replace(/^\s*:+\s*/, ''))!.title;

test('setContainerTitle edits the title where it lives', () => {
  assert.equal(setContainerTitle(':::note Old', 'New'), ':::note New');
  assert.equal(setContainerTitle(':::note', 'New'), ':::note New');
  assert.equal(setContainerTitle(':::note{collapsible}', 'New'), ':::note{collapsible} New');
  assert.equal(setContainerTitle(':::note{collapsible}   Old  ', 'New'), ':::note{collapsible}   New  ');
  assert.equal(setContainerTitle(':::note{collapsible} Old', ''), ':::note{collapsible}');
  assert.equal(setContainerTitle(':::note Old', 'Two\nlines'), ':::note Two lines');
  // title="…" wins over the text after the attributes, so that is where it changes.
  assert.equal(setContainerTitle(':::note{title="Old" collapsible} Ignored', 'New'), ':::note{title="New" collapsible} Ignored');
  assert.equal(setContainerTitle(':::note{title="Old"} Ignored', ''), ':::note');
  assert.equal(setContainerTitle('text', 'x'), null);
  for (const [line, title] of [[':::card{accent=teal} A', 'B {x}'], [':::note', '{x}'], [':::details{title=\'Q\'}', 'It "works"'], [':::tip', '']]) {
    const out = setContainerTitle(line, title)!;
    assert.equal(titleOf(out), title, `${line} → ${out}`);
  }
});

test('setContainerAttr and removeContainerAttr edit the opening line in place', () => {
  assert.equal(setContainerAttr(':::note Title', 'collapsible', true), ':::note{collapsible} Title');
  assert.equal(setContainerAttr(':::decision{status=proposed} Use it', 'status', 'accepted'), ':::decision{status=accepted} Use it');
  assert.equal(setContainerAttr(':::decision{status=proposed} Use it', 'owner', '@a'), ':::decision{status=proposed owner=@a} Use it');
  assert.equal(setContainerAttr(':::note{a=1 Title', 'b', '2'), null);
  assert.equal(removeContainerAttr(':::note{collapsible} Title', 'collapsible'), ':::note Title');
  assert.equal(removeContainerAttr(':::note{collapsible}Title', 'collapsible'), ':::note Title');
  assert.equal(removeContainerAttr(':::note{a=1 collapsible} Title', 'collapsible'), ':::note{a=1} Title');
  assert.equal(removeContainerAttr(':::note Title', 'collapsible'), ':::note Title');
  // A formatted document stays formatted.
  const doc = ':::decision{status=proposed owner=@a} Use Postgres\nWhy.\n:::\n';
  const [first, ...rest] = doc.split('\n');
  const edited = [setContainerAttr(first, 'date', '2026-10-14')!, ...rest].join('\n');
  assert.equal(edited, ':::decision{status=proposed date=2026-10-14 owner=@a} Use Postgres\nWhy.\n:::\n');
  assert.equal(formatSmd(edited), edited);
});
