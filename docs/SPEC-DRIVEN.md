# Spec-driven work with Styled Markdown

A coding agent does better work from a written spec than from a chat message, and better still when the spec, the plan and the task list are documents it can read cheaply, query and check off. This guide sets up that loop with three templates and the `smd` CLI: **spec → plan → tasks**, with `smd tasks` as the agent's work queue and `smd validate` as the gate.

## Contents

- [The three documents](#the-three-documents)
- [1. Write the spec](#1-write-the-spec)
- [2. Plan it](#2-plan-it)
- [3. Break it into tasks](#3-break-it-into-tasks)
- [4. Let the agent work the queue](#4-let-the-agent-work-the-queue)
- [5. Check off and gate](#5-check-off-and-gate)
- [Prompts that work](#prompts-that-work)

## The three documents

Keep one folder per feature, with the three files side by side, so their `related:` links resolve:

```text
specs/saved-searches/
├── spec.smd    what and why: requirements (R1, R2…), acceptance criteria (AC1…), open questions
├── plan.smd    how: approach, decisions, risks, phases          related: [spec.smd]
└── tasks.smd   the work queue: tasks by phase, with requirement, priority, owner and due date
                                                                  related: [spec.smd, plan.smd]
```

```bash
smd init specs/saved-searches/spec.smd  --template spec  --title "Saved searches"
smd init specs/saved-searches/plan.smd  --template plan  --title "Saved searches"
smd init specs/saved-searches/tasks.smd --template tasks --title "Saved searches"
```

Each template has a `:::agent` block with the rules an agent follows for that document, and `smd: 2` front matter. An agent with the [writer skill](SKILLS.md) can fill them: "Write the spec for saved searches in specs/saved-searches/spec.smd".

## 1. Write the spec

The spec says what to build and how to tell that it works, not how to build it.

- **Requirements** get IDs (`R1`, `R2`) and a priority (`:priority[P0]`). Everything later refers to them.
- **Acceptance criteria** (`AC1`) are Given / When / Then rows tied to a requirement. They become tests.
- **Open questions** are `:::question` blocks. Write the fallback to build while a question is open, so an agent doesn't guess.
- **Constraints** an implementation must respect go in `:::warning` (or `:::danger` for hard limits). Background for people goes in a `## … {agent=skip}` section, which agents don't read.

Review it like code: `status: review` in the front matter, a pull request, then `status: approved`. An agent treats an approved spec as binding and a draft as tentative.

## 2. Plan it

Ask the agent for a plan against the approved spec: "Read specs/saved-searches/spec.smd and write plan.smd next to it." The plan holds:

- the **approach**, naming the requirements each part covers, with a Mermaid diagram if it helps;
- **decisions** as `:::decision{status=proposed}` blocks: you accept them (`status=accepted`) and the agent treats accepted ones as binding;
- **risks** as `:::risk` blocks with impact, likelihood and owner;
- **phases** with a "done when" each, usually an acceptance criterion.

## 3. Break it into tasks

"Break plan.smd into tasks.smd, one task per change, grouped by phase." Each task is one line:

```markdown
- [ ] Store saved searches per user (R1) :priority[P0] @maya :due[2026-11-14]
```

The requirement in brackets ties the task to the spec; the priority, owner and due date make it a queue. Leave tasks for the agent unassigned or give them an agent handle (`@agent`), and keep tasks for people with their owners.

## 4. Let the agent work the queue

`smd tasks` lists open tasks across documents, overdue first, then by priority, each with its file and line:

```bash
smd tasks specs/saved-searches/
smd tasks specs/ --mine @agent          # only the agent's tasks
```

```text
specs/saved-searches/tasks.smd:21  [ ] [P0] Store saved searches per user (R1) @maya (due 2026-11-14)  — Phase 1: Foundation
```

For each task, the agent reads only what it needs, not all three documents:

```bash
smd read specs/saved-searches/spec.smd                      # whole agent view if it is small, else the outline
smd agent specs/saved-searches/spec.smd --section requirements
smd query "decision[status=accepted]" specs/saved-searches/ # the binding decisions
smd query "question" specs/saved-searches/                  # what is still open
```

With the MCP server (`smd mcp`), the same steps are the `tasks`, `read` and `query` tools, with no shell access needed. `read {file, sections: ["requirements"]}` returns one section; `mode: "outline"` the outline.

## 5. Check off and gate

When a task is done and its checks pass, the agent checks it off in `tasks.smd`. Two ways:

- **Edit the line:** change `- [ ]` to `- [x]` on the line `smd tasks` printed. Any agent with file access can do this.
- **MCP, without file access:** run the server with writes allowed, `smd mcp --allow-write`, and call `check_task {file: "specs/saved-searches/tasks.smd", line: 21}` (`done: false` unticks). The server validates the document after the change and refuses paths outside its root. `set_status` moves a document's front matter `status` (say, the plan to `approved`), and `add_decision` appends a `:::decision` to a section when the approach changes.

`smd validate` is the gate, for the agent and in CI:

```bash
smd validate specs/ --strict
```

It catches broken syntax, links between the three documents (`related:` and `spec.smd#requirements`), task dates that aren't dates, and Mermaid errors, with `--fix` for the safe ones. Run it before every commit (a [pre-commit hook](INSTALL.md#pre-commit-hooks)) and in CI (the [GitHub Action](INSTALL.md#github-actions)), so a task list an agent edited stays valid. Overdue tasks show up as `task/overdue`.

`smd diff specs/ --since main` shows a reviewer what changed in the spec, plan and tasks on a branch, section by section.

## Prompts that work

| Step | Prompt |
|---|---|
| Spec | "Write a spec for *feature* in specs/*feature*/spec.smd from the spec template. Ask me about anything you would otherwise guess." |
| Plan | "The spec is approved. Write plan.smd next to it: approach, decisions (proposed), risks, three phases." |
| Tasks | "Break the plan into tasks.smd: one task per change, each with its requirement ID, a priority and @agent as owner." |
| Work | "Take the next open task from `smd tasks specs/feature/ --mine @agent`, implement it, run the tests and `smd validate specs/`, then check it off." |
| Review | "Summarize what changed in specs/ since main with `smd diff`, and list open questions." |

Agents set up with `smd init --agent` or the Claude Code plugin ([INSTALL.md](INSTALL.md#set-up-an-ai-agent)) already know the commands; others can be pointed at [AGENTS.md](AGENTS.md).
