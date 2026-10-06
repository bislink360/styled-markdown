import { FIGURE_KINDS } from './spec';

/**
 * Numbered figures: `:::figure{#id kind=table} Caption` blocks and the `:ref[id]` references to them.
 * Figures are numbered in document order with one counter per kind (Figure 1, Table 1, Listing 1), the
 * same way in the rendered HTML, the agent view and the plain-Markdown export.
 */

/** A figure's kind and number. */
export interface FigureNumber {
  /** `figure`, `table` or `listing`. */
  kind: string;
  /** 1-based, counted per kind. */
  number: number;
  /** What a reference shows: `Figure 2`, `Table 1`. */
  label: string;
}

/** A `:::figure` of a document. */
export interface Figure extends FigureNumber {
  /** The `{#id}` that `:ref[id]` refers to; undefined when the figure has none. */
  id?: string;
  /** Zero-based line of the `:::figure` opening fence. */
  line: number;
}

const LABELS = new Map([['figure', 'Figure'], ['table', 'Table'], ['listing', 'Listing']]);

/** The kind a `kind=` value names; a missing or unknown value is a plain figure. */
export function figureKind(value: string | undefined): string {
  const kind = value?.trim().toLowerCase() ?? '';
  return FIGURE_KINDS.includes(kind) ? kind : 'figure';
}

/** Counts figures in document order. Call `next` for each figure as it appears. */
export class FigureCounter {
  private readonly counts = new Map<string, number>();

  next(kindValue: string | undefined): FigureNumber {
    const kind = figureKind(kindValue);
    const number = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, number);
    return { kind, number, label: `${LABELS.get(kind)} ${number}` };
  }
}

/** Figures by id, for resolving references. When two figures share an id, the first one wins. */
export function figureTargets<T extends { id?: string }>(figures: Iterable<T>): Map<string, T> {
  const targets = new Map<string, T>();
  for (const f of figures) {
    if (f.id && !targets.has(f.id)) targets.set(f.id, f);
  }
  return targets;
}

/** A `:ref[id]` in the source. Positions are zero-based; the columns span the whole directive. */
export interface FigureRef {
  id: string;
  line: number;
  column: number;
  endColumn: number;
}

/** `:ref[id]`, where a directive may start (see inlineDirective): line start, space or opening punctuation. */
export const REF_DIRECTIVE = /(^|[\s([{>*_~"'-]):ref\[([^\]\n]*)\]/g;

/** Every `:ref[id]` outside code fences and inline code, from `from` (the first body line) on. */
export function findRefs(lines: string[], from = 0): FigureRef[] {
  const refs: FigureRef[] = [];
  let fence: string | null = null;
  for (let i = from; i < lines.length; i++) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      if (mark && closesFence(lines[i], mark[1], fence)) fence = null;
      continue;
    }
    if (mark) { fence = mark[1]; continue; }
    refs.push(...refsOnLine(lines[i], i));
  }
  return refs;
}

function closesFence(line: string, mark: string, fence: string): boolean {
  return mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark;
}

function refsOnLine(raw: string, line: number): FigureRef[] {
  // Blank out inline code so its contents are never treated as syntax.
  const text = raw.replace(/(`+)([\s\S]*?)\1/g, (m) => ' '.repeat(m.length));
  return [...text.matchAll(REF_DIRECTIVE)].map((m) => {
    const column = m.index + m[1].length;
    return { id: m[2].trim(), line, column, endColumn: m.index + m[0].length };
  });
}
