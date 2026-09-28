import katex from 'katex';
import { attrsToStyle, isStyleKey, parseAttrs, resolveColor } from './attrs';
import { CONTAINER_CLOSE, CONTAINER_OPEN, parseContainerInfo } from './containers';
import { parseFrontMatter } from './frontmatter';
import { dueState, HEADING_ATTRS } from './render';
import { anchorIds, findLinks, isDocumentPath, splitTarget } from './links';
import { parseFenceInfo, sliceLines } from './fence';
import { suggest } from './util';
import {
  PRIORITY_VALUES,
  CONTAINERS, INLINE_DIRECTIVES, MERMAID_TYPES, SMD_VERSION,
} from './spec';
import { FRONTMATTER_SCHEMA, frontMatterProperty } from './frontmatterSchema';

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export interface Diagnostic {
  /** Zero-based line. */
  line: number;
  /** Zero-based start column. */
  column: number;
  /** Zero-based end column (exclusive). */
  endColumn: number;
  severity: Severity;
  /** Stable rule id, e.g. "container/unknown". Useful for agents and CI filters. */
  code: string;
  message: string;
  /** A machine-applicable fix: replace [column, endColumn) on `line` with `replacement`. */
  fix?: Fix;
}

export interface Fix {
  line: number;
  column: number;
  endColumn: number;
  replacement: string;
  title: string;
}

export interface ValidateOptions {
  /** Return true when a path (relative to the document) exists. Omit to skip link checks. */
  fileExists?: (relativePath: string) => boolean;
  /** Read a file relative to the document, for checking `file="…" lines="…"` embeds. */
  readFile?: (relativePath: string) => string | undefined;
  /** "Today" as YYYY-MM-DD for overdue and stale checks. Defaults to the current date. */
  today?: string;
  /**
   * Report `frontmatter/stale` when `updated` is more than this many days before today and the
   * status is not archived or deprecated. Default 180; 0 turns the check off.
   */
  staleAfterDays?: number;
}

export function validateSmd(text: string, options: ValidateOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = text.split(/\r?\n/);
  const push: Push = (line, column, endColumn, severity, code, message, fix) =>
    diagnostics.push({ line, column, endColumn: Math.max(endColumn, column + 1), severity, code, message, ...(fix ? { fix } : {}) });
  const wholeLine = (line: number, severity: Severity, code: string, message: string) =>
    push(line, 0, lines[line]?.length ?? 1, severity, code, message);

  // --- Front matter -------------------------------------------------------
  const fm = parseFrontMatter(text);
  if (fm.error) wholeLine(fm.error.line, 'error', 'frontmatter/invalid', fm.error.message);
  if (fm.present && !fm.error) checkFrontMatter(fm.data, lines, fm.bodyStartLine, push, options);

  // --- Body ---------------------------------------------------------------
  interface Open { name: string; len: number; line: number }
  const stack: Open[] = [];
  let fence: { char: string; len: number; lang: string; info: string; line: number; content: string[] } | null = null;
  let mathStart = -1;
  let mathLines: string[] = [];
  let firstH1: { text: string; line: number } | null = null;

  for (let i = fm.bodyStartLine; i < lines.length; i++) {
    const raw = lines[i];

    // Fenced code: nothing inside is SMD syntax, except we check diagrams and math.
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence.char === '`' ? '`' : '~'}{${fence.len},}\\s*$`);
      if (close.test(raw)) {
        checkFence(fence.lang, fence.content, fence.line, push, wholeLine);
        checkEmbed(fence.info, fence.content, fence.line, lines[fence.line], push, options);
        fence = null;
      } else {
        fence.content.push(raw);
      }
      continue;
    }
    const fenceOpen = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/.exec(raw);
    if (fenceOpen) {
      fence = { char: fenceOpen[2][0], len: fenceOpen[2].length, lang: fenceOpen[3].toLowerCase(), info: raw.slice(fenceOpen[1].length + fenceOpen[2].length), line: i, content: [] };
      continue;
    }

    // Display math $$ … $$
    if (mathStart >= 0) {
      if (raw.trimEnd().endsWith('$$')) {
        mathLines.push(raw.trimEnd().slice(0, -2));
        checkMath(mathLines.join('\n'), mathStart, wholeLine);
        mathStart = -1;
        mathLines = [];
      } else {
        mathLines.push(raw);
      }
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith('$$')) {
      const rest = trimmed.slice(2);
      if (rest.endsWith('$$') && rest.length > 2) checkMath(rest.slice(0, -2), i, wholeLine);
      else { mathStart = i; mathLines = [rest]; }
      continue;
    }

    // Containers
    const close = CONTAINER_CLOSE.exec(raw);
    if (close) {
      // A bare ::: always closes the innermost open container.
      if (!stack.pop()) {
        wholeLine(i, 'warning', 'container/stray-close', `Closing "${close[2]}" has no matching opening container.`);
      }
      continue;
    }
    const open = CONTAINER_OPEN.exec(raw);
    if (open) {
      const len = open[2].length;
      const col = open[1].length;
      const info = parseContainerInfo(open[3] + open[4]);
      if (info) {
        const parent = stack[stack.length - 1];
        const nameStart = raw.indexOf(open[3], col + len);
        const nameEnd = nameStart + info.name.length;
        checkContainer(info, i, nameStart, nameEnd, parent?.name, push);
        stack.push({ name: info.name, len, line: i });
      }
      continue;
    }

    // Headings
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h1 && !firstH1) firstH1 = { text: h1[1].replace(HEADING_ATTRS, ''), line: i };
    if (/^\s{0,3}#{1,6}\s/.test(raw)) checkHeadingAttrs(raw, i, push);

    // Open tasks that are past their due date
    const openTask = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s/.test(raw);
    const due = openTask ? /:due\[(\d{4}-\d{2}-\d{2})\]/.exec(raw) : null;
    if (due && dueState(due[1], options.today) === 'overdue') {
      push(i, due.index, due.index + due[0].length, 'info', 'task/overdue', `Open task is overdue (due ${due[1]}).`);
    }

    checkInline(raw, i, push);
  }

  if (fence) wholeLine(fence.line, 'error', 'fence/unclosed', `Code block opened here is never closed with ${fence.char.repeat(fence.len)}.`);
  if (mathStart >= 0) wholeLine(mathStart, 'error', 'math/unclosed', 'Display math "$$" is never closed.');
  for (const o of stack) {
    wholeLine(o.line, 'error', 'container/unclosed', `":::${o.name}" is never closed. Add a line with ${':'.repeat(o.len)} after its content.`);
  }

  if (firstH1 && typeof fm.data.title === 'string' && firstH1.text.trim() === fm.data.title.trim()) {
    wholeLine(firstH1.line, 'hint', 'frontmatter/duplicate-title',
      'The front matter title is already rendered as the document heading; this "# heading" duplicates it.');
  }

  checkLinks(text, push, options);

  return diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
}

type Push = (line: number, column: number, endColumn: number, severity: Severity, code: string, message: string, fix?: Fix) => void;
type WholeLine = (line: number, severity: Severity, code: string, message: string) => void;

/** Status values whose documents are not expected to be kept up to date. */
const RETIRED_STATUS = ['archived', 'deprecated'];

/** Front matter checks, driven by FRONTMATTER_SCHEMA. Keys outside the schema are custom metadata. */
function checkFrontMatter(
  data: Record<string, unknown>, lines: string[], end: number, push: Push, options: ValidateOptions,
): void {
  const keyLine = (key: string) => {
    for (let i = 1; i < end; i++) if (new RegExp(`^${key}\s*:`).test(lines[i])) return i;
    return 0;
  };
  const markKey = (key: string, severity: Severity, code: string, message: string) => {
    const l = keyLine(key);
    push(l, 0, lines[l]?.length ?? key.length, severity, code, message);
  };

  if (data.smd === undefined) {
    push(0, 0, 3, 'info', 'frontmatter/version', `Add "smd: ${SMD_VERSION}" to the front matter so tools know which Styled Markdown version this file targets.`,
      { line: 1, column: 0, endColumn: 0, replacement: `smd: ${SMD_VERSION}\n`, title: `Add "smd: ${SMD_VERSION}"` });
  } else if (Number(data.smd) !== SMD_VERSION) {
    markKey('smd', 'warning', 'frontmatter/version', `Unsupported Styled Markdown version "${data.smd}". This tool supports version ${SMD_VERSION}.`);
  }

  const known = Object.keys(FRONTMATTER_SCHEMA.properties);
  for (const [key, value] of Object.entries(data)) {
    const prop = frontMatterProperty(key);
    if (!prop) {
      const hint = suggest(key, known);
      const l = keyLine(key);
      push(l, 0, key.length, 'hint', 'frontmatter/unknown-key',
        `"${key}" is not a standard front matter key${hint ? ` — did you mean "${hint}"?` : '.'} It is kept as custom metadata.`,
        hint ? { line: l, column: 0, endColumn: key.length, replacement: hint, title: `Change to "${hint}"` } : undefined);
      continue;
    }
    if (key === 'smd' || value === undefined || value === null) continue;
    if (key === 'accent') {
      if (!resolveColor(String(value))) markKey(key, 'error', 'frontmatter/accent', `Invalid accent color "${value}".`);
    } else if (prop.enum) {
      // Status is matched case-insensitively, as it always has been.
      const v = key === 'status' ? String(value).toLowerCase() : String(value);
      if (!prop.enum.map(String).includes(v)) {
        const code = key === 'status' ? 'frontmatter/status' : key === 'audience' ? 'frontmatter/audience' : 'frontmatter/value';
        markKey(key, 'warning', code, `Unknown ${key} "${value}". Use one of: ${prop.enum.join(', ')}.`);
      }
    } else if (prop.anyOf?.some((a) => a.type === 'array')) {
      if (!Array.isArray(value) && typeof value !== 'string') markKey(key, 'warning', 'frontmatter/type', `"${key}" should be a list, e.g. ${key}: [a, b].`);
    } else if (prop.type === 'boolean') {
      if (typeof value !== 'boolean') markKey(key, 'warning', 'frontmatter/type', `"${key}" should be true or false.`);
    } else if (prop.format === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}/.test(String(value))) markKey(key, 'warning', 'frontmatter/date', `"${key}" should be a date like 2026-09-26.`);
    } else if (typeof value === 'object') {
      markKey(key, 'warning', 'frontmatter/type', `"${key}" should be a single value, not a list or a mapping.`);
    }
  }

  // Stale documents: `updated` long ago on a document that is still live.
  const staleAfter = options.staleAfterDays ?? 180;
  const updated = typeof data.updated === 'string' ? data.updated.slice(0, 10) : '';
  if (staleAfter > 0 && /^\d{4}-\d{2}-\d{2}$/.test(updated) && !RETIRED_STATUS.includes(String(data.status ?? '').toLowerCase())) {
    const today = options.today ?? new Date().toISOString().slice(0, 10);
    const days = Math.floor((Date.parse(today) - Date.parse(updated)) / 86_400_000);
    if (days > staleAfter) {
      markKey('updated', 'info', 'frontmatter/stale',
        `Last updated ${days} days ago (more than ${staleAfter}). Review the document and bump "updated", or set "status: archived".`);
    }
  }
}

function checkContainer(
  info: NonNullable<ReturnType<typeof parseContainerInfo>>,
  line: number, nameStart: number, nameEnd: number, parent: string | undefined, push: Push,
): void {
  const spec = CONTAINERS[info.name];
  if (!spec) {
    const hint = suggest(info.name, Object.keys(CONTAINERS));
    push(line, nameStart, nameEnd, 'warning', 'container/unknown',
      `Unknown container ":::${info.name}"${hint ? ` — did you mean ":::${hint}"?` : '.'} It will render as a plain box.`,
      hint ? { line, column: nameStart, endColumn: nameEnd, replacement: hint, title: `Change to ":::${hint}"` } : undefined);
    return;
  }
  if (info.attrsError) push(line, nameEnd, nameEnd + 1, 'error', 'attrs/syntax', info.attrsError);
  if (spec.parent && parent !== spec.parent) {
    push(line, nameStart, nameEnd, 'warning', 'container/parent',
      `":::${info.name}" should be placed directly inside "::::${spec.parent}".`);
  }
  const allowed = new Set([...(spec.attrs ?? []), 'title']);
  for (const key of Object.keys(info.attrs.values)) {
    if (!allowed.has(key) && !isStyleKey(key)) {
      push(line, nameStart, nameEnd, 'warning', 'attrs/unknown', `Unknown attribute "${key}" on ":::${info.name}".`);
    }
  }
  for (const p of attrsToStyle(info.attrs, true).problems) push(line, nameStart, nameEnd, p.severity, 'attrs/value', p.message);
  for (const [key, allowed] of Object.entries(spec.values ?? {})) {
    const v = info.attrs.values[key];
    if (v !== undefined && !allowed.some((a) => a.toLowerCase() === v.toLowerCase())) {
      const hint = suggest(v, allowed);
      push(line, nameStart, nameEnd, 'error', 'attrs/value', `Invalid ${key} "${v}" on ":::${info.name}"${hint ? ` — did you mean "${hint}"?` : '.'} Use one of: ${allowed.join(', ')}.`);
    }
  }
  for (const key of spec.required ?? []) {
    if (info.attrs.values[key] === undefined) {
      const example = info.name === 'api' ? ':::api{method=GET path="/v1/items"}' : `{${key}=…}`;
      push(line, nameStart, nameEnd, 'error', 'attrs/required', `":::${info.name}" needs a ${key} attribute, e.g. ${example}.`);
    }
  }
  if (info.attrs.values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(info.attrs.values.date)) {
    push(line, nameStart, nameEnd, 'warning', 'attrs/value', '"date" should look like 2026-09-26.');
  }
  const width = info.attrs.values.width;
  if (info.name === 'column' && width && !/^\d+(\.\d+)?%?$/.test(width)) {
    push(line, nameStart, nameEnd, 'error', 'attrs/value', `Invalid column width "${width}". Use a percentage (30%) or a ratio (2).`);
  }
  if (info.name === 'card' && info.attrs.values.accent && !resolveColor(info.attrs.values.accent)) {
    push(line, nameStart, nameEnd, 'error', 'attrs/value', `Invalid accent color "${info.attrs.values.accent}".`);
  }
}

function checkInline(raw: string, line: number, push: Push): void {
  // Blank out inline code so its contents are never treated as syntax.
  const text = raw.replace(/(`+)([\s\S]*?)\1/g, (m) => ' '.repeat(m.length));

  // :directive[content]{attrs}
  const directiveSpans: Array<[number, number]> = [];
  for (const m of text.matchAll(/(^|[\s([{>*_~"'-]):([a-z][a-z0-9-]*)(\[[^\]\n]*\])?(\{[^{}\n]*\})?/g)) {
    if (!m[3] && !m[4]) continue;
    const name = m[2];
    const col = m.index! + m[1].length;
    const end = col + m[0].length - m[1].length;
    directiveSpans.push([col, end]);
    const spec = INLINE_DIRECTIVES[name];
    if (!spec) {
      const hint = suggest(name, Object.keys(INLINE_DIRECTIVES));
      // Only flag things that look intentional, e.g. ":badg[..]" — not "see:[link]".
      if (hint) {
        push(line, col, end, 'warning', 'directive/unknown', `Unknown inline directive ":${name}" — did you mean ":${hint}"?`,
          { line, column: col + 1, endColumn: col + 1 + name.length, replacement: hint, title: `Change to ":${hint}"` });
      }
      continue;
    }
    if (spec.content && !m[3]) push(line, col, end, 'error', 'directive/content', `":${name}" needs content in brackets, e.g. ${spec.example}.`);
    const attrs = m[4] ? parseAttrs(m[4].slice(1, -1)) : null;
    if (m[4] && !attrs) { push(line, col, end, 'error', 'attrs/syntax', 'Malformed attribute list.'); continue; }
    const content = m[3]?.slice(1, -1).trim() ?? '';
    if (name === 'priority' && content && !PRIORITY_VALUES.some((v) => v.toLowerCase() === content.toLowerCase())) {
      push(line, col, end, 'warning', 'attrs/value', `Unknown priority "${content}". Use one of: ${PRIORITY_VALUES.join(', ')}.`);
    }
    if (name === 'due' && content && dueState(content) === 'invalid') {
      push(line, col, end, 'error', 'attrs/value', `Due date "${content}" should look like 2026-10-15.`);
    }
    if (name === 'metric' && !attrs?.values.label) {
      push(line, col, end, 'warning', 'attrs/required', `":metric" should have a label, e.g. :metric[${content || '42%'}]{label="Activation"}.`);
    }
    if (!attrs) continue;
    const values = spec.values ?? {};
    for (const [key, value] of Object.entries(attrs.values)) {
      if (values[key] && !values[key].includes(value)) {
        push(line, col, end, 'error', 'attrs/value', `Invalid ${key} "${value}" for ":${name}". Use one of: ${values[key].join(', ')}.`);
      } else if (!spec.attrs.includes(key)) push(line, col, end, 'warning', 'attrs/unknown', `":${name}" does not take "${key}". Accepted: ${spec.attrs.join(', ') || 'none'}.`);
      else if (key === 'color' && !resolveColor(value)) push(line, col, end, 'error', 'attrs/value', `Invalid color "${value}".`);
      else if (key === 'value') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 100) push(line, col, end, 'error', 'attrs/value', `Progress value must be a number from 0 to 100, got "${value}".`);
      }
    }
  }

  // [text]{attrs} — styled spans (skip the attribute lists that belong to directives)
  for (const m of text.matchAll(/\]\{([^{}\n]*)\}/g)) {
    const col = m.index! + 1;
    const end = col + m[0].length - 1;
    if (directiveSpans.some(([s, e]) => col > s && col < e)) continue;
    const attrs = parseAttrs(m[1]);
    if (!attrs) { push(line, col, end, 'error', 'attrs/syntax', 'Malformed attribute list. Expected {key=value key2="value 2" .class}.'); continue; }
    for (const key of Object.keys(attrs.values)) {
      if (!isStyleKey(key)) push(line, col, end, 'warning', 'attrs/unknown', `Unknown style attribute "${key}". Known: color, bg, border, size, weight, font, style.`);
    }
    for (const p of attrsToStyle(attrs).problems) push(line, col, end, p.severity, 'attrs/value', p.message);
  }
}

/**
 * Links, images, reference definitions, HTML href/src and `related:` entries must resolve: `#anchor` to an
 * id in this document, relative paths to existing files and `file.smd#anchor` to an id in that file.
 * File checks run only when `fileExists` is given; anchors in other files also need `readFile`.
 */
function checkLinks(text: string, push: Push, options: ValidateOptions): void {
  const { links, references, definitions } = findLinks(text);
  let ownIds: Set<string> | undefined;
  const otherIds = new Map<string, Set<string> | undefined>();
  const idsIn = (path: string): Set<string> | undefined => {
    if (!otherIds.has(path)) {
      const other = options.readFile?.(path);
      otherIds.set(path, other === undefined ? undefined : anchorIds(other));
    }
    return otherIds.get(path);
  };

  for (const link of links) {
    const parts = splitTarget(link.target);
    if (!parts) continue;
    const { line, column } = link;
    const end = column + link.target.length;
    if (!parts.path) {
      if (!parts.anchor) continue;
      ownIds ??= anchorIds(text);
      if (!ownIds.has(parts.anchor)) {
        missingAnchor(parts.anchor, ownIds, 'in this document', link.target, line, column, end, push);
      }
      continue;
    }
    if (!options.fileExists) continue;
    if (!options.fileExists(parts.path)) {
      const where = link.kind === 'related' ? ' (listed in "related")' : '';
      push(line, column, end, 'warning', 'link/missing-file', `"${parts.path}" does not exist${where}.`);
      continue;
    }
    if (parts.anchor && isDocumentPath(parts.path)) {
      const ids = idsIn(parts.path);
      if (ids && !ids.has(parts.anchor)) {
        missingAnchor(parts.anchor, ids, `in "${parts.path}"`, link.target, line, column, end, push);
      }
    }
  }

  for (const ref of references) {
    if (!definitions.has(ref.label)) {
      push(ref.line, ref.column, ref.endColumn, 'warning', 'link/undefined-reference',
        `No definition for the reference "[${ref.label}]". Add a line like "[${ref.label}]: https://…" or use an inline link.`);
    }
  }
}

function missingAnchor(
  anchor: string, ids: Set<string>, where: string, target: string,
  line: number, column: number, end: number, push: Push,
): void {
  const hint = suggest(anchor, [...ids]);
  const fixed = hint ? target.slice(0, target.indexOf('#') + 1) + hint : undefined;
  push(line, column, end, 'warning', 'link/missing-anchor',
    `No heading or element with id "${anchor}" ${where}${hint ? ` — did you mean "#${hint}"?` : '.'}`,
    fixed ? { line, column, endColumn: end, replacement: fixed, title: `Change to "${fixed}"` } : undefined);
}

function checkFence(lang: string, content: string[], line: number, push: Push, wholeLine: WholeLine): void {
  if (lang === 'mermaid') {
    let inConfig = false;
    for (const [offset, l] of content.entries()) {
      const t = l.trim();
      if (t === '---') { inConfig = !inConfig; continue; }
      if (inConfig || !t || t.startsWith('%%')) continue;
      const kind = t.split(/[\s;:]/)[0];
      if (!MERMAID_TYPES.includes(kind)) {
        const hint = suggest(kind, MERMAID_TYPES);
        const at = line + 1 + offset;
        const col = l.indexOf(kind);
        push(at, col, col + kind.length, 'error', 'mermaid/type', `Unknown Mermaid diagram type "${kind}"${hint ? ` — did you mean "${hint}"?` : '.'}`,
          hint ? { line: at, column: col, endColumn: col + kind.length, replacement: hint, title: `Change to "${hint}"` } : undefined);
      }
      return;
    }
    wholeLine(line, 'warning', 'mermaid/empty', 'Empty Mermaid diagram.');
  } else if (lang === 'math' || lang === 'latex' || lang === 'katex') {
    checkMath(content.join('\n'), line, wholeLine);
  }
}

function checkMath(tex: string, line: number, wholeLine: WholeLine): void {
  try {
    katex.renderToString(tex, { displayMode: true, throwOnError: true });
  } catch (e) {
    const msg = (e as Error).message.replace(/^KaTeX parse error:\s*/, '');
    wholeLine(line, 'error', 'math/syntax', `Math error: ${msg}`);
  }
}

function checkHeadingAttrs(raw: string, line: number, push: Push): void {
  const m = HEADING_ATTRS.exec(raw);
  if (!m) return;
  const col = m.index + m[0].indexOf('{');
  const end = col + m[1].length + 2;
  const attrs = parseAttrs(m[1]);
  if (!attrs) { push(line, col, end, 'error', 'attrs/syntax', 'Malformed heading attribute list. Expected {#id .class agent=skip}.'); return; }
  for (const [key, value] of Object.entries(attrs.values)) {
    if (key !== 'agent') push(line, col, end, 'warning', 'attrs/unknown', `Unknown heading attribute "${key}". Headings accept #id, .class and agent=skip.`);
    else if (value !== 'skip') push(line, col, end, 'error', 'attrs/value', `agent="${value}" is not supported on headings — use agent=skip to hide the section from agent views.`);
  }
}

function checkEmbed(info: string, content: string[], line: number, raw: string, push: Push, options: ValidateOptions): void {
  const fence = parseFenceInfo(info);
  const at = (s: string): [number, number] => { const c = raw.indexOf(s); return c < 0 ? [0, raw.length] : [c, c + s.length]; };
  for (const problem of fence.problems) push(line, 0, raw.length, 'error', 'fence/range', problem);
  if (fence.lines && !fence.file) push(line, ...at('lines='), 'warning', 'fence/lines-without-file', '"lines" only applies together with file="…".');
  if (!fence.file) return;
  const [c0, c1] = at(fence.file);
  if (content.some((l) => l.trim())) {
    push(line, c0, c1, 'warning', 'fence/embed-body', 'This code block embeds a file, so its own content is ignored. Leave the block empty.');
  }
  if (options.readFile) {
    const text = options.readFile(fence.file);
    if (text === undefined) {
      push(line, c0, c1, 'error', 'fence/embed-missing', `Cannot embed "${fence.file}": the file does not exist or is outside the workspace.`);
    } else if (fence.lines && sliceLines(text, fence.lines).outOfRange) {
      const total = text.replace(/\n$/, '').split(/\r?\n/).length;
      push(line, ...at(fence.linesRaw ?? 'lines='), 'error', 'fence/range', `lines="${fence.linesRaw}" is outside "${fence.file}", which has ${total} lines.`);
    }
  } else if (options.fileExists && !options.fileExists(fence.file)) {
    push(line, c0, c1, 'error', 'fence/embed-missing', `Cannot embed "${fence.file}": the file does not exist.`);
  }
}

/** Apply every diagnostic fix to the text (bottom-up, skipping overlaps). Returns the new text and the count applied. */
export function applyFixes(text: string, diagnostics: Diagnostic[]): { text: string; applied: number } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const fixes = diagnostics
    .map((d) => d.fix)
    .filter((f): f is Fix => !!f)
    .sort((a, b) => b.line - a.line || b.column - a.column);
  let applied = 0;
  let last: Fix | undefined;
  for (const f of fixes) {
    if (last && last.line === f.line && f.endColumn > last.column) continue; // overlapping
    const l = lines[f.line] ?? '';
    const replaced = l.slice(0, f.column) + f.replacement + l.slice(f.endColumn);
    lines.splice(f.line, 1, ...replaced.split('\n'));
    applied++;
    last = f;
  }
  return { text: lines.join(eol), applied };
}
