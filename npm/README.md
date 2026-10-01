<p align="center">
  <img src="https://raw.githubusercontent.com/bislink360/styled-markdown/main/docs/images/icon.png" width="96" alt="Styled Markdown">
</p>

# styled-markdown

**Styled Markdown (`.smd`)** is Markdown for developers, product managers and AI agents: callouts, colors, diagrams, decisions, risks, API blocks, KPIs and audience-aware content, with validation and token-efficient **agent views**.

This package provides the complete engine as a **library** and the **`smd` CLI**, with **zero runtime dependencies**.

![Rendered Styled Markdown](https://raw.githubusercontent.com/bislink360/styled-markdown/main/docs/images/01-overview.png)

- 📦 One install gives you the render, validate, fix, convert, agent-view, outline and task-extraction tools
- 🧩 CommonJS + ESM + TypeScript types; runs in Node 18+ and in bundlers/browsers (the library has no `fs` dependency)
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
smd fmt docs/ --check                 # formatting check for CI; without --check it formats in place
smd outline docs/spec.smd             # sections, line ranges and token cost per section
smd agent docs/spec.smd --section api # compact agent view of one section (+ agent instructions)
smd tasks docs/ --mine @alice         # open tasks across docs: priority, owner, due date, overdue first
smd decisions docs/ --status accepted # decision log across docs, newest first (--md: an ADR index)
smd tasks docs/ --csv -o tasks.csv    # tasks for a spreadsheet; --gantt [--smd] for a Mermaid Gantt chart
smd diff docs/ --since HEAD~3         # only the sections that changed since a commit, in the agent view
smd render docs/spec.smd -o spec.html # standalone HTML page
smd to-md docs/spec.smd -o spec.md    # plain GitHub Markdown (callouts → GitHub alerts)
smd init docs/plan.smd --template prd # new document from one of 13 templates (smd templates lists them)
smd skills install --global           # install the AI agent skills into ~/.claude/skills
smd mcp                               # MCP server (stdio) with outline, section, agent, tasks, validate, query
```

Run `smd --help` for every option.

## Library

```ts
import {
  renderSmd, renderPage, validateSmd, applyFixes, agentView, outline,
  smdToMarkdown, markdownToSmd, getDocumentInfo, extractTasks, querySmd, indexEntry, smdIndex, diffSmd, formatSmd,
  decisionLog, decisionLogMarkdown,
} from 'styled-markdown';
```

### Render

```ts
// HTML fragment + front matter + headings
const { html, frontMatter, headings } = renderSmd(source, {
  agentBlocks: 'collapsed',                  // how :::agent blocks show to humans: collapsed | expanded | hidden
  readFile: (path) => fs.readFileSync(path, 'utf8'), // enables ```ts file="…" embeds (sandbox it yourself)
});

// Complete standalone page (styles + runtime for tabs, Mermaid, theme switching)
const page = renderPage(source);
```

The front matter JSON Schema is at `styled-markdown/frontmatter.schema.json`, and `FRONTMATTER_SCHEMA` exports the same object. Style fragments with the bundled stylesheet: `import 'styled-markdown/smd.css'`. Diagrams render client-side with [Mermaid](https://mermaid.js.org), and math server-side with KaTeX (include KaTeX's CSS).

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
markdownToSmd(markdown, 'Fallback title'); // add front matter, GitHub alerts → callouts
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
// { path, title, summary, status, owners, tags, audience, updated, related, tokens: { file, agent }, counts: { openTasks, … }, sections: [{ level, text, id, line, endLine, tokens }] }
const catalog = smdIndex([{ path: 'docs/checkout.smd', text: source }]); // { format: 'smd-index', version: 1, smd: 1, documents: [entry, …] }, sorted by path
const log = decisionLog([{ path: 'docs/adr-0007.smd', text: source }], { status: ['accepted'] }); // the `smd decisions` log, newest first
// [{ title, status: 'accepted', date: '2026-09-18', owner: '@platform', path, line, endLine, section, anchor, document, adr: true }]
const adrIndex = decisionLogMarkdown(log, { link: (p) => p.replace(/^docs\//, '') }); // `smd decisions --md`: an ADR index to save as docs/decisions.smd
const changes = diffSmd(oldSource, newSource); // the `smd diff` sections that changed
// { frontMatter: [{ key: 'status', before: 'draft', after: 'accepted' }], sections: [{ change: 'changed', heading: 'Rollout', level: 3, line: 40, endLine: 46, text: '### Rollout  [L41]\n…' }], text: '…', tokens: 42, fullTokens: 1480 }
```

Also exported: `parseSelector` and `SelectorError` (invalid selectors), `parseFrontMatter`, `parseSmd` (headings and anchor ids without rendering), `RULE_CODES`, `applyRuleSettings`, `mermaidBlocks`, `ganttDate` and `TASK_CSV_COLUMNS` (task export), `estimateTokens`, `fillTemplate`, `SMD_CSS`, `SMD_RUNTIME_JS`, and the vocabulary (`CONTAINERS`, `INLINE_DIRECTIVES`, `NAMED_COLORS`, `FRONTMATTER_KEYS`, …) for building your own tooling.

## A taste of the format

````markdown
---
smd: 1
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
