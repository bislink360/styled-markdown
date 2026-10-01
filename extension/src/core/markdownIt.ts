import type MarkdownIt from 'markdown-it';
import { applySmd, hostContext, smdFeatures } from './markdownItSetup';

/**
 * Styled Markdown as a markdown-it plugin, for any markdown-it host (13 or 14):
 *
 *   import MarkdownIt from 'markdown-it';
 *   import smd from 'styled-markdown/markdown-it';
 *   const md = new MarkdownIt().use(smd);
 *
 * The plugin only adds rules to the host's instance: it never creates its own, keeps the host's
 * options (raw HTML stays as the host set it) and wraps the host's code block renderer. renderSmd
 * builds its markdown-it instance with the same rules.
 */
export interface MarkdownItSmdOptions {
  /** `:::name{attrs} Title … :::` block containers: callouts, cards, tabs, decisions, risks, APIs… Default true. */
  containers?: boolean;
  /** Inline directives: `:badge[…]`, `:kbd[…]`, `:progress[…]`, `:due[…]`, `:metric[…]`, `:status[…]`… Default true. */
  directives?: boolean;
  /** Attribute lists: `[text]{color=red .muted}` spans and `## Heading {#id .class}`. Default true. */
  attributes?: boolean;
  /** `==highlighted==` text. Default true. */
  mark?: boolean;
  /** `$inline$` and `$$display$$` math, rendered with KaTeX (the host page needs the KaTeX stylesheet). Default true. */
  math?: boolean;
  /** GFM task lists (`- [ ]`, `- [x]`) as checkboxes. Default true. */
  tasks?: boolean;
  /**
   * Fenced code: ```` ```mermaid ```` diagrams, ```` ```math ```` blocks, and `title="…"`, `file="…"` and `{2,5-7}`
   * line highlights on code blocks. Other code blocks are left to the host. Default true.
   */
  fences?: boolean;
  /** Frame every code block like the .smd preview, with a language label. Default false. */
  codeFrames?: boolean;
  /** Give headings ids from their text (`#getting-started`, `#setup-1`), as renderSmd does. Default false. */
  headingIds?: boolean;
  /** Add `data-line` source line numbers to block elements, as the .smd preview does. Default false. */
  sourceLines?: boolean;
  /** Render `---` YAML front matter as the .smd document header (title, status, owners, tags). Default false. */
  frontMatter?: boolean;
  /** How `:::agent` blocks are shown to human readers. Default `collapsed`. */
  agentBlocks?: 'collapsed' | 'expanded' | 'hidden';
  /**
   * Read a file for ```` ```lang file="…" ```` embeds, relative to the document being rendered (`env` is the
   * env passed to `md.render`). Return undefined when the file is missing or not allowed. Without it, embeds
   * show "Cannot read".
   */
  readFile?: (relativePath: string, env: unknown) => string | undefined;
  /** "Today" as YYYY-MM-DD, for `:due[]` states. Defaults to the current date. */
  today?: string;
}

/** Add Styled Markdown syntax to a markdown-it instance. Using it twice on one instance has no further effect. */
export function markdownItSmd(md: MarkdownIt, options: MarkdownItSmdOptions = {}): void {
  applySmd(md, smdFeatures(options), hostContext(md, options));
}

export default markdownItSmd;

