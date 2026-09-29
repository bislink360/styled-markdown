import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Seeded generators of .smd input for fuzz tests and benchmarks. Everything is deterministic for a
 * given seed, so a failure can be reproduced from the seed and case number it prints.
 */

export type Random = () => number;

/** A small, fast, seeded PRNG (mulberry32). */
export function prng(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: Random, list: readonly T[]): T => list[Math.floor(random() * list.length)];
const int = (random: Random, max: number) => Math.floor(random() * max);

const repo = path.join(__dirname, '..', '..', '..');

/** The example documents, as seeds for mutation and as realistic benchmark content. */
export function exampleDocuments(): string[] {
  const dir = path.join(repo, 'examples');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.smd')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
}

/** Lines that exercise every construct, including broken ones and hostile attribute values. */
const LINES = [
  '', '', '', '# Title', '## Section', '### Sub {#custom .cls agent=skip}', 'Setext', '---', '===', '***',
  'Plain paragraph text with **bold**, *italic*, ~~strike~~ and ==mark==.',
  ':::note', ':::warning{collapsible} Heads up', ':::', '::::', '::::tabs', ':::tab One', ':::tab', '::::columns', ':::column{width=50%}',
  ':::decision{status=accepted date=2026-01-01 owner=@a} Decide', ':::risk{impact=high likelihood=low} Risk',
  ':::api{method=POST path="/v1/x" auth=token} Endpoint', ':::agent Rules', ':::human Why', ':::details More', ':::card{accent=teal} Card',
  ':::warnign', ':::api', ':::note{unclosed', ':::box{bg=indigo align=center}',
  '```', '```ts', '```mermaid', 'flowchart LR', '  A --> B', 'flowchat TD', '~~~', '````', '```ts file="src/pricing.ts" lines="1-3" {2}',
  '```ts file="../../outside.txt"', '```math', '$$', 'x^2 + \\frac{1}{2}', '\\frac{', '$$E = mc^2$$', 'Inline $a+b$ math.',
  '- item', '  - nested', '1. first', '10) tenth', '- [ ] task @owner :due[2026-01-01] :priority[P1]', '- [x] done', '* [X] done',
  '> quote', '> > nested quote', '>', '    indented code', '\tTabbed',
  '| a | b |', '| - | :-: |', '| `x|y` | z |', '|', '| only |',
  '[link](other.smd#anchor) [ref][label] [label][] ![img](a.png)', '[label]: https://example.com "Title"', '[dangling]:',
  '<div id="raw">', '</div>', '<!-- comment', '-->', '<pre>', '</pre>', '<a name="n">x</a>',
  ':badge[Shipped]{color=green} :status[OK]{color=red} :kbd[Ctrl+K] :mention[@x] :progress{value=65} :metric[42%]{label="A" delta="+1" trend=up}',
  ':badg[typo] :progress{value=500} :due[not-a-date] :priority[P9]',
  '[span]{color=red weight=bold} [x]{color=blu} [y]{style=strike size=xl} [z]{#id .a .b}',
  // Hostile attribute values: they must never reach the output as CSS or markup.
  '[a]{color="red;background:url(x)"} [b]{bg=\'"><b>x</b>\'} [c]{style="x;position:fixed"}',
  ':::note{title="<i>t</i>"}', ':::box{color="#fff;}body{display:none"}', '[e]{border="1px solid red; top:0"}',
  ':status[s]{color="rgb(1,2,3);x:y"} :badge[b]{color="var(--x)"} :progress{value="1;x" color="red;y"}',
  '[j](javascript:void(0)) <a href="#">raw link</a>',
  '{', '}', '{{', '[[', ']]', ']{', ':', '::', ':::::::::::', '\\', '`', '``', '*', '_', '|', '#', '#######', '$', '@',
];

const NOISE = ['\u0000', '​', '﻿', '\r', '\t', ' ', '😀', '漢字', 'é', '\\', '`', '"', "'", '<', '>', '&', '{', '}', '[', ']', '(', ')', ':', '#', '|', '$', '*'];

/** Front matter, valid or not. */
const FRONT = [
  '---\nsmd: 1\ntitle: Fuzz [t]{#title-id}\nsummary: A *summary*\nstatus: review\nowners: ["@a"]\ntags: [x]\nupdated: 2020-01-01\n---\n',
  '---\nsmd: 2\nstatus: nope\naccent: "url(x)"\ntoc: yes\n---\n',
  '---\ntitle: [unclosed\n---\n', '---\nno end\n', '---\n---\n', '',
];

/** A random document made of construct lines, occasionally with noise characters. */
export function randomDocument(random: Random, maxLines = 80): string {
  const lines: string[] = [];
  const count = 1 + int(random, maxLines);
  for (let i = 0; i < count; i++) {
    let line = pick(random, LINES);
    if (random() < 0.15) {
      const at = int(random, line.length + 1);
      line = line.slice(0, at) + pick(random, NOISE) + line.slice(at);
    }
    if (random() < 0.05) line = line.repeat(1 + int(random, 30)); // long lines
    lines.push(line);
  }
  return pick(random, FRONT) + lines.join(random() < 0.1 ? '\r\n' : '\n');
}

/** A real document, mutated: lines deleted, duplicated, swapped, cut or spliced with construct lines. */
export function mutatedDocument(random: Random, base: string): string {
  const lines = base.split('\n');
  const edits = 1 + int(random, 12);
  for (let e = 0; e < edits && lines.length; e++) {
    const at = int(random, lines.length);
    switch (int(random, 6)) {
      case 0: lines.splice(at, 1); break;
      case 1: lines.splice(at, 0, lines[int(random, lines.length)]); break;
      case 2: lines.splice(at, 0, pick(random, LINES)); break;
      case 3: lines[at] = lines[at].slice(0, int(random, lines[at].length + 1)); break;
      case 4: { const j = int(random, lines.length); [lines[at], lines[j]] = [lines[j], lines[at]]; break; }
      default: lines[at] += pick(random, NOISE);
    }
  }
  return lines.join('\n');
}

/** A generated fuzz case: random construct soup or a mutated example. */
export function fuzzCase(random: Random, examples: readonly string[]): string {
  return random() < 0.5 ? randomDocument(random) : mutatedDocument(random, pick(random, examples));
}

/**
 * A realistic document of about `lines` lines for benchmarks: example bodies under numbered
 * sections, the same for every run.
 */
export function largeDocument(lines: number): string {
  const bodies = exampleDocuments().map((d) => d.replace(/^---[\s\S]*?\n---\n/, ''));
  const parts = ['---\nsmd: 1\ntitle: Benchmark\n---\n'];
  let count = 4;
  for (let i = 0; count < lines; i++) {
    const body = `\n## Part ${i}\n\n${bodies[i % bodies.length]}`;
    parts.push(body);
    count += body.split('\n').length - 1;
  }
  return parts.join('');
}
