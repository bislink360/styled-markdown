---
name: styled-markdown-writer
description: Create and edit Styled Markdown (.smd) documents that follow the .smd rules — PRDs, ADRs, RFCs/design docs, runbooks, API references, status reports, meeting notes, postmortems, release notes, OKRs, onboarding guides, test plans, PR descriptions, specs and plans. Use this skill whenever the user asks to write, draft, create, convert, restructure or update a .smd file, asks for a spec/PRD/ADR/runbook/status report "in smd" or "styled markdown", wants a Markdown doc converted to .smd, or wants a document that both people and AI agents will read. It provides templates, the full syntax, authoring rules and a validator that fixes mistakes.
---

# Writing Styled Markdown (.smd)

`.smd` is Markdown plus a small, validated vocabulary: callouts, decisions, risks, API blocks, tasks with owners and due dates, KPIs, diagrams, and audience blocks. Documents are read by **people** in a styled preview and by **AI agents** through a compact "agent view". Write for both.

Tool (Node 18+, no install): `node <this-skill-dir>/scripts/smd.cjs <command>` (or `smd` if it's on PATH).

## Workflow

1. **Pick a template** that matches the request, and start from it rather than a blank page:

   | Request | Template |
   |---|---|
   | Product requirements, feature spec | `prd` |
   | Architecture/technical decision | `adr` |
   | Design proposal, RFC, tech spec | `rfc` |
   | On-call / operational procedure | `runbook` |
   | Endpoint reference | `api` |
   | Weekly/monthly update | `status-report` |
   | Meeting summary with actions | `meeting-notes` |
   | Incident review, post-incident report | `postmortem` |
   | Release announcement, what's new, upgrade guide | `release-notes` |
   | Objectives and key results, quarterly goals | `okrs` |
   | New team member guide | `onboarding` |
   | Test scope, strategy and cases, QA plan | `test-plan` |
   | Pull request description | `pr-description` |

   `smd init docs/name.smd --template prd --title "Saved searches"` creates the file with today's date filled in. The raw templates are in `assets/templates/`. For anything else, start from front matter + headings.

2. **Fill it with real content.** Delete template sections that don't apply, and never leave placeholder text such as `—`, `@owner` or `YYYY-MM-DD` in a finished document. If you don't know a value (an owner, a date), ask, or leave a `:::question` that says what's missing.

3. **Format, validate and fix:**

   ```bash
   node <skill>/scripts/smd.cjs fmt docs/name.smd
   node <skill>/scripts/smd.cjs validate docs/name.smd --fix
   ```

   `fmt` only changes layout (fence colons, attribute order and quoting, table columns, blank lines), never meaning.

   `--fix` repairs typos automatically. Fix any remaining errors yourself: each has a line:column, a message and a rule code. **A document is done only when validation reports 0 errors.**

4. **Check what agents will see:** `smd agent docs/name.smd --brief`. If it's still long, move narrative into `{agent=skip}` sections or `:::human` blocks.

## Rules you must follow

These are the rules the validator and renderers depend on. `references/syntax.md` has the complete reference with every attribute and allowed value; read it before using a construct you're not sure about.

1. **Front matter first:** `smd: 1`, `title`, a precise one- or two-sentence `summary`, `status` (`draft` · `review` · `approved` · `deprecated` · `archived`), `owners`, and `updated` (`YYYY-MM-DD`). Don't repeat the title as a `# H1`; start the body at `##`.
2. **Blocks** are `:::name{attrs} Title` … `:::`. Attributes go directly after the name with no space. A bare `:::` closes the innermost block. Write outer containers with more colons (`::::tabs`) for readability.
3. **Only known names:**
   - Blocks: `note` `info` `tip` `success` `warning` `danger` `question` `details` `card` `box` `tabs`/`tab` `columns`/`column` `steps` `timeline` `decision` `risk` `api` `agent` `human`.
   - Inline: `:badge` `:status` `:priority` `:due` `:metric` `:progress` `:kbd` `:mention`.
4. **Enumerated values exactly as specified:**
   - decision `status`: proposed, accepted, rejected, superseded, deprecated
   - risk `impact`/`likelihood`: low, medium, high, critical
   - api `method`: GET, POST, PUT, PATCH, DELETE…; `path` is required
   - priority: P0–P4
   - dates: `YYYY-MM-DD`
5. **Named colors only** (red orange amber yellow green teal cyan blue indigo purple pink gray muted accent) unless a brand hex is required.
6. **Tasks:** `- [ ] Verb-first task :priority[P1] @owner :due[2026-10-15]`. One owner per task where possible.
7. **Code:** always give fences a language. Use `title="path"` for file names, `{2,5-7}` to highlight lines, and `file="../src/x.ts" lines="10-24"` (empty body) to embed real source instead of pasting it.
8. **Diagrams:** ```` ```mermaid ```` with a valid first line (`flowchart LR`, `sequenceDiagram`, `gantt`, …).

## Writing for both audiences

`references/style-guide.md` covers this in depth. In short:

- **Meaning over decoration.** Use `:::warning`, `:::danger` or `:::decision` for things that matter. Color is decoration and must never be the only signal.
- **Hard constraints for implementers go in one `:::agent` block** near the end. Agents always receive it, even when they read a single section.
- **Narrative, history and research go under `## Background {agent=skip}` or in `:::human`.** People still see it; agents skip it, which keeps reads cheap.
- **Unresolved decisions go in `:::question`**, with who decides and by when. Put the interim fallback in the `:::agent` block.
- **Headings name the content** ("Requirements", "API", "Rollout") because agents select sections by heading.
