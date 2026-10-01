# Versioning policy

## One version for everything

The extension, the npm package and the skills (through their bundled CLI) always share one version `X.Y.Z`, and each release has one Git tag `vX.Y.Z`. That way "Styled Markdown 1.4.0" means the same behaviour in VS Code, in CI and in an agent. `bump-version.mjs` updates every place at once, and `release-check.mjs` fails on a mismatch.

## Semantic versioning, applied to this project

| Bump | When | Examples |
|---|---|---|
| **major** `X+1.0.0` | Anything in `compatibility.md` marked **Yes** | removing a block or alias, new validation errors on valid docs, renaming a CLI flag, export or command ID, changing agent-view tags, raising minimum Node or VS Code |
| **minor** `X.Y+1.0` | Additive capabilities | new block, directive, attribute, value, template, CLI command or flag, export, setting; new `info`/`hint` rules; deprecations |
| **patch** `X.Y.Z+1` | Fixes with no new surface | bug fixes, performance, docs, styling tweaks that keep the same classes |

The checker computes the **required** bump. A release may bump more than required (e.g. a minor for a significant fix) but never less.

## Spec version (`smd: N`)

`SMD_VERSION` changes only when documents written for the old format would be read differently. That is rare and always implies a major release. When it happens:

- The validator accepts both versions for at least one major cycle and warns on the old one.
- `docs/SPEC.md` gets a migration section.
- `smd migrate` (or `--fix`) upgrades documents automatically where possible.

## Pre-releases

For risky changes, publish a pre-release first. Pre-releases are published by hand: the Release workflow only accepts plain `vX.Y.Z` tags, and a `vX.Y.Z-beta.N` tag stops in its verify job before anything is published.

- npm: `X.Y.Z-beta.N` with `npm publish --tag next`
- VS Code: `npx vsce publish --pre-release` (the Marketplace needs a unique version; use an odd minor for pre-release lines if needed)
- GitHub: `gh release create vX.Y.Z-beta.N --prerelease`

## Deprecation timeline

1. **Minor N:** mark it deprecated. Keep it working, add a `hint` diagnostic with a quick fix to the replacement, and list it under `### Deprecated` in the changelog and docs.
2. **Next major:** remove it, and list it under `### ⚠️ Breaking changes` with a migration note.
