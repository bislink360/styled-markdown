import type { Renderer, StateCore, Token } from 'markdown-it';
import { escapeHtml } from './attrs';
import { dateSuffix, isIsoDate, splitEntry } from './changelog';
import type { ContainerMeta } from './markdownItRules';

/**
 * The changelog pass of the markdown-it plugin. Inside a `:::changelog`, the headings at the highest level
 * used directly in it are release entries: each starts an `<li class="smd-changelog-entry">` of an
 * `<ol class="smd-changelog-list">`, in the order written, and its version and date are marked up,
 * `<span class="smd-changelog-version">1.2.0</span> — <time class="smd-changelog-date" datetime="2026-03-01">…</time>`.
 * The headings stay headings with the ids and outline entries they have anywhere else. Text before the first
 * entry stays above the list. A document without a changelog keeps its tokens as they are.
 */

const isChangelogOpen = (t: Token) => t.type === 'container_smd_open' && (t.meta as ContainerMeta | null)?.name === 'changelog';

export function changelogEntries(state: StateCore): void {
  if (state.inlineMode || !state.tokens.some(isChangelogOpen)) return;
  const tokens = state.tokens;
  // Last block first, so a nested changelog is wrapped before the one around it is searched.
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (isChangelogOpen(tokens[i])) wrapEntries(state, i);
  }
}

/** The tokens of the changelog opened at `start` with its entries wrapped in list items. */
function wrapEntries(state: StateCore, start: number): void {
  const tokens = state.tokens;
  const open = tokens[start];
  const end = tokens.findIndex((t, i) => i > start && t.type === 'container_smd_close' && t.level === open.level);
  const close = end < 0 ? tokens.length : end;
  const headings = tokens.slice(start + 1, close).filter((t) => t.type === 'heading_open' && t.level === open.level + 1);
  if (!headings.length) return;
  const tag = headings.map((h) => h.tag).sort((a, b) => a.localeCompare(b))[0];
  const entries = new Set(headings.filter((h) => h.tag === tag));
  const level = open.level + 1;
  const body: Token[] = [];
  let first = true;
  for (const token of tokens.slice(start + 1, close)) {
    if (entries.has(token)) {
      if (first) body.push(marker(state, 'smd_changelog_list_open', 'ol', 1, level));
      else body.push(marker(state, 'smd_changelog_entry_close', 'li', -1, level + 1));
      body.push(marker(state, 'smd_changelog_entry_open', 'li', 1, level + 1));
      first = false;
    }
    body.push(token);
  }
  body.push(marker(state, 'smd_changelog_entry_close', 'li', -1, level + 1), marker(state, 'smd_changelog_list_close', 'ol', -1, level));
  for (const heading of entries) markEntry(state, tokens[tokens.indexOf(heading) + 1]);
  tokens.splice(start + 1, close - start - 1, ...body);
}

function marker(state: StateCore, type: string, tag: string, nesting: 1 | -1, level: number): Token {
  const token = new state.Token(type, tag, nesting);
  token.block = true;
  token.level = level;
  return token;
}

/**
 * `1.2.0 — 2026-03-01` → the version in a span, then the separator, then the date as a `<time>` (a plain span
 * when it is not a date). The text is split, never changed, so hosts that make ids from it get the same ids.
 */
function markEntry(state: StateCore, inline: Token | undefined): void {
  const children = inline?.children;
  if (!inline || !children) return;
  joinTrailingText(children);
  // The heading's text after `{{name}}` values are in, which may hold the date.
  const date = splitEntry(children.map((c) => (c.type === 'text' || c.type === 'code_inline' ? c.content : '')).join('')).date;
  const last = children.at(-1);
  const suffix = date && last?.type === 'text' ? dateSuffix(last.content) : undefined;
  const version = [new state.Token('smd_changelog_version_open', 'span', 1), new state.Token('smd_changelog_version_close', 'span', -1)];
  if (!last || !suffix || suffix.date !== date) {
    inline.children = [version[0], ...children, version[1]];
    return;
  }
  const content = last.content;
  const at = content.lastIndexOf(suffix.date);
  const text = (s: string) => Object.assign(new state.Token('text', '', 0), { content: s });
  const dateToken = Object.assign(new state.Token('smd_changelog_date', 'time', 0), { content: suffix.date });
  const rest = [text(content.slice(suffix.at, at)), dateToken, text(content.slice(at + suffix.date.length))].filter((t) => t.content);
  last.content = content.slice(0, suffix.at);
  inline.children = [version[0], ...children.filter((c) => c !== last || c.content), version[1], ...rest];
}

/** Join the text tokens that end a heading (a `{{name}}` value is a token of its own), so a date split across them is one. */
function joinTrailingText(children: Token[]): void {
  let first = children.length;
  while (first > 0 && children[first - 1].type === 'text') first--;
  if (children.length - first < 2) return;
  children[first].content = children.slice(first).map((c) => c.content).join('');
  children.splice(first + 1);
}

/** Register the HTML of the tokens above. */
export function addChangelogRules(rules: Renderer['rules']): void {
  rules.smd_changelog_list_open = () => '<ol class="smd-changelog-list">\n';
  rules.smd_changelog_list_close = () => '</ol>\n';
  rules.smd_changelog_entry_open = () => '<li class="smd-changelog-entry">\n';
  rules.smd_changelog_entry_close = () => '</li>\n';
  rules.smd_changelog_version_open = () => '<span class="smd-changelog-version">';
  rules.smd_changelog_version_close = () => '</span>';
  rules.smd_changelog_date = (tokens, idx) => changelogDate(tokens[idx].content);
}

/** A valid date as `<time datetime>`; anything else as written, marked so it can be told apart. */
export function changelogDate(date: string): string {
  const text = escapeHtml(date);
  if (isIsoDate(date)) return `<time class="smd-changelog-date" datetime="${text}">${text}</time>`;
  return `<span class="smd-changelog-date smd-changelog-date-invalid">${text}</span>`;
}
