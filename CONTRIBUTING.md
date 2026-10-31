# Contributing

Thanks for helping improve Styled Markdown.

- **Questions and ideas:** [Discussions](https://github.com/bislink360/styled-markdown/discussions).
- **Bugs and feature requests:** [open an issue](https://github.com/bislink360/styled-markdown/issues/new/choose); the forms ask for what we need.
- **Security problems:** report them privately, as [SECURITY.md](SECURITY.md) explains.
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Good first issues

Issues labelled [`good first issue`](https://github.com/bislink360/styled-markdown/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are small and self-contained, with the files to change named in the issue. [`help wanted`](https://github.com/bislink360/styled-markdown/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) issues are bigger but well defined. Comment on the issue before you start, so two people don't do the same work.

No labelled issue that suits you? These are good places to start, and need no knowledge of the parser:

- **A template:** add a document template to `skills/styled-markdown-writer/assets/templates/` and register it in `TEMPLATES` in `extension/src/skillsBundle.ts`. Copy an existing one; after `smd init x.smd --template <name>`, `smd validate x.smd` must report no errors or warnings.
- **A quick fix or a clearer message** for a validation rule in `extension/src/core/validate.ts`, with a test.
- **A language** for the labels smd adds around a document's text (`Note`, `Figure 2`, `overdue`…): copy a locale in `extension/src/core/locales.ts` and translate it.
- **Docs:** a missing example, a confusing sentence or a broken link in `docs/`.
- **An example document** in `examples/` that shows a real use (it must pass `smd validate` and `smd fmt --check`).

Pull requests may target the open `release/v*` branch or `main`; the maintainer retargets them. The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) has the checklist.

## Setup

```bash
git clone https://github.com/bislink360/styled-markdown.git
cd styled-markdown/extension
npm install
npm run build
npm test
```

Press **F5** in `extension/` to run the extension in a development host.

## Where things live

| Change | Files |
|---|---|
| New block or directive | `src/core/spec.ts` (vocabulary; drives validation, completion and hover) → `src/core/render.ts` (HTML) → `media/smd.css` (style) → `src/core/agentView.ts` (agent view) → `src/core/toMarkdown.ts` (GitHub fallback) → `syntaxes/smd-directives.injection.json` (for new inline directives) → `docs/SPEC.md`, `docs/FEATURES.md`, `skills/styled-markdown-writer/references/syntax.md` |
| Validation rule | `src/core/validate.ts`, with a stable `code` and, when safe, a `fix` |
| Agent skills | `skills/*/SKILL.md`, references and templates. `npm run build` refreshes the bundled `scripts/smd.cjs`. |
| Preview behaviour | `media/runtime.js`, `src/preview.ts` |

### Repository layout

```text
styled-markdown/
├── extension/            VS Code extension + smd CLI (TypeScript)
│   ├── src/core/         the engine: renderer, validator, agent view, converters (no VS Code dependency)
│   ├── src/              extension: preview, language features, agent view UI, CLI
│   ├── media/            preview CSS/runtime, icons
│   └── test/             unit tests + VS Code integration tests
├── skills/
│   ├── styled-markdown-reader/   agent skill: token-efficient reading
│   └── styled-markdown-writer/   agent skill: authoring, with templates and references
├── npm/                  the `styled-markdown` npm package (library + CLI)
├── integrations/mkdocs/  the MkDocs plugin (Python package `mkdocs-styled-markdown`)
├── integrations/obsidian/ the Obsidian plugin (id `styled-markdown`)
├── integrations/jetbrains/ the JetBrains plugin (Kotlin, Gradle): TextMate highlighting and the language server
├── integrations/tree-sitter-smd/  Tree-sitter grammar and queries for Neovim, Helix and Zed
├── playground/           the web playground: a static page that runs the engine in the browser
├── site/                 the homepage on GitHub Pages (index.smd, built with smd build)
├── validate/             the GitHub Action (smd validate with pull request annotations)
├── examples/             example documents (+ rendered HTML)
├── docs/                 guides, specification, gallery and screenshots
├── .claude-plugin/       the Claude Code plugin marketplace (marketplace.json, plugin.json)
├── server.json           the MCP Registry entry for the npm package's MCP server
├── .pre-commit-hooks.yaml    hooks for the pre-commit framework
└── package.json          lets pre-commit install the bundled CLI (not published)
```

`npm run build:npm` writes the npm package to `npm/dist`, `npm run build:playground` the playground to `extension/dist/playground`, and `npm run package` the `.vsix`. `npm run test:vscode` runs the integration checks inside a real VS Code.

## Branching: release trains

Work reaches `main` through release branches. For a release, `release/vX.Y.Z` is created from `main`, each major feature or fix gets its own branch from it, feature PRs target the release branch, and after the release is tagged and published the release branch is merged into `main`. See the `version-control` skill (`.claude/skills/version-control/SKILL.md`); `plan-release.mjs` sets up the branches.

## Continuous integration

Every pull request to `main` or a `release/**` branch, and every push to them, runs [.github/workflows/ci.yml](.github/workflows/ci.yml):

| Job | Checks |
|---|---|
| Build & unit tests (Ubuntu, Windows) | typecheck, build of extension/CLI/npm package, unit tests, examples validate and are formatted (`smd fmt --check`), bundled skill CLIs are up to date, `npm pack` |
| Benchmarks & extended fuzz | `npm run bench -- --check` (fails when a core function gets ~10x slower on 1k/10k-line documents; the table is in the job summary) and 3000 fuzz cases |
| VS Code integration tests | the extension in a real VS Code (preview, diagnostics, quick fixes, completion, agent view), plus a `.vsix` build uploaded as an artifact |
| Backward compatibility | `release-check.mjs` against the last `vX.Y.Z` tag; the report appears in the job summary. It fails on blocking issues, e.g. breaking changes without a major version on `release/*` branches. |

## Before opening a pull request

- `npm run typecheck` and `npm test` pass. `npm run test:vscode` passes for editor-facing changes.
- `npm test` includes a seeded fuzz test (`test/fuzz.test.ts`). To reproduce or widen it: `SMD_FUZZ_SEED=<seed> SMD_FUZZ_RUNS=5000 npm test`; a failure writes a shrunk input to `test/fuzz-failures/`. A bug it finds gets its own regression test.
- For changes to parsing or rendering, `npm run bench` shows timings on large documents.
- `node dist/cli.js validate ../examples ../docs/gallery` reports 0 errors, and `node dist/cli.js fmt --check ../examples ../docs/gallery` reports 0 files to format (run it without `--check` to fix them).
- The static analysis gate passes: `node .claude/skills/sonarqube-scan/scripts/sonar-scan.mjs` from the repository root (needs Docker). It runs SonarQube locally, since CI has no static analysis. It is mandatory before every release; see the `sonarqube-scan` skill.
- New syntax is documented in `docs/SPEC.md`, `docs/FEATURES.md` and the writer skill's `references/syntax.md`.
- The CHANGELOG has an entry.
