<p align="center">
  <img src="https://raw.githubusercontent.com/bislink360/styled-markdown/main/docs/images/icon.png" width="96" alt="Styled Markdown">
</p>

# styled-markdown

**Styled Markdown (`.smd`)** is Markdown for developers, product managers and AI agents: callouts, colors, diagrams, decisions, risks, API blocks, KPIs and audience-aware content, with validation and token-efficient **agent views**.

This package provides the complete engine as a **library** and the **`smd` CLI**, with **zero runtime dependencies**.

![Rendered Styled Markdown](https://raw.githubusercontent.com/bislink360/styled-markdown/main/docs/images/01-overview.png)

- 📦 One install gives you the render, validate, fix, convert, agent-view, outline and task-extraction tools
- 🧩 CommonJS + ESM + TypeScript types; runs in Node 22+ and in bundlers/browsers (the library has no `fs` dependency)
- 🤖 Built for LLM pipelines: `agentView()` typically cuts **37–85%** of tokens while keeping meaning

## Install

```bash
npm install styled-markdown        # library + local `smd` command
npm install -g styled-markdown     # global `smd` command
npx styled-markdown --help         # run without installing
```

## CLI

```bash
smd validate docs/ --fix              # check files, auto-fix typos; exit code 1 on errors (CI-friendly)
smd validate docs/ --format github    # GitHub Actions annotations (--summary "$GITHUB_STEP_SUMMARY" adds a job summary)
smd fmt docs/ --check                 # formatting check for CI; without --check it formats in place
smd migrate docs/ --to 2              # move documents to spec v2 (smd: 2), keeping their meaning (--dry-run: the plan)
smd outline docs/spec.smd             # sections, line ranges and token cost per section
smd agent docs/spec.smd --section api # compact agent view of one section (+ agent instructions)
smd tasks docs/ --mine @alice         # open tasks across docs: priority, owner, due date, overdue first
smd decisions docs/ --status accepted # decision log across docs, newest first (--md: an ADR index)
smd tasks docs/ --csv -o tasks.csv    # tasks for a spreadsheet; --gantt [--smd] for a Mermaid Gantt chart
smd risks docs/ --html -o risks.html  # risk register: impact × likelihood, highest first, colour-coded matrix
smd diff docs/ --since HEAD~3         # only the sections that changed since a commit, in the agent view
smd report docs/ --since 2026-09-01 -o status.smd # draft a status report: tasks done and added since, open, decisions, risks
smd issues docs/                      # GitHub Issues sync plan via gh (a dry run; --apply [--create] [--close] syncs)
smd export docs/spec.smd -o spec.html # standalone HTML page (prints well: Print → Save as PDF); -o picks the format
smd export docs/spec.smd --to pdf     # spec.pdf, if Playwright or Puppeteer is installed (not bundled)
smd export docs/spec.smd --to docx    # spec.docx, if Pandoc is installed (not bundled); --html-only for Pandoc's input
smd export docs/spec.smd -o spec.md   # plain GitHub Markdown (callouts → GitHub alerts)
smd export docs/spec.smd --to confluence -o spec.xml  # Confluence storage format (built-in macros)
smd export docs/spec.smd --to notion -o spec.json     # Notion API blocks, as request bodies
smd build docs/ --out site            # static docs site: navigation, search, backlinks, task/decision/risk dashboard
smd init docs/plan.smd --template prd # new document (smd: 2) from one of 13 templates (smd templates lists them)
smd skills install --global           # install the AI agent skills into ~/.claude/skills
smd mcp                               # MCP server (stdio) with outline, section, agent, tasks, validate, query
smd lsp --stdio                       # language server for Neovim, Helix, Zed… (also installed as smd-language-server)
```

Run `smd --help` for every option. The export commands before 2.0, `smd render`, `smd to-md`, `smd pdf` and `smd docx`, still work as before.

The package also installs **`smd-language-server`**, the same as `smd lsp`: point your editor's LSP client at `smd-language-server --stdio` for `.smd` files to get diagnostics with quick fixes, the outline, symbol search, hover, completion, go to definition and formatting. Setups for Neovim, Helix and Zed: [editor guide](https://github.com/bislink360/styled-markdown/blob/main/docs/EDITORS.md).

## Library

```ts
import {
  renderSmd, renderPage, specVersion, validateSmd, applyFixes, agentView, outline,
  smdToMarkdown, smdToConfluence, smdToNotion, notionRequests, markdownToSmd, getDocumentInfo, extractTasks,
  querySmd, indexEntry, smdIndex, diffSmd, formatSmd,
  decisionLog, decisionLogMarkdown, statusChanges, statusReportMarkdown, statusReport,
  riskRegister, riskRegisterText, renderRiskPage, buildSite,
} from 'styled-markdown';
```

### Render

```ts
// HTML fragment + front matter + headings + the spec version the document was read with
const { html, frontMatter, headings, spec } = renderSmd(source, {
  agentBlocks: 'collapsed',                  // how :::agent blocks show to humans: collapsed | expanded | hidden
  readFile: (path) => fs.readFileSync(path, 'utf8'), // enables ```ts file="…" embeds and :::include (sandbox it yourself)
  lang: 'de',                                // labels ("Hinweis", "Abbildung 2") for documents without their own `lang:`
  spec: 2,                                   // spec version for documents without an `smd:` key (default 1); their own `smd:` wins
});

specVersion(source);                         // 1 or 2: which rules read the document (its `smd:`; see SPEC.md §10)

// Complete standalone page (styles + runtime for tabs, Mermaid, theme switching)
const page = renderPage(source);
```

The front matter JSON Schema is at `styled-markdown/frontmatter.schema.json`, and `FRONTMATTER_SCHEMA` exports the same object. Style fragments with the bundled stylesheet: `import 'styled-markdown/smd.css'`. Diagrams render client-side with [Mermaid](https://mermaid.js.org), and math server-side with KaTeX (include KaTeX's CSS).

### markdown-it plugin

Already render Markdown with [markdown-it](https://github.com/markdown-it/markdown-it) (a docs site, a static site generator, a chat UI)? Add `.smd` syntax to your own instance with the `styled-markdown/markdown-it` plugin. It works with markdown-it 13 and 14, which you provide (an optional peer dependency; the package still has no runtime dependencies):

```ts
import MarkdownIt from 'markdown-it';
import smd from 'styled-markdown/markdown-it';   // CommonJS: const smd = require('styled-markdown/markdown-it');
import 'styled-markdown/smd.css';                 // or <link rel="stylesheet" href="…/styled-markdown/dist/smd.css">

const md = new MarkdownIt({ linkify: true }).use(smd);

md.render(':::warning Heads up\nShips :badge[beta]{color=amber} on :due[2026-11-01].\n:::');
```

The plugin only adds rules to your instance: your options (including `html`), your other plugins and your code highlighting keep working, and plain Markdown renders exactly as before. Options, all optional:

| Option | Default | What it adds |
|---|---|---|
| `preset` | none | `'smd'`: render as `renderSmd` does (since 2.0; see below). It turns on `codeFrames`, `headingIds`, `sourceLines` and `frontMatter` unless you pass them |
| `containers` | `true` | `:::note`, `:::tabs`, `:::decision`, `:::risk`, `:::api`, numbered `:::figure`, `:::glossary`, `:::changelog`, `:::quote` and the other blocks |
| `glossary` | `true` | `:::glossary` term lists as `<dl>`, and the first use of each term per section linked to its definition with a tooltip (needs `containers`) |
| `directives` | `true` | `:badge[…]`, `:kbd[…]`, `:progress[…]`, `:due[…]`, `:priority[…]`, `:metric[…]`, `:status[…]`, `:mention[…]`, `:ref[…]` |
| `attributes` | `true` | `[text]{color=red .muted}` spans and `## Heading {#id .class}` |
| `mark` | `true` | `==highlighted==` text |
| `math` | `true` | `$inline$` and `$$display$$` math with KaTeX (include KaTeX's CSS) |
| `footnotes` | `true` | GitHub-style `[^1]` footnotes, collected in a numbered section at the end (since 1.6). If you use markdown-it-footnote, add it before this plugin (this option then steps aside) or set `footnotes: false` |
| `tasks` | `true` | `- [ ]` / `- [x]` task lists as checkboxes |
| `fences` | `true` | ```` ```mermaid ```` and ```` ```math ```` blocks, and `title="…"`, `file="…"` and `{2,5-7}` on code blocks; turn it off if your host has its own fence attributes |
| `codeFrames` | `false` (`true` with `preset`) | Frame every code block with a language label, as the `.smd` preview does |
| `headingIds` | `false` (`true` with `preset`) | Heading ids from their text (`#setup`, `#setup-1`), the same slugs as `renderSmd` |
| `sourceLines` | `false` (`true` with `preset`) | `data-line` source line numbers on blocks |
| `frontMatter` | `false` (`true` with `preset`) | Render `---` YAML front matter as the `.smd` document header (leave it off if your host handles front matter) |
| `variables` | `true` | `{{version}}` in text shows the front matter value of `version` (`{{owner.name}}` for nested keys; since 1.6). Names the front matter doesn't define stay as written. The front matter is read from the source; if your host removes it first, pass its data as `env.smdVariables` |
| `agentBlocks` | `'collapsed'` | How `:::agent` blocks show to humans: `collapsed`, `expanded` or `hidden` |
| `readFile` | none | `(path, env?) => string \| undefined` for ```` ```ts file="…" ```` embeds and `:::include`; `env` is what you passed to `md.render` (sandbox it yourself). The same `ReadFile` function as `renderSmd`'s (since 2.0) |
| `today` | current date | `YYYY-MM-DD` for `:due[]` states |
| `lang` | English | Language of the labels the plugin adds ("Note", "Figure 2", "overdue"…), a BCP 47 tag: `de`, `es`, `fr`, `ja`, `pt`, `zh` (`pt-BR` → `pt`; others are English). A render's `env.lang` overrides it, and with `frontMatter` the document's `lang:` overrides both (since 1.6) |
| `spec` | `1` | The spec version (`1` or `2`) of documents that don't say, for hosts that remove the front matter (since 2.0). The document's own `smd:` wins: in the source's front matter, else in the front matter you pass as `env.smdVariables`. The plugin puts the version on the render's env as `smdSpec` |

**Typography and links in spec v2.** Your `typographer` and `linkify` options apply to spec v1 documents as they always did. A spec v2 document (`smd: 2`, or `spec: 2`) gets no typographic quotes, dashes or ellipses unless its front matter says `typography: true`, and only GFM autolink literals become links (`https://…`, `www.…`, e-mail addresses; not `example.com`). The plugin only takes away: with your `typographer` or `linkify` off, they stay off. If your host removes the front matter, pass `typography` with the rest of it in `env.smdVariables`. See SPEC §4.8.

**Render like `renderSmd`: `preset: 'smd'`** (since 2.0). The plugin's defaults leave out what a host usually has its own way of doing: heading ids, the front matter header, code frames and source lines are off, and typography and links follow your instance. The preset turns on what `renderSmd` does, so the same document gives the same HTML (inside `<article class="smd-doc">`):

```ts
import hljs from 'highlight.js/lib/common';
const md = new MarkdownIt({
  html: true,                                                    // renderSmd's default; the preset leaves raw HTML to you
  highlight: (code, lang) => (hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : ''),
}).use(smd, { preset: 'smd', sourceLines: false });              // an option you pass wins over the preset's
```

It turns on `headingIds`, `frontMatter`, `codeFrames` and `sourceLines`, sets your instance's `typographer` and `linkify` to `true` (spec v2 documents still follow the rules above; `md.set({ typographer: false })` after `.use()` turns one back off), and wraps tables in `<div class="smd-table-wrap">` with `scope="col"` on header cells. Raw HTML (`html`) and code highlighting stay your instance's. Without `preset`, nothing changes.

**`readFile` (since 2.0)** has one signature for `renderSmd` and the plugin, `ReadFile = (relativePath: string, env?: unknown) => string | undefined` (exported as a type). `env` is the render's markdown-it env, the same object for every file one render reads: the `env` you passed to `md.render`, or `renderSmd`'s own (opaque). A one-argument function works for both.

Each rule is named `smd_…`, so `md.disable('smd_mark')` turns a single one off. The blocks are styled by `smd.css` on their own; wrap the output in `<article class="smd-doc">` for the `.smd` typography too. Mermaid blocks render as `<pre class="smd-mermaid">` source inside `.smd-diagram`, ready for `mermaid.run({ querySelector: 'pre.smd-mermaid' })`. Figures are numbered per `md.render` call, and `:ref[id]` resolves against the figures of that call (they are kept on the `env` as `smdFigures`). Two things need the whole document and stay with `renderSmd`: the computed `:::risk-matrix` grid (the plugin renders its title and body) and the `toc: true` table of contents.

### remark and rehype plugins (Astro, Docusaurus, Next.js)

`styled-markdown/remark` renders the whole file with `renderSmd` and replaces the Markdown tree with the resulting HTML, so every `.smd` construct looks exactly as it does with `smd export --to html`. `styled-markdown/rehype` does the same for pipelines that only take rehype plugins. Neither imports anything from unified: the package still has zero dependencies.

```js
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { remarkSmd } from 'styled-markdown/remark';

const file = await unified()
  .use(remarkParse)
  .use(remarkSmd, { header: true })
  .use(remarkRehype, { allowDangerousHtml: true })   // the plugin emits one raw HTML node
  .use(rehypeStringify, { allowDangerousHtml: true })
  .process(source);
String(file);           // <article class="smd-doc">…</article>
file.data.smd;          // { frontMatter, headings, spec }
```

| Option | Default | |
|---|---|---|
| `test` | every file | RegExp or `(path) => boolean` on `file.path`, e.g. `/\.smd$/`; files without a path are skipped when set |
| `header` | `true` | the title/status/owners header from front matter; `false` when the site layout already shows the title |
| `frontMatter` | see below | `(file) => object`: front matter the host already removed from the source |
| `readFile` | none | `(relativePath, file) => string \| undefined`, for ```` ```ts file="…" ```` embeds (resolve against `file.path`, sandbox it yourself) |
| `allowHtml`, `agentBlocks`, `today`, `lang`, `spec` | as `renderSmd` | `allowHtml: false` for documents you don't trust: the output is inserted as raw HTML. `spec` is the version of files whose front matter (their own, or the host's) has no `smd:` |

**Front matter.** When the source still starts with `---` (plain unified, with or without remark-frontmatter), the plugin reads it like `renderSmd`. When the host removed it first, the plugin looks for the parsed data in `file.data.astro.frontmatter` (Astro), `file.data.matter` (vfile-matter) or `file.data.frontmatter`, or uses your `frontMatter` option. Front matter nodes (`yaml`, `toml`) and MDX `import`/`export` nodes stay in the tree.

**What the page needs.** The stylesheet (`styled-markdown/smd.css`), KaTeX's CSS when documents have math (rendered at build time), and for Mermaid diagrams, tabs and copy buttons the Mermaid script plus the runtime that `smd export --to html` inlines (`SMD_RUNTIME_JS` from `styled-markdown`). The runtime hydrates the page once on load. Without it, diagrams show their source and tab panes are stacked under their labels.

| Host | Status | Notes |
|---|---|---|
| unified (remark-parse → remark-rehype → rehype-stringify) | **Tested** with hand-built trees and files (not yet with unified itself in CI) | needs `allowDangerousHtml: true` in remark-rehype and rehype-stringify, or `rehype-raw` |
| Astro `.md` pages and content collections | Expected | Astro already passes raw HTML through. Name files `.md` (Astro doesn't know `.smd`); limit the plugin with `test`. `getHeadings()` may be empty, because Astro collects headings before it parses raw HTML: add `rehype-raw` to `rehypePlugins` |
| Docusaurus 3 `.md` files (`markdown.format: 'detect'`) | Expected | `.md` files are compiled as CommonMark with raw HTML parsed by rehype-raw. Docusaurus builds its table of contents from the original headings: links match for plain headings and `{#id}`, but can differ for headings with attribute lists or runs of punctuation (`A - B`) |
| MDX (`.mdx`, Astro `@astrojs/mdx`, Next.js `@next/mdx`) | **Not supported** for `.mdx` files | MDX parses `{…}` and `<…>` as JSX *before* any plugin runs, so `.smd` attribute lists such as `:::callout{type=warning}` fail to compile. Use `.md` with MDX's `format: 'detect'` and `rehype-raw` |
| Next.js | Expected | simplest: `renderSmd` in a Server Component (below); or `@next/mdx` with `.md` files as above |

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import { remarkSmd } from 'styled-markdown/remark';

export default defineConfig({
  markdown: { remarkPlugins: [[remarkSmd, { test: /[\\/]docs[\\/]/, header: false }]] },
});
// in the layout: import 'styled-markdown/smd.css';
```

```js
// docusaurus.config.js
const { remarkSmd } = require('styled-markdown/remark');

module.exports = {
  markdown: { format: 'detect' },   // .md = CommonMark, .mdx = MDX
  presets: [['classic', {
    docs: { remarkPlugins: [[remarkSmd, { header: false }]] },
    theme: { customCss: [require.resolve('styled-markdown/smd.css')] },
  }]],
};
```

```tsx
// Next.js (App Router): app/docs/spec/page.tsx
import { readFile } from 'node:fs/promises';
import { renderSmd } from 'styled-markdown';
import 'styled-markdown/smd.css';

export default async function Page() {
  const { html } = renderSmd(await readFile('docs/spec.smd', 'utf8'));
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
```

```js
// next.config.mjs, with @next/mdx and rehype-raw installed (pages written as .md)
import createMDX from '@next/mdx';
import rehypeRaw from 'rehype-raw';
import { remarkSmd } from 'styled-markdown/remark';

const withMDX = createMDX({
  extension: /\.mdx?$/,
  options: { format: 'detect', remarkPlugins: [remarkSmd], rehypePlugins: [rehypeRaw] },
});
export default withMDX({ pageExtensions: ['ts', 'tsx', 'md', 'mdx'] });
// Turbopack takes plugins by name instead: remarkPlugins: ['styled-markdown/remark'] (default export)
```

### Validate and fix

```ts
const diagnostics = validateSmd(source, { fileExists: (p) => fs.existsSync(p) });
// [{ line: 4, column: 3, endColumn: 10, severity: 'warning', code: 'container/unknown',
//    message: 'Unknown container ":::warnign" — did you mean ":::warning"? …',
//    fix: { line: 4, column: 3, endColumn: 10, replacement: 'warning', title: 'Change to ":::warning"' } }]

const { text, applied } = applyFixes(source, diagnostics);
```

Every diagnostic has a stable `code` (`container/unclosed`, `attrs/value`, `mermaid/type`, `task/overdue`, …). They're listed in the [specification](https://github.com/bislink360/styled-markdown/blob/main/docs/SPEC.md#7-validation-rules).

```ts
// Turn rules off or change their severity, by code, category or '*'; the most specific key wins.
validateSmd(source, { rules: { 'link/missing-file': 'off', 'frontmatter/*': 'hint' } });

// Or read them from a smd.config.json / .smdrc file you loaded yourself.
const { rules, problems } = readRuleConfig(JSON.parse(configText));

// Mermaid syntax errors need a parser, which the library doesn't bundle: pass mermaid.parse.
const errors = await checkMermaid(source, (src) => mermaid.parse(src), rules);
```

Inside a document, `<!-- smd-disable-next-line link/missing-file -->` silences one rule on the next line.

### Token-efficient agent views

```ts
const view = agentView(source, { sections: ['requirements'], brief: true });
view.text            // compact, meaning-preserving text for an LLM prompt
view.tokens          // ≈ tokens of the view (chars / 4)
view.originalTokens  // ≈ tokens of the raw file
view.skippedSections // headings marked {agent=skip}

console.log(outline(source)); // sections with line ranges and token costs

// Fit a budget: condense as brief, then leave out the least important sections (each becomes a pointer).
const fitted = agentView(source, { maxTokens: 800, file: 'docs/spec.smd' });
fitted.budget        // { maxTokens, tokens, fits, condensed, omitted: [{ heading, level, line, endLine, tokens }] }

// Exact counts with a tokenizer you bring, e.g. js-tiktoken (not a dependency of this package).
import { getEncoding } from 'js-tiktoken';
const o200k = getEncoding('o200k_base');
const tokenizer = { name: 'o200k_base', count: (text: string) => o200k.encode(text).length };
agentView(source, { tokenizer, maxTokens: 800 }).counted; // { tokenizer, tokens, originalTokens }
outline(source, { tokenizer });                          // exact counts next to each estimate
```

`maxTokens` never leaves out the header, text before the first `##` section, sections with `:::agent` instructions, or the requested `sections`. Sections with danger or warning callouts, accepted decisions, questions or open tasks are kept longest. OpenAI encodings are approximate for Claude models, which have no public tokenizer.

The agent view drops styling, layout, `:::human` blocks and `{agent=skip}` sections. It keeps callouts (`<warning>`), decisions, risks, API definitions, tasks with owner, priority and due date, and **always** includes `:::agent` instructions, even when you select a single section.

### Convert and inspect

```ts
smdToMarkdown(source);                    // GitHub-flavored Markdown
smdToConfluence(source, { readFile });    // Confluence storage format (XHTML with built-in macros); raw HTML reduced to text
notionRequests(smdToNotion(source));      // Notion blocks, cut into PATCH /v1/blocks/{id}/children bodies (within Notion's limits)
markdownToSmd(markdown, 'Fallback title'); // add front matter, GitHub alerts → callouts
smdToPandocHtml(source);                  // HTML for `pandoc -f html -t docx` (what `smd export --to docx` converts; no docx writer here)
formatSmd(source);                        // the `smd fmt` layout: fence colons, attribute order, tables, blank lines

const info = getDocumentInfo(source);     // front matter, outline, tasks, decisions, risks, agent blocks, diagnostics
const open = extractTasks(source).filter((t) => !t.done);
// [{ text: 'Idempotent order creation', priority: 'P0', assignees: ['@api-team'], due: '2026-10-03', overdue: false, line: 61, section: 'Requirements' }]
const rows = extractTasks(source).map((t) => ({ ...t, file: 'docs/checkout.smd' }));
tasksToCsv(rows);   // the `smd tasks --csv` export: header, CRLF, 1-based lines, formula-like cells prefixed with '
const chart = tasksToGantt(rows, { title: 'Q4' }); // Mermaid gantt: a section per file, a milestone per dated task
ganttDocument(chart, 'Q4'); // the chart in a .smd document with a mermaid fence (`smd tasks --gantt --smd`)

const risks = querySmd(source, 'risk[impact>=high][status!=closed]'); // the `smd query` selectors
// [{ type: 'risk', title: 'Apple Pay domain verification delays launch', attrs: { impact: 'high', … }, line: 144, endLine: 146, section: 'Risks', text: '<risk impact="high" …' }]

const entry = indexEntry(source, 'docs/checkout.smd'); // one `smd index` catalog entry
// { path, smd, title, summary, status, owners, tags, audience, updated, related, tokens: { file, agent }, counts: { openTasks, … }, sections: [{ level, text, id, line, endLine, tokens }] }
// (`smd` is the document's spec version, 1 or 2)
const catalog = smdIndex([{ path: 'docs/checkout.smd', text: source }]); // { format: 'smd-index', version: 1, smd: 2, documents: [entry, …] }, sorted by path (`smd`: the newest spec version the tool knows)
const log = decisionLog([{ path: 'docs/adr-0007.smd', text: source }], { status: ['accepted'] }); // the `smd decisions` log, newest first
// [{ title, status: 'accepted', date: '2026-09-18', owner: '@platform', path, line, endLine, section, anchor, document, adr: true }]
const adrIndex = decisionLogMarkdown(log, { link: (p) => p.replace(/^docs\//, '') }); // `smd decisions --md`: an ADR index to save as docs/decisions.smd
const changes = diffSmd(oldSource, newSource); // the `smd diff` sections that changed
// { frontMatter: [{ key: 'status', before: 'draft', after: 'accepted' }], sections: [{ change: 'changed', heading: 'Rollout', level: 3, line: 40, endLine: 46, text: '### Rollout  [L41]\n…' }], text: '…', tokens: 42, fullTokens: 1480 }

const register = riskRegister([{ path: 'docs/checkout.smd', text: source }], { all: false }); // the `smd risks` register
// { risks: [{ path, line, title, impact: 'high', likelihood: 'medium', score: 6, owner: '@payments', status: 'open', section, summary, defaulted: [] }], matrix: { impact, likelihood, counts }, documents: 1, documentsWithRisks: 1 }
riskRegisterText(register);               // one line per risk, then a text matrix
renderRiskPage(register);                 // standalone HTML page: colour-coded matrix + register table (light/dark)

const status = statusChanges([{ path: 'docs/plan.smd', text: oldSource }], [{ path: 'docs/plan.smd', text: source }], { today: '2026-09-30' }); // `smd report` (before: null when there's no earlier version)
// { compared: true, today, done: [task…], added, removed, open, overdue, dueSoon, decisions: [{ decision, before: 'proposed' }], needed, risks, documents }
const draft = statusReportMarkdown(status, { since: 'HEAD~5', title: 'Checkout squad' }); // a status-report draft that passes `smd validate`

const site = buildSite([{ path: 'index.smd', text: home }, { path: 'guide/setup.smd', text: source }], { title: 'Docs', today: '2026-10-01' }); // `smd build`
// { files: [{ path: 'guide/setup.html', content }, { path: 'dashboard.html', … }, { path: '_smd/search-index.js', … }, …], assets: ['img/logo.png'], pages, skipped }
// Write each file under your output folder and copy `assets` (local files the pages link to) from the source folder.
```

### GitHub Issues sync (the `smd issues` logic, without network access)

```ts
const tasks = issueTasks(source); // every task with the issue it links to: [#12](https://github.com/o/r/issues/12), the bare URL or o/r#12
const plan = planIssueSync(tasks, states, { create: true, close: false }); // states: Map<'o/r#12', { state: 'open' | 'closed', reason? }>
// { actions: [{ kind: 'check' | 'create' | 'close', task, issue, enabled }], inSync: [...], skipped: [{ task, issue, reason }] }
const { title, body } = issueDraft(task, { path: 'docs/plan.smd' }); // owners in code spans: nobody is @-mentioned
addIssueLink(line, { number: 12, url: 'https://github.com/o/r/issues/12' }); // appends ` [#12](…)`, nothing else changes
checkTaskLine(line);                      // `- [ ]` → `- [x]`, nothing else changes
```

Also: `parseIssueRefs(line)` (every reference, code spans ignored), `taskIssueRef(line)` (the first), `issueKey(ref)` and `stripIssueRefs(text)`. Talking to GitHub (`gh`) and writing files is left to you.

Also exported: `parseSelector` and `SelectorError` (invalid selectors), `parseFrontMatter`, `parseSmd` (headings and anchor ids without rendering), `RULE_CODES`, `applyRuleSettings`, `mermaidBlocks`, `ganttDate` and `TASK_CSV_COLUMNS` (task export), `estimateTokens`, `fillTemplate`, `SMD_CSS`, `SMD_RUNTIME_JS`, and the vocabulary (`CONTAINERS`, `INLINE_DIRECTIVES`, `NAMED_COLORS`, `FRONTMATTER_KEYS`, …) for building your own tooling.

The vocabulary is read-only (since 2.0): every table is frozen, nested objects and arrays included, and typed `Readonly`. Copy one to extend it: `{ ...CONTAINERS, mine: { description: 'My block' } }`, `[...NAMED_COLORS, 'brand']`.

`inlineText(line, options?)` is one line of `.smd` as the agent view writes it: styling removed, the words kept. Its options are one object (since 2.0; 1.x took them as positional arguments), all optional:

```ts
inlineText(':badge[v2] by :due[2026-10-01], see :ref[fig-a], for {{team}}', {
  today: '2026-10-15',   // YYYY-MM-DD: a past :due[…] reads "(due …, OVERDUE)" on an open task
  openTask: true,        // the line is an open task's (default false)
  figures,               // the document's figures by id (ReadonlyMap): :ref[id] → "Figure 2 (id)"
  variables: frontMatter, // {{name}} → the front matter value
});
// '[v2] by (due 2026-10-01, OVERDUE), see Figure 1 (fig-a), for Core'
```

## A taste of the format

````markdown
---
smd: 2
title: Saved Searches
summary: Let users save a search and get notified about new results.
status: review
---

:::warning Breaking change
`GET /v1/search` requires the `filters` object from 2026-11-01.
:::

- [ ] Idempotent order creation :priority[P0] @api-team :due[2026-10-03]

:::decision{status=accepted date=2026-09-08 owner=@maya} Accordion layout on mobile
:::

## Background {agent=skip}
People read this; agents skip it.

:::agent
- All prices are integer cents.
:::
````

## More

- **VS Code extension:** live preview, validation, IntelliSense and agent view. Search for "Styled Markdown" in the Extensions view, or see the [install guide](https://github.com/bislink360/styled-markdown/blob/main/docs/INSTALL.md).
- **AI agent skills** for Claude and other agents: [skills guide](https://github.com/bislink360/styled-markdown/blob/main/docs/SKILLS.md)
- [Feature guide](https://github.com/bislink360/styled-markdown/blob/main/docs/FEATURES.md) · [Specification](https://github.com/bislink360/styled-markdown/blob/main/docs/SPEC.md) · [Examples](https://github.com/bislink360/styled-markdown/tree/main/examples)

Author: **Roshan Alwis** · License: MIT
