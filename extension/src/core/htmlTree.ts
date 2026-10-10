import { escapeHtml } from './attrs';

/**
 * A small, forgiving HTML tree for reshaping the renderer's own output (see pandoc.ts). It reads what renderSmd
 * writes (well-formed, every element closed) and copes with raw HTML from documents: void elements, stray or
 * missing closing tags, comments and the raw text of `<script>` and `<style>`. It is not a full HTML5 parser.
 */

export interface HtmlText {
  kind: 'text';
  /** The text as it appears in the HTML, character references and all. */
  html: string;
}

export interface HtmlElement {
  kind: 'element';
  /** Lower case. */
  tag: string;
  /** Attribute values with their character references decoded. */
  attrs: Map<string, string>;
  children: HtmlNode[];
}

export type HtmlNode = HtmlText | HtmlElement;

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Elements whose content is text up to their closing tag. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

const NAME = String.raw`[a-zA-Z][\w:.-]*`;
const ATTRIBUTE = String.raw`[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?`;
/** A comment, a declaration (doctype), a closing tag (name in group 1) or an opening tag (name, attributes, `/`). */
const TAG = new RegExp(String.raw`<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/(${NAME})\s*>|<(${NAME})((?:\s+${ATTRIBUTE})*)\s*(\/?)>`, 'g');
const ATTRIBUTES = new RegExp(String.raw`([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?`, 'g');

export const element = (tag: string, children: HtmlNode[] = [], attrs: Record<string, string> = {}): HtmlElement =>
  ({ kind: 'element', tag, attrs: new Map(Object.entries(attrs)), children });

/** Text from a plain string (escaped here). */
export const text = (value: string): HtmlText => ({ kind: 'text', html: escapeHtml(value) });

/** Parse an HTML fragment into its top-level nodes. */
export function parseHtml(html: string): HtmlNode[] {
  const root = element('#root');
  const open: HtmlElement[] = [root];
  const re = new RegExp(TAG.source, 'g');
  let pos = 0;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    pushText(open.at(-1)!, html.slice(pos, match.index));
    pos = re.lastIndex;
    // Comments and declarations are left out.
    const [, closing, opening, attrs, selfClosing] = match;
    if (closing) closeElement(open, closing.toLowerCase());
    else if (opening) pos = openElement(open, { tag: opening.toLowerCase(), attrs, selfClosing: selfClosing === '/' }, html, pos);
    re.lastIndex = pos;
  }
  pushText(open.at(-1)!, html.slice(pos));
  return root.children;
}

function pushText(parent: HtmlElement, value: string): void {
  if (value) parent.children.push({ kind: 'text', html: value });
}

/** Close the innermost open element with this name; a closing tag that matches none is ignored. */
function closeElement(open: HtmlElement[], tag: string): void {
  for (let i = open.length - 1; i > 0; i--) {
    if (open[i].tag === tag) {
      open.length = i;
      return;
    }
  }
}

interface OpeningTag { tag: string; attrs: string; selfClosing: boolean }

/** Add the element; returns where parsing goes on (after the raw text of `<script>` and the like). */
function openElement(open: HtmlElement[], tag: OpeningTag, html: string, pos: number): number {
  const el: HtmlElement = { kind: 'element', tag: tag.tag, attrs: parseAttributes(tag.attrs), children: [] };
  open.at(-1)!.children.push(el);
  if (VOID_TAGS.has(tag.tag) || tag.selfClosing) return pos;
  if (RAW_TEXT_TAGS.has(tag.tag)) {
    const end = html.toLowerCase().indexOf(`</${tag.tag}`, pos);
    const stop = end < 0 ? html.length : end;
    pushText(el, html.slice(pos, stop));
    const close = html.indexOf('>', stop);
    return close < 0 ? html.length : close + 1;
  }
  open.push(el);
  return pos;
}

function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const [, name, double, single, bare] of source.matchAll(ATTRIBUTES)) {
    const key = name.toLowerCase();
    if (!attrs.has(key)) attrs.set(key, decodeEntities(double ?? single ?? bare ?? ''));
  }
  return attrs;
}

/** HTML for nodes; attribute values are escaped again. */
export function serializeHtml(nodes: readonly HtmlNode[]): string {
  return nodes.map(serializeNode).join('');
}

function serializeNode(node: HtmlNode): string {
  if (node.kind === 'text') return node.html;
  const attrs = [...node.attrs].map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${serializeHtml(node.children)}</${node.tag}>`;
}

/** The text of nodes, character references decoded. */
export function textContent(nodes: readonly HtmlNode[]): string {
  return nodes.map((n) => (n.kind === 'text' ? decodeEntities(n.html) : textContent(n.children))).join('');
}

/** The class names of an element. */
export function classes(el: HtmlElement): string[] {
  return (el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
}

/** The first element, depth first, that `test` accepts. */
export function findElement(nodes: readonly HtmlNode[], test: (el: HtmlElement) => boolean): HtmlElement | undefined {
  for (const node of nodes) {
    if (node.kind !== 'element') continue;
    if (test(node)) return node;
    const inner = findElement(node.children, test);
    if (inner) return inner;
  }
  return undefined;
}

const NAMED_ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' ']]);

/** Decode the named references markdown-it and KaTeX write, and numeric ones; others stay as written. */
export function decodeEntities(value: string): string {
  return value.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES.get(ref.toLowerCase()) ?? whole;
  });
}
