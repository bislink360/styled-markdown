import {
  blockInlines, childBlocks, exportColor, exportTree, type Block, type ExportOptions, type Inline, type ListItem, type Marks,
} from './exportTree';

/**
 * Confluence storage format: the XHTML-based markup of Confluence's REST API (`body.storage`) and of
 * "Insert markup". Only built-in macros are used (info, note, tip, warning, panel, expand, code, status,
 * anchor), so pages need no apps. Text is XML-escaped, code goes in CDATA sections, and raw HTML from the
 * document never passes through (see exportTree.ts). The output is a fragment: one element per block, a
 * line each.
 */
export function smdToConfluence(text: string, options: ExportOptions = {}): string {
  const doc = exportTree(text, options);
  const writer = new ConfluenceWriter(linkedAnchors(doc.blocks));
  const body = doc.blocks.map((b) => writer.block(b)).filter(Boolean).join('\n');
  return body ? `${body}\n` : '';
}

/** smd callout → Confluence macro. Confluence's `note` is its yellow caution panel and `warning` its red one. */
const CALLOUT_MACROS = new Map([
  ['note', 'info'], ['info', 'info'], ['tip', 'tip'], ['success', 'tip'], ['warning', 'note'], ['danger', 'warning'], ['question', 'info'],
]);

/** smd named colour → status macro colour. */
const STATUS_COLOURS = new Map([
  ['red', 'Red'], ['orange', 'Red'], ['pink', 'Red'], ['amber', 'Yellow'], ['yellow', 'Yellow'], ['green', 'Green'], ['teal', 'Green'],
  ['blue', 'Blue'], ['cyan', 'Blue'], ['indigo', 'Blue'], ['purple', 'Purple'],
]);

/** smd named colour → text colour and background tint. `accent` has no fixed value outside the page theme, so it is dropped. */
const TEXT_COLOURS = new Map([
  ['red', '#de350b'], ['orange', '#ff8b00'], ['amber', '#ff991f'], ['yellow', '#b38600'], ['green', '#00875a'], ['teal', '#008da6'],
  ['cyan', '#00a3bf'], ['blue', '#0052cc'], ['indigo', '#403294'], ['purple', '#6554c0'], ['pink', '#c2185b'], ['gray', '#6b778c'],
  ['muted', '#6b778c'],
]);
const BACKGROUNDS = new Map([
  ['red', '#ffebe6'], ['orange', '#fff4e5'], ['amber', '#fffae6'], ['yellow', '#fff0b3'], ['green', '#e3fcef'], ['teal', '#e6fcff'],
  ['cyan', '#e6fcff'], ['blue', '#deebff'], ['indigo', '#eae6ff'], ['purple', '#eae6ff'], ['pink', '#ffecf6'], ['gray', '#f4f5f7'],
  ['muted', '#f4f5f7'],
]);

/** Short fence languages spelled as the code macro names them; anything else is passed as written. */
const CODE_LANGUAGES = new Map([
  ['ts', 'typescript'], ['js', 'javascript'], ['sh', 'bash'], ['shell', 'bash'], ['zsh', 'bash'], ['console', 'bash'], ['py', 'python'],
  ['yml', 'yaml'], ['rb', 'ruby'], ['kt', 'kotlin'], ['cs', 'csharp'], ['c#', 'csharp'], ['c++', 'cpp'], ['md', 'markdown'], ['html', 'xml'],
  ['ps1', 'powershell'], ['golang', 'go'], ['rs', 'rust'],
]);

/** Text and attribute values in XML 1.0: characters it cannot hold are dropped, markup characters escaped. */
export function xmlText(value: string): string {
  return xmlChars(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;');
}

/** A CDATA section holding any text: `]]>` is split across two sections. */
export function cdata(value: string): string {
  return `<![CDATA[${xmlChars(value).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

/** The characters XML 1.0 allows: tab, newlines, and the rest from U+0020 up, without lone surrogates, U+FFFE and U+FFFF. */
function xmlChars(value: string): string {
  let out = '';
  for (const ch of value) if (isXmlChar(ch.codePointAt(0) ?? 0)) out += ch;
  return out;
}

const isXmlChar = (code: number): boolean =>
  code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code < 0xd800) || (code > 0xdfff && code < 0xfffe) || code > 0xffff;

const param = (name: string, value: string | undefined) => (value ? `<ac:parameter ac:name="${name}">${xmlText(value)}</ac:parameter>` : '');
const richBody = (inner: string) => `<ac:rich-text-body>${inner}</ac:rich-text-body>`;

function macro(name: string, params: string, body = ''): string {
  return `<ac:structured-macro ac:name="${name}">${params}${body}</ac:structured-macro>`;
}

const anchorMacro = (id: string) => macro('anchor', `<ac:parameter ac:name="">${xmlText(id)}</ac:parameter>`);

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Every `#id` a link in the document points at, plus the footnotes referred to: only these get an anchor macro. */
function linkedAnchors(blocks: Block[]): Set<string> {
  const ids = new Set<string>();
  const visit = (list: Block[]): void => {
    for (const block of list) {
      for (const inline of blockInlines(block).flat()) addAnchor(ids, inline);
      visit(childBlocks(block));
    }
  };
  visit(blocks);
  return ids;
}

function addAnchor(ids: Set<string>, inline: Inline): void {
  if (inline.kind === 'footnote') ids.add(`fn-${inline.n}`);
  const href = 'marks' in inline ? inline.marks.href : undefined;
  if (href?.startsWith('#')) ids.add(safeDecode(href.slice(1)));
}

const hrefOf = (inline: Inline): string | undefined => ('marks' in inline ? inline.marks.href : undefined);

/** The order marks are applied in, innermost first. */
const MARK_TAGS: Array<[keyof Marks, string]> = [['underline', 'u'], ['italic', 'em'], ['bold', 'strong']];

class ConfluenceWriter {
  private taskId = 0;

  constructor(private readonly anchors: Set<string>) {}

  block(b: Block): string {
    switch (b.kind) {
      case 'heading':
        return `<h${b.level}>${b.id && this.anchors.has(b.id) ? anchorMacro(b.id) : ''}${this.inlines(b.content)}</h${b.level}>`;
      case 'paragraph':
        return b.content.length ? `<p>${this.inlines(b.content)}</p>` : '';
      case 'list':
        return this.list(b.ordered, b.items);
      case 'code':
        return this.code(b.code, b.lang, b.title);
      case 'math':
        return macro('code', param('title', 'LaTeX'), `<ac:plain-text-body>${cdata(b.tex)}</ac:plain-text-body>`);
      case 'quote':
        return `<blockquote>${this.blocks(b.blocks)}</blockquote>`;
      case 'callout':
        return macro(CALLOUT_MACROS.get(b.type) ?? 'info', param('title', b.title), richBody(this.blocks(b.blocks)));
      case 'panel':
        return macro('panel', param('title', b.title), richBody(this.blocks(b.blocks)));
      case 'expand':
        return macro('expand', param('title', b.title), richBody(this.blocks(b.blocks)));
      case 'rule':
        return '<hr />';
      case 'table':
        return this.table(b.header, b.rows);
      case 'anchor':
        return this.anchors.has(b.id) ? `<p>${anchorMacro(b.id)}</p>` : '';
      case 'footnotes':
        return `<hr />${this.list(true, b.items.map((i) => ({ blocks: [{ kind: 'anchor', id: `fn-${i.n}` }, ...i.blocks] })))}`;
    }
  }

  private blocks(list: Block[]): string {
    return list.map((b) => this.block(b)).join('');
  }

  /** A list; runs of task items become task lists, since Confluence has no checkbox inside `<li>`. */
  private list(ordered: boolean, items: ListItem[]): string {
    const tag = ordered ? 'ol' : 'ul';
    let out = '';
    let start = 0;
    while (start < items.length) {
      const isTask = Boolean(items[start].task);
      let end = start + 1;
      while (end < items.length && Boolean(items[end].task) === isTask) end++;
      const run = items.slice(start, end);
      const inner = run.map((i) => (isTask ? this.task(i) : `<li>${this.itemBody(i.blocks)}</li>`)).join('');
      out += isTask ? `<ac:task-list>${inner}</ac:task-list>` : `<${tag}>${inner}</${tag}>`;
      start = end;
    }
    return out;
  }

  /** A task; ids count up through the page. */
  private task(item: ListItem): string {
    this.taskId++;
    const status = item.task?.checked ? 'complete' : 'incomplete';
    const body = `<ac:task-body>${this.itemBody(item.blocks)}</ac:task-body>`;
    return `<ac:task><ac:task-id>${this.taskId}</ac:task-id><ac:task-status>${status}</ac:task-status>${body}</ac:task>`;
  }

  /** A list item's blocks; the text of a first paragraph goes in directly, as in a tight list. Leading anchors go first. */
  private itemBody(blocks: Block[]): string {
    const anchors = blocks.filter((b) => b.kind === 'anchor' && this.anchors.has(b.id)).map((b) => anchorMacro((b as { id: string }).id)).join('');
    const rest = blocks.filter((b) => b.kind !== 'anchor');
    const [first, ...others] = rest;
    if (first?.kind !== 'paragraph') return anchors + this.blocks(rest);
    return anchors + this.inlines(first.content) + this.blocks(others);
  }

  private code(code: string, lang: string, title: string | undefined): string {
    const lower = lang.toLowerCase();
    // Mermaid needs an app in Confluence, so a diagram stays its source, titled so readers know what it is.
    const mermaid = lower === 'mermaid';
    const language = mermaid ? undefined : CODE_LANGUAGES.get(lower) ?? (lower || undefined);
    const params = param('language', language) + param('title', title ?? (mermaid ? 'Mermaid diagram' : undefined));
    return macro('code', params, `<ac:plain-text-body>${cdata(code)}</ac:plain-text-body>`);
  }

  private table(header: boolean, rows: Inline[][][]): string {
    const row = (cells: Inline[][], n: number) => {
      const tag = header && n === 0 ? 'th' : 'td';
      return `<tr>${cells.map((c) => `<${tag}><p>${this.inlines(c)}</p></${tag}>`).join('')}</tr>`;
    };
    return `<table><tbody>${rows.map(row).join('')}</tbody></table>`;
  }

  /** Inline content; neighbours with the same link share one link element. */
  inlines(list: Inline[]): string {
    let out = '';
    let start = 0;
    while (start < list.length) {
      const href = hrefOf(list[start]);
      let end = start + 1;
      while (end < list.length && hrefOf(list[end]) === href) end++;
      const inner = list.slice(start, end).map((i) => this.inline(i)).join('');
      out += href === undefined ? inner : link(href, inner);
      start = end;
    }
    return out;
  }

  private inline(i: Inline): string {
    switch (i.kind) {
      case 'text':
        return marked(xmlText(i.text), i.marks);
      case 'math':
        return marked(`<code>${xmlText(i.tex)}</code>`, { ...i.marks, code: false });
      case 'break':
        return '<br />';
      case 'status':
        return macro('status', param('colour', STATUS_COLOURS.get(i.color) ?? 'Grey') + param('title', i.text));
      case 'date':
        return `<time datetime="${xmlAttr(i.date)}" />`;
      case 'footnote':
        return `<sup><ac:link ac:anchor="fn-${i.n}"><ac:plain-text-link-body>${cdata(String(i.n))}</ac:plain-text-link-body></ac:link></sup>`;
      case 'image':
        return image(i.src, i.alt);
    }
  }
}

function link(href: string, inner: string): string {
  if (!href.startsWith('#')) return `<a href="${xmlAttr(href)}">${inner}</a>`;
  return `<ac:link ac:anchor="${xmlAttr(safeDecode(href.slice(1)))}"><ac:link-body>${inner}</ac:link-body></ac:link>`;
}

function marked(inner: string, marks: Marks): string {
  let out = marks.code ? `<code>${inner}</code>` : inner;
  // Strikethrough is a style in storage format, as Confluence writes it.
  const style = [
    colour('color', marks.color, TEXT_COLOURS),
    colour('background-color', marks.highlight, BACKGROUNDS),
    marks.strike ? 'text-decoration: line-through;' : '',
  ].filter(Boolean).join(' ');
  if (style) out = `<span style="${xmlAttr(style)}">${out}</span>`;
  for (const [mark, tag] of MARK_TAGS) if (marks[mark]) out = `<${tag}>${out}</${tag}>`;
  return out;
}

/** `color: #de350b;` for a named or CSS colour the renderer accepts, else nothing. */
function colour(property: string, value: string | undefined, named: Map<string, string>): string {
  const c = exportColor(value);
  const css = c?.named ? named.get(c.named) : c?.css;
  return css ? `${property}: ${css};` : '';
}

/**
 * An image: by URL when it has one, else as a page attachment of the same file name (upload the file with the
 * page). Other sources (`data:` URIs, absolute paths) keep only their alt text.
 */
function image(src: string, alt: string): string {
  const altAttr = alt ? ` ac:alt="${xmlAttr(alt)}"` : '';
  if (/^https?:\/\//i.test(src)) return `<ac:image${altAttr}><ri:url ri:value="${xmlAttr(src)}" /></ac:image>`;
  const relative = src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('/');
  if (!relative) return xmlText(alt);
  const file = safeDecode(src.split(/[?#]/)[0].split('/').at(-1) ?? '');
  return file ? `<ac:image${altAttr}><ri:attachment ri:filename="${xmlAttr(file)}" /></ac:image>` : xmlText(alt);
}
