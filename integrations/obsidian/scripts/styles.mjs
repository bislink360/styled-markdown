// The Obsidian plugin's styles.css, made from the extension's smd.css when the plugin is built:
// - the colour variables follow Obsidian's theme (its text, background and accent colours and its palette), in light
//   and dark mode (`body.theme-light` / `body.theme-dark`);
// - every rule is limited to rendered notes (`.markdown-rendered`) and the plugin's own blocks (`.smd-obsidian`, which
//   also covers ```smd blocks in Live Preview);
// - rules for plain Markdown elements (headings, paragraphs, tables, links… inside `.smd-doc`) are left out, so notes
//   keep Obsidian's typography, and code colours apply only inside the engine's code frames.

export const SCOPE = ':is(.markdown-rendered, .smd-obsidian)';

/** Obsidian's theme variables for the ones smd.css defines; smd.css's own palette fills in the colours Obsidian lacks. */
const THEME = `body.theme-light, body.theme-dark {
  --smd-font-sans: var(--font-text);
  --smd-font-mono: var(--font-monospace);
  --smd-bg: var(--background-primary);
  --smd-fg: var(--text-normal);
  --smd-fg-muted: var(--text-muted);
  --smd-surface: var(--background-secondary);
  --smd-border: var(--background-modifier-border);
  --smd-code-bg: var(--code-background);
  --smd-red: var(--color-red); --smd-orange: var(--color-orange); --smd-yellow: var(--color-yellow);
  --smd-green: var(--color-green); --smd-cyan: var(--color-cyan); --smd-blue: var(--color-blue);
  --smd-purple: var(--color-purple); --smd-pink: var(--color-pink);
  --smd-accent-default: var(--interactive-accent);
}`;

/** The plugin's own rules. */
const EXTRA = `.smd-obsidian-hidden { display: none; }
.smd-obsidian { overflow-wrap: break-word; }
.smd-obsidian > :last-child, .smd-obsidian > :last-child > :last-child { margin-bottom: 0; }
${SCOPE} .smd-math-block { overflow-x: auto; }`;

/**
 * Top-level rules and at-rules of a stylesheet (comments removed): `{ prelude, body }`, with `children` for the
 * rules inside `@media`/`@supports`.
 * @param {string} css
 * @returns {Array<{ prelude: string, body: string, children?: ReturnType<typeof parseCss> }>}
 */
export function parseCss(css) {
  const text = css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('{', at);
    if (open < 0) break;
    const close = matchingBrace(text, open);
    const prelude = text.slice(at, open).trim();
    const body = text.slice(open + 1, close);
    blocks.push(/^@(media|supports)\b/.test(prelude) ? { prelude, body, children: parseCss(body) } : { prelude, body });
    at = close + 1;
  }
  return blocks;
}

function matchingBrace(text, open) {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') depth--;
    if (text[i] === '}' && depth === 0) return i;
    i++;
  }
  throw new Error(`Unclosed "{" at ${open} in smd.css.`);
}

/** Split a selector list on its top-level commas. */
export function splitSelectors(list) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(list.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(list.slice(from).trim());
  return parts.filter(Boolean);
}

/**
 * One selector for Obsidian, or null to leave it out: the page's `:root` becomes `body` (`body.theme-dark` for the
 * dark theme), `.smd-doc` goes, and what's left must still name a .smd class.
 */
export function obsidianSelector(selector) {
  if (selector.startsWith(':root')) return selector.replace(':root[data-smd-theme="dark"]', 'body.theme-dark').replace(':root', 'body');
  if (/(^|[\s,])html\b|\.smd-body\b/.test(selector)) return null;
  const rest = selector.replaceAll(/\.smd-doc(?![\w-])\s*/g, '').trim();
  if (!/\.(smd-|hljs)/.test(rest)) return null;
  return `${SCOPE} ${rest.startsWith('.hljs') ? `.smd-code ${rest}` : rest}`;
}

/** One rule for Obsidian (with the theme mapping after smd.css's dark palette), or '' to leave it out. */
function obsidianRule(block, depth) {
  if (block.children) {
    const inner = block.children.map((child) => obsidianRule(child, depth + 1)).filter(Boolean).join('\n');
    return inner ? `${block.prelude} {\n${inner}\n}` : '';
  }
  // Other at-rules (`@page` margins) would change every note's PDF export, not only .smd blocks.
  if (block.prelude.startsWith('@')) return '';
  const selectors = splitSelectors(block.prelude).map(obsidianSelector).filter(Boolean);
  if (!selectors.length) return '';
  const rule = `${selectors.join(',\n')} {${block.body}}`;
  const darkPalette = depth === 0 && block.prelude === ':root[data-smd-theme="dark"]';
  return darkPalette ? `${rule}\n\n${THEME}` : rule;
}

/** styles.css for the plugin from smd.css. */
export function obsidianCss(smdCss) {
  const rules = parseCss(smdCss).map((block) => obsidianRule(block, 0)).filter(Boolean);
  if (!rules.some((rule) => rule.includes(THEME))) throw new Error('smd.css has no :root[data-smd-theme="dark"] palette to map.');
  return [
    '/* Styled Markdown for Obsidian: made from smd.css by scripts/build.mjs (do not edit). */',
    ...rules,
    EXTRA,
    '',
  ].join('\n\n');
}
