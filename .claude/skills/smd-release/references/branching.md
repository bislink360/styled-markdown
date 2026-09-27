# Branching, commits and pull requests

## Branches

- `main` is always releasable. Never commit to it directly; change it only by merging pull requests.
- Use one branch per capability or fix, created from the latest `main`: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
- `release/vX.Y.Z` holds only the version bump, changelog and final docs for a release.
- Keep branches short-lived. Rebase or merge `main` in before opening the PR if `main` moved.

Suggested settings on GitHub (repository → Settings → Branches → `main`), which only the repository owner can change:

- require a pull request before merging
- require the release-check or test workflow to pass
- allow squash merging only, and delete branches after merge

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
- [ ] `release-check.mjs` run; required bump: <patch|minor|major>
- [ ] Breaking changes: <none | list with migration notes>
- [ ] Behaviour changes flagged by the checker reviewed: <list or none>

## Checklist
- [ ] Tests added/updated (`npm test`), VS Code checks pass (`npm run test:vscode`) for editor changes
- [ ] New syntax has a corpus document in `extension/test/compat/corpus/`
- [ ] Docs updated: SPEC.md, FEATURES.md, writer skill `references/syntax.md`, README feature list
- [ ] Plain-Markdown fallback (`toMarkdown.ts`) and agent view (`agentView.ts`) handle the new construct
- [ ] Examples still validate: `node extension/dist/cli.js validate examples`
```

## Merging and tagging

- Squash-merge feature PRs. The squash commit message is the PR's Conventional Commit title.
- Release: merge `release/vX.Y.Z` into `main`, then tag the merge commit with `vX.Y.Z` and push the tag. Build and publish artifacts from that tag only.
- Never move or delete a published tag. If a release is wrong, publish a new patch version.
