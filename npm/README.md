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
smd diff docs/ --since HEAD~3         # only the sections that changed since a commit, in the agent view
smd render docs/spec.smd -o spec.html # standalone HTML page
smd to-md docs/spec.smd -o spec.md    # plain GitHub Markdown (callouts → GitHub alerts)
smd init docs/plan.smd --template prd # new document: prd, adr, rfc, runbook, api, status-report, meeting-notes
smd skills install --global           # install the AI agent skills into ~/.claude/skills
```

Run `smd --help` for every option.

## Library

```ts
import {
  renderSmd, renderPage, validateSmd, applyFixes, agentView, outline,
  smdToMarkdown, markdownToSmd, getDocumentInfo, extractTasks, querySmd, diffSmd, formatSmd,
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
```

The agent view drops styling, layout, `:::human` blocks and `{agent=skip}` sections. It keeps callouts (`<warning>`), decisions, risks, API definitions, tasks with owner, priority and due date, and **always** includes `:::agent` instructions, even when you select a single section.

### Convert and inspect

```ts
smdToMarkdown(source);                    // GitHub-flavored Markdown
markdownToSmd(markdown, 'Fallback title'); // add front matter, GitHub alerts → callouts
formatSmd(source);                        // the `smd fmt` layout: fence colons, attribute order, tables, blank lines

const info = getDocumentInfo(source);     // front matter, outline, tasks, decisions, risks, agent blocks, diagnostics
const open = extractTasks(source).filter((t) => !t.done);
// [{ text: 'Idempotent order creation', priority: 'P0', assignees: ['@api-team'], due: '2026-10-03', overdue: false, line: 61, section: 'Requirements' }]

const risks = querySmd(source, 'risk[impact>=high][status!=closed]'); // the `smd query` selectors
// [{ type: 'risk', title: 'Apple Pay domain verification delays launch', attrs: { impact: 'high', … }, line: 144, endLine: 146, section: 'Risks', text: '<risk impact="high" …' }]

const changes = diffSmd(oldSource, newSource); // the `smd diff` sections that changed
// { frontMatter: [{ key: 'status', before: 'draft', after: 'accepted' }], sections: [{ change: 'changed', heading: 'Rollout', level: 3, line: 40, endLine: 46, text: '### Rollout  [L41]\n…' }], text: '…', tokens: 42, fullTokens: 1480 }
```

Also exported: `parseSelector` and `SelectorError` (invalid selectors), `parseFrontMatter`, `parseSmd` (headings and anchor ids without rendering), `RULE_CODES`, `applyRuleSettings`, `mermaidBlocks`, `estimateTokens`, `fillTemplate`, `SMD_CSS`, `SMD_RUNTIME_JS`, and the vocabulary (`CONTAINERS`, `INLINE_DIRECTIVES`, `NAMED_COLORS`, `FRONTMATTER_KEYS`, …) for building your own tooling.

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
