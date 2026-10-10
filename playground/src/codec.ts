/**
 * Share-by-URL codec: a document travels in the URL fragment (`#smd=…`) as base64url of its UTF-8 text compressed
 * with deflate-raw. The fragment is never sent to a server, so a shared document stays between the people who share
 * the link. Uses only web platform APIs (CompressionStream, Blob, Response, btoa), which Node 18+ has as well.
 */

/** The fragment key: `#smd=<payload>`. A future format can use a different key and keep this one readable. */
export const FRAGMENT_KEY = 'smd';

/** Above this many characters a link may be cut off by chat apps, mail clients and some browsers. */
export const SHARE_WARN_LENGTH = 8 * 1024;

/**
 * Decompressing stops past this many bytes, so a crafted fragment of a few KB can't expand into gigabytes and hang
 * the tab (a "zip bomb"). Far above any document worth sharing by link.
 */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

const CHUNK = 0x8000;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Throws on characters outside the base64url alphabet. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not base64url');
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** True when this browser can compress share links. */
export function canShare(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

/** Reads a byte stream to the end, failing once it passes `limit` bytes. */
async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`The shared document is larger than ${limit} bytes.`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Runs bytes through a (de)compression stream, reading at most `limit` bytes of output. */
async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Errors surface on the readable side, which readAll reports; this only keeps them from going unhandled.
  const writing = writer.write(bytes).then(() => writer.close()).catch(() => undefined);
  const out = await readAll(stream.readable, limit);
  await writing;
  return out;
}

/** The fragment payload for a document: base64url of its deflate-raw compressed UTF-8. */
export async function encodeDocument(text: string): Promise<string> {
  return bytesToBase64Url(await pipe(new TextEncoder().encode(text), new CompressionStream('deflate-raw'), Number.POSITIVE_INFINITY));
}

/** The document in a fragment payload. Throws when it isn't one, or when it expands past MAX_DOCUMENT_BYTES. */
export async function decodeDocument(payload: string, limit = MAX_DOCUMENT_BYTES): Promise<string> {
  if (!payload) return ''; // `#smd=` with nothing after it: an empty document
  const bytes = await pipe(base64UrlToBytes(payload), new DecompressionStream('deflate-raw'), limit);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** `#smd=<payload>` for a document. */
export async function shareFragment(text: string): Promise<string> {
  return `#${FRAGMENT_KEY}=${await encodeDocument(text)}`;
}

/** The payload of a `#smd=…` fragment, or undefined when the fragment holds no document. */
export function fragmentPayload(hash: string): string | undefined {
  const prefix = `#${FRAGMENT_KEY}=`;
  return hash.startsWith(prefix) ? hash.slice(prefix.length) : undefined;
}

export type HashDocument =
  | { kind: 'none' }
  | { kind: 'document'; text: string }
  | { kind: 'invalid'; message: string };

/** What a page's `location.hash` holds: no document, a document, or a link that can't be read. Never throws. */
export async function documentFromHash(hash: string): Promise<HashDocument> {
  const payload = fragmentPayload(hash);
  if (payload === undefined) return { kind: 'none' };
  try {
    return { kind: 'document', text: await decodeDocument(payload) };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)) || 'damaged data';
    return { kind: 'invalid', message: `This link doesn't hold a readable document (${reason}).` };
  }
}

/** A warning for a share link long enough to be cut off along the way; undefined when it's fine. */
export function shareLinkWarning(url: string, limit = SHARE_WARN_LENGTH): string | undefined {
  if (url.length <= limit) return undefined;
  const kb = (url.length / 1024).toFixed(1);
  return `This link is ${kb} KB. Links over ${limit / 1024} KB may be cut off by chat apps and mail clients; share the file instead if it doesn't open.`;
}
