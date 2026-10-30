# Styled Markdown compatibility policy

What you can rely on when you write Styled Markdown documents, run `smd` in CI, build on the npm package or point an agent at the tools, and what each kind of release may change.

## The spec is versioned apart from the tools

There are two version numbers:

| Version | Example | What it names | Where you see it |
|---|---|---|---|
| **Spec version** | `2` | The format: which syntax exists and what it means | `smd: 2` in a document's front matter; `smd --version` prints `smd 2.5.0 (Styled Markdown spec v2)` |
| **Tools version** | `2.5.0` | One release of everything: the VS Code extension, the `smd` CLI, the npm package `styled-markdown`, the agent skills, the MCP server, the GitHub Action and the other integrations | The release tag `v2.5.0`, package versions |

The tools move often; the spec rarely. Tools 2.5.0 read spec v2 documents and spec v1 documents (those with `smd: 1` or no `smd` key, which includes every `.md` file) exactly as earlier 2.x tools did. A document says which rules it is written for, so a newer tool never changes what an older document means.

## Spec v2 is stable

- **No breaking change to spec v2.** A document that is valid spec v2 today keeps its meaning and stays valid in every later tools release that reads spec v2. New syntax may be added (a block, a directive, an attribute, a value, a front matter key), only in forms that existing text can't already match.
- **Spec v3 needs an RFC.** A change that would read existing documents differently can only come as a new spec version, proposed in an RFC in this repository (as [spec v2 was](SPEC-V2-PROPOSALS.smd)) and discussed in public before it is accepted.
- **Old specs keep working.** When a new spec version ships, the tools keep reading the previous one for at least one major release of the tools, warn about it, and `smd migrate` moves documents across, as it does from v1 to v2 today ([SPEC.md §10.1](SPEC.md#101-migrating-to-spec-v2)).

## What each tools release may change

The tools follow semantic versioning, applied to everything a user or a pipeline depends on.

| Release | Example | May | Never |
|---|---|---|---|
| **Patch** | 2.5.0 → 2.5.1 | Fix bugs, speed things up, improve messages and docs, restyle the preview with the same CSS classes | Add commands, flags, syntax or settings |
| **Minor** | 2.5.0 → 2.6.0 | Add syntax, templates, CLI commands and flags, MCP tools, export formats, settings, `info` and `hint` rules, and new behaviour behind an option; deprecate something | Remove or rename anything listed below; turn a valid document invalid; change exit codes |
| **Major** | 2.x → 3.0.0 | Remove what was deprecated in 2.x, flip a default, raise the minimum Node.js or VS Code version, add `error` rules that fail documents that passed | Change a document's meaning silently: that needs a new spec version and `smd migrate` |

**Kept within a major release:**

- **Documents:** every block, directive, attribute, value and front matter key; heading ids (so `#anchor` links keep working); what the validator accepts. New validation rules start at `info` or `hint`; a new `warning` is called out in the changelog, because it fails `smd validate --strict`.
- **CLI:** command names, flags, template names, exit codes (`0` ok, `1` problems found, `2` usage error) and the fields of `--json` output (new fields may appear; none disappear). Older command names stay as aliases (`smd render`, `smd to-md`, `smd pdf` and `smd docx` still work next to `smd export`).
- **Agent view:** the tags and labels agents read (`<agent-instructions>`, `<warning>`, `<decision …>`, `[L42]` line references, `[section omitted: …]`). `:::agent` blocks are always included, and `:::human` and `{agent=skip}` content is never added without an opt-in flag.
- **MCP server:** tool names and their arguments. Tools that 2.5.0 no longer lists by default (`outline`, `section`, `agent`) still answer when called, and `smd mcp --legacy-tools` lists them, until 3.0. Write tools exist only with `--allow-write`.
- **npm package:** exports, entry points and `bin` commands; options are only widened, and result fields only added.
- **VS Code extension:** the extension id `bislink360.styled-markdown`, command ids, setting keys and the `.smd` language.
- **Agent skills:** the skill names `styled-markdown-reader` and `styled-markdown-writer` and the paths other tools reference.
- **HTML and CSS:** the `smd-*` classes and `--smd-*` variables that custom themes target.

Features marked **Preview** (today: the Block Editor) may change their look and keys in a minor release.

## Deprecation

1. **In a minor release**, the old name or behaviour is marked deprecated. It keeps working; the validator adds a `hint` with a quick fix to the replacement where that applies, and the changelog lists it under **Deprecated**.
2. **In the next major release** at the earliest, it may be removed, listed under **Breaking changes** in the changelog with a migration note.

Nothing is removed without first being deprecated in a minor release.

## Release cadence

- **A minor release roughly every month**, from a release branch that collects the month's features.
- **Patch releases as needed**, for fixes, including security fixes ([SECURITY.md](../SECURITY.md)).
- **Major releases are rare** and announced ahead, with the deprecations they remove already in place.

Every release has one version for all components, one Git tag (`vX.Y.Z`) and a changelog entry with migration notes for anything that needs action: [extension/CHANGELOG.md](../extension/CHANGELOG.md). Pre-releases (`X.Y.Z-beta.N`) are opt-in: npm's `next` tag, the VS Code Marketplace's pre-release channel, and GitHub releases marked as pre-releases.

## How it is enforced

Every pull request runs a compatibility check against the last release: it compares the vocabulary, the validator, the agent view of a corpus of documents, the CLI, the npm package's exports and the extension's contributions, and fails a release branch whose version bump is smaller than its changes require. The full catalogue the maintainers use is in [.claude/skills/smd-release/references/compatibility.md](../.claude/skills/smd-release/references/compatibility.md).
