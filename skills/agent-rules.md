## Styled Markdown (.smd)

`.smd` files are Styled Markdown: Markdown plus `:::` containers, `{…}` attributes and `:name[…]` directives. Work with them through the `smd` CLI, run from the repository root as `{{smd}} <command>` (Node.js 18+, no install), or as `smd` if it is on PATH.

### Reading

- Don't read `.smd` files whole. Run `{{smd}} outline <file>` first: title, status, summary, and every section with its line range and token cost.
- If the full agent view is small (≲ 2,000 tokens), read it once with `{{smd}} agent <file>`. Otherwise read only what you need: `{{smd}} agent <file> --section "<heading>"` (repeatable). `--brief` condenses diagrams, long code and done tasks.
- If the front matter lists `related:` documents, `{{smd}} outline <file> --related` summarizes each one. Open a related document only when the question needs it.
- Headings in the agent view carry `[L42]` line refs. Open raw lines only to edit, and only that range.
- Across documents: `{{smd}} tasks docs/` lists open tasks, overdue first. `{{smd}} query "<selector>" docs/` prints matching blocks, e.g. `decision[status=accepted]`, `risk[impact>=high]`, `api[method=POST]`, `question` (`--titles` for one line each).
- `<agent-instructions>` is written for you: follow it. `<danger>` is a hard constraint, `<warning>` a caveat. `<question>` is unresolved: don't assume an answer. `<decision status="accepted">` is binding; `proposed` isn't decided; `rejected`/`superseded` means don't. Front matter `status: approved` is authoritative, `draft`/`review` tentative.

### Writing

- Start from a template when one fits (`{{smd}} templates` lists them: prd, adr, rfc, runbook, api, status-report, meeting-notes, postmortem, release-notes, okrs, onboarding, test-plan, pr-description): `{{smd}} init docs/x.smd --template <name> --title "…"`. Otherwise start with front matter: `smd: 1`, `title`, `summary` (one or two sentences), `status: draft`, `owners`, `updated`.
- Write normal Markdown and add Styled Markdown only where it helps: `:::warning Title` … `:::` (also `note`, `info`, `tip`, `danger`, `question`, `details`), `:::agent` for instructions to agents, `:::decision{status=accepted owner=@a} Title`, `:::risk{impact=high likelihood=low} Title`, `:::api{method=POST path="/v1/x"} Title`, `- [ ] Task :priority[P1] @owner :due[2026-10-15]`, `[text]{color=red}`, `:badge[Beta]{color=amber}`, ```` ```mermaid ```` diagrams.
- A line with only `:::` closes the innermost container. Attributes go directly after the name, with no space. Use named colors. Don't repeat the `title` as a `# H1`. Mark human-only sections `## Background {agent=skip}`.
- Before you finish, run `{{smd}} validate <file> --fix` until there are 0 errors, then `{{smd}} fmt <file>`.
- Full syntax: https://github.com/bislink360/styled-markdown/blob/main/docs/SPEC.md
