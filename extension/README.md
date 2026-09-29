# Styled Markdown (.smd) for VS Code

**One document format for developers, product managers and AI agents.** Styled Markdown is Markdown plus callouts, colors, diagrams, decisions, risks, API blocks, KPIs and audience-aware content, with a live preview, validation, and token-efficient views for AI agents.

Every `.md` file is already valid `.smd`, so you can rename a file and start adding structure.

![Styled Markdown preview](https://raw.githubusercontent.com/bislink360/styled-markdown/main/docs/images/01-overview.png)

## Highlights

- **Live preview** (`Ctrl+K V`): themed to match VS Code, scroll sync, double-click to jump to source, clickable tasks, Mermaid diagrams, KaTeX math, tabs and columns.
- **Project blocks:** `:::decision`, `:::risk`, `:::timeline`, KPI tiles (`:metric`), priorities, and due dates that turn red when overdue. Tasks carry owners.
- **Developer blocks:** `:::api` endpoint cards, code line highlights `{2,5-7}`, and live source embeds `file="…" lines="…"` so docs never drift from code.
- **Refactorings** (`Ctrl+.`): wrap the selection in a callout, card, `:::details`, `:::agent` or `:::human` block; change a callout's type; turn a `> **Warning:**` or `> [!WARNING]` blockquote into a `:::warning` callout.
- **Validation with quick fixes** as you type (`:::warnign` → `:::warning`, `flowchat` → `flowchart`, `blu` → `blue`), including Mermaid syntax errors on the exact line before the diagram renders. Turn rules off or change their severity in `smd.config.json` / `.smdrc`, which get completion from a schema, or silence one line with `<!-- smd-disable-next-line rule/code -->`.
- **Formatter:** Format Document (`Shift+Alt+F`) and `"editor.formatOnSave"` tidy container fences, attribute lists, table columns and blank lines, with the same rules as `smd fmt` in CI.
- **IntelliSense:** completion for blocks, directives, attributes and allowed values, and for paths and `#anchors` in links, `related:` entries and `file="…"` embeds; hover docs; color picker; go to definition for anchors, linked files and reference links; find references and rename for headings, which updates every link to them across the workspace; `Ctrl+T` search across every heading, decision, risk and API endpoint in the workspace; hover previews of linked sections, documents and embedded code; outline; folding; 34 snippets.
- **Agent view:** 🤖 shows exactly what an AI agent reads, with styling, layout and human-only sections stripped and meaning kept (typically 37–85% fewer tokens). Copy the whole view or selected sections to any chat tool. A status-bar token counter shows the size.
- **Export** to standalone HTML or GitHub Markdown, and convert `.md` → `.smd`.

![Project management blocks](https://raw.githubusercontent.com/bislink360/styled-markdown/main/docs/images/02-project-management.png)

## Commands

| Command | Default key |
|---|---|
| Styled Markdown: Open Preview to the Side | `Ctrl+K V` |
| Styled Markdown: Open Preview | `Ctrl+Shift+V` |
| Styled Markdown: Show Agent View / Show Brief Agent View | 🤖 in the title bar |
| Styled Markdown: Copy Agent View / Copy Sections for an Agent… | — |
| Styled Markdown: Export to HTML / Export to Plain Markdown (.md) | — |
| Styled Markdown: Convert Markdown File to .smd | Explorer context menu |
| Styled Markdown: Validate All .smd Files in Workspace | — |
| Styled Markdown: Set Up Spell Checking (cSpell) | — |

## Settings

| Setting | Default | Description |
|---|---|---|
| `smd.preview.theme` | `auto` | `auto` follows VS Code; or force `light` / `dark` |
| `smd.preview.showAgentBlocks` | `collapsed` | How `:::agent` blocks appear to humans: `collapsed`, `expanded`, `hidden` |
| `smd.preview.allowHtml` | `true` | Render raw HTML (scripts never run) |
| `smd.validation.enabled` | `true` | Report problems |
| `smd.validation.checkLinks` | `true` | Warn about relative links, images and `related:` entries that point to missing files or headings |
| `smd.validation.mermaid` | `true` | Parse Mermaid diagrams and report syntax errors before they render |
| `smd.validation.staleAfterDays` | `180` | Flag a document as stale when `updated` is older than this and its status isn't archived or deprecated (`0`: off) |
| `smd.editor.continueLists` | `true` | Enter continues task lists (unchecked, keeping `@owner`), bullets and numbered lists; Enter on an empty item ends the list |
| `smd.images.folder` | `docs/images` | Where pasted and dropped images are saved, relative to the workspace folder |

## Syntax at a glance

````markdown
---
smd: 1
title: Saved Searches
summary: Let users save a search and get notified about new results.
status: review
---

:::warning Breaking change
The `filters` parameter is now required.
:::

- [ ] Idempotent order creation :priority[P0] @api-team :due[2026-10-03]

:::decision{status=accepted date=2026-09-08 owner=@maya} Accordion layout on mobile
:::

```mermaid
flowchart LR
  A --> B
```

## Background {agent=skip}

:::agent
Constraints for AI agents working on this document.
:::
````

## Learn more

- [Feature guide](https://github.com/bislink360/styled-markdown/blob/main/docs/FEATURES.md)
- [Installation guide](https://github.com/bislink360/styled-markdown/blob/main/docs/INSTALL.md)
- [Agent skills for Claude and other agents](https://github.com/bislink360/styled-markdown/blob/main/docs/SKILLS.md)
- [Specification](https://github.com/bislink360/styled-markdown/blob/main/docs/SPEC.md)
- [Examples](https://github.com/bislink360/styled-markdown/tree/main/examples)

Author: **Roshan Alwis** · License: MIT
