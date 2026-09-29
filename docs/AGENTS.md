# Styled Markdown — Guide for AI Agents

> Paste this file (or link to it) in your agent's system prompt, `CLAUDE.md`, `AGENTS.md`, `.cursorrules` or Copilot instructions so agents read and write `.smd` correctly. Agents that support skills can use the [styled-markdown skills](SKILLS.md) instead.

## Reading `.smd` files (save tokens)

Don't read `.smd` files whole with cat/Read. Use the CLI (`smd` on PATH, or `node skills/styled-markdown-reader/scripts/smd.cjs`):

1. `smd outline <file>` shows the title, status, summary and every section with its line range and token cost.
2. If the full agent view is small (≲ 2,000 tokens), read it once with `smd agent <file>`. Otherwise read only what you need with `smd agent <file> --section "<heading>"` (repeatable). `:::agent` instructions from other sections are always included. `--brief` condenses diagrams, long code, details and completed tasks.
3. Headings in the agent view carry `[L42]` line refs. Open raw lines only when you edit, and only that range.
4. Across documents: `smd tasks docs/` lists open tasks (priority, owner, due date, overdue first). `smd query "<selector>" docs/` pulls just the blocks you need, e.g. `decision[status=accepted]`, `risk[impact>=high]`, `api[method=POST]` or `question` (`--titles` for a one-line list).
5. With the [MCP server](#mcp-server) registered, the same steps are the tools `outline`, `section`, `agent`, `tasks`, `query` and `validate`.

How to interpret what you read:

- Front matter `status`: `approved` is authoritative, `draft`/`review` is tentative, `deprecated`/`archived` is history.
- `<agent-instructions>` (`:::agent`) is written **for you**. Follow it for any work the document covers.
- `:::human` blocks and `## … {agent=skip}` sections are context for people and are omitted from the agent view.
- `<danger>` is a hard constraint and `<warning>` an important caveat. `<question>` is unresolved: don't assume an answer; use the fallback in the agent instructions, or ask.
- `<decision status="accepted">` is binding. `proposed` isn't decided yet; `rejected`/`superseded` means don't do it.
- `<risk …>` is something to design around. `API POST /v1/x` is an endpoint definition.
- Tasks: `- [ ]` is open, `[P1]` is priority, `@name` is the owner, `(due …, OVERDUE)`.
- Styling never changes meaning.

## MCP server

Agents that speak the [Model Context Protocol](https://modelcontextprotocol.io) can use the reading commands as tools, without shell access. `smd mcp` runs a server over stdio:

| Tool | Arguments | Returns |
|---|---|---|
| `outline` | `file` | Sections with line ranges and token costs, as `smd outline` |
| `section` | `file`, `sections[]`, `brief?` | The agent view of only those sections, plus agent instructions from elsewhere |
| `agent` | `file`, `brief?`, `includeHuman?` | The agent view of the whole document |
| `tasks` | `paths[]?`, `all?`, `mine?` | Open tasks, one per line, overdue first |
| `validate` | `paths[]?` | Diagnostics as JSON, the same shape as `smd validate --json` |
| `query` | `selector`, `paths[]?`, `brief?`, `titles?` | Matching blocks in the agent view, as `smd query` |

Paths are relative to the root folder: `--root <dir>`, or the folder the client starts the server in. The server refuses paths outside the root (symbolic links included), only reads `.smd` files, and embeds code only from files inside the root. `paths` defaults to the whole root. Nothing is written.

Register it with the npm package (`npx` downloads it on first use), or with the CLI bundled in the reader skill:

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

Start from a template when one fits: `smd init docs/x.smd --template prd|adr|rfc|runbook|api|status-report|meeting-notes --title "…"`. Otherwise, always start with front matter:

```yaml
---
smd: 1
title: Short title
summary: One or two sentences — what and why.
status: draft
owners: ["@team"]
updated: 2026-09-26
---
```

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
| Math | `$x^2$` inline, `$$ … $$` block |
| Tabs | `::::tabs` / `:::tab Name` … `:::` / `::::` |
| Columns | `::::columns` / `:::column` … `:::` / `::::` |
| Card | `:::card{accent=green} Title` … `:::` |
| Numbered steps | `:::steps` wrapping an ordered list |
| File name on code | ```` ```ts title="src/app.ts" ```` (add `{2,5-7}` to highlight lines) |
| Embed real source | ```` ```ts file="../src/app.ts" lines="10-24" ```` with an empty body |
| Decision | `:::decision{status=accepted date=2026-09-01 owner=@a} Title` … `:::` |
| Risk | `:::risk{impact=high likelihood=medium owner=@b status=open} Title` … `:::` |
| API endpoint | `:::api{method=POST path="/v1/items" auth=token} Title` … `:::` |
| Milestones | `:::timeline` around a list of `- **2026-10-01** — Beta` |
| Task metadata | `- [ ] Task :priority[P1] @owner :due[2026-10-15]` |
| KPI | `:metric[42%]{label="Activation" delta="+3%" trend=up}` |
| Human-only section | `## Background {agent=skip}` |

Rules:

- A line with only `:::` closes the **innermost** open container. Using more colons on outer containers (`::::tabs`) is optional but improves readability.
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

## Need plain Markdown?

`smd to-md file.smd` produces GitHub-compatible Markdown (callouts → GitHub alerts, badges → code spans, etc.).
