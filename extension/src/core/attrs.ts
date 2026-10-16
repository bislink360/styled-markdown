import {
  ALIGN_VALUES, FONT_VALUES, NAMED_COLORS, SIZE_VALUES, STYLE_KEYS, TEXT_STYLE_VALUES, WEIGHT_VALUES,
} from './spec';
import { suggest } from './util';

/**
 * Attribute lists look like Pandoc / remark-directive attributes:
 *   {color=red bg="#fef3c7" .my-class #my-id title="Hello world"}
 */
export interface Attrs {
  values: Record<string, string>;
  classes: string[];
  id?: string;
}

export interface AttrProblem {
  message: string;
  severity: 'error' | 'warning';
  /** The attribute and the invalid value (one word of it for `style`). */
  key?: string;
  value?: string;
}

export function emptyAttrs(): Attrs {
  return { values: {}, classes: [] };
}

/**
 * One item of an attribute list: `.class`, `#id`, a bare `flag` or `key=value`, the value double-quoted (group 4),
 * single-quoted (group 5) or bare (group 6). In a quoted value a backslash and the character after it go together,
 * so `\"` (or `\'`) does not end it; the alternatives inside the quotes never overlap, so matching stays linear.
 */
const ATTR_ITEM = /\s*(?:([.#])([A-Za-z0-9_-]+)|([A-Za-z_][\w-]*)(?:\s*=\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^\s"'}]+)))?)\s*/y;
/** The same items as read before 1.10, without escapes: a quoted value runs to the next quote of its kind. */
const ATTR_ITEM_V1 = /\s*(?:([.#])([A-Za-z0-9_-]+)|([A-Za-z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+)))?)\s*/y;

/** One lexed item: the match of ATTR_ITEM (or ATTR_ITEM_V1) and where it starts. */
export interface AttrMatch {
  match: RegExpExecArray;
  pos: number;
}

/**
 * The items of the inside of `{…}`, or null when it is not a well-formed attribute list. Quoted values may hold
 * `\"` and `\'` (unquoteValue); a list that only reads without them (`title="C:\dir\"`, valid before 1.10) is read
 * as before, so no list that was valid changes.
 */
export function lexAttrItems(src: string): AttrMatch[] | null {
  return lexWith(ATTR_ITEM, src) ?? (src.includes('\\') ? lexWith(ATTR_ITEM_V1, src) : null);
}

function lexWith(re: RegExp, src: string): AttrMatch[] | null {
  const items: AttrMatch[] = [];
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const match = re.exec(src);
    if (!match || match[0].length === 0) {
      if (src.slice(pos).trim() === '') break;
      return null;
    }
    items.push({ match, pos });
    pos = re.lastIndex;
  }
  return items;
}

/**
 * A quoted value as written (without its quotes) → its value: `\"` in double quotes and `\'` in single quotes are
 * the quote. Every other backslash stays, `\\` included (two backslashes, until `smd: 2`), so Windows paths keep theirs.
 */
export function unquoteValue(raw: string, quote: '"' | "'"): string {
  return raw.includes('\\') ? raw.replaceAll(/\\([\s\S])/g, (pair, ch: string) => (ch === quote ? ch : pair)) : raw;
}

/** The value of a `key=value` item and the quotes it was written in; undefined for a flag. */
export function itemValue(m: RegExpExecArray): { value?: string; quote: '"' | "'" | '' } {
  if (m[4] !== undefined) return { value: unquoteValue(m[4], '"'), quote: '"' };
  if (m[5] !== undefined) return { value: unquoteValue(m[5], "'"), quote: "'" };
  return { value: m[6], quote: '' };
}

/**
 * Parse the inside of `{...}` (without the braces). Returns null when the
 * text is not a well-formed attribute list.
 */
export function parseAttrs(src: string): Attrs | null {
  const items = lexAttrItems(src);
  if (!items) return null;
  const attrs = emptyAttrs();
  for (const { match: m } of items) {
    if (m[1] === '.') attrs.classes.push(m[2]);
    else if (m[1] === '#') attrs.id = m[2];
    else attrs.values[m[3]] = itemValue(m).value ?? 'true';
  }
  return attrs;
}

/**
 * Find the `}` closing an attribute list that starts at `start` (which must be `{`). Inside quotes a backslash
 * takes the next character with it, as in parseAttrs; when that finds no end, the list is read without escapes.
 */
export function findAttrsEnd(src: string, start: number): number {
  const end = scanAttrsEnd(src, start, true);
  return end === -1 ? scanAttrsEnd(src, start, false) : end;
}

function scanAttrsEnd(src: string, start: number, escapes: boolean): number {
  if (src[start] !== '{') return -1;
  let quote: string | null = null;
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      // An escape pair: the character after the backslash is skipped with it.
      if (escapes && ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '}') {
      return i;
    } else if (ch === '\n' || ch === '{') {
      return -1;
    }
    i++;
  }
  return -1;
}

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC = /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%\s,/-]+\)$/;

/** Resolve a user color into a safe CSS value, or null when invalid. */
export function resolveColor(value: string): string | null {
  const v = value.trim();
  if ((NAMED_COLORS as readonly string[]).includes(v)) return `var(--smd-${v})`;
  if (HEX.test(v) || FUNC.test(v)) return v;
  return null;
}

/** Resolve a user color for use as a soft background tint. */
export function resolveTint(value: string): string | null {
  const v = value.trim();
  if ((NAMED_COLORS as readonly string[]).includes(v)) return `var(--smd-${v}-soft)`;
  return resolveColor(v);
}

/**
 * Convert style attributes into an inline CSS string. Only whitelisted keys
 * and values are emitted, so user content can never inject arbitrary CSS.
 */
export function attrsToStyle(attrs: Attrs, block = false): { style: string; problems: AttrProblem[] } {
  const css: string[] = [];
  const problems: AttrProblem[] = [];
  const bad = (key: string, value: string, hint: string) =>
    problems.push({ severity: 'error', message: `Invalid value "${value}" for "${key}". ${hint}`, key, value });

  for (const [key, value] of Object.entries(attrs.values)) {
    switch (key) {
      case 'color': {
        const c = resolveColor(value);
        if (c) css.push(`color:${c}`); else bad(key, value, colorHint(value));
        break;
      }
      case 'bg': {
        const c = resolveTint(value);
        if (c) css.push(`background:${c}`, block ? '' : 'padding:0 .25em;border-radius:3px'); else bad(key, value, colorHint(value));
        break;
      }
      case 'border': {
        const c = resolveColor(value);
        if (c) css.push(`border:1px solid ${c}`, block ? '' : 'padding:0 .25em;border-radius:3px'); else bad(key, value, colorHint(value));
        break;
      }
      case 'size': {
        const s = SIZE_VALUES[value];
        if (s) css.push(`font-size:${s}`); else bad(key, value, `Use one of: ${Object.keys(SIZE_VALUES).join(', ')}.`);
        break;
      }
      case 'weight': {
        const w = WEIGHT_VALUES[value];
        if (w) css.push(`font-weight:${w}`); else bad(key, value, `Use one of: ${Object.keys(WEIGHT_VALUES).join(', ')}.`);
        break;
      }
      case 'font': {
        const f = FONT_VALUES[value];
        if (f) css.push(`font-family:${f}`); else bad(key, value, `Use one of: ${Object.keys(FONT_VALUES).join(', ')}.`);
        break;
      }
      case 'align': {
        if (ALIGN_VALUES.includes(value)) css.push(`text-align:${value}`); else bad(key, value, `Use one of: ${ALIGN_VALUES.join(', ')}.`);
        break;
      }
      case 'style': {
        const parts = value.split(/[\s,]+/).filter(Boolean);
        for (const p of parts) {
          const s = TEXT_STYLE_VALUES[p];
          if (s) css.push(s); else bad(key, p, `Use one of: ${Object.keys(TEXT_STYLE_VALUES).join(', ')}.`);
        }
        break;
      }
      default:
        break; // non-style attributes (title, value...) are handled by the caller
    }
  }
  return { style: css.filter(Boolean).join(';'), problems };
}

export function isStyleKey(key: string): boolean {
  return key in STYLE_KEYS;
}

export function colorHint(value?: string): string {
  const hint = value ? suggest(value, NAMED_COLORS) : undefined;
  return `${hint ? `Did you mean "${hint}"? ` : ''}Use a named color (${NAMED_COLORS.join(', ')}) or #hex / rgb().`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render class/id/style as HTML attribute text (leading space included). */
export function htmlAttrs(attrs: Attrs, baseClasses: string[], style: string): string {
  const classes = [...baseClasses, ...attrs.classes.map((c) => `smd-u-${c}`)];
  let out = '';
  if (attrs.id) out += ` id="${escapeHtml(attrs.id)}"`;
  if (classes.length) out += ` class="${escapeHtml(classes.join(' '))}"`;
  if (style) out += ` style="${escapeHtml(style)}"`;
  return out;
}
