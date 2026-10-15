import { formatSmd } from './format';

/**
 * Block templates for the block editor's toolbar, made from the extension's snippets (snippets/smd.json): each
 * placeholder becomes its default (the first choice of a `${1|a,b|}`, today's date for `$CURRENT_YEAR`…), the text
 * is in canonical form (formatSmd gives it back unchanged), and the first placeholder's span is kept so the editor
 * can select it after inserting. The snippets are passed in, so this module stays free of file access; the host
 * imports the JSON. Browser-safe; not part of the npm API.
 */

/** One entry of a VS Code snippets file. */
export interface Snippet {
  prefix?: string | string[];
  description?: string;
  body: string | string[];
}

export interface BlockTemplate {
  /** The snippet's name, such as "Callout". */
  name: string;
  description?: string;
  /** Canonical .smd ending with one line break. */
  text: string;
  /** The first placeholder's default in `text` (empty when it has none), to select after inserting. */
  select: { from: number; to: number };
}

/** Lines that start a block: snippets that don't (badges, spans, references) are inline and not templates. */
const BLOCK_START = /^(?::{3,}[a-zA-Z]|`{3,}|~{3,}|\$\$|#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/;
/** `${1:default}`, `${1|a,b|}`, `${1}`, `$1` and `$VARIABLE`. */
const PLACEHOLDER = /\$\{(\d+)(?::([^}]*)|\|([^|]*)\|)?\}|\$(\d+)|\$([A-Z][A-Z_]*)/g;
const VARIABLE = /\$([A-Z][A-Z_]*)/g;
const LF = '\n';

/** A tab stop's first appearance: its number, offset and default. */
interface Stop {
  n: number;
  at: number;
  value: string;
}

interface Expanded {
  text: string;
  stops: Stop[];
}

/** Snippet variables (only the date ones appear in smd.json); others are empty. */
function variable(name: string, today: string): string {
  const [year, month, day] = today.split('-');
  const values: Record<string, string | undefined> = { CURRENT_YEAR: year, CURRENT_MONTH: month, CURRENT_DATE: day };
  return values[name] ?? '';
}

/** A snippet body with every placeholder replaced by its default. */
function expand(body: string, today: string): Expanded {
  const values = new Map<number, string>();
  const stops: Stop[] = [];
  let text = '';
  let last = 0;
  for (const m of body.matchAll(PLACEHOLDER)) {
    const [whole, n, fallback, choices, mirror, name] = m;
    text += body.slice(last, m.index);
    last = m.index + whole.length;
    if (name) {
      text += variable(name, today);
      continue;
    }
    const stop = Number(n ?? mirror);
    const value = mirror ? values.get(stop) ?? '' : defaultOf(fallback, choices, today);
    if (!values.has(stop)) {
      values.set(stop, value);
      stops.push({ n: stop, at: text.length, value });
    }
    text += value;
  }
  return { text: text + body.slice(last), stops };
}

function defaultOf(fallback: string | undefined, choices: string | undefined, today: string): string {
  if (choices !== undefined) return choices.split(',')[0];
  return (fallback ?? '').replaceAll(VARIABLE, (_, name: string) => variable(name, today));
}

/** The first tab stop: the lowest positive number, else `$0`. */
function firstStop(stops: readonly Stop[]): Stop | undefined {
  const positive = stops.filter((s) => s.n > 0).sort((a, b) => a.n - b.n);
  return positive[0] ?? stops.find((s) => s.n === 0);
}

const isBlank = (line: string) => line.trim() === '';

/** The index of the `count`-th non-whitespace character's end in `line` (0 for none). */
function afterNonSpace(line: string, count: number): number {
  let seen = 0;
  for (let i = 0; i < line.length; i++) {
    if (seen === count) return i;
    if (!/\s/.test(line[i])) seen++;
  }
  return line.length;
}

/**
 * Where a span of the unformatted text is in the formatted one. Formatting only changes blank lines, spaces and
 * table rules, so a non-blank line keeps its place among the non-blank lines and its text keeps its order.
 */
function relocate(raw: string, formatted: string, at: number, value: string): number {
  const head = raw.slice(0, at).split(LF);
  const column = head.at(-1)!.length;
  const lineIndex = head.length - 1;
  const rawLine = raw.split(LF)[lineIndex];
  const before = head.slice(0, -1).filter((l) => !isBlank(l)).length;
  const lines = formatted.split(LF);
  const nonBlank = lines.flatMap((l, i) => (isBlank(l) ? [] : [i]));
  const offsetOf = (line: number) => lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0);
  if (isBlank(rawLine)) return offsetOf(before > 0 ? nonBlank[before - 1] + 1 : 0);
  const target = nonBlank[before];
  const nonSpaceBefore = [...rawLine.slice(0, column)].filter((c) => !/\s/.test(c)).length;
  const from = afterNonSpace(lines[target], nonSpaceBefore);
  const found = value ? lines[target].indexOf(value, from) : -1;
  return offsetOf(target) + (found < 0 ? from : found);
}

/** A snippet as a block template, or null for an inline snippet or one that isn't a block on its own. */
export function blockTemplate(name: string, snippet: Snippet, today: string = new Date().toISOString().slice(0, 10)): BlockTemplate | null {
  const body = Array.isArray(snippet.body) ? snippet.body.join(LF) : snippet.body;
  const { text: expanded, stops } = expand(body, today);
  const lines = expanded.split(LF);
  while (lines.length && isBlank(lines.at(-1)!)) lines.pop();
  if (!lines.length || !BLOCK_START.test(lines[0])) return null;
  const raw = `${lines.join(LF)}${LF}`;
  const text = formatSmd(raw);
  const stop = firstStop(stops);
  const at = Math.min(stop?.at ?? 0, raw.length - 1);
  const value = stop && stop.at + stop.value.length <= raw.length ? stop.value : '';
  const from = text === raw ? at : relocate(raw, text, at, value);
  const template: BlockTemplate = { name, text, select: { from, to: from + value.length } };
  if (snippet.description) template.description = snippet.description;
  return template;
}

/** The block templates among the snippets of a snippets file, in its order. */
export function blockTemplates(snippets: Readonly<Record<string, Snippet>>, today?: string): BlockTemplate[] {
  return Object.entries(snippets).flatMap(([name, snippet]) => blockTemplate(name, snippet, today) ?? []);
}
