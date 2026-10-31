import { segmentSmd, type Segment } from './blocks';
import { isFrontMatterRefusal, readFrontMatterBlock } from './frontMatterEdit';
import { parseSmdTokens } from './render';
import { specVersion } from './specVersion';

/**
 * A three-way merge of `.smd` text that knows its blocks, for `smd merge` (a Git merge driver). It is meant for the
 * merges Git's own line merge leaves conflicted, and it never does more than it must:
 *
 * 1. A line merge, as Git's: changes that overlap or touch (neighbouring lines) are one conflicting region.
 * 2. Each conflicting region grows to whole units in all three versions: front matter keys, list items, table rows,
 *    a container's opening line, children and closing line, other blocks, and the lines between them.
 * 3. Those units are merged as units: a unit only one side changed comes from that side, line for line; the same
 *    change on both sides is taken once. Changed front matter keys merge key by key, and an `updated:` date both
 *    sides changed takes the later date. Where both sides changed one unit differently, its lines are merged as
 *    Git merges lines, so a conflict stays inside that unit.
 *
 * Lines nobody changed are copied from the ancestor, nothing is reformatted, and line breaks (LF, CRLF or mixed)
 * are kept as written. When anything is in doubt (the versions are read with different spec versions, they differ
 * too much, or the merged text would not read as the same blocks) it returns a doubt and the caller keeps Git's
 * own result. Browser-safe and pure: Git itself is run by the CLI. Not part of the npm API.
 */

export interface BlockMergeOptions {
  /** The length of conflict markers (Git's %L), default 7. */
  markerSize?: number;
  /** Write the ancestor's lines in conflicts too (Git's merge.conflictStyle diff3). */
  diff3?: boolean;
  /** Conflict marker labels; default ours, base and theirs. */
  labels?: { ours?: string; base?: string; theirs?: string };
}

export interface BlockMergeResult {
  text: string;
  /** Conflicts left in `text`, each inside one unit. */
  conflicts: number;
}

/** Why the merge was not attempted; the caller keeps Git's result. */
export interface BlockMergeDoubt {
  doubt: string;
}

export const isMergeDoubt = (r: BlockMergeResult | BlockMergeDoubt): r is BlockMergeDoubt => 'doubt' in r;

// ---------------------------------------------------------------------------
// Lines and a line diff
// ---------------------------------------------------------------------------

/** The lines of a text, each with its line break (`\n` or `\r\n`); a last line without one stays as it is. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** a[a0, a1) became b[b0, b1). */
interface Hunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** The largest middle (after the common start and end) the diff compares cell by cell. */
const MAX_CELLS = 4_000_000;

/** The changes from `a` to `b`, from a longest common subsequence; null when they differ too much to compare. */
function diffHunks(a: readonly string[], b: readonly string[]): Hunk[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (!n && !m) return [];
  if (!n || !m) return [{ a0: pre, a1: pre + n, b0: pre, b1: pre + m }];
  if (n * m > MAX_CELLS) return null;
  const ids = new Map<string, number>();
  const id = (s: string) => ids.get(s) ?? ids.set(s, ids.size).get(s)!;
  const x = a.slice(pre, pre + n).map(id);
  const y = b.slice(pre, pre + m).map(id);
  return lcsHunks(x, y).map((h) => ({ a0: h.a0 + pre, a1: h.a1 + pre, b0: h.b0 + pre, b1: h.b1 + pre }));
}

/** Hunks between x and y from a table of longest common suffix lengths. */
function lcsHunks(x: readonly number[], y: readonly number[]): Hunk[] {
  const n = x.length;
  const m = y.length;
  const w = m + 1;
  const len = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * w + j] = x[i] === y[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | undefined;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      open = undefined;
      i++;
      j++;
      continue;
    }
    if (!open) {
      open = { a0: i, a1: i, b0: j, b1: j };
      hunks.push(open);
    }
    if (j >= m || (i < n && len[(i + 1) * w + j] >= len[i * w + j + 1])) open.a1 = ++i;
    else open.b1 = ++j;
  }
  return hunks;
}

// ---------------------------------------------------------------------------
// Three-way merge of sequences
// ---------------------------------------------------------------------------

type RegionKind = 'stable' | 'ours' | 'theirs' | 'same' | 'conflict';

/** Aligned ranges of the three versions: base [b0, b1), ours [o0, o1), theirs [t0, t1). */
interface Span {
  b0: number;
  b1: number;
  o0: number;
  o1: number;
  t0: number;
  t1: number;
}

interface Region extends Span {
  kind: RegionKind;
}

interface SideHunk extends Hunk {
  ours: boolean;
}

/**
 * Whether two changes from different sides conflict. Line merges (`touching`) conflict as Git's do: when they
 * overlap or touch. Unit merges conflict only when they overlap, or insert at the same place.
 */
function clash(p: Hunk, q: Hunk, touching: boolean): boolean {
  if (touching) return p.a0 <= q.a1 && q.a0 <= p.a1;
  if (p.a0 === p.a1 && q.a0 === q.a1) return p.a0 === q.a0;
  return p.a0 < q.a1 && q.a0 < p.a1;
}

/** Changes of both sides, in the order of the base, grouped where they conflict (directly or through others). */
function groupHunks(ours: readonly Hunk[], theirs: readonly Hunk[], touching: boolean): SideHunk[][] {
  const all = [...ours.map((h) => ({ ...h, ours: true })), ...theirs.map((h) => ({ ...h, ours: false }))];
  all.sort((p, q) => p.a0 - q.a0 || p.a1 - q.a1);
  const groups: SideHunk[][] = [];
  for (const h of all) {
    const group = groups.at(-1);
    if (group?.some((g) => g.ours !== h.ours && clash(g, h, touching))) group.push(h);
    else groups.push([h]);
  }
  return groups;
}

const sameLines = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

/** A change of n units into n others, as n changes of one unit each, so neighbouring units stay apart. */
function oneByOne(hunks: readonly Hunk[]): Hunk[] {
  return hunks.flatMap((h) => {
    const n = h.a1 - h.a0;
    if (n < 2 || n !== h.b1 - h.b0) return [h];
    return Array.from({ length: n }, (_, k) => ({ a0: h.a0 + k, a1: h.a0 + k + 1, b0: h.b0 + k, b1: h.b0 + k + 1 }));
  });
}

/**
 * The regions of a three-way merge of sequences, covering all three in order; null when a diff is too large. A unit
 * merge (not `touching`) pairs the units of a change one by one when it has as many units as it replaces.
 */
function merge3(base: readonly string[], ours: readonly string[], theirs: readonly string[], touching: boolean): Region[] | null {
  const pair = (h: Hunk[] | null) => (h && !touching ? oneByOne(h) : h);
  const ho = pair(diffHunks(base, ours));
  const ht = pair(diffHunks(base, theirs));
  if (!ho || !ht) return null;
  const regions: Region[] = [];
  let at = 0;
  let dO = 0;
  let dT = 0;
  const stable = (b0: number, b1: number) => {
    if (b1 > b0) regions.push({ kind: 'stable', b0, b1, o0: b0 + dO, o1: b1 + dO, t0: b0 + dT, t1: b1 + dT });
  };
  for (const group of groupHunks(ho, ht, touching)) {
    const b0 = Math.min(...group.map((h) => h.a0));
    const b1 = Math.max(...group.map((h) => h.a1));
    stable(at, b0);
    const growth = (side: boolean) => group.filter((h) => h.ours === side).reduce((s, h) => s + (h.b1 - h.b0) - (h.a1 - h.a0), 0);
    const gO = growth(true);
    const gT = growth(false);
    const r: Region = { kind: 'conflict', b0, b1, o0: b0 + dO, o1: b1 + dO + gO, t0: b0 + dT, t1: b1 + dT + gT };
    r.kind = regionKind(group, ours.slice(r.o0, r.o1), theirs.slice(r.t0, r.t1));
    regions.push(r);
    dO += gO;
    dT += gT;
    at = b1;
  }
  stable(at, base.length);
  return regions;
}

function regionKind(group: readonly SideHunk[], ours: readonly string[], theirs: readonly string[]): RegionKind {
  const o = group.some((h) => h.ours);
  const t = group.some((h) => !h.ours);
  if (o && t) return sameLines(ours, theirs) ? 'same' : 'conflict';
  return o ? 'ours' : 'theirs';
}

// ---------------------------------------------------------------------------
// Units: where a version's blocks, items, rows and front matter keys start
// ---------------------------------------------------------------------------

interface Units {
  /** Lines where a unit starts, with 0 and the line count. */
  starts: Set<number>;
  /** Front matter keys by the line their entry starts on. */
  keys: Map<number, string>;
  /** Whether the front matter can't be read key by key. */
  frontMatterRefused: boolean;
}

const BLANK = /^[ \t\r]*$/;
const INDENTED = /^[ \t]/;

function unitsOf(text: string, count: number): Units {
  const plain = text.split(/\r?\n/);
  const units: Units = { starts: new Set([0, count]), keys: new Map(), frontMatterRefused: false };
  addSegments(segmentSmd(text), plain, units);
  addItemsAndRows(text, units.starts);
  for (const s of units.starts) if (s > count) units.starts.delete(s);
  return units;
}

function addSegments(segments: readonly Segment[], plain: readonly string[], units: Units): void {
  for (const seg of segments) {
    units.starts.add(seg.start);
    units.starts.add(seg.end);
    if (seg.kind === 'frontmatter') addFrontMatter(plain.slice(0, seg.end), units);
    else if (seg.kind === 'gap') addGapLines(seg, plain, units.starts);
    if (seg.children) {
      units.starts.add(seg.bodyStart!);
      units.starts.add(seg.bodyEnd!);
      addSegments(seg.children, plain, units);
    }
  }
}

/** Front matter read key by key: each key with its value's lines, and each other line, is a unit. */
function addFrontMatter(lines: readonly string[], units: Units): void {
  const block = readFrontMatterBlock(lines);
  if (isFrontMatterRefusal(block)) {
    units.frontMatterRefused = true;
    return;
  }
  const inside = new Set<number>();
  for (const e of block.entries) {
    units.keys.set(e.line, e.key);
    for (let i = e.line + 1; i < e.end; i++) inside.add(i);
  }
  for (let i = 0; i < lines.length; i++) if (!inside.has(i)) units.starts.add(i);
}

/** Lines between blocks: blank lines, and definitions (with their indented continuation lines). */
function addGapLines(seg: Segment, plain: readonly string[], starts: Set<number>): void {
  for (let i = seg.start; i < seg.end; i++) {
    if (BLANK.test(plain[i] ?? '') || !INDENTED.test(plain[i] ?? '') || BLANK.test(plain[i - 1] ?? '')) starts.add(i);
  }
}

/** List items (at every level) and table rows, from the parse. */
function addItemsAndRows(text: string, starts: Set<number>): void {
  const parsed = parseSmdTokens(text);
  const offset = parsed.env.lineOffset;
  for (const t of parsed.tokens) {
    if (!t.map) continue;
    if (t.type === 'list_item_open') starts.add(t.map[0] + offset);
    if (t.type === 'tr_open') {
      starts.add(t.map[0] + offset);
      starts.add(t.map[1] + offset);
    }
  }
}

interface Unit {
  lines: string[];
  text: string;
  key?: string;
}

/** Lines [from, to) cut into units. */
function cutUnits(lines: readonly string[], from: number, to: number, units: Units): Unit[] {
  const out: Unit[] = [];
  let start = from;
  for (let i = from + 1; i <= to; i++) {
    if (i < to && !units.starts.has(i)) continue;
    const part = lines.slice(start, i);
    out.push({ lines: part, text: part.join(''), key: units.keys.get(start) });
    start = i;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Growing conflicting regions to whole units
// ---------------------------------------------------------------------------

interface Group {
  /** The regions wholly inside the span. */
  first: number;
  last: number;
  /** May take part of a stable region at either end. */
  span: Span;
}

/** How far `x` is past the unit start before it. */
function back(starts: ReadonlySet<number>, x: number): number {
  let i = x;
  while (i > 0 && !starts.has(i)) i--;
  return x - i;
}

/** How far `x` is before the next unit start (or the end, `count`). */
function ahead(starts: ReadonlySet<number>, x: number, count: number): number {
  let i = x;
  while (i < count && !starts.has(i)) i++;
  return i - x;
}

type Three<T> = readonly [T, T, T];

/** Grow a group backwards until it starts on a unit in all three versions; true when it ran into `prev` and took it in. */
function growBack(g: Group, regions: readonly Region[], units: Three<Units>, prev: Group | undefined): boolean {
  for (;;) {
    const need = Math.max(back(units[0].starts, g.span.b0), back(units[1].starts, g.span.o0), back(units[2].starts, g.span.t0));
    if (need === 0) return false;
    const r = regions[g.first - 1];
    const floor = prev && g.first - 1 === prev.last + 1 ? Math.max(r.b0, prev.span.b1) : r.b0;
    if (r.kind === 'stable' && need < g.span.b0 - floor) {
      g.span.b0 -= need;
      g.span.o0 -= need;
      g.span.t0 -= need;
    } else if (prev && (floor > r.b0 || g.first - 1 <= prev.last)) {
      g.first = prev.first;
      g.span = { ...g.span, b0: prev.span.b0, o0: prev.span.o0, t0: prev.span.t0 };
      return true;
    } else {
      g.first--;
      g.span = { ...g.span, b0: r.b0, o0: r.o0, t0: r.t0 };
    }
  }
}

/** Grow a group forwards until it ends on a unit in all three versions. */
function growAhead(g: Group, regions: readonly Region[], units: Three<Units>, counts: Three<number>): void {
  for (;;) {
    const need = Math.max(
      ahead(units[0].starts, g.span.b1, counts[0]), ahead(units[1].starts, g.span.o1, counts[1]), ahead(units[2].starts, g.span.t1, counts[2]),
    );
    if (need === 0) return;
    const r = regions[g.last + 1];
    if (r.kind === 'stable' && need < r.b1 - g.span.b1) {
      g.span.b1 += need;
      g.span.o1 += need;
      g.span.t1 += need;
    } else {
      g.last++;
      g.span = { ...g.span, b1: r.b1, o1: r.o1, t1: r.t1 };
    }
  }
}

/** The conflicting regions, each grown to whole units, and merged where they meet. */
function unitGroups(regions: readonly Region[], units: Three<Units>, counts: Three<number>): Group[] {
  const groups: Group[] = [];
  for (let i = 0; i < regions.length; i++) {
    if (regions[i].kind !== 'conflict') continue;
    const g: Group = { first: i, last: i, span: { ...regions[i] } };
    if (growBack(g, regions, units, groups.at(-1))) groups.pop();
    growAhead(g, regions, units, counts);
    groups.push(g);
    i = g.last;
  }
  return groups;
}

// ---------------------------------------------------------------------------
// The merged text, as pieces
// ---------------------------------------------------------------------------

/** Merged lines, or a conflict between the sides' lines. `seam`: the piece starts a unit taken by the block merge. */
interface Piece {
  ours: readonly string[];
  theirs: readonly string[];
  base?: readonly string[];
  conflict?: boolean;
  seam?: boolean;
}

const taken = (lines: readonly string[], seam = false): Piece => ({ ours: lines, theirs: lines, seam });

interface Versions {
  base: readonly string[];
  ours: readonly string[];
  theirs: readonly string[];
}

/** A region of a line merge as a piece (a conflict keeps the lines both sides share at its ends outside it, unless diff3). */
function regionPieces(r: Region, v: Versions, diff3: boolean): Piece[] {
  const o = v.ours.slice(r.o0, r.o1);
  const t = v.theirs.slice(r.t0, r.t1);
  if (r.kind === 'stable') return [taken(v.base.slice(r.b0, r.b1))];
  if (r.kind === 'theirs') return [taken(t)];
  if (r.kind !== 'conflict') return [taken(o)];
  const b = v.base.slice(r.b0, r.b1);
  if (diff3) return [{ ours: o, theirs: t, base: b, conflict: true }];
  let head = 0;
  while (head < o.length && head < t.length && o[head] === t[head]) head++;
  let tail = 0;
  while (tail < o.length - head && tail < t.length - head && o[o.length - 1 - tail] === t[t.length - 1 - tail]) tail++;
  return [
    taken(o.slice(0, head)),
    { ours: o.slice(head, o.length - tail), theirs: t.slice(head, t.length - tail), base: b, conflict: true },
    taken(o.slice(o.length - tail)),
  ];
}

/** Git-style line merge of a few lines: what a unit both sides changed differently becomes. */
function lineMerge(v: Versions, diff3: boolean): Piece[] {
  const regions = merge3(v.base, v.ours, v.theirs, true);
  if (!regions) return [{ ours: v.ours, theirs: v.theirs, base: v.base, conflict: true }];
  return regions.flatMap((r) => regionPieces(r, v, diff3));
}

const DATE_LINE = /^updated[ \t]*:[ \t]*(["']?)(\d{4}-\d{2}-\d{2})\1[ \t]*(?:#.*)?\r?\n?$/;

/** Both sides' lines of a front matter key: the same, one side's change, or the later of two `updated:` dates. */
function keyLines(b: Unit | undefined, o: Unit | undefined, t: Unit | undefined): Piece {
  const lines = (u: Unit | undefined) => u?.lines ?? [];
  if (o?.text === t?.text) return taken(lines(o), true);
  if (o?.text === b?.text) return taken(lines(t), true);
  if (t?.text === b?.text) return taken(lines(o), true);
  const dateO = o && DATE_LINE.exec(o.text)?.[2];
  const dateT = t && DATE_LINE.exec(t.text)?.[2];
  if (dateO && dateT && dateO !== dateT) return taken(lines(dateO > dateT ? o : t), true);
  return { ours: lines(o), theirs: lines(t), base: lines(b), conflict: true, seam: true };
}

/**
 * Front matter units both sides changed, merged key by key, in ours' order and then the keys only theirs has. Null
 * unless every unit is one key, and each key is in these units or not in the front matter at all.
 */
function keyMerge(units: Three<readonly Unit[]>, all: Three<Units>): Piece[] | null {
  if (!units.every((list) => list.every((u) => u.key))) return null;
  const order = [...new Set(units[1].concat(units[2], units[0]).map((u) => u.key!))];
  for (let v = 0; v < 3; v++) {
    const here = new Set(units[v].map((u) => u.key));
    if ([...all[v].keys.values()].some((k) => order.includes(k) && !here.has(k))) return null;
  }
  const find = (list: readonly Unit[], key: string) => list.find((u) => u.key === key);
  return order.map((key) => keyLines(find(units[0], key), find(units[1], key), find(units[2], key)));
}

/** A group's lines merged unit by unit. */
function groupPieces(g: Group, v: Versions, all: Three<Units>, diff3: boolean): Piece[] {
  const { span } = g;
  const units: Three<Unit[]> = [
    cutUnits(v.base, span.b0, span.b1, all[0]), cutUnits(v.ours, span.o0, span.o1, all[1]), cutUnits(v.theirs, span.t0, span.t1, all[2]),
  ];
  const regions = merge3(units[0].map((u) => u.text), units[1].map((u) => u.text), units[2].map((u) => u.text), false);
  const lines = (parts: Three<readonly Unit[]>): Versions => ({
    base: parts[0].flatMap((u) => u.lines), ours: parts[1].flatMap((u) => u.lines), theirs: parts[2].flatMap((u) => u.lines),
  });
  if (!regions) return lineMerge(lines(units), diff3);
  return regions.flatMap((r) => {
    const parts: Three<Unit[]> = [units[0].slice(r.b0, r.b1), units[1].slice(r.o0, r.o1), units[2].slice(r.t0, r.t1)];
    const merged = lines(parts);
    if (r.kind === 'conflict') return keyMerge(parts, all) ?? markFirst(lineMerge(merged, diff3));
    const pick: Record<Exclude<RegionKind, 'conflict'>, readonly string[]> = {
      stable: merged.base, ours: merged.ours, theirs: merged.theirs, same: merged.ours,
    };
    return [taken(pick[r.kind], true)];
  });
}

function markFirst(pieces: Piece[]): Piece[] {
  if (pieces.length) pieces[0] = { ...pieces[0], seam: true };
  return pieces;
}

/** The whole merge as pieces: line merge regions outside the groups, unit merges inside them. */
function allPieces(regions: readonly Region[], groups: readonly Group[], v: Versions, all: Three<Units>, diff3: boolean): Piece[] {
  const pieces: Piece[] = [];
  let pos = 0;
  let next = 0;
  for (let i = 0; i < regions.length; i++) {
    const g = groups[next];
    if (g && i === g.first) {
      pieces.push(...markFirst(groupPieces(g, v, all, diff3)), { ours: [], theirs: [], seam: true });
      pos = g.span.b1;
      i = g.last;
      next++;
      continue;
    }
    const r = regions[i];
    if (r.kind !== 'stable') {
      pieces.push(...regionPieces(r, v, diff3));
      continue;
    }
    const from = Math.max(r.b0, pos);
    const to = g ? Math.min(r.b1, Math.max(r.b0, g.span.b0)) : r.b1;
    pieces.push(taken(v.base.slice(from, to)));
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Checks and output
// ---------------------------------------------------------------------------

/** One side's text (every conflict resolved its way) and where the block merge's seams fall in it. */
function projection(pieces: readonly Piece[], side: 'ours' | 'theirs'): { text: string; count: number; seams: number[] } {
  let count = 0;
  let text = '';
  const seams: number[] = [];
  for (const p of pieces) {
    if (p.seam) seams.push(count);
    count += p[side].length;
    text += p[side].join('');
  }
  return { text, count, seams };
}

/** Why the merged text would not read as the blocks that were merged, if it wouldn't. */
function mergedDoubt(pieces: readonly Piece[], inputs: Three<Units>): string | undefined {
  if (!pieces.some((p) => p.seam)) return undefined;
  for (const side of ['ours', 'theirs'] as const) {
    const merged = projection(pieces, side);
    const units = unitsOf(merged.text, merged.count);
    if (merged.seams.some((s) => !units.starts.has(s))) return 'the merged blocks would not read as the same blocks';
    if (units.frontMatterRefused && !inputs.some((u) => u.frontMatterRefused)) return 'the merged front matter would not read key by key';
  }
  return undefined;
}

/** The line break most lines of a text end with. */
function lineBreak(text: string): string {
  const crlf = text.split('\r\n').length - 1;
  return crlf > text.split('\n').length - 1 - crlf ? '\r\n' : '\n';
}

function render(pieces: readonly Piece[], options: BlockMergeOptions, eol: string): BlockMergeResult {
  const size = options.markerSize ?? 7;
  const label = { ours: 'ours', base: 'base', theirs: 'theirs', ...options.labels };
  const side = (lines: readonly string[] = []) => {
    const t = lines.join('');
    return t === '' || t.endsWith('\n') ? t : t + eol;
  };
  let text = '';
  let conflicts = 0;
  for (const p of pieces) {
    if (!p.conflict) {
      text += p.ours.join('');
      continue;
    }
    conflicts++;
    text += `${'<'.repeat(size)} ${label.ours}${eol}${side(p.ours)}`;
    if (options.diff3) text += `${'|'.repeat(size)} ${label.base}${eol}${side(p.base)}`;
    text += `${'='.repeat(size)}${eol}${side(p.theirs)}${'>'.repeat(size)} ${label.theirs}${eol}`;
  }
  return { text, conflicts };
}

/**
 * Merge three versions of a `.smd` document (the ancestor and two sides) by blocks, as described at the top of this
 * file. Meant for when Git's line merge conflicts: when it merges cleanly, keep Git's result.
 */
export function blockMerge(base: string, ours: string, theirs: string, options: BlockMergeOptions = {}): BlockMergeResult | BlockMergeDoubt {
  try {
    return mergeBlocks(base, ours, theirs, options);
  } catch (e) {
    return { doubt: `the merge failed (${e instanceof Error ? e.message : String(e)})` };
  }
}

function mergeBlocks(base: string, ours: string, theirs: string, options: BlockMergeOptions): BlockMergeResult | BlockMergeDoubt {
  const texts = [base, ours, theirs] as const;
  if (new Set(texts.map((t) => specVersion(t))).size > 1) return { doubt: 'the versions are read with different spec versions' };
  const v: Versions = { base: splitLines(base), ours: splitLines(ours), theirs: splitLines(theirs) };
  const regions = merge3(v.base, v.ours, v.theirs, true);
  if (!regions) return { doubt: 'the versions differ too much to compare line by line' };
  const counts: Three<number> = [v.base.length, v.ours.length, v.theirs.length];
  const units: Three<Units> = [unitsOf(base, counts[0]), unitsOf(ours, counts[1]), unitsOf(theirs, counts[2])];
  const diff3 = options.diff3 ?? false;
  const pieces = allPieces(regions, unitGroups(regions, units, counts), v, units, diff3);
  const doubt = mergedDoubt(pieces, units);
  if (doubt) return { doubt };
  return render(pieces, options, lineBreak(ours));
}
