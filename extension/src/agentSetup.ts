// `smd init --agent …`: the MCP server config each agent reads from the project. Pure string functions (the CLI does
// the file I/O), so they can be tested without touching the disk.
import { SHARED_CLI_PATH, type AgentTarget } from './agentTargets';

/** Name of the server entry written into each config. */
export const MCP_SERVER_NAME = 'styled-markdown';

/** Where the Claude skills put the CLI, relative to the project root. */
export const CLAUDE_SKILL_CLI = '.claude/skills/styled-markdown-reader/scripts/smd.cjs';

export interface McpConfigSpec {
  /** Path relative to the project root, with forward slashes. */
  file: string;
  /** The top-level key that holds the servers. */
  key: 'mcpServers' | 'servers';
  entry: Record<string, unknown>;
}

/**
 * The MCP config for an agent, or undefined when it has no project-level config file (`agents`: AGENTS.md is read by
 * many tools, each with its own MCP setup). Claude Code starts project servers in the project root; Cursor and VS Code
 * expand `${workspaceFolder}`.
 */
export function mcpConfigFor(target: AgentTarget): McpConfigSpec | undefined {
  switch (target) {
    case 'claude':
      return { file: '.mcp.json', key: 'mcpServers', entry: { command: 'node', args: [CLAUDE_SKILL_CLI, 'mcp'] } };
    case 'cursor':
      return {
        file: '.cursor/mcp.json', key: 'mcpServers',
        entry: { command: 'node', args: [`\${workspaceFolder}/${SHARED_CLI_PATH}`, 'mcp', '--root', '${workspaceFolder}'] },
      };
    case 'copilot':
      return {
        file: '.vscode/mcp.json', key: 'servers',
        entry: { type: 'stdio', command: 'node', args: [`\${workspaceFolder}/${SHARED_CLI_PATH}`, 'mcp', '--root', '${workspaceFolder}'] },
      };
    default:
      return undefined;
  }
}

export class McpConfigError extends Error {}

/**
 * The config file with our server added or replaced; other servers and keys are kept. Throws an McpConfigError when
 * the existing file isn't a JSON object (for example JSON with comments), so it is never overwritten.
 */
export function mergeMcpConfig(existing: string | undefined, spec: McpConfigSpec): string {
  let config: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      config = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      throw new McpConfigError(`${spec.file} isn't plain JSON (comments?), so it was left alone. Add this to its "${spec.key}":\n${snippet(spec)}`);
    }
    if (!isObject(config) || (config[spec.key] !== undefined && !isObject(config[spec.key]))) {
      throw new McpConfigError(`${spec.file} has an unexpected shape, so it was left alone. Add this to its "${spec.key}":\n${snippet(spec)}`);
    }
  }
  const servers = { ...(config[spec.key] as Record<string, unknown> | undefined), [MCP_SERVER_NAME]: spec.entry };
  const indent = existing?.match(/\n([ \t]+)"/)?.[1] ?? '  ';
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify({ ...config, [spec.key]: servers }, null, indent).split('\n').join(eol) + eol;
}

function snippet(spec: McpConfigSpec): string {
  return JSON.stringify({ [MCP_SERVER_NAME]: spec.entry }, null, 2);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
