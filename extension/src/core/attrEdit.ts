import { findAttrsEnd } from './attrs';
import { CONTAINER_OPEN } from './containers';
import { attrRank, quote } from './format';
import { CONTAINERS } from './spec';

/**
 * Attribute edits that keep everything else as written. An attribute list is lexed as parseAttrs lexes it, with
 * each item's place in the text, so setting or removing one attribute changes only that item: its quotes are kept
 * when the new value allows them, and a new key goes where formatAttrs would put it, quoted as formatAttrs would
 * quote it, so `smd fmt` has nothing to change in a list that was formatted. Browser-safe; not part of the npm API.
 */

/** [start, end) offsets in the text given. */
export interface Span {
  start: number;
  end: number;
}

export type AttrKind = 'key' | 'class' | 'id';
/** The quotes around a value: double, single, or none (bare values, flags, classes and ids). */
export type QuoteStyle = '"' | "'" | '';

/** One item of an attribute list: `key=value`, a bare `flag`, `.class` or `#id`. */
export interface AttrItem extends Span {
  kind: AttrKind;
  /** The key, or the class or id without its `.` or `#`. */
  name: string;
  /** A key's value without quotes; undefined for a flag (which parseAttrs reads as "true"). */
  value?: string;
  quote: QuoteStyle;
  /** The value with its quotes. */
  valueSpan?: Span;
}

/** A value for setAttr: text, or `true` for a bare flag (`collapsible`). */
export type AttrValue = string | true;

/** The same items as parseAttrs (attrs.ts) reads: keep the two in step. */
const ATTR_ITEM = /\s*(?:([.#])([A-Za-z0-9_-]+)|([A-Za-z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+)))?)\s*/y;
const BARE_VALUE = /^[^\s"'}]+$/;
const ID_NAME = /^[A-Za-z0-9_-]+$/;
const TITLE = 'title';
const KEY: AttrKind = 'key';
const ID: AttrKind = 'id';

/** One lexed item, its whitespace trimmed off. */
function lexItem(m: RegExpExecArray, pos: number): AttrItem {
  const text = m[0];
  const start = pos + text.length - text.trimStart().length;
  const end = pos + text.trimEnd().length;
  if (m[1]) return { kind: m[1] === '.' ? 'class' : ID, name: m[2], start, end, quote: '' };
  const [value, style] = valueOf(m);
  const item: AttrItem = { kind: KEY, name: m[3], start, end, quote: style };
  if (value === undefined) return item;
  const length = value.length + 2 * style.length;
  return { ...item, value, valueSpan: { start: end - length, end } };
}

function valueOf(m: RegExpExecArray): [string | undefined, QuoteStyle] {
  if (m[4] !== undefined) return [m[4], '"'];
  if (m[5] !== undefined) return [m[5], "'"];
  return [m[6], ''];
}

/**
 * The items of the inside of `{…}` (without the braces), with their spans; null when parseAttrs would reject the
 * text. Later items win in parseAttrs, so the last of a repeated key is the one that counts.
 */
export function lexAttrs(src: string): AttrItem[] | null {
  const items: AttrItem[] = [];
  let pos = 0;
  while (pos < src.length) {
    ATTR_ITEM.lastIndex = pos;
    const m = ATTR_ITEM.exec(src);
    if (!m || m[0].length === 0) {
      if (src.slice(pos).trim() === '') break;
      return null;
    }
    items.push(lexItem(m, pos));
    pos = ATTR_ITEM.lastIndex;
  }
  return items;
}

const splice = (text: string, span: Span, insert: string) => text.slice(0, span.start) + insert + text.slice(span.end);

/** The index of the last item that passes `test`, or -1 (findLastIndex is ES2023, past the ES2022 lib in tsconfig). */
function lastIndex(items: readonly AttrItem[], test: (item: AttrItem) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return i;
  return -1;
}

const lastIndexOf = (items: readonly AttrItem[], kind: AttrKind, name?: string) =>
  lastIndex(items, (i) => i.kind === kind && (name === undefined || i.name === name));

/** `value` in the quotes it had, when they can still hold it. */
function inSameQuotes(value: string, style: QuoteStyle): string | undefined {
  if (style === '') return BARE_VALUE.test(value) ? value : undefined;
  return value.includes(style) ? undefined : `${style}${value}${style}`;
}

/** A value no attribute list can hold: a line break, or both kinds of quote. */
const unwritable = (value: AttrValue) => value !== true && (/[\r\n]/.test(value) || (value.includes('"') && value.includes("'")));

/**
 * Set `key` in the inside of an attribute list. An existing key (the last, if repeated) changes in place: a value
 * quoted as formatAttrs would quote it is quoted that way again, any other keeps its quotes when they can hold the
 * new value. A new key goes at its canonical place among the others for a block whose own keys are `order`
 * (CONTAINERS[name].attrs). Null when `src` is malformed or no attribute list can hold the value.
 */
export function setAttr(src: string, key: string, value: AttrValue, order: readonly string[] = []): string | null {
  const items = lexAttrs(src);
  if (!items || unwritable(value) || !/^[A-Za-z_][\w-]*$/.test(key)) return null;
  const index = lastIndexOf(items, KEY, key);
  if (index < 0) return insertItem(src, items, key, value === true ? key : `${key}=${quote(key, value, order)}`, order);
  const item = items[index];
  if (value === true) return item.value === undefined ? src : splice(src, item, key);
  if (!item.valueSpan) return splice(src, { start: item.end, end: item.end }, `=${quote(key, value, order)}`);
  // A value quoted as formatAttrs quotes it stays formatted; one quoted by hand keeps its quotes if it can.
  const formatted = src.slice(item.valueSpan.start, item.valueSpan.end) === quote(key, item.value!, order);
  const kept = formatted ? undefined : inSameQuotes(value, item.quote);
  return splice(src, item.valueSpan, kept ?? quote(key, value, order));
}

/** Where formatAttrs would put each item: the id, the classes, then the keys by attrRank. */
function itemRank(item: AttrItem, order: readonly string[], written: readonly string[]): number {
  if (item.kind === ID) return -2;
  if (item.kind === 'class') return -1;
  return attrRank(item.name, order, written);
}

/** Insert an item's text after the last item that ranks at or before it. */
function insertItem(src: string, items: readonly AttrItem[], name: string, text: string, order: readonly string[], kind = KEY): string {
  if (!items.length) return text; // the list was empty or blank
  const written = [...new Set([...items.filter((i) => i.kind === KEY).map((i) => i.name), name])];
  const rank = itemRank({ kind, name, start: 0, end: 0, quote: '' }, order, written);
  const after = lastIndex(items, (i) => itemRank(i, order, written) <= rank);
  if (after < 0) return splice(src, { start: items[0].start, end: items[0].start }, `${text} `);
  return splice(src, { start: items[after].end, end: items[after].end }, ` ${text}`);
}

/** Remove the item at `index` with the space that separated it from its neighbour. */
function removeItem(src: string, items: readonly AttrItem[], index: number): string {
  const item = items[index];
  if (index + 1 < items.length) return splice(src, { start: item.start, end: items[index + 1].start }, '');
  if (index > 0) return splice(src, { start: items[index - 1].end, end: item.end }, '');
  return splice(src, item, '');
}

/** Remove every item of a kind (and name). */
function removeAll(src: string, kind: AttrKind, name?: string): string | null {
  let out = src;
  let items = lexAttrs(out);
  if (!items) return null;
  let index = lastIndexOf(items, kind, name);
  while (index >= 0) {
    out = removeItem(out, items, index);
    items = lexAttrs(out) ?? [];
    index = lastIndexOf(items, kind, name);
  }
  return out;
}

/** Remove `key` (every time it is written) from the inside of an attribute list; null when `src` is malformed. */
export function removeAttr(src: string, key: string): string | null {
  return removeAll(src, KEY, key);
}

/** Set the `#id` (the last one, which wins), or remove every id when `id` is undefined. Null for a malformed list or id. */
export function setId(src: string, id: string | undefined): string | null {
  if (id === undefined) return removeAll(src, ID);
  const items = lexAttrs(src);
  if (!items || !ID_NAME.test(id)) return null;
  const index = lastIndexOf(items, ID);
  if (index >= 0) return splice(src, { start: items[index].start + 1, end: items[index].end }, id);
  return insertItem(src, items, id, `#${id}`, [], ID);
}

// ---------------------------------------------------------------------------
// Container opening lines
// ---------------------------------------------------------------------------

/** The parts of a container's opening line, `:::name{attrs} Title`, as parseContainerInfo reads them. */
export interface ContainerHeader {
  indent: Span;
  colons: Span;
  name: Span;
  /** The name as written (parseContainerInfo lower-cases it). */
  nameText: string;
  /** `{…}` with its braces, when the line has a closed attribute list right after the name. */
  attrs?: Span;
  /** The title text after the name and attributes, trimmed; an empty span where a title would go when there is none. */
  title: Span;
}

/** The parts of a container's opening line, or null when it isn't one. */
export function containerHeader(line: string): ContainerHeader | null {
  const m = CONTAINER_OPEN.exec(line);
  if (!m) return null;
  const [, indent, colons, name, rest] = m;
  const restStart = line.length - rest.length;
  const nameStart = restStart - name.length;
  let titleFrom = restStart;
  let attrs: Span | undefined;
  const close = rest.startsWith('{') ? findAttrsEnd(rest, 0) : -1;
  if (close !== -1) {
    attrs = { start: restStart, end: restStart + close + 1 };
    titleFrom = attrs.end;
  }
  const tail = line.slice(titleFrom);
  const title = tail.trim();
  const titleStart = title ? titleFrom + tail.length - tail.trimStart().length : titleFrom;
  return {
    indent: { start: 0, end: indent.length },
    colons: { start: indent.length, end: indent.length + colons.length },
    name: { start: nameStart, end: restStart },
    nameText: name,
    attrs,
    title: { start: titleStart, end: titleStart + title.length },
  };
}

/** The keys a container's form offers, in canonical order. */
const containerOrder = (name: string): readonly string[] => CONTAINERS[name.toLowerCase()]?.attrs ?? [];

/** Apply an edit to the inside of a header's attribute list (or a new `{…}` after the name); null when it fails. */
function editHeaderAttrs(line: string, h: ContainerHeader, edit: (inner: string) => string | null): string | null {
  if (!h.attrs) {
    if (line[h.name.end] === '{') return null; // an attribute list that is never closed

    const created = edit('');
    if (created === null) return null;
    return created ? splice(line, { start: h.name.end, end: h.name.end }, `{${created}}`) : line;
  }
  const inner = { start: h.attrs.start + 1, end: h.attrs.end - 1 };
  const next = edit(line.slice(inner.start, inner.end));
  if (next === null) return null;
  if (next.trim()) return splice(line, inner, next);
  // Nothing left: drop the braces, keeping a space before a title.
  const glued = h.title.start === h.attrs.end && h.title.end > h.title.start;
  return splice(line, h.attrs, glued ? ' ' : '');
}

/** Set an attribute on a container's opening line; null when the line isn't one or the value can't be written. */
export function setContainerAttr(line: string, key: string, value: AttrValue): string | null {
  const h = containerHeader(line);
  return h && editHeaderAttrs(line, h, (inner) => setAttr(inner, key, value, containerOrder(h.nameText)));
}

/** Remove an attribute from a container's opening line (and the braces when nothing is left). */
export function removeContainerAttr(line: string, key: string): string | null {
  const h = containerHeader(line);
  return h && editHeaderAttrs(line, h, (inner) => removeAttr(inner, key));
}

/**
 * Set a container's title where it lives: in `title="…"` when the attributes have one (it wins in
 * parseContainerInfo), else as the text after the name and attributes. An empty title removes it. Line breaks
 * become spaces.
 */
export function setContainerTitle(line: string, title: string): string | null {
  const h = containerHeader(line);
  if (!h) return null;
  const text = title.split(/\r\n|[\r\n]/).map((part) => part.trim()).filter(Boolean).join(' ');
  const inner = h.attrs ? line.slice(h.attrs.start + 1, h.attrs.end - 1) : '';
  if (h.attrs && lexAttrs(inner)?.some((i) => i.kind === KEY && i.name === TITLE)) {
    if (text) return editHeaderAttrs(line, h, (src) => setAttr(src, TITLE, text, containerOrder(h.nameText)));
    // Removing title="…" would make the text after it the title: remove both.
    const untitled = splice(line, { start: h.attrs.end, end: h.title.end }, '');
    return editHeaderAttrs(untitled, { ...h, title: { start: h.attrs.end, end: h.attrs.end } }, (src) => removeAttr(src, TITLE));
  }
  if (h.title.end > h.title.start) return splice(line, text ? h.title : { start: titleGapStart(h), end: h.title.end }, text);
  return text ? splice(line, h.title, ` ${text}`) : line;
}

/** Where the space before a title starts: right after the attributes, or after the name. */
const titleGapStart = (h: ContainerHeader) => h.attrs?.end ?? h.name.end;
