/**
 * Open documents and position conversion for the language server.
 *
 * The core reports columns as JavaScript string indices, which are UTF-16 code units: exactly what LSP
 * positions mean by default. A client may offer other encodings (LSP 3.17 `general.positionEncodings`);
 * UTF-16 is used whenever it is offered or nothing is, otherwise UTF-32 (code points) or UTF-8 (bytes).
 */

export type PositionEncoding = 'utf-16' | 'utf-32' | 'utf-8';

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }

/** The encoding to use, from the encodings the client offers (most preferred first). */
export function chooseEncoding(offered: unknown): PositionEncoding {
  if (!Array.isArray(offered) || !offered.length || offered.includes('utf-16')) return 'utf-16';
  const known = offered.find((e): e is PositionEncoding => e === 'utf-32' || e === 'utf-8');
  return known ?? 'utf-16';
}

/** Width of one code point in the client's encoding. */
function unitsOf(codePoint: number, encoding: PositionEncoding): number {
  if (encoding === 'utf-32') return 1;
  if (encoding === 'utf-16') return codePoint > 0xffff ? 2 : 1;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint > 0xffff ? 4 : 3;
}

/** A UTF-16 column of `line` as a column in `encoding`. */
export function toClientColumn(line: string, column: number, encoding: PositionEncoding): number {
  const end = Math.min(Math.max(column, 0), line.length);
  if (encoding === 'utf-16') return end;
  let units = 0;
  for (let i = 0; i < end;) {
    const codePoint = line.codePointAt(i)!;
    const width = codePoint > 0xffff ? 2 : 1;
    // A column inside a surrogate pair counts as the start of that character.
    if (i + width > end) break;
    units += unitsOf(codePoint, encoding);
    i += width;
  }
  return units;
}

/**
 * A column in `encoding` as a UTF-16 column of `line`. Columns past the end of the line mean the end;
 * a column inside a character means its start.
 */
export function fromClientColumn(line: string, column: number, encoding: PositionEncoding): number {
  if (encoding === 'utf-16') return Math.min(Math.max(column, 0), line.length);
  let units = 0;
  let i = 0;
  while (i < line.length) {
    const codePoint = line.codePointAt(i)!;
    const width = unitsOf(codePoint, encoding);
    if (units + width > column) break;
    units += width;
    i += codePoint > 0xffff ? 2 : 1;
  }
  return i;
}

/** A document the client has open, with conversions between core (UTF-16) and client positions. */
export class TextDocument {
  private cachedLines?: string[];

  constructor(readonly uri: string, readonly version: number, readonly text: string, readonly encoding: PositionEncoding) {}

  get lines(): string[] {
    this.cachedLines ??= this.text.split(/\r?\n/);
    return this.cachedLines;
  }

  /** The line break the document uses. */
  get eol(): string {
    return this.text.includes('\r\n') ? '\r\n' : '\n';
  }

  /** A client position for a zero-based line and UTF-16 column. */
  position(line: number, column: number): Position {
    const text = this.lines[line] ?? '';
    return { line, character: toClientColumn(text, column, this.encoding) };
  }

  /** A client range on one line, from UTF-16 columns. */
  range(line: number, start: number, end: number): Range {
    return { start: this.position(line, start), end: this.position(line, end) };
  }

  /** From the start of `startLine` to the end of `endLine`. */
  lineRange(startLine: number, endLine: number): Range {
    return { start: { line: startLine, character: 0 }, end: this.position(endLine, this.lines[endLine]?.length ?? 0) };
  }

  /** A client position as a line and UTF-16 column, clamped to the document. */
  locate(position: Position): { line: number; column: number } {
    const line = Math.min(Math.max(position.line, 0), this.lines.length - 1);
    return { line, column: fromClientColumn(this.lines[line], position.character, this.encoding) };
  }
}

/** The documents the client has open, by URI. */
export class TextDocuments {
  private readonly documents = new Map<string, TextDocument>();

  constructor(private readonly encoding: () => PositionEncoding) {}

  set(uri: string, version: number, text: string): TextDocument {
    const document = new TextDocument(uri, version, text, this.encoding());
    this.documents.set(uri, document);
    return document;
  }

  get(uri: string): TextDocument | undefined {
    return this.documents.get(uri);
  }

  delete(uri: string): void {
    this.documents.delete(uri);
  }

  all(): TextDocument[] {
    return [...this.documents.values()];
  }
}
