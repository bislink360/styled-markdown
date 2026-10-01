/**
 * The Language Server Protocol's base layer, written by hand so it bundles into the single-file CLI:
 * JSON-RPC 2.0 messages framed by a `Content-Length` header (in bytes) over stdio.
 *
 *   initialize                 answered by the server's handler; nothing else is served before it
 *   shutdown / exit            shutdown answers null; exit ends with code 0 after shutdown, 1 without
 *   $/cancelRequest            ignored: every request is answered at once
 *   other requests             the server's handler, or MethodNotFound
 *   other notifications        the server's handler, or ignored
 *
 * Handlers run in the order messages arrive and return their result directly, so a request always
 * sees the effect of the notifications sent before it.
 */
import { JSONRPC_ERRORS } from './mcpProtocol';

export const LSP_ERRORS = {
  ...JSONRPC_ERRORS,
  serverNotInitialized: -32002,
  requestFailed: -32803,
} as const;

type Id = string | number | null;

export interface LspResponse {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface LspNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type LspMessage = LspResponse | LspNotification;

/** A failure to answer with a JSON-RPC error instead of a result. */
export class LspError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'LspError';
  }
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

const HEADER_END = Buffer.from('\r\n\r\n', 'ascii');

/** One message with its `Content-Length` header; the length counts UTF-8 bytes, not characters. */
export function frame(message: LspMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Splits a byte stream into message bodies. Chunks may hold part of a message or several; bodies are
 * decoded only once all their bytes have arrived, so a multi-byte character split across chunks is safe.
 */
export class MessageReader {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly onBody: (body: string) => void,
    private readonly onProblem: (message: string) => void,
  ) {}

  push(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([this.buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk]);
    while (this.next()) { /* one message per call */ }
  }

  /** Takes one complete message off the buffer. Returns false when more bytes are needed. */
  private next(): boolean {
    const end = this.buffer.indexOf(HEADER_END);
    if (end < 0) return false;
    const length = contentLength(this.buffer.subarray(0, end).toString('ascii'));
    const start = end + HEADER_END.length;
    if (length === undefined) {
      this.onProblem('[smd lsp] dropped a message without a valid Content-Length header');
      this.buffer = this.buffer.subarray(start);
      return true;
    }
    if (this.buffer.length < start + length) return false;
    const body = this.buffer.subarray(start, start + length).toString('utf8');
    this.buffer = this.buffer.subarray(start + length);
    this.onBody(body);
    return true;
  }
}

/** The `Content-Length` of a header block (header names are case-insensitive). */
export function contentLength(headers: string): number | undefined {
  for (const line of headers.split('\r\n')) {
    const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line);
    if (match) return Number(match[1]);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Dispatch and lifecycle
// ---------------------------------------------------------------------------

export type RequestHandler = (params: unknown) => unknown;
export type NotificationHandler = (params: unknown) => void;

export interface LspEndpointOptions {
  /** Sends one message to the client. */
  send: (message: LspMessage) => void;
  /** Request handlers by method; `initialize` is required. */
  requests: Record<string, RequestHandler>;
  notifications: Record<string, NotificationHandler>;
  /** Called on `exit` with the process exit code. */
  onExit: (code: number) => void;
  /** Where to report unexpected errors (default: stderr via console.error). */
  log?: (message: string) => void;
}

interface Incoming { id?: Id; method: string; params?: unknown }

/** Answers requests and routes notifications, following the LSP lifecycle. */
export class LspEndpoint {
  private state: 'starting' | 'running' | 'shuttingDown' = 'starting';
  private readonly log: (message: string) => void;

  constructor(private readonly options: LspEndpointOptions) {
    this.log = options.log ?? ((m) => console.error(m));
  }

  /** Whether the client has sent `shutdown`. */
  get shutDown(): boolean {
    return this.state === 'shuttingDown';
  }

  /** Sends a notification to the client, e.g. textDocument/publishDiagnostics. */
  notify(method: string, params: unknown): void {
    this.options.send({ jsonrpc: '2.0', method, params });
  }

  /** Handles one message body as read from the stream. */
  receiveBody(body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      this.respondError(null, LSP_ERRORS.parseError, 'Parse error: not valid JSON.');
      return;
    }
    this.receive(message);
  }

  /** Handles one parsed message. Responses from the client are ignored: this server sends no requests. */
  receive(message: unknown): void {
    const incoming = asIncoming(message);
    if (incoming === 'response') return;
    if (!incoming) {
      this.respondError(idOf(message), LSP_ERRORS.invalidRequest, 'Invalid request: expected a JSON-RPC 2.0 message with a method.');
      return;
    }
    if (incoming.id === undefined) this.onNotification(incoming.method, incoming.params);
    else this.onRequest(incoming.id, incoming.method, incoming.params);
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'exit') {
      this.options.onExit(this.state === 'shuttingDown' ? 0 : 1);
      return;
    }
    const handler = this.options.notifications[method];
    if (!handler || this.state !== 'running') return;
    try {
      handler(params);
    } catch (e) {
      this.log(`[smd lsp] ${method} failed: ${(e as Error).stack ?? e}`);
    }
  }

  private onRequest(id: Id, method: string, params: unknown): void {
    const refusal = this.refusal(method);
    if (refusal) {
      this.respondError(id, refusal.code, refusal.message);
      return;
    }
    try {
      const result = this.answer(method, params);
      this.options.send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (e) {
      if (e instanceof LspError) return this.respondError(id, e.code, e.message);
      this.log(`[smd lsp] ${method} failed: ${(e as Error).stack ?? e}`);
      this.respondError(id, LSP_ERRORS.internalError, `Internal error: ${(e as Error).message}`);
    }
  }

  /** Why a request can't be served in the current state, if it can't. */
  private refusal(method: string): LspError | undefined {
    if (this.state === 'starting' && method !== 'initialize') return new LspError(LSP_ERRORS.serverNotInitialized, 'The server is not initialized yet.');
    if (this.state !== 'starting' && method === 'initialize') return new LspError(LSP_ERRORS.invalidRequest, 'The server is already initialized.');
    if (this.state === 'shuttingDown') return new LspError(LSP_ERRORS.invalidRequest, 'The server is shutting down.');
    return undefined;
  }

  private answer(method: string, params: unknown): unknown {
    if (method === 'shutdown') {
      this.state = 'shuttingDown';
      return null;
    }
    const handler = this.options.requests[method];
    if (!handler) throw new LspError(LSP_ERRORS.methodNotFound, `Method not found: ${method}`);
    const result = handler(params);
    if (method === 'initialize') this.state = 'running';
    return result;
  }

  private respondError(id: Id, code: number, message: string): void {
    this.options.send({ jsonrpc: '2.0', id, error: { code, message } });
  }
}

/**
 * Feeds framed messages from `input` to `endpoint` (which writes its answers through its `send`).
 * Resolves when the input ends.
 */
export function serveStream(endpoint: LspEndpoint, input: NodeJS.ReadableStream, log: (message: string) => void): Promise<void> {
  const reader = new MessageReader((body) => endpoint.receiveBody(body), log);
  return new Promise((resolve) => {
    input.on('data', (chunk: Buffer | string) => reader.push(chunk));
    input.on('end', () => resolve());
  });
}

function asIncoming(message: unknown): Incoming | 'response' | undefined {
  if (!isObject(message) || message.jsonrpc !== '2.0') return undefined;
  if (typeof message.method !== 'string') return 'id' in message && ('result' in message || 'error' in message) ? 'response' : undefined;
  const id = message.id;
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') return undefined;
  return { id, method: message.method, params: message.params };
}

function idOf(message: unknown): Id {
  const id = isObject(message) ? message.id : undefined;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
