import type { Heading } from './render';

/**
 * Token budgets for the agent view (`smd agent --max-tokens N`).
 *
 * A view over the budget is shrunk in two steps: first condensed as with --brief, then whole
 * sections are omitted, each replaced by a one-line pointer that says how to read it:
 *
 *   [section omitted: ## Rollout plan, L120-L160, ≈420 tokens — smd agent plan.smd --section "Rollout plan"]
 *
 * Never omitted: the header (title, front matter facts, summary), text before the first
 * subsection, level-1 sections as a whole, sections that contain `:::agent` instructions, and
 * sections requested with `sections` (and their subsections).
 *
 * Order: sections without key content go first; sections with a danger or warning callout, an
 * accepted decision, a question or an open task are kept longer. Within each group the deepest
 * headings go first, then the largest, then the latest in the document. A parent section is only
 * omitted after its subsections, and its pointer then replaces theirs.
 */

/** Counts the tokens of a text: an exact tokenizer, or `estimateTokens`. */
export interface Tokenizer {
  /** Shown next to counts, e.g. `o200k_base`. */
  name: string;
  count: (text: string) => number;
}

export interface OmittedSection {
  /** Heading text. */
  heading: string;
  level: number;
  /** Zero-based first and last line of the section, including its subsections. */
  line: number;
  endLine: number;
  /** Tokens the section would have cost in the view. */
  tokens: number;
}

export interface BudgetResult {
  maxTokens: number;
  /** Size of the returned view, counted with the tokenizer when one is given (else estimated). */
  tokens: number;
  /** False when even the smallest view (everything that is never omitted) is over the budget. */
  fits: boolean;
  /** Diagrams, long code, :::details and completed tasks were condensed as with `brief`. */
  condensed: boolean;
  /** Omitted sections, in document order. */
  omitted: OmittedSection[];
}

export interface BudgetSection { heading: Heading; start: number; end: number }

const AGENT_BLOCK = /^\s*:{3,}\s*agent(?![\w-])/;
const KEY_CONTENT = [
  /^\s*:{3,}\s*(?:danger|warning|question)(?![\w-])/,
  /^\s*:{3,}\s*decision\b.*\bstatus\s*=\s*["']?accepted\b/,
  /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s/,
];

const within = (inner: BudgetSection, outer: BudgetSection) => inner.start >= outer.start && inner.end <= outer.end;
const overlaps = (a: BudgetSection, b: BudgetSection) => a.start <= b.end && b.start <= a.end;

/** Sections that may be omitted: not level 1, not skipped, no agent instructions, not requested. */
export function omittableSections(sections: BudgetSection[], lines: string[], requested: BudgetSection[] | null): BudgetSection[] {
  return sections.filter((s) =>
    s.heading.level > 1
    && s.heading.agent !== 'skip'
    && !requested?.some((r) => overlaps(s, r))
    && !lines.slice(s.start, s.end + 1).some((l) => AGENT_BLOCK.test(l)));
}

/** 1 when the section has content worth keeping longer (see the module comment), else 0. */
function keepTier(s: BudgetSection, lines: string[]): number {
  return lines.slice(s.start, s.end + 1).some((l) => KEY_CONTENT.some((re) => re.test(l))) ? 1 : 0;
}

/** Omission order: least important first (see the module comment). */
export function omissionOrder(candidates: BudgetSection[], lines: string[], cost: (s: BudgetSection) => number): BudgetSection[] {
  const ranked = candidates.map((s) => ({ s, tier: keepTier(s, lines), tokens: cost(s) }));
  ranked.sort((a, b) => a.tier - b.tier
    || b.s.heading.level - a.s.heading.level
    || b.tokens - a.tokens
    || b.s.start - a.s.start);
  return ranked.map((r) => r.s);
}

/** Add a section to the omitted set, replacing any of its omitted subsections. Keeps document order. */
export function withOmitted(omitted: BudgetSection[], section: BudgetSection): BudgetSection[] {
  return [...omitted.filter((o) => !within(o, section)), section].sort((a, b) => a.start - b.start);
}

/** `[section omitted: ## Rollout plan, L120-L160, ≈420 tokens — smd agent plan.smd --section "Rollout plan"]` */
export function omissionPointer(s: BudgetSection, tokens: number, file = '<file>'): string {
  const heading = `${'#'.repeat(s.heading.level)} ${s.heading.text}`;
  const query = s.heading.text.includes('"') ? s.heading.slug : s.heading.text;
  const read = `smd agent ${quoteArg(file)} --section "${query}"`;
  return `[section omitted: ${heading}, L${s.start + 1}-L${s.end + 1}, ≈${tokens} tokens — ${read}]`;
}

function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}
