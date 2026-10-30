<p align="center">
  <img src="docs/images/icon.png" width="112" alt="Styled Markdown icon">
</p>

<h1 align="center">Styled Markdown (<code>.smd</code>)</h1>

<p align="center">
  <b>Styled Markdown is Markdown for the specs, plans and docs that AI coding agents and people both read.</b><br>
  Decisions, risks, tasks and agent instructions that tools understand, validated in CI, and read by agents a section at a time.
</p>

<p align="center">
  <a href="https://github.com/bislink360/styled-markdown/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/bislink360/styled-markdown?label=release&color=4f46e5"></a>
  <a href="docs/COMPATIBILITY.md"><img alt="Spec: smd v2, stable" src="https://img.shields.io/badge/spec-smd%20v2%20stable-7c3aed"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-22c55e"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#for-ai-agents">For agents</a> ·
  <a href="https://bislink360.github.io/styled-markdown/playground/">Playground</a> ·
  <a href="docs/FEATURES.md">Feature guide</a> ·
  <a href="examples/">Examples</a> ·
  <a href="docs/SPEC.md">Specification</a>
</p>

---

## Install

**Claude Code:** the plugin brings the reading and writing skills and the `smd` MCP server.

```text
/plugin marketplace add bislink360/styled-markdown
/plugin install styled-markdown@styled-markdown
```

**Any agent, one project:** run this in your repository and commit the result. It installs the skills (Claude Code) or a rules file (Cursor, Copilot, `AGENTS.md`), the CLI at `.smd/smd.cjs`, the MCP server config and the `AGENTS.md` snippet.

```bash
npx styled-markdown init --agent claude      # or cursor, copilot, agents
```

**VS Code:** install **Styled Markdown** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=bislink360.styled-markdown), or `code --install-extension bislink360.styled-markdown`. **Cursor, VSCodium, Windsurf:** download **`styled-markdown-2.4.0.vsix`** from the [latest release](https://github.com/bislink360/styled-markdown/releases/latest), then `cursor --install-extension styled-markdown-2.4.0.vsix` (`codium …` for VSCodium), or **Install from VSIX…** in the Extensions view. Open a `.smd` file and press **`Ctrl+K V`** (**`Cmd+K V`** on macOS) for the live preview.

**CLI and library** (Node.js 22+):

```bash
npm install -g https://github.com/bislink360/styled-markdown/releases/download/v2.4.0/styled-markdown-2.4.0.tgz   # the smd command
smd validate docs/
```

> The npm registry and Open VSX listings are coming. Until the package is on npm, `npx styled-markdown …` doesn't work yet: use the files from the [latest release](https://github.com/bislink360/styled-markdown/releases/latest), or `node smd.cjs init --agent claude` with the [single-file CLI](docs/INSTALL.md#install-the-smd-cli).

Everything else (the MCP server on its own, JetBrains, Obsidian, MkDocs, Neovim and other editors, the GitHub Action, pre-commit hooks, Astro and Docusaurus): **[docs/INSTALL.md](docs/INSTALL.md)**. Or try it first in the **[web playground](https://bislink360.github.io/styled-markdown/playground/)**, nothing to install.

![A Styled Markdown document rendered in the preview](docs/images/01-overview.png)

## For AI agents

Styled Markdown makes the meaning of a document explicit, so an agent can tell an accepted decision from a proposal, a hard constraint from a side note, and its own instructions (`:::agent`) from content for people. The tools let it read only what a task needs:

| Command (CLI) or tool (MCP) | Gives the agent |
|---|---|
| `smd read spec.smd` · MCP `read` | The whole agent view when it fits a budget (default 2,000 tokens), else the outline with token costs; then `smd agent spec.smd --section "…"` (MCP `read` with `sections`) for just the parts it needs |
| `smd tasks docs/` · MCP `tasks` | Open tasks across documents with owner, priority and due date, overdue first: a work queue |
| `smd query "decision[status=accepted]" docs/` · MCP `query` | Just the blocks it asks for: decisions, risks, APIs, open questions |
| `smd validate docs/` · MCP `validate` | Problems with rule codes and machine-applicable fixes, as a gate before it commits |
| `smd mcp --allow-write` | Opt-in write tools: `check_task`, `set_status`, `add_decision`, each validated |

**What it saves, measured.** The agent view drops styling, layout and content marked for people only. On the [examples](examples/), the full agent view is **5–37% smaller** than the file (median ≈17%) and `--brief` **14–43%**; reading the outline plus one section costs **about 80% less** than the file on 6k–8k-token documents. The bigger the document and the more often it is read, the more that adds up. For a small document (under ≈1,500 tokens) the skill and tool overhead costs more than it saves: just read the file, as the reader skill does. Methodology, fixed costs and a break-even table: **[docs/TOKENS.md](docs/TOKENS.md)**; what the agent view keeps and drops: [docs/SKILLS.md](docs/SKILLS.md#how-token-reduction-works). `smd savings docs/` reports the numbers for your own repository.

Measured on [`examples/checkout-redesign.smd`](examples/checkout-redesign.smd), a ≈2,500-token PRD (≈4 characters per token):

| How it's read | ≈ tokens | Saving |
|---|---:|---:|
| Raw file | 2,471 | — |
| `smd agent` (whole document) | 1,540 | 38% |
| `smd agent --brief` | 1,406 | 43% |
| `smd outline` + `smd agent --section "open questions"` | 630 | 75% |
| `smd tasks examples/` vs. reading all 7 examples | 704 vs 7,328 | 90% |
| `smd query "decision, risk" examples/` vs. reading all 7 examples | 827 vs 7,328 | 89% |

**Spec-driven work:** `spec`, `plan` and `tasks` templates turn a feature into three linked documents an agent works through, with `smd tasks` as its queue and `smd validate` as the gate: [docs/SPEC-DRIVEN.md](docs/SPEC-DRIVEN.md). Setup for each agent: [docs/SKILLS.md](docs/SKILLS.md) and [docs/AGENTS.md](docs/AGENTS.md).

## Why Styled Markdown?

Markdown is the lingua franca of engineering docs, but teams keep stretching it. `**IMPORTANT:**` stands in for warnings, raw HTML for color and layout, and nobody finds a broken diagram until someone opens the file. AI agents reading those docs spend tokens on decoration and history, and can't tell a hard constraint from a side note.

- **Every `.md` file is already a valid `.smd` file.** Rename it and add structure where it helps.
- **Meaning is explicit.** `:::warning`, `:::decision`, `:::risk`, `:::api` and `:::agent` say what content *is*, not just how it looks.
- **Everything is validated,** with rule codes and automatic fixes, in VS Code and in CI.
- **Agents read only what matters,** through the agent view, the outline and queries.
- **Safe and portable.** No scripts, allowlisted styles, and a one-command export to HTML, GitHub Markdown, PDF or Word.
- **Stable.** Spec v2 gets no breaking changes; tools releases follow a [compatibility policy](docs/COMPATIBILITY.md).

| | Developers | Product & project managers | AI agents |
|---|---|---|---|
| Write | API blocks, code highlights, live code embeds, diagrams, math | Decisions, risks, timelines, KPIs, task owners and due dates | A writer skill with 16 templates and a validator |
| Read | Syntax-highlighted preview, outline, folding | Status header, colored callouts, overdue tasks in red | `smd read`, then only the needed sections |
| Check | Problems panel + quick fixes, `smd validate` in CI | `smd tasks` across all docs, overdue first | `--json` diagnostics with machine-applicable fixes |

## A taste of the syntax

````markdown
---
smd: 2
title: Saved Searches
summary: Let users save a search and get notified when new results match.
status: review
owners: ["@product-search"]
---

:metric[38%]{label="Abandonment" delta="-2.1pp" trend=down good=down}

:::warning Breaking change
`GET /v1/search` requires the `filters` object from 2026-11-01.
:::

- [ ] Idempotent order creation :priority[P0] @api-team :due[2026-10-03]

:::decision{status=accepted date=2026-09-08 owner=@maya} Accordion layout on mobile
Won usability testing on completion rate.
:::

```mermaid
flowchart LR
    A[Search] --> B[Save] --> C[Notify]
```

## Background {agent=skip}
History and research. People see it; agents skip it.

:::agent
- All prices are integer cents.
:::
````

Every construct, with what it renders, what an agent reads and its plain-Markdown fallback: **[the feature guide](docs/FEATURES.md)** (its [At a glance](docs/FEATURES.md#at-a-glance) section lists everything the format, the VS Code extension, the CLI and the skills do).

## At a glance

<table>
<tr>
<td width="50%"><img src="docs/images/02-project-management.png" alt="KPIs, tasks with owners and due dates, decision, risk and timeline"><br><sub><b>Project management:</b> KPI tiles, tasks with priority/owner/due date, decisions, risks, timelines</sub></td>
<td width="50%"><img src="docs/images/03-developers.png" alt="API endpoint, embedded source code with highlighted lines, sequence diagram"><br><sub><b>Developers:</b> API endpoints, code embedded from the repo with line highlights, Mermaid diagrams</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/images/04-dark-layout.png" alt="Dark theme with cards, tabs, flowchart and agent block"><br><sub><b>Layout & theming:</b> cards, columns, tabs, diagrams, math. Light and dark follow VS Code.</sub></td>
<td width="50%"><img src="docs/images/05-agent-view.png" alt="smd outline and smd agent output"><br><sub><b>Agent view:</b> an outline with per-section token costs, then only the section needed</sub></td>
</tr>
</table>

## On GitHub

GitHub renders `.md` files but shows `.smd` files as source. You can write Styled Markdown syntax in `.md` files, generate `.md` copies in CI with `smd export --to md`, or post the changed sections on pull requests: **[docs/GITHUB.md](docs/GITHUB.md)** compares them, with complete workflows. To check documents on every pull request, with each problem annotated on its line:

```yaml
- uses: bislink360/styled-markdown/validate@v2.4.0
  with:
    paths: docs
```

## Examples

| File | Shows |
|---|---|
| [showcase.smd](examples/showcase.smd) | Every feature on one page |
| [checkout-redesign.smd](examples/checkout-redesign.smd) | A realistic PRD: requirements, API, decisions, risks, rollout, agent constraints |
| [feature-spec.smd](examples/feature-spec.smd) | A short product spec |
| [adr-0007-event-bus.smd](examples/adr-0007-event-bus.smd) | Architecture decision record |
| [runbook-payments-latency.smd](examples/runbook-payments-latency.smd) | On-call runbook with safe-automation rules |
| [api-orders.smd](examples/api-orders.smd) | API reference with endpoints and embedded source |
| [status-report-2026-09.smd](examples/status-report-2026-09.smd) | Weekly status report with KPIs, risks and decisions needed |

Each has a rendered `.html` version next to it that you can open in a browser. More in [examples/README.md](examples/README.md).

## Documentation

| Document | For |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Installing and updating everything: agents, VS Code, the CLI and library, CI, pre-commit hooks, other editors and integrations, upgrading to 2.0 |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature guide: every construct with syntax, rendering, agent view and plain-Markdown fallback; the VS Code extension, the CLI and the Block Editor |
| [docs/SKILLS.md](docs/SKILLS.md) | Importing the agent skills into Claude Code, Claude.ai, the API/Agent SDK and other agents |
| [docs/AGENTS.md](docs/AGENTS.md) | One-page guide to paste into any agent's instructions, and the MCP server |
| [docs/SPEC-DRIVEN.md](docs/SPEC-DRIVEN.md) | Spec → plan → tasks with an agent |
| [docs/TOKENS.md](docs/TOKENS.md) | What the agent view saves, measured, and when it doesn't pay |
| [docs/EDITORS.md](docs/EDITORS.md) | Using `.smd` in Neovim, Helix, Zed and other editors with the language server and Tree-sitter highlighting |
| [docs/SPEC.md](docs/SPEC.md) | The formal specification (v2, with the v1 rules it keeps) and validation rules |
| [docs/GITHUB.md](docs/GITHUB.md) | Making `.smd` documents readable on GitHub: `.md` files, generated copies, pull request comments |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | The stability promise: spec v2 is stable, what each release may change, deprecations, release cadence |

## Contributing

Bug reports, ideas and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the repository layout and good first issues, and [Discussions](https://github.com/bislink360/styled-markdown/discussions) for questions. To build and test:

```bash
cd extension
npm install
npm run build          # bundle extension + CLI; refresh the CLI bundled in skills/*/scripts
npm test               # unit tests
npm run test:vscode    # integration checks inside a real VS Code
npm run package        # → styled-markdown-2.4.0.vsix
npm run build:npm      # → ../npm/dist (the npm package)
npm run build:playground  # → dist/playground (the web playground; open its index.html)
```

Press **F5** in `extension/` to launch an Extension Development Host with the examples open.

## Author

**Roshan Alwis**, [bislink360](https://github.com/bislink360)

## License

[MIT](LICENSE)
