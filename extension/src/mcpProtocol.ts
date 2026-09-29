/**
 * A small Model Context Protocol server: JSON-RPC 2.0 messages, one per line, with tools only.
 * No dependencies, so it bundles into the single-file CLI.
 *
 *   initialize                 negotiates the protocol version, returns serverInfo and capabilities.tools
 *   ping                       {}
 *   tools/list                 every tool with its JSON Schema
 *   tools/call                 runs a tool; failures come back as results with isError: true
 *   notifications/*            accepted, never answered
 *
 * Tool arguments are checked against the tool's inputSchema (the subset used here: object properties of
 * type string, boolean or array of strings, `required` and `additionalProperties: false`).
 */

/** Protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const JSONRPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export interface JsonSchemaProperty {
  type: 'string' | 'boolean' | 'array';
  description?: string;
  items?: { type: 'string' };
  minItems?: number;
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: Record<string, unknown>;
  /** Returns the result text. Throw a ToolError for a failure the caller should see. */
  run(args: Record<string, unknown>): string | Promise<string>;
}

/** A failure to report to the client as a tool result with isError: true. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: McpTool[];
  /** Shown to the client after initialize. */
  instructions?: string;
  /** Where to report unexpected errors (default: stderr via console.error). */
  log?: (message: string) => void;
}

type Id = string | number | null;
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Request { id?: Id; method: string; params?: unknown }

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export class McpServer {
  private readonly tools: Map<string, McpTool>;
  private readonly log: (message: string) => void;

  constructor(private readonly options: McpServerOptions) {
    this.tools = new Map(options.tools.map((t) => [t.name, t]));
    this.log = options.log ?? ((m) => console.error(m));
  }

  /** Answers one parsed message (or a batch). Returns undefined for notifications. */
  async handle(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (!Array.isArray(message)) return this.handleOne(message);
    if (!message.length) return errorResponse(null, JSONRPC_ERRORS.invalidRequest, 'Empty batch.');
    const answers = await Promise.all(message.map((m) => this.handleOne(m)));
    const replies = answers.filter((a): a is JsonRpcResponse => a !== undefined);
    return replies.length ? replies : undefined;
  }

  /** Answers one line of input: parses it, then handles the message. */
  async handleLine(line: string): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return errorResponse(null, JSONRPC_ERRORS.parseError, 'Parse error: not valid JSON.');
    }
    return this.handle(message);
  }

  private async handleOne(message: unknown): Promise<JsonRpcResponse | undefined> {
    const request = asRequest(message);
    if (!request) return errorResponse(idOf(message), JSONRPC_ERRORS.invalidRequest, 'Invalid request: expected a JSON-RPC 2.0 message with a method.');
    const isNotification = request.id === undefined;
    try {
      const result = await this.dispatch(request.method, request.params);
      return isNotification ? undefined : { jsonrpc: '2.0', id: request.id as Id, result };
    } catch (e) {
      if (isNotification) return undefined;
      if (e instanceof RpcError) return errorResponse(request.id as Id, e.code, e.message);
      this.log(`[smd mcp] ${request.method} failed: ${(e as Error).stack ?? e}`);
      return errorResponse(request.id as Id, JSONRPC_ERRORS.internalError, `Internal error: ${(e as Error).message}`);
    }
  }

  private dispatch(method: string, params: unknown): unknown {
    switch (method) {
      case 'initialize':
        return this.initialize(params);
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: [...this.tools.values()].map(describeTool) };
      case 'tools/call':
        return this.call(params);
      default:
        if (method.startsWith('notifications/')) return {};
        throw new RpcError(JSONRPC_ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  private initialize(params: unknown) {
    const requested = isObject(params) ? params.protocolVersion : undefined;
    const protocolVersion = typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
    const { name, version, instructions } = this.options;
    return { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name, version }, ...(instructions ? { instructions } : {}) };
  }

  private async call(params: unknown): Promise<ToolResult> {
    if (!isObject(params) || typeof params.name !== 'string') throw new RpcError(JSONRPC_ERRORS.invalidParams, 'tools/call needs a tool "name".');
    const tool = this.tools.get(params.name);
    if (!tool) throw new RpcError(JSONRPC_ERRORS.invalidParams, `Unknown tool: ${params.name}. Available: ${[...this.tools.keys()].join(', ')}`);
    const args = params.arguments ?? {};
    const problem = isObject(args) ? checkArguments(tool.inputSchema, args) : 'arguments must be an object.';
    if (problem) return errorResult(`Invalid arguments for ${tool.name}: ${problem}`);
    try {
      return { content: [{ type: 'text', text: await tool.run(args as Record<string, unknown>) }] };
    } catch (e) {
      if (!(e instanceof ToolError)) this.log(`[smd mcp] ${tool.name} failed: ${(e as Error).stack ?? e}`);
      return errorResult((e as Error).message);
    }
  }
}

/** The first problem with `args` against `schema`, or undefined when they fit. */
export function checkArguments(schema: ToolInputSchema, args: Record<string, unknown>): string | undefined {
  const missing = (schema.required ?? []).find((key) => args[key] === undefined);
  if (missing) return `"${missing}" is required.`;
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property) {
      if (schema.additionalProperties === false) return `unknown argument "${key}". Expected: ${Object.keys(schema.properties).join(', ')}.`;
      continue;
    }
    const problem = checkValue(property, value);
    if (problem) return `"${key}" ${problem}`;
  }
  return undefined;
}

function checkValue(property: JsonSchemaProperty, value: unknown): string | undefined {
  if (property.type !== 'array') return typeof value === property.type ? undefined : `must be a ${property.type}.`;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return 'must be an array of strings.';
  if (property.minItems && value.length < property.minItems) return `needs at least ${property.minItems} item(s).`;
  return undefined;
}

/**
 * Serves `server` over newline-delimited JSON: reads messages from `input`, writes each response as one
 * line to `write`. Resolves when the input ends and every pending request has been answered.
 */
export function serveLines(server: McpServer, input: NodeJS.ReadableStream, write: (line: string) => void): Promise<void> {
  const pending = new Set<Promise<void>>();
  let buffer = '';
  const answer = (line: string) => {
    const done = server.handleLine(line).then((response) => {
      if (response) write(JSON.stringify(response) + '\n');
    });
    pending.add(done);
    void done.finally(() => pending.delete(done));
  };
  const flush = (all: boolean) => {
    const lines = buffer.split('\n');
    buffer = all ? '' : lines.pop() ?? '';
    for (const line of lines) if (line.trim()) answer(line.trim());
  };
  return new Promise((resolve) => {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      flush(false);
    });
    input.on('end', () => {
      flush(true);
      void Promise.all(pending).then(() => resolve());
    });
  });
}

function describeTool(tool: McpTool) {
  const { name, title, description, inputSchema, annotations } = tool;
  return { name, ...(title ? { title } : {}), description, inputSchema, ...(annotations ? { annotations } : {}) };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function errorResponse(id: Id, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function asRequest(message: unknown): Request | undefined {
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return undefined;
  const id = message.id;
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') return undefined;
  return { id, method: message.method, params: message.params };
}

function idOf(message: unknown): Id {
  const id = isObject(message) ? message.id : undefined;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
