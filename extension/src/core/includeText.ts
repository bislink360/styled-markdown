import { FigureCounter, type Figure } from './figures';
import { parseFrontMatter } from './frontmatter';
import {
  containerEnd, dirOf, findIncludes, includeRequest, innerScope, loadInclude, outsideCode, rebaseFenceFile, rebaseUrl, rootScope, shiftedLevel,
  type IncludeBlock, type IncludeScope, type IncludeSource, type LoadedInclude,
} from './include';
import { findLinks } from './links';
import { codeLines, parseSmd } from './parse';

/** `:::include` for the line-based views (agent view, plain Markdown, validation), which read text rather than tokens. */

/** Read includes through `readFile`, finding sections by the headings parseSmd gives. */
export function includeSource(readFile: ((relativePath: string) => string | undefined) | undefined): IncludeSource {
  return { readFile, headings: (text) => parseSmd(text).headings };
}

/**
 * The lines of an included file as the including document reads them (same indexes): headings moved by its
 * `level`, and relative links, images and code embeds rebased onto the including document's folder.
 */
export function includedLines(include: LoadedInclude): string[] {
  const lines = [...include.lines];
  const dir = dirOf(include.path);
  if (dir) rebaseLinks(lines, dir);
  for (const [i, fence] of outsideCode(lines, include.start, include.end)) {
    lines[i] = fence ? rebaseFenceFile(lines[i], dir) : shiftHeading(lines[i], include.shift);
  }
  return lines;
}

/**
 * The included lines as text on their own, as rendering parses them, and what to add to a line of it for the
 * line of the included file. A leading blank line keeps a body that starts with `---` from reading as front matter.
 */
export function includedText(include: LoadedInclude): { text: string; offset: number } {
  return { text: ['', ...include.lines.slice(include.start, include.end + 1)].join('\n'), offset: include.start - 1 };
}

/** The lines of the included file (zero-based, in that file) that are code where it is included. */
export function includedCodeLines(include: LoadedInclude): Set<number> {
  const { text, offset } = includedText(include);
  return codeLines(text, offset);
}

/** Links, images, reference definitions and HTML href/src; `:::include` paths stay, as nested includes resolve them. */
function rebaseLinks(lines: string[], dir: string): void {
  const links = findLinks(lines.join('\n')).links
    .filter((l) => l.kind !== 'related' && l.kind !== 'include')
    .sort((a, b) => b.line - a.line || b.column - a.column);
  for (const link of links) {
    const line = lines[link.line];
    lines[link.line] = line.slice(0, link.column) + rebaseUrl(link.target, dir) + line.slice(link.column + link.target.length);
  }
}

function shiftHeading(line: string, shift: number): string {
  if (!shift) return line;
  const m = /^(\s{0,3})(#{1,6})(?=\s|$)/.exec(line);
  return m ? m[1] + '#'.repeat(shiftedLevel(m[2].length, shift)) + line.slice(m[0].length) : line;
}

// ---------------------------------------------------------------------------
// Figures across includes
// ---------------------------------------------------------------------------

/**
 * The figures of a document and of the text its `:::include` blocks bring in, numbered together in document order
 * with one counter per kind, as rendered output numbers them. A loaded include's fallback body is replaced by the
 * included text, so figures written in that body don't count; an include that can't be loaded keeps its body.
 */
export interface ExpandedFigures {
  /** Figures by id, included ones too; when two share an id, the first in document order wins. */
  byId: ReadonlyMap<string, Figure>;
  /**
   * Each document's figures by the zero-based line of their opening fence in that document's own lines: the root
   * document under `''`, an included document under the key `includeKey` gives the include that brings it in.
   */
  byDocument: ReadonlyMap<string, ReadonlyMap<number, Figure>>;
}

/** The key of the document that the `:::include` on zero-based `line` of the document `parent` brings in. */
export const includeKey = (parent: string, line: number): string => `${parent}/${line}`;

const NO_FIGURES: ReadonlyMap<number, Figure> = new Map();

/** A document's own figures in ExpandedFigures, by line. */
export const figuresOf = (figures: ExpandedFigures, key: string): ReadonlyMap<number, Figure> => figures.byDocument.get(key) ?? NO_FIGURES;

/**
 * Number the figures of `text` and, with `readFile`, of the documents its includes bring in, as the agent view and
 * `smd to-md` expand them. Without `readFile` nothing is included and the numbers are parseSmd's.
 */
export function expandedFigures(text: string, readFile?: (relativePath: string) => string | undefined): ExpandedFigures {
  const lines = text.split(/\r?\n/);
  const walk: FigureWalk = { counter: new FigureCounter(), byId: new Map(), byDocument: new Map(), source: includeSource(readFile), root: text };
  const from = parseFrontMatter(text).bodyStartLine;
  numberDocument({ key: '', lines, figures: parseSmd(text).figures, from, to: lines.length - 1 }, walk);
  return { byId: walk.byId, byDocument: walk.byDocument };
}

interface FigureWalk {
  counter: FigureCounter;
  byId: Map<string, Figure>;
  byDocument: Map<string, Map<number, Figure>>;
  source: IncludeSource;
  /** The root document, for include cycles. */
  root: string;
}

/** One document of the walk: its lines, its figures (lines in `lines`) and the lines [from, to] it shows. */
interface FigureDocument {
  key: string;
  lines: string[];
  figures: Figure[];
  from: number;
  to: number;
  /** Where its includes resolve; the root document's includes each start a scope of their own, as the views do. */
  scope?: IncludeScope;
}

function numberDocument(doc: FigureDocument, walk: FigureWalk): void {
  const own = new Map<number, Figure>();
  walk.byDocument.set(doc.key, own);
  const includes = walk.source.readFile ? findIncludes(doc.lines, doc.from, doc.to) : [];
  const events = [...doc.figures.map((figure) => ({ line: figure.line, figure })), ...includes.map((include) => ({ line: include.line, include }))]
    .sort((a, b) => a.line - b.line);
  // The last line of the include whose fallback body the included text replaces.
  let replacedTo = -1;
  for (const event of events) {
    if (event.line <= replacedTo) continue;
    if ('figure' in event) numberFigure(event.figure, own, walk);
    else replacedTo = expandFigures(event.include, doc, walk) ?? replacedTo;
  }
}

function numberFigure(figure: Figure, own: Map<number, Figure>, walk: FigureWalk): void {
  const numbered: Figure = { ...walk.counter.next(figure.kind), ...(figure.id ? { id: figure.id } : {}), line: figure.line };
  own.set(figure.line, numbered);
  if (figure.id && !walk.byId.has(figure.id)) walk.byId.set(figure.id, numbered);
}

/** Number the figures an include brings in; returns its closing line when it is loaded. */
function expandFigures(block: IncludeBlock, doc: FigureDocument, walk: FigureWalk): number | undefined {
  const request = includeRequest(block.info.attrs.values);
  const scope = doc.scope ?? rootScope(walk.root);
  const result = request && loadInclude(request, scope, walk.source);
  if (!result?.ok) return undefined;
  const inc = result.include;
  const { text, offset } = includedText(inc);
  const figures = parseSmd(text).figures.map((f) => ({ ...f, line: f.line + offset }));
  numberDocument({ key: includeKey(doc.key, block.line), lines: inc.lines, figures, from: inc.start, to: inc.end, scope: innerScope(scope, inc) }, walk);
  return containerEnd(doc.lines, block.line);
}
