# Changelog

## 1.5.0 — 2026-10-01

### ⚠️ Breaking changes

### Added
- **GitHub Action** `bislink360/styled-markdown/validate@v1.5.0` (in this repository's `validate/` folder): validates `.smd` files on pull requests, shows each problem as an inline annotation and writes a job summary (counts per severity and the first 50 problems, linked to their lines). It runs the bundled CLI with the runner's Node.js 18+, without installing anything. Inputs: `paths` (one per line, spaces allowed), `fail-on` (`error`, `warning` or `never`), `strict`, `config`, `mermaid`, `stale-after`, `summary` and `cli`.
- **`smd validate --format github`**: one GitHub workflow command per problem (`::error`/`::warning`/`::notice file=…,line=…,col=…,endColumn=…,title=smd <code>::<message>`; hints are left out), with 1-based positions, paths relative to `$GITHUB_WORKSPACE` (else the current folder) and workflow-command escaping. `--format json` is the same as `--json`; text and `--json` output are unchanged.
- **`smd validate --summary <file>`** appends a Markdown summary of the run to a file, with any output format, e.g. `--summary "$GITHUB_STEP_SUMMARY"`.
- **Pre-commit hooks:** the repository is now a [pre-commit](https://pre-commit.com) hook repository (`.pre-commit-hooks.yaml`) with `smd-validate` (fails on errors; `args: [--strict]` for warnings too), `smd-fmt` (formats the staged `.smd` files in place) and `smd-fmt-check` (fails on unformatted files without changing them). They use `language: node`: pre-commit installs a new private root `package.json` whose `smd` bin is the bundled single-file CLI, with no dependencies and nothing from the npm registry. `docs/INSTALL.md` ("Pre-commit hooks") also has copy-paste setups for lint-staged with husky and for a plain `.git/hooks/pre-commit`.
- **PDF export:** `smd pdf <file.smd> [-o out.pdf] [--format A4|Letter] [--landscape]` prints the rendered page to PDF with a headless Chromium from Playwright or Puppeteer, which you install (smd still has no dependencies; they are found in your project or global folder, like js-tiktoken for `--tokenizer`). Without one it exits 2 and suggests `smd render` + the browser's Print → Save as PDF. It waits for Mermaid diagrams and fonts (the page runtime now sets `data-smd-ready` on `<html>`), so diagrams print as vector SVG.
- **Print stylesheet** for `smd render` and Export to HTML pages: page margins, the light palette, no copy buttons or tab bar, every tab printed under its label, collapsed blocks opened while printing, wrapped code, and headings kept with the next block and blocks kept whole across page breaks where they fit. `:::agent` blocks are left out of print. `{.page-break}` on a heading or block starts a new page and `{.no-print}` leaves a block out of the printout (existing attribute syntax).
- CLI: `--` ends the options, so every later argument is a file, even one whose name starts with `-` (e.g. `smd validate -- -draft.smd`). Arguments before `--` are read as before.
- npm: **remark and rehype plugins** for Astro, Docusaurus, Next.js and other unified pipelines: `import { remarkSmd } from 'styled-markdown/remark'` (or `rehypeSmd` from `styled-markdown/rehype`). They render the whole file with `renderSmd` into one raw HTML node, so the output matches `smd render`; the page loads `styled-markdown/smd.css`. Options: `test` (which files), `header: false` (no title header), `frontMatter` (front matter the host already removed; Astro's is found automatically), `readFile` (embeds, with the file), plus `allowHtml`, `agentBlocks`, `today`. `file.data.smd` holds the front matter and headings. Works with `.md` files; `.mdx` files can't hold `.smd` syntax, because MDX parses `{…}` as JSX first. No new dependencies. Also exported from the main entry, with `renderSmdFile(file, options)`.
- npm: a **markdown-it plugin**, `styled-markdown/markdown-it` (ESM and CommonJS, with types), so any markdown-it 13 or 14 host renders `.smd` syntax: `md.use(smd, options)`. It adds rules to the host's own instance (never a second markdown-it), keeps the host's options, other plugins and code highlighting, and leaves plain Markdown unchanged. Options turn containers, inline directives, attribute lists, `==marks==`, math, task lists and `.smd` code fences on or off (all on by default), and opt into code frames, heading ids, `data-line` source lines and the front matter header; `agentBlocks`, `readFile` (embeds, off unless given) and `today` work as in `renderSmd`. markdown-it is an optional peer dependency: the package keeps zero runtime dependencies. Style the output with `styled-markdown/smd.css`. `renderSmd` uses the same rules, and its output is unchanged.
- VS Code: `.md` files that use `.smd` syntax render in VS Code's **built-in Markdown preview** (containers, directives, attribute lists, marks, Mermaid diagrams, code titles and embeds; math stays VS Code's own while `markdown.math.enabled` is on). New setting `smd.markdownPreview.enabled` (default on). Opening a Markdown preview now activates the extension.
- **`smd build <dir> [--out site] [--title "…"] [--base /docs/] [--md] [--clean]`**: a static docs site. Every `.smd` file (and `.md` with `--md`) becomes a page in the same folder structure; `index.html` is the folder's `index.smd` or `README`, else a generated index of every document. Links between documents point at their pages (anchors kept, external links untouched) and linked local files such as images are copied, so the site works from disk and from any static host (`--base` for absolute links). Pages get a sidebar ordered by title, breadcrumbs, previous/next links, backlinks ("Linked from"), a client-side search box (an index of titles, headings, summaries and section excerpts in `_smd/search-index.js`, no external service) and a link to `dashboard.html`: open tasks (overdue first), decisions and open risks with the impact × likelihood matrix across the site. Stylesheet and scripts are written once to `_smd/`; only pages with diagrams or math load Mermaid and KaTeX from a CDN. `--out` must be outside the source folder and new, empty or a previous build (recognized by its `.smd-site.json`), and `--clean` deletes only the files that build recorded.
- Library: `buildSite(sources, options)` returns the site's files, the local files to copy and the page list; `SMD_SITE_CSS` and `SMD_SITE_JS` are its stylesheet and script.

### Changed

### Deprecated

### Fixed
- `:priority[…]` with a value such as `constructor` rendered a broken color; unknown values are gray, as documented.

## 1.4.0 — 2026-09-30

No breaking changes. Documents, CLI commands and flags, diagnostic codes and messages, library exports, extension commands and settings from 1.3.0 all keep working, and every document that passed `smd validate` still passes: there are no new rules. New: four commands (`smd decisions`, `smd risks`, `smd report`, `smd issues`), export flags on `smd tasks`, one block (`:::risk-matrix`), and two VS Code features (the SMD Tasks view and the status bar picker). `smd issues` is the first command that can write to an external service: it is a dry run unless you add `--apply`.

### Added
- VS Code: an **SMD Tasks** view in the Explorer (shown in workspaces with `.smd` files) lists the tasks of every `.smd` file in the workspace:
  - **Group Tasks By…** (view title bar) switches between owner (Unassigned last; a task with two owners is under both), due date (Overdue, Today, This week, Later, No due date) and document; the choice is remembered per workspace
  - inside every group: overdue first, then by priority and due date, as in `smd tasks`
  - open tasks only, or all with **Show Completed Tasks**; each task shows its priority, due date (and "overdue") and owners, with the section and file in the tooltip
  - click a task to open it at its line; tick its checkbox to check it off (or uncheck it) in the file, which is saved unless it already had unsaved changes
  - follows unsaved edits, saves and files created or deleted on disk; the view's badge shows the number of overdue tasks
  - new commands: `smd.groupTasksBy`, `smd.showCompletedTasks`, `smd.hideCompletedTasks`, `smd.refreshTasks` and `smd.openTask`; the extension now also activates when the workspace contains `.smd` files
- **`smd decisions <files|dirs>`**: a decision log across documents (an ADR index). Every `:::decision`, newest date first and undated last, one line each with location, date, status, title, owner and document › section. `--status accepted,proposed` filters by status (`open` = proposed, the default status), `--owner @name` by owner, `--json` prints structured rows.
- **`smd decisions --md`**: the log as an ADR index document to commit (front matter and a table with status badges, each decision linked to its section, rejected and superseded ones struck through). With `-o docs/decisions.smd` the links are relative to that file, so it passes `smd validate` and `smd fmt --check`; `--title` sets its title.
- Library: `decisionLog(documents, { status, owner })` and `decisionLogMarkdown(entries, { title, link })`, with `DECISION_STATUS_FILTERS` and `isInactiveDecision`.
- `smd risks <files|dirs...>`: a risk register of every `:::risk` block across documents, scored impact × likelihood (`low` 1 … `critical` 4, so 1–16) and sorted by score, then impact, then path and line. Each line shows the score, levels, title, owner, status, location, section and a one-line mitigation (a `Mitigation:` line from the body, else its first sentence), followed by an impact × likelihood matrix of counts. A missing or unknown level counts as `medium` and shows as `medium?`; a missing status is `open`. Closed risks are left out unless `--all`; `--status open,mitigated,…` and `--owner @name` filter; `--json` prints the register for tools.
- `smd risks --html [-o risks.html]`: a standalone, theme-aware (light/dark) page with a colour-coded impact × likelihood matrix (green → red by score) whose cells link to the register table below it. Uses the same stylesheet as `smd render`.
- `:::risk-matrix [title]` block: draws the impact × likelihood matrix of the risks in the same document (closed ones left out; risks with an `{#id}` are linked). Plain-Markdown export turns it into a table, and the agent view into a one-line `[risk matrix: …]` pointer, since the risks are already `<risk>` blocks. Completion, a `risk-matrix` snippet and validation know it.
- Library: `riskRegister`, `documentRisks`, `riskScore`, `riskMatrix`, `riskSummary`, `compareRisks`, `riskLine`, `riskMatrixText`, `riskRegisterText`, `riskRegisterSummary`, `riskMatrixHtml`, `riskRegisterHtml`, `riskBand`, `renderRiskPage`, the `RISK_STATUS` list, and their types.
- **`smd report <files|dirs> --since <date|git-ref> [-o report.smd] [--title "…"] [--today YYYY-MM-DD]`**: drafts a status report in the shape of the `status-report` template from how tasks and decisions changed since a Git commit, branch or tag, or a date (the last commit before it). It lists tasks done since and added since, removed ones, open tasks (overdue, due in the next 7 days, then the rest by priority), open risks with impact high or critical, decisions added or changed since, decisions still proposed and the source documents, each linked to its section, with a summary left for a person to write. Tasks are matched by document and text, so a reworded task counts as removed and added. Outside a Git repository, a date reports the current state only and the draft says so. The draft passes `smd validate --strict` and `smd fmt --check`, adds no tasks or decisions of its own, and `-o` never overwrites an existing file.
- Library: `statusChanges(before, after, options)`, `statusReportMarkdown(changes, options)` and `statusReport(before, after, options)`, with the types `StatusChanges`, `StatusReportOptions`, `ReportDocument`, `ReportTask`, `ReportDecision` and `ReportRisk`.
- `smd tasks --csv` exports tasks for spreadsheets: RFC 4180 with a header row and CRLF line endings, UTF-8 without a byte order mark, columns `file,line,done,text,owners,priority,due,overdue,section` in that order, 1-based lines (as `smd tasks` prints them; `--json` stays zero-based) and owners joined with `;`. Fields that start with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading `'` so spreadsheets don't run them as formulas; this includes owners (`'@maya`).
- `smd tasks --gantt` prints a Mermaid `gantt` chart of tasks with a `YYYY-MM-DD` due date: one section per document, one milestone per task on its due date, done tasks (with `--all`) marked `done` and overdue ones `crit`; tasks without a due date are left out and counted on stderr. Characters Mermaid would misread in names become entity codes (`#58;`). `--title` sets the chart title, and `--smd` wraps the chart in a small `.smd` document that `smd render` draws.
- `smd tasks -o <file>` writes any of its outputs to a file. Without the new flags `smd tasks` prints exactly what it did in 1.3.0; `--json`, `--csv` and `--gantt` together are a usage error (exit code 2).
- Library: `tasksToCsv(rows)`, `tasksToGantt(rows, { title })`, `ganttDocument(chart, title)`, `ganttDate(due)` and `TASK_CSV_COLUMNS`, with the `TaskExportRow` and `GanttOptions` types.
- **`smd issues <files|dirs>`**: sync tasks with GitHub Issues through your own GitHub CLI (`gh`), so no token passes through smd. **A dry run unless `--apply`**: it reads the issues' states, prints the plan and changes nothing.
  - a task is linked by an issue reference on its line, no new syntax: `[#123](https://github.com/owner/repo/issues/123)`, the bare issue URL or `owner/repo#123` (not in code spans; the first one counts)
  - `--apply` checks off open tasks whose issue was closed as completed (not those closed as not planned); `--apply --create` opens an issue for each open task without one (in `--repo`, default the current folder's repository) and appends ` [#N](url)` to the task line; `--apply --close` closes the issue of each done task
  - new issues: the task text as title; the body names the file, line and section, owners (in code spans, so nobody is @-mentioned), priority and due date; `--label` adds labels
  - only the intended lines change (the box, or the appended link), line endings are kept, and a line edited since it was read is left alone; re-running never opens a second issue for a task
  - one `gh` call at a time, stopping at the first failure with a report of what was done; `--json` for scripts; exit code 2 when `gh` is missing or not logged in
- Library: `issueTasks`, `parseIssueRefs`, `taskIssueRef`, `planIssueSync`, `issueDraft`, `addIssueLink`, `checkTaskLine`, `issueKey` and `stripIssueRefs` (pure, no network access).
- VS Code: a **document status workflow**. A status bar item shows the front matter `status` of the active `.smd` editor with an icon per status (**No status** when there is none; a warning for a value outside draft, review, approved, deprecated and archived) and is hidden for other files:
  - click it, or run **Set Document Status…** (`smd.setStatus`, in the command palette for `.smd` files), to pick a status: the usual next step first (draft → review → approved → deprecated → archived), the current one marked, and what each means to readers
  - only the front matter changes, as one undoable edit that is not saved: the `status:` value is replaced in place, keeping quotes, comments, key order and line endings; a missing `status:` is added after `summary:` (else `title:`, else at the end of the front matter); a document without front matter gets `smd: 1` and `status:` at the top. Front matter that does not parse is left alone with a message
  - an existing `updated:` is set to today; turn that off with the new `smd.status.updateDate` setting (default `true`). No `updated:` key is added
  - `smd.setStatus` takes an optional status (and document URI) argument, for keybindings: `{ "command": "smd.setStatus", "args": "review" }`

### Changed
- `smd outline` marks a section `risk` only for `:::risk` blocks: a section that holds just a `:::risk-matrix` (or another container whose name starts with `risk-`) is no longer marked.
- The extension also activates in workspaces that contain `.smd` files (`workspaceContains:**/*.smd`), so the SMD Tasks view is ready before a document is opened.
- `:::risk-matrix` is now a known block. A document that already used that name got a `container/unknown` warning and rendered a plain box; it now renders the matrix.

## 1.3.0 — 2026-09-29

No breaking changes. Documents, CLI commands and flags, diagnostic codes and messages, library exports, extension commands and settings from 1.2.0 all keep working, and every document that passed `smd validate` still passes: there are no new rules. Everything new is additive: new commands (`smd mcp`, `smd query`, `smd index`, `smd diff`), new flags, new templates and new library exports. Without the new flags, `smd outline` and `smd agent` print exactly what they did in 1.2.0. Two things behave differently: `smd validate --fix` now fixes more (see Added) and repeats until nothing is left to fix, and `smd --help` lists the new commands.

### Added
- `smd mcp [--root <dir>]` runs a Model Context Protocol server over stdio, so agents in Claude Code, Cursor, VS Code or Claude Desktop can read `.smd` documents without a shell:
  - tools: `outline` (file), `section` (file, sections), `agent` (file, brief, includeHuman), `tasks` (paths, all, mine), `validate` (paths; JSON as `smd validate --json`) and `query` (selector, paths, brief, titles)
  - paths resolve against the root folder (default: the current folder); paths outside it, including through symbolic links, are refused, only `.smd` files are read, and code embeds only come from inside the root
  - no new dependencies; register it with `claude mcp add smd -- npx -y -p styled-markdown smd mcp` or the `mcp.json` snippets in docs/AGENTS.md
- `smd query "<selector>" <files|dirs…>` selects blocks by type and attributes and prints each in the agent view, e.g. `decision[status=accepted]`, `risk[impact>=high][status!=closed]`, `api[method=POST|PUT]`, `question`, `task[owner=@maya][due<today]` or `heading[level=2]`:
  - types: any container, `callout` (any callout), `task`, `heading` (with its whole section) and `*`; commas list alternatives
  - tests: `[key]`, `=`, `!=`, `*=`, `^=`, `$=` with `a|b` alternatives, and `<`, `<=`, `>`, `>=` over numbers, dates (`today`), priorities and risk levels; every block also has `title`, `section` and `type`
  - `--titles` prints one line per block, `--json` gives type, lines, title, attributes, section and agent-view text; `--brief` and `--no-lines` work as in `smd agent`
  - a misspelled type or attribute is an error with a suggestion (exit code 2), and the exit code is 1 when nothing matches
- Library: `querySmd(source, selector, options)`, `parseSelector` and `SelectorError`.
- `smd index <files|dirs…> [-o catalog.json] [--compact]` writes a JSON catalog of every document for agent routing:
  - per document: path (relative to the working directory, `/` separators), title, summary, status, owners, tags, audience, updated, related, and token costs of the file and of its full agent view
  - sections with level, text, id, zero-based line range and agent-view token cost (the numbers `smd outline` shows)
  - counts: open, done and overdue tasks, decisions by status, risks and open risks, questions, API endpoints, diagrams and `:::agent` blocks
  - deterministic output (no timestamps, sorted by path) so the catalog can be committed and diffed; `--today` pins the overdue count
- Library: `indexEntry(source, path, options)` and `smdIndex(documents, options)`, with the `SmdIndex*` types.
- `smd diff <old.smd> <new.smd>` and `smd diff <files|dirs…> --since <git-ref>` show only what changed, for an agent catching up on a document:
  - front-matter changes (`status: draft → accepted`), then changed, renamed and added sections in the agent view of the new version (line refs point into the new file), then removed sections (heading and old lines only)
  - sections are matched by heading id, then by content, so a renamed heading is reported as a rename; a change is shown in the smallest section that contains it, without unchanged subsections; content before the first heading counts as a section
  - only changes visible in the agent view count: styling, comments and `:::human` content are ignored, and sections marked `{agent=skip}` are listed without their content
  - `--since` compares each file with its version at a commit, branch or tag (via `git show`), and also reports files added and deleted since; stderr shows the token cost against the full agent view
  - `--json`, `--brief` and `--no-lines` work as in `smd query`; the exit code is 0, or 1 with `--exit-code` when something changed (like `git diff --exit-code`)
- Library: `diffSmd(oldSource, newSource, options)`.
- `smd outline <file> --related` adds a block listing the documents in front matter `related:`: each `.smd` file's title, status, summary and full agent-view token cost, so agents can decide whether to open it. URLs and other files are listed but not read; missing files and files outside the project folders are marked. Without the flag the outline is unchanged.
- The reader skill and `docs/AGENTS.md` tell agents to check related documents with `smd outline --related` and to open them only when the question needs it.
- Library: `relatedDocs(source, { readFile })`, `relatedEntries`, `summarizeSmd` and `formatRelated`.
- `smd agent --max-tokens N` fits the agent view into a token budget. It first condenses the view as `--brief` does, then leaves out whole sections, least important first, and puts a one-line pointer in each one's place: `[section omitted: ## Rollout plan, L153-L166, ≈118 tokens — smd agent plan.smd --section "Rollout plan"]`.
  - never left out: the header (title, front matter, summary), text before the first `##` section, sections with `:::agent` instructions, and sections requested with `--section`
  - kept longer: sections with a danger or warning callout, an accepted decision, a question or an open task; among the rest the deepest headings go first, then the largest, then the latest
  - stderr says what was condensed and left out and the final size; when even the smallest view is over the budget it is printed anyway with a warning (exit code 0)
  - without the flag the output is unchanged
- `--tokenizer o200k_base|cl100k_base|p50k_base|r50k_base` on `smd agent` and `smd outline` shows exact token counts next to the estimate (`≈1531 est · 1402 o200k_base tokens`), and `--max-tokens` then counts with it. It uses the `js-tiktoken` package if you have installed it in your project or globally; smd still has no runtime dependencies and says how to install it when it is missing. These are OpenAI encodings: there is no public tokenizer for current Claude models, so for Claude the counts are still approximate.
- Library: `agentView` options `maxTokens`, `tokenizer` (any `{ name, count(text) }`) and `file` (used in the pointers), result fields `budget` and `counted`, and `outline(source, { tokenizer })`. Types `BudgetResult`, `OmittedSection` and `Tokenizer`.
- `smd skills install --target <claude|cursor|copilot|agents>` sets up agents without Claude-style skills (repeat the flag or separate targets with commas; the default is `claude`, which works as before):
  - `cursor` writes the project rule `.cursor/rules/styled-markdown.mdc` (applies to `**/*.smd`)
  - `copilot` writes `.github/instructions/styled-markdown.instructions.md` (`applyTo: "**/*.smd"`)
  - `agents` adds a section to `AGENTS.md` between `<!-- styled-markdown:start -->` and `<!-- styled-markdown:end -->`; re-running replaces that section and keeps the rest of the file
  - each also installs the CLI once to `.smd/smd.cjs`, and the rules tell agents to run `node .smd/smd.cjs`
  - `--dir` sets the project root for these targets; `--global` and `--only` apply to `claude` only
- All three targets share one set of reading and writing rules, `skills/agent-rules.md`.
- Six new templates for `smd init --template` and the writer skill, 13 in total:
  - `postmortem`: blameless incident review with impact metrics, timeline, root cause, action items with owners and due dates, and rules for agents doing the follow-ups
  - `release-notes`: highlights, breaking changes with migration steps, deprecations, Added/Changed/Fixed, upgrade and known issues
  - `okrs`: objectives with key-result tables (owner, baseline, target, progress, confidence), initiatives and risks
  - `onboarding`: day-one setup, first-week tasks, a 90-day timeline, key links and people to meet
  - `test-plan`: scope, strategy, environments, test cases, entry and exit criteria, risks and schedule
  - `pr-description`: summary, changes, testing, risk and rollback, checklist and review focus
- More diagnostics carry a machine-applicable `fix` (quick fix in VS Code, `fix` in `--json`, applied by `smd validate --fix`). A fix is attached only when there is one clear repair:
  - `frontmatter/status`, `frontmatter/audience`, `frontmatter/value`: the one close allowed value (`aproved` → `approved`, `Dark` → `dark`)
  - `frontmatter/accent`: a misspelled named color (`bleu` → `blue`)
  - `frontmatter/type`: `yes`/`no`/`on`/`off` or a quoted `"true"`/`"false"` on a true/false key → `true`/`false`
  - `frontmatter/date`: year-first dates with other separators or no zero padding (`2026/9/5` → `2026-09-05`)
  - `container/unclosed`, `fence/unclosed`: add the closing line at the end of the document, where the block already ends (unindented blocks only)
  - `attrs/unknown`: the one close accepted attribute name, when it is not already set (`{colr=red}` → `{color=red}`)
  - `attrs/value`: the one close allowed value for block and directive enums, named colors, `size`, `weight`, `font`, `align`, `:priority[…]` and heading `agent=skip`; year-first `date="…"` and `:due[…]` dates
- `applyFixes` applies adjacent edits and orders several insertions at the same point innermost block first, whatever order the diagnostics come in.

### Changed
- `smd validate --fix` applies fixes and checks again until nothing is left to fix, e.g. a code block is closed before the container around it. The `fixed` count covers all rounds.

## 1.2.0 — 2026-09-28

No breaking changes. Documents, CLI commands and flags, diagnostic codes, library exports, extension commands and settings from 1.1.0 all keep working, and every document that passed `smd validate` still passes. New checks are warnings or info: `link/undefined-reference`, `frontmatter/value` and `mermaid/syntax` are warnings, `frontmatter/type` now also covers a `title`, `summary` or `version` given as a list or mapping, and `frontmatter/stale` is info. So `smd validate --strict` can report warnings on documents that passed before; turn any rule off in `smd.config.json`.

### Added
- Go to definition (`F12`, `Ctrl+Click`) on links: `#anchor` jumps to the heading, `{#id}` block or HTML element; `other.smd#anchor` opens the other document at that heading; relative files open; `[text][label]` jumps to its `[label]: …` definition.
- Link validation checks anchors in other documents: `[x](plan.smd#rollout)` warns with `link/missing-anchor` when `plan.smd` has no such heading.
- `link/missing-anchor` offers a quick fix to the closest heading id, and also accepts `{#id}` block attributes and HTML `id`/`name` as targets.
- Reference-style links: `[text][label]` without a `[label]: …` definition reports the new `link/undefined-reference` rule, and definition targets are checked like inline links.
- HTML `href`/`src` targets and front matter `related:` entries are checked for missing files and anchors.
- `smd fmt <files|dirs…>` formats `.smd` files in place, with `--check` for CI (exit code 1 when a file isn't formatted) and `--stdout` for one file. It only changes layout, never meaning:
  - container fences: `:::name` with no space, one colon count per nesting level (the innermost uses `:::`, each enclosing level one more, e.g. `::::tabs` around `:::tab`), closing fences matching their opener; unbalanced documents keep their colons
  - attribute lists on containers, headings, `[text]{…}` spans and inline directives: `#id`, `.classes`, then keys in the spec's order; values quoted only when needed (`title` and `label` always); duplicate keys collapsed to the value that wins
  - pipe tables: aligned columns and delimiter rows (wide characters and emoji count as two columns)
  - blank lines around containers, code, math, headings and tables where they touch paragraph text, runs of blank lines collapsed, one final newline
  - code, math, raw HTML, front matter and indented blocks are left untouched
- **Format Document** and format on save in VS Code, using the same rules as `smd fmt`.
- `formatSmd()` in the `styled-markdown` library.
- Path and anchor completion in VS Code:
  - inside links and images `](…`, reference definitions `[label]: …`, front matter `related:` entries and code fence `file="…"` embeds, relative files and folders are suggested (`.smd`/`.md` first; `related:` offers documents only)
  - after `#`, the headings, `{#id}` blocks and HTML ids of the current document or of the linked `other.smd#…` are suggested, using its unsaved text when it is open
  - an empty link target also offers this document's `#anchors`
  - nothing is suggested inside code
- Find references (`Shift+F12`) for heading anchors across the workspace, from a heading or from a link's `#anchor`. The results cover inline links, reference definitions and HTML `href`s in `.smd` and `.md` files.
- Rename a heading (`F2`) and update every link to its anchor across the workspace. When a rename renumbers the anchors of later headings with the same text (`#setup-1` → `#setup`), links to those are updated too. Headings with an explicit `{#id}` keep their anchor, and percent-encoded anchors stay encoded.
- Configurable rules. A `smd.config.json`, `.smdrc` or `.smdrc.json` file in a document's folder or a parent folder turns rules `off` or sets their severity (`error`, `warning`, `info`, `hint`) by code, by category (`link/*`) or for every rule (`*`). The nearest file applies, the search stops at the repository root, and the most specific key wins. It is used by:
  - VS Code, which reloads the file as it changes, reports its problems on the file itself, and completes and checks rule codes from a JSON schema
  - `smd validate` and `smd meta`, which also accept `--config <file>`
  - the library, through `validateSmd(text, { rules })`, alongside the `RULE_CODES`, `readRuleConfig` and `applyRuleSettings` exports
- Inline suppression comments: `<!-- smd-disable-next-line [codes] -->`, `<!-- smd-disable-line [codes] -->` and `<!-- smd-disable [codes] -->` … `<!-- smd-enable [codes] -->`. No codes means every rule. Unknown codes are reported as the new `rules/unknown` warning, with a fix.
- Refactorings in VS Code (`Ctrl+.`):
  - wrap the selected lines in `:::note`, `:::tip`, `:::warning`, `:::danger`, `:::card`, `:::details`, `:::agent` or `:::human`; the new fence gets one more colon than any container inside it, and selections that split a code block or container aren't offered
  - convert a callout to another type, from its opening line
  - convert a blockquote callout into a `:::callout`, from GitHub alerts (`> [!WARNING]`, mapped like `smd from-md`) or bold labels (`> **Warning:**`, `> **Tip**:`); nested quotes keep their extra `>`
- Mermaid syntax errors as warnings (`mermaid/syntax`), on the line and columns the parser points at, e.g. "expected TXT, got end of line". Diagrams are parsed with Mermaid's own parser, which ships as a separate `dist/mermaid-parse.js` and is loaded only when a document has diagrams.
  - VS Code: errors appear as you type, and `smd.validation.mermaid` turns the check off.
  - `smd validate`: `--no-mermaid` skips the check. The single-file CLI bundled in the agent skills doesn't include the parser and skips it.
  - Library: `checkMermaid(text, parse, rules?)` and `mermaidBlocks(text)`; pass `mermaid.parse` or any compatible parser.
  - Like other rules, `mermaid/syntax` can be turned off or given another severity in `smd.config.json` / `.smdrc`, and silenced with `<!-- smd-disable-next-line mermaid/syntax -->`.
- Front matter JSON Schema: one schema (`FRONTMATTER_SCHEMA`) drives front matter validation and editor completion.
  - It is published as `extension/schemas/smd-frontmatter.schema.json` and as `styled-markdown/frontmatter.schema.json` on npm, for YAML tooling and pipelines.
  - Completion now offers every enumerated value, including `theme`, `toc` and `smd`. It skips keys already in the front matter, and suggests today's date for `updated` and `created`.
  - New `frontmatter/value` warning for values the schema doesn't allow on keys without their own rule, such as `theme: neon`.
  - `title`, `summary` and `version` given as a list or mapping are reported as `frontmatter/type`.
- Stale document check `frontmatter/stale` (info): `updated` is more than 180 days old and the status isn't `archived` or `deprecated`. Configure it with `smd.validation.staleAfterDays`, `smd validate --stale-after <days>` or `validateSmd(text, { staleAfterDays })`; `0` turns it off. Like other rules, it can also be turned off or given another severity in `smd.config.json` / `.smdrc`.
- Workspace symbol search (`Ctrl+T`) across every `.smd` file: headings, `:::decision` and `:::risk` titles, and `:::api` endpoints, which are searchable by method and path. Each file's symbols are cached until it changes.
- Hover previews:
  - over a link's text or target, `#anchor` / `other.smd#anchor` shows the start of that section (up to 20 lines), and `other.smd` shows the document's title, status, summary and top-level sections
  - over a ```` ```lang file="…" lines="…" ```` line, the embedded code (up to 30 lines), or why it can't be read
- List continuation on Enter (`smd.editor.continueLists`):
  - tasks continue unchecked and keep their `@owner` mentions, with the cursor before them
  - bullets repeat and numbered items count up
  - Enter on an empty item ends the list
  - nothing changes inside code blocks
- Paste and drag-and-drop images:
  - images are saved to `docs/images/` (`smd.images.folder`) and linked relative to the document
  - images already in the workspace are linked in place
  - name clashes get `-1`, `-2`…
  - pasting needs VS Code 1.97 or later; dropping works on every supported version
- **Styled Markdown: Set Up Spell Checking (cSpell)** adds an `smd` entry to cSpell's `languageSettings`, so container and directive names, attribute lists, mentions, link targets, front matter and code aren't reported as misspellings. It runs only when you ask, because cSpell settings can't be scoped to a language by another extension.
- `parseSmd(text)` in the library: headings and anchor ids without rendering HTML, parsed incrementally.

### Changed
- Large documents stay responsive. On a 12,000-line document, after typical edits:
  - validation: about 110 ms → 30 ms
  - `smd outline`: 11 s → 80 ms (it transformed the document once per section; now once)
  - `smd meta`: 180 ms → 40 ms
  - the agent view and its token counter: 90 ms → 26 ms
  - Outline view and go to definition: no render at all
  Headings and anchors now come from an incremental parse that reuses every top-level block the edit didn't touch, instead of a full HTML render, and results are identical. Math checks are cached per formula, and the status-bar token counter waits longer before updating on long documents.
- The npm package ships Mermaid's parser for `smd validate` (`dist/mermaid-parse.js`, 3.4 MB unpacked). The library entry points don't load it.
- The preview keeps your place when it updates: the source line at the top of the preview stays there, even when lines are added or removed above it.
- The selected tab in `:::tabs` and opened or closed collapsibles (`:::details`, `collapsible` callouts, agent blocks) stay as you left them across updates. They're matched by their titles, not their position.
- The preview restores its scroll position, tabs and collapsibles after its tab was hidden and shown again.
- Unchanged Mermaid diagrams are restored from the cache right away on each update, instead of waiting behind a diagram that changed and briefly showing their source. A diagram you're editing keeps its previous height until the new version renders, so the page below it doesn't jump.

### Fixed
- The preview's Content-Security-Policy nonce is now generated with a cryptographically secure random source instead of `Math.random()`.
- A lone carriage return (`\r` without `\n`) was treated as a line break, so heading lines in the preview, scroll sync, outlines and `smd meta` drifted from the editor.
- A front matter key containing regex characters, such as `"a(b": 1`, made validation throw.
- The `frontmatter/unknown-key` quick fix no longer rewrites the opening `---` when the key is written differently in YAML (e.g. quoted); it is then offered as a hint only.
- A preview hidden behind another tab showed the document as it was when the preview was opened until the next edit.
- Link targets with spaces in angle brackets (`[x](<my file.md>)`), `'single'`/`(paren)` titles or balanced parentheses were not checked.
- A link with malformed percent-encoding (`[x](#100%)`) made validation throw.
- Links inside `~~~` code fences that contain ```` ``` ```` lines were checked as if they were prose.

### Internal
- CI runs a seeded fuzz test of the core (render, validate, quick fixes, agent view, outline, document info, tasks, Markdown conversion) and a benchmark suite (`npm run bench`) that fails on order-of-magnitude slowdowns.
- CI checks that `examples/` and `docs/gallery/` are formatted (`smd fmt --check`).
- The release check compares a corpus of documents (`extension/test/compat/corpus/`) across releases; it starts with the rule and suppression-comment additions.

## 1.1.0 — 2026-09-27

No breaking changes. Documents, CLI commands and flags, diagnostic codes, extension commands and settings are unchanged from 1.0.0.

### Added
- **npm package [`styled-markdown`](https://www.npmjs.com/package/styled-markdown)**: the full engine as a library (CommonJS, ESM and TypeScript types, zero runtime dependencies, browser-safe) plus the `smd` CLI (`npm install -g styled-markdown` or `npx styled-markdown`).
- Library API: `renderSmd`, `renderPage`, `validateSmd`, `applyFixes`, `agentView`, `outline`, `smdToMarkdown`, `markdownToSmd`, `getDocumentInfo`, `extractTasks`, `parseFrontMatter`, `estimateTokens`, `fillTemplate`, `SMD_CSS`, `SMD_RUNTIME_JS` and the format vocabulary.
- The stylesheet as a package export: `styled-markdown/smd.css`.
- Install docs for the VS Code Marketplace and npm; `npx styled-markdown skills install` for the agent skills.

### Changed
- `smd render` embeds the stylesheet and page runtime at build time, so it works from any copy of the CLI (npm, the skills' bundled `scripts/smd.cjs`), not only from the extension folder.
- The CLI's version is injected at build time; `smd --version` output is unchanged.

### Fixed
- `smd render` failed with "media/ was not found next to this CLI" when run from the agent skills' bundled CLI.
- `npm test` failed on Windows with Node.js < 21 (the `test/*.test.ts` glob was not expanded).

### Internal
- CI on every pull request and push to `main`: build and unit tests on Ubuntu and Windows, VS Code integration tests, and a backward-compatibility check against the last release.
- `createMarkdownIt` is no longer exported from the engine's internal core module. It was never part of a published API.

## 1.0.0 — 2026-09-26

First public release, implementing Styled Markdown spec v1.

### Format
- Superset of CommonMark + GFM with YAML front matter (status header, owners, tags, TOC, accent, theme).
- Callouts (`note` `info` `tip` `success` `warning` `danger` `question`, optionally collapsible) and `details`.
- Theme-aware named colors and whitelisted style attributes: `[text]{color bg border size weight font style}`, `==highlight==`.
- Inline directives: `:badge` `:status` `:priority` `:due` `:metric` `:progress` `:kbd` `:mention`, plus KaTeX math.
- Layout: `tabs`, `columns`, `card`, `box`, `steps`, `timeline`, with arbitrary nesting (a bare `:::` closes the innermost block).
- Project management: `decision`, `risk`, and tasks with owner, priority and due date (overdue detection).
- Developers: `api` endpoint blocks, code titles, line highlights, sandboxed live source embeds.
- Audience: `:::agent`, `:::human`, and `## Heading {agent=skip}`.
- All Mermaid diagram types, themed to the document palette.

### VS Code extension
- Live preview with scroll sync, double-click to source, task toggling, light/dark themes and a strict CSP.
- Validation with stable rule codes and quick fixes; completion, hover, color picker, outline, folding, 34 snippets.
- Agent view, brief agent view, copy agent view or selected sections, status-bar token counter.
- Export to HTML and GitHub Markdown; convert `.md` to `.smd`; validate the whole workspace.

### CLI (`smd`)
- `outline`, `agent`, `tasks`, `meta`, `validate` (`--json`, `--fix`, `--strict`), `render`, `to-md`, `from-md`, `init --template`, `templates`, `skills install`.

### Agent skills
- `styled-markdown-writer`: create and edit `.smd` following the rules, with 7 templates (PRD, ADR, RFC, runbook, API, status report, meeting notes), a full syntax reference and a style guide.
- `styled-markdown-reader`: token-efficient reading (outline → sections → raw lines only to edit).
