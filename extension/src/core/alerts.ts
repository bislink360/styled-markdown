import type { StateCore, Token } from 'markdown-it';
import { emptyAttrs } from './attrs';
import type { ContainerMeta } from './markdownItRules';

/**
 * GitHub alerts (`> [!NOTE]`, spec §3.8): a blockquote whose first line is only a marker renders as the matching
 * callout. GitHub's five kinds and their callouts; IMPORTANT is `info`, as `smd from-md` converts it.
 */
export const GITHUB_ALERTS: Readonly<Record<string, string>> = {
  NOTE: 'note', TIP: 'tip', IMPORTANT: 'info', WARNING: 'warning', CAUTION: 'danger',
};

/** The marker, in any case, alone on the first line of the blockquote's first paragraph (trailing blanks allowed). */
const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*$/i;

/** The callout of a GitHub alert marker line (`[!WARNING]` → `warning`), or undefined. */
export function alertCallout(line: string): string | undefined {
  const m = MARKER.exec(line);
  return m ? GITHUB_ALERTS[m[1].toUpperCase()] : undefined;
}

/** A blockquote that is an alert: rendered as a callout container of its own (see renderContainer). */
export interface AlertMeta extends ContainerMeta {
  /** The marker's kind as written, upper-cased: `NOTE`, `IMPORTANT`… */
  alert: string;
  /** The marker's line, in the lines the tokens were parsed from. */
  markerLine: number;
}

/** The alert a `blockquote_open` or `blockquote_close` token is, if any. */
export function alertOf(token: Token): AlertMeta | undefined {
  const meta = token.meta as Partial<AlertMeta> | null;
  return meta?.alert ? (meta as AlertMeta) : undefined;
}

/** Core rule: mark the alerts of a document (see markAlerts). */
export function githubAlerts(state: StateCore): void {
  if (!state.inlineMode) markAlerts(state.tokens);
}

/**
 * Mark the blockquotes of `tokens` that are GitHub alerts and take their marker out of the text. As on GitHub, an
 * alert is not nested in other blocks (a list, a quote), though it may be inside `:::` containers, which GitHub
 * doesn't see; and it has a body, so a quote holding only the marker stays a quote. Runs before inline parsing.
 */
export function markAlerts(tokens: Token[]): void {
  const open: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.nesting === -1) open.pop();
    if (t.nesting !== 1) continue;
    if (t.type === 'blockquote_open' && open.every((type) => type === 'container_smd_open')) markAlert(tokens, i);
    open.push(t.type);
  }
}

function markAlert(tokens: Token[], at: number): void {
  const [paragraph, inline, paragraphClose] = tokens.slice(at + 1, at + 4);
  if (paragraph?.type !== 'paragraph_open' || inline?.type !== 'inline' || !paragraph.map) return;
  const content = inline.content;
  const lineEnd = content.indexOf('\n');
  const callout = alertCallout(lineEnd < 0 ? content : content.slice(0, lineEnd));
  if (!callout) return;
  const rest = lineEnd < 0 ? '' : content.slice(lineEnd + 1).trimStart();
  const close = closingQuote(tokens, at);
  // Only the marker: the paragraph is all there is.
  if (!rest && close === at + 4) return;
  const meta: AlertMeta = {
    name: callout, attrs: emptyAttrs(), title: '', close: '', alert: content.slice(2, content.indexOf(']')).toUpperCase(), markerLine: paragraph.map[0],
  };
  tokens[at].meta = meta;
  if (close < tokens.length) tokens[close].meta = meta;
  if (rest) {
    // The paragraph goes on from the line after the marker.
    inline.content = rest;
    for (const t of [paragraph, inline, paragraphClose]) if (t.map) t.map = [t.map[0] + 1, t.map[1]];
  } else {
    tokens.splice(at + 1, 3);
  }
}

/** The index of the `blockquote_close` of the blockquote opened at `open`. */
function closingQuote(tokens: Token[], open: number): number {
  let depth = 0;
  for (let j = open + 1; j < tokens.length; j++) {
    if (tokens[j].type === 'blockquote_open') depth++;
    else if (tokens[j].type === 'blockquote_close' && depth-- === 0) return j;
  }
  return tokens.length;
}
