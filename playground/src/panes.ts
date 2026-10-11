/**
 * Everything the playground shows for a document, computed without the DOM so it can be tested in Node.
 * The playground has no file system: no `readFile` is passed, so `:::include` blocks and `file="…"` code embeds
 * render their fallback notes instead of reading anything.
 */
import { agentView } from '../../extension/src/core/agentView';
import { mermaidBlocks } from '../../extension/src/core/mermaid';
import { renderSmd } from '../../extension/src/core/render';
import { smdToMarkdown } from '../../extension/src/core/toMarkdown';
import { validateSmd, type Diagnostic } from '../../extension/src/core/validate';

export interface PreviewPane {
  /** The rendered `<article>`; only ever shown inside the sandboxed preview frame. */
  html: string;
  lang: string;
  /** The front matter `theme` when it is `light` or `dark`. */
  theme?: 'light' | 'dark';
  /** The document has Mermaid diagrams, so the frame loads Mermaid. */
  mermaid: boolean;
}

export interface AgentPane {
  text: string;
  /** Approximate tokens (≈ characters / 4) of the agent view and of the source. */
  tokens: number;
  originalTokens: number;
}

export interface Panes {
  preview: PreviewPane;
  agent: AgentPane;
  /** Sorted by line, then column. */
  diagnostics: Diagnostic[];
  markdown: string;
}

export interface PaneOptions {
  /** "Today" as YYYY-MM-DD, for due dates and stale checks (tests pin it). */
  today?: string;
}

function themeOf(value: unknown): PreviewPane['theme'] {
  return value === 'light' || value === 'dark' ? value : undefined;
}

/** Shown in a pane when computing it failed, so one failing view doesn't blank the others. */
function failure(view: string, error: unknown): string {
  return `The ${view} could not be produced: ${error instanceof Error ? error.message : String(error)}`;
}

export function previewPane(text: string, options: PaneOptions = {}): PreviewPane {
  try {
    const result = renderSmd(text, { allowHtml: true, today: options.today });
    return { html: result.html, lang: result.lang ?? 'en', theme: themeOf(result.frontMatter.theme), mermaid: mermaidBlocks(text).length > 0 };
  } catch (error) {
    // The message is text, not markup: escape it before it becomes part of the frame's HTML.
    const message = failure('preview', error).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return { html: `<article class="smd-doc"><p class="smd-error">${message}</p></article>`, lang: 'en', mermaid: false };
  }
}

export function agentPane(text: string, options: PaneOptions = {}): AgentPane {
  try {
    const view = agentView(text, { today: options.today });
    return { text: view.text, tokens: view.tokens, originalTokens: view.originalTokens };
  } catch (error) {
    return { text: failure('agent view', error), tokens: 0, originalTokens: 0 };
  }
}

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return a.line - b.line || a.column - b.column;
}

export function diagnosticsPane(text: string, options: PaneOptions = {}): Diagnostic[] {
  try {
    return validateSmd(text, { today: options.today }).sort(compareDiagnostics);
  } catch (error) {
    return [{ line: 0, column: 0, endColumn: 1, severity: 'error', code: 'playground/internal', message: failure('validation', error) }];
  }
}

export function markdownPane(text: string): string {
  try {
    return smdToMarkdown(text);
  } catch (error) {
    return failure('Markdown export', error);
  }
}

/** All four panes for a document. */
export function renderPanes(text: string, options: PaneOptions = {}): Panes {
  return {
    preview: previewPane(text, options),
    agent: agentPane(text, options),
    diagnostics: diagnosticsPane(text, options),
    markdown: markdownPane(text),
  };
}

/** "3 errors, 1 warning" for the Diagnostics tab; "No problems" when there are none. */
export function diagnosticsSummary(diagnostics: Diagnostic[]): string {
  if (!diagnostics.length) return 'No problems';
  const counts = new Map<string, number>();
  for (const d of diagnostics) counts.set(d.severity, (counts.get(d.severity) ?? 0) + 1);
  const order: Diagnostic['severity'][] = ['error', 'warning', 'info', 'hint'];
  return order
    .filter((s) => counts.has(s))
    .map((s) => {
      const n = counts.get(s) ?? 0;
      return `${n} ${s}${n === 1 ? '' : 's'}`;
    })
    .join(', ');
}
