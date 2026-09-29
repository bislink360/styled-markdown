import { parseFrontMatter } from './frontmatter';
import { MERMAID_TYPES } from './spec';
import { applyRuleSettings, applySuppressions, type RuleSettings } from './rules';
import type { Diagnostic } from './validate';

/**
 * Parses one Mermaid diagram and rejects on a syntax error, e.g. `(src) => mermaid.parse(src)`.
 * Mermaid is large, so the core never imports it: callers pass a parser in.
 */
export type MermaidParse = (source: string) => Promise<unknown>;

export interface MermaidBlock {
  /** Zero-based line of the first line inside the fence. */
  line: number;
  source: string;
}

/**
 * ```mermaid blocks whose diagram type is known. Empty blocks and unknown types are left out,
 * since `validateSmd` already reports them as `mermaid/empty` and `mermaid/type`.
 */
export function mermaidBlocks(text: string): MermaidBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: MermaidBlock[] = [];
  let fence: { char: string; len: number; mermaid: boolean; line: number; content: string[] } | null = null;
  for (let i = parseFrontMatter(text).bodyStartLine; i < lines.length; i++) {
    const raw = lines[i];
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence.char === '`' ? '`' : '~'}{${fence.len},}\\s*$`);
      if (!close.test(raw)) { fence.content.push(raw); continue; }
      if (fence.mermaid && hasKnownType(fence.content)) blocks.push({ line: fence.line + 1, source: fence.content.join('\n') });
      fence = null;
      continue;
    }
    const open = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(raw);
    if (open) fence = { char: open[1][0], len: open[1].length, mermaid: open[2].toLowerCase() === 'mermaid', line: i, content: [] };
  }
  return blocks;
}

/** The first line that is not config front matter, a comment or blank names the diagram type. */
function hasKnownType(content: string[]): boolean {
  let inConfig = false;
  for (const l of content) {
    const t = l.trim();
    if (t === '---') { inConfig = !inConfig; continue; }
    if (inConfig || !t || t.startsWith('%%')) continue;
    return MERMAID_TYPES.includes(t.split(/[\s;:]/)[0]);
  }
  return false;
}

/**
 * Parse every Mermaid block and report syntax errors as `mermaid/syntax` (one per diagram).
 * Suppression comments and `rules` apply as in `validateSmd`; unknown codes in comments are
 * reported by `validateSmd`, not here.
 */
export async function checkMermaid(text: string, parse: MermaidParse, rules?: RuleSettings): Promise<Diagnostic[]> {
  const lines = text.split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];
  for (const block of mermaidBlocks(text)) {
    try {
      await parse(block.source);
    } catch (e) {
      diagnostics.push(toDiagnostic(e, block, lines));
    }
  }
  const kept = applySuppressions(text, diagnostics, false);
  return rules ? applyRuleSettings(kept, rules) : kept;
}

interface ErrorPosition { line: number; column?: number; endColumn?: number; message: string }

/** Convert a Mermaid parse error into a diagnostic on the document line it points at. */
function toDiagnostic(error: unknown, block: MermaidBlock, lines: string[]): Diagnostic {
  const blockLines = block.source.split('\n');
  const pos = errorPosition(error) ?? { line: 1, message: firstLine(error) };
  // Positions are 1-based within the diagram; an error at the end points past its last line.
  let offset = Math.min(Math.max(pos.line - 1, 0), blockLines.length - 1);
  while (offset > 0 && !blockLines[offset].trim()) offset--;
  const line = block.line + offset;
  const text = lines[line] ?? '';
  const indent = text.length - text.trimStart().length;
  let column = pos.column !== undefined && pos.column < text.length ? pos.column : indent;
  let endColumn = pos.endColumn !== undefined && pos.endColumn > column && pos.endColumn <= text.length ? pos.endColumn : text.length;
  if (endColumn <= column) { column = indent; endColumn = Math.max(text.length, indent + 1); }
  return { line, column, endColumn, severity: 'error', code: 'mermaid/syntax', message: `Mermaid syntax error: ${pos.message}` };
}

function errorPosition(error: unknown): ErrorPosition | undefined {
  const e = error as {
    hash?: { loc?: { first_line: number; last_line: number; first_column: number; last_column: number }; token?: unknown; expected?: string[] };
    result?: {
      lexerErrors?: Array<{ line?: number; column?: number; length?: number; message: string }>;
      parserErrors?: Array<{ message: string; token: { startLine?: number; startColumn?: number; endColumn?: number } }>;
    };
  };
  // Jison grammars (flowchart, sequence, class, state, gantt, er…)
  if (e?.hash?.loc) {
    const { loc, token, expected } = e.hash;
    const got = tokenName(token);
    const wanted = (expected ?? []).map((t) => tokenName(t.replace(/^'|'$/g, '')));
    const list = wanted.length > 4 ? `${wanted.slice(0, 4).join(', ')}…` : wanted.join(' or ');
    const message = wanted.length ? `expected ${list}, got ${got}.` : `unexpected ${got}.`;
    return loc.first_line === loc.last_line
      ? { line: loc.first_line, column: loc.first_column, endColumn: loc.last_column, message }
      : { line: loc.last_line, message };
  }
  // Langium grammars (pie, packet, architecture, gitGraph, radar…): positions are 1-based.
  if (e?.result) {
    const errors: Array<{ line: number; column: number; endColumn: number; message: string }> = [];
    for (const l of e.result.lexerErrors ?? []) {
      if (l.line && l.column) errors.push({ line: l.line, column: l.column - 1, endColumn: l.column - 1 + (l.length ?? 1), message: 'unexpected character.' });
    }
    for (const p of e.result.parserErrors ?? []) {
      const t = p.token;
      if (t.startLine && t.startColumn) errors.push({ line: t.startLine, column: t.startColumn - 1, endColumn: t.endColumn ?? t.startColumn, message: p.message.split('\n')[0].replace(/\.?$/, '.') });
    }
    errors.sort((a, b) => a.line - b.line || a.column - b.column);
    return errors[0];
  }
  return undefined;
}

function tokenName(token: unknown): string {
  if (token === 1 || token === 'EOF') return 'end of diagram';
  if (token === 'NEWLINE' || token === 'NL') return 'end of line';
  return typeof token === 'string' ? token : String(token);
}

function firstLine(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  return message.replace(/^Parsing failed:\s*/, '').split('\n')[0].trim() || 'could not parse the diagram.';
}
