/**
 * A minimal ZIP archive writer and reader, for .docx files (which are ZIP archives of XML parts). smd has no
 * runtime dependencies and the core runs in browsers too, so compression is passed in: Node's
 * `zlib.deflateRawSync` and `zlib.inflateRawSync` in the CLI and the editors. Without a deflater, entries are
 * stored; Word, LibreOffice and Google Docs open both.
 */

export interface ZipEntry {
  /** The path in the archive, with `/` separators. */
  name: string;
  data: Uint8Array;
}

/** Raw DEFLATE (RFC 1951), without zlib's header: `zlib.deflateRawSync`. */
export type Deflate = (data: Uint8Array) => Uint8Array;

/** Raw INFLATE: `zlib.inflateRawSync`. */
export type Inflate = (data: Uint8Array) => Uint8Array;

const STORED = 0;
const DEFLATED = 8;
/** 1980-01-01 00:00, the earliest MS-DOS date: archives don't change from one run to the next. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** Bit 11: names are UTF-8. */
const UTF8_FLAG = 0x0800;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

let crcTable: Uint32Array | undefined;

/** The CRC-32 (IEEE 802.3) of `data`, as ZIP stores it. */
export function crc32(data: Uint8Array): number {
  crcTable ??= makeCrcTable();
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** A ZIP archive of `entries`, in order. Entries are deflated when `deflate` is given and that makes them smaller. */
export function zip(entries: readonly ZipEntry[], deflate?: Deflate): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const packed = deflate?.(entry.data);
    const [method, body] = packed && packed.length < entry.data.length ? [DEFLATED, packed] : [STORED, entry.data];
    const fields = { name, crc, method, compressed: body.length, size: entry.data.length };
    const local = header(LOCAL_HEADER, fields);
    locals.push(local, body);
    centrals.push(header(CENTRAL_HEADER, fields, offset));
    offset += local.length + body.length;
  }
  const directorySize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, offset, true);
  return concat([...locals, ...centrals, end]);
}

interface HeaderFields { name: Uint8Array; crc: number; method: number; compressed: number; size: number }

/** A local file header (no `offset`) or a central directory header (with the local header's `offset`). */
function header(signature: number, f: HeaderFields, offset?: number): Uint8Array {
  const central = offset !== undefined;
  const fixed = central ? 46 : 30;
  const out = new Uint8Array(fixed + f.name.length);
  const view = new DataView(out.buffer);
  let p = 0;
  const u16 = (v: number) => { view.setUint16(p, v, true); p += 2; };
  const u32 = (v: number) => { view.setUint32(p, v, true); p += 4; };
  u32(signature);
  if (central) u16(20); // version made by
  u16(20); // version needed to extract
  u16(UTF8_FLAG);
  u16(f.method);
  u16(DOS_TIME);
  u16(DOS_DATE);
  u32(f.crc);
  u32(f.compressed);
  u32(f.size);
  u16(f.name.length);
  u16(0); // extra field length
  if (central) {
    u16(0); // comment length
    u16(0); // disk number
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offset);
  }
  out.set(f.name, p);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * One entry of a ZIP archive, by name, or undefined when there is none. Reads the central directory, so it copes
 * with archives that put sizes after the data. Throws when `data` isn't a ZIP archive, or uses a compression
 * method other than stored and deflated.
 */
export function unzipEntry(data: Uint8Array, name: string, inflate: Inflate): Uint8Array | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = findEndOfCentralDirectory(view);
  const count = view.getUint16(end + 10, true);
  const decoder = new TextDecoder();
  let p = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    if (p + 46 > data.length || view.getUint32(p, true) !== CENTRAL_HEADER) throw new Error('Not a valid ZIP archive (central directory).');
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const entryName = decoder.decode(data.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (local + 30 > data.length || view.getUint32(local, true) !== LOCAL_HEADER) throw new Error('Not a valid ZIP archive (local header).');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = data.subarray(start, start + compressed);
    if (method === STORED) return body;
    if (method === DEFLATED) return inflate(body);
    throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
  }
  return undefined;
}

function findEndOfCentralDirectory(view: DataView): number {
  // The record is 22 bytes plus a comment of up to 65535 bytes, at the very end.
  const last = view.byteLength - 22;
  for (let p = last; p >= Math.max(0, last - 0xffff); p--) {
    if (view.getUint32(p, true) === END_OF_CENTRAL_DIRECTORY) return p;
  }
  throw new Error('Not a ZIP archive.');
}
