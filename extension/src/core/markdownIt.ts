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
  /**
   * `:::name{attrs} Title … :::` block containers: callouts, cards, tabs, decisions, risks, APIs, numbered figures, glossaries, changelogs, quotes…
   * Figure numbers are kept on the render's `env` as `smdFigures` for `:ref[id]`. Default true.
   */
  containers?: boolean;
  /**
   * Glossaries: the `**Term**: definition` list of a `:::glossary` block renders as a `<dl>`, and the first use of
   * each term in every section links to its definition with the definition as a tooltip (`<abbr title>` for
   * abbreviations). Needs `containers`. Default true.
   */
  glossary?: boolean;
  /** Inline directives: `:badge[…]`, `:kbd[…]`, `:progress[…]`, `:due[…]`, `:metric[…]`, `:status[…]`, `:ref[…]`… Default true. */
  directives?: boolean;
  /** Attribute lists: `[text]{color=red .muted}` spans and `## Heading {#id .class}`. Default true. */
  attributes?: boolean;
  /** `==highlighted==` text. Default true. */
  mark?: boolean;
  /** `$inline$` and `$$display$$` math, rendered with KaTeX (the host page needs the KaTeX stylesheet). Default true. */
  math?: boolean;
  /**
   * GitHub-style footnotes: `[^1]` references and `[^1]: text` definitions, collected into a numbered
   * footnotes section at the end. Default true. Left to the host when markdown-it-footnote was added
   * to the instance before this plugin; set it to false to keep markdown-it-footnote added after it.
   */
  footnotes?: boolean;
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
  /**
   * Front matter variables: `{{version}}` in text shows the value of the front matter key `version`
   * (`{{owner.name}}` for nested keys); names the front matter doesn't define stay as written. The front
   * matter is read from the source; a host that removes it first can pass its data as `env.smdVariables`.
   * Default true.
   */
  variables?: boolean;
  /** How `:::agent` blocks are shown to human readers. Default `collapsed`. */
  agentBlocks?: 'collapsed' | 'expanded' | 'hidden';
  /**
   * Read a file for ```` ```lang file="…" ```` embeds and `:::include` blocks, relative to the document being
   * rendered (`env` is the env passed to `md.render`; nested includes ask for paths relative to that document too).
   * Return undefined when the file is missing or not allowed. Without it, embeds show "Cannot read" and includes
   * their fallback body under an "Include not available here" note.
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

