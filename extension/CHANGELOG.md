# Changelog

## 1.3.0 — 2026-09-29

### ⚠️ Breaking changes

### Added
- `smd query "<selector>" <files|dirs…>` selects blocks by type and attributes and prints each in the agent view, e.g. `decision[status=accepted]`, `risk[impact>=high][status!=closed]`, `api[method=POST|PUT]`, `question`, `task[owner=@maya][due<today]` or `heading[level=2]`:
  - types: any container, `callout` (any callout), `task`, `heading` (with its whole section) and `*`; commas list alternatives
  - tests: `[key]`, `=`, `!=`, `*=`, `^=`, `$=` with `a|b` alternatives, and `<`, `<=`, `>`, `>=` over numbers, dates (`today`), priorities and risk levels; every block also has `title`, `section` and `type`
  - `--titles` prints one line per block, `--json` gives type, lines, title, attributes, section and agent-view text; `--brief` and `--no-lines` work as in `smd agent`
  - a misspelled type or attribute is an error with a suggestion (exit code 2), and the exit code is 1 when nothing matches
- Library: `querySmd(source, selector, options)`, `parseSelector` and `SelectorError`.
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
- Six new templates for `smd init --template` and the writer skill, 13 in total:
  - `postmortem`: blameless incident review with impact metrics, timeline, root cause, action items with owners and due dates, and rules for agents doing the follow-ups
  - `release-notes`: highlights, breaking changes with migration steps, deprecations, Added/Changed/Fixed, upgrade and known issues
  - `okrs`: objectives with key-result tables (owner, baseline, target, progress, confidence), initiatives and risks
  - `onboarding`: day-one setup, first-week tasks, a 90-day timeline, key links and people to meet
  - `test-plan`: scope, strategy, environments, test cases, entry and exit criteria, risks and schedule
  - `pr-description`: summary, changes, testing, risk and rollback, checklist and review focus
- `smd index <files|dirs…> [-o catalog.json] [--compact]` writes a JSON catalog of every document for agent routing:
  - per document: path (relative to the working directory, `/` separators), title, summary, status, owners, tags, audience, updated, related, and token costs of the file and of its full agent view
  - sections with level, text, id, zero-based line range and agent-view token cost (the numbers `smd outline` shows)
  - counts: open, done and overdue tasks, decisions by status, risks and open risks, questions, API endpoints, diagrams and `:::agent` blocks
  - deterministic output (no timestamps, sorted by path) so the catalog can be committed and diffed; `--today` pins the overdue count
- Library: `indexEntry(source, path, options)` and `smdIndex(documents, options)`, with the `SmdIndex*` types.
- `smd mcp [--root <dir>]` runs a Model Context Protocol server over stdio, so agents in Claude Code, Cursor, VS Code or Claude Desktop can read `.smd` documents without a shell:
  - tools: `outline` (file), `section` (file, sections), `agent` (file, brief, includeHuman), `tasks` (paths, all, mine), `validate` (paths; JSON as `smd validate --json`) and `query` (selector, paths, brief, titles)
  - paths resolve against the root folder (default: the current folder); paths outside it, including through symbolic links, are refused, only `.smd` files are read, and code embeds only come from inside the root
  - no new dependencies; register it with `claude mcp add smd -- npx -y -p styled-markdown smd mcp` or the `mcp.json` snippets in docs/AGENTS.md
- `smd skills install --target <claude|cursor|copilot|agents>` sets up agents without Claude-style skills (repeat the flag or separate targets with commas; the default is `claude`, which works as before):
  - `cursor` writes the project rule `.cursor/rules/styled-markdown.mdc` (applies to `**/*.smd`)
  - `copilot` writes `.github/instructions/styled-markdown.instructions.md` (`applyTo: "**/*.smd"`)
  - `agents` adds a section to `AGENTS.md` between `<!-- styled-markdown:start -->` and `<!-- styled-markdown:end -->`; re-running replaces that section and keeps the rest of the file
  - each also installs the CLI once to `.smd/smd.cjs`, and the rules tell agents to run `node .smd/smd.cjs`
  - `--dir` sets the project root for these targets; `--global` and `--only` apply to `claude` only
- All three targets share one set of reading and writing rules, `skills/agent-rules.md`.
- `smd diff <old.smd> <new.smd>` and `smd diff <files|dirs…> --since <git-ref>` show only what changed, for an agent catching up on a document:
  - front-matter changes (`status: draft → accepted`), then changed, renamed and added sections in the agent view of the new version (line refs point into the new file), then removed sections (heading and old lines only)
  - sections are matched by heading id, then by content, so a renamed heading is reported as a rename; a change is shown in the smallest section that contains it, without unchanged subsections; content before the first heading counts as a section
  - only changes visible in the agent view count: styling, comments and `:::human` content are ignored, and sections marked `{agent=skip}` are listed without their content
  - `--since` compares each file with its version at a commit, branch or tag (via `git show`), and also reports files added and deleted since; stderr shows the token cost against the full agent view
  - `--json`, `--brief` and `--no-lines` work as in `smd query`; the exit code is 0, or 1 with `--exit-code` when something changed (like `git diff --exit-code`)
- Library: `diffSmd(oldSource, newSource, options)`.
- More diagnostics carry a machine-applicable `fix` (quick fix in VS Code, `fix` in `--json`, applied by `smd validate --fix`). A fix is attached only when there is one clear repair:
  - `frontmatter/status`, `frontmatter/audience`, `frontmatter/value`: the one close allowed value (`aproved` → `approved`, `Dark` → `dark`)
  - `frontmatter/accent`: a misspelled named color (`bleu` → `blue`)
  - `frontmatter/type`: `yes`/`no`/`on`/`off` or a quoted `"true"`/`"false"` on a true/false key → `true`/`false`
  - `frontmatter/date`: year-first dates with other separators or no zero padding (`2026/9/5` → `2026-09-05`)
  - `container/unclosed`, `fence/unclosed`: add the closing line at the end of the document, where the block already ends (unindented blocks only)
  - `attrs/unknown`: the one close accepted attribute name, when it is not already set (`{colr=red}` → `{color=red}`)
  - `attrs/value`: the one close allowed value for block and directive enums, named colors, `size`, `weight`, `font`, `align`, `:priority[…]` and heading `agent=skip`; year-first `date="…"` and `:due[…]` dates
- `smd validate --fix` applies fixes and checks again until nothing is left to fix, e.g. a code block is closed before the container around it. The `fixed` count covers all rounds.
- `applyFixes` applies adjacent edits and orders several insertions at the same point innermost block first, whatever order the diagnostics come in.

### Changed

### Deprecated

### Fixed

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
