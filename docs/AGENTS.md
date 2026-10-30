# Styled Markdown — Guide for AI Agents

> Paste this file (or link to it) in your agent's system prompt, `CLAUDE.md`, `AGENTS.md`, Cursor rules or Copilot instructions so agents read and write `.smd` correctly. For Cursor, GitHub Copilot and `AGENTS.md`, `smd skills install --target cursor,copilot,agents` writes a short version of this guide and the CLI (`.smd/smd.cjs`) into your project ([details](SKILLS.md#github-copilot-cursor-codex-windsurf-and-other-agents)). Agents that support skills can use the [styled-markdown skills](SKILLS.md) instead.

## Reading `.smd` files (save tokens)

Don't read `.smd` files whole with cat/Read. Use the CLI (`smd` on PATH, or `node skills/styled-markdown-reader/scripts/smd.cjs`):

0. **Shortcut:** `smd read <file>` does steps 1–2 in one call. It prints the whole agent view when it fits 2,000 tokens (`--max-tokens <n>` changes the budget), and otherwise the outline, so you can ask for sections next with `smd read <file> --section "<heading>"`.
1. `smd outline <file>` shows the title, status, summary and every section with its line range and token cost.
2. If the full agent view is small (≲ 2,000 tokens), read it once with `smd agent <file>`. Otherwise read only what you need with `smd agent <file> --section "<heading>"` (repeatable). `:::agent` instructions from other sections are always included. `--brief` condenses diagrams, long code, details and completed tasks. When you need an overview within a fixed budget, `smd agent <file> --max-tokens 2000` condenses the view and leaves out the least important sections; each one becomes a `[section omitted: …]` line with the `--section` command that reads it.
3. If the front matter lists `related:` documents, `smd outline <file> --related` adds each one's title, status, summary and token cost. Open a related document only when the question needs it.
4. Headings in the agent view carry `[L42]` line refs. Open raw lines only when you edit, and only that range.
5. Across documents: `smd tasks docs/` lists open tasks (priority, owner, due date, overdue first). `smd query "<selector>" docs/` pulls just the blocks you need, e.g. `decision[status=accepted]`, `risk[impact>=high]`, `api[method=POST]` or `question` (`--titles` for a one-line list). `smd decisions docs/ --status accepted` lists the binding decisions across documents, newest first (`--status open` for the ones still to decide). `smd risks docs/` is the risk register: every risk scored impact × likelihood, highest first, with owner, status and a one-line mitigation (`--json` for tools).
6. Many documents and you don't know which one matters: read the catalog (`smd index docs/`, or a committed `catalog.json`). Each entry has the path, title, summary, status, owners, tags, token costs, sections with ids, and counts of open tasks, decisions, risks, questions and APIs. Pick documents by summary, status and tags, then `smd outline` them or read `smd agent <file> --section "<id>"`.
7. With the [MCP server](#mcp-server) registered, the same steps are the tools `read`, `tasks`, `query` and `validate`.
8. Catching up on a document you've read before: `smd diff <file> --since <git-ref>` (e.g. `HEAD~3`, `main` or the commit you last saw) prints only the sections that changed, in the agent view, plus front-matter changes and removed headings.

How to interpret what you read:

- Front matter `status`: `approved` is authoritative, `draft`/`review` is tentative, `deprecated`/`archived` is history.
- `<agent-instructions>` (`:::agent`) is written **for you**. Follow it for any work the document covers.
- `:::human` blocks and `## … {agent=skip}` sections are context for people and are omitted from the agent view.
- `<danger>` is a hard constraint and `<warning>` an important caveat. `<question>` is unresolved: don't assume an answer; use the fallback in the agent instructions, or ask.
- `<decision status="accepted">` is binding. `proposed` isn't decided yet; `rejected`/`superseded` means don't do it.
- `<risk …>` is something to design around. `API POST /v1/x` is an endpoint definition.
- Tasks: `- [ ]` is open, `[P1]` is priority, `@name` is the owner, `(due …, OVERDUE)`.
- `[section omitted: …]` is a section left out by `--max-tokens`. Run the command it gives if the question needs that section.
- Styling never changes meaning.

## MCP server

Agents that speak the [Model Context Protocol](https://modelcontextprotocol.io) can use the reading commands as tools, without shell access. `smd mcp` runs a server over stdio:

| Tool | Arguments | Returns |
|---|---|---|
| `read` | `file`, `sections[]?`, `mode?` (`auto`, `outline`, `full`), `brief?` | As `smd read`: the whole agent view when it fits 2,000 tokens, else the outline; with `sections`, only those sections plus agent instructions from elsewhere |
| `tasks` | `paths[]?`, `all?`, `mine?` | Open tasks, one per line, overdue first |
| `query` | `selector`, `paths[]?`, `brief?`, `titles?` | Matching blocks in the agent view, as `smd query` |
| `validate` | `paths[]?` | Diagnostics as JSON, the same shape as `smd validate --json` |

Every session pays for the tool list, so it is kept small: about 500 tokens with the server's instructions (1,320 before 2.5.0, when `read` was three tools). The 2.4 tools `outline`, `section` and `agent` still work when a client calls them; `smd mcp --legacy-tools` lists them again. They stay until 3.0.

Paths are relative to the root folder: `--root <dir>`, or the folder the client starts the server in. The server refuses paths outside the root (symbolic links included), only reads `.smd` files, and embeds code only from files inside the root. `paths` defaults to the whole root. Nothing is written unless you pass `--allow-write`.

### Write tools (opt-in)

`smd mcp --allow-write` adds three tools that edit documents for the agent. Each changes only the lines it is about, keeps the file's line endings, stays inside the root, and refuses (writing nothing) when the result would have more validation errors than before.

| Tool | Arguments | Does |
|---|---|---|
| `check_task` | `file`, `line`, `done?`, `text?` | Ticks the task on that line (`line` as `tasks` prints it; `done: false` unticks it). With `text`, it refuses if the line no longer contains it, so a moved line is never ticked by mistake. |
| `set_status` | `file`, `status` | Sets the front matter `status` (`draft`, `review`, `approved`, `deprecated`, `archived`), and `updated` to today when the document has one. |
| `add_decision` | `file`, `section`, `title`, `body`, `status?`, `owner?` | Appends a `:::decision{status=… date=… owner=…} Title` block at the end of a section (default status `proposed`). |

### Set it up with one command

`smd init --agent claude|cursor|copilot|agents` (comma-separated for several; `--dir <project>`, default the current folder) installs everything an agent needs in a project: the skills (`claude`) or the reading and writing rules (`cursor`, `copilot`, and `agents` for `AGENTS.md`), the CLI, and the MCP server in the agent's own config file: `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor) or `.vscode/mcp.json` (Copilot in VS Code). Existing config files are merged (other servers are kept); a file that isn't plain JSON, such as one with comments, is left alone and the entry to add is printed. Run it again to update. `--no-mcp` skips the MCP config.

```bash
npx styled-markdown init --agent claude            # once the package is on npm
node path/to/smd.cjs init --agent cursor,agents    # with the CLI from a release or a skill folder
```

Or register it by hand with the npm package (`npx` downloads it on first use), or with the CLI bundled in the reader skill:

```bash
# Claude Code (add --scope project to share it through .mcp.json)
claude mcp add smd -- npx -y -p styled-markdown smd mcp
claude mcp add smd -- node skills/styled-markdown-reader/scripts/smd.cjs mcp
```

Cursor (`.cursor/mcp.json`) and Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "smd": { "command": "npx", "args": ["-y", "-p", "styled-markdown", "smd", "mcp", "--root", "/path/to/project"] }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "smd": { "type": "stdio", "command": "npx", "args": ["-y", "-p", "styled-markdown", "smd", "mcp", "--root", "${workspaceFolder}"] }
  }
}
```

Pass `--root` whenever the client may start the server outside your project, such as Claude Desktop. On Windows, clients that cannot run `npx` directly need `cmd /c npx …` (for Claude Code: `claude mcp add smd -- cmd /c npx -y -p styled-markdown smd mcp`). Logs go to stderr; stdout carries only protocol messages.

## Writing `.smd` files

Start from a template when one fits: `smd init docs/x.smd --template prd|adr|rfc|runbook|api|status-report|meeting-notes|postmortem|release-notes|okrs|onboarding|test-plan|pr-description|spec|plan|tasks --title "…"`. Otherwise, always start with front matter:

```yaml
---
smd: 2
title: Short title
summary: One or two sentences — what and why.
status: draft
owners: ["@team"]
updated: 2026-09-26
---
```

`smd: 2` (spec v2) shows text as written: straight quotes stay straight (type `—` or `’`, or add `typography: true`), only `https://…`, `www.…` and e-mail addresses become links, a heading's trailing `{word}` is heading text, and any `:name[…]` is a directive (`\:name[…]` keeps it text). When you edit an existing document, keep its `smd` value: `smd: 1` or no key keeps the v1 rules, and `smd migrate <file> --to 2` moves it to spec v2 without changing what it shows.

Then write normal Markdown, adding Styled Markdown only where it helps the reader:

| Need | Write |
|------|-------|
| Important note | `:::warning Title` … `:::` (also `note`, `info`, `tip`, `success`, `danger`, `question`) |
| Collapsible | `:::details Title` … `:::` |
| Instructions for agents | `:::agent` … `:::` |
| Colored text | `[text]{color=red}` (named colors: red orange amber yellow green teal cyan blue indigo purple pink gray muted accent) |
| Background / emphasis | `[text]{bg=amber}` · `[text]{weight=bold}` · `==highlight==` |
| Label | `:badge[Beta]{color=amber}` |
| Status | `:status[On track]{color=green}` |
| Progress | `:progress{value=60}` |
| Keys | `:kbd[Ctrl+S]` |
| Diagram | ```` ```mermaid ```` fenced block (`flowchart LR`, `sequenceDiagram`, `gantt`, `pie`, `erDiagram`, …) |
| Glossary | `:::glossary` with `- **API**: Application Programming Interface` items … `:::`; the first use of each term per section shows its definition on hover |
| Numbered figure | `:::figure{#fig-flow} Caption` around an image, diagram, table (`kind=table`) or code (`kind=listing`) … `:::`; refer to it with `:ref[fig-flow]` ("Figure 2") |
| Release history | `:::changelog` with `## 1.2.0 — 2026-03-01` headings (newest first) and their notes … `:::` |
| Quote | `:::quote{author="Ada Lovelace" source="Notes" cite="https://…"}` quoted text `:::` |
| Math | `$x^2$` inline; a block between `$$` lines of their own (or `$$ x^2 $$` on one line) |
| Front matter value in text | `{{version}}` with `version: "2.10"` in the front matter (`{{owner.name}}` for nested keys; `\{{x}}` keeps the braces) |
| Tabs | `::::tabs` / `:::tab Name` … `:::` / `::::` |
| Columns | `::::columns` / `:::column` … `:::` / `::::` |
| Card | `:::card{accent=green} Title` … `:::` |
| Numbered steps | `:::steps` wrapping an ordered list |
| File name on code | ```` ```ts title="src/app.ts" ```` (add `{2,5-7}` to highlight lines) |
| Embed real source | ```` ```ts file="../src/app.ts" lines="10-24" ```` with an empty body |
| Decision | `:::decision{status=accepted date=2026-09-01 owner=@a} Title` … `:::` |
| Risk | `:::risk{impact=high likelihood=medium owner=@b status=open} Title` … `:::` |
| Risk matrix | `:::risk-matrix Title` then `:::` (draws the document's risks; leave the body empty) |
| API endpoint | `:::api{method=POST path="/v1/items" auth=token} Title` … `:::` |
| Milestones | `:::timeline` around a list of `- **2026-10-01** — Beta` |
| Task metadata | `- [ ] Task :priority[P1] @owner :due[2026-10-15]` |
| KPI | `:metric[42%]{label="Activation" delta="+3%" trend=up}` |
| Human-only section | `## Background {agent=skip}` |

Rules:

- A line with only `:::` closes the **innermost** open container. Using more colons on outer containers (`::::tabs`) is optional but improves readability. In a document with `smd: 2`, a closing fence closes the innermost container opened with as many colons, so write each one with its opener's colons, and put `$$` math delimiters on lines of their own.
- Attributes go **directly after** the name with no space: `:::card{accent=blue} Title`, `[text]{color=red}`.
- Use named colors, not hex, unless matching a brand color.
- Don't repeat the front matter `title` as a `# H1`.
- Prefer semantic containers (`:::warning`) over colored text for anything important.

## Validate before you finish

```bash
smd validate path/to/file.smd          # human-readable
smd validate docs/ --json              # machine-readable, exit code 1 on errors
smd validate docs/ --fix               # apply safe automatic fixes
```

Every problem has a stable `code` (e.g. `container/unclosed`, `attrs/value`) and, where safe, a `fix` object `{ line, column, endColumn, replacement }` (0-based).

## Tasks and GitHub Issues

`smd issues docs/` is a dry run: it prints which tasks would get an issue, be checked off or have their issue closed, and changes nothing. Run it to show the user the plan. **Never add `--apply` (or `--create` / `--close`) unless the user asked for that specific change**: it creates and closes issues on GitHub as the user and edits the documents.

## Need plain Markdown?

`smd export file.smd --to md` produces GitHub-compatible Markdown (callouts → GitHub alerts, badges → code spans, etc.).
