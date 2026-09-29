import { agentView, agentViewRanges, estimateTokens } from './agentView';
import { asStringList, parseFrontMatter } from './frontmatter';
import { parseSmd } from './parse';
import type { Heading } from './render';

/**
 * Section-level diff of two versions of a document, for agents catching up on a changed doc.
 *
 * Sections are matched by heading id (the n-th "Notes" with the n-th "Notes"), then left-over
 * sections by content, so a renamed heading is still the same section. Each section is compared by
 * its own content (up to the next heading of any level) in the agent view, so a change is reported
 * in the smallest section that contains it, and changes an agent can't see (styling, :::human
 * content, comments) don't count. Content before the first heading is a section of its own.
 */
export interface DiffOptions {
  /** Condense diagrams, long code, details blocks and completed tasks in each section (as `smd agent --brief`). */
  brief?: boolean;
  /** Append [L12] line references (into the new version) to headings, and line ranges to labels (default true). */
  lineRefs?: boolean;
  /** YYYY-MM-DD used for overdue tasks; defaults to the current date. */
  today?: string;
}

export interface FrontMatterChange {
  key: string;
  /** Absent when the key was added. */
  before?: unknown;
  /** Absent when the key was removed. */
  after?: unknown;
}

export interface SectionChange {
  /** `renamed`: only the heading text changed. */
  change: 'added' | 'removed' | 'changed' | 'renamed';
  /** Heading text; null for the content before the first heading. */
  heading: string | null;
  /** Heading level; 0 for the content before the first heading. */
  level: number;
  /** Heading id (slug); null for the content before the first heading. */
  id: string | null;
  /** Zero-based lines of the section's own content in the new version (up to the next heading). Absent when removed. */
  line?: number;
  endLine?: number;
  /** Zero-based lines in the old version. Absent when added. */
  oldLine?: number;
  oldEndLine?: number;
  /** The old heading text, when the heading was renamed. */
  oldHeading?: string;
  /** The section is marked {agent=skip} (or is inside such a section): its content is left out. */
  skipped?: boolean;
  /** The new version of the section in the agent view (not for removed or skipped sections). */
  text?: string;
}

export interface DiffResult {
  frontMatter: FrontMatterChange[];
  /** In the order of the new version; removed sections last. */
  sections: SectionChange[];
  /** The changes as text for an agent (empty when nothing changed). */
  text: string;
  /** Approximate tokens of `text` and of the new version's full agent view. */
  tokens: number;
  fullTokens: number;
}

interface Section {
  heading: Heading | null;
  /** Matching key: heading id plus occurrence, or '' for the content before the first heading. */
  key: string;
  start: number;
  end: number;
  /** The section's own content in the agent view, without line references. */
  view: string;
  skipped: boolean;
}

export function diffSmd(oldText: string, newText: string, options: DiffOptions = {}): DiffResult {
  const viewOptions = { brief: options.brief, today: options.today, lineRefs: false };
  const before = sectionsOf(oldText, agentViewRanges(oldText, viewOptions));
  const after = sectionsOf(newText, agentViewRanges(newText, viewOptions));
  const pairs = matchSections(before, after);
  const shown = agentViewRanges(newText, { ...viewOptions, lineRefs: options.lineRefs ?? true });
  const sections = [
    ...after.map((s) => compare(pairs.get(s), s, shown)).filter((c): c is SectionChange => c !== null),
    ...before.filter((s) => ![...pairs.values()].includes(s)).map((s) => ({ ...describe(s), change: 'removed' as const, ...oldRange(s) })),
  ];
  const frontMatter = frontMatterChanges(parseFrontMatter(oldText).data, parseFrontMatter(newText).data);
  const text = diffText(frontMatter, sections, options.lineRefs ?? true);
  return { frontMatter, sections, text, tokens: estimateTokens(text), fullTokens: agentView(newText, { brief: options.brief, today: options.today }).tokens };
}

/** Sections by own content: the content before the first heading, then each heading up to the next one. */
function sectionsOf(text: string, view: (start: number, end: number) => string): Section[] {
  const lineCount = text.split(/\r?\n/).length;
  const headings = parseSmd(text).headings;
  const skippedRanges = skippedRangesOf(headings, lineCount);
  const seen = new Map<string, number>();
  const sections: Section[] = [];
  const bodyStart = parseFrontMatter(text).bodyStartLine;
  const firstHeading = headings[0]?.line ?? lineCount;
  const preamble = view(bodyStart, firstHeading - 1);
  if (preamble) sections.push({ heading: null, key: '', start: bodyStart, end: firstHeading - 1, view: preamble, skipped: false });
  headings.forEach((h, i) => {
    const n = seen.get(h.slug) ?? 0;
    seen.set(h.slug, n + 1);
    const end = (headings[i + 1]?.line ?? lineCount) - 1;
    const skipped = skippedRanges.some(([s, e]) => h.line >= s && h.line <= e);
    sections.push({ heading: h, key: `${h.slug}#${n}`, start: h.line, end, view: view(h.line, end), skipped });
  });
  return sections;
}

/** Line ranges of sections marked {agent=skip}, subsections included. */
function skippedRangesOf(headings: Heading[], lineCount: number): Array<[number, number]> {
  return headings.flatMap((h, i) => {
    if (h.agent !== 'skip') return [];
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    return [[h.line, (next?.line ?? lineCount) - 1] as [number, number]];
  });
}

/** New section → the old section it is a version of: by heading id first, then by similar content. */
function matchSections(before: Section[], after: Section[]): Map<Section, Section> {
  const pairs = new Map<Section, Section>();
  const byKey = new Map(before.map((s) => [s.key, s]));
  for (const s of after) {
    const old = byKey.get(s.key);
    if (old) pairs.set(s, old);
  }
  const unmatched = () => before.filter((s) => ![...pairs.values()].includes(s));
  after.forEach((s, index) => {
    if (pairs.has(s) || !s.heading) return;
    const old = renamedFrom(s, index, unmatched(), before);
    if (old) pairs.set(s, old);
  });
  return pairs;
}

/** The unmatched old heading at the same level whose content is most like this one's (at least half the same lines). */
function renamedFrom(section: Section, index: number, candidates: Section[], before: Section[]): Section | undefined {
  let best: Section | undefined;
  let bestScore = 0;
  for (const old of candidates) {
    if (!old.heading || old.heading.level !== section.heading?.level) continue;
    const distance = Math.abs(before.indexOf(old) - index);
    const score = similarity(bodyOf(old.view), bodyOf(section.view)) - distance / 1000;
    if (score > bestScore) {
      best = old;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : undefined;
}

/** A view without blank lines or trailing spaces, so only changes to the content count. */
function contentOf(view: string): string {
  return view.split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n');
}

/** A section's view without its heading line. */
function bodyOf(view: string): string[] {
  return view.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
}

/** Shared lines over all distinct lines (1 when both are empty). */
function similarity(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const all = new Set([...left, ...right]);
  if (!all.size) return 1;
  return [...left].filter((l) => right.has(l)).length / all.size;
}

function compare(old: Section | undefined, section: Section, shown: (start: number, end: number) => string): SectionChange | null {
  if (old && contentOf(old.view) === contentOf(section.view)) return null;
  const change = changeKind(old, section);
  const result: SectionChange = { ...describe(section), change, line: section.start, endLine: section.end };
  if (old) Object.assign(result, oldRange(old));
  if (old?.heading && section.heading && old.heading.text !== section.heading.text) result.oldHeading = old.heading.text;
  if (section.skipped) result.skipped = true;
  else result.text = change === 'renamed' ? shown(section.start, section.start) : shown(section.start, section.end);
  return result;
}

function changeKind(old: Section | undefined, section: Section): SectionChange['change'] {
  if (!old) return 'added';
  const sameBody = bodyOf(old.view).join('\n') === bodyOf(section.view).join('\n');
  return sameBody && old.heading?.text !== section.heading?.text ? 'renamed' : 'changed';
}

function describe(s: Section): Pick<SectionChange, 'heading' | 'level' | 'id'> {
  return { heading: s.heading?.text ?? null, level: s.heading?.level ?? 0, id: s.heading?.slug ?? null };
}

function oldRange(s: Section): Pick<SectionChange, 'oldLine' | 'oldEndLine'> {
  return { oldLine: s.start, oldEndLine: s.end };
}

function frontMatterChanges(before: Record<string, unknown>, after: Record<string, unknown>): FrontMatterChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((key) => ({ key, ...(key in before ? { before: before[key] } : {}), ...(key in after ? { after: after[key] } : {}) }));
}

// ---------------------------------------------------------------------------
// Text output
// ---------------------------------------------------------------------------

function diffText(frontMatter: FrontMatterChange[], sections: SectionChange[], lineRefs: boolean): string {
  const blocks: string[] = [];
  if (frontMatter.length) blocks.push(['Front matter:', ...frontMatter.map((c) => `  ${c.key}: ${valueText(c.before)} → ${valueText(c.after)}`)].join('\n'));
  for (const s of sections) blocks.push([label(s, lineRefs), s.text].filter(Boolean).join('\n'));
  return blocks.length ? blocks.join('\n\n') + '\n' : '';
}

function valueText(value: unknown): string {
  if (value === undefined) return '(none)';
  if (Array.isArray(value)) return asStringList(value).join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** `[changed L40-52]`, `[renamed from "Goals" L12-20]`, `[removed: ## Old plan, was L30-38]` */
function label(s: SectionChange, lineRefs: boolean): string {
  const parts: string[] = [s.change];
  if (s.change === 'removed') parts[0] = `removed: ${headingText(s)},`;
  else if (s.oldHeading !== undefined) parts.push(`from "${s.oldHeading}"`);
  if (lineRefs) parts.push(rangeText(s));
  if (s.change !== 'removed' && !s.heading) parts.push('(before the first heading)');
  if (s.skipped) parts.push(`${headingText(s)} (skipped for agents)`);
  return `[${parts.join(' ').replace(/,$/, '')}]`;
}

function headingText(s: SectionChange): string {
  return s.heading === null ? 'content before the first heading' : `${'#'.repeat(s.level)} ${s.heading}`;
}

function rangeText(s: SectionChange): string {
  if (s.change === 'removed') return `was L${(s.oldLine ?? 0) + 1}-${(s.oldEndLine ?? 0) + 1}`;
  return `L${(s.line ?? 0) + 1}-${(s.endLine ?? 0) + 1}`;
}
