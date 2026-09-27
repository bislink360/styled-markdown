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

## Before opening a pull request

- `npm run typecheck` and `npm test` pass. `npm run test:vscode` passes for editor-facing changes.
- `node dist/cli.js validate ../examples` reports 0 errors.
- New syntax is documented in `docs/SPEC.md`, `docs/FEATURES.md` and the writer skill's `references/syntax.md`.
- The CHANGELOG has an entry.
