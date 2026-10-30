# Reading Styled Markdown: full reference

Read this only when `SKILL.md` doesn't cover what you need. Commands run as `node <skill-dir>/scripts/smd.cjs <command>` (or `smd` on PATH).

`.smd` documents mix three kinds of content: presentation (colors, badges, layout), human context (background, research, history) and what you need (requirements, constraints, decisions, APIs, tasks). The agent view keeps only the last.

A document with `smd: 2` in its front matter follows the spec v2 rules (no `smd`, or `smd: 1`, keeps v1); the CLI reads each document with its own rules, so you don't need to.

## One document

- `smd read FILE [--max-tokens N]` (default 2000): the whole agent view when it fits, else the outline and a hint to read sections.
- `smd outline FILE` (≈100–300 tokens): title, status, summary, and every section with its line range and token cost. It flags open tasks, decisions, risks, APIs and `AGENT INSTRUCTIONS`.
- `smd agent FILE` is the full agent view. `--section "Heading"` (repeatable) matches heading text or id, includes subsections, and always appends `:::agent` instructions from elsewhere in the file.
- `--brief` condenses diagrams, long code, `:::details` and completed tasks into pointers with line numbers.
- `--max-tokens 2000` condenses as `--brief`, then leaves out the least important sections, never agent instructions or sections you asked for with `--section`.
- Related documents: if the front matter lists `related:`, `smd outline FILE --related` adds each related doc's title, status, summary and agent-view cost. Open one only when the question needs it.
- `smd meta FILE --no-diagnostics` gives JSON (outline, tasks, decisions, risks, agent blocks).

## Many documents

- `smd index DIR` (or a committed catalog JSON) lists every document with title, summary, status, owners, tags, token costs (`tokens.agent`), sections (`id`, zero-based `line`/`endLine`, `tokens`) and counts of open tasks, decisions, risks, questions and APIs. Use it to pick which documents to read.
- `smd tasks DIR` lists open tasks with priority, owner and due date, overdue first (`--mine @name` filters by owner).
- `smd risks DIR` is the risk register: every `:::risk` with its score (impact × likelihood, 1–16; `medium?` marks a level that was not set), owner, status, location and one-line mitigation, highest first, then an impact × likelihood matrix. Closed risks are left out unless `--all`; filter with `--status open,accepted` or `--owner @name`; `--json` for structured output.
- `smd query "SELECTOR" DIR` prints only the matching blocks in the agent view: `decision[status=accepted]`, `risk[impact>=high][status!=closed]`, `api[method=POST]`, `question`, `task[owner=@me][done=false]`, `heading[level=2]`. Commas combine selectors. `--titles` gives one line per block, `--json` structured output. Exit code 1 means no match.
- `smd decisions DIR --status accepted` lists the binding decisions, one line each (date, title, owner, file:line, document › section), newest first; superseded and rejected ones are labelled. `--status open` lists decisions still to make, `--json` gives structured output.

## Catching up on a changed document

`smd diff FILE --since REF` (a commit, branch or tag such as `HEAD~3` or `main`) prints only what changed: front-matter changes, then each changed, renamed or added section in the agent view with `[L42]` refs into the current file, then removed headings. Use it instead of rereading a document you've already read. `smd diff DIR --since REF` covers every `.smd` file below, including new and deleted ones; `smd diff OLD.smd NEW.smd` compares two files.

## MCP server

If the `smd` MCP server is registered, use its tools instead of the shell. Paths are relative to the server's root folder.

- `read {file, sections?, brief?, mode?}`: `mode` `auto` (default) works like `smd read`, `outline` and `full` force one; `sections` returns only those sections (with the agent instructions).
- `tasks`, `query` and `validate` work like the commands of the same name.
- Older servers list `outline`, `section` and `agent` instead of `read` (newer ones with `smd mcp --legacy-tools`): `outline` first, then `section` with the headings you need.

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
| `<glossary>` … `</glossary>` | The document's defined terms and abbreviations, listed once; the text uses them as written (not expanded) |
| `<changelog>` with `## 1.2.0 (2026-03-01)` lines | Release history, newest first: each line is a version and its release date, followed by what changed in it |
| `<quote author="…" source="…" cite="…">` | A quotation: the words are the author's, not the document's own claims |
| `<figure id="fig-x"> Figure 2: caption`, `Figure 2 (fig-x)` | A numbered figure (or Table/Listing) and a reference to it; the id in parentheses names the `<figure>` meant |
| front matter `status:` | `approved` is authoritative, `draft`/`review` is tentative, `deprecated`/`archived` is history |
| front matter `lang:` | The language the document is written in. It only changes labels in rendered HTML; the agent view's labels stay English |
| `[P1]`, `@name`, `(due …, OVERDUE)` | Task priority, owner, due date |
| Values such as a version in the text | The source may write them as `{{version}}`, a front matter variable the view fills in. To change one everywhere, edit the front matter key, not the `[L…]` line. |
| `[^1]` … `[^1]: text` | A footnote reference and its definition, as written. In a `--section` excerpt, `Footnotes referenced above:` lists the definitions it needs. |
| `[code: path lines a-b …]` | Real source embedded by the doc. Read that file range if you need it (or rerun with `--embed`). |
| `<included file="shared/terms.smd" section="…">…</included>` | Text included from another document, part of this one. `[L…]` refs inside point into that file, so edit it there. |
| `[include: shared/terms.smd § Pricing — …]` | An include that wasn't expanded (`--no-includes`, or it can't be read). Run `smd agent shared/terms.smd --section "Pricing"` if you need it. |
| `[diagram: …]`, `[details: … omitted]` | Condensed by `--brief`. Read the given lines if you need them. |
| `[section omitted: ## X, L90-L128, ≈231 tokens — smd agent …]` | Left out by `--max-tokens`. Run the given command if the question needs that section. |
| `[front matter could not be read]` and a `yaml` fence | The front matter is broken (often a missing closing `---`); the fence holds its raw lines, so title, status and the other keys are unknown |
| Plain words where the source has `:abbr[HTML]` | In `smd: 2`, a directive the tools don't know shows only its content (`HTML`); `\:abbr[…]` is literal text |
| `<note>`, `<warning>`… from a `> [!WARNING]` blockquote | A GitHub alert: the same callout as `:::warning` |

## Reading the raw file (small files, or no Node.js)

Read the front matter and headings first (for example the first 20 lines, then search for `^## `), then only the relevant line ranges. Skip `:::human` blocks and sections whose heading ends in `{agent=skip}`, and always read the `:::agent` block. The raw blocks mean what their agent-view tags mean: `:::decision{status=accepted}` is `<decision status="accepted">`, and so on.

In an `smd: 2` document: `$$` math opens and closes only on a line of its own (`$$5 per seat` is text); a closing fence closes the container opened with as many colons; a heading's trailing `{word}` is part of its text (`{#id}`, `{.class}`, `{key=value}` are attributes); and any `:name[…]` is a directive whose content is the text (`\:name[…]` is literal).

`:::human` blocks and `## … {agent=skip}` sections are left out of the agent view on purpose. Use `--include-human` only when the task is specifically about that content (e.g. proofreading the background section).
