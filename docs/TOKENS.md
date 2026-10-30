# Token cost: when the smd tools pay off

Styled Markdown's agent tools save tokens by reading less of a document. They also cost tokens: the skill descriptions, the reader skill, the agent rules and the MCP tool definitions all sit in the agent's context. This page measures both, so you can see the **net** effect and the document size from which the tools pay off.

Short answer, measured in 2.5.0:

- On one read of a short document (under ≈1,500 tokens, ≈6 KB), the tools don't pay for their own instructions. The reader skill therefore tells agents to read such files directly.
- Answering a question about one section pays off from ≈1,500 tokens with the reader skill, ≈1,000 with agent rules, ≈700 with no fixed cost. On 6k–8k-token documents a section read costs 80% less than the raw file.
- Reading a whole document through the agent view saves 5–37% on the examples (`--brief` 14–43%), so it needs larger documents or several reads per session before it beats the fixed cost.

## Method

The benchmark is `extension/test/bench/netTokens.ts` (`npm run bench:tokens`). For every document it simulates two agent tasks and counts the tokens each way of reading puts into the agent's context:

| Task | Plain reading | With the smd tools |
|---|---|---|
| (a) Answer a question about one section | Read the whole raw file | `smd outline` + `smd agent --section`; or `smd read`, plus `--section` when `smd read` returned the outline |
| (b) Understand the whole document | Read the whole raw file | `smd agent` (full agent view); `smd agent --brief`; `smd read` |

For (a), every section an agent sees (no `{agent=skip}`, no subsections of its own) is asked about once, and the table shows the median. `smd read` prints the whole agent view when it fits 2,000 tokens, else the outline; until that command is in the built CLI, the benchmark applies the same rule in process.

Fixed costs are read at run time from the repository, not typed in:

- **Skill descriptions:** the front matter of both skills, in context in every Claude Code session.
- **Reader `SKILL.md`:** loaded when the reader skill triggers.
- **Agent rules:** `skills/agent-rules.md` as `smd skills install --target` writes it (Cursor rule, Copilot instructions, `AGENTS.md` section).
- **MCP:** the `tools/list` result as JSON plus the server's instructions, asked from `dist/cli.js mcp`. Clients render tool definitions in their own format, so this is an estimate.

Other assumptions:

- **Tokens** are characters / 4, the same estimate `smd outline` prints. `--tokenizer o200k_base` gives exact counts for that OpenAI encoding if `js-tiktoken` is installed. There is no public tokenizer for current Claude models.
- **Each tool call** adds 20 tokens for the call and the result's framing, for raw reads too. Claude Code's Read tool also adds a line number to every line of a raw file. The benchmark doesn't count that, so it favors raw reading slightly.
- **Output tokens** cost about 5× input tokens. The tasks here are reads, so they are input tokens; the writer skill's guidance (write meaning, not styling) is about output.
- **Larger documents** are built from the examples, one after another, with one `:::agent` block and unique headings (`composite ≈8k` and so on).

### Accuracy: a coverage proxy, not an LLM

The benchmark can't run a model, so it can't check answers. As a **proxy**, it checks that the text the agent needed is present in what it read. For each line of the target section (or of the whole agent view) it takes the line's key phrase: its longest run of three or more plain words between markup characters. Coverage is the share of those phrases found in what was read.

Read the coverage column as "did the agent at least see the right text". It doesn't show whether the agent understood it. Raw reads score 89–100% rather than 100% only because some phrases are written by the view itself (a KPI tile's label, "Figure 1" for `:ref`); the raw file holds that content in another form.

## Results

Measured on 2026-10-30 with the 2.5.0 skills, from `npm run bench:tokens -- --docs`. Numbers are ≈ tokens, including 20 per tool call.

### Fixed costs, before and after 2.5.0

| Overhead | When it is paid | 2.4.0 | 2.5.0 |
|---|---|---:|---:|
| Skill descriptions (reader + writer) | every Claude Code session | 321 | 256 |
| Reader `SKILL.md` | when the reader skill triggers | 2,310 | 482 |
| `agent-rules.md` (as installed) | every session (`AGENTS.md`) or when a `.smd` file is in context (Cursor, Copilot) | 819 | 279 |
| MCP `tools/list` + instructions | every session with the server | 1,351 | 1,351 |
| Writer `SKILL.md` | when the writer skill triggers | 2,091 | 1,647 |
| Writer syntax reference | when the writer needs syntax | 4,545 (one file) | 367 index + one topic (198–944, median 645) |
| Writer style guide | when the writer reads it | 1,146 | 1,146 |

The MCP row was measured before the slimmer MCP tool list of 2.5.0 (one `read` tool in place of `outline`, `section` and `agent`); run the benchmark again to see the new number.

### (a) Answer a question about one section

| Document | raw | sections | Read raw | outline + section | `smd read` (+ section) | saving | saving incl. skill | coverage raw / outline+section / read |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| examples/adr-0007-event-bus.smd | 756 | 3 | 776 | 482 | 619 | 20% | -75% | 100% / 100% / 100% |
| examples/api-orders.smd | 748 | 5 | 768 | 374 | 582 | 24% | -72% | 100% / 100% / 100% |
| examples/checkout-redesign.smd | 2,471 | 9 | 2,491 | 710 | 1,560 | 37% | 8% | 89% / 100% / 100% |
| examples/feature-spec.smd | 747 | 5 | 767 | 451 | 638 | 17% | -79% | 97% / 97% / 97% |
| examples/runbook-payments-latency.smd | 660 | 4 | 680 | 443 | 572 | 16% | -93% | 92% / 100% / 100% |
| examples/showcase.smd | 1,549 | 10 | 1,569 | 553 | 1,302 | 17% | -30% | 98% / 99% / 99% |
| examples/status-report-2026-09.smd | 370 | 5 | 390 | 329 | 371 | 5% | -184% | 100% / 100% / 100% |
| docs/COLLABORATION-RFC.smd | 7,986 | 15 | 8,006 | 1,407 | 1,407 | 82% | 73% | 100% / 100% / 100% |
| docs/SPEC-V2-PROPOSALS.smd | 5,975 | 20 | 5,995 | 1,224 | 1,224 | 80% | 67% | 100% / 100% / 100% |

"saving" compares `smd read` (+ section) with the raw read; "incl. skill" adds the reader skill's fixed cost (descriptions + `SKILL.md`, 738 tokens) to one read. On the small examples `smd read` returns the whole agent view, so outline + section is cheaper for a single question; on the large documents `smd read` returns the outline and the two are the same.

### (b) Understand the whole document

| Document | Read raw | agent view | `--brief` | `smd read` | agent view saving | `--brief` saving | coverage raw / agent / brief / read |
|---|---:|---:|---:|---:|---:|---:|---|
| examples/adr-0007-event-bus.smd | 776 | 619 | 592 | 619 | 20% | 24% | 100% / 100% / 100% / 100% |
| examples/api-orders.smd | 768 | 582 | 551 | 582 | 24% | 28% | 100% / 100% / 91% / 100% |
| examples/checkout-redesign.smd | 2,491 | 1,560 | 1,426 | 1,560 | 37% | 43% | 98% / 100% / 85% / 100% |
| examples/feature-spec.smd | 767 | 638 | 537 | 638 | 17% | 30% | 96% / 96% / 75% / 96% |
| examples/runbook-payments-latency.smd | 680 | 572 | 572 | 572 | 16% | 16% | 96% / 100% / 100% / 100% |
| examples/showcase.smd | 1,569 | 1,302 | 1,160 | 1,302 | 17% | 26% | 97% / 98% / 78% / 98% |
| examples/status-report-2026-09.smd | 390 | 371 | 335 | 371 | 5% | 14% | 100% / 100% / 77% / 100% |
| docs/COLLABORATION-RFC.smd | 8,006 | 6,051 | 5,952 | 641 | 24% | 26% | 99% / 99% / 95% / 10% |
| docs/SPEC-V2-PROPOSALS.smd | 5,995 | 5,486 | 5,486 | 676 | 8% | 8% | 100% / 100% / 100% / 19% |

`--brief` trades coverage for tokens: it replaces diagrams, long code and done tasks with pointers, which is why its coverage drops to 75–95%. On the two large documents `smd read` returns the outline (10–19% coverage): it is a map for choosing sections, not the whole document.

### By document size

Net = tokens of the raw read minus tokens of the tools (and the reader skill's fixed cost, where shown), for one read in a session. Positive means the tools save.

| Document | raw | (a) `smd read` + section | (a) net, no fixed | (a) net, skill | (b) `--brief` | (b) net, no fixed | (b) net, skill |
|---|---:|---:|---:|---:|---:|---:|---:|
| examples/status-report-2026-09.smd | 370 | 371 | 19 | -719 | 335 | 55 | -683 |
| examples/runbook-payments-latency.smd | 660 | 572 | 108 | -630 | 572 | 108 | -630 |
| examples/feature-spec.smd | 747 | 638 | 129 | -609 | 537 | 230 | -508 |
| examples/api-orders.smd | 748 | 582 | 186 | -552 | 551 | 217 | -521 |
| examples/adr-0007-event-bus.smd | 756 | 619 | 157 | -581 | 592 | 184 | -554 |
| examples/showcase.smd | 1,549 | 1,302 | 267 | -471 | 1,160 | 409 | -329 |
| examples/checkout-redesign.smd | 2,471 | 1,560 | 931 | 193 | 1,426 | 1,065 | 327 |
| composite ≈4k | 4,108 | 701 | 3,427 | 2,689 | 2,429 | 1,699 | 961 |
| docs/SPEC-V2-PROPOSALS.smd | 5,975 | 1,224 | 4,771 | 4,033 | 5,486 | 509 | -229 |
| docs/COLLABORATION-RFC.smd | 7,986 | 1,407 | 6,599 | 5,861 | 5,952 | 2,054 | 1,316 |
| composite ≈8k | 9,760 | 1,552 | 8,228 | 7,490 | 6,038 | 3,742 | 3,004 |
| composite ≈16k | 16,573 | 2,557 | 14,036 | 13,298 | 10,368 | 6,225 | 5,487 |
| composite ≈32k | 32,499 | 4,818 | 27,701 | 26,963 | 20,811 | 11,708 | 10,970 |

With the small-document shortcut, an agent with the reader skill reads the five smallest examples raw, so in practice it pays the raw read plus the skill's fixed cost there, not the "(a) net, skill" figure.

### Break-even

The raw size, in tokens, above which the tools cost less than reading the file. It comes from a straight-line fit of the tools' cost against raw size over all the documents above. "Skill" is the reader skill's fixed cost (descriptions + `SKILL.md`); with 5 reads in one session it is shared by 5.

| Task and method | no fixed cost | skill, 1 read | skill, 5 reads | agent rules | MCP |
|---|---:|---:|---:|---:|---:|
| (a) one section: outline + section | 400 | 1,200 | 600 | 700 | 2,000 |
| (a) one section: `smd read` (+ section) | 700 | 1,500 | 800 | 1,000 | 2,200 |
| (b) whole doc: agent view | 400 | 3,000 | 1,000 | 1,400 | 5,100 |
| (b) whole doc: `--brief` | 600 | 2,600 | 1,000 | 1,300 | 4,300 |

The same table with the 2.4.0 skill files (the MCP column is unchanged):

| Task and method | no fixed cost | skill, 1 read | skill, 5 reads | agent rules | MCP |
|---|---:|---:|---:|---:|---:|
| (a) one section: outline + section | 400 | 3,400 | 1,000 | 1,300 | 2,000 |
| (a) one section: `smd read` (+ section) | 700 | 3,700 | 1,300 | 1,600 | 2,200 |
| (b) whole doc: agent view | 400 | 9,500 | 2,200 | 3,300 | 5,100 |
| (b) whole doc: `--brief` | 600 | 7,800 | 2,000 | 2,800 | 4,300 |

The 1,500-token break-even of a one-section read with the skill is where the reader skill's small-document shortcut sits.

## Reproduce

```bash
cd extension
npm ci
npm run build                                  # the MCP cost is asked from dist/cli.js; without it, tools/list only
npm run bench:tokens                           # examples/
npm run bench:tokens -- --docs                 # examples/ and docs/*.smd (the tables above)
npm run bench:tokens -- --tokenizer o200k_base # exact OpenAI counts (needs js-tiktoken)
npm run bench:tokens -- --json                 # raw numbers
```

The output is Markdown with the same tables as this page. The 2.4.0 rows came from the same script run with the 2.4.0 versions of `skills/agent-rules.md`, `skills/styled-markdown-reader/SKILL.md`, `skills/styled-markdown-writer/SKILL.md` and `references/syntax.md` checked out.

For your own documents, `smd outline FILE` prints the raw and agent-view cost of one document and of each section, and `smd savings docs/` reports the raw, agent-view and `--brief` tokens of every document in a folder, with the saving in tokens and dollars.
