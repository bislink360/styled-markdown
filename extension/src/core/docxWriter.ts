import { xmlAttr, xmlText } from './confluence';
import { BACKGROUNDS, cssColour, TEXT_COLOURS } from './exportColors';
import {
  blockInlines, childBlocks, exportTree, type Block, type ExportOptions, type Inline, type ListItem, type Marks, type PanelType,
} from './exportTree';
import { zip, type Deflate, type ZipEntry } from './zip';

/**
 * The built-in Word writer: a .smd document as a .docx (Office Open XML) that Word, LibreOffice, Pages and Google
 * Docs open, without Pandoc. It writes the export tree (exportTree.ts), so every .smd rule has run and the human
 * view applies, as in the Confluence and Notion exports:
 *
 * - headings, lists, tables (with a repeating header row), footnotes and links are Word's own; links to
 *   `#id` go to bookmarks; images next to the document are embedded (PNG, JPEG, GIF)
 * - callouts are paragraphs with a coloured bar and tint under a bold title; decisions, risks, cards, details and
 *   tabs are expanded under a bold title with a grey bar; quotes have a grey bar
 * - code blocks are monospaced on a grey background; Mermaid diagrams and math keep their source
 * - tasks start with ☐ or ☒; badges, priorities and statuses are bold text on their colour
 *
 * Style names are Pandoc's ("Heading 1", "Body Text", "Source Code", "Verbatim Char", "Block Text"…), so a
 * Pandoc reference document's styles (`styles`) apply as they do with Pandoc.
 */

export interface DocxWriterOptions extends ExportOptions {
  /** Read a file relative to the document as bytes, for images. Without it, images keep only their alt text. */
  readBinary?: (relativePath: string) => Uint8Array | undefined;
  /** Raw DEFLATE (`zlib.deflateRawSync`); without it the archive's entries are stored. */
  deflate?: Deflate;
  /** A `word/styles.xml` to use instead of the built-in one, such as a reference document's. */
  styles?: string;
}

export interface DocxResult {
  /** The .docx file. */
  data: Uint8Array;
  /** What could not be exported as asked, such as images that were not found. */
  warnings: string[];
}

/** An .smd document as a .docx file. As in print, `.no-print` blocks are left out, and agent blocks unless `agentBlocks` says otherwise. */
export function smdToDocx(text: string, options: DocxWriterOptions = {}): DocxResult {
  const { entries, warnings } = docxParts(text, options);
  return { data: zip(entries, options.deflate), warnings };
}

/** The parts of the .docx (the archive's entries, in order) and the warnings. */
export function docxParts(text: string, options: DocxWriterOptions = {}): { entries: ZipEntry[]; warnings: string[] } {
  const doc = exportTree(text, { ...options, agentBlocks: options.agentBlocks ?? 'hidden', print: true });
  const writer = new DocxWriter(doc.blocks, options);
  const title = doc.title ? paragraphXml(runs(doc.title, {}), { style: 'Title' }) : '';
  const body = title + writer.body(doc.blocks);
  const footnotes = writer.footnotesXml();
  const encode = (s: string) => new TextEncoder().encode(s);
  const parts: Array<[string, string | Uint8Array]> = [
    ['[Content_Types].xml', contentTypes(Boolean(footnotes), writer.media.map((m) => m.ext))],
    ['_rels/.rels', ROOT_RELS],
    ['docProps/core.xml', coreProperties(doc.title, doc.lang)],
    ['docProps/app.xml', APP_PROPERTIES],
    ['word/document.xml', documentXml(body)],
    ['word/_rels/document.xml.rels', relationships(writer.partRels('document', Boolean(footnotes)))],
    ['word/styles.xml', options.styles ?? stylesXml(doc.lang)],
    ['word/numbering.xml', writer.numberingXml()],
    ['word/settings.xml', settingsXml(Boolean(footnotes))],
  ];
  if (footnotes) {
    parts.push(['word/footnotes.xml', footnotes], ['word/_rels/footnotes.xml.rels', relationships(writer.partRels('footnotes', false))]);
  }
  for (const m of writer.media) parts.push([`word/media/${m.name}`, m.data]);
  return { entries: parts.map(([name, data]) => ({ name, data: typeof data === 'string' ? encode(data) : data })), warnings: writer.warnings };
}

// ---------------------------------------------------------------------------
// Measures (twentieths of a point, "twips", unless said otherwise)
// ---------------------------------------------------------------------------

/** A4 with 1-inch margins. */
const PAGE = { width: 11906, height: 16838, margin: 1440 };
const TEXT_WIDTH = PAGE.width - 2 * PAGE.margin;
/** Each list level indents this much more. */
const LIST_INDENT = 720;
const HANGING = 360;
/** What a box (callout, panel, quote) indents its content by, so its bar sits inside the text column. */
const BOX_INDENT = 240;
/** English Metric Units per inch, and pixels per inch for images without other information. */
const EMU_PER_INCH = 914400;
const PIXELS_PER_INCH = 96;
const MAX_IMAGE_WIDTH = Math.floor((TEXT_WIDTH / 1440) * EMU_PER_INCH);

const MONO = 'Consolas';
/** A 6 pt high empty paragraph. */
const SPACER = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>';
const MATH_FONT = 'Cambria Math';
const LINK_COLOUR = '0563C1';
const BORDER_GREY = 'BFBFBF';
const BAR_GREY = 'C8CCD0';
/** The title of a box with a grey bar. */
const TITLE_GREY = '595959';
const CODE_FILL = 'F3F4F6';
const HEADER_FILL = 'F2F2F2';

/** smd callout type → colour name (exportColors.ts). */
const CALLOUT_COLOURS = new Map([
  ['note', 'blue'], ['info', 'blue'], ['tip', 'green'], ['success', 'green'], ['warning', 'amber'], ['danger', 'red'], ['question', 'purple'],
]);

const PANEL_COLOURS: Record<PanelType, string> = {
  card: 'gray', agent: 'indigo', human: 'teal', decision: 'blue', risk: 'red', api: 'purple',
};

/** `#0ea5e9`, `#abc` or `rgb(14, 165, 233)` as Word's `0EA5E9`; else undefined. */
export function hexColour(css: string | undefined): string | undefined {
  if (!css) return undefined;
  const value = css.trim().toLowerCase();
  const long = /^#([0-9a-f]{6})$/.exec(value);
  if (long) return long[1].toUpperCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short) return (short[1] + short[1] + short[2] + short[2] + short[3] + short[3]).toUpperCase();
  const inner = /^rgba?\(([^)]*)\)$/.exec(value)?.[1];
  // `14, 165, 233`, `14 165 233` or with an alpha after them.
  const channels = inner?.split(/[\s,/]+/).filter(Boolean).slice(0, 3) ?? [];
  if (channels.length < 3 || !channels.every((n) => /^\d{1,3}$/.test(n))) return undefined;
  return channels.map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

const textColour = (value: string | undefined) => hexColour(cssColour(value, TEXT_COLOURS));
const backgroundColour = (value: string | undefined) => hexColour(cssColour(value, BACKGROUNDS));

// ---------------------------------------------------------------------------
// Runs and paragraphs
// ---------------------------------------------------------------------------

interface RunProps {
  style?: string;
  font?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  color?: string;
  /** Half-points. */
  size?: number;
  underline?: boolean;
  fill?: string;
  superscript?: boolean;
}

/** `<w:rPr>`, its children in the order the schema wants. */
function runPropsXml(p: RunProps): string {
  let s = '';
  if (p.style) s += `<w:rStyle w:val="${p.style}"/>`;
  if (p.font) s += `<w:rFonts w:ascii="${p.font}" w:hAnsi="${p.font}" w:cs="${p.font}"/>`;
  if (p.bold) s += '<w:b/><w:bCs/>';
  if (p.italic) s += '<w:i/><w:iCs/>';
  if (p.strike) s += '<w:strike/>';
  if (p.color) s += `<w:color w:val="${p.color}"/>`;
  if (p.size) s += `<w:sz w:val="${p.size}"/><w:szCs w:val="${p.size}"/>`;
  if (p.underline) s += '<w:u w:val="single"/>';
  if (p.fill) s += `<w:shd w:val="clear" w:color="auto" w:fill="${p.fill}"/>`;
  if (p.superscript) s += '<w:vertAlign w:val="superscript"/>';
  return s ? `<w:rPr>${s}</w:rPr>` : '';
}

/** Runs of text: line breaks become `<w:br/>` and tabs `<w:tab/>`. */
function runs(value: string, props: RunProps): string {
  if (!value) return '';
  const rPr = runPropsXml(props);
  const inner = value.split('\n').map((line) => line.split('\t').map((part) => (part ? `<w:t xml:space="preserve">${xmlText(part)}</w:t>` : '')).join('<w:tab/>')).join('<w:br/>');
  return `<w:r>${rPr}${inner}</w:r>`;
}

interface ParaProps {
  style?: string;
  keepNext?: boolean;
  numId?: number;
  ilvl?: number;
  /** Colour of a bar on the left. */
  bar?: string;
  /** Colour of a line below (a thematic break). */
  below?: string;
  fill?: string;
  before?: number;
  after?: number;
  left?: number;
  hanging?: number;
  align?: 'center';
}

function paragraphPropsXml(p: ParaProps): string {
  let s = '';
  if (p.style) s += `<w:pStyle w:val="${p.style}"/>`;
  if (p.keepNext) s += '<w:keepNext/>';
  if (p.numId !== undefined) s += `<w:numPr><w:ilvl w:val="${p.ilvl ?? 0}"/><w:numId w:val="${p.numId}"/></w:numPr>`;
  if (p.bar || p.below) {
    const left = p.bar ? `<w:left w:val="single" w:sz="24" w:space="8" w:color="${p.bar}"/>` : '';
    const bottom = p.below ? `<w:bottom w:val="single" w:sz="6" w:space="1" w:color="${p.below}"/>` : '';
    s += `<w:pBdr>${left}${bottom}</w:pBdr>`;
  }
  if (p.fill) s += `<w:shd w:val="clear" w:color="auto" w:fill="${p.fill}"/>`;
  if (p.before !== undefined || p.after !== undefined) {
    s += `<w:spacing${p.before === undefined ? '' : ` w:before="${p.before}"`}${p.after === undefined ? '' : ` w:after="${p.after}"`}/>`;
  }
  if (p.left) s += `<w:ind w:left="${p.left}"${p.hanging ? ` w:hanging="${p.hanging}"` : ''}/>`;
  if (p.align) s += `<w:jc w:val="${p.align}"/>`;
  return s ? `<w:pPr>${s}</w:pPr>` : '';
}

function paragraphXml(content: string, props: ParaProps): string {
  return `<w:p>${paragraphPropsXml(props)}${content}</w:p>`;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

interface ImageInfo { ext: 'png' | 'jpeg' | 'gif'; width: number; height: number }

/** The format and pixel size of a PNG, JPEG or GIF image; else undefined. */
export function imageInfo(data: Uint8Array): ImageInfo | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 24 && view.getUint32(0) === 0x89504e47) return { ext: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  if (data.length >= 10 && view.getUint32(0) === 0x47494638) return { ext: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (data.length >= 4 && view.getUint16(0) === 0xffd8) return jpegInfo(view);
  return undefined;
}

/** A JPEG's size, from its first start-of-frame marker. */
function jpegInfo(view: DataView): ImageInfo | undefined {
  let p = 2;
  while (p + 9 < view.byteLength) {
    if (view.getUint8(p) !== 0xff) return undefined;
    const marker = view.getUint8(p + 1);
    if (marker === 0xff) {
      p++;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { ext: 'jpeg', height: view.getUint16(p + 5), width: view.getUint16(p + 7) };
    p += 2 + view.getUint16(p + 2);
  }
  return undefined;
}

/** The bytes of a `data:image/…;base64,` URI; else undefined. */
function dataUri(src: string): Uint8Array | undefined {
  const m = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
  if (!m) return undefined;
  try {
    const binary = atob(m[1].replaceAll(/\s/g, ''));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/** Where blocks are written: how far in, with which bar and tint, in which paragraph style. */
interface Frame {
  indent: number;
  bar?: string;
  fill?: string;
  style?: string;
}

interface Relationship { id: string; type: string; target: string; external?: boolean }

type Part = 'document' | 'footnotes';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

class DocxWriter {
  readonly warnings: string[] = [];
  readonly media: Array<{ name: string; ext: string; data: Uint8Array }> = [];
  private readonly rels: Record<Part, Relationship[]> = { document: [], footnotes: [] };
  private part: Part = 'document';
  /** The bookmark name of each linked `#id`. */
  private readonly bookmarks = new Map<string, string>();
  private bookmarkId = 0;
  private readonly placed = new Set<string>();
  /** Runs (bookmarks, a footnote's mark) waiting for the next paragraph. */
  private pending = '';
  /** One numbering instance per ordered list, so each starts at 1; bullets share instance 1. */
  private readonly orderedLists: number[] = [];
  private drawingId = 0;
  private readonly footnotes = new Map<number, Block[]>();
  /** What was written last: Word joins two tables in a row, and the bars of two boxes in a row, so they are kept apart. */
  private last: 'table' | 'box' | 'other' = 'other';
  private readonly imageCache = new Map<string, string>();

  constructor(blocks: Block[], private readonly options: DocxWriterOptions) {
    this.collect(blocks);
  }

  /** Find the footnotes, and the ids that are both linked to and in the document (they get bookmarks). */
  private collect(blocks: Block[]): void {
    const targets = new Set<string>();
    const linked: string[] = [];
    const visit = (list: Block[]): void => {
      for (const block of list) {
        if (block.kind === 'footnotes') for (const item of block.items) this.footnotes.set(item.n, item.blocks);
        if ((block.kind === 'heading' || block.kind === 'anchor') && block.id) targets.add(block.id);
        for (const inline of blockInlines(block).flat()) {
          const href = 'marks' in inline ? inline.marks.href : undefined;
          if (href?.startsWith('#')) linked.push(safeDecode(href.slice(1)));
        }
        visit(childBlocks(block));
      }
    };
    visit(blocks);
    const names = new Set<string>();
    for (const id of linked) if (targets.has(id)) this.addBookmark(id, names);
  }

  /** Word's bookmark names: up to 40 letters, digits and underscores, starting with a letter. */
  private addBookmark(id: string, names: Set<string>): void {
    if (!id || this.bookmarks.has(id)) return;
    const base = `smd_${id.replaceAll(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 36);
    let name = base;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base}_${n}`;
    names.add(name.toLowerCase());
    this.bookmarks.set(id, name);
  }

  private bookmark(id: string | undefined): void {
    const name = id === undefined ? undefined : this.bookmarks.get(id);
    // Each bookmark once: Word wants unique names.
    if (!name || this.placed.has(name)) return;
    this.placed.add(name);
    const n = this.bookmarkId++;
    this.pending += `<w:bookmarkStart w:id="${n}" w:name="${name}"/><w:bookmarkEnd w:id="${n}"/>`;
  }

  /** The document body: the blocks, then any bookmark still waiting. */
  body(blocks: Block[]): string {
    const out = this.blocks(blocks, { indent: 0 });
    // Word wants a paragraph after a table that ends the document.
    if (this.pending || this.last === 'table') return out + this.paragraph('<w:r/>', {}, { indent: 0 });
    return out;
  }

  /** A paragraph with the waiting runs first. Empty paragraphs are left out unless something waits. */
  private paragraph(content: string, props: ParaProps, frame: Frame): string {
    if (!content && !this.pending) return '';
    const inner = this.pending + content;
    this.pending = '';
    // Some room after a table, which has no spacing of its own.
    const before = props.before ?? (this.last === 'table' ? 120 : undefined);
    this.last = 'other';
    const left = (props.left ?? 0) + frame.indent;
    return paragraphXml(inner, {
      style: frame.style ?? 'BodyText', bar: frame.bar, fill: frame.fill, ...props, before, left: left || undefined,
    });
  }

  private blocks(list: Block[], frame: Frame): string {
    return list.map((b) => this.block(b, frame)).join('');
  }

  private block(b: Block, frame: Frame): string {
    switch (b.kind) {
      case 'heading':
        this.bookmark(b.id);
        return this.paragraph(this.inlines(b.content), { style: `Heading${Math.min(Math.max(b.level, 1), 6)}` }, frame);
      case 'paragraph':
        return this.paragraph(this.inlines(b.content), {}, frame);
      case 'list':
        return this.list(b.ordered, b.items, frame, 0);
      case 'code':
        return this.code(b.code, b.lang, b.title, frame);
      case 'math':
        return this.paragraph(runs(b.tex, { font: MATH_FONT, italic: true }), { align: 'center' }, frame);
      case 'quote':
        return this.blocks(b.blocks, { ...frame, indent: frame.indent + BOX_INDENT, bar: BAR_GREY, style: 'BlockText' });
      case 'callout': {
        const colour = CALLOUT_COLOURS.get(b.type) ?? 'blue';
        return this.box(b.title, b.blocks, frame, textColour(colour) ?? LINK_COLOUR, backgroundColour(colour));
      }
      case 'panel':
        return this.box(b.title, b.blocks, frame, textColour(PANEL_COLOURS[b.type]) ?? BAR_GREY);
      case 'expand':
        return this.box(b.title, b.blocks, frame, BAR_GREY);
      case 'rule':
        return this.paragraph('<w:r/>', { below: BORDER_GREY }, { indent: frame.indent });
      case 'table':
        return this.table(b.header, b.rows, frame);
      case 'anchor':
        this.bookmark(b.id);
        return '';
      case 'footnotes':
        // Written as Word footnotes (footnotesXml).
        return '';
    }
  }

  /** A box: a bold title in the bar's colour, then the content, all with the bar (and tint). */
  private box(title: string, blocks: Block[], frame: Frame, bar: string, fill?: string): string {
    // An empty paragraph between two boxes in a row, or Word draws their bars as one.
    const gap = this.last === 'box' ? SPACER : '';
    const inner: Frame = { indent: frame.indent + BOX_INDENT, bar, fill, style: frame.style };
    const color = bar === BAR_GREY ? TITLE_GREY : bar;
    const heading = title ? this.paragraph(runs(title, { bold: true, color }), { keepNext: true, after: 60 }, inner) : '';
    const out = gap + heading + this.blocks(blocks, inner);
    this.last = 'box';
    return out;
  }

  private list(ordered: boolean, items: ListItem[], frame: Frame, level: number): string {
    let numId = 1;
    if (ordered) {
      numId = 2 + this.orderedLists.length;
      this.orderedLists.push(numId);
    }
    const left = LIST_INDENT * (level + 1);
    let out = '';
    for (const item of items) {
      // Anchors go on the item's first paragraph.
      const content: Block[] = [];
      for (const b of item.blocks) {
        if (b.kind === 'anchor') this.bookmark(b.id);
        else content.push(b);
      }
      const [first, ...rest] = content;
      const lead = first?.kind === 'paragraph' ? first : undefined;
      const others = lead ? rest : content;
      const style = frame.style ?? 'Compact';
      const firstContent = lead ? this.inlines(lead.content) : '';
      if (item.task) {
        const box = runs(item.task.checked ? '☒\t' : '☐\t', {});
        out += this.paragraph(box + firstContent, { style, left, hanging: HANGING }, frame);
      } else {
        // An empty run keeps an item without text (one that starts with a code block, say) numbered.
        out += this.paragraph(firstContent || '<w:r/>', { style, numId, ilvl: Math.min(level, 8), left, hanging: HANGING }, frame);
      }
      for (const block of others) {
        out += block.kind === 'list'
          ? this.list(block.ordered, block.items, frame, level + 1)
          : this.block(block, { ...frame, indent: frame.indent + left });
      }
    }
    return out;
  }

  private code(code: string, lang: string, title: string | undefined, frame: Frame): string {
    const label = title ?? (lang.toLowerCase() === 'mermaid' ? 'Mermaid diagram' : undefined);
    let out = label ? this.paragraph(runs(label, { bold: true, size: 18 }), { keepNext: true, after: 40 }, frame) : '';
    const lines = code.replace(/\n$/, '').split('\n');
    lines.forEach((line, n) => {
      const props: ParaProps = {
        style: 'SourceCode', fill: CODE_FILL, keepNext: n < lines.length - 1, before: n === 0 ? 60 : 0, after: n === lines.length - 1 ? 160 : 0,
      };
      // An empty run keeps empty lines of code.
      out += this.paragraph(runs(line, { font: MONO }) || '<w:r/>', props, { indent: frame.indent, bar: frame.bar, style: 'SourceCode' });
    });
    return out;
  }

  private table(header: boolean, rows: Inline[][][], frame: Frame): string {
    const columns = Math.max(1, ...rows.map((r) => r.length));
    const width = TEXT_WIDTH - frame.indent;
    const cellWidth = Math.floor(width / columns);
    const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${BORDER_GREY}"/>`;
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('');
    const tblPr = `<w:tblPr><w:tblStyle w:val="Table"/><w:tblW w:w="${width}" w:type="dxa"/>${frame.indent ? `<w:tblInd w:w="${frame.indent}" w:type="dxa"/>` : ''}`
      + `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="autofit"/>`
      + '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>'
      + '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>';
    const grid = `<w:tblGrid>${`<w:gridCol w:w="${cellWidth}"/>`.repeat(columns)}</w:tblGrid>`;
    const body = rows.map((cells, n) => {
      const isHeader = header && n === 0;
      const tcs = Array.from({ length: columns }, (_, c) => {
        const fill = isHeader ? `<w:shd w:val="clear" w:color="auto" w:fill="${HEADER_FILL}"/>` : '';
        const content = this.inlines(cells[c] ?? [], isHeader ? { bold: true } : {});
        return `<w:tc><w:tcPr><w:tcW w:w="${cellWidth}" w:type="dxa"/>${fill}</w:tcPr>${paragraphXml(content, { style: 'Compact', after: 0 })}</w:tc>`;
      }).join('');
      return `<w:tr>${isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${tcs}</w:tr>`;
    }).join('');
    // Word joins two tables in a row into one; an empty paragraph keeps them apart.
    const gap = this.last === 'table' ? paragraphXml('', { after: 0 }) : '';
    // Waiting bookmarks go in a paragraph before the table (a table can't hold them).
    const lead = this.pending ? this.paragraph('', { after: 0 }, frame) : '';
    this.last = 'table';
    return gap + lead + `<w:tbl>${tblPr}${grid}${body}</w:tbl>`;
  }

  /** Inline content; neighbours with the same link share one hyperlink. `base` styles all of it (a header cell's bold). */
  private inlines(list: Inline[], base: RunProps = {}): string {
    let out = '';
    let start = 0;
    const hrefOf = (i: Inline) => ('marks' in i ? i.marks.href : undefined);
    while (start < list.length) {
      const href = hrefOf(list[start]);
      let end = start + 1;
      while (end < list.length && hrefOf(list[end]) === href) end++;
      const group = list.slice(start, end);
      out += href === undefined ? group.map((i) => this.inline(i, base)).join('') : this.hyperlink(href, group, base);
      start = end;
    }
    return out;
  }

  private hyperlink(href: string, group: Inline[], base: RunProps): string {
    const linkProps: RunProps = { ...base, style: 'Hyperlink', color: LINK_COLOUR, underline: true };
    const inner = group.map((i) => this.inline(i, linkProps)).join('');
    if (href.startsWith('#')) {
      const name = this.bookmarks.get(safeDecode(href.slice(1)));
      return name ? `<w:hyperlink w:anchor="${name}" w:history="1">${inner}</w:hyperlink>` : group.map((i) => this.inline(i, base)).join('');
    }
    const target = linkTarget(href);
    if (!target) return group.map((i) => this.inline(i, base)).join('');
    const id = this.relationship(`${REL}/hyperlink`, target, true);
    return `<w:hyperlink r:id="${id}" w:history="1">${inner}</w:hyperlink>`;
  }

  private inline(i: Inline, base: RunProps): string {
    switch (i.kind) {
      case 'text':
        return runs(i.text, this.markProps(i.marks, base));
      case 'math':
        return runs(i.tex, { ...this.markProps(i.marks, base), font: MATH_FONT, italic: true });
      case 'break':
        return '<w:r><w:br/></w:r>';
      case 'status':
        return runs(` ${i.text} `, { ...base, bold: true, size: 18, color: textColour(i.color) ?? '444444', fill: backgroundColour(i.color) ?? HEADER_FILL });
      case 'date':
        return runs(i.date, base);
      case 'footnote':
        return this.footnoteReference(i.n, base);
      case 'image':
        return this.image(i.src, i.alt, base);
    }
  }

  private markProps(marks: Marks, base: RunProps): RunProps {
    const props: RunProps = { ...base };
    if (marks.bold) props.bold = true;
    if (marks.italic) props.italic = true;
    if (marks.strike) props.strike = true;
    if (marks.underline) props.underline = true;
    if (marks.code) {
      props.style = 'VerbatimChar';
      props.font = MONO;
      props.fill = CODE_FILL;
    }
    const color = textColour(marks.color);
    if (color) props.color = color;
    const fill = backgroundColour(marks.highlight);
    if (fill) props.fill = fill;
    return props;
  }

  private footnoteReference(n: number, base: RunProps): string {
    if (!this.footnotes.has(n) || this.part === 'footnotes') return runs(String(n), { ...base, superscript: true });
    return `<w:r>${runPropsXml({ style: 'FootnoteReference', superscript: true })}<w:footnoteReference w:id="${n}"/></w:r>`;
  }

  /** An embedded image, or its alt text (linked, for an image on the web) when it can't be embedded. */
  private image(src: string, alt: string, base: RunProps): string {
    const fallback = () => runs(alt || src, { ...base, italic: true });
    if (/^https?:\/\//i.test(src)) {
      this.warnings.push(`Image ${src} is on the web: the .docx links to it instead of embedding it.`);
      const target = linkTarget(src);
      if (!target) return fallback();
      const id = this.relationship(`${REL}/hyperlink`, target, true);
      return `<w:hyperlink r:id="${id}" w:history="1">${runs(alt || src, { ...base, style: 'Hyperlink', color: LINK_COLOUR, underline: true })}</w:hyperlink>`;
    }
    const data = src.startsWith('data:') ? dataUri(src) : this.options.readBinary?.(safeDecode(src.split(/[?#]/)[0]));
    const info = data && imageInfo(data);
    if (!data || !info) {
      this.warnings.push(data ? `Image ${shortSrc(src)} is not PNG, JPEG or GIF: only its alt text is in the .docx.` : `Image ${shortSrc(src)} was not found: only its alt text is in the .docx.`);
      return fallback();
    }
    let cx = Math.round((info.width / PIXELS_PER_INCH) * EMU_PER_INCH);
    let cy = Math.round((info.height / PIXELS_PER_INCH) * EMU_PER_INCH);
    if (cx > MAX_IMAGE_WIDTH) {
      cy = Math.round((cy * MAX_IMAGE_WIDTH) / cx);
      cx = MAX_IMAGE_WIDTH;
    }
    const id = this.mediaRelationship(src, data, info.ext);
    const n = ++this.drawingId;
    const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const pic = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
    return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
      + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${n}" name="Picture ${n}" descr="${xmlAttr(alt)}"/>`
      + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
      + `<a:graphic xmlns:a="${a}"><a:graphicData uri="${pic}"><pic:pic xmlns:pic="${pic}">`
      + `<pic:nvPicPr><pic:cNvPr id="${n}" name="Picture ${n}" descr="${xmlAttr(alt)}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  }

  /** The relationship of an image in the current part; each file is stored once. */
  private mediaRelationship(src: string, data: Uint8Array, ext: string): string {
    let name = this.imageCache.get(src);
    if (!name) {
      name = `image${this.media.length + 1}.${ext}`;
      this.media.push({ name, ext, data });
      this.imageCache.set(src, name);
    }
    const target = `media/${name}`;
    const existing = this.rels[this.part].find((r) => r.target === target);
    return existing?.id ?? this.relationship(`${REL}/image`, target);
  }

  private relationship(type: string, target: string, external = false): string {
    const list = this.rels[this.part];
    const found = list.find((r) => r.type === type && r.target === target);
    if (found) return found.id;
    // rId1 to rId4 are the document's styles, numbering, settings and footnotes.
    const id = `rId${list.length + 10}`;
    list.push({ id, type, target, external });
    return id;
  }

  /** A part's relationships: the document's own parts, then links and images. */
  partRels(part: Part, footnotes: boolean): Relationship[] {
    const own: Relationship[] = part === 'document'
      ? [
          { id: 'rId1', type: `${REL}/styles`, target: 'styles.xml' },
          { id: 'rId2', type: `${REL}/numbering`, target: 'numbering.xml' },
          { id: 'rId3', type: `${REL}/settings`, target: 'settings.xml' },
          ...(footnotes ? [{ id: 'rId4', type: `${REL}/footnotes`, target: 'footnotes.xml' }] : []),
        ]
      : [];
    return [...own, ...this.rels[part]];
  }

  /** `word/footnotes.xml`, or '' when the document has no footnotes. */
  footnotesXml(): string {
    if (!this.footnotes.size) return '';
    this.part = 'footnotes';
    const separator = (type: string, id: number, mark: string) =>
      `<w:footnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r>${mark}</w:r></w:p></w:footnote>`;
    let out = separator('separator', -1, '<w:separator/>') + separator('continuationSeparator', 0, '<w:continuationSeparator/>');
    for (const [n, blocks] of this.footnotes) {
      this.pending = `<w:r>${runPropsXml({ style: 'FootnoteReference', superscript: true })}<w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>`;
      const body = this.blocks(blocks, { indent: 0, style: 'FootnoteText' });
      const rest = this.pending ? this.paragraph('', {}, { indent: 0, style: 'FootnoteText' }) : '';
      out += `<w:footnote w:id="${n}">${body}${rest}</w:footnote>`;
    }
    this.part = 'document';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:footnotes ${NAMESPACES}>${out}</w:footnotes>`;
  }

  /** `word/numbering.xml`: bullets (instance 1) and one decimal instance per ordered list, each starting at 1. */
  numberingXml(): string {
    const BULLETS = ['•', '◦', '▪'];
    const FORMATS = ['decimal', 'lowerLetter', 'lowerRoman'];
    const level = (l: number, format: string, text: string, font?: string) =>
      `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>`
      + `<w:pPr><w:ind w:left="${LIST_INDENT * (l + 1)}" w:hanging="${HANGING}"/></w:pPr>${font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/></w:rPr>` : ''}</w:lvl>`;
    const levels = (make: (l: number) => string) => Array.from({ length: 9 }, (_, l) => make(l)).join('');
    const bullets = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels((l) => level(l, 'bullet', BULLETS[l % 3]))}</w:abstractNum>`;
    const decimal = `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels((l) => level(l, FORMATS[l % 3], `%${l + 1}.`))}</w:abstractNum>`;
    const restart = levels((l) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="1"/></w:lvlOverride>`);
    const nums = '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
      + this.orderedLists.map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/>${restart}</w:num>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${NAMESPACES}>${bullets}${decimal}${nums}</w:numbering>`;
  }
}

/**
 * A link's target as Word accepts it: a valid URI, without spaces or other characters it rejects as a damaged
 * file. Relative links (another document beside this one) stay relative. Undefined when it can't be one.
 */
export function linkTarget(href: string): string | undefined {
  try {
    const target = encodeURI(safeDecode(href));
    return target && !target.startsWith('javascript:') ? target : undefined;
  } catch {
    return undefined;
  }
}

const shortSrc = (src: string) => (src.length > 80 ? `${src.slice(0, 77)}…` : src);

// ---------------------------------------------------------------------------
// The package's other parts
// ---------------------------------------------------------------------------

const NAMESPACES = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + `xmlns:r="${REL}" `
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
  + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function documentXml(body: string): string {
  const section = `<w:sectPr><w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}"/>`
    + `<w:pgMar w:top="${PAGE.margin}" w:right="${PAGE.margin}" w:bottom="${PAGE.margin}" w:left="${PAGE.margin}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  return `${XML_HEAD}<w:document ${NAMESPACES}><w:body>${body}${section}</w:body></w:document>`;
}

function relationships(rels: Relationship[]): string {
  const items = rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('');
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
}

const ROOT_RELS = relationships([
  { id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' },
  { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
  { id: 'rId3', type: `${REL}/extended-properties`, target: 'docProps/app.xml' },
]);

function contentTypes(footnotes: boolean, images: string[]): string {
  const main = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  const override = (part: string, type: string) => `<Override PartName="${part}" ContentType="${type}"/>`;
  const defaults = [...new Set(images)].map((ext) => `<Default Extension="${ext}" ContentType="image/${ext}"/>`).join('');
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + `<Default Extension="xml" ContentType="application/xml"/>${defaults}`
    + override('/word/document.xml', `${main}.document.main+xml`)
    + override('/word/styles.xml', `${main}.styles+xml`)
    + override('/word/numbering.xml', `${main}.numbering+xml`)
    + override('/word/settings.xml', `${main}.settings+xml`)
    + (footnotes ? override('/word/footnotes.xml', `${main}.footnotes+xml`) : '')
    + override('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml')
    + override('/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml')
    + '</Types>';
}

function coreProperties(title: string | undefined, lang: string): string {
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" `
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `${title ? `<dc:title>${xmlText(title)}</dc:title>` : ''}<dc:language>${xmlText(lang)}</dc:language></cp:coreProperties>`;
}

const APP_PROPERTIES = `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">`
  + '<Application>Styled Markdown</Application></Properties>';

function settingsXml(footnotes: boolean): string {
  const notes = footnotes ? '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' : '';
  return `${XML_HEAD}<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>${notes}`
    + '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
    + '</w:settings>';
}

/** A paragraph style. */
function pStyle(id: string, name: string, pPr: string, rPr: string, extra = ''): string {
  return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}</w:style>`;
}

/** `word/styles.xml`: Pandoc's style names, in Calibri 11 pt. */
export function stylesXml(lang: string): string {
  const based = (id: string, next = 'BodyText') => `<w:basedOn w:val="${id}"/><w:next w:val="${next}"/><w:qFormat/>`;
  const font = (f: string) => `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>`;
  const size = (halfPoints: number) => `<w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/>`;
  const HEADING_SIZES = [32, 28, 26, 24, 22, 22];
  const headings = HEADING_SIZES.map((sz, n) => pStyle(
    `Heading${n + 1}`, `heading ${n + 1}`,
    `<w:keepNext/><w:keepLines/><w:spacing w:before="${n ? 240 : 360}" w:after="80"/><w:outlineLvl w:val="${n}"/>`,
    `<w:b/><w:bCs/>${n === 5 ? '<w:i/><w:iCs/>' : ''}<w:color w:val="1F3864"/>${size(sz)}`,
    based('Normal'),
  )).join('');
  return `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:docDefaults><w:rPrDefault><w:rPr>${font('Calibri')}${size(22)}<w:lang w:val="${xmlAttr(lang)}"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>'
    + '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:semiHidden/></w:style>'
    + pStyle('BodyText', 'Body Text', '', '', based('Normal'))
    + pStyle('FirstParagraph', 'First Paragraph', '', '', based('BodyText'))
    + pStyle('Compact', 'Compact', '<w:spacing w:before="20" w:after="40"/>', '', based('BodyText', 'Compact'))
    + pStyle('Title', 'Title', '<w:keepNext/><w:spacing w:before="0" w:after="160"/>', `<w:b/><w:bCs/><w:color w:val="1F3864"/>${size(48)}`, based('Normal'))
    + pStyle('Subtitle', 'Subtitle', '<w:keepNext/><w:spacing w:after="240"/>', `<w:color w:val="595959"/>${size(28)}`, based('Title'))
    + headings
    + pStyle('BlockText', 'Block Text', '', '<w:color w:val="404040"/>', based('BodyText'))
    + pStyle('SourceCode', 'Source Code', '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', `${font(MONO)}${size(19)}`, based('Normal', 'SourceCode'))
    + pStyle('FootnoteText', 'footnote text', '<w:spacing w:after="40" w:line="240" w:lineRule="auto"/>', size(18), based('Normal', 'FootnoteText'))
    + pStyle('Caption', 'caption', '<w:spacing w:before="0" w:after="160"/>', `<w:i/><w:iCs/>${size(18)}`, based('Normal'))
    + pStyle('TableCaption', 'Table Caption', '<w:keepNext/>', '', based('Caption'))
    + pStyle('ImageCaption', 'Image Caption', '', '', based('Caption'))
    + `<w:style w:type="character" w:customStyle="1" w:styleId="VerbatimChar"><w:name w:val="Verbatim Char"/><w:rPr>${font(MONO)}${size(19)}</w:rPr></w:style>`
    + `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="${LINK_COLOUR}"/><w:u w:val="single"/></w:rPr></w:style>`
    + '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
    + '<w:style w:type="table" w:customStyle="1" w:styleId="Table"><w:name w:val="Table"/><w:basedOn w:val="TableNormal"/><w:tblPr/></w:style>'
    + '</w:styles>';
}
