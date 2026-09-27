# Backward-compatibility catalogue

Who depends on what, and how to change it safely. `release-check.mjs` detects most of these automatically. The ones marked *(manual)* need a human or agent review of the diff.

## Contents

1. Format and syntax
2. Validation
3. Rendering (HTML/CSS)
4. Agent view
5. Plain-Markdown export
6. CLI
7. npm library
8. VS Code extension
9. Agent skills
10. Safe patterns

---

## 1. Format and syntax

Users have documents in version control, so the same file must keep its meaning and stay valid.

| Change | Breaking? | Compatible alternative |
|---|---|---|
| Add a block, inline directive, attribute, named color, front-matter key, enum value | No (minor) | — |
| Remove or rename any of the above | **Yes** | Keep the old name as an alias; deprecate (§10) |
| Make an attribute required | **Yes** | Keep it optional; warn when missing |
| Restrict a free-text attribute to an enum | **Yes, if** existing values fall outside it | Warn on unknown values instead of erroring |
| Change what existing syntax means, e.g. `:::` nesting rules or `$` math detection *(manual)* | **Yes** | New opt-in syntax or attribute |
| Change `SMD_VERSION` | **Yes** (format major) | Only when old documents truly can't be read the same way |
| A new inline syntax that could match existing plain text, e.g. `:word[` or `{…}` after text *(manual)* | **Possibly** | Require a leading `:`/whitespace rule like existing directives; test on the corpus |

## 2. Validation

CI pipelines run `smd validate --strict` and agents parse `--json`.

| Change | Breaking? | Compatible alternative |
|---|---|---|
| New rule at `info`/`hint` | No | — |
| New rule at `warning` | **For `--strict` users** — treat as a behaviour change and call it out | Start at `info`; promote later |
| New rule at `error`, or raise a severity | **Yes** | Only in a major |
| Remove or rename a diagnostic code | **Yes** (CI filters) | Keep the code |
| Change the `--json` shape (`files[].diagnostics[].{line,column,endColumn,severity,code,message,fix}`) | **Yes** for removals/renames | Add fields only |
| Change message text | No, but mention it in the changelog | — |
| Change a `fix` replacement *(manual)* | Behaviour change | Test that `--fix` output is still valid |

## 3. Rendering (HTML/CSS)

People theme documents with custom CSS and embed the HTML elsewhere.

| Change | Breaking? | Compatible alternative |
|---|---|---|
| Remove or rename an emitted `smd-*` class or `data-*` attribute | **Yes** for custom styles | Emit both old and new classes for one major cycle |
| Remove or rename a `--smd-*` CSS variable | **Yes** | Keep the old variable as an alias |
| Visual restyling with the same classes | No (mention it) | — |
| Heading id (slug) algorithm change | **Yes** (breaks `#anchor` links) | Never change it; add `{#id}` support instead |
| Preview runtime messages (`toggleTask`, `openLink`, …) | Internal | — |

## 4. Agent view

Agents and prompts depend on the exact shape.

| Change | Breaking? | Compatible alternative |
|---|---|---|
| Rename or remove a tag (`<agent-instructions>`, `<warning>`, `<decision …>`, `<risk …>`), a label (`API METHOD path`, `Tab "…":`) or a pointer format (`[code: …]`, `[diagram: …]`, `[L42]`) | **Yes** | Keep the format; add new tags for new blocks |
| Stop always including `:::agent` blocks when sections are filtered | **Yes** | Never |
| Include content that was previously omitted (`:::human`, `{agent=skip}`) | **Yes** (token budgets, privacy) | Opt-in flag |
| Represent a new block | No (minor) | Follow the existing tag style |
| Output differences on the corpus *(the checker lists them)* | Behaviour change: confirm intent | — |

## 5. Plain-Markdown export

| Change | Breaking? |
|---|---|
| Different fallback for an existing construct (e.g. callout → alert type) | Behaviour change: confirm it's still GitHub-compatible |
| Dropping content that used to be exported | **Yes** |

## 6. CLI

`smd` is used in CI, scripts and by agents.

| Change | Breaking? | Compatible alternative |
|---|---|---|
| Remove or rename a command, flag or template | **Yes** | Keep it as a hidden alias |
| Change exit codes (0 ok / 1 errors / 2 usage) | **Yes** | Never |
| Change the default output of `outline`/`agent`/`tasks` *(manual)* | Behaviour change | Add a flag |
| Change `--json` fields | **Yes** for removals | Add fields only |
| Raise the minimum Node version | **Yes** | Only in a major |

## 7. npm library

| Change | Breaking? | Compatible alternative |
|---|---|---|
| Remove or rename an export, `exports` entry point or `bin` | **Yes** | Re-export under the old name, marked `@deprecated` |
| Narrow a parameter or option type, or remove/rename a result field *(manual: the checker flags declaration changes)* | **Yes** | Widen only; add optional fields |
| Change the default of an option *(manual)* | Behaviour change | — |
| Add a runtime dependency | No, but review size and supply chain | Prefer bundling |
| Change the module format (CJS/ESM) or `engines` | **Yes** | Ship both formats |

## 8. VS Code extension

| Change | Breaking? | Compatible alternative |
|---|---|---|
| Change `publisher` or `name` | **Yes** (users stop receiving updates) | Never |
| Remove or rename a command ID or setting key | **Yes** (keybindings, settings.json) | Keep the old ID and forward it |
| Change a setting's default | Behaviour change | — |
| Remove a snippet prefix or keybinding | Behaviour change (muscle memory) | Keep it |
| Raise `engines.vscode` | Behaviour change: users on older VS Code stay on the old version | Only when needed |
| Remove the `smd` language ID or `.smd` association | **Yes** | Never |

## 9. Agent skills

| Change | Breaking? | Compatible alternative |
|---|---|---|
| Rename or remove a skill folder or `name` | **Yes** (installed skills, docs) | Keep the name |
| Change a documented workflow in a way that contradicts older CLI versions *(manual)* | Behaviour change | Mention the minimum CLI version |
| The bundled `scripts/smd.cjs` must equal `extension/dist/cli.js` | The checker fails otherwise | `npm run build` |

## 10. Safe patterns

- **Aliases:** keep `oldName` mapped to `newName` in the vocabulary and code; the validator emits `hint` code `deprecated/<thing>` with a quick fix to the new name.
- **Deprecation timeline:** deprecate in a minor (changelog `### Deprecated`, hint diagnostic, docs), then remove in the next major, listed under `### ⚠️ Breaking changes` with a migration note.
- **Opt-in behaviour:** new behaviour behind a flag, attribute, setting or front-matter key; flip the default only in a major.
- **Corpus-first:** before changing parsing or rendering, add documents that exercise the current behaviour to `extension/test/compat/corpus/`, then make the change and review the checker's diffs.
