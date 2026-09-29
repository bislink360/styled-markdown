# Contributing

Thanks for helping improve Styled Markdown.

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

## Branching: release trains

Work reaches `main` through release branches. For a release, `release/vX.Y.Z` is created from `main`, each major feature or fix gets its own branch from it, feature PRs target the release branch, and after the release is tagged and published the release branch is merged into `main`. See the `version-control` skill (`.claude/skills/version-control/SKILL.md`); `plan-release.mjs` sets up the branches.

## Continuous integration

Every pull request to `main` or a `release/**` branch, and every push to them, runs [.github/workflows/ci.yml](.github/workflows/ci.yml):

| Job | Checks |
|---|---|
| Build & unit tests (Ubuntu, Windows) | typecheck, build of extension/CLI/npm package, unit tests, examples validate and are formatted (`smd fmt --check`), bundled skill CLIs are up to date, `npm pack` |
| VS Code integration tests | the extension in a real VS Code (preview, diagnostics, quick fixes, completion, agent view), plus a `.vsix` build uploaded as an artifact |
| Backward compatibility | `release-check.mjs` against the last `vX.Y.Z` tag; the report appears in the job summary. It fails on blocking issues, e.g. breaking changes without a major version on `release/*` branches. |

## Before opening a pull request

- `npm run typecheck` and `npm test` pass. `npm run test:vscode` passes for editor-facing changes.
- `node dist/cli.js validate ../examples ../docs/gallery` reports 0 errors, and `node dist/cli.js fmt --check ../examples ../docs/gallery` reports 0 files to format (run it without `--check` to fix them).
- New syntax is documented in `docs/SPEC.md`, `docs/FEATURES.md` and the writer skill's `references/syntax.md`.
- The CHANGELOG has an entry.
