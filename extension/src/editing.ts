import * as path from 'node:path';

/**
 * Editing helpers without VS Code dependencies, so they can be unit tested: list continuation on
 * Enter, image file names and links for paste / drop, and cSpell settings for .smd.
 */

// ---------------------------------------------------------------------------
// List continuation
// ---------------------------------------------------------------------------

export type ListEnter =
  /** Insert a line break, then `prefix`, the cursor, then `suffix` (the task's owners). */
  | { kind: 'continue'; prefix: string; suffix: string }
  /** The item is empty: replace the line with `line`, ending the list. */
  | { kind: 'end'; line: string };

const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/;

/**
 * What Enter does at `cursor` on a list item: continue the list with the next marker (tasks start
 * unchecked and keep their `@owner` mentions when the cursor is at the end), or end the list when the
 * item is empty. Undefined when the line is not a list item or the cursor is inside its marker.
 */
export function listEnter(line: string, cursor: number): ListEnter | undefined {
  const m = ITEM.exec(line);
  if (!m) return undefined;
  const [, indent, bullet, num, delim, space, box = '', content] = m;
  const marker = bullet ?? `${num}${delim}`;
  if (cursor < indent.length + marker.length + space.length + box.length) return undefined;

  const words = content.trim().split(/\s+/).filter(Boolean);
  const owners = box ? words.filter((w) => /^@[\w.-]+$/.test(w)) : [];
  if (words.length === owners.length) return { kind: 'end', line: '' };

  const next = bullet ?? `${Number(num) + 1}${delim}`;
  const atEnd = cursor >= line.trimEnd().length;
  return {
    kind: 'continue',
    prefix: `${indent}${next}${space}${box ? '[ ] ' : ''}`,
    suffix: atEnd && owners.length ? ` ${[...new Set(owners)].join(' ')}` : '',
  };
}

/** Is `line` inside a fenced code block (or on its fence)? Enter behaves normally there. */
export function inCodeBlock(lines: readonly string[], line: number): boolean {
  let fence: { char: string; len: number } | null = null;
  for (let i = 0; i <= line && i < lines.length; i++) {
    const mark = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fence) {
      if (i === line) return true;
      if (mark && mark[1][0] === fence.char && mark[1].length >= fence.len && !mark[2].trim()) fence = null;
    } else if (mark && !(mark[1][0] === '`' && mark[2].includes('`'))) {
      if (i === line) return true;
      fence = { char: mark[1][0], len: mark[1].length };
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Images: paste and drop
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.avif'];

export const isImagePath = (file: string): boolean => IMAGE_EXTENSIONS.includes(path.extname(file).toLowerCase());

/** The extension for a pasted image's MIME type, e.g. `image/png` → `.png`. */
export function imageExtension(mime: string): string | undefined {
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif' }[mime.toLowerCase()];
  return ext;
}

/** A name for a pasted image: `<document>-<yyyymmdd-hhmmss>`, e.g. `checkout-redesign-20260928-091502`. */
export function pastedImageBase(documentPath: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${path.basename(documentPath, path.extname(documentPath))}-${stamp}`;
}

/** `name.ext`, or `name-1.ext`, `name-2.ext`… when taken. */
export function uniqueFileName(base: string, ext: string, taken: (name: string) => boolean): string {
  let name = `${base}${ext}`;
  for (let i = 1; taken(name); i++) name = `${base}-${i}${ext}`;
  return name;
}

/**
 * The folder images are saved to: `folder` (e.g. `docs/images`) inside the workspace folder, or next
 * to the document when it isn't in a workspace.
 */
export function imageFolder(documentPath: string, workspaceRoot: string | undefined, folder: string): string {
  return path.resolve(workspaceRoot ?? path.dirname(documentPath), folder);
}

/** A Markdown image for `imagePath`, linked relative to the document, with alt text from the file name. */
export function imageMarkdown(documentPath: string, imagePath: string): string {
  const rel = path.relative(path.dirname(documentPath), imagePath).split(path.sep).join('/');
  const alt = path.basename(imagePath, path.extname(imagePath)).replace(/[-_]+/g, ' ').replace(/[[\]]/g, '').trim() || 'image';
  return `![${alt}](${encodeURI(rel).replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
}

// ---------------------------------------------------------------------------
// Spell checking (cSpell)
// ---------------------------------------------------------------------------

/**
 * cSpell patterns for .smd: syntax that is not prose, so its names are never flagged. Titles after a
 * container name and the text inside `[…]` stay checked.
 */
export const SPELLCHECK_PATTERNS: ReadonlyArray<{ name: string; pattern: string }> = [
  // Anchored to the start of the file, so `---` rules in the body don't pair up.
  { name: 'smd-front-matter', pattern: '/^---\\r?\\n[\\s\\S]*?\\r?\\n(?:---|\\.\\.\\.)(?=\\r?\\n|$)/' },
  { name: 'smd-code-block', pattern: '/^\\s{0,3}(`{3,}|~{3,})[\\s\\S]*?^\\s{0,3}\\1\\s*$/gm' },
  { name: 'smd-inline-code', pattern: '/(`+)[^`\\n]+?\\1/g' },
  { name: 'smd-container-fence', pattern: '/^\\s{0,3}:{3,}\\s*[A-Za-z][\\w-]*(?:\\{[^}\\n]*\\})?/gm' },
  { name: 'smd-directive', pattern: '/(?<=^|[\\s([{>*_~"\'-]):[a-z][a-z0-9-]*(?=[[{])/gm' },
  { name: 'smd-attributes', pattern: '/\\{[#.]?[A-Za-z_][\\w-]*(?:=(?:"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s}]*))?(?:\\s+[#.]?[A-Za-z_][\\w-]*(?:=(?:"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s}]*))?)*\\s*\\}/g' },
  { name: 'smd-mention', pattern: '/(?<=^|\\s|\\[)@[\\w.-]+/gm' },
  { name: 'smd-url', pattern: '/\\]\\([^)\\s]+/g' },
];

/** The cSpell `languageSettings` entry for .smd. */
export function smdLanguageSettings(): { languageId: string; name: string; patterns: Array<{ name: string; pattern: string }>; ignoreRegExpList: string[] } {
  return {
    languageId: 'smd',
    name: 'Styled Markdown (added by the Styled Markdown extension)',
    patterns: SPELLCHECK_PATTERNS.map((p) => ({ ...p })),
    ignoreRegExpList: SPELLCHECK_PATTERNS.map((p) => p.name),
  };
}

/** `languageSettings` with the .smd entry added, replacing an earlier one from this extension. */
export function mergeLanguageSettings(existing: unknown): unknown[] {
  const list = Array.isArray(existing) ? existing : [];
  const ours = smdLanguageSettings();
  const kept = list.filter((e) => !(e && typeof e === 'object' && (e as { name?: unknown }).name === ours.name));
  return [...kept, ours];
}

/** Turn a cSpell `/pattern/flags` string into a RegExp (for tests and previews). */
export function toRegExp(pattern: string): RegExp {
  const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(pattern);
  if (!m) throw new Error(`Not a /pattern/flags string: ${pattern}`);
  return new RegExp(m[1], m[2]);
}
