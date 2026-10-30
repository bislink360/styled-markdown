<!--
Thanks for contributing! Target branch: the open `release/v*` branch if there is one, otherwise `main`.
Either is fine: the maintainer retargets the pull request to the right release branch.
Title: a Conventional Commit, e.g. "feat(cli): add --since to smd tasks" or "fix(render): keep table alignment".
Leave a checkbox empty if it doesn't apply, or if you're not sure: that's fine, we'll sort it out in review.
-->

## What

<!-- One paragraph: what changes and why. Link the issue: "Closes #123". -->

## Compatibility

<!-- Styled Markdown keeps existing documents, CLI flags, MCP tools and settings working (docs/COMPATIBILITY.md). -->

- [ ] Existing documents keep their meaning, and no command, flag, setting, template or MCP tool was removed or renamed
- [ ] Breaking changes: <!-- none, or a list with migration notes -->
- [ ] (Maintainers) `node .claude/skills/smd-release/scripts/release-check.mjs --pr` run; next release must be at least: <!-- patch | minor | major -->

## Checklist

- [ ] Tests added or updated, and `npm run typecheck` and `npm test` pass in `extension/`
- [ ] For editor changes: `npm run test:vscode` passes
- [ ] Examples still validate and are formatted: `node extension/dist/cli.js validate examples docs/gallery` and `node extension/dist/cli.js fmt --check examples docs/gallery`
- [ ] New syntax: documented in `docs/SPEC.md`, `docs/FEATURES.md` and the writer skill's `references/syntax.md`, with a corpus document in `extension/test/compat/corpus/`
- [ ] New syntax: the plain-Markdown export (`toMarkdown.ts`) and the agent view (`agentView.ts`) handle it
- [ ] Changed `extension/src`: the bundles `npm run build` refreshes (`skills/*/scripts/smd.cjs`, the MkDocs plugin's `bridge.cjs`) are committed too; CI checks that they are up to date
- [ ] (Maintainers) SonarQube gate passes locally (`node .claude/skills/sonarqube-scan/scripts/sonar-scan.mjs`); suppressions or baseline changes: <!-- none, or a list with reasons -->
