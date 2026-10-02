/**
 * Completion and hover for the language server, from the core's spec tables and link helpers. No editor
 * or Node APIs: files are reached through the `AssistEnv` callbacks, and columns are UTF-16 indices
 * (the server converts them to the client's position encoding).
 */
import {
  CONTAINERS, FONT_VALUES, FRONTMATTER_SCHEMA, INLINE_DIRECTIVES, MERMAID_TYPES, NAMED_COLORS, SIZE_VALUES, STYLE_KEYS, ALIGN_VALUES,
  TEXT_STYLE_VALUES, WEIGHT_VALUES, frontMatterValues, parseFrontMatter,
} from './core';
import { footnoteAt, footnoteLabelPrefix, footnoteLabels, footnoteText } from './core/footnotes';
import { frontMatterProperty } from './core/frontmatterSchema';
import { anchorTargets, findLinks, isDocumentPath, linkAt, linkCompletionContext, splitTarget, type LinkCompletionContext } from './core/links';
import { documentPreview, embedPreview, sectionExcerpt } from './core/symbols';

/** LSP CompletionItemKind values used here. */
export const COMPLETION_KIND = {
  function: 3, module: 9, property: 10, value: 12, keyword: 14, color: 16, file: 17, reference: 18, folder: 19, enumMember: 20,
} as const;

export interface AssistItem {
  label: string;
  kind: number;
  detail?: string;
  documentation?: string;
  /** Text to insert instead of the label. */
  insertText?: string;
  sortText?: string;
}

/** Items that replace the text from column `from` to the cursor. */
export interface Completion {
  from: number;
  items: AssistItem[];
}

export interface FolderEntry { name: string; isDirectory: boolean }

/** How completion and hover reach other files, relative to the current document. */
export interface AssistEnv {
  /** A linked document's text (open or on disk), by a path relative to the current document. */
  readDocument?: (relativePath: string) => string | undefined;
  /** A folder's entries, by a path relative to the current document; the document itself is left out. */
  listFolder?: (relativePath: string) => FolderEntry[];
  /** A code embed's contents, by a path relative to the current document. */
  readFile?: (relativePath: string) => string | undefined;
  /** Today as YYYY-MM-DD, offered for date keys. */
  today?: string;
}

interface Cursor {
  text: string;
  lines: string[];
  line: number;
  column: number;
  /** The line's text before the cursor. */
  prefix: string;
}

const ATTR_VALUES: Record<string, string[]> = {
  color: [...NAMED_COLORS], bg: [...NAMED_COLORS], border: [...NAMED_COLORS], accent: [...NAMED_COLORS],
  size: Object.keys(SIZE_VALUES), weight: Object.keys(WEIGHT_VALUES), font: Object.keys(FONT_VALUES),
  align: ALIGN_VALUES, style: Object.keys(TEXT_STYLE_VALUES), collapsible: ['open'],
};

const FENCE_LANGUAGES = ['mermaid', 'math', 'ts', 'js', 'json', 'yaml', 'bash', 'python', 'go', 'sql', 'diff'];

const CONTAINER_LINE = /^(\s*:{3,}\s*)([\w-]+)/;
const NAME_CHAR = /[\w-]/;

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

type Provider = (cursor: Cursor, env: AssistEnv) => Completion | undefined;

/** In order: the first provider that recognizes the context answers. */
const PROVIDERS: Provider[] = [
  linkCompletion, footnoteCompletion, frontMatterCompletion, attributeCompletion, containerCompletion, fenceCompletion, directiveCompletion,
  mermaidCompletion,
];

/** Completions at a zero-based line and UTF-16 column, or undefined when nothing fits there. */
export function completionsAt(text: string, line: number, column: number, env: AssistEnv = {}): Completion | undefined {
  const lines = text.split(/\r?\n/);
  const cursor: Cursor = { text, lines, line, column, prefix: (lines[line] ?? '').slice(0, column) };
  for (const provider of PROVIDERS) {
    const found = provider(cursor, env);
    if (found) return found;
  }
  return undefined;
}

/** Paths and `#anchors` for links, `related:` entries and `file="…"` embeds. */
function linkCompletion(cursor: Cursor, env: AssistEnv): Completion | undefined {
  const ctx = linkCompletionContext(cursor.text, cursor.line, cursor.column);
  if (!ctx) return undefined;
  const hash = ctx.kind === 'embed' ? -1 : ctx.target.indexOf('#');
  if (hash >= 0) {
    const rel = ctx.target.slice(0, hash);
    const target = rel ? linkedText(rel, env) : cursor.text;
    return { from: ctx.column + hash + 1, items: target === undefined ? [] : anchorItems(target, '') };
  }
  const slash = ctx.target.lastIndexOf('/');
  const items = pathItems(ctx, decodePath(ctx.target.slice(0, slash + 1)), env);
  // An empty link target can also point into this document.
  if (ctx.kind === 'link' && ctx.target === '') items.push(...anchorItems(cursor.text, '#'));
  return { from: ctx.column + slash + 1, items };
}

/** The document's footnote labels after `[^`. */
function footnoteCompletion(cursor: Cursor): Completion | undefined {
  const typed = footnoteLabelPrefix(cursor.prefix);
  if (typed === undefined) return undefined;
  const items = footnoteLabels(cursor.text).map((label) => ({ label, kind: COMPLETION_KIND.reference }));
  return items.length ? { from: cursor.column - typed.length, items } : undefined;
}

function linkedText(rel: string, env: AssistEnv): string | undefined {
  return isDocumentPath(rel) ? env.readDocument?.(decodePath(rel)) : undefined;
}

function pathItems(ctx: LinkCompletionContext, folder: string, env: AssistEnv): AssistItem[] {
  const items: AssistItem[] = [];
  for (const entry of env.listFolder?.(folder) ?? []) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const isDoc = !entry.isDirectory && isDocumentPath(entry.name);
    if (ctx.kind === 'related' && !entry.isDirectory && !isDoc) continue;
    const name = ctx.kind === 'link' ? entry.name.replace(/ /g, '%20') : entry.name;
    items.push({
      label: entry.isDirectory ? `${entry.name}/` : entry.name,
      kind: entry.isDirectory ? COMPLETION_KIND.folder : COMPLETION_KIND.file,
      insertText: entry.isDirectory ? `${name}/` : name,
      sortText: `${pathRank(entry.isDirectory, isDoc)}${entry.name.toLowerCase()}`,
    });
  }
  return items;
}

/** Documents first, then folders, then other files. */
function pathRank(isDirectory: boolean, isDoc: boolean): number {
  if (isDoc) return 0;
  return isDirectory ? 1 : 2;
}

function anchorItems(text: string, prefix: string): AssistItem[] {
  return anchorTargets(text).map((t, i) => ({
    label: `${prefix}${t.id}`,
    kind: COMPLETION_KIND.reference,
    detail: anchorDetail(t.text, t.level, t.line),
    sortText: `3${String(i).padStart(5, '0')}`,
  }));
}

function anchorDetail(text: string | undefined, level: number | undefined, line: number | undefined): string {
  if (text !== undefined) return `${'#'.repeat(level ?? 1)} ${text}`;
  return line === undefined ? 'id' : `id on line ${line + 1}`;
}

/** Front matter keys and values, from the front matter schema. Inside front matter nothing else is offered. */
function frontMatterCompletion(cursor: Cursor, env: AssistEnv): Completion | undefined {
  const fm = parseFrontMatter(cursor.text);
  if (!fm.present || cursor.line === 0 || cursor.line >= fm.bodyStartLine - 1) return undefined;
  const value = /^([\w-]+):\s*(\S*)$/.exec(cursor.prefix);
  if (value) return { from: cursor.column - value[2].length, items: frontMatterValueItems(value[1], env) };
  if (!/^\w*$/.test(cursor.prefix)) return { from: cursor.column, items: [] };
  const present = new Set(Object.keys(fm.data));
  const items = Object.entries(FRONTMATTER_SCHEMA.properties).filter(([key]) => !present.has(key)).map(([key, prop], i) => ({
    label: key, kind: COMPLETION_KIND.property, insertText: `${key}: `, documentation: prop.description, sortText: String(i).padStart(2, '0'),
  }));
  return { from: 0, items };
}

function frontMatterValueItems(key: string, env: AssistEnv): AssistItem[] {
  if (frontMatterProperty(key)?.format === 'date') {
    const today = env.today ?? new Date().toISOString().slice(0, 10);
    return [{ label: today, kind: COMPLETION_KIND.value, detail: 'Today' }];
  }
  const kind = key === 'accent' ? COMPLETION_KIND.color : COMPLETION_KIND.enumMember;
  return frontMatterValues(key).map((label) => ({ label, kind }));
}

/** Attribute keys and values inside `{…}` on a container line or after an inline directive. */
function attributeCompletion(cursor: Cursor): Completion | undefined {
  const { prefix, column } = cursor;
  const brace = prefix.lastIndexOf('{');
  if (brace < 0 || brace < prefix.lastIndexOf('}')) return undefined;
  const container = /^\s*:{3,}\s*([\w-]+)\{/.exec(prefix)?.[1];
  const directive = directiveBefore(prefix, brace);
  const inside = prefix.slice(brace + 1);
  const value = attributeValueAt(inside);
  if (value) return { from: column - value.value.length, items: attributeValueItems(value.key, container, directive) };
  const typed = trailing(inside, NAME_CHAR);
  return { from: column - typed.length, items: attributeKeyItems(container, directive) };
}

/** The inline directive whose `{` is at `brace`: `:name{` or `:name[content]{`. */
function directiveBefore(prefix: string, brace: number): string | undefined {
  const end = prefix[brace - 1] === ']' ? prefix.lastIndexOf('[', brace - 1) : brace;
  const name = end < 0 ? '' : trailing(prefix.slice(0, end), NAME_CHAR);
  return /^[a-z]/.test(name) && prefix[end - name.length - 1] === ':' ? name : undefined;
}

/** The `key=value` being typed at the end of an attribute list (the value may be empty, or opened by a quote). */
function attributeValueAt(inside: string): { key: string; value: string } | undefined {
  const value = trailing(inside, /[^\s"'=]/);
  let equals = inside.length - value.length - 1;
  if (inside[equals] === '"' || inside[equals] === "'") equals--;
  if (inside[equals] !== '=') return undefined;
  const key = trailing(inside.slice(0, equals), NAME_CHAR);
  return key ? { key, value } : undefined;
}

function attributeValueItems(key: string, container: string | undefined, directive: string | undefined): AssistItem[] {
  const own = container ? CONTAINERS[container]?.values?.[key] : undefined;
  const values = own ?? (directive ? INLINE_DIRECTIVES[directive]?.values?.[key] : undefined) ?? ATTR_VALUES[key] ?? [];
  return values.map((label) => ({ label, kind: (NAMED_COLORS as readonly string[]).includes(label) ? COMPLETION_KIND.color : COMPLETION_KIND.enumMember }));
}

function attributeKeyItems(container: string | undefined, directive: string | undefined): AssistItem[] {
  let keys = Object.keys(STYLE_KEYS);
  if (container && CONTAINERS[container]) keys = [...(CONTAINERS[container].attrs ?? []), ...keys];
  else if (directive && INLINE_DIRECTIVES[directive]) keys = INLINE_DIRECTIVES[directive].attrs;
  return keys.map((key) => ({ label: key, kind: COMPLETION_KIND.property, insertText: `${key}=`, documentation: STYLE_KEYS[key] }));
}

/** Container names after `:::`. */
function containerCompletion(cursor: Cursor): Completion | undefined {
  const open = /^\s*:{3,}\s*([\w-]*)$/.exec(cursor.prefix);
  if (!open) return undefined;
  const items = Object.entries(CONTAINERS).map(([name, spec], i) => ({
    label: name, kind: COMPLETION_KIND.module, documentation: spec.description, sortText: String(i).padStart(2, '0'),
  }));
  return { from: cursor.column - open[1].length, items };
}

/** Diagram and code languages after a fence. */
function fenceCompletion(cursor: Cursor): Completion | undefined {
  const fence = /^\s*(?:`{3,}|~{3,})(\w*)$/.exec(cursor.prefix);
  if (!fence) return undefined;
  const items = FENCE_LANGUAGES.map((label) => ({
    label, kind: label === 'mermaid' || label === 'math' ? COMPLETION_KIND.keyword : COMPLETION_KIND.value,
  }));
  return { from: cursor.column - fence[1].length, items };
}

/** Inline directive names after `:`. */
function directiveCompletion(cursor: Cursor): Completion | undefined {
  const typed = trailing(cursor.prefix, /[a-z]/);
  const colon = cursor.prefix.length - typed.length - 1;
  // The colon starts the line or follows a space, bracket, quote mark or emphasis.
  if (cursor.prefix[colon] !== ':' || (colon > 0 && !/[\s(>*_-]/.test(cursor.prefix[colon - 1]))) return undefined;
  const items = Object.entries(INLINE_DIRECTIVES).map(([name, spec]) => ({
    label: name, kind: COMPLETION_KIND.function, detail: spec.example, documentation: spec.description,
  }));
  return { from: cursor.column - typed.length, items };
}

/** Mermaid diagram types on the first line of a mermaid fence. */
function mermaidCompletion(cursor: Cursor): Completion | undefined {
  const typed = /^\s*(\w*)$/.exec(cursor.prefix);
  if (!typed || cursor.line === 0 || !/^\s*```\s*mermaid/.test(cursor.lines[cursor.line - 1])) return undefined;
  return { from: cursor.column - typed[1].length, items: MERMAID_TYPES.map((label) => ({ label, kind: COMPLETION_KIND.keyword })) };
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

/** Markdown to show, and the span on the hovered line it describes (UTF-16 columns). */
export interface AssistHover {
  markdown: string;
  start?: number;
  end?: number;
}

/** What the text at a zero-based line and UTF-16 column is: a container, directive, link or code embed. */
export function hoverAt(text: string, line: number, column: number, env: AssistEnv = {}): AssistHover | undefined {
  const lineText = text.split(/\r?\n/)[line] ?? '';
  return containerHover(lineText, column) ?? directiveHover(lineText, column) ?? footnoteHover(text, line, column)
    ?? linkHover(text, line, column, env) ?? embedHover(lineText, env);
}

function containerHover(lineText: string, column: number): AssistHover | undefined {
  const container = CONTAINER_LINE.exec(lineText);
  const spec = container && CONTAINERS[container[2]];
  if (!container || !spec) return undefined;
  const start = container[1].length;
  const end = start + container[2].length;
  if (column < start || column > end) return undefined;
  const attrs = spec.attrs?.length ? `\n\nAttributes: \`${spec.attrs.join('`, `')}\` + style attributes` : '';
  return { markdown: `**:::${container[2]}** — ${spec.description}${attrs}`, start, end };
}

function directiveHover(lineText: string, column: number): AssistHover | undefined {
  for (const match of lineText.matchAll(/:[a-z][\w-]*/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (column < start || column > end) continue;
    const name = match[0].slice(1);
    const spec = INLINE_DIRECTIVES[name];
    return spec ? { markdown: `**:${name}** — ${spec.description}\n\n\`${spec.example}\``, start, end } : undefined;
  }
  return undefined;
}

/** Preview what a link points at: the start of a section, or a linked document's title and outline. */
function linkHover(text: string, line: number, column: number, env: AssistEnv): AssistHover | undefined {
  const hit = linkAt(text, line, column) ?? linkTextAt(text, line, column);
  const parts = hit && splitTarget(hit.link.target);
  if (!hit || !parts) return undefined;
  let target = text;
  let where = '';
  if (parts.path) {
    const other = isDocumentPath(parts.path) ? env.readDocument?.(parts.path) : undefined;
    if (other === undefined) return undefined;
    target = other;
    where = parts.path.split('/').pop() ?? parts.path;
  }
  const markdown = parts.anchor ? sectionMarkdown(target, parts.anchor, where) : documentMarkdown(target, where);
  return markdown === undefined ? undefined : { markdown, start: hit.start, end: hit.end };
}

function documentMarkdown(text: string, where: string): string {
  const doc = documentPreview(text);
  const parts = [`**${escapeMarkdown(doc.title ?? where)}**${doc.status ? ` · ${escapeMarkdown(doc.status)}` : ''}`];
  if (doc.summary) parts.push(doc.summary);
  if (doc.sections.length) parts.push(`Sections: ${doc.sections.map(escapeMarkdown).join(' · ')}`);
  return parts.join('\n\n');
}

function sectionMarkdown(text: string, anchor: string, where: string): string | undefined {
  const section = sectionExcerpt(text, anchor);
  if (!section) return undefined;
  const title = section.title === undefined ? '' : `**${escapeMarkdown(section.title)}**${where ? ` — ${escapeMarkdown(where)}` : ''}\n\n---\n\n`;
  return `${title}${section.lines.join('\n')}${section.truncated ? '\n\n…' : ''}`;
}

/** An inline link whose `[text]` is under the cursor, so hovering the visible text previews it too. */
function linkTextAt(text: string, line: number, column: number): ReturnType<typeof linkAt> {
  const lineText = text.split(/\r?\n/)[line] ?? '';
  for (const link of findLinks(text).links) {
    if (link.kind !== 'inline' || link.line !== line) continue;
    const open = openingBracket(lineText, link.column - 3);
    if (open >= 0 && column >= open && column < link.column - 1) {
      return { link, start: open, end: link.column + link.target.length + 1, reference: false };
    }
  }
  return undefined;
}

/** The `[` that opens the link text ending at `from` (the character before `](`), allowing nested brackets. */
function openingBracket(lineText: string, from: number): number {
  let depth = 0;
  for (let i = from; i >= 0; i--) {
    if (lineText[i] === ']') depth++;
    else if (lineText[i] === '[' && depth === 0) return i;
    else if (lineText[i] === '[') depth--;
  }
  return -1;
}

/** A footnote reference `[^1]` previews its definition. */
function footnoteHover(text: string, line: number, column: number): AssistHover | undefined {
  const hit = footnoteAt(text, line, column);
  if (!hit) return undefined;
  return { markdown: `**[^${escapeMarkdown(hit.definition.raw)}]**\n\n${footnoteText(text, hit.definition)}`, start: hit.start, end: hit.end };
}

/** Preview the code a ```lang file="…" lines="…"``` fence embeds. */
function embedHover(lineText: string, env: AssistEnv): AssistHover | undefined {
  const embed = embedPreview(lineText, env.readFile);
  if (!embed) return undefined;
  const heading = `**${escapeMarkdown(embed.file)}**${embed.lines ? ` · lines ${embed.lines[0]}–${embed.lines[1]}` : ''}`;
  if (embed.problem) return { markdown: `${heading}\n\n${escapeMarkdown(embed.problem)}` };
  // Longer than any backtick run in the code, so the code can't close the fence.
  const longest = Math.max(0, ...(embed.code?.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return { markdown: `${heading}\n\n${fence}${embed.lang}\n${embed.code ?? ''}\n${fence}${embed.truncated ? '\n…' : ''}` };
}

/** The characters at the end of `text` that each match `allowed` (a scan, not a `…*$` regex, so it stays linear). */
function trailing(text: string, allowed: RegExp): string {
  let start = text.length;
  while (start > 0 && allowed.test(text[start - 1])) start--;
  return text.slice(start);
}

const escapeMarkdown = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

function decodePath(p: string): string {
  try { return decodeURIComponent(p); } catch { return p; }
}
