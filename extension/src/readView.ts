import { agentView, outline, type AgentViewOptions } from './core';

/**
 * `smd read` and the MCP `read` tool: one call that gives an agent what it should read first. A document whose agent
 * view fits the budget comes back whole; a longer one comes back as its outline (sections with line ranges and token
 * costs), so the agent asks for the sections it needs next.
 */

/** Tokens below which the whole agent view is returned (the reader skill's "≲ 2,000 tokens: read it once"). */
export const READ_BUDGET = 2000;

export const READ_MODES = ['auto', 'outline', 'full'] as const;
export type ReadMode = (typeof READ_MODES)[number];

export interface ReadOptions extends Pick<AgentViewOptions, 'readFile' | 'today' | 'tokenizer' | 'file' | 'lineRefs'> {
  /** auto (default): whole view within the budget, else the outline. */
  mode?: ReadMode;
  /** Budget for `auto`, in tokens (default {@link READ_BUDGET}). */
  maxTokens?: number;
  brief?: boolean;
  /** Only these sections (heading text or id); overrides the mode. */
  sections?: string[];
}

export interface ReadResult {
  /** What was returned. */
  shown: 'full' | 'outline' | 'sections';
  text: string;
  /** Estimated tokens of the whole agent view, and of the file. */
  fullTokens: number;
  fileTokens: number;
  missingSections: string[];
}

export function readDocument(text: string, options: ReadOptions = {}): ReadResult {
  const { mode = 'auto', maxTokens = READ_BUDGET, brief, sections, ...view } = options;
  if (sections?.length) {
    const result = agentView(text, { ...view, brief, sections });
    return { shown: 'sections', text: result.text, fullTokens: result.tokens, fileTokens: result.originalTokens, missingSections: result.missingSections };
  }
  const full = agentView(text, { ...view, brief });
  const sizes = { fullTokens: full.tokens, fileTokens: full.originalTokens, missingSections: [] };
  if (mode === 'full' || (mode === 'auto' && full.tokens <= maxTokens)) return { shown: 'full', text: full.text, ...sizes };
  const why = mode === 'auto' ? `The agent view (≈${full.tokens} tokens) is over the ${maxTokens}-token budget, so this is the outline. ` : '';
  const next = `${why}Read only the sections you need next.\n`;
  return { shown: 'outline', text: `${outline(text, view).trimEnd()}\n\n${next}`, ...sizes };
}
