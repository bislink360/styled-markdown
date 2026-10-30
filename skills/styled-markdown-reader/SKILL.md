---
name: styled-markdown-reader
description: Read Styled Markdown (.smd) files with few tokens. Use it whenever you need anything from a .smd file (answering questions about a spec/PRD/ADR/RFC/runbook/design doc, implementing, summarizing or reviewing it, checking its tasks, decisions, risks or APIs), even if the user just says "the spec", "the doc" or "the plan". Use it instead of reading large .smd files whole.
---

# Reading .smd

The bundled CLI drops styling and human-only text: `node <this-skill-dir>/scripts/smd.cjs <command>` (or `smd` on PATH; Node 22+, no install).

1. **Small file (under ≈6 KB, ≈1,500 tokens): read it directly.** Skip `:::human` blocks and `{agent=skip}` sections. Unsure of the size? Use step 2.
2. **`smd read FILE`**: the whole agent view when it fits 2,000 tokens, else the outline (sections with line ranges and token costs). The summary often answers the question.
3. **From an outline, read only what you need:** `smd agent FILE --section "Heading"` (repeatable; adds subsections and the `:::agent` instructions). `--brief` condenses diagrams, long code and done tasks.
4. **Open raw lines only to edit:** headings carry `[L42]` refs; read just that range. To write, use the `styled-markdown-writer` skill.

`smd` MCP server registered? Its `read` tool does the same (`sections` for step 3).

## Rules

- `<agent-instructions>` (`:::agent`) is binding: follow it for any work the document covers.
- `<decision status="accepted">` is binding; `proposed` is not decided; `rejected`/`superseded` means don't.
- `<question>` is unresolved: don't pick an answer; use the fallback in the agent instructions, or ask.
- `<danger>` is a hard constraint, `<warning>` a caveat. Front matter `status: approved` is authoritative, `draft`/`review` tentative.

Other markers, many documents (`index`, `tasks`, `query`, `risks`, `decisions`, `diff`) and reading without Node: `references/reading.md`.
