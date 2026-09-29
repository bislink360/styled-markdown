# Branching, commits and pull requests

## Branches

The full workflow is the **version-control** skill's release train. In short:

- `main` contains only released code. It changes only by merging a `release/vX.Y.Z` tracking PR after that version is tagged and published.
- `release/vX.Y.Z` is created from `main` (or from a tag, for hotfixes) and opened at its version by `plan-release.mjs`.
- Use one branch per major feature or fix, created from the release branch: `feat/…`, `fix/…`, `docs/…`, `chore/…`, `perf/…`, `refactor/…`. Its PR targets the release branch.
- Keep branches short-lived. When the release branch moves, merge it into the feature branch; don't rebase shared branches.

Suggested settings on GitHub (repository → Settings → Branches), which only the repository owner can change:

- protect `main` and `release/**`: require a pull request and the CI checks to pass
- allow squash merges (feature PRs) and merge commits (release → `main`)
- turn on automatically deleting head branches

## Commits

Use the Conventional Commits format:

```text
feat(tables): add table captions and column alignment attributes
fix(cli): exit 2 on unknown flags
docs(skills): explain npx install
chore(deps): bump esbuild
feat(validate)!: report unclosed blocks as errors

BREAKING CHANGE: documents with unclosed blocks now fail `smd validate`.
```

- Write the subject in the imperative, under 72 characters.
- Use scopes that match the areas: `format`, `render`, `validate`, `agent-view`, `cli`, `npm`, `vscode`, `skills`, `docs`, `examples`.
- Don't add AI co-author trailers or "Generated with …" lines.

## Pull request checklist

Copy this into the PR description:

```markdown
## What
<one paragraph>

## Compatibility
- [ ] `release-check.mjs --pr` run; next release must be at least: <patch|minor|major>
- [ ] Breaking changes: <none | list with migration notes>
- [ ] Behaviour changes flagged by the checker reviewed: <list or none>

## Checklist
- [ ] Tests added/updated (`npm test`), VS Code checks pass (`npm run test:vscode`) for editor changes
- [ ] SonarQube gate passes locally (`node .claude/skills/sonarqube-scan/scripts/sonar-scan.mjs`); suppressions/baseline changes: <none | list with reasons>
- [ ] New syntax has a corpus document in `extension/test/compat/corpus/`
- [ ] Docs updated: SPEC.md, FEATURES.md, writer skill `references/syntax.md`, README feature list
- [ ] Plain-Markdown fallback (`toMarkdown.ts`) and agent view (`agentView.ts`) handle the new construct
- [ ] Examples still validate: `node extension/dist/cli.js validate examples`
```

## Merging and tagging

- Squash-merge feature PRs into the release branch. The squash commit message is the PR's Conventional Commit title.
- Release: tag the **release branch head** `vX.Y.Z`, push the tag, and build and publish artifacts from that tag only.
- Then merge the tracking PR `release/vX.Y.Z → main` with a **merge commit**, so the tagged commit is in `main`'s history. Delete the release branch afterwards.
- Never move or delete a published tag. If a release is wrong, publish a new patch version from a hotfix train (`--base vX.Y.Z`).
