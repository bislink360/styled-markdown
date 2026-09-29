# Changelog

## 1.2.0 — 2026-09-28

### ⚠️ Breaking changes

### Added
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

### Changed

### Deprecated

### Fixed
- The preview's Content-Security-Policy nonce is now generated with a cryptographically secure random source instead of `Math.random()`.

## Unreleased

### Added
- Go to definition (`F12`, `Ctrl+Click`) on links: `#anchor` jumps to the heading, `{#id}` block or HTML element; `other.smd#anchor` opens the other document at that heading; relative files open; `[text][label]` jumps to its `[label]: …` definition.
- Link validation checks anchors in other documents: `[x](plan.smd#rollout)` warns with `link/missing-anchor` when `plan.smd` has no such heading.
- `link/missing-anchor` offers a quick fix to the closest heading id, and also accepts `{#id}` block attributes and HTML `id`/`name` as targets.
- Reference-style links: `[text][label]` without a `[label]: …` definition reports the new `link/undefined-reference` rule, and definition targets are checked like inline links.
- HTML `href`/`src` targets and front matter `related:` entries are checked for missing files and anchors.

### Fixed
- Link targets with spaces in angle brackets (`[x](<my file.md>)`), `'single'`/`(paren)` titles or balanced parentheses were not checked.
- A link with malformed percent-encoding (`[x](#100%)`) made validation throw.
- Links inside `~~~` code fences that contain ```` ``` ```` lines were checked as if they were prose.

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
