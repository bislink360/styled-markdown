import type MarkdownIt from 'markdown-it';
import { addTableRules, applySmd, hasSmd, hostContext, smdFeatures, type ReadFile } from './markdownItSetup';

export type { ReadFile } from './markdownItSetup';

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
   * `'smd'`: render as renderSmd does (since 2.0). It turns on `codeFrames`, `headingIds`, `sourceLines` and
   * `frontMatter`, sets the instance's `typographer` and `linkify` options, and wraps tables as renderSmd does
   * (`<div class="smd-table-wrap">`, `scope="col"` on header cells). An option you pass wins over the preset's.
   * Raw HTML (`html`) and code highlighting (`highlight`) stay the instance's own. Default: no preset.
   */
  preset?: 'smd';
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
  /** Frame every code block like the .smd preview, with a language label. Default false (true with `preset: 'smd'`). */
  codeFrames?: boolean;
  /** Give headings ids from their text (`#getting-started`, `#setup-1`), as renderSmd does. Default false (true with `preset: 'smd'`). */
  headingIds?: boolean;
  /** Add `data-line` source line numbers to block elements, as the .smd preview does. Default false (true with `preset: 'smd'`). */
  sourceLines?: boolean;
  /** Render `---` YAML front matter as the .smd document header (title, status, owners, tags). Default false (true with `preset: 'smd'`). */
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
   * their fallback body under an "Include not available here" note. renderSmd's `readFile` is the same function.
   */
  readFile?: ReadFile;
  /** "Today" as YYYY-MM-DD, for `:due[]` states. Defaults to the current date. */
  today?: string;
  /**
   * The language of the labels the plugin adds ("Note", "Figure 2", "overdue"…), a BCP 47 tag such as `de` or
   * `pt-BR`, for documents that don't name one. A render's `env.lang` overrides it, and with `frontMatter` the
   * document's own `lang:` overrides both. Unsupported languages, and the default, are English.
   */
  lang?: string;
  /**
   * The spec version (1 or 2) of documents that don't say, for hosts that remove the front matter. The document's
   * own `smd` wins: in the source's `---` front matter, else in `env.smdVariables` (front matter a host removed and
   * passes along per render). Default 1. The plugin puts the version on the render's env as `smdSpec` before
   * parsing, where the rules read it.
   */
  spec?: 1 | 2;
}

/** The options `preset: 'smd'` turns on, as renderSmd has them. */
const SMD_PRESET = { codeFrames: true, headingIds: true, sourceLines: true, frontMatter: true } as const;

/** `options` with the preset's values for the options it leaves out. */
function presetOptions(options: MarkdownItSmdOptions): MarkdownItSmdOptions {
  if (options.preset !== 'smd') return options;
  const resolved: MarkdownItSmdOptions = { ...options };
  for (const [key, value] of Object.entries(SMD_PRESET) as Array<[keyof typeof SMD_PRESET, boolean]>) resolved[key] ??= value;
  return resolved;
}

/** Add Styled Markdown syntax to a markdown-it instance. Using it twice on one instance has no further effect. */
export function markdownItSmd(md: MarkdownIt, options: MarkdownItSmdOptions = {}): void {
  if (hasSmd(md)) return;
  const resolved = presetOptions(options);
  if (resolved.preset === 'smd') {
    md.set({ typographer: true, linkify: true });
    addTableRules(md);
  }
  applySmd(md, smdFeatures(resolved), hostContext(md, resolved));
}

export default markdownItSmd;

