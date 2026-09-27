# Changelog

## 1.0.0 — 2026-09-26

First public release, implementing Styled Markdown spec v1.

### Format
- Superset of CommonMark + GFM with YAML front matter (status header, owners, tags, TOC, accent, theme).
- Callouts (`note` `info` `tip` `success` `warning` `danger` `question`, optionally collapsible) and `details`.
- Theme-aware named colors and whitelisted style attributes: `[text]{color bg border size weight font style}`, `==highlight==`.
- Inline directives: `:badge` `:status` `:priority` `:due` `:metric` `:progress` `:kbd` `:mention`, plus KaTeX math.
- Layout: `tabs`, `columns`, `card`, `box`, `steps`, `timeline`, with arbitrary nesting (a bare `:::` closes the innermost block).
- Project management: `decision`, `risk`, and tasks with owner, priority and due date (overdue detection).
- Developers: `api` endpoint blocks, code titles, line highlights, sandboxed live source embeds.
- Audience: `:::agent`, `:::human`, and `## Heading {agent=skip}`.
- All Mermaid diagram types, themed to the document palette.

### VS Code extension
- Live preview with scroll sync, double-click to source, task toggling, light/dark themes and a strict CSP.
- Validation with stable rule codes and quick fixes; completion, hover, color picker, outline, folding, 34 snippets.
- Agent view, brief agent view, copy agent view or selected sections, status-bar token counter.
- Export to HTML and GitHub Markdown; convert `.md` to `.smd`; validate the whole workspace.

### CLI (`smd`)
- `outline`, `agent`, `tasks`, `meta`, `validate` (`--json`, `--fix`, `--strict`), `render`, `to-md`, `from-md`, `init --template`, `templates`, `skills install`.

### Agent skills
- `styled-markdown-writer`: create and edit `.smd` following the rules, with 7 templates (PRD, ADR, RFC, runbook, API, status report, meeting notes), a full syntax reference and a style guide.
- `styled-markdown-reader`: token-efficient reading (outline → sections → raw lines only to edit).
