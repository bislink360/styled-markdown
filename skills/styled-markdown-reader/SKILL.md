---
name: styled-markdown-reader
description: Read and query Styled Markdown (.smd) files token-efficiently, focusing only on meaningful content. Use this skill whenever you need information from a .smd file — answering questions about a spec/PRD/ADR/runbook/design doc, implementing what it describes, summarizing it, reviewing it, or checking its tasks, decisions, risks, APIs or open questions — even if the user just says "the spec", "the doc" or "the plan" and the file ends in .smd. Use it instead of reading .smd files with Read/cat, which wastes tokens on styling, layout and human-only content.
---

# Reading Styled Markdown (.smd) efficiently

`.smd` documents mix three kinds of content:

1. **Presentation:** colors, badges, layout.
2. **Human context:** background, research, history.
3. **What you need:** requirements, constraints, decisions, APIs, tasks.

The bundled CLI strips the first two and lets you pull only the sections you need.

```bash
node <this-skill-dir>/scripts/smd.cjs <command> …    # or `smd` if on PATH; Node 18+, no install
```

## Workflow

1. **`smd outline FILE`** (≈100–300 tokens) shows the title, status, summary, and every section with its line range and token cost. It also flags open tasks, decisions, risks, APIs and `AGENT INSTRUCTIONS`. The summary alone often answers the question.
2. **Read only what the task needs:**
   - Full agent view is small (≲ 2,000 tokens, shown on the outline's first line): run `smd agent FILE` once.
   - Specific question: run `smd agent FILE --section "Heading" [--section …]`. This matches heading text or id, includes subsections, and always appends `:::agent` instructions from elsewhere in the file.
   - Overview of a large doc: add `--brief`. It condenses diagrams, long code, `:::details` and completed tasks into pointers with line numbers.
   - Overview within a fixed budget: `smd agent FILE --max-tokens 2000`. It condenses as `--brief`, then leaves out the least important sections, never agent instructions or sections you asked for with `--section`.
3. **Related documents:** if the front matter lists `related:`, run `smd outline FILE --related`. It adds each related doc's title, status, summary and agent-view cost. Open a related doc (outline, then sections) only when the question needs it.
4. **Open raw lines only to edit.** Headings in the agent view carry `[L42]` line references. Read just that range with offset/limit, never the whole file. For writing or restructuring, use the `styled-markdown-writer` skill.

Across many documents:
- `smd index DIR` (or a committed catalog JSON) lists every document with title, summary, status, owners, tags, token costs (`tokens.agent`), sections (`id`, zero-based `line`/`endLine`, `tokens`) and counts of open tasks, decisions, risks, questions and APIs. Use it to pick which documents to read, then `smd outline` or `smd agent FILE --section "ID"` on those only.
- `smd tasks DIR` lists open tasks with priority, owner and due date, overdue first (`--mine @name` filters by owner).
- `smd risks DIR` is the risk register: every `:::risk` with its score (impact × likelihood, 1–16; `medium?` marks a level that was not set), owner, status, location and one-line mitigation, highest first, then an impact × likelihood matrix. Closed risks are left out unless `--all`; filter with `--status open,accepted` or `--owner @name`; `--json` for structured output.
- `smd query "SELECTOR" DIR` prints only the matching blocks in the agent view: `decision[status=accepted]`, `risk[impact>=high][status!=closed]`, `api[method=POST]`, `question`, `task[owner=@me][done=false]`, `heading[level=2]`. Commas combine selectors. Add `--titles` for one line per block, `--json` for structured output. Exit code 1 means no match.
- `smd decisions DIR --status accepted` lists the binding decisions across documents, one line each (date, title, owner, file:line, document › section), newest first; superseded and rejected ones are labelled. `--status open` lists decisions still to make, `--json` gives structured output.
- `smd meta FILE --no-diagnostics` gives JSON (outline, tasks, decisions, risks, agent blocks).

**MCP tools available?** If the `smd` MCP server is registered (tools `outline`, `section`, `agent`, `tasks`, `query`, `validate`), follow the same workflow with the tools instead of the shell: `outline` first, then `section` with the headings you need. Paths are relative to the server's root folder.

Catching up on a changed document:
- `smd diff FILE --since REF` (a commit, branch or tag such as `HEAD~3` or `main`) prints only what changed since then: front-matter changes, then each changed, renamed or added section in the agent view with `[L42]` refs into the current file, then removed headings. Use it instead of rereading a document you've already read. `smd diff DIR --since REF` covers every `.smd` file below, including new and deleted ones; `smd diff OLD.smd NEW.smd` compares two files.

## What the agent view means

| You see | Meaning |
|---|---|
| `<agent-instructions>` | Constraints written for you. Follow them for any work the document covers. |
| `<danger>` / `<warning>` | Hard constraint / important caveat |
| `<question>` | Unresolved. Don't pick an answer yourself; use the fallback in the agent instructions, or ask. |
| `<decision status="accepted">` | Binding. `proposed` isn't decided yet; `rejected`/`superseded` means don't do it. |
| `<risk impact=… likelihood=…>` | Design around it or test for it |
| `[risk matrix: …]` | A grid of the document's risks for people; the risks themselves are the `<risk>` blocks |
| `API POST /v1/x — …` | Endpoint definition; the following lines describe it |
| `<figure id="fig-x"> Figure 2: caption`, `Figure 2 (fig-x)` | A numbered figure (or Table/Listing) and a reference to it; the id in parentheses names the `<figure>` meant |
| front matter `status:` | `approved` is authoritative, `draft`/`review` is tentative, `deprecated`/`archived` is history |
| `[P1]`, `@name`, `(due …, OVERDUE)` | Task priority, owner, due date |
| `[^1]` … `[^1]: text` | A footnote reference and its definition, as written. In a `--section` excerpt, `Footnotes referenced above:` lists the definitions it needs. |
| `[code: path lines a-b …]` | Real source embedded by the doc. Read that file range if you need it (or rerun with `--embed`). |
| `[diagram: …]`, `[details: … omitted]` | Condensed by `--brief`. Read the given lines if you need them. |
| `[section omitted: ## X, L90-L128, ≈231 tokens — smd agent …]` | Left out by `--max-tokens`. Run the given command if the question needs that section. |

**No Node.js available?** Read the front matter and headings first (for example the first 20 lines, then search for `^## `), then read only the relevant line ranges. Skip `:::human` blocks and sections whose heading ends in `{agent=skip}`, and always read the `:::agent` block.

`:::human` blocks and `## … {agent=skip}` sections are left out on purpose. Use `--include-human` only when the task is specifically about that content (e.g. proofreading the background section).
