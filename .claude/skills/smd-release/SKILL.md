---
name: smd-release
description: Branch, version, verify and publish Styled Markdown releases (VS Code extension, npm package `styled-markdown`, agent skills, GitHub release) without breaking existing users. Use this skill for any change destined for the public bislink360/styled-markdown repository — starting a feature or fix branch, preparing or reviewing a pull request, bumping versions, writing the changelog, checking backward compatibility, tagging, or publishing to the VS Code Marketplace, npm or GitHub Releases — even if the user just says "ship it", "release this", "bump the version", "merge this" or "publish".
---

# Releasing Styled Markdown

One repository ships four artifacts that must stay in lockstep:

| Artifact | Where | Version source |
|---|---|---|
| VS Code extension `bislink360.styled-markdown` | Marketplace + `.vsix` on GitHub Releases | `extension/package.json` |
| npm package `styled-markdown` (library + `smd` CLI) | npmjs.com | `npm/package.json` (same version) |
| Agent skills `styled-markdown-reader` / `-writer` | `skills/`, zips on GitHub Releases | bundle the CLI, so they follow the same version |
| Format spec | `smd: 1` in documents | `SMD_VERSION` in `extension/src/core/spec.ts`; changes only for format-breaking releases |

Existing documents, CI pipelines (`smd validate`), library users and agents all depend on today's behaviour. **The primary goal of this process is that nothing breaks silently.** Every incompatible change is found by the checker, called out to the human, and shipped only as a major version.

## Workflow

### 1. Work on a branch, never on `main`

Create one branch per capability or fix from an up-to-date `main`:

| Branch | For |
|---|---|
| `feat/<area>-<short-name>` | new capability (e.g. `feat/tables-captions`) |
| `fix/<area>-<short-name>` | bug fix |
| `docs/<topic>` | documentation only |
| `chore/<topic>` | tooling, CI, dependencies |
| `release/vX.Y.Z` | version bump + changelog for a release |

Use Conventional Commit messages (`feat(tables): add captions`, `fix(cli): …`, `docs: …`), because they feed the changelog. Mark breaking commits with `!` and a `BREAKING CHANGE:` footer. **Do not add AI co-author trailers or "Generated with" lines to commits or PRs in this repository.** Read `references/branching.md` for the PR checklist and merge rules.

### 2. Keep every change backward compatible by default

Before designing a change, read `references/compatibility.md`. It lists what counts as breaking on each surface (syntax, validation, HTML, agent view, CLI, npm API, extension manifest, skills) and the compatible alternative for each. In short:

- **Add, don't change.** Add new blocks, directives, attributes, values, commands, flags, exports and settings. Leave old ones working.
- **Never make valid documents invalid.** New checks start as `warning`/`info`; only a major release may introduce new errors on previously valid input.
- **Deprecate before removing.** Keep an alias, emit a deprecation hint, document it, and remove it only in the next major.
- **Stable identifiers are contracts:** diagnostic codes, CLI flags and JSON output fields, `smd-*` CSS classes, agent-view tags, extension command/setting IDs, skill names.

### 3. Prove it on every PR

From the repository root:

```bash
node .claude/skills/smd-release/scripts/release-check.mjs            # compare with the last vX.Y.Z tag
node .claude/skills/smd-release/scripts/release-check.mjs --skip-vscode --skip-tests   # quick iteration
```

The checker builds the last release in a temporary worktree (cached) and compares it with the working tree:

- format vocabulary, diagnostic codes, validation results, agent view, Markdown export and emitted CSS classes on a document corpus
- CLI commands and flags, and templates
- npm exports, entry points and types
- extension commands, settings, defaults, language IDs, keybindings and snippets
- skills

It also runs the typecheck, unit tests and VS Code integration tests, checks version consistency and the changelog, and computes the **required** bump. It exits `1` if anything blocks.

Every new syntax feature must also add a document exercising it to `extension/test/compat/corpus/`, so future releases are compared against it. Create the folder if it doesn't exist yet.

### 4. Prepare the release on `release/vX.Y.Z`

1. Branch from `main` after the feature PRs are merged.
2. Bump every artifact in one step:

   ```bash
   node .claude/skills/smd-release/scripts/bump-version.mjs <patch|minor|major|X.Y.Z>
   ```

   This updates `extension/package.json`, `extension/package-lock.json` and `npm/package.json`, and opens a CHANGELOG entry.
3. Fill in `extension/CHANGELOG.md`. List every item from the checker's **Breaking** section under `### ⚠️ Breaking changes`, each with a migration note. Delete empty headings.
4. Update docs for any new syntax: `docs/SPEC.md`, `docs/FEATURES.md`, `skills/styled-markdown-writer/references/syntax.md`, and the README feature list.
5. Rebuild (`cd extension && npm run build && npm run build:npm`) and run the **full** check with no skip flags.

### 5. Stop and get human approval (mandatory)

Before merging the release PR, show the human the checker report and a short summary:

- **Version:** `vPREV → vNEXT` (required bump / actual bump)
- **Breaking changes:** each one with who is affected and the migration path. If there are none, say so explicitly.
- **Behaviour changes** the checker flagged for review (agent-view, HTML or Markdown-export diffs, new warnings, changed defaults), with your assessment of each.
- **New features.**
- **Tests:** pass counts for unit and VS Code integration tests.

Don't proceed until the human approves in chat. For a major release, get approval for each breaking change individually.

### 6. Merge, tag, build artifacts

1. Merge the release PR into `main` (squash).
2. On the merge commit, tag and push:

   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

3. Build the artifacts from that exact commit: `npm run package` (→ `.vsix`), `npm run build:npm`, and skill zips created with `tar -a -c -f <name>.zip <folder>` from `skills/` (forward-slash paths; don't use PowerShell `Compress-Archive`).

### 7. Publish (the human holds the credentials)

Publish in this order. Only publish with credentials that are already present on the machine. **Never ask for, type, paste or store tokens yourself.** If a step needs a login, stop and give the human the exact command to run.

| Step | Command | Verify (don't trust the output alone) |
|---|---|---|
| GitHub release | `gh release create vX.Y.Z --title "Styled Markdown X.Y.Z" --notes-file <changelog excerpt> <vsix> <skill zips>` | `gh release view vX.Y.Z` lists 3 assets |
| VS Code Marketplace | `cd extension && npx vsce publish --packagePath styled-markdown-X.Y.Z.vsix` | `npx vsce show bislink360.styled-markdown` shows X.Y.Z (allow a few minutes for verification) |
| npm | `cd npm && npm publish` | `npm view styled-markdown version` returns X.Y.Z |

Check authentication first: `npx vsce ls-publishers` must list `bislink360`, and `npm whoami` must succeed. If either fails, hand the step to the human.

**Only report something as published after the registry itself shows the new version.** If a listing isn't live, say so plainly and don't update docs to point at it.

### 8. After publishing

- Confirm the README badges and install instructions resolve. Push doc changes that point at the new version only after all registries show it.
- If a release is bad, don't unpublish. Ship a patch (`fix/…` → `release/vX.Y.Z+1`). For npm, `npm deprecate styled-markdown@X.Y.Z "<reason>"` warns installers.

## References

- `references/compatibility.md` — the breaking-change catalogue per surface, and the compatible alternatives. Read it before designing any change.
- `references/versioning.md` — semver rules for this repository, spec-version policy and deprecation timeline.
- `references/branching.md` — branch naming, commit conventions, PR checklist, merge and tag rules.
