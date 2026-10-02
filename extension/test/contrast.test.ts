import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Colour contrast of the stylesheet (WCAG 2.2 AA) in both themes: 4.5:1 for text, 3:1 for focus rings and other
// graphical objects. Colours come from the CSS custom properties, so a palette change that breaks contrast fails here.

const css = readFileSync(join(__dirname, '..', 'media', 'smd.css'), 'utf8');

/** The declarations of the first rule with exactly this selector. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `smd.css has a "${selector}" rule`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

function customProperties(body: string): Map<string, string> {
  return new Map([...body.matchAll(/(--smd-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const light = customProperties(block(':root'));
const dark = new Map([...light, ...customProperties(block(':root[data-smd-theme="dark"]'))]);
const print = customProperties(block(':root, :root[data-smd-theme="dark"]'));
const THEMES: Array<[string, Map<string, string>]> = [['light', light], ['dark', dark]];

type Rgba = [number, number, number, number];

/** A colour value: `#rrggbb`, `var(--…)` or `color-mix(in srgb, <colour> <n>%, <colour> | transparent)`. */
function color(value: string, theme: Map<string, string>): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba;
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return color(theme.get(ref[1]) ?? assert.fail(`${ref[1]} is defined`), theme);
  const mix = mixArgs(v);
  if (!mix) return assert.fail(`unsupported colour ${v}`);
  const [first, percent, second] = mix;
  const amount = Number.parseFloat(percent.startsWith('var(') ? theme.get(percent.slice(4, -1)) ?? '' : percent) / 100;
  const a = color(first, theme);
  if (second === 'transparent') return [a[0], a[1], a[2], a[3] * amount];
  const b = color(second, theme);
  return [0, 1, 2].map((i) => a[i] * amount + b[i] * (1 - amount)).concat(1) as Rgba;
}

/** `color-mix(in srgb, <a> <amount>, <b>)` as [a, amount, b]; null for anything else. */
function mixArgs(value: string): [string, string, string] | null {
  if (!value.startsWith('color-mix(in srgb,') || !value.endsWith(')')) return null;
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  const inner = value.slice('color-mix('.length, -1);
  [...inner].forEach((ch, i) => {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  });
  args.push(inner.slice(start).trim());
  const space = args[1]?.lastIndexOf(' ') ?? -1;
  return args.length === 3 && space > 0 ? [args[1].slice(0, space), args[1].slice(space + 1), args[2]] : null;
}

/** Layers painted bottom to top; the first must be opaque. */
function paint(layers: string[], theme: Map<string, string>): Rgba {
  return layers.map((l) => color(l, theme)).reduce((under, [r, g, b, a]) =>
    [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a), 1]);
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

interface Pair { what: string; fg: string; bg: string[]; min: number }

const TEXT = 4.5;
const GRAPHIC = 3;
const v = (name: string) => `var(--smd-${name})`;
const tint = (name: string, percent: number | string) =>
  `color-mix(in srgb, ${v(name)} ${typeof percent === 'number' ? `${percent}%` : percent}, transparent)`;
const soft = (name: string) => tint(name, v('soft'));
/** Text on a tint of its own colour (badges, pills): the colour leaning towards the text colour. */
const ink = (name: string) => `color-mix(in srgb, ${v(name)} ${v('ink')}, ${v('fg')})`;
const BG = v('bg');
const SURFACE = v('surface');

const NAMED = ['red', 'orange', 'amber', 'yellow', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'gray'];
const CODE_TOKENS = ['purple', 'green', 'orange', 'blue', 'amber', 'cyan', 'red', 'pink'];
const CALLOUTS = { note: 'gray', info: 'blue', tip: 'teal', success: 'green', warning: 'amber', danger: 'red', question: 'purple' };
const SOLID_PILLS = ['red', 'orange', 'amber', 'blue', 'gray', 'green', 'purple'];
const DOC_STATUS = ['amber', 'blue', 'green', 'red', 'gray'];
const DECISIONS = ['blue', 'green', 'red', 'gray'];
const RISKS = ['amber', 'green', 'orange', 'red'];
const RISK_BANDS = ['green', 'yellow', 'orange', 'red'];

/** Every text/background pair the stylesheets use (site.css shares these variables). */
const PAIRS: Pair[] = [
  { what: 'body text', fg: v('fg'), bg: [BG], min: TEXT },
  { what: 'text on surfaces (cards, table headers)', fg: v('fg'), bg: [SURFACE], min: TEXT },
  { what: 'code', fg: v('fg'), bg: [v('code-bg')], min: TEXT },
  { what: 'striped table rows', fg: v('fg'), bg: [BG, tint('surface', 60)], min: TEXT },
  { what: 'highlighted text', fg: v('fg'), bg: [BG, soft('yellow')], min: TEXT },
  { what: 'muted text', fg: v('fg-muted'), bg: [BG], min: TEXT },
  { what: 'muted text on surfaces', fg: v('fg-muted'), bg: [SURFACE], min: TEXT },
  { what: 'code comments and titles', fg: v('fg-muted'), bg: [v('code-bg')], min: TEXT },
  { what: 'links', fg: v('accent-default'), bg: [BG], min: TEXT },
  { what: 'links on surfaces (contents, sidebar)', fg: v('accent-default'), bg: [SURFACE], min: TEXT },
  { what: 'glossary term underline (the term itself is body text)', fg: v('fg-muted'), bg: [BG], min: GRAPHIC },
  { what: 'current page in the sidebar, mentions', fg: v('accent-default'), bg: [BG, soft('indigo')], min: TEXT },
  { what: 'step numbers, skip link', fg: BG, bg: [v('accent-default')], min: TEXT },
  { what: 'focus ring', fg: v('focus'), bg: [BG], min: GRAPHIC },
  { what: 'focus ring on surfaces', fg: v('focus'), bg: [SURFACE], min: GRAPHIC },
  { what: 'focus ring on code', fg: v('focus'), bg: [v('code-bg')], min: GRAPHIC },
  { what: 'focus ring in callouts', fg: v('focus'), bg: [BG, tint('red', 7)], min: GRAPHIC },
  { what: 'selected tab underline', fg: v('accent-default'), bg: [SURFACE], min: GRAPHIC },
  { what: 'progress bar fill', fg: v('accent-default'), bg: [BG, soft('gray')], min: GRAPHIC },
  { what: 'agent block title', fg: v('cyan'), bg: [BG, tint('cyan', 5)], min: TEXT },
  { what: 'due soon', fg: ink('amber'), bg: [BG, soft('amber')], min: TEXT },
  { what: 'overdue', fg: ink('red'), bg: [BG, soft('red')], min: TEXT },
  ...NAMED.flatMap((c): Pair[] => [
    { what: `{color=${c}} text`, fg: v(c), bg: [BG], min: TEXT },
    { what: `:badge{color=${c}}`, fg: ink(c), bg: [BG, soft(c)], min: TEXT },
    { what: `:status dot ${c}`, fg: v(c), bg: [BG], min: GRAPHIC },
  ]),
  ...CODE_TOKENS.map((c): Pair => ({ what: `code token ${c}`, fg: v(c), bg: [v('code-bg')], min: TEXT })),
  ...Object.entries(CALLOUTS).flatMap(([type, c]): Pair[] => [
    { what: `:::${type} title`, fg: v(c), bg: [BG, tint(c, 7)], min: TEXT },
    { what: `:::${type} body`, fg: v('fg'), bg: [BG, tint(c, 7)], min: TEXT },
  ]),
  ...SOLID_PILLS.map((c): Pair => ({ what: `priority / API method pill ${c}`, fg: BG, bg: [v(c)], min: TEXT })),
  ...DOC_STATUS.map((c): Pair => ({ what: `document status ${c}`, fg: ink(c), bg: [SURFACE, soft(c)], min: TEXT })),
  ...[...DOC_STATUS, 'indigo'].map((c): Pair => ({ what: `metric delta / status on a tile ${c}`, fg: v(c), bg: [SURFACE], min: TEXT })),
  ...DECISIONS.map((c): Pair => ({ what: `decision status ${c}`, fg: ink(c), bg: [BG, tint(c, 8), tint(c, 15)], min: TEXT })),
  ...RISKS.map((c): Pair => ({ what: `risk title ${c}`, fg: v(c), bg: [BG, tint(c, 6)], min: TEXT })),
  ...RISK_BANDS.flatMap((c): Pair[] => [
    { what: `risk matrix count ${c}`, fg: ink(c), bg: [BG, tint(c, 22)], min: TEXT },
    { what: `risk matrix link ${c}`, fg: v('fg'), bg: [BG, tint(c, 22)], min: TEXT },
    { what: `risk score ${c}`, fg: ink(c), bg: [BG, tint(c, 18)], min: TEXT },
  ]),
];

/** The ratio of a pair in a theme, rounded down to two decimals as contrast checkers report it. */
function pairRatio(pair: Pair, theme: Map<string, string>): number {
  return Math.floor(ratio(paint([pair.fg], theme), paint(pair.bg, theme)) * 100) / 100;
}

for (const [name, theme] of THEMES) {
  test(`contrast: every text and graphic pair meets WCAG AA in the ${name} theme`, () => {
    const failing = PAIRS
      .map((pair) => ({ pair, ratio: pairRatio(pair, theme) }))
      .filter(({ pair, ratio: r }) => r < pair.min)
      .map(({ pair, ratio: r }) => `${pair.what}: ${r} < ${pair.min}`);
    assert.deepEqual(failing, []);
  });
}

test('contrast: the print palette is the light palette', () => {
  for (const [name, value] of print) assert.equal(value, light.get(name), name);
  for (const name of ['--smd-bg', '--smd-fg', '--smd-fg-muted', '--smd-red', '--smd-gray']) assert.ok(print.has(name), name);
});

test('contrast: the editor color swatches show the light palette', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'language.ts'), 'utf8');
  const start = source.indexOf('const LIGHT_HEX');
  const found = [...source.slice(start, source.indexOf('};', start)).matchAll(/(\w+): '(#[0-9a-f]{6})'/g)];
  assert.equal(found.length, NAMED.length);
  for (const [, name, hex] of found) assert.equal(hex, light.get(`--smd-${name}`), name);
});

test('contrast: the checker itself matches known ratios', () => {
  const pair = (fg: string, bg: string): Pair => ({ what: '', fg, bg: [bg], min: 0 });
  assert.equal(pairRatio(pair('#000000', '#ffffff'), light), 21);
  assert.equal(pairRatio(pair('#767676', '#ffffff'), light), 4.54);
  // 50% black over white is rgb(127.5 127.5 127.5): 5.28:1 against black, mixed in sRGB as color-mix does.
  assert.equal(pairRatio({ what: '', fg: '#000000', bg: ['#ffffff', 'color-mix(in srgb, #000000 50%, transparent)'], min: 0 }, light), 5.28);
});
